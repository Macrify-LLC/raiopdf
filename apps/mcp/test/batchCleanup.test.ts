import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine.js";
import { handleBatchCleanup } from "../src/tools/batchCleanup.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-batch-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("batch_cleanup tool", () => {
  it("accepts an existing empty package directory", async () => {
    const source = await makePdf("source.pdf");
    const outputDir = path.join(dir, "package");
    await fs.mkdir(outputDir);

    const result = await handleBatchCleanup(
      {
        inputs: [source],
        outputDir,
        operations: {
          sanitize: false,
          scrubMetadata: true,
          ocrMode: "off",
        },
      },
      throwingEngineHandle(),
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      packageRoot: outputDir,
    });
    await expect(fs.access(path.join(outputDir, "upload", "source - cleaned.pdf"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputDir, "raio-manifest", "manifest.json"))).resolves.toBeUndefined();
  });

  it("does not start the sidecar for local-only batches", async () => {
    const source = await makePdf("source.pdf");
    const outputDir = path.join(dir, "package");
    let starts = 0;

    await handleBatchCleanup(
      {
        inputs: [source],
        outputDir,
        operations: {
          sanitize: false,
          scrubMetadata: true,
          ocrMode: "off",
        },
      },
      ({
        async getEngine() {
          starts += 1;
          throw new Error("sidecar should not start");
        },
      } as unknown) as EngineHandle,
    );

    expect(starts).toBe(0);
  });
});

async function makePdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([240, 240]);
  page.drawText(`Source ${name}`, { x: 12, y: 120, size: 10, font });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

function throwingEngineHandle(): EngineHandle {
  return ({
    async getEngine() {
      throw new Error("sidecar should not start");
    },
  } as unknown) as EngineHandle;
}
