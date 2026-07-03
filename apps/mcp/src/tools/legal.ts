import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PdfPageSelection, PdfSplitPart, PdfStampPlacement } from "@raiopdf/engine-api";
import { getLocalEngine, type EngineHandle } from "../engine.js";
import { baseOutputSchema, successResult, type StructuredToolResult } from "../format.js";
import { resolveInput } from "../paths.js";
import { runLocalOutputOp, runLocalSingleOutputOp, writeManyOutputs } from "../ops.js";

const absoluteInput = z.string().describe("Absolute path to an existing PDF file.");
const absoluteOutput = z
  .string()
  .describe("Absolute path for the new PDF. Must not already exist (never overwrites).");
const absoluteOutputDir = z
  .string()
  .describe("Absolute path to an existing directory for the output files.");

const placementSchema = z.object({
  edge: z.enum(["header", "footer"]),
  align: z.enum(["left", "center", "right"]),
});
const pageSelectionSchema = z.union([
  z.literal("all"),
  z.literal("first"),
  z.array(z.number().int().nonnegative()),
]);
const binderIndexSchema = z.object({
  enabled: z.boolean().optional().describe("Generate an Exhibit Index. Defaults to true."),
  includeSourceFileName: z
    .boolean()
    .optional()
    .describe("Include source filenames in the Exhibit Index. Defaults to false."),
});

const outputResultSchema = { ...baseOutputSchema, output: z.string().optional() };
const multiOutputResultSchema = { ...baseOutputSchema, outputs: z.array(z.string()).optional() };

const BATES_PLACEMENT: PdfStampPlacement = { edge: "footer", align: "right" };
const PAGE_NUMBER_PLACEMENT: PdfStampPlacement = { edge: "footer", align: "center" };

/** Reject a user-supplied filename component that could escape the output dir. */
function safeFileComponent(value: string, field: string): string {
  if (value.length === 0 || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`${field} must be a plain filename component (no path separators or "..").`);
  }
  return value;
}

// The engine's PdfEngine annotates this as its structural type; the tools that
// only need it as an opaque value re-use it via the imported alias.
type Placement = PdfStampPlacement;
type PageSelection = PdfPageSelection;

// ---- build_exhibit_binder ----
export const binderInputSchema = {
  main: absoluteInput,
  exhibits: z
    .array(z.object({ path: z.string(), label: z.string(), description: z.string().optional() }))
    .min(1)
    .describe("Ordered exhibit files with their labels (e.g. { path, label: \"Exhibit A\" })."),
  descriptions: z
    .array(z.string())
    .optional()
    .describe("Optional descriptions aligned to the exhibits array. Defaults from source filenames."),
  index: binderIndexSchema.optional().describe("Exhibit Index options. Index generation defaults on."),
  output: absoluteOutput,
  slipSheets: z.boolean().optional().describe("Insert a labeled slip sheet before each exhibit."),
  placement: placementSchema.optional(),
  stampPages: pageSelectionSchema.optional(),
  fontSizePt: z.number().positive().optional(),
  marginIn: z.number().nonnegative().optional(),
};
export const binderOutputSchema = outputResultSchema;
export interface BinderInput {
  main: string;
  exhibits: { path: string; label: string; description?: string | undefined }[];
  descriptions?: string[] | undefined;
  index?: { enabled?: boolean | undefined; includeSourceFileName?: boolean | undefined } | undefined;
  output: string;
  slipSheets?: boolean | undefined;
  placement?: Placement | undefined;
  stampPages?: PageSelection | undefined;
  fontSizePt?: number | undefined;
  marginIn?: number | undefined;
}
export function handleBinder(
  input: BinderInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  if (input.descriptions !== undefined && input.descriptions.length !== input.exhibits.length) {
    throw new Error("descriptions must have one entry per exhibit when provided.");
  }

  const inputPaths = [input.main, ...input.exhibits.map((exhibit) => exhibit.path)];
  return runLocalOutputOp(inputPaths, input.output, async (engine, documents) => {
    const mainDocument = documents[0];
    if (mainDocument === undefined) {
      throw new Error("Missing the main document.");
    }
    const exhibits = input.exhibits.map((exhibit, index) => {
      const doc = documents[index + 1];
      if (doc === undefined) {
        throw new Error(`Missing exhibit document for "${exhibit.label}".`);
      }
      return {
        doc,
        label: exhibit.label,
        description: exhibit.description ?? input.descriptions?.[index],
        sourceFileName: path.basename(exhibit.path),
      };
    });
    const result = await engine.buildBinder(mainDocument, exhibits, {
      slipSheets: input.slipSheets ?? false,
      ...(input.index === undefined ? {} : { index: input.index }),
      ...(input.placement === undefined ? {} : { placement: input.placement }),
      ...(input.stampPages === undefined ? {} : { stampPages: input.stampPages }),
      ...(input.fontSizePt === undefined ? {} : { fontSizePt: input.fontSizePt }),
      ...(input.marginIn === undefined ? {} : { marginIn: input.marginIn }),
    });
    return {
      result,
      summary: `Assembled an exhibit binder (${exhibits.length} exhibit(s)) into ${input.output}.`,
    };
  });
}

