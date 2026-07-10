import { PDF_COVER_STYLES, PdfEngineError } from "@raiopdf/engine-api";
import {
  decodePDFRawStream,
  degrees as pdfDegrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFStream,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { readPdfOutline, writePdfOutlineInPlace } from "@raiopdf/engine-pdf-lib";
import {
  CAPTION_STYLES,
  createLocalPdfEngine,
  createStableExhibitIndex,
  drawDotLeaderRow,
  drawCoverPage,
  renderStableFrontMatter,
  resolveCaptionStyle,
  sanitizeIndexTextForFont,
} from "../src/index";

describe("LocalPdfEngine", () => {
  it("reorders pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const { document: reordered } = await engine.reorderPages(document, [2, 0, 1]);
    const bytes = await engine.saveToBytes(reordered);

    await expectPageWidths(bytes, [220, 200, 210]);
  });

  it("rotates selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const rotated = await engine.rotatePages(document, [1], 90);
    const bytes = await engine.saveToBytes(rotated);

    await expectPageRotations(bytes, [0, 90, 0]);
  });

  it("deletes selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const { document: deleted } = await engine.deletePages(document, [1]);
    const bytes = await engine.saveToBytes(deleted);

    await expectPageWidths(bytes, [200, 220]);
  });

  it("rejects deleting every page", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300]]));

    const result = engine.deletePages(document, [0, 1]);

    await expect(result).rejects.toBeInstanceOf(PdfEngineError);
    await expect(result).rejects.toMatchObject({
      code: "EMPTY_RESULT",
    });
  });

  it("reports direct text replacement as unsupported", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(
      engine.replaceText(document, {
        operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("reports selected text-map editing as unsupported", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(engine.inspectTextMap(document)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });

    await expect(
      engine.replaceSelectedText(document, {
        replacement: "Petitioner",
        target: {
          pageIndex: 0,
          start: 0,
          end: 9,
          expectedText: "Plaintiff",
          sourceDocumentFingerprint: "document-test",
          sourceFingerprint: "test",
          firstElementIndex: 0,
          lastElementIndex: 0,
          firstElementOffset: 0,
          lastElementOffset: 9,
        },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("maps encrypted documents to ENCRYPTED_DOCUMENT", async () => {
    const engine = createLocalPdfEngine();

    await expect(engine.open(encryptedPdfBytes())).rejects.toMatchObject({
      code: "ENCRYPTED_DOCUMENT",
    });
  });

  it("crops selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 310]]));

    const cropped = await engine.cropPages(document, [1], 0.25);
    const bytes = await engine.saveToBytes(cropped);

    await expectPageCropBoxes(bytes, [
      { x: 0, y: 0, width: 200, height: 300 },
      { x: 18, y: 18, width: 174, height: 274 },
    ]);
  });

  it("resizes selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 310]]));

    const resized = await engine.resizePages(document, [0], {
      widthPt: 612,
      heightPt: 792,
    });
    const bytes = await engine.saveToBytes(resized);

    await expectPageSizes(bytes, [[612, 792], [210, 310]]);
  });

  it("normalizes pages to letter portrait without retaining page rotations", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[792, 612], [306, 396]]));

    const normalized = await engine.normalizePages(document, {
      targetSize: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    });
    const bytes = await engine.saveToBytes(normalized);

    await expectPageSizes(bytes, [[612, 792], [612, 792]]);
    await expectPageRotations(bytes, [0, 0]);
  });

  it("normalizes a landscape page with Rotate 90 inside the letter portrait page box", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithRotatedLandscapePage());

    const normalized = await engine.normalizePages(document, {
      targetSize: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
    });
    const bytes = await engine.saveToBytes(normalized);
    const [matrix] = await readPageDrawMatrices(bytes, 0);

    if (!matrix) {
      throw new Error("Expected normalized page to draw an embedded source page.");
    }

    const bounds = boundsForTransformedRect(matrix, 792, 612);

    await expectPageSizes(bytes, [[612, 792]]);
    await expectPageRotations(bytes, [0]);
    expect(bounds.minX).toBeGreaterThanOrEqual(-0.001);
    expect(bounds.minY).toBeGreaterThanOrEqual(-0.001);
    expect(bounds.maxX).toBeLessThanOrEqual(612.001);
    expect(bounds.maxY).toBeLessThanOrEqual(792.001);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(612, 5);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(792, 5);
  });

  it("splits documents by max bytes with greedy page-boundary packing", async () => {
    const engine = createLocalPdfEngine();
    const sourceBytes = await createPdf([[200, 300], [210, 310], [220, 320]]);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const twoPageBytes = await createPdfFromSourcePages(sourcePdf, [0, 1]);
    const threePageBytes = await createPdfFromSourcePages(sourcePdf, [0, 1, 2]);
    const document = await engine.open(sourceBytes);

    const result = await engine.splitByMaxBytes(document, threePageBytes.byteLength - 1);

    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toMatchObject({
      pageIndexes: [0, 1],
      byteLength: twoPageBytes.byteLength,
      oversized: false,
    });
    expect(result.parts[1]).toMatchObject({
      pageIndexes: [2],
      oversized: false,
    });
    await expectPageWidths(await engine.saveToBytes(result.parts[0]!.document), [200, 210]);
    await expectPageWidths(await engine.saveToBytes(result.parts[1]!.document), [220]);
  });

  it("flags a single page that exceeds the split byte cap", async () => {
    const engine = createLocalPdfEngine();
    const sourceBytes = await createPdf([[200, 300]]);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const singlePageBytes = await createPdfFromSourcePages(sourcePdf, [0]);
    const document = await engine.open(sourceBytes);

    const result = await engine.splitByMaxBytes(document, singlePageBytes.byteLength - 1);

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      pageIndexes: [0],
      byteLength: singlePageBytes.byteLength,
      oversized: true,
    });
  });

  it("splits by max bytes with O(parts) serializations, not one per page", async () => {
    const engine = createLocalPdfEngine();
    const pageCount = 60;
    const sourceBytes = await createPdf(
      Array.from({ length: pageCount }, () => [200, 300] as const),
    );
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const capBytes = (
      await createPdfFromSourcePages(sourcePdf, Array.from({ length: 20 }, (_, index) => index))
    ).byteLength;
    const document = await engine.open(sourceBytes);

    // splitByMaxBytes serializes candidate parts exclusively through
    // PDFDocument.create (one create per serialized probe document), so the
    // spy's call count is the serialization count.
    const createSpy = vi.spyOn(PDFDocument, "create");
    const result = await engine.splitByMaxBytes(document, capBytes);
    const serializations = createSpy.mock.calls.length;
    createSpy.mockRestore();

    // Contract unchanged: parts cover every page in order and respect the cap.
    expect(result.parts.flatMap((part) => part.pageIndexes)).toEqual(
      Array.from({ length: pageCount }, (_, index) => index),
    );
    for (const part of result.parts) {
      expect(part.oversized).toBe(false);
      expect(part.byteLength).toBeLessThanOrEqual(capBytes);
    }

    // The old implementation re-serialized the growing part once per page
    // (>= 60 serializations here). The estimator + binary-search packing is
    // bounded by O(parts * log(pages)), far below one per page.
    const bound = result.parts.length * (3 + Math.ceil(Math.log2(pageCount)));
    expect(serializations).toBeLessThanOrEqual(bound);
    expect(serializations).toBeLessThan(pageCount);
  });

  it("merges documents in order", async () => {
    const engine = createLocalPdfEngine();
    const first = await engine.open(await createPdf([[200, 300], [210, 300]]));
    const second = await engine.open(await createPdf([[300, 400]]));

    const { document: merged } = await engine.merge([first, second]);
    const bytes = await engine.saveToBytes(merged);

    await expectPageWidths(bytes, [200, 210, 300]);
  });

  it("inserts another document at a page position", async () => {
    const engine = createLocalPdfEngine();
    const target = await engine.open(await createPdf([[200, 300], [220, 300]]));
    const inserted = await engine.open(await createPdf([[210, 300]]));

    const { document: combined } = await engine.insertPages(target, 1, inserted);
    const bytes = await engine.saveToBytes(combined);

    await expectPageWidths(bytes, [200, 210, 220]);
  });

  it("reads and rewrites nested PDF bookmarks", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithOutline());

    const outline = await engine.getOutline(document);

    expect(outline.openMode).toBe("outlines");
    expect(outline.items).toHaveLength(2);
    expect(outline.items[0]).toMatchObject({
      title: "Main",
      target: { kind: "page", pageIndex: 0 },
      children: [
        {
          title: "Main child",
          target: { kind: "page", pageIndex: 1 },
        },
      ],
    });

    const rewritten = await engine.replaceOutline(document, {
      ...outline,
      openMode: "default",
      items: [
        {
          ...outline.items[0]!,
          title: "Renamed main",
        },
      ],
    });
    const saved = await PDFDocument.load(await engine.saveToBytes(rewritten.document));
    const savedOutline = readPdfOutline(saved);

    expect(savedOutline.openMode).toBe("default");
    expect(savedOutline.items).toHaveLength(1);
    expect(savedOutline.items[0]).toMatchObject({
      title: "Renamed main",
      children: [{ title: "Main child" }],
    });
  });

  it("removes bookmarks whose deleted page target no longer exists", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithOutline());

    const result = await engine.deletePages(document, [1]);
    const outline = await engine.getOutline(result.document);

    expect(result.removedTargets).toBe(1);
    expect(outline.items).toMatchObject([
      { title: "Main", target: { kind: "page", pageIndex: 0 } },
      { title: "Appendix", target: { kind: "page", pageIndex: 1 } },
    ]);
    expect(outline.items[0]?.children).toBeUndefined();
  });

  it("preserves view-only URI bookmark targets when rewriting titles", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithUriOutline());
    const outline = await engine.getOutline(document);

    expect(outline.items[0]).toMatchObject({
      title: "Source website",
      target: { kind: "uri", uri: "https://example.test/source" },
    });

    const result = await engine.replaceOutline(document, {
      ...outline,
      items: [
        {
          ...outline.items[0]!,
          title: "Renamed website",
        },
      ],
    });
    const savedOutline = await engine.getOutline(result.document);

    expect(savedOutline.items[0]).toMatchObject({
      title: "Renamed website",
      target: { kind: "uri", uri: "https://example.test/source" },
    });
  });

  it("preserves remote view-only bookmarks through page remaps", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithRemoteOutline());

    const result = await engine.reorderPages(document, [1, 0]);
    const outline = await engine.getOutline(result.document);
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const item = readFirstOutlineItem(pdf);
    const action = item.lookup(PDFName.of("A"), PDFDict);

    expect(result.removedTargets).toBe(0);
    expect(outline.items[0]).toMatchObject({
      title: "External appendix",
      target: { kind: "remote" },
    });
    expect(action.lookup(PDFName.of("S"), PDFName).decodeText()).toBe("GoToR");
    expect(readTextValue(action.get(PDFName.of("F")))).toBe("appendix.pdf");
  });

  it("preserves unresolved named bookmarks through page remaps", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithUnresolvedNamedOutline());

    const result = await engine.deletePages(document, [0]);
    const outline = await engine.getOutline(result.document);
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const item = readFirstOutlineItem(pdf);

    expect(result.removedTargets).toBe(0);
    expect(outline.items[0]).toMatchObject({
      title: "Unresolved destination",
      target: { kind: "named", name: "Missing" },
    });
    expect(readTextValue(item.get(PDFName.of("Dest")))).toBe("Missing");
  });

  it("preserves /XYZ page destination view while remapping pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithXyzOutline());

    const result = await engine.reorderPages(document, [1, 0]);
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const dest = readFirstOutlineDestination(pdf);

    expect(result.removedTargets).toBe(0);
    expect(outlineDestinationPageIndex(pdf, dest)).toBe(0);
    expect(readNameAt(dest, 1)).toBe("XYZ");
    expect(readNumberAt(dest, 2)).toBe(36);
    expect(readNumberAt(dest, 3)).toBe(640);
    expect(readNumberAt(dest, 4)).toBe(1.25);
  });

  it("preserves GoTo action destination view while remapping pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithGoToActionOutline());

    const result = await engine.reorderPages(document, [1, 0]);
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const item = readFirstOutlineItem(pdf);
    const action = item.lookup(PDFName.of("A"), PDFDict);
    const dest = action.lookup(PDFName.of("D"), PDFArray);

    expect(result.removedTargets).toBe(0);
    expect(action.lookup(PDFName.of("S"), PDFName).decodeText()).toBe("GoTo");
    expect(outlineDestinationPageIndex(pdf, dest)).toBe(0);
    expect(readNameAt(dest, 1)).toBe("FitH");
    expect(readNumberAt(dest, 2)).toBe(640);
  });

  it("preserves named destinations as named destinations when rewriting titles", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithNamedDestinationOutline());
    const outline = await engine.getOutline(document);

    expect(outline.items[0]).toMatchObject({
      title: "Intro by name",
      target: { kind: "named", name: "Intro", resolvedPageIndex: 1 },
    });

    const result = await engine.replaceOutline(document, {
      ...outline,
      items: [
        {
          ...outline.items[0]!,
          title: "Renamed intro",
        },
      ],
    });
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const item = readFirstOutlineItem(pdf);
    const dest = item.get(PDFName.of("Dest"));

    expect(item.lookup(PDFName.of("Title"), PDFString, PDFHexString).decodeText()).toBe("Renamed intro");
    expect(readTextValue(dest)).toBe("Intro");
  });

  it("preserves named destination entries while remapping pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithNamedDestinationOutline());

    const result = await engine.reorderPages(document, [1, 0]);
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const item = readFirstOutlineItem(pdf);
    const namedDestination = readNamedDestination(pdf, "Intro");

    expect(result.removedTargets).toBe(0);
    expect(readTextValue(item.get(PDFName.of("Dest")))).toBe("Intro");
    expect(outlineDestinationPageIndex(pdf, namedDestination)).toBe(0);
    expect(readNameAt(namedDestination, 1)).toBe("FitH");
    expect(readNumberAt(namedDestination, 2)).toBe(640);
  });

  it("keeps duplicate merged named destinations separate", async () => {
    const engine = createLocalPdfEngine();
    const first = await engine.open(await createPdfWithNamedDestinationOutline());
    const second = await engine.open(await createPdfWithNamedDestinationOutline());

    const result = await engine.merge([first, second], {
      labels: ["first.pdf", "second.pdf"],
    });
    const pdf = await PDFDocument.load(await engine.saveToBytes(result.document));
    const outline = readPdfOutline(pdf);
    const firstNamedDestination = readNamedDestination(pdf, "merged:0:Intro");
    const secondNamedDestination = readNamedDestination(pdf, "merged:1:Intro");

    expect(result.removedTargets).toBe(0);
    expect(outline.items[0]?.children?.[0]).toMatchObject({
      title: "Intro by name",
      target: { kind: "named", name: "merged:0:Intro", resolvedPageIndex: 1 },
    });
    expect(outline.items[1]?.children?.[0]).toMatchObject({
      title: "Intro by name",
      target: { kind: "named", name: "merged:1:Intro", resolvedPageIndex: 3 },
    });
    expect(outlineDestinationPageIndex(pdf, firstNamedDestination)).toBe(1);
    expect(outlineDestinationPageIndex(pdf, secondNamedDestination)).toBe(3);
  });

  it("keeps nested source bookmarks under filename roots when merging", async () => {
    const engine = createLocalPdfEngine();
    const first = await engine.open(await createPdfWithOutline());
    const second = await engine.open(await createPdfWithOutline());

    const result = await engine.merge([first, second], {
      labels: ["first.pdf", "second.pdf"],
    });
    const outline = await engine.getOutline(result.document);

    expect(result.removedTargets).toBe(0);
    expect(outline.items).toMatchObject([
      {
        title: "first.pdf",
        target: { kind: "page", pageIndex: 0 },
        children: [
          {
            title: "Main",
            target: { kind: "page", pageIndex: 0 },
            children: [
              {
                title: "Main child",
                target: { kind: "page", pageIndex: 1 },
              },
            ],
          },
          {
            title: "Appendix",
            target: { kind: "page", pageIndex: 2 },
          },
        ],
      },
      {
        title: "second.pdf",
        target: { kind: "page", pageIndex: 3 },
        children: [
          {
            title: "Main",
            target: { kind: "page", pageIndex: 3 },
            children: [
              {
                title: "Main child",
                target: { kind: "page", pageIndex: 4 },
              },
            ],
          },
          {
            title: "Appendix",
            target: { kind: "page", pageIndex: 5 },
          },
        ],
      },
    ]);
  });

  it("stamps selected pages with text", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300]]));

    const stamped = await engine.stampText(document, {
      text: "Filed 2026",
      pageIndexes: "first",
      placement: { edge: "header", align: "center" },
    });
    const bytes = await engine.saveToBytes(stamped);

    await expectPageContentToContainLabel(bytes, 0, "Filed 2026");
    await expectPageContentNotToContainLabel(bytes, 1, "Filed 2026");
  });

  it("stamps rotated pages against the visual page edge", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));
    const rotated = await engine.rotatePages(document, [0], 90);

    const stamped = await engine.stampText(rotated, {
      text: "Rotated Header",
      pageIndexes: "first",
      placement: { edge: "header", align: "center" },
      fontSizePt: 11,
      marginIn: 0.5,
    });
    const bytes = await engine.saveToBytes(stamped);
    const [matrix] = await readPageTextMatrices(bytes, 0);

    if (!matrix) {
      throw new Error("Expected stamped page to contain a text matrix.");
    }

    const textWidth = await measureHelveticaText("Rotated Header", 11);

    expect(matrix).toMatchObject({
      a: expect.closeTo(0, 10),
      b: expect.closeTo(1, 10),
      c: expect.closeTo(-1, 10),
      d: expect.closeTo(0, 10),
      e: expect.closeTo(47, 5),
      f: expect.closeTo((300 - textWidth) / 2, 5),
    });
  });

  it("scrubs info dictionary fields and XMP metadata streams", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdfWithMetadata());

    const scrubbed = await engine.scrubMetadata(document);
    const bytes = await engine.saveToBytes(scrubbed);

    await expectNoDocumentMetadata(bytes);
  });

  it("stamps sequential Bates numbers on every page", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    const stamped = await engine.batesStamp(document, {
      prefix: "RAIO-",
      start: 7,
      digits: 4,
      placement: { edge: "footer", align: "right" },
    });
    const bytes = await engine.saveToBytes(stamped);

    await expectPageContentToContainLabel(bytes, 0, "RAIO-0007");
    await expectPageContentToContainLabel(bytes, 1, "RAIO-0008");
    await expectPageContentToContainLabel(bytes, 2, "RAIO-0009");
  });

  it("stamps simple page numbers on selected pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300]]));

    const numbered = await engine.pageNumbers(document, {
      startAt: 3,
      pageIndexes: "all",
      format: "page-of-total",
      placement: { edge: "footer", align: "center" },
    });
    const bytes = await engine.saveToBytes(numbered);

    await expectPageContentToContainLabel(bytes, 0, "Page 3 of 2");
    await expectPageContentToContainLabel(bytes, 1, "Page 4 of 2");
  });

  it("shrinks page numbers that would exceed the visual page width", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[80, 300]]));

    const numbered = await engine.pageNumbers(document, {
      startAt: 1,
      pageIndexes: "all",
      format: "page-of-total",
      placement: { edge: "footer", align: "right" },
      fontSizePt: 12,
      marginIn: 0.5,
    });
    const bytes = await engine.saveToBytes(numbered);
    const [matrix] = await readPageTextMatrices(bytes, 0);
    const [fontSize] = await readPageTextFontSizes(bytes, 0);

    if (!matrix || !fontSize) {
      throw new Error("Expected page number text matrix and font size.");
    }

    const textWidth = await measureHelveticaText("Page 1 of 1", fontSize);

    expect(matrix.e).toBeGreaterThanOrEqual(35.99);
    expect(matrix.e + textWidth).toBeLessThanOrEqual(44.01);
    expect(fontSize).toBeLessThan(12);
  });

  it("keeps a long diagonal watermark within the visual page bounds", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));
    const text = "CONFIDENTIAL SETTLEMENT COMMUNICATION";

    const watermarked = await engine.watermark(document, {
      text,
      pageIndexes: "all",
      orientation: "diagonal",
      opacity: 0.2,
      fontSizePt: 48,
    });
    const bytes = await engine.saveToBytes(watermarked);
    const [matrix] = await readPageTextMatrices(bytes, 0);
    const [fontSize] = await readPageTextFontSizes(bytes, 0);

    if (!matrix || !fontSize) {
      throw new Error("Expected watermark text matrix and font size.");
    }

    const textWidth = await measureHelveticaText(text, fontSize);
    const bounds = boundsForTransformedRect(matrix, textWidth, fontSize);

    expect(bounds.minX).toBeGreaterThanOrEqual(-0.001);
    expect(bounds.minY).toBeGreaterThanOrEqual(-0.001);
    expect(bounds.maxX).toBeLessThanOrEqual(200.001);
    expect(bounds.maxY).toBeLessThanOrEqual(300.001);
    expect(fontSize).toBeLessThan(48);
  });

  it("inserts PNG images as full pages", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [220, 300]]));

    const { document: inserted } = await engine.insertImagePages(document, 1, [
      { bytes: onePixelPng(), format: "png" },
    ]);
    const bytes = await engine.saveToBytes(inserted);

    await expectPageWidths(bytes, [200, 1, 220]);
  });

  it("rejects Bates numbers that overflow the configured digit width", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300], [210, 300], [220, 300]]));

    await expect(
      engine.batesStamp(document, {
        prefix: "RAIO-",
        start: 98,
        digits: 2,
        placement: { edge: "footer", align: "right" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });

  it("rejects true redaction operations as unsupported", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(
      engine.redactAreas(document, [{ pageIndex: 0, x: 10, y: 10, w: 20, h: 20 }]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(
      engine.redactText(document, { terms: ["secret"], wholeWord: true }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("rejects PDF/A conversion as unsupported in the local engine", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(engine.convertToPdfA(document, { flavor: "pdfa-2b" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("builds a slip-sheet exhibit binder with stamped labels and outline entries", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[200, 300], [210, 300]]));
    const exhibitA = await engine.open(await createPdf([[300, 400], [310, 400]]));
    const exhibitB = await engine.open(await createPdf([[400, 500]]));

    const binder = await engine.buildBinder(
      main,
      [
        { doc: exhibitA, label: "Exhibit A", sourceFileName: "source-a.pdf" },
        { doc: exhibitB, label: "Exhibit B", description: "Signed ledger" },
      ],
      { slipSheets: true },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageWidths(bytes, [200, 210, 200, 200, 300, 310, 200, 400]);
    await expectPageContentToContainLabel(bytes, 2, "Exhibit Index");
    await expectPageContentToContainLabel(bytes, 2, "4-6");
    await expectPageContentToContainLabel(bytes, 2, "7-8");
    await expectPageContentToContainLabel(bytes, 3, "Exhibit A");
    await expectPageContentToContainLabel(bytes, 4, "Exhibit A");
    await expectPageContentToContainLabel(bytes, 5, "Exhibit A");
    await expectPageContentToContainLabel(bytes, 6, "Exhibit B");
    await expectPageContentToContainLabel(bytes, 7, "Exhibit B");
    await expectOutlineEntries(bytes, [
      { title: "Main document", pageIndex: 0 },
      { title: "Exhibit Index", pageIndex: 2 },
      { title: "Exhibit A", pageIndex: 3 },
      { title: "Exhibit B", pageIndex: 6 },
    ]);
  });

  it.each(PDF_COVER_STYLES)("draws a saveable one-page $id cover", async ({ id }) => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    drawCoverPage(page, { regular, bold }, {
      label: "Exhibit A",
      description: "Deposition transcript of Jane Doe",
      style: id,
    });

    const saved = await PDFDocument.load(await pdf.save());

    expect(saved.getPageCount()).toBe(1);
  });

  it.each(CAPTION_STYLES)("builds a one-page $id case-caption cover", async ({ id }) => {
    const engine = createLocalPdfEngine();
    const cover = await engine.buildCoverPage({
      styleId: id,
      caption: sampleCaption(),
    });
    const bytes = await engine.saveToBytes(cover);

    await expectPageSizes(bytes, [[612, 792]]);
  });

  it("renders searchable caption text into the generated cover page", async () => {
    const engine = createLocalPdfEngine();
    const cover = await engine.buildCoverPage({
      styleId: "classic-boxed",
      caption: sampleCaption(),
    });
    const bytes = await engine.saveToBytes(cover);

    await expectPageContentToContainLabel(bytes, 0, "Superior Court of Fulton County");
    await expectPageContentToContainLabel(bytes, 0, "v.");
    await expectPageContentToContainLabel(bytes, 0, "Case No. 2026-CV-1000");
    await expectPageContentToContainLabel(bytes, 0, "Motion for Summary Judgment");
  });

  it("falls back to the first caption style for unknown style ids", () => {
    expect(resolveCaptionStyle("unknown-caption-style")).toBe(CAPTION_STYLES[0]);
  });

  it("sanitizes non-Latin party glyphs before drawing caption text", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const engine = createLocalPdfEngine();
    const cover = await engine.buildCoverPage({
      styleId: "classic-boxed",
      caption: {
        ...sampleCaption(),
        parties: [
          { role: "Plaintiff", names: ["Jane 契約 Doe"], etAl: true },
          { role: "Defendant", names: ["Acme LLC"] },
        ],
      },
    });
    const bytes = await engine.saveToBytes(cover);

    expect(sanitizeIndexTextForFont(font, "Jane 契約 Doe")).toBe("Jane Doe");
    await expectPageContentToContainLabel(bytes, 0, "Jane Doe");
  });

  it("keeps the minimal slip-sheet content identical to the prior centered-label output", async () => {
    const engine = createLocalPdfEngine();
    const mainBytes = await createPdf([[612, 792]]);
    const exhibit = await engine.open(await createPdf([[612, 792]]));
    const main = await engine.open(mainBytes);

    const defaultBinder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Exhibit A", description: "Deposition transcript" }],
      { slipSheets: true, index: { enabled: false } },
    );
    const minimalBinder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Exhibit A", description: "Deposition transcript" }],
      { slipSheets: true, index: { enabled: false }, coverStyle: "minimal" },
    );
    const defaultBytes = await engine.saveToBytes(defaultBinder);
    const minimalBytes = await engine.saveToBytes(minimalBinder);
    const legacyContent = await createLegacyMinimalSlipSheetContent(mainBytes, "Exhibit A");

    await expectPageSizes(defaultBytes, [[612, 792], [612, 792], [612, 792]]);
    await expectPageSizes(minimalBytes, [[612, 792], [612, 792], [612, 792]]);
    expect(await readDecodedPageContent(defaultBytes, 1)).toBe(legacyContent);
    expect(await readDecodedPageContent(minimalBytes, 1)).toBe(legacyContent);
  });

  it("builds an exhibit binder without slip sheets after the generated index", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[200, 300], [210, 300]]));
    const exhibitA = await engine.open(await createPdf([[300, 400], [310, 400]]));
    const exhibitB = await engine.open(await createPdf([[400, 500]]));

    const binder = await engine.buildBinder(
      main,
      [
        { doc: exhibitA, label: "Exhibit A", sourceFileName: "invoice-final.pdf" },
        { doc: exhibitB, label: "Exhibit B" },
      ],
      { slipSheets: false },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageWidths(bytes, [200, 210, 200, 300, 310, 400]);
    await expectPageContentToContainLabel(bytes, 2, "Exhibit Index");
    await expectPageContentToContainLabel(bytes, 2, "invoice-final");
    await expectPageContentNotToContainLabel(bytes, 2, "invoice-final.pdf");
    await expectPageContentToContainLabel(bytes, 2, "4-5");
    await expectPageContentToContainLabel(bytes, 2, "6");
    await expectOutlineEntries(bytes, [
      { title: "Main document", pageIndex: 0 },
      { title: "Exhibit Index", pageIndex: 2 },
      { title: "Exhibit A", pageIndex: 3 },
      { title: "Exhibit B", pageIndex: 5 },
    ]);
  });

  it("builds an exhibit binder with the source filename index column when requested", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[612, 792]]));
    const exhibit = await engine.open(await createPdf([[612, 792]]));

    const binder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Exhibit A", description: "Contract", sourceFileName: "contract.pdf" }],
      { slipSheets: false, index: { includeSourceFileName: true } },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageContentToContainLabel(bytes, 1, "Source file");
    await expectPageContentToContainLabel(bytes, 1, "contract.pdf");
  });

  it("falls back to the exhibit label when a CJK filename description cannot be drawn", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[612, 792]]));
    const exhibit = await engine.open(await createPdf([[612, 792]]));

    const binder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Exhibit A", sourceFileName: "契約書.pdf" }],
      { slipSheets: false, index: { includeSourceFileName: true } },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageContentToContainLabel(bytes, 1, "Source file");
    await expectPageContentToContainLabel(bytes, 1, ".pdf");
    await expectPageContentLabelCount(bytes, 1, "Exhibit A", 2);
  });

  it("falls back to the exhibit label when an emoji-only filename description cannot be drawn", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[612, 792]]));
    const exhibit = await engine.open(await createPdf([[612, 792]]));

    const binder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Exhibit B", sourceFileName: "😀.pdf" }],
      { slipSheets: false },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageContentLabelCount(bytes, 1, "Exhibit B", 2);
  });

  it("keeps drawable text from a mixed Unicode filename description", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[612, 792]]));
    const exhibit = await engine.open(await createPdf([[612, 792]]));

    const binder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Label C", sourceFileName: "Exhibit — 契約書.pdf" }],
      { slipSheets: false },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageContentLabelCount(bytes, 1, "Exhibit", 2);
  });

  it("sanitizes user-supplied Unicode descriptions before drawing the exhibit index", async () => {
    const engine = createLocalPdfEngine();
    const main = await engine.open(await createPdf([[612, 792]]));
    const exhibit = await engine.open(await createPdf([[612, 792]]));

    const binder = await engine.buildBinder(
      main,
      [{ doc: exhibit, label: "Exhibit D", description: "Signed 契約" }],
      { slipSheets: false },
    );
    const bytes = await engine.saveToBytes(binder);

    await expectPageContentToContainLabel(bytes, 1, "Signed");
  });

  it("keeps exhibit index pagination stable for a multi-page index", async () => {
    const layout = await createStableExhibitIndex({
      pageSize: [612, 792],
      mainPageCount: 3,
      slipSheets: false,
      exhibits: Array.from({ length: 45 }, (_, index) => ({
        label: `Exhibit ${index + 1}`,
        pageCount: 1,
        sourceFileName: `source-${index + 1}.pdf`,
      })),
    });

    expect(layout.pageCount).toBeGreaterThan(1);
    expect(layout.iterations).toBeLessThanOrEqual(5);
    expect(layout.entries[0]?.pageRange).toBe("6");
    expect(layout.entries.at(-1)?.pageRange).toBe("50");
  });

  it("draws a dot-leader front-matter row with left and right text", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const result = drawDotLeaderRow({
      page,
      font,
      leftText: "Acme v. Smith",
      rightText: "12",
      x: 36,
      y: 120,
      width: 220,
      fontSize: 10,
    });
    const bytes = await pdf.save();

    expect(result.leaderText.length).toBeGreaterThan(0);
    await expectPageContentToContainLabel(bytes, 0, "Acme v. Smith");
    await expectPageContentToContainLabel(bytes, 0, "12");
  });

  it("truncates a long dot-leader row label before the right text", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([260, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const leftText = "A very long authority label that cannot fit next to the page number";

    const result = drawDotLeaderRow({
      page,
      font,
      leftText,
      rightText: "999",
      x: 36,
      y: 120,
      width: 120,
      fontSize: 10,
    });
    const bytes = await pdf.save();

    expect(result.leftText).toMatch(/\.\.\.$/u);
    expect(result.leftText).not.toBe(leftText);
    expect(font.widthOfTextAtSize(result.leftText, 10)).toBeLessThanOrEqual(
      120 - font.widthOfTextAtSize(result.rightText, 10) - 8,
    );
    await expectPageContentToContainLabel(bytes, 0, result.leftText);
    await expectPageContentToContainLabel(bytes, 0, "999");
    await expectPageContentNotToContainLabel(bytes, 0, leftText);
  });

  it("renders stable front matter on one page for a small section list", async () => {
    const rendered = await renderStableFrontMatter({
      title: "Table of Contents",
      sections: [{ title: "Filings", rows: [{ leftText: "Complaint", rightText: "4" }] }],
    });
    const bytes = await rendered.doc.save();

    expect(rendered.pageCount).toBe(1);
    expect(rendered.pages).toHaveLength(1);
    expect(rendered.doc.getPageCount()).toBe(1);
    await expectPageContentToContainLabel(bytes, 0, "Table of Contents");
    await expectPageContentToContainLabel(bytes, 0, "Complaint");
    await expectPageContentToContainLabel(bytes, 0, "4");
  });

  it("stabilizes front-matter page counts for a multi-page section list", async () => {
    const rendered = await renderStableFrontMatter({
      title: "Table of Authorities",
      sections: ({ frontMatterPageCount }) => [
        {
          title: "Cases",
          rows: Array.from({ length: 45 }, (_, index) => ({
            leftText: `Authority ${index + 1}`,
            rightText: String(frontMatterPageCount + index + 1),
          })),
        },
      ],
    });
    const bytes = await rendered.doc.save();

    expect(rendered.pageCount).toBe(2);
    expect(rendered.pages).toHaveLength(rendered.pageCount);
    expect(rendered.doc.getPageCount()).toBe(rendered.pageCount);
    expect(rendered.iterations).toBeLessThanOrEqual(5);
    await expectPageContentToContainLabel(bytes, 0, "1 of 2");
    await expectPageContentToContainLabel(bytes, 1, "2 of 2");
    await expectPageContentToContainLabel(bytes, 0, "Authority 1");
    await expectPageContentToContainLabel(bytes, 0, "3");
    await expectPageContentToContainLabel(bytes, 1, "Authority 45");
    await expectPageContentToContainLabel(bytes, 1, "47");
  });

  it("closes document handles and ignores unknown handles", async () => {
    const engine = createLocalPdfEngine();
    const document = await engine.open(await createPdf([[200, 300]]));

    await expect(engine.close(document)).resolves.toBeUndefined();
    await expect(engine.close("local-pdf:missing" as never)).resolves.toBeUndefined();
    await expect(engine.saveToBytes(document)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });
});

