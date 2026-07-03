import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PdfDocumentHandle } from "@raiopdf/engine-api";
import type { EngineHandle } from "../src/engine.js";
import { handleOcr, handleRemoveEncryption } from "../src/tools/core.js";

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

describe("handleRemoveEncryption", () => {
  it("writes unlocked bytes without echoing the password", async () => {
    const input = await writeInput("locked.pdf");
    const output = path.join(dir, "unlocked.pdf");
    const unlockedBytes = await pdfWithPageTexts(["unlocked"]);
    const { handle } = fakeRemoveEncryptionEngine(unlockedBytes, "sensitive-password");

    const result = await handleRemoveEncryption({
      input,
      output,
      password: "sensitive-password",
    }, handle);

    expect(result.structuredContent).toMatchObject({
      ok: true,
      output,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-password");
    expect(await fs.readFile(output)).toEqual(Buffer.from(unlockedBytes));
  });

  it.skipIf(!hasQpdf())("round-trips a qpdf-encrypted fixture through remove_encryption", async () => {
    const fixture = await createEncryptedPdfFixture("open-sesame");
    const input = path.join(dir, "locked.pdf");
    const output = path.join(dir, "unlocked.pdf");
    await fs.writeFile(input, fixture.encrypted);
    const { handle } = fakeRemoveEncryptionEngine(fixture.decrypted, "open-sesame");

    const result = await handleRemoveEncryption({
      input,
      output,
      password: "open-sesame",
    }, handle);

    expect(JSON.stringify(result)).not.toContain("open-sesame");
    const outputBytes = await fs.readFile(output);
    await expect(PDFDocument.load(outputBytes, { updateMetadata: false })).resolves.toBeTruthy();
    expect(outputBytes.toString("latin1")).not.toContain("/Encrypt");
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

function fakeRemoveEncryptionEngine(
  outputBytes: Uint8Array,
  expectedPassword: string,
): { handle: EngineHandle } {
  const engine = {
    removeEncryption: async (_bytes: Uint8Array, password: string) => {
      if (password !== expectedPassword) {
        throw new Error("wrong password");
      }
      return outputBytes;
    },
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

function hasQpdf(): boolean {
  return spawnSync("qpdf", ["--version"], { stdio: "ignore" }).status === 0;
}

async function createEncryptedPdfFixture(password: string): Promise<{
  decrypted: Uint8Array;
  encrypted: Uint8Array;
}> {
  const fixtureDir = await fs.mkdtemp(path.join(dir, "qpdf-"));
  const plainPath = path.join(fixtureDir, "plain.pdf");
  const encryptedPath = path.join(fixtureDir, "encrypted.pdf");
  const decryptedPath = path.join(fixtureDir, "decrypted.pdf");

  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  await fs.writeFile(plainPath, await pdf.save());
  runQpdf([
    "--encrypt",
    password,
    password,
    "256",
    "--",
    plainPath,
    encryptedPath,
  ]);
  runQpdf([
    `--password=${password}`,
    "--decrypt",
    encryptedPath,
    decryptedPath,
  ]);

  return {
    encrypted: await fs.readFile(encryptedPath),
    decrypted: await fs.readFile(decryptedPath),
  };
}

function runQpdf(args: readonly string[]): void {
  const result = spawnSync("qpdf", [...args], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`qpdf failed: ${result.stderr || result.stdout}`);
  }
}
