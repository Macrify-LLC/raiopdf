import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildFilingPacket } from "@raiopdf/filing-packet";
import {
  buildDocumentFacts,
  DEFAULT_PACK_ID,
  getPack,
  listPacks,
  preflight,
} from "@raiopdf/rules";
import { extractPageTextByPage, extractTextLayerCoverage } from "@raiopdf/rules/node";
import type { JurisdictionPack, JurisdictionPackId } from "@raiopdf/rules";
import { getLocalEngine, type EngineHandle } from "../engine.js";
import { baseOutputSchema, errorResult, successResult, type StructuredToolResult } from "../format.js";
import { preparePackageOutputDir, resolveInput } from "../paths.js";

const packIds: string[] = listPacks().map((pack) => pack.id);

export const filingInputSchema = {
  input: z.string().describe("Absolute path to an existing PDF file."),
  pack: z
    .string()
    .optional()
    .describe(`Jurisdiction pack id (default "${DEFAULT_PACK_ID}"). Available: ${packIds.join(", ")}.`),
};
export const filingOutputSchema = {
  ...baseOutputSchema,
  /** No known warnings. Not a green light while checks remain unverified. */
  noWarnings: z.boolean().optional(),
  /** Every check passed — no warnings and nothing unverified. */
  confirmedReady: z.boolean().optional(),
  /** Labels of checks that could not be verified here (report as "unknown"). */
  unverified: z.array(z.string()).optional(),
  pack: z.object({ id: z.string(), name: z.string(), version: z.string() }).optional(),
  guidance: z.string().optional(),
  checks: z
    .array(
      z.object({
        checkId: z.string(),
        label: z.string(),
        authority: z.string(),
        kind: z.string(),
        status: z.string(),
        detail: z.string(),
      }),
    )
    .optional(),
};
export interface FilingInput {
  input: string;
  pack?: string | undefined;
}

const prepStepIdSchema = z.enum([
  "remove-encryption",
  "normalize-pages",
  "sanitize-content",
  "scrub-metadata",
  "make-searchable",
  "flatten-forms",
  "convert-pdfa",
  "split-by-size",
]);

export const filingPacketInputSchema = {
  sources: z
    .array(z.object({
      path: z.string().describe("Absolute path to an existing PDF file."),
      displayName: z.string().optional().describe("Optional filename to use in packet reports."),
    }))
    .min(1)
    .describe("Ordered source PDFs in filing upload order."),
  outputDir: z.string().describe("Absolute package root. The directory may not already contain files."),
  pack: z
    .string()
    .optional()
    .describe(`Jurisdiction pack id (default "${DEFAULT_PACK_ID}"). Available: ${packIds.join(", ")}.`),
  layoutMode: z.enum(["separate-files", "combined-pdf"]).optional().describe("Default separate-files."),
  prefixFilenames: z.boolean().optional().describe("Prefix upload filenames with 01 -, 02 -, etc. Default true."),
  maxFileBytes: z.number().int().positive().optional().describe("Court profile per-file cap in bytes."),
  maxEnvelopeBytes: z.number().int().positive().optional().describe("Court profile envelope cap in bytes."),
  selectedStepIds: z.array(prepStepIdSchema).optional().describe("Explicit prep checklist steps to run."),
  skippedStepIds: z.array(prepStepIdSchema).optional().describe("Explicit prep checklist steps to skip."),
  splitSizeMb: z.number().positive().optional().describe("Per-run split cap override in megabytes."),
  convertToPdfA: z.boolean().optional().describe("Explicitly enable/disable PDF/A conversion step."),
};
export const filingPacketOutputSchema = {
  ...baseOutputSchema,
  packageRoot: z.string().optional(),
  outputs: z.array(z.string()).optional(),
  manifestPdf: z.string().optional(),
  packetJson: z.string().optional(),
  combinedPdf: z.string().nullable().optional(),
  selectionWarnings: z.array(z.string()).optional(),
};
export interface FilingPacketInput {
  sources: { path: string; displayName?: string | undefined }[];
  outputDir: string;
  pack?: string | undefined;
  layoutMode?: "separate-files" | "combined-pdf" | undefined;
  prefixFilenames?: boolean | undefined;
  maxFileBytes?: number | undefined;
  maxEnvelopeBytes?: number | undefined;
  selectedStepIds?: z.infer<typeof prepStepIdSchema>[] | undefined;
  skippedStepIds?: z.infer<typeof prepStepIdSchema>[] | undefined;
  splitSizeMb?: number | undefined;
  convertToPdfA?: boolean | undefined;
}

/**
 * Read-only e-filing preflight: builds document facts in Node and runs the
 * jurisdiction rules engine, returning each rule/portal check with its authority
 * citation, the pack's guidance disclaimer, and an overall "ready" flag. Does
 * not modify the file. Checks the rules engine cannot determine from the
 * available facts (e.g. clerk-stamp geometry, PDF/A) are reported as "unknown".
 */