function sampleCaption() {
  return {
    courtName: "Superior Court of Fulton County",
    county: "Fulton County",
    parties: [
      { role: "Plaintiff", names: ["Jane Doe"], etAl: true },
      { role: "Defendant", names: ["Acme LLC"] },
    ],
    caseNumber: "2026-CV-1000",
    division: "Civil",
    judge: "Hon. Alex Carter",
    documentTitle: "Motion for Summary Judgment",
    signatureBlockLines: ["Respectfully submitted,", "Counsel for Plaintiff"],
  };
}

async function createPdf(pageSizes: ReadonlyArray<readonly [number, number]>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const pageSize of pageSizes) {
    pdf.addPage([pageSize[0], pageSize[1]]);
  }

  return pdf.save();
}

async function createLegacyMinimalSlipSheetContent(mainBytes: Uint8Array, label: string): Promise<string> {
  const main = await PDFDocument.load(mainBytes);
  const output = await PDFDocument.create();

  await copyAllPagesForTest(output, main);
  const mainFirstPage = output.getPage(0);
  const slipSheet = output.addPage([mainFirstPage.getWidth(), mainFirstPage.getHeight()]);
  const font = await output.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const textWidth = font.widthOfTextAtSize(label, fontSize);

  slipSheet.drawText(label, {
    x: (slipSheet.getWidth() - textWidth) / 2,
    y: (slipSheet.getHeight() - fontSize) / 2,
    size: fontSize,
    font,
    color: rgb(0.08, 0.08, 0.08),
  });

  return readDecodedPageContent(await output.save(), 1);
}

