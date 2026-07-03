import { z } from "zod";
import { runBatchCleanup } from "@raiopdf/batch-cleanup";
import type { BatchCleanupOcrMode } from "@raiopdf/batch-cleanup";
import type { JurisdictionPackId } from "@raiopdf/rules";
import { extractTextLayerCoverage } from "@raiopdf/rules/node";
import { getLocalEngine, type EngineHandle } from "../engine.js";
import { baseOutputSchema, successResult, type StructuredToolResult } from "../format.js";
import { prepareOutput, resolveInput } from "../paths.js";

const absoluteInput = z.string().describe("Absolute path to an existing PDF file.");

const operationsSchema = z.object({
  ocrMode: z.enum(["auto-image-only", "skip-text", "force-ocr", "off"]).optional()
    .describe("Default auto-image-only OCRs only files whose text-layer facts say every page is image-only."),
  compress: z.boolean().optional(),
  sanitize: z.boolean().optional(),
  scrubMetadata: z.boolean().optional(),
  repair: z.boolean().optional(),
  splitBySize: z.boolean().optional(),
  splitSizeMb: z.number().positive().optional(),
  normalizePages: z.boolean().optional()
    .describe("Only applies when a jurisdiction pack is selected."),
  convertToPdfA: z.boolean().optional()
    .describe("Only runs for required/preferred pack PDF/A stances."),
  compressionQuality: z.number().int().min(1).max(9).optional(),
});

export const batchCleanupInputSchema = {
  inputs: z.array(absoluteInput).min(1).describe("PDFs to clean in queue order."),
  outputDir: z.string().describe("Absolute package root. The directory may not already contain files."),
  packId: z.string().optional().describe("Optional jurisdiction pack id for defaults and warning propagation."),
  operations: operationsSchema.optional(),
};

export const batchCleanupOutputSchema = {
  ...baseOutputSchema,
  packageRoot: z.string().optional(),
  reportPdf: z.string().optional(),
  reportJson: z.string().optional(),
  files: z.array(z.object({
    sourceFilename: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
    outputs: z.array(z.string()),
  })).optional(),
};

export interface BatchCleanupInput {
  inputs: string[];
  outputDir: string;
  packId?: string | undefined;
  operations?: {
    ocrMode?: BatchCleanupOcrMode | undefined;
    compress?: boolean | undefined;
    sanitize?: boolean | undefined;
    scrubMetadata?: boolean | undefined;
    repair?: boolean | undefined;
    splitBySize?: boolean | undefined;
    splitSizeMb?: number | undefined;
    normalizePages?: boolean | undefined;
    convertToPdfA?: boolean | undefined;
    compressionQuality?: number | undefined;
  } | undefined;
}

export async function handleBatchCleanup(
  input: BatchCleanupInput,
  engineHandle: EngineHandle,
): Promise<StructuredToolResult> {
  const resolvedSources = await Promise.all(
    input.inputs.map(async (sourcePath) => ({ path: (await resolveInput(sourcePath)).realPath })),
  );
  const output = await prepareOutput(input.outputDir);
  let outputReserved = true;

  try {
    await output.abort();
    outputReserved = false;

    const sidecar = await engineHandle.getEngine();
    const result = await runBatchCleanup({
      sources: resolvedSources,
      outputDir: output.outputPath,
      ...(input.packId === undefined ? {} : { packId: input.packId as JurisdictionPackId }),
      ...(input.operations === undefined ? {} : { operations: input.operations }),
      factsOptions: {
        textExtractor: {
          extractTextLayerCoverage,
        },
      },
    }, {
      local: getLocalEngine(),
      sidecar,
    });
    const failed = result.files.filter((file) => file.status === "failed").length;
    const skipped = result.files.filter((file) => file.status === "skipped").length;
    const summarySuffix = failed || skipped
      ? ` (${failed} failed, ${skipped} skipped)`
      : "";

    return successResult(
      `Batch cleanup finished ${result.files.length} file(s) at ${result.packageRoot}${summarySuffix}.`,
      {
        packageRoot: result.packageRoot,
        reportPdf: result.reportPdf,
        reportJson: result.reportJson,
        files: result.files.map((file) => ({
          sourceFilename: file.sourceFilename,
          status: file.status,
          reason: file.reason,
          outputs: file.outputs.map((entry) => entry.packageRelativePath),
        })),
      },
    );
  } finally {
    if (outputReserved) {
      await output.abort().catch(() => undefined);
    }
  }
}
