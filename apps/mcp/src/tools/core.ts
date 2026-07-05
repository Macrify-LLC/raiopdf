import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { EngineHandle } from "../engine.js";
import {
  baseOutputSchema,
  errorResult,
  successResult,
  type StructuredToolResult,
} from "../format.js";
import { resolvePageIndexes, runLocalOutputOp, runOutputOp, runSingleOutputOp } from "../ops.js";
import { prepareOutput, resolveInput } from "../paths.js";
import { extractTextLayerCoverage } from "../pdfjs-node.js";

const execFileAsync = promisify(execFile);

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
export const ocrOutputSchema = {
  ...outputResultSchema,
  verifiedPages: z.number().optional(),
  missingTextPages: z.array(z.number()).optional(),
  garbledPages: z.number().optional(),
};
export interface OcrInput {
  input: string;
  output: string;
  languages?: string[] | undefined;
  force?: boolean | undefined;
}
export async function handleOcr(
  input: OcrInput,
  engineHandle: EngineHandle,
): Promise<StructuredToolResult> {
  const source = await resolveInput(input.input);
  const output = await prepareOutput(input.output);
  const opened: PdfDocumentHandle[] = [];
  const produced: PdfDocumentHandle[] = [];
  let engine: Awaited<ReturnType<EngineHandle["getEngine"]>> | undefined;

  try {
    // Inside the try so an engine-start failure still aborts the reserved output.
    engine = await engineHandle.getEngine();
    const bytes = await fs.readFile(source.realPath);
    const document = await engine.open(bytes);
    opened.push(document);

    const searchable = await engine.ocr(document, {
      languages: input.languages ?? ["eng"],
      ocrType: input.force ? "force-ocr" : "skip-text",
    });
    if (searchable !== document) {
      produced.push(searchable);
    }

    const searchableBytes = await engine.saveToBytes(searchable);
    const coverage = summarizeTextLayerCoverage(await extractTextLayerCoverage(searchableBytes));
    if (!coverage.verified) {
      await output.abort();
      const result = errorResult(
        "OCR_UNVERIFIED",
        `${formatOcrCoverageFailure(coverage)} The document was NOT written.`,
        "Re-run OCR with different settings or inspect the source scan quality.",
      );
      return {
        ...result,
        structuredContent: {
          ...result.structuredContent,
          missingTextPages: coverage.missingTextPages,
          garbledPages: coverage.garbledPages,
          verifiedPages: Math.max(0, coverage.pagesWithText.length - coverage.garbledPages),
        },
      };
    }

    await output.write(searchableBytes);
    await output.commit();

    return successResult(
      `Made searchable via OCR: ${output.outputPath}; verified text on ${coverage.pageCount} page(s).`,
      { output: output.outputPath, verifiedPages: coverage.pageCount, garbledPages: 0 },
    );
  } catch (error) {
    await output.abort();
    throw error;
  } finally {
    if (engine !== undefined) {
      for (const document of [...produced, ...opened]) {
        await engine.close(document).catch(() => undefined);
      }
    }
  }
}

// pdf.js's coverage detector buckets by 0-indexed page position and by
// image/text/mixed content; OCR verification only cares whether page-body
// text exists at all, reported as 1-indexed page numbers.
function summarizeTextLayerCoverage(layer: {
  imageOnlyPages: readonly number[];
  mixedPages: readonly number[];
  textPages: readonly number[];
  garbledPages: readonly { pageIndex: number }[];
}): {
  pageCount: number;
  pagesWithText: number[];
  missingTextPages: number[];
  garbledPages: number;
  verified: boolean;
  hasAnyText: boolean;
} {
  const pagesWithText = [...layer.mixedPages, ...layer.textPages]
    .map((pageIndex) => pageIndex + 1)
    .sort((a, b) => a - b);
  const missingTextPages = [...layer.imageOnlyPages].map((pageIndex) => pageIndex + 1).sort((a, b) => a - b);
  const pageCount = pagesWithText.length + missingTextPages.length;

  return {
    pageCount,
    pagesWithText,
    missingTextPages,
    garbledPages: layer.garbledPages.length,
    verified: pageCount > 0 && missingTextPages.length === 0 && layer.garbledPages.length === 0,
    hasAnyText: pagesWithText.length > 0,
  };
}

