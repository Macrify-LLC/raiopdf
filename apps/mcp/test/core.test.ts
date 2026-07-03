import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { EngineHandle } from "../src/engine.js";
import { handleOcr } from "../src/tools/core.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-core-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("handleOcr", () => {
  it("writes the OCR output only after every page has extractable text", async () => {
    const input = await writeInput("scan.pdf");
    const output = path.join(dir, "searchable.pdf");
    const outputBytes = await pdfWithPageTexts(["page one", "page two"]);
    const { handle } = fakeOcrEngine(outputBytes);

    const result = await handleOcr({ input, output }, handle);

    expect(result.structuredContent).toMatchObject({
      ok: true,
      output,
      verifiedPages: 2,
    });
    expect(await fs.readFile(output)).toEqual(Buffer.from(outputBytes));
  });

  it("returns a structured failure and leaves no output when OCR misses a page", async () => {
    const input = await writeInput("scan.pdf");
    const output = path.join(dir, "partial.pdf");
    const outputBytes = await pdfWithPageTexts(["page one", ""]);
    const { handle } = fakeOcrEngine(outputBytes);

    const result = await handleOcr({ input, output }, handle);

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "OCR_UNVERIFIED" },
      missingTextPages: [2],
      verifiedPages: 1,
    });
    await expect(fs.access(output)).rejects.toBeTruthy();
    const leftovers = (await fs.readdir(dir)).filter((entry) => entry !== "scan.pdf");
    expect(leftovers).toEqual([]);
  });
});

async function writeInput(name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdfWithPageTexts(["source"]));
  return filePath;
}

function fakeOcrEngine(outputBytes: Uint8Array): { handle: EngineHandle } {
  const input = "input" as PdfDocumentHandle;
  const output = "output" as PdfDocumentHandle;
  const engine = {
    open: async () => input,
    ocr: async () => output,
    saveToBytes: async (document: PdfDocumentHandle) => {
      if (document !== output) {
        throw new Error("unexpected save handle");
      }
      return outputBytes;
    },
    close: async () => undefined,
  };

  return {
    handle: { getEngine: async () => engine } as unknown as EngineHandle,
  };
}

async function pdfWithPageTexts(pageTexts: readonly string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = pdf.addPage([400, 200]);
    if (text.length > 0) {
      page.drawText(text, { x: 10, y: 100, size: 12, font });
    }
  }
  return pdf.save();
}
