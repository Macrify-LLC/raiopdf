import { promises as fs } from "node:fs";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { SidecarPdfEngine } from "@raiopdf/engine-sidecar";
import type { EngineHandle } from "./engine.js";
import { successResult, type StructuredToolResult } from "./format.js";
import { prepareOutput, resolveInput } from "./paths.js";

export type OpProduction = {
  /** The document to save to the output path. */
  result: PdfDocumentHandle;
  /** One-line human summary for the tool's text content. */
  summary: string;
  /** Extra structured fields to merge into the tool result. */
  extra?: Record<string, unknown>;
};

/**
 * Shared runner for file-in / file-out engine tools. Applies the hardened path
 * policy (realpath inputs, exclusive no-clobber output via temp+atomic rename),
 * opens each input, runs `produce`, saves the produced document to the output,
 * and always closes every opened document. On any failure the partial output is
 * removed.
 */
export async function runOutputOp(
  engineHandle: EngineHandle,
  inputPaths: readonly string[],
  outputPath: string,
  produce: (
    engine: SidecarPdfEngine,
    documents: PdfDocumentHandle[],
  ) => Promise<OpProduction>,
): Promise<StructuredToolResult> {
  const resolvedInputs = await Promise.all(inputPaths.map((path) => resolveInput(path)));
  const output = await prepareOutput(outputPath);
  const engine = await engineHandle.getEngine();
  const opened: PdfDocumentHandle[] = [];

  try {
    for (const input of resolvedInputs) {
      const bytes = await fs.readFile(input.realPath);
      opened.push(await engine.open(bytes));
    }

    const { result, summary, extra } = await produce(engine, opened);
    const outputBytes = await engine.saveToBytes(result);
    await output.write(outputBytes);
    await output.commit();

    if (!opened.includes(result)) {
      await engine.close(result).catch(() => undefined);
    }

    return successResult(summary, { output: output.outputPath, ...(extra ?? {}) });
  } catch (error) {
    await output.abort();
    throw error;
  } finally {
    for (const document of opened) {
      await engine.close(document).catch(() => undefined);
    }
  }
}

/** Single-input variant of {@link runOutputOp} that hands `produce` one document. */
export function runSingleOutputOp(
  engineHandle: EngineHandle,
  inputPath: string,
  outputPath: string,
  produce: (engine: SidecarPdfEngine, document: PdfDocumentHandle) => Promise<OpProduction>,
): Promise<StructuredToolResult> {
  return runOutputOp(engineHandle, [inputPath], outputPath, async (engine, documents) => {
    const document = documents[0];
    if (document === undefined) {
      throw new Error("Expected exactly one opened input document.");
    }
    return produce(engine, document);
  });
}

/** Resolve a `"all" | number[]` page selection to concrete zero-based indexes. */
export async function resolvePageIndexes(
  engine: SidecarPdfEngine,
  document: PdfDocumentHandle,
  pages: readonly number[] | "all",
): Promise<number[]> {
  if (pages === "all") {
    const count = await engine.pageCount(document);
    return Array.from({ length: count }, (_, index) => index);
  }
  return [...pages];
}