// ---- bates_stamp ----
export const batesInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  prefix: z.string().describe('Text before the number, e.g. "ABC".'),
  start: z.number().int().nonnegative().optional().describe("First Bates number. Default 1."),
  digits: z.number().int().min(1).optional().describe("Zero-padded width. Default 6."),
  placement: placementSchema.optional(),
  fontSizePt: z.number().positive().optional(),
  marginIn: z.number().nonnegative().optional(),
};
export const batesOutputSchema = outputResultSchema;
export interface BatesInput {
  input: string;
  output: string;
  prefix: string;
  start?: number | undefined;
  digits?: number | undefined;
  placement?: Placement | undefined;
  fontSizePt?: number | undefined;
  marginIn?: number | undefined;
}
export function handleBates(input: BatesInput, _engine: EngineHandle): Promise<StructuredToolResult> {
  return runLocalSingleOutputOp(input.input, input.output, async (engine, document) => {
    const result = await engine.batesStamp(document, {
      prefix: input.prefix,
      start: input.start ?? 1,
      digits: input.digits ?? 6,
      placement: input.placement ?? BATES_PLACEMENT,
      ...(input.fontSizePt === undefined ? {} : { fontSizePt: input.fontSizePt }),
      ...(input.marginIn === undefined ? {} : { marginIn: input.marginIn }),
    });
    return { result, summary: `Bates-stamped into ${input.output}.` };
  });
}

// ---- bates_stamp_folder ----
export const batesFolderInputSchema = {
  inputs: z.array(absoluteInput).min(1).describe("Ordered files to stamp with one continuous sequence."),
  outputDir: absoluteOutputDir,
  prefix: z.string(),
  start: z.number().int().nonnegative().optional().describe("First Bates number. Default 1."),
  digits: z.number().int().min(1).optional().describe("Zero-padded width. Default 6."),
  placement: placementSchema.optional(),
  fontSizePt: z.number().positive().optional(),
  marginIn: z.number().nonnegative().optional(),
};
export const batesFolderOutputSchema = {
  ...multiOutputResultSchema,
  nextNumber: z.number().optional(),
};
export interface BatesFolderInput {
  inputs: string[];
  outputDir: string;
  prefix: string;
  start?: number | undefined;
  digits?: number | undefined;
  placement?: Placement | undefined;
  fontSizePt?: number | undefined;
  marginIn?: number | undefined;
}
export async function handleBatesFolder(
  input: BatesFolderInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  const engine = getLocalEngine();
  const resolved = await Promise.all(input.inputs.map((file) => resolveInput(file)));
  const opened = [];
  const produced = [];
  const outputs: { path: string; bytes: Uint8Array }[] = [];

  try {
    let running = input.start ?? 1;
    for (let index = 0; index < resolved.length; index += 1) {
      const source = resolved[index];
      const originalPath = input.inputs[index];
      if (source === undefined || originalPath === undefined) {
        throw new Error("Missing an input file while stamping.");
      }
      const bytes = await fs.readFile(source.realPath);
      const document = await engine.open(bytes);
      opened.push(document);
      const pageCount = await engine.pageCount(document);
      const stamped = await engine.batesStamp(document, {
        prefix: input.prefix,
        start: running,
        digits: input.digits ?? 6,
        placement: input.placement ?? BATES_PLACEMENT,
        ...(input.fontSizePt === undefined ? {} : { fontSizePt: input.fontSizePt }),
        ...(input.marginIn === undefined ? {} : { marginIn: input.marginIn }),
      });
      if (stamped !== document) {
        // Track before saving so a saveToBytes failure still closes it in finally.
        produced.push(stamped);
      }
      const outBytes = await engine.saveToBytes(stamped);
      const base = path.basename(originalPath).replace(/\.pdf$/i, "");
      outputs.push({ path: path.join(input.outputDir, `${base}-bates.pdf`), bytes: outBytes });
      running += pageCount;
    }

    const written = await writeManyOutputs(outputs);
    return successResult(
      `Bates-stamped ${written.length} file(s) with one continuous sequence into ${input.outputDir}.`,
      { outputs: written, nextNumber: running },
    );
  } finally {
    for (const document of [...produced, ...opened]) {
      await engine.close(document).catch(() => undefined);
    }
  }
}