async function copyAllPagesForTest(output: PDFDocument, source: PDFDocument): Promise<void> {
  const pages = await output.copyPages(source, source.getPageIndices());

  for (const page of pages) {
    output.addPage(page);
  }
}

async function createPdfWithOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await createPdf([[200, 300], [210, 300], [220, 300]]));
  writePdfOutlineInPlace(pdf, {
    openMode: "outlines",
    revision: "test",
    items: [
      {
        id: "main",
        title: "Main",
        target: { kind: "page", pageIndex: 0 },
        expanded: true,
        children: [
          {
            id: "main-child",
            title: "Main child",
            target: { kind: "page", pageIndex: 1 },
          },
        ],
      },
      {
        id: "appendix",
        title: "Appendix",
        target: { kind: "page", pageIndex: 2 },
      },
    ],
  });

  return pdf.save();
}

async function createPdfWithUriOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);

  const rootRef = pdf.context.nextRef();
  const itemRef = pdf.context.nextRef();
  pdf.context.assign(
    itemRef,
    pdf.context.obj({
      Title: PDFString.of("Source website"),
      Parent: rootRef,
      A: {
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.test/source"),
      },
    }),
  );
  pdf.context.assign(
    rootRef,
    pdf.context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRef,
      Last: itemRef,
      Count: 1,
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return pdf.save();
}

