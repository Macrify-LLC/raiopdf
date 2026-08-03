import { PDFDocument, degrees } from "pdf-lib";
// The main `pdfjs-dist` entry expects browser APIs that don't exist in a plain
// Vitest/Node run; the legacy build is the same one the renumber unit test and
// the rotation repro test use, for the same reason.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import type { PdfEditRect, PdfStampEdit } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import {
  buildAnnotationSavePlan,
  pendingEditsFromRaioAnnotations,
  type PendingEdit,
  type PendingExhibitStamp,
} from "./edits";
import { exhibitLabelLines } from "./exhibitLabels";
import {
  applyExhibitStampRenumberStep,
  planExhibitStampRenumber,
  readStampVisualRects,
  renumberableStamps,
} from "./exhibitStampRenumber";
import type { PDFDocumentProxy } from "./pdfjs";

/**
 * An exhibit sticker is only useful if it is still a live object the next time
 * the file is opened: selectable, movable, and — the part that matters for a
 * binder — renumberable as a set. The pure pieces of that are already covered
 * (`exhibitLabels`, `exhibitStamps`, `exhibitStampRenumber`, all against
 * hand-built fixtures). What none of them touch is the seam where the sticker
 * has actually been through a PDF: written into the file, read back out, and
 * renumbered from the geometry the file itself reports.
 *
 * That distinction is load-bearing on a rotated page. The renumber sorts in
 * VISUAL space, so its input is the pdf.js viewport of the saved document —
 * not the user-space rectangle the engine stored. Only a round-trip can prove
 * the two agree.
 */

const TEMPLATE_ID = "plaintiffs-exhibit";
const TEMPLATE_REVISION = 4;
const PREFIX = "Plaintiff's Exhibit";
const PAGE_SIZE: [number, number] = [612, 792];
/** Page 0 upright, page 1 upside down. */
const PAGE_ROTATIONS = [0, 180] as const;

interface Placement {
  name: string;
  pageIndex: number;
  rect: PdfEditRect;
}

/**
 * Six stickers whose stored rectangles say one thing and whose on-screen
 * positions say another. `top-left` / `top-right` / `lower` name what the
 * READER sees, which is the order the renumber has to produce.
 *
 * Page 0 (/Rotate 0): up the page is +y, so the top row is the high-y one and
 * left is low x. Page 1 (/Rotate 180): the page is upside down, so both axes
 * invert — the reader's top-left corner is the low-y, HIGH-x one. A renumber
 * that sorted on raw user-space geometry would run page 1 backwards.
 */
const PLACEMENTS: readonly Placement[] = [
  { name: "p0-top-left", pageIndex: 0, rect: { x: 50, y: 700, w: 120, h: 60 } },
  // A few points of vertical drift is still the same row to a reader.
  { name: "p0-top-right", pageIndex: 0, rect: { x: 320, y: 694, w: 120, h: 60 } },
  { name: "p0-lower", pageIndex: 0, rect: { x: 50, y: 400, w: 120, h: 60 } },
  { name: "p1-top-left", pageIndex: 1, rect: { x: 420, y: 50, w: 120, h: 60 } },
  { name: "p1-top-right", pageIndex: 1, rect: { x: 100, y: 56, w: 120, h: 60 } },
  { name: "p1-lower", pageIndex: 1, rect: { x: 420, y: 300, w: 120, h: 60 } },
];

/**
 * The order the stickers were dropped into the file — scrambled within each
 * page, so nothing but the visual sort can produce the reading order below.
 * Each sticker is numbered by its position HERE, which is what makes the
 * reopened file wrong and gives the renumber something to fix.
 */
const PLACEMENT_ORDER: readonly string[] = [
  "p0-lower",
  "p0-top-right",
  "p0-top-left",
  "p1-lower",
  "p1-top-right",
  "p1-top-left",
];

const READING_ORDER: readonly string[] = [
  "p0-top-left",
  "p0-top-right",
  "p0-lower",
  "p1-top-left",
  "p1-top-right",
  "p1-lower",
];

