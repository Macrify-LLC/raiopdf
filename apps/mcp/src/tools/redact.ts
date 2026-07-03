import { promises as fs } from "node:fs";
import { z } from "zod";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { EngineHandle } from "../engine.js";
import {
  baseOutputSchema,
  errorResult,
  successResult,
  type StructuredToolResult,
} from "../format.js";
import { prepareOutput, resolveInput } from "../paths.js";
import { verifyTermsRemoved } from "../redaction/verify.js";

export const redactInputSchema = {
  input: z.string().describe("Absolute path to an existing PDF file."),
  output: z
    .string()
    .describe("Absolute path for the redacted PDF. Must not already exist (never overwrites)."),
  terms: z
    .array(z.string().min(1))
    .min(1)
    .describe("Text terms to redact (case-insensitive)."),
  wholeWord: z.boolean().optional().describe("Match whole words only."),
};
export const redactOutputSchema = {
  ...baseOutputSchema,
  output: z.string().optional(),
  survivingTerms: z.array(z.string()).optional(),
};
export interface RedactInput {
  input: string;
  output: string;
  terms: string[];
  wholeWord?: boolean | undefined;
}

/**
 * Redacts terms by routing through Stirling's rasterizing auto-redact (which
 * removes recoverable text by converting pages to images), then verifies with
 * pdf.js that no redacted term survives. If verification fails, nothing is
 * written — the "fail leaves no output" guarantee.
 */
export async function handleRedact(
  input: RedactInput,
  engineHandle: EngineHandle,
): Promise<StructuredToolResult> {
  const source = await resolveInput(input.input);
  const output = await prepareOutput(input.output);
  const opened: PdfDocumentHandle[] = [];
  const produced: PdfDocumentHandle[] = [];
  let engine: Awaited<ReturnType<EngineHandle["getEngine"]>> | undefined;

  try {
    // Inside the try so a sidecar-start failure still aborts the reserved output.
    engine = await engineHandle.getEngine();
    const bytes = await fs.readFile(source.realPath);
    const document = await engine.open(bytes);
    opened.push(document);

    const redacted = await engine.redactText(document, {
      terms: input.terms,
      rasterize: true,
      ...(input.wholeWord === undefined ? {} : { wholeWord: input.wholeWord }),
    });
    if (redacted !== document) {
      produced.push(redacted);
    }
    const redactedBytes = await engine.saveToBytes(redacted);

    const verification = await verifyTermsRemoved(redactedBytes, input.terms, {
      wholeWord: input.wholeWord ?? false,
    });
    if (!verification.ok) {
      await output.abort();
      return errorResult(
        "REDACTION_UNVERIFIED",
        `Redaction verification failed — the following term(s) are still extractable after redaction: ${verification.survivingTerms.join(", ")}. The document was NOT written.`,
        "Nothing was saved. Re-run, refine the terms, or redact by area.",
      );
    }

    await output.write(redactedBytes);
    await output.commit();
    return successResult(
      `Redacted ${input.terms.length} term(s) into ${input.output}; verified no term remains extractable.`,
      { output: output.outputPath, survivingTerms: [] },
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
