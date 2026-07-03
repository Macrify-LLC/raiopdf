import { promises as fs } from "node:fs";
import { z } from "zod";
import type { EngineHandle } from "../engine.js";
import { baseOutputSchema, successResult, type StructuredToolResult } from "../format.js";
import { resolveInput } from "../paths.js";

export const pageCountInputSchema = {
  path: z.string().describe("Absolute path to an existing PDF file."),
};

export const pageCountOutputSchema = {
  ...baseOutputSchema,
  pageCount: z.number().int().nonnegative().optional(),
};

export type PageCountInput = {
  path: string;
};

export async function handlePageCount(
  input: PageCountInput,
  engineHandle: EngineHandle,
): Promise<StructuredToolResult> {
  const inputFile = await resolveInput(input.path);
  const bytes = await fs.readFile(inputFile.realPath);
  const engine = await engineHandle.getEngine();
  const document = await engine.open(bytes);

  try {
    const pageCount = await engine.pageCount(document);

    return successResult(`${pageCount} page${pageCount === 1 ? "" : "s"}.`, {
      pageCount,
    });
  } finally {
    await engine.close(document);
  }
}
