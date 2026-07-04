import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { readRaioPdfMarkupAnnotations } from "@raiopdf/engine-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleAddComment,
  handleHighlightText,
  handleLocateText,
  handleStrikethroughText,
  handleUnderlineText,
} from "../src/tools/annotate.js";
import { defaultEngineHandle } from "../src/engine.js";

let tempDir: string;
let inputPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-annotate-"));
  inputPath = path.join(tempDir, "source.pdf");
  await fs.writeFile(inputPath, await annotationFixturePdf());
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("MCP annotation tools", () => {
  it("locates repeated terms, page subsets, whole words, hyphenation, and smart punctuation", async () => {
    const all = await handleLocateText(
      { input: inputPath, query: "arbitration" },
      defaultEngineHandle,
    );
    expect(all.structuredContent.matchCount).toBe(3);
    expect((all.structuredContent.matches as unknown[])).toHaveLength(3);

    const pageSubset = await handleLocateText(
      { input: inputPath, query: "arbitration", pages: [0] },
      defaultEngineHandle,
    );
    expect(pageSubset.structuredContent.matchCount).toBe(1);

    const wholeWord = await handleLocateText(
      { input: inputPath, query: "cat", wholeWord: true },
      defaultEngineHandle,
    );
    expect(wholeWord.structuredContent.matchCount).toBe(1);

    const substring = await handleLocateText(
      { input: inputPath, query: "cat" },
      defaultEngineHandle,
    );
    expect(substring.structuredContent.matchCount).toBeGreaterThan(1);

    const hyphenated = await handleLocateText(
      { input: inputPath, query: "indemnification" },
      defaultEngineHandle,
    );
    expect(hyphenated.structuredContent.matchCount).toBe(1);
    const [hyphenatedMatch] = hyphenated.structuredContent.matches as Array<{ rects: unknown[] }>;
    expect(hyphenatedMatch?.rects).toHaveLength(2);

    const smartQuote = await handleLocateText(
      { input: inputPath, query: "\u201Cnotice\u201D" },
      defaultEngineHandle,
    );
    expect(smartQuote.structuredContent.matchCount).toBe(1);
  });

  it("highlights quote matches as live Highlight annotations", async () => {
    const output = path.join(tempDir, "highlighted.pdf");
    const result = await handleHighlightText(
      { input: inputPath, output, quote: "arbitration" },
      defaultEngineHandle,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.occurrences).toBe(3);
    await expect(markupSubtypes(output)).resolves.toEqual(["Highlight", "Highlight", "Highlight"]);
  });

  it("honors matchAll:false for quote-based highlights", async () => {
    const output = path.join(tempDir, "highlight-one.pdf");
    const result = await handleHighlightText(
      { input: inputPath, output, quote: "arbitration", matchAll: false },
      defaultEngineHandle,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.occurrences).toBe(1);
    await expect(markupSubtypes(output)).resolves.toEqual(["Highlight"]);
  });

  it("does not write an output file when a quote has no match", async () => {
    const output = path.join(tempDir, "missing.pdf");
    const result = await handleHighlightText(
      { input: inputPath, output, quote: "not in this document" },
      defaultEngineHandle,
    );

    expect(result.structuredContent.ok).toBe(false);
    expect((result.structuredContent.error as { code?: string }).code).toBe("NO_MATCH");
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits underline and strikethrough annotation subtypes", async () => {
    const underlineOutput = path.join(tempDir, "underlined.pdf");
    const strikeOutput = path.join(tempDir, "struck.pdf");

    await handleUnderlineText(
      { input: inputPath, output: underlineOutput, quote: "notice" },
      defaultEngineHandle,
    );
    await handleStrikethroughText(
      { input: inputPath, output: strikeOutput, quote: "cat", wholeWord: true },
      defaultEngineHandle,
    );

    await expect(markupSubtypes(underlineOutput)).resolves.toEqual(["Underline"]);
    await expect(markupSubtypes(strikeOutput)).resolves.toEqual(["StrikeOut"]);
  });

  it("adds a sticky-note comment at a text anchor and refuses missing anchors", async () => {
    const output = path.join(tempDir, "commented.pdf");
    const result = await handleAddComment(
      { input: inputPath, output, text: "Review this clause.", anchorText: "notice", author: "Raio" },
      defaultEngineHandle,
    );

    expect(result.structuredContent.ok).toBe(true);
    await expect(annotationSubtypes(output)).resolves.toContain("Text");

    const missingOutput = path.join(tempDir, "missing-comment.pdf");
    const missing = await handleAddComment(
      { input: inputPath, output: missingOutput, text: "No anchor.", anchorText: "absent phrase" },
      defaultEngineHandle,
    );

    expect(missing.structuredContent.ok).toBe(false);
    expect((missing.structuredContent.error as { code?: string }).code).toBe("NO_MATCH");
    await expect(fs.stat(missingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function annotationFixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page1 = pdf.addPage([420, 240]);
  page1.drawText('Arbitration clause says "notice" must be written.', {
    x: 30,
    y: 180,
    size: 12,
    font,
  });
  page1.drawText("The cat sat beside a concatenation example.", {
    x: 30,
    y: 150,
    size: 12,
    font,
  });

  const page2 = pdf.addPage([420, 240]);
  page2.drawText("arbitration appears again on this page.", {
    x: 30,
    y: 180,
    size: 12,
    font,
  });
  page2.drawText("indemni-", { x: 30, y: 150, size: 12, font });
  page2.drawText("fication survives a line break.", { x: 30, y: 132, size: 12, font });

  const page3 = pdf.addPage([420, 240]);
  page3.drawText("A final arbitration reference closes the fixture.", {
    x: 30,
    y: 180,
    size: 12,
    font,
  });

  return pdf.save();
}

async function markupSubtypes(filePath: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await fs.readFile(filePath));
  return pdf.getPages().flatMap((page) =>
    readRaioPdfMarkupAnnotations(page).map((entry) => entry.subtype)
  );
}

async function annotationSubtypes(filePath: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await fs.readFile(filePath));
  return pdf.getPages().flatMap((page) => {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) {
      return [];
    }

    const subtypes: string[] = [];
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookup(index, PDFDict);
      const subtype = annotation.lookup(PDFName.of("Subtype"), PDFName);
      subtypes.push(subtype.asString().replace(/^\//, ""));
    }
    return subtypes;
  });
}
