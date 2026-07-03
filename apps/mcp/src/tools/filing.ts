import { promises as fs } from "node:fs";
import { z } from "zod";
import { DEFAULT_PACK_ID, getPack, listPacks, preflight } from "@raiopdf/rules";
import type { JurisdictionPack, JurisdictionPackId } from "@raiopdf/rules";
import type { EngineHandle } from "../engine.js";
import { baseOutputSchema, errorResult, successResult, type StructuredToolResult } from "../format.js";
import { resolveInput } from "../paths.js";
import { buildDocumentFacts } from "../filing/facts.js";

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
  /** No known blocking issue (no rule "warn" / portal "fix"). Not a green light. */
  noBlockingIssues: z.boolean().optional(),
  /** Every check passed — nothing blocking AND nothing unverified. */
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
  const facts = await buildDocumentFacts(bytes);
  const report = preflight(facts, pack);

  const checks = report.checks.map((check) => ({
    checkId: check.checkId,
    label: check.label,
    authority: check.authority,
    kind: check.kind,
    status: check.status,
    detail: check.detail,
  }));
  const blocking = report.checks.filter(
    (check) => check.status === "warn" || check.status === "fix",
  );
  const unverified = report.checks
    .filter((check) => check.status === "unknown")
    .map((check) => check.label);
  const noBlockingIssues = blocking.length === 0;
  const confirmedReady = noBlockingIssues && unverified.length === 0;

  let summary: string;
  if (confirmedReady) {
    summary = `Filing preflight passed all ${checks.length} checks for the ${pack.name} pack. ${pack.guidanceNote}`;
  } else if (noBlockingIssues) {
    summary = `No blocking issues for the ${pack.name} pack, but ${unverified.length} check(s) could not be verified here (${unverified.join("; ")}) — confirm those manually. ${pack.guidanceNote}`;
  } else {
    summary = `Filing preflight found ${blocking.length} blocking issue(s) for the ${pack.name} pack: ${blocking
      .map((check) => check.label)
      .join("; ")}. ${pack.guidanceNote}`;
  }

  return successResult(summary, {
    noBlockingIssues,
    confirmedReady,
    unverified,
    pack: { id: pack.id, name: pack.name, version: pack.packVersion },
    guidance: pack.guidanceNote,
    checks,
  });
}