async function createPdfWithRemoteOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([210, 300]);

  const rootRef = pdf.context.nextRef();
  const itemRef = pdf.context.nextRef();
  pdf.context.assign(
    itemRef,
    pdf.context.obj({
      Title: PDFString.of("External appendix"),
      Parent: rootRef,
      A: {
        S: PDFName.of("GoToR"),
        F: PDFString.of("appendix.pdf"),
        D: PDFString.of("Intro"),
      },
    }),
  );
  pdf.context.assign(
    rootRef,
    pdf.context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRef,
      Last: itemRef,
      Count: 1,
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return pdf.save();
}

async function createPdfWithUnresolvedNamedOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([210, 300]);

  const rootRef = pdf.context.nextRef();
  const itemRef = pdf.context.nextRef();
  pdf.context.assign(
    itemRef,
    pdf.context.obj({
      Title: PDFString.of("Unresolved destination"),
      Parent: rootRef,
      Dest: PDFString.of("Missing"),
    }),
  );
  pdf.context.assign(
    rootRef,
    pdf.context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRef,
      Last: itemRef,
      Count: 1,
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return pdf.save();
}

async function createPdfWithXyzOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const secondPage = pdf.addPage([210, 300]);

  const rootRef = pdf.context.nextRef();
  const itemRef = pdf.context.nextRef();
  pdf.context.assign(
    itemRef,
    pdf.context.obj({
      Title: PDFString.of("Second page XYZ"),
      Parent: rootRef,
      Dest: [secondPage.ref, PDFName.of("XYZ"), 36, 640, 1.25],
    }),
  );
  pdf.context.assign(
    rootRef,
    pdf.context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRef,
      Last: itemRef,
      Count: 1,
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return pdf.save();
}