describe("reopened exhibit stamps", () => {
  it("comes back as live stamps with their template and sequence provenance", async () => {
    const { stamps, nameOf } = await placeSaveAndReopen();

    expect(stamps).toHaveLength(PLACEMENT_ORDER.length);
    // Exactly one sticker per placement came back, each still sitting where it
    // was dropped — the rectangle is what every later assertion identifies it by.
    expect(stamps.map(nameOf).sort()).toEqual([...PLACEMENT_ORDER].sort());
    // `renumberableStamps` only keeps stamps that still carry a templateId AND
    // a sequence — so a file that lost either would silently return fewer, and
    // the reopened sticker would be movable but no longer part of the set.
    expect(renumberableStamps(stamps, TEMPLATE_ID)).toHaveLength(PLACEMENT_ORDER.length);

    for (const stamp of stamps) {
      expect(stamp).toMatchObject({
        kind: "stamp",
        annotSource: "raio",
        status: "applied",
        templateId: TEMPLATE_ID,
        templateRevision: TEMPLATE_REVISION,
        sequence: { schemaVersion: 1, identifierStyle: "numbers", prefix: PREFIX },
      });
      expect(stamp.annotId).toBeTruthy();
      // The number it was placed with is exactly the number that reopened.
      expect(stamp.sequence?.index).toBe(PLACEMENT_ORDER.indexOf(nameOf(stamp)));
      expect(stamp.lines).toEqual(labelFor(PLACEMENT_ORDER.indexOf(nameOf(stamp))));
    }
  });

  it("renumbers reopened stamps in reading order, upside-down page included", async () => {
    const { stamps, savedBytes, nameOf } = await placeSaveAndReopen();

    await withPdfJsDocument(savedBytes, async (pdfDocument) => {
      const renumberable = renumberableStamps(stamps, TEMPLATE_ID);
      const visualRects = await readStampVisualRects(pdfDocument, renumberable);

      // Every page measured, so the plan below is the real viewport sort and
      // not the user-space fallback (which would get page 1 backwards).
      expect(visualRects.size).toBe(PLACEMENT_ORDER.length);

      const steps = planExhibitStampRenumber(renumberable, visualRects, 0);

      expect(steps.map((step) => nameOf(byId(stamps, step.id)))).toEqual([...READING_ORDER]);
      expect(steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });

  it("writes the renumber back into the file without duplicating a sticker", async () => {
    const { engine, reopened, stamps, imports, savedBytes, nameOf } = await placeSaveAndReopen();

    const renumbered = await withPdfJsDocument(savedBytes, async (pdfDocument) => {
      const renumberable = renumberableStamps(stamps, TEMPLATE_ID);
      const steps = planExhibitStampRenumber(
        renumberable,
        await readStampVisualRects(pdfDocument, renumberable),
        0,
      );

      return stamps.map((stamp) => {
        const step = steps.find((candidate) => candidate.id === stamp.id);

        return step ? applyExhibitStampRenumberStep(stamp, step) : stamp;
      });
    });
    const plan = buildAnnotationSavePlan(renumbered, new Set(imports));

    // A renumber rewrites reopened stickers in place. Anything appended here
    // would leave the old number sitting under the new one.
    expect(plan.appendEdits).toEqual([]);
    expect(plan.deleteAnnotIds).toEqual([]);
    // Only the four stickers whose number actually moved are rewritten:
    // p0-top-right and p1-top-right already held their reading-order number.
    expect(
      plan.updateEdits
        .map((update) => nameOf(byAnnotId(renumbered, update.annotId)))
        .sort(),
    ).toEqual(["p0-lower", "p0-top-left", "p1-lower", "p1-top-left"]);

    let current = reopened;

    for (const update of plan.updateEdits) {
      current = await engine.updateAnnotationById(current, update.annotId, update.edit);
    }

    const finalEngine = createLocalPdfEngine();
    const finalStamps = pendingEditsFromRaioAnnotations(
      await finalEngine.readRaioPdfAnnotations(
        await finalEngine.open(await engine.saveToBytes(current)),
      ),
    ).filter(isStamp);

    expect(finalStamps).toHaveLength(PLACEMENT_ORDER.length);
    expect(new Set(finalStamps.map((stamp) => stamp.annotId)).size).toBe(PLACEMENT_ORDER.length);
    // Reopened once more, every sticker reads as its reading-order number —
    // both the label a reader sees and the provenance a later renumber uses.
    // Keyed by placement rather than by position, because the order a file
    // stores its annotations in is not a promise the renumber depends on.
    expect(
      Object.fromEntries(
        finalStamps.map((stamp) => [nameOf(stamp), [stamp.lines, stamp.sequence?.index]]),
      ),
    ).toEqual(
      Object.fromEntries(
        READING_ORDER.map((name, index) => [name, [labelFor(index), index]]),
      ),
    );
  });
});

async function placeSaveAndReopen(): Promise<{
  engine: ReturnType<typeof createLocalPdfEngine>;
  reopened: Awaited<ReturnType<ReturnType<typeof createLocalPdfEngine>["open"]>>;
  stamps: PendingExhibitStamp[];
  imports: string[];
  savedBytes: Uint8Array;
  /** Names a stamp by the placement its rectangle came from. */
  nameOf: (stamp: PendingExhibitStamp | undefined) => string;
}> {
  const source = await PDFDocument.create();

  for (const rotation of PAGE_ROTATIONS) {
    source.addPage(PAGE_SIZE).setRotation(degrees(rotation));
  }

  const authoringEngine = createLocalPdfEngine();
  const document = await authoringEngine.open(await source.save());
  const applied = await authoringEngine.applyEdits(document, PLACEMENT_ORDER.map(stampEdit), {
    markupMode: "annotation",
  });
  const savedBytes = await authoringEngine.saveToBytes(applied);

  // A fresh engine, so nothing carries over in memory from placement — every
  // stamp below was reconstructed from the saved file.
  const engine = createLocalPdfEngine();
  const reopened = await engine.open(savedBytes);
  const annotations = await engine.readRaioPdfAnnotations(reopened);
  const stamps = pendingEditsFromRaioAnnotations(annotations).filter(isStamp);
  const namesByRect = new Map(
    PLACEMENTS.map((placement) => [JSON.stringify(placement.rect), placement.name]),
  );

  return {
    engine,
    reopened,
    stamps,
    imports: annotations.map((entry) => entry.annotId),
    savedBytes,
    nameOf: (stamp) => namesByRect.get(JSON.stringify(stamp?.rect)) ?? "unknown",
  };
}

/** The sticker placed at `name`, numbered by its position in placement order. */
function stampEdit(name: string): PdfStampEdit {
  const placement = PLACEMENTS.find((candidate) => candidate.name === name)!;
  const index = PLACEMENT_ORDER.indexOf(name);

  return {
    type: "stamp",
    pageIndex: placement.pageIndex,
    rect: placement.rect,
    lines: labelFor(index),
    fontSizePt: 14,
    bold: true,
    templateId: TEMPLATE_ID,
    templateRevision: TEMPLATE_REVISION,
    sequence: {
      schemaVersion: 1,
      identifierStyle: "numbers",
      prefix: PREFIX,
      layout: "stacked",
      index,
    },
  };
}

function labelFor(index: number): string[] {
  return exhibitLabelLines(PREFIX, "numbers", index, "stacked");
}

function isStamp(edit: PendingEdit): edit is PendingExhibitStamp {
  return edit.kind === "stamp";
}

function byId(stamps: readonly PendingExhibitStamp[], id: string): PendingExhibitStamp | undefined {
  return stamps.find((stamp) => stamp.id === id);
}

function byAnnotId(
  stamps: readonly PendingEdit[],
  annotId: string,
): PendingExhibitStamp | undefined {
  return stamps.filter(isStamp).find((stamp) => stamp.annotId === annotId);
}

async function withPdfJsDocument<T>(
  bytes: Uint8Array,
  run: (pdfDocument: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const task = getDocument({ data: new Uint8Array(bytes) });

  try {
    return await run((await task.promise) as unknown as PDFDocumentProxy);
  } finally {
    await task.destroy();
  }
}
