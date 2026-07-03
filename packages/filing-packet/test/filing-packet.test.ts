import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractAllText, extractPageTextByPage, extractTextLayerCoverage } from "@raiopdf/rules/node";
import { buildFilingPacket } from "../src/index";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-filing-packet-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("buildFilingPacket", () => {
  it("builds a separate-file package with split naming, manifests, checks, and overrides", async () => {
    const motion = await writePdf("Motion to Compel.pdf", [
      "MOTION TO COMPEL",
      "I certify that prior to filing this motion, counsel conferred.",
      "motion body",
    ]);
    const exhibit = await writePdf("Exhibit A - Email Chain.pdf", ["email one", "email two"]);
    const notice = await writePdf("Notice of Filing.pdf", ["notice"]);
    const outputDir = path.join(dir, "packet");

    const result = await buildFilingPacket({
      sources: [
        { path: motion },
        { path: exhibit },
        { path: notice },
      ],
      outputDir,
      packId: "florida",
      checklist: {
        selectedStepIds: ["normalize-pages", "scrub-metadata", "split-by-size"],
        skippedStepIds: ["make-searchable"],
        splitSizeMb: 0.001,
      },
      createdAt: "2026-07-03T12:00:00.000Z",
      factsOptions: {
        textExtractor: {
          extractTextLayerCoverage,
          extractPageTextByPage,
        },
      },
    });

    expect(result.packageRoot).toBe(outputDir);
    expect(result.layoutMode).toBe("separate-files");
    expect(await exists(path.join(outputDir, "upload"))).toBe(true);
    expect(await exists(path.join(outputDir, "raio-manifest", "manifest.json"))).toBe(true);
    expect(await exists(path.join(outputDir, result.manifestPdf))).toBe(true);
    expect(result.files.map((file) => file.outputName)).toContain("01 - Motion to Compel - Part 1 of 3.pdf");
    expect(result.files.map((file) => file.outputName)).toContain("02 - Exhibit A - Email Chain - Part 1 of 2.pdf");
    expect(result.selectionChecks.map((check) => check.checkId)).toEqual([
      "envelope-size",
      "selection-filenames",
      "filename-collisions",
    ]);
    expect(result.manifest.rootDocuments.map((document) => document.name)).toContain("filing-packet-manifest.pdf");
    expect(result.manifest.machineReports.map((report) => report.name)).toContain("filing-packet.json");
    expect(result.manifest.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "filing-packet-split-size", valueMb: 0.001 }),
      expect.objectContaining({ type: "filing-checklist-step", stepId: "make-searchable" }),
    ]));

    const manifestText = await extractAllText(await fs.readFile(path.join(outputDir, result.manifestPdf)));
    expect(manifestText).toContain("Motion to Compel.pdf");
    expect(manifestText).toContain("01 - Motion to Compel - Part 1 of 3.pdf");
    expect(manifestText).not.toContain(dir);
  });

  it("builds combined-PDF mode as one upload file", async () => {
    const motion = await writePdf("Motion.pdf", ["Motion", "See Fla. R. Civ. P. 1.202."]);
    const exhibit = await writePdf("Exhibit B.pdf", ["exhibit"]);
    const outputDir = path.join(dir, "combined");

    const result = await buildFilingPacket({
      sources: [{ path: motion }, { path: exhibit }],
      outputDir,
      packId: "florida",
      layoutMode: "combined-pdf",
      prefixFilenames: false,
      checklist: {
        selectedStepIds: ["normalize-pages"],
      },
      factsOptions: {
        textExtractor: {
          extractTextLayerCoverage,
          extractPageTextByPage,
        },
      },
    });

    expect(result.combinedPdf).toBe("upload/filing-packet.pdf");
    expect(result.manifest.uploadFiles).toHaveLength(1);
    expect(result.manifest.uploadFiles[0]).toMatchObject({
      outputName: "filing-packet.pdf",
      relativePath: "upload/filing-packet.pdf",
      pages: 3,
    });
    expect(await exists(path.join(outputDir, "upload", "filing-packet.pdf"))).toBe(true);
  });
});

async function writePdf(name: string, lines: readonly string[]): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const line of lines) {
    const page = pdf.addPage([612, 792]);
    page.drawText(line, { x: 72, y: 720, size: 12, font });
  }

  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, await pdf.save());
  return filePath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