async function createPdfWithGoToActionOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const secondPage = pdf.addPage([210, 300]);

  const rootRef = pdf.context.nextRef();
  const itemRef = pdf.context.nextRef();
  pdf.context.assign(
    itemRef,
    pdf.context.obj({
      Title: PDFString.of("Second page FitH"),
      Parent: rootRef,
      A: {
        S: PDFName.of("GoTo"),
        D: [secondPage.ref, PDFName.of("FitH"), 640],
      },
    }),
  );
  pdf.context.assign(
    rootRef,
    pdf.context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRef,
      Last: itemRef,
      Count: 1,
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return pdf.save();
}

async function createPdfWithNamedDestinationOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const secondPage = pdf.addPage([210, 300]);

  const namedDestination = pdf.context.obj([secondPage.ref, PDFName.of("FitH"), 640]);
  pdf.catalog.set(
    PDFName.of("Names"),
    pdf.context.obj({
      Dests: {
        Names: [PDFString.of("Intro"), namedDestination],
      },
    }),
  );

  const rootRef = pdf.context.nextRef();
  const itemRef = pdf.context.nextRef();
  pdf.context.assign(
    itemRef,
    pdf.context.obj({
      Title: PDFString.of("Intro by name"),
      Parent: rootRef,
      Dest: PDFName.of("Intro"),
    }),
  );
  pdf.context.assign(
    rootRef,
    pdf.context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRef,
      Last: itemRef,
      Count: 1,
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);

  return pdf.save();
}