function formatOcrCoverageFailure(coverage: {
  pageCount: number;
  hasAnyText: boolean;
  missingTextPages: readonly number[];
  garbledPages: number;
}): string {
  if (coverage.pageCount === 0) {
    return "OCR verification failed because the output PDF has no pages.";
  }

  if (!coverage.hasAnyText) {
    return "OCR verification failed because the output PDF has no extractable page text.";
  }

  if (coverage.garbledPages > 0) {
    const missingText = coverage.missingTextPages.length > 0
      ? ` and page(s) ${coverage.missingTextPages.join(", ")} have no extractable text`
      : "";
    return `OCR verification failed because ${coverage.garbledPages} page(s) still have a garbled text layer${missingText}.`;
  }

  return `OCR verification failed because page(s) ${coverage.missingTextPages.join(", ")} have no extractable text.`;
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
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  return runLocalOutputOp(input.inputs, input.output, async (e, documents) => {
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
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  void input.quality;
  void input.grayscale;
  return handleCompressWithQpdf(input);
}

async function handleCompressWithQpdf(input: CompressInput): Promise<StructuredToolResult> {
  const source = await resolveInput(input.input);
  const output = await prepareOutput(input.output);

  try {
    const compressedBytes = await compressWithQpdf(source.realPath, output.tempPath);
    await output.write(compressedBytes);
    await output.commit();

    return successResult("Compressed into a new PDF.", { output: output.outputPath });
  } catch (error) {
    await output.abort();
    throw error;
  }
}

async function compressWithQpdf(inputPath: string, outputTempPath: string): Promise<Uint8Array> {
  const qpdf = await resolveQpdfBinary();
  const qpdfOutput = `${outputTempPath}.qpdf.pdf`;

  try {
    await execFileAsync(qpdf, [
      "--warning-exit-0",
      "--object-streams=generate",
      "--compress-streams=y",
      "--recompress-flate",
      "--linearize",
      inputPath,
      qpdfOutput,
    ]);
    const bytes = await fs.readFile(qpdfOutput);
    if (bytes.byteLength === 0) {
      throw new Error("qpdf produced an empty compressed PDF.");
    }
    return new Uint8Array(bytes);
  } catch (error) {
    throw new Error(formatQpdfCompressError(error));
  } finally {
    await fs.rm(qpdfOutput, { force: true }).catch(() => undefined);
  }
}

// ---- remove_encryption ----
export const removeEncryptionInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  password: z.string().describe("Sensitive PDF open password. Never echoed in tool results."),
};
export const removeEncryptionOutputSchema = outputResultSchema;
export interface RemoveEncryptionInput {
  input: string;
  output: string;
  password: string;
}
export async function handleRemoveEncryption(
  input: RemoveEncryptionInput,
  _engineHandle: EngineHandle,
): Promise<StructuredToolResult> {
  const source = await resolveInput(input.input);
  const output = await prepareOutput(input.output);

  try {
    const unlockedBytes = await decryptWithQpdf(source.realPath, input.password, output.tempPath);
    await output.write(unlockedBytes);
    await output.commit();

    return successResult("Removed encryption and wrote a new PDF.", { output: output.outputPath });
  } catch (error) {
    await output.abort();
    throw error;
  }
}

async function decryptWithQpdf(inputPath: string, password: string, outputTempPath: string): Promise<Uint8Array> {
  const qpdf = await resolveQpdfBinary();
  const workDir = await fs.mkdtemp(path.join(tmpdir(), "raiopdf-mcp-decrypt-"));
  const passwordPath = path.join(workDir, "password.txt");
  const qpdfOutput = `${outputTempPath}.qpdf.pdf`;

  try {
    await fs.writeFile(passwordPath, password);
    await execFileAsync(qpdf, [
      "--warning-exit-0",
      "--decrypt",
      `--password-file=${passwordPath}`,
      inputPath,
      qpdfOutput,
    ]);
    const bytes = await fs.readFile(qpdfOutput);
    if (bytes.byteLength === 0) {
      throw new Error("qpdf produced an empty decrypted PDF.");
    }
    return new Uint8Array(bytes);
  } catch (error) {
    throw new Error(formatQpdfDecryptError(error));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(qpdfOutput, { force: true }).catch(() => undefined);
  }
}

async function resolveQpdfBinary(): Promise<string> {
  const payloadDir = process.env.RAIOPDF_ENGINE_PAYLOAD_DIR
    ?? (process.env.RAIOPDF_ENGINE_RESOURCE_DIR
      ? path.join(process.env.RAIOPDF_ENGINE_RESOURCE_DIR, "payload")
      : undefined);
  const candidates = [
    process.env.RAIOPDF_ENGINE_QPDF,
    payloadDir
      ? path.join(
          payloadDir,
          "ocr",
          "qpdf",
          "bin",
          process.platform === "win32" ? "qpdf.exe" : "qpdf",
        )
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next explicit candidate, then fall back to PATH.
    }
  }

  return process.platform === "win32" ? "qpdf.exe" : "qpdf";
}

function formatQpdfDecryptError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim()
  ) {
    return `qpdf decrypt failed: ${error.stderr.trim()}`;
  }
  if (error instanceof Error) {
    return `qpdf decrypt failed: ${error.message}`;
  }
  return "qpdf decrypt failed.";
}

function formatQpdfCompressError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim()
  ) {
    return `qpdf compress failed: ${error.stderr.trim()}`;
  }
  if (error instanceof Error) {
    return `qpdf compress failed: ${error.message}`;
  }
  return "qpdf compress failed.";
}

// ---- sanitize_pdf ----
export const sanitizeInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  removeJavaScript: z.boolean().optional().describe("Default true."),
  removeEmbeddedFiles: z.boolean().optional().describe("Default true."),
  removeLinks: z.boolean().optional().describe("Default true."),
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
      removeLinks: input.removeLinks ?? true,
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
