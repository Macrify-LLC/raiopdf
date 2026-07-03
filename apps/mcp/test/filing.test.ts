import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine.js";
import { handlePrepareForFiling } from "../src/tools/filing.js";

const engine = {} as EngineHandle;

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-filing-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function makePdf(name: string, widthIn: number, heightIn: number, withText: boolean): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([widthIn * 72, heightIn * 72]);
  if (withText) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Filing document text", { x: 20, y: 40, size: 10, font });
  }
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

function structured(result: { structuredContent: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent;
}

type Check = { label: string; authority: string; status: string; kind: string };

describe("prepare_for_filing", () => {
  it("returns a rule-cited preflight report for a letter-portrait searchable PDF", async () => {
    const input = await makePdf("letter.pdf", 8.5, 11, true);
    const content = structured(await handlePrepareForFiling({ input }, engine));
    expect(content.ok).toBe(true);
    expect(content.pack).toMatchObject({ id: "florida" });
    expect(typeof content.guidance).toBe("string");
    const checks = content.checks as Check[];
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(typeof check.authority).toBe("string");
      expect(check.authority.length).toBeGreaterThan(0);
    }
  });

  it("does not report the document as confirmed-ready when the page size is non-standard", async () => {
    const input = await makePdf("legal.pdf", 8.5, 14, true);
    const content = structured(await handlePrepareForFiling({ input }, engine));
    const checks = content.checks as Check[];
    const anyNonPass = checks.some((check) => check.status !== "pass");
    expect(content.confirmedReady === false || anyNonPass).toBe(true);
  });

  it("never reports confirmed-ready while clerk-stamp / PDF-A remain unverified", async () => {
    const input = await makePdf("letter2.pdf", 8.5, 11, true);
    const content = structured(await handlePrepareForFiling({ input }, engine));
    // We cannot verify clerk-stamp geometry or PDF/A in Node, so those are unknown.
    expect((content.unverified as string[]).length).toBeGreaterThan(0);
    expect(content.confirmedReady).toBe(false);
  });

  it("rejects an unknown jurisdiction pack", async () => {
    const input = await makePdf("x.pdf", 8.5, 11, true);
    const result = await handlePrepareForFiling({ input, pack: "atlantis" }, engine);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });
});