function readFirstOutlineItem(pdf: PDFDocument): PDFDict {
  const outlineRoot = pdf.catalog.lookup(PDFName.of("Outlines"), PDFDict);
  const first = outlineRoot.get(PDFName.of("First"));

  if (!(first instanceof PDFRef)) {
    throw new Error("Expected first outline item reference");
  }

  return pdf.context.lookup(first, PDFDict);
}

function readFirstOutlineDestination(pdf: PDFDocument): PDFArray {
  return readFirstOutlineItem(pdf).lookup(PDFName.of("Dest"), PDFArray);
}

function readNamedDestination(pdf: PDFDocument, name: string): PDFArray {
  const namesRoot = pdf.catalog.lookup(PDFName.of("Names"), PDFDict);
  const dests = namesRoot.lookup(PDFName.of("Dests"), PDFDict);
  const names = dests.lookup(PDFName.of("Names"), PDFArray);

  for (let index = 0; index + 1 < names.size(); index += 2) {
    if (readTextValue(names.get(index)) === name) {
      return names.lookup(index + 1, PDFArray);
    }
  }

  throw new Error(`Named destination "${name}" was not written.`);
}

function outlineDestinationPageIndex(pdf: PDFDocument, destination: PDFArray): number {
  const pageRef = destination.get(0);

  if (!(pageRef instanceof PDFRef)) {
    throw new Error("Expected outline destination page reference");
  }

  return pdf.getPages().findIndex((page) => page.ref.toString() === pageRef.toString());
}

