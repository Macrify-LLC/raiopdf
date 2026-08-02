import { PDFDocument, degrees } from "pdf-lib";
// The main `pdfjs-dist` entry expects browser APIs that don't exist in a plain
// Vitest/Node run; the legacy build is the same one the rotation repro test
// uses, for the same reason.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import type { PendingEdit } from "./edits";
import {
  planExhibitStampRenumber,
  readStampVisualRects,
  renumberableStamps,
  type RenumberableStamp,
  type StampVisualRect,
} from "./exhibitStampRenumber";
import type { PDFDocumentProxy } from "./pdfjs";

const TEMPLATE_ID = "plaintiffs-exhibit";
const PAGE_ROTATIONS = [0, 90, 180, 270] as const;

/**
 * Three stamps per page, laid out so that — once the page's rotation is
 * applied — A and B share the top visual line (A left of B) and C sits below
 * them. The user-space rectangles differ wildly per rotation; the reading
 * order they produce must not.
 */
const PAGE_LAYOUTS: ReadonlyArray<
  Readonly<Record<"a" | "b" | "c", { x: number; y: number; w: number; h: number }>>
> = [
  // /Rotate 0: up the page is +y, so the top row is the high-y one.
  {
    a: { x: 50, y: 700, w: 100, h: 50 },
    b: { x: 300, y: 700, w: 100, h: 50 },
    c: { x: 50, y: 400, w: 100, h: 50 },
  },
  // /Rotate 90: the reader's "down the page" is +x, and "across" is +y.
  {
    a: { x: 50, y: 100, w: 100, h: 50 },
    b: { x: 50, y: 400, w: 100, h: 50 },
    c: { x: 300, y: 100, w: 100, h: 50 },
  },
  // /Rotate 180: everything inverts — top row is low y, left is high x.
  {
    a: { x: 400, y: 50, w: 100, h: 50 },
    b: { x: 100, y: 50, w: 100, h: 50 },
    c: { x: 400, y: 300, w: 100, h: 50 },
  },
  // /Rotate 270: down the page is -x, across is -y.
  {
    a: { x: 450, y: 600, w: 100, h: 50 },
    b: { x: 450, y: 300, w: 100, h: 50 },
    c: { x: 200, y: 600, w: 100, h: 50 },
  },
];

