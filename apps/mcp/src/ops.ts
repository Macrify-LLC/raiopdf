import { promises as fs } from "node:fs";
import type { PdfDocumentHandle, PdfEngine } from "@raiopdf/engine-api";
import type { SidecarPdfEngine } from "@raiopdf/engine-sidecar";
import { getLocalEngine, type EngineHandle } from "./engine.js";
import { successResult, type StructuredToolResult } from "./format.js";
import { prepareOutput, resolveInput, type PreparedOutput } from "./paths.js";

export type OpProduction = {
  /** The document to save to the output path. */
  result: PdfDocumentHandle;
  /** One-line human summary for the tool's text content. */
  summary: string;
  /** Extra structured fields to merge into the tool result. */
  extra?: Record<string, unknown>;
};

/** The engine surface the shared runner needs, satisfied by both engines. */
type EngineOps = Pick<PdfEngine, "open" | "close" | "saveToBytes">;

async function runOutputOpCore<E extends EngineOps>(
  getEngine: () => Promise<E>,
  inputPaths: readonly string[],
  outputPath: string,
  produce: (engine: E, documents: PdfDocumentHandle[]) => Promise<OpProduction>,
): Promise<StructuredToolResult> {
  const resolvedInputs = await Promise.all(inputPaths.map((path) => resolveInput(path)));
  const output = await prepareOutput(outputPath);
  const opened: PdfDocumentHandle[] = [];
  let engine: E | undefined;
  let produced: PdfDocumentHandle | undefined;

  try {
    // Inside the try so an engine-start failure still aborts the reserved output.
    engine = await getEngine();
    for (const input of resolvedInputs) {
      const bytes = await fs.readFile(input.realPath);
      opened.push(await engine.open(bytes));
    }

    const { result, summary, extra } = await produce(engine, opened);
    produced = result;
    const outputBytes = await engine.saveToBytes(result);
    await output.write(outputBytes);
    await output.commit();

    return successResult(summary, { output: output.outputPath, ...(extra ?? {}) });
  } catch (error) {
    await output.abort();
    throw error;
  } finally {
    if (engine !== undefined) {
      const toClose = [...opened];
      if (produced !== undefined && !opened.includes(produced)) {
        toClose.push(produced);
      }
      for (const document of toClose) {
        await engine.close(document).catch(() => undefined);
      }
    }
  }
}

// ---- sidecar (engine-host) runners ----

export function runOutputOp(
  engineHandle: EngineHandle,
  inputPaths: readonly string[],
  outputPath: string,
  produce: (engine: SidecarPdfEngine, documents: PdfDocumentHandle[]) => Promise<OpProduction>,
): Promise<StructuredToolResult> {
  return runOutputOpCore<SidecarPdfEngine>(
    () => engineHandle.getEngine(),
    inputPaths,
    outputPath,
    produce,
  );
}

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

// ---- local (in-process pdf-lib) runners ----

export function runLocalOutputOp(
  inputPaths: readonly string[],
  outputPath: string,
  produce: (engine: PdfEngine, documents: PdfDocumentHandle[]) => Promise<OpProduction>,
): Promise<StructuredToolResult> {
  return runOutputOpCore<PdfEngine>(
    () => Promise.resolve(getLocalEngine()),
    inputPaths,
    outputPath,
    produce,
  );
}

export function runLocalSingleOutputOp(
  inputPath: string,
  outputPath: string,
  produce: (engine: PdfEngine, document: PdfDocumentHandle) => Promise<OpProduction>,
): Promise<StructuredToolResult> {
  return runLocalOutputOp([inputPath], outputPath, async (engine, documents) => {
    const document = documents[0];
    if (document === undefined) {
      throw new Error("Expected exactly one opened input document.");
    }
    return produce(engine, document);
  });
}

/** Resolve a `"all" | number[]` page selection to concrete zero-based indexes. */
export async function resolvePageIndexes(
  engine: Pick<PdfEngine, "pageCount">,
  document: PdfDocumentHandle,
  pages: readonly number[] | "all",
): Promise<number[]> {
  if (pages === "all") {
    const count = await engine.pageCount(document);
    return Array.from({ length: count }, (_, index) => index);
  }
  return [...pages];
}

/**
 * Write several output files all-or-nothing: every target is reserved
 * (exclusive-create, no clobber) and written before any is committed, and any
 * failure aborts every reservation. Used by the multi-output tools (split,
 * bates_stamp_folder).
 */
export async function writeManyOutputs(
  outputs: readonly { path: string; bytes: Uint8Array }[],
): Promise<string[]> {
  const prepared: PreparedOutput[] = [];
  const committed: string[] = [];
  try {
    for (const output of outputs) {
      const handle = await prepareOutput(output.path);
      prepared.push(handle);
      await handle.write(output.bytes);
    }
    for (const handle of prepared) {
      await handle.commit();
      committed.push(handle.outputPath);
    }
    return committed;
  } catch (error) {
    // abort() cleans up any not-yet-committed reservation + temp file.
    for (const handle of prepared) {
      await handle.abort().catch(() => undefined);
    }
    // A commit can fail after earlier ones already renamed into place; remove
    // those so the batch is best-effort all-or-nothing.
    for (const outputPath of committed) {
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