function readTextValue(value: unknown): string | null {
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }

  return null;
}

function readNameAt(array: PDFArray, index: number): string {
  const value = array.get(index);

  if (!(value instanceof PDFName)) {
    throw new Error(`Expected PDF name at index ${index}`);
  }

  return value.decodeText();
}

function readNumberAt(array: PDFArray, index: number): number {
  const value = array.get(index);

  if (!(value instanceof PDFNumber)) {
    throw new Error(`Expected PDF number at index ${index}`);
  }

  return value.asNumber();
}

function onePixelPng(): Uint8Array {
  return new Uint8Array(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ));
}

async function createPdfWithRotatedLandscapePage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([792, 612]);

  page.setRotation(pdfDegrees(90));
  page.drawRectangle({
    x: 24,
    y: 24,
    width: 744,
    height: 564,
    borderColor: rgb(0, 0, 0),
    borderWidth: 2,
  });

  return pdf.save();
}

async function createPdfWithMetadata(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.setTitle("Confidential Title");
  pdf.setAuthor("Confidential Author");
  pdf.setSubject("Confidential Subject");
  pdf.setKeywords(["confidential", "legal"]);
  pdf.setCreator("RaioPDF Test");
  pdf.setProducer("RaioPDF Producer");
  pdf.setCreationDate(new Date("2026-01-02T03:04:05Z"));
  pdf.setModificationDate(new Date("2026-01-03T03:04:05Z"));

  const metadataStream = pdf.context.stream("<x:xmpmeta>Confidential XMP</x:xmpmeta>", {
    Type: "Metadata",
    Subtype: "XML",
  });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(metadataStream));

  return pdf.save();
}

async function createPdfFromSourcePages(
  source: PDFDocument,
  pageIndexes: readonly number[],
): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const copiedPages = await output.copyPages(source, [...pageIndexes]);

  for (const page of copiedPages) {
    output.addPage(page);
  }

  return output.save();
}