export async function handlePrepareForFiling(
  input: FilingInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  const packId = input.pack ?? DEFAULT_PACK_ID;
  // getPack throws for an unrequested/unknown jurisdiction, but returns the
  // unknownPack (honest "unknown" checks) when the DEFAULT pack fails integrity —
  // so a bad integrity check degrades gracefully instead of a false rejection.
  let pack: JurisdictionPack;
  try {
    pack = getPack(packId as JurisdictionPackId);
  } catch {
    return errorResult(
      "INVALID_ARGUMENT",
      `Unknown jurisdiction pack "${packId}".`,
      `Available packs: ${packIds.join(", ") || "(none available)"}.`,
    );
  }

  const source = await resolveInput(input.input);
  const bytes = await fs.readFile(source.realPath);
  const facts = await buildDocumentFacts(bytes, {
    textExtractor: {
      extractTextLayerCoverage,
      extractPageTextByPage,
    },
  });
  const report = preflight(facts, pack);

  const checks = report.checks.map((check) => ({
    checkId: check.checkId,
    label: check.label,
    authority: check.authority,
    kind: check.kind,
    status: check.status,
    detail: check.detail,
  }));
  const warnings = report.checks.filter((check) => check.status === "warn");
  const unverified = report.checks
    .filter((check) => check.status === "unknown")
    .map((check) => check.label);
  const noWarnings = warnings.length === 0;
  const confirmedReady = noWarnings && unverified.length === 0;

  let summary: string;
  if (confirmedReady) {
    summary = `Filing preflight passed all ${checks.length} checks for the ${pack.name} pack. ${pack.guidanceNote}`;
  } else if (noWarnings) {
    summary = `No warnings for the ${pack.name} pack, but ${unverified.length} check(s) could not be verified here (${unverified.join("; ")}) — confirm those manually. ${pack.guidanceNote}`;
  } else {
    summary = `Filing preflight found ${warnings.length} warning(s) for the ${pack.name} pack: ${warnings
      .map((check) => check.label)
      .join("; ")}. ${pack.guidanceNote}`;
  }

  return successResult(summary, {
    noWarnings,
    confirmedReady,
    unverified,
    pack: { id: pack.id, name: pack.name, version: pack.packVersion },
    guidance: pack.guidanceNote,
    checks,
  });
}

export async function handleBuildFilingPacket(
  input: FilingPacketInput,
  engineHandle: EngineHandle,
): Promise<StructuredToolResult> {
  const packId = input.pack ?? DEFAULT_PACK_ID;
  try {
    getPack(packId as JurisdictionPackId);
  } catch {
    return errorResult(
      "INVALID_ARGUMENT",
      `Unknown jurisdiction pack "${packId}".`,
      `Available packs: ${packIds.join(", ") || "(none available)"}.`,
    );
  }

  const resolvedSources = await Promise.all(
    input.sources.map(async (source) => {
      const resolved = await resolveInput(source.path);
      return {
        path: resolved.realPath,
        displayName: source.displayName ?? path.basename(source.path),
      };
    }),
  );
  const output = await preparePackageOutputDir(input.outputDir);
  const sidecar = typeof engineHandle.getEngine === "function"
    ? await engineHandle.getEngine().catch(() => undefined)
    : undefined;
  const result = await buildFilingPacket({
    sources: resolvedSources,
    outputDir: output.outputPath,
    packId: packId as JurisdictionPackId,
    ...(input.layoutMode === undefined ? {} : { layoutMode: input.layoutMode }),
    ...(input.prefixFilenames === undefined ? {} : { prefixFilenames: input.prefixFilenames }),
    ...(input.maxFileBytes === undefined && input.maxEnvelopeBytes === undefined
      ? {}
      : {
          courtProfile: {
            ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }),
            ...(input.maxEnvelopeBytes === undefined ? {} : { maxEnvelopeBytes: input.maxEnvelopeBytes }),
          },
        }),
    checklist: {
      ...(input.selectedStepIds === undefined ? {} : { selectedStepIds: input.selectedStepIds }),
      ...(input.skippedStepIds === undefined ? {} : { skippedStepIds: input.skippedStepIds }),
      ...(input.splitSizeMb === undefined ? {} : { splitSizeMb: input.splitSizeMb }),
      ...(input.convertToPdfA === undefined ? {} : { convertToPdfA: input.convertToPdfA }),
    },
    factsOptions: {
      textExtractor: {
        extractTextLayerCoverage,
        extractPageTextByPage,
      },
    },
  }, {
    local: getLocalEngine(),
    ...(sidecar === undefined ? {} : { sidecar }),
  });
  const selectionWarnings = result.selectionChecks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.label}: ${check.detail}`);

  return successResult(
    `Built a filing packet with ${result.files.length} upload file(s) at ${result.packageRoot}.`,
    {
      packageRoot: result.packageRoot,
      outputs: result.files.map((file) => file.packageRelativePath),
      manifestPdf: result.manifestPdf,
      packetJson: result.packetJson,
      combinedPdf: result.combinedPdf,
      selectionWarnings,
    },
  );
}