// ---- page_numbers ----
export const pageNumbersInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  startAt: z.number().int().optional().describe("Number on the first selected page. Default 1."),
  pages: pageSelectionSchema.optional().describe('Zero-based pages, "all" (default), or "first".'),
  format: z.enum(["number", "page-of-total"]).optional().describe('Default "number".'),
  placement: placementSchema.optional(),
  fontSizePt: z.number().positive().optional(),
  marginIn: z.number().nonnegative().optional(),
};
export const pageNumbersOutputSchema = outputResultSchema;
export interface PageNumbersInput {
  input: string;
  output: string;
  startAt?: number | undefined;
  pages?: PageSelection | undefined;
  format?: "number" | "page-of-total" | undefined;
  placement?: Placement | undefined;
  fontSizePt?: number | undefined;
  marginIn?: number | undefined;
}
export function handlePageNumbers(
  input: PageNumbersInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runLocalSingleOutputOp(input.input, input.output, async (engine, document) => {
    const result = await engine.pageNumbers(document, {
      startAt: input.startAt ?? 1,
      pageIndexes: input.pages ?? "all",
      format: input.format ?? "number",
      placement: input.placement ?? PAGE_NUMBER_PLACEMENT,
      ...(input.fontSizePt === undefined ? {} : { fontSizePt: input.fontSizePt }),
      ...(input.marginIn === undefined ? {} : { marginIn: input.marginIn }),
    });
    return { result, summary: `Added page numbers into ${input.output}.` };
  });
}

// ---- split_pdf ----
export const splitInputSchema = {
  input: absoluteInput,
  outputDir: absoluteOutputDir,
  maxBytes: z.number().int().positive().describe("Byte cap per output part."),
  prefix: z.string().optional().describe("Output filename prefix. Default: the input's base name."),
};
export const splitOutputSchema = {
  ...multiOutputResultSchema,
  parts: z.number().optional(),
  oversized: z.number().optional(),
};
export interface SplitInput {
  input: string;
  outputDir: string;
  maxBytes: number;
  prefix?: string | undefined;
}
export async function handleSplit(
  input: SplitInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  const engine = getLocalEngine();
  const prefix = safeFileComponent(
    input.prefix ?? path.basename(input.input).replace(/\.pdf$/i, ""),
    "prefix",
  );
  const source = await resolveInput(input.input);
  const document = await engine.open(await fs.readFile(source.realPath));
  let parts: readonly PdfSplitPart[] = [];

  try {
    const split = await engine.splitByMaxBytes(document, input.maxBytes);
    parts = split.parts;
    const outputs: { path: string; bytes: Uint8Array }[] = [];

    for (let index = 0; index < split.parts.length; index += 1) {
      const part = split.parts[index];
      if (part === undefined) {
        continue;
      }
      const bytes = await engine.saveToBytes(part.document);
      const name = `${prefix}-part-${String(index + 1).padStart(2, "0")}.pdf`;
      outputs.push({ path: path.join(input.outputDir, name), bytes });
    }

    const written = await writeManyOutputs(outputs);
    const oversized = split.parts.filter((part) => part.oversized).length;
    const oversizedNote =
      oversized > 0 ? ` (${oversized} part(s) exceed the cap and could not be split further)` : "";
    return successResult(
      `Split into ${written.length} part(s)${oversizedNote} in ${input.outputDir}.`,
      { outputs: written, parts: split.parts.length, oversized },
    );
  } finally {
    // Close every produced part handle + the source, on success or failure.
    for (const part of parts) {
      await engine.close(part.document).catch(() => undefined);
    }
    await engine.close(document).catch(() => undefined);
  }
}

// ---- extract_pages ----
export const extractInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  pages: z
    .array(z.number().int().nonnegative())
    .min(1)
    .describe("Zero-based page indexes to keep (in original document order)."),
};
export const extractOutputSchema = outputResultSchema;
export interface ExtractInput {
  input: string;
  output: string;
  pages: number[];
}
export function handleExtract(
  input: ExtractInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runLocalSingleOutputOp(input.input, input.output, async (engine, document) => {
    const count = await engine.pageCount(document);
    for (const page of input.pages) {
      if (page >= count) {
        throw new Error(`Page ${page} is out of range; the document has ${count} page(s).`);
      }
    }
    const keep = new Set(input.pages);
    const toDelete = Array.from({ length: count }, (_, index) => index).filter(
      (index) => !keep.has(index),
    );
    if (toDelete.length === count) {
      throw new Error("No pages selected to keep.");
    }
    const result = await engine.deletePages(document, toDelete);
    return { result, summary: `Extracted ${keep.size} page(s) into ${input.output}.` };
  });
}