function encryptedPdfBytes(): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 0 /Kids [] >>
endobj
3 0 obj
<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>
endobj
trailer
<< /Root 1 0 R /Encrypt 3 0 R >>
%%EOF`);
}

async function expectPageWidths(bytes: Uint8Array, expectedWidths: readonly number[]): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const widths = pdf.getPages().map((page) => page.getWidth());

  expect(widths).toEqual(expectedWidths);
}

async function expectPageSizes(
  bytes: Uint8Array,
  expectedSizes: ReadonlyArray<readonly [number, number]>,
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const sizes = pdf.getPages().map((page) => [page.getWidth(), page.getHeight()]);

  expect(sizes).toEqual(expectedSizes);
}

async function expectPageCropBoxes(
  bytes: Uint8Array,
  expectedCropBoxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const cropBoxes = pdf.getPages().map((page) => page.getCropBox());

  expect(cropBoxes).toEqual(expectedCropBoxes);
}

async function expectPageContentToContainLabel(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<void> {
  expect(await readDecodedPageContent(bytes, pageIndex)).toContain(encodeTextAsHex(label));
}

async function expectPageContentNotToContainLabel(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<void> {
  expect(await readDecodedPageContent(bytes, pageIndex)).not.toContain(encodeTextAsHex(label));
}

async function expectPageContentLabelCount(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
  minimumCount: number,
): Promise<void> {
  const content = await readDecodedPageContent(bytes, pageIndex);
  const matches = content.match(new RegExp(escapeRegExp(encodeTextAsHexFragment(label)), "g"));

  expect(matches?.length ?? 0).toBeGreaterThanOrEqual(minimumCount);
}

async function expectNoDocumentMetadata(bytes: Uint8Array): Promise<void> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });

  expect(pdf.context.trailerInfo.Info).toBeUndefined();
  expect(pdf.catalog.has(PDFName.of("Metadata"))).toBe(false);

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      expect(object.has(PDFName.of("Metadata"))).toBe(false);
    }
  }
}

async function readDecodedPageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

  return contentObjects
    .map((object) => (object instanceof PDFStream ? object : pdf.context.lookup(object)))
    .filter((object): object is PDFStream => object instanceof PDFStream)
    .map((stream) => decodePdfStream(stream))
    .join("\n");
}

async function readPageTextMatrices(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<Array<{ a: number; b: number; c: number; d: number; e: number; f: number }>> {
  const content = await readDecodedPageContent(bytes, pageIndex);
  const numberPattern = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const matrixPattern = new RegExp(
    `${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} Tm`,
    "g",
  );

  return [...content.matchAll(matrixPattern)].map((match) => {
    const values = match[0]
      .slice(0, -" Tm".length)
      .split(" ")
      .map((value) => Number(value));

    return {
      a: values[0]!,
      b: values[1]!,
      c: values[2]!,
      d: values[3]!,
      e: values[4]!,
      f: values[5]!,
    };
  });
}

async function readPageTextFontSizes(bytes: Uint8Array, pageIndex: number): Promise<number[]> {
  const content = await readDecodedPageContent(bytes, pageIndex);
  const numberPattern = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const fontSizePattern = new RegExp(`/[^\\s]+ (${numberPattern}) Tf`, "g");

  return [...content.matchAll(fontSizePattern)].map((match) => Number(match[1]));
}

async function readPageDrawMatrices(bytes: Uint8Array, pageIndex: number): Promise<TransformMatrix[]> {
  const content = await readDecodedPageContent(bytes, pageIndex);
  const numberPattern = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const matrixPattern = new RegExp(
    `${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} ${numberPattern} cm`,
    "g",
  );
  const matrices = [...content.matchAll(matrixPattern)].map((match) => {
    const values = match[0]
      .slice(0, -" cm".length)
      .split(" ")
      .map((value) => Number(value));

    return {
      a: values[0]!,
      b: values[1]!,
      c: values[2]!,
      d: values[3]!,
      e: values[4]!,
      f: values[5]!,
    };
  });

  if (matrices.length === 0) {
    return [];
  }

  return [matrices.reduce(multiplyMatrices)];
}

type TransformMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };

function multiplyMatrices(left: TransformMatrix, right: TransformMatrix): TransformMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function boundsForTransformedRect(matrix: TransformMatrix, width: number, height: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const points = [
    transformPoint(matrix, 0, 0),
    transformPoint(matrix, width, 0),
    transformPoint(matrix, 0, height),
    transformPoint(matrix, width, height),
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function transformPoint(matrix: TransformMatrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

async function measureHelveticaText(text: string, size: number): Promise<number> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  return font.widthOfTextAtSize(text, size);
}

function decodePdfStream(stream: PDFStream): string {
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }

  return new TextDecoder().decode(stream.getContents());
}

function encodeTextAsHex(text: string): string {
  return `<${encodeTextAsHexFragment(text)}>`;
}

function encodeTextAsHexFragment(text: string): string {
  return [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectOutlineEntries(
  bytes: Uint8Array,
  expectedEntries: ReadonlyArray<{ title: string; pageIndex: number }>,
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const outlinesObject = pdf.catalog.get(PDFName.of("Outlines"));
  const outlines = outlinesObject instanceof PDFRef
    ? pdf.context.lookup(outlinesObject, PDFDict)
    : outlinesObject;

  if (!(outlines instanceof PDFDict)) {
    throw new Error("Expected PDF outlines dictionary.");
  }

  const count = outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber();

  expect(count).toBe(expectedEntries.length);
  expect(readOutlineEntries(pdf, outlines)).toEqual(expectedEntries);
}

function readOutlineEntries(
  pdf: PDFDocument,
  outlines: PDFDict,
): Array<{ title: string; pageIndex: number }> {
  const entries: Array<{ title: string; pageIndex: number }> = [];
  let itemRef = outlines.get(PDFName.of("First"));

  while (itemRef) {
    if (!(itemRef instanceof PDFRef)) {
      throw new Error("Expected PDF outline item reference.");
    }

    const item = pdf.context.lookup(itemRef, PDFDict);
    const title = item.lookup(PDFName.of("Title"), PDFString, PDFHexString).decodeText();
    const dest = item.lookup(PDFName.of("Dest"), PDFArray);
    const destPageRef = dest.get(0);
    if (!(destPageRef instanceof PDFRef)) {
      throw new Error("Expected PDF outline destination page reference.");
    }

    const pageIndex = pdf.getPages().findIndex((page) => page.ref.toString() === destPageRef.toString());

    entries.push({ title, pageIndex });
    itemRef = item.get(PDFName.of("Next"));
  }

  return entries;
}

async function expectPageRotations(
  bytes: Uint8Array,
  expectedRotations: readonly number[],
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const rotations = pdf.getPages().map((page) => page.getRotation().angle);

  expect(rotations).toEqual(expectedRotations);
}
