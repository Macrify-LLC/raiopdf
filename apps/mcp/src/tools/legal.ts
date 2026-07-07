import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  PdfApplyEditsOptions,
  PdfBinderOptions,
  PdfCoverStyle,
  PdfDocumentHandle,
  PdfEdit,
  PdfEditImageFormat,
  PdfPageSelection,
  PdfSplitPart,
  PdfStampPlacement,
} from "@raiopdf/engine-api";
import { buildProductionSet } from "@raiopdf/production-set";
import { getLocalEngine, type EngineHandle } from "../engine.js";
import {
  baseOutputSchema,
  errorResult,
  successResult,
  type StructuredToolResult,
} from "../format.js";
import { prepareOutput, preparePackageOutputDir, resolveInput } from "../paths.js";
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
const coverStyleSchema: z.ZodType<PdfCoverStyle> = z
  .enum(["minimal", "labeled", "bordered"])
  .describe("Slip sheet cover style. Defaults to minimal.");
const binderIndexSchema = z.object({
  enabled: z.boolean().optional().describe("Generate an Exhibit Index. Defaults to true."),
  includeSourceFileName: z
    .boolean()
    .optional()
    .describe("Include source filenames in the Exhibit Index. Defaults to false."),
});
const binderOptionsSchema = z.object({
  slipSheets: z.boolean(),
  coverStyle: coverStyleSchema.optional(),
  index: binderIndexSchema.optional(),
  placement: placementSchema.optional(),
  stampPages: pageSelectionSchema.optional(),
  fontSizePt: z.number().positive().optional(),
  marginIn: z.number().nonnegative().optional(),
});
const applyEditsOptionsSchema = z.object({
  markupMode: z.enum(["baked", "annotation"]).optional(),
  printMarkupAnnotations: z.boolean().optional(),
});
const applyEditsTempBytesSchema = z.object({
  tempPath: absoluteInput,
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

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MiB`;
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
  coverStyle: coverStyleSchema.optional(),
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
  coverStyle?: PdfCoverStyle | undefined;
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
      ...(input.coverStyle === undefined ? {} : { coverStyle: input.coverStyle }),
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

// ---- one-shot build_binder ----
export const buildBinderOneShotInputSchema = {
  mainPath: absoluteInput,
  exhibits: z
    .array(z.object({
      path: absoluteInput,
      label: z.string(),
      description: z.string().optional(),
      sourceFileName: z.string().optional(),
    }))
    .min(1),
  options: binderOptionsSchema,
  outputPath: absoluteOutput,
  maxInputBytes: z.number().int().positive(),
};
export const buildBinderOneShotOutputSchema = outputResultSchema;
export interface BuildBinderOneShotInput {
  mainPath: string;
  exhibits: {
    path: string;
    label: string;
    description?: string | undefined;
    sourceFileName?: string | undefined;
  }[];
  options: PdfBinderOptions;
  outputPath: string;
  maxInputBytes: number;
}

export async function handleBuildBinderOneShot(
  input: BuildBinderOneShotInput,
): Promise<StructuredToolResult> {
  if (input.exhibits.length === 0) {
    return errorResult("INVALID_ARGUMENT", "build_binder requires at least one exhibit.");
  }

  const mainStats = await fs.stat(input.mainPath).catch((error: unknown) => {
    throw new Error(`Main PDF is not accessible: ${input.mainPath}.`, { cause: error });
  });
  if (!mainStats.isFile()) {
    return errorResult("INVALID_ARGUMENT", `Main path is not a regular file: ${input.mainPath}.`);
  }
  if (mainStats.size > input.maxInputBytes) {
    return errorResult(
      "INVALID_ARGUMENT",
      `Main PDF is too large for build_binder (${formatBytes(mainStats.size)}).`,
      `Choose a PDF at or below ${formatBytes(input.maxInputBytes)}.`,
    );
  }

  const engine = getLocalEngine();
  const output = await prepareOutput(input.outputPath);
  const opened: PdfDocumentHandle[] = [];
  let produced: Awaited<ReturnType<typeof engine.buildBinder>> | undefined;

  try {
    const main = await engine.open(await fs.readFile(input.mainPath));
    opened.push(main);

    const exhibitInputs = [];
    for (const exhibit of input.exhibits) {
      const doc = await engine.open(await fs.readFile(exhibit.path));
      opened.push(doc);
      exhibitInputs.push({
        doc,
        label: exhibit.label,
        description: exhibit.description,
        sourceFileName: exhibit.sourceFileName,
      });
    }

    produced = await engine.buildBinder(main, exhibitInputs, input.options);
    await output.write(await engine.saveToBytes(produced));
    await output.commit();

    return successResult(
      `Assembled an exhibit binder (${input.exhibits.length} exhibit(s)) into ${input.outputPath}.`,
      { output: output.outputPath },
    );
  } catch (error) {
    await output.abort();
    throw error;
  } finally {
    if (produced !== undefined && !opened.includes(produced)) {
      opened.push(produced);
    }
    for (const document of opened) {
      await engine.close(document).catch(() => undefined);
    }
  }
}

// ---- one-shot apply_edits ----
export const applyEditsOneShotInputSchema = {
  mainPath: absoluteInput,
  edits: z.array(z.unknown()),
  applyOptions: applyEditsOptionsSchema.optional(),
  outputPath: absoluteOutput,
  maxInputBytes: z.number().int().positive(),
};
export const applyEditsOneShotOutputSchema = outputResultSchema;
export interface ApplyEditsOneShotInput {
  mainPath: string;
  edits: unknown[];
  applyOptions?: PdfApplyEditsOptions | undefined;
  outputPath: string;
  maxInputBytes: number;
}

type ImageBackedEditWithTemp = {
  type: "image" | "signature";
  bytes: { tempPath: string };
  format: PdfEditImageFormat;
} & Record<string, unknown>;

export async function handleApplyEditsOneShot(
  input: ApplyEditsOneShotInput,
): Promise<StructuredToolResult> {
  const mainStats = await fs.stat(input.mainPath).catch((error: unknown) => {
    throw new Error(`Main PDF is not accessible: ${input.mainPath}.`, { cause: error });
  });
  if (!mainStats.isFile()) {
    return errorResult("INVALID_ARGUMENT", `Main path is not a regular file: ${input.mainPath}.`);
  }
  if (mainStats.size > input.maxInputBytes) {
    return errorResult(
      "INVALID_ARGUMENT",
      `Main PDF is too large for apply_edits (${formatBytes(mainStats.size)}).`,
      `Choose a PDF at or below ${formatBytes(input.maxInputBytes)}.`,
    );
  }

  const engine = getLocalEngine();
  const output = await prepareOutput(input.outputPath);
  const opened: PdfDocumentHandle[] = [];
  let produced: Awaited<ReturnType<typeof engine.applyEdits>> | undefined;

  try {
    const main = await engine.open(await fs.readFile(input.mainPath));
    opened.push(main);
    const edits = await materializeApplyEdits(input.edits);
    const applyOptions: PdfApplyEditsOptions = {
      markupMode: "annotation",
      printMarkupAnnotations: true,
      ...input.applyOptions,
    };

    produced = await engine.applyEdits(main, edits, applyOptions);
    await output.write(await engine.saveToBytes(produced));
    await output.commit();

    return successResult(
      `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} into ${input.outputPath}.`,
      { output: output.outputPath },
    );
  } catch (error) {
    await output.abort();
    throw error;
  } finally {
    if (produced !== undefined && !opened.includes(produced)) {
      opened.push(produced);
    }
    for (const document of opened) {
      await engine.close(document).catch(() => undefined);
    }
  }
}

async function materializeApplyEdits(edits: readonly unknown[]): Promise<PdfEdit[]> {
  const materialized: PdfEdit[] = [];

  for (const edit of edits) {
    if (!isObject(edit) || typeof edit.type !== "string") {
      throw new Error("Each apply_edits edit must be an object with a type.");
    }

    if (isImageBackedEditWithTemp(edit)) {
      const tempBytes = applyEditsTempBytesSchema.parse(edit.bytes);
      const bytes = new Uint8Array(await fs.readFile(tempBytes.tempPath));
      materialized.push({ ...edit, bytes } as PdfEdit);
      continue;
    }

    materialized.push(edit as PdfEdit);
  }

  return materialized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isImageBackedEditWithTemp(value: Record<string, unknown>): value is ImageBackedEditWithTemp {
  return (
    (value.type === "image" || value.type === "signature") &&
    isObject(value.bytes) &&
    typeof value.bytes.tempPath === "string"
  );
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

// ---- build_production_set ----
export const productionSetInputSchema = {
  sources: z
    .array(z.object({
      path: absoluteInput,
      designation: z.string().optional().describe("Whole-document confidentiality designation."),
    }))
    .min(1)
    .describe("Ordered source PDFs in production order."),
  outputDir: z
    .string()
    .describe("Absolute package root. The directory may not already contain files."),
  prefix: z.string().describe('Bates prefix, e.g. "SMITH".'),
  start: z.number().int().nonnegative().optional().describe("First Bates number. Default 1."),
  digits: z.number().int().min(1).optional().describe("Zero-padded width. Default 6."),
  includeFilenameInIndex: z.boolean().optional().describe("Include produced filenames in the index. Default true."),
  includeIndex: z.boolean().optional().describe("Write production-index.pdf and production-index.csv. Default true."),
  combinedPdf: z.boolean().optional().describe("Also write a single combined production PDF. Default false."),
  volumeSizeMb: z.number().positive().optional().describe("Optional volume folder cap in megabytes."),
};
export const productionSetOutputSchema = {
  ...baseOutputSchema,
  packageRoot: z.string().optional(),
  outputs: z.array(z.string()).optional(),
  nextNumber: z.number().optional(),
  indexPdf: z.string().nullable().optional(),
  indexCsv: z.string().nullable().optional(),
  combinedPdf: z.string().nullable().optional(),
};
export interface ProductionSetInput {
  sources: { path: string; designation?: string | undefined }[];
  outputDir: string;
  prefix: string;
  start?: number | undefined;
  digits?: number | undefined;
  includeFilenameInIndex?: boolean | undefined;
  includeIndex?: boolean | undefined;
  combinedPdf?: boolean | undefined;
  volumeSizeMb?: number | undefined;
}
export async function handleProductionSet(
  input: ProductionSetInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  const resolvedSources = await Promise.all(
    input.sources.map(async (source) => ({
      ...source,
      path: (await resolveInput(source.path)).realPath,
    })),
  );
  const output = await preparePackageOutputDir(input.outputDir);
  const result = await buildProductionSet({
    sources: resolvedSources,
    outputDir: output.outputPath,
    prefix: input.prefix,
    ...(input.start === undefined ? {} : { start: input.start }),
    ...(input.digits === undefined ? {} : { digits: input.digits }),
    ...(input.includeFilenameInIndex === undefined
      ? {}
      : { includeFilenameInIndex: input.includeFilenameInIndex }),
    ...(input.includeIndex === undefined ? {} : { includeIndex: input.includeIndex }),
    ...(input.combinedPdf === undefined ? {} : { combinedPdf: input.combinedPdf }),
    ...(input.volumeSizeMb === undefined ? {} : { volumeSizeMb: input.volumeSizeMb }),
  });

  return successResult(
    `Built a Bates production package with ${result.files.length} file(s) at ${result.packageRoot}.`,
    {
      packageRoot: result.packageRoot,
      outputs: result.files.map((file) => file.packageRelativePath),
      nextNumber: result.nextNumber,
      indexPdf: result.indexPdf,
      indexCsv: result.indexCsv,
      combinedPdf: result.combinedPdf,
    },
  );
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
    return { result: result.document, summary: `Extracted ${keep.size} page(s) into ${input.output}.` };
  });
}
