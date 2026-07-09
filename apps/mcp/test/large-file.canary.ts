// Opt-in large-file canary for the Node one-shot lane used by streamed
// Combine with Exhibits and streamed overlay Apply/Save. It intentionally uses
// a gitignored large fixture; default path matches the UI synthetic generator.

import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleApplyEditsOneShot,
  handleBuildBinderOneShot,
} from "../src/tools/legal.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const defaultFixture = path.join(repoRoot, "apps", "ui", "smoke", "fixtures.local", "synthetic-large.pdf");
const fixturePath = process.env.RAIOPDF_LARGE_FIXTURE?.split(path.delimiter).find(Boolean) ?? defaultFixture;
const minBytes = Number(process.env.RAIOPDF_LARGE_FIXTURE_MIN_BYTES ?? 50 * 1024 * 1024);
const fixtureReady = existsSync(fixturePath) && statSync(fixturePath).size >= minBytes;

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-large-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!fixtureReady)("large-file Node one-shot lane canary", () => {
  it("build_binder accepts a large main PDF plus a small exhibit under the aggregate cap", async () => {
    const exhibit = await writeSmallPdf("exhibit.pdf", "Large binder exhibit canary");
    const output = path.join(dir, "large-binder.pdf");
    const fixtureSize = statSync(fixturePath).size;
    const exhibitSize = statSync(exhibit).size;

    const result = await handleBuildBinderOneShot({
      mainPath: fixturePath,
      exhibits: [{ path: exhibit, label: "Exhibit A", sourceFileName: "exhibit.pdf" }],
      options: { slipSheets: false },
      outputPath: output,
      maxInputBytes: fixtureSize + exhibitSize + 10 * 1024 * 1024,
    });

    expect(result.structuredContent).toMatchObject({ ok: true, output });
    expect((await fs.stat(output)).size).toBeGreaterThan(0);
  });

  it("build_binder rejects a large main plus exhibit above the aggregate cap before writing output", async () => {
    const exhibit = await writeSmallPdf("exhibit.pdf", "Aggregate cap canary");
    const output = path.join(dir, "over-cap-binder.pdf");
    const fixtureSize = statSync(fixturePath).size;

    const result = await handleBuildBinderOneShot({
      mainPath: fixturePath,
      exhibits: [{ path: exhibit, label: "Exhibit A" }],
      options: { slipSheets: false },
      outputPath: output,
      maxInputBytes: fixtureSize,
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("combined"),
      },
    });
    await expect(fs.access(output)).rejects.toBeTruthy();
  });

  it("apply_edits writes a large overlay output under the Node cap", async () => {
    const output = path.join(dir, "large-edited.pdf");
    const fixtureSize = statSync(fixturePath).size;

    const result = await handleApplyEditsOneShot({
      mainPath: fixturePath,
      edits: [{
        type: "comment",
        pageIndex: 0,
        at: { x: 72, y: 72 },
        text: "Large overlay canary",
      }],
      applyOptions: { markupMode: "annotation" },
      outputPath: output,
      maxInputBytes: fixtureSize + 10 * 1024 * 1024,
    });

    expect(result.structuredContent).toMatchObject({ ok: true, output });
    expect((await fs.stat(output)).size).toBeGreaterThan(0);
  });
});

async function writeSmallPdf(name: string, text: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([200, 200]);
  page.drawText(text, { x: 20, y: 100, size: 12, font });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}
