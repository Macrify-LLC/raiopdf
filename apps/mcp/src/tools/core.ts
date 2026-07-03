import { z } from "zod";
import type { EngineHandle } from "../engine.js";
import { baseOutputSchema, type StructuredToolResult } from "../format.js";
import { resolvePageIndexes, runOutputOp, runSingleOutputOp } from "../ops.js";

const absoluteInput = z.string().describe("Absolute path to an existing PDF file.");
const absoluteOutput = z
  .string()
  .describe("Absolute path for the new PDF. Must not already exist (never overwrites).");

const outputResultSchema = { ...baseOutputSchema, output: z.string().optional() };

// ---- ocr_pdf ----
export const ocrInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  languages: z.array(z.string()).optional().describe('OCR languages (default ["eng"]).'),
  force: z.boolean().optional().describe("Re-OCR pages that already contain text."),
};
export const ocrOutputSchema = outputResultSchema;
export interface OcrInput {
  input: string;
  output: string;
  languages?: string[] | undefined;
  force?: boolean | undefined;
}
export function handleOcr(input: OcrInput, engine: EngineHandle): Promise<StructuredToolResult> {
  return runSingleOutputOp(engine, input.input, input.output, async (e, document) => {
    const result = await e.ocr(document, {
      languages: input.languages ?? ["eng"],
      ocrType: input.force ? "force-ocr" : "skip-text",
    });
    return { result, summary: `Made searchable via OCR: ${input.output}.` };
  });
}

// ---- merge_pdfs ----
export const mergeInputSchema = {
  inputs: z.array(absoluteInput).min(2).describe("Absolute paths to merge, in order."),
  output: absoluteOutput,
};
export const mergeOutputSchema = outputResultSchema;
export interface MergeInput {
  inputs: string[];
  output: string;
}
export function handleMerge(
  input: MergeInput,
  engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runOutputOp(engine, input.inputs, input.output, async (e, documents) => {
    const result = await e.merge(documents);
    return { result, summary: `Merged ${documents.length} files into ${input.output}.` };
  });
}

// ---- rotate_pages ----
export const rotateInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  degrees: z
    .number()
    .int()
    .refine((value) => value % 90 === 0, "degrees must be a multiple of 90")
    .describe("Clockwise rotation in degrees (a multiple of 90)."),
  pages: z
    .union([z.literal("all"), z.array(z.number().int().nonnegative())])
    .optional()
    .describe('Zero-based page indexes, or "all" (default).'),
};
export const rotateOutputSchema = outputResultSchema;
export interface RotateInput {
  input: string;
  output: string;
  degrees: number;
  pages?: number[] | "all" | undefined;
}
export function handleRotate(
  input: RotateInput,
  engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runSingleOutputOp(engine, input.input, input.output, async (e, document) => {
    const indexes = await resolvePageIndexes(e, document, input.pages ?? "all");
    const result = await e.rotatePages(document, indexes, input.degrees);
    return {
      result,
      summary: `Rotated ${indexes.length} page(s) by ${input.degrees}° into ${input.output}.`,
    };
  });
}

// ---- compress_pdf ----
export const compressInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  quality: z
    .number()
    .int()
    .min(1)
    .max(9)
    .optional()
    .describe("Optimize level 1 (light) to 9 (aggressive). Default 5."),
  grayscale: z.boolean().optional().describe("Convert to grayscale while compressing."),
};
export const compressOutputSchema = outputResultSchema;
export interface CompressInput {
  input: string;
  output: string;
  quality?: number | undefined;
  grayscale?: boolean | undefined;
}
export function handleCompress(
  input: CompressInput,
  engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runSingleOutputOp(engine, input.input, input.output, async (e, document) => {
    const result = await e.compress(document, {
      quality: input.quality ?? 5,
      ...(input.grayscale === undefined ? {} : { grayscale: input.grayscale }),
    });
    return { result, summary: `Compressed into ${input.output}.` };
  });
}

// ---- sanitize_pdf ----
export const sanitizeInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  removeJavaScript: z.boolean().optional().describe("Default true."),
  removeEmbeddedFiles: z.boolean().optional().describe("Default true."),
  removeLinks: z.boolean().optional().describe("Default false."),
};
export const sanitizeOutputSchema = {
  ...outputResultSchema,
  removed: z.array(z.string()).optional(),
};
export interface SanitizeInput {
  input: string;
  output: string;
  removeJavaScript?: boolean | undefined;
  removeEmbeddedFiles?: boolean | undefined;
  removeLinks?: boolean | undefined;
}
export function handleSanitize(
  input: SanitizeInput,
  engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runSingleOutputOp(engine, input.input, input.output, async (e, document) => {
    const { document: result, removed } = await e.sanitize(document, {
      removeJavaScript: input.removeJavaScript ?? true,
      removeEmbeddedFiles: input.removeEmbeddedFiles ?? true,
      removeLinks: input.removeLinks ?? false,
    });
    const removedLabel = removed.length > 0 ? removed.join(", ") : "nothing";
    return {
      result,
      summary: `Sanitized into ${input.output} (removed: ${removedLabel}).`,
      extra: { removed },
    };
  });
}

// ---- scrub_metadata ----
export const scrubMetadataInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
};
export const scrubMetadataOutputSchema = outputResultSchema;
export interface ScrubMetadataInput {
  input: string;
  output: string;
}
export function handleScrubMetadata(
  input: ScrubMetadataInput,
  engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runSingleOutputOp(engine, input.input, input.output, async (e, document) => {
    const result = await e.scrubMetadata(document);
    return { result, summary: `Scrubbed document metadata into ${input.output}.` };
  });
}