describe("exhibit stamp renumbering", () => {
  it("collects a design's placed drafts and imported stamps, and nothing else", () => {
    const edits: PendingEdit[] = [
      stampEdit("draft", 0, { x: 0, y: 0, w: 100, h: 50 }),
      { ...stampEdit("imported", 1, { x: 0, y: 0, w: 100, h: 50 }), annotId: "raio-1" },
      { ...stampEdit("other-design", 2, { x: 0, y: 0, w: 100, h: 50 }), templateId: "other" },
      // A stamp whose provenance was stripped can be moved but not renumbered.
      stampWithoutSequence("no-sequence", 3),
      { kind: "comment", id: "note", pageIndex: 0, at: { x: 1, y: 1 }, text: "hi" },
    ];

    expect(renumberableStamps(edits, TEMPLATE_ID).map((stamp) => stamp.id)).toEqual([
      "draft",
      "imported",
    ]);
  });

  it("renumbers in reading order across pages rotated 0, 90, 180, and 270", async () => {
    const bytes = await createRotatedPdf();
    const task = getDocument({ data: new Uint8Array(bytes) });

    try {
      const pdfDocument = (await task.promise) as unknown as PDFDocumentProxy;
      // Deliberately scrambled: last page first, and each page's stamps out of
      // order, so nothing but the visual sort can produce the expected run.
      const stamps = [...PAGE_ROTATIONS.keys()]
        .reverse()
        .flatMap((pageIndex) => {
          const layout = PAGE_LAYOUTS[pageIndex]!;

          return [
            stampEdit(`p${pageIndex}-c`, pageIndex, layout.c),
            stampEdit(`p${pageIndex}-b`, pageIndex, layout.b),
            stampEdit(`p${pageIndex}-a`, pageIndex, layout.a),
          ];
        });
      const visualRects = await readStampVisualRects(pdfDocument, stamps);
      const steps = planExhibitStampRenumber(stamps, visualRects, 0);

      expect(steps.map((step) => step.id)).toEqual([
        "p0-a", "p0-b", "p0-c",
        "p1-a", "p1-b", "p1-c",
        "p2-a", "p2-b", "p2-c",
        "p3-a", "p3-b", "p3-c",
      ]);
      expect(steps.map((step) => step.index)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      // The label is rebuilt from each stamp's own recorded wording.
      expect(steps[0]?.lines).toEqual(["Plaintiff's Exhibit", "1"]);
      expect(steps[11]?.lines).toEqual(["Plaintiff's Exhibit", "12"]);
    } finally {
      await task.destroy();
    }
  });

  it("keeps two stamps on one visual line in left-to-right order", () => {
    const stamps = [
      stampEdit("right", 0, { x: 300, y: 700, w: 100, h: 50 }),
      stampEdit("left", 0, { x: 50, y: 700, w: 100, h: 50 }),
      stampEdit("below", 0, { x: 50, y: 400, w: 100, h: 50 }),
    ];
    // A few points of vertical drift is still the same line to a reader.
    const visualRects = new Map<string, StampVisualRect>([
      ["right", { left: 300, top: 46, height: 50 }],
      ["left", { left: 50, top: 42, height: 50 }],
      ["below", { left: 50, top: 342, height: 50 }],
    ]);

    expect(
      planExhibitStampRenumber(stamps, visualRects, 0).map((step) => step.id),
    ).toEqual(["left", "right", "below"]);
  });

  it("starts from the identifier the caller asks for", () => {
    const stamps = [
      stampEdit("first", 0, { x: 50, y: 700, w: 100, h: 50 }),
      stampEdit("second", 0, { x: 50, y: 400, w: 100, h: 50 }),
    ];

    expect(planExhibitStampRenumber(stamps, new Map(), 11)).toEqual([
      { id: "first", index: 11, lines: ["Plaintiff's Exhibit", "12"] },
      { id: "second", index: 12, lines: ["Plaintiff's Exhibit", "13"] },
    ]);
  });

  it("falls back to unrotated page geometry when no document is loaded", async () => {
    const stamps = [
      stampEdit("lower", 0, { x: 50, y: 100, w: 100, h: 50 }),
      stampEdit("upper", 0, { x: 50, y: 700, w: 100, h: 50 }),
      stampEdit("next-page", 1, { x: 50, y: 700, w: 100, h: 50 }),
    ];
    const visualRects = await readStampVisualRects(null, stamps);

    expect(visualRects.size).toBe(0);
    expect(
      planExhibitStampRenumber(stamps, visualRects, 0).map((step) => step.id),
    ).toEqual(["upper", "lower", "next-page"]);
  });
});

async function createRotatedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const rotation of PAGE_ROTATIONS) {
    pdf.addPage([612, 792]).setRotation(degrees(rotation));
  }

  return pdf.save();
}

/** A placed stamp that lost its numbering provenance (e.g. a hand edit). */
function stampWithoutSequence(id: string, pageIndex: number): PendingEdit {
  const { sequence: _sequence, ...rest } = stampEdit(id, pageIndex, {
    x: 0,
    y: 0,
    w: 100,
    h: 50,
  });

  return rest;
}

function stampEdit(
  id: string,
  pageIndex: number,
  rect: { x: number; y: number; w: number; h: number },
): RenumberableStamp {
  return {
    kind: "stamp",
    id,
    pageIndex,
    rect,
    lines: ["Plaintiff's Exhibit", "1"],
    fontSizePt: 14,
    templateId: TEMPLATE_ID,
    sequence: {
      schemaVersion: 1,
      identifierStyle: "numbers",
      prefix: "Plaintiff's Exhibit",
      layout: "stacked",
      index: 0,
    },
  };
}
