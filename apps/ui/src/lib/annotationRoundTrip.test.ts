import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PdfEdit, PdfRaioAnnotationImport } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import {
  annotationSavePlanHasChanges,
  buildAnnotationSavePlan,
  pendingEditsFromRaioAnnotations,
  toPdfEdit,
  type PendingEdit,
} from "./edits";
import { countRaioPdfMarkupAnnotations } from "./markupAnnotations";

/**
 * Drawings, shapes, and callouts have to come back from a saved file as LIVE
 * overlay objects — selectable, restyleable, movable, deletable — not just as
 * pixels that happen to render. That is a two-layer promise: the engine has to
 * preserve the annotation, AND the UI has to recognise it as its own and hand
 * the overlay something it can edit.
 *
 * The engine half is covered in `engine-local`'s annotation-layer suite. This
 * file covers the UI half against a real save-and-reopen: the import seam
 * (`pendingEditsFromRaioAnnotations`) and the save-planning seam
 * (`buildAnnotationSavePlan`), driven by the same in-process engine the app
 * uses — the Vitest counterpart of `smoke/real-engine/annotation-roundtrip.canary.ts`,
 * which covers text markup, text boxes, and comments but never authors ink,
 * shapes, or callouts.
 */

const PAGE_SIZE: [number, number] = [320, 220];

/**
 * Every styling value here is deliberately non-default (see `editStyles.ts`),
 * so `toPdfEdit` cannot drop a field as "the engine already defaults that" and
 * accidentally make the fidelity assertion below pass on an empty comparison.
 */
const AUTHORED = [
  {
    type: "ink",
    pageIndex: 0,
    strokes: [
      [{ x: 20, y: 20 }, { x: 40, y: 55 }, { x: 70, y: 30 }],
      [{ x: 90, y: 25 }, { x: 110, y: 60 }],
    ],
    strokeWidthPt: 2.5,
    color: { r: 0.9, g: 0.1, b: 0.1 },
  },
  {
    type: "shape",
    pageIndex: 0,
    shape: "rect",
    rect: { x: 20, y: 80, w: 60, h: 30 },
    strokeWidthPt: 2,
    strokeColor: { r: 0.1, g: 0.4, b: 0.8 },
    fillColor: { r: 0.8, g: 0.9, b: 1 },
  },
  {
    type: "shape",
    pageIndex: 0,
    shape: "ellipse",
    rect: { x: 100, y: 80, w: 50, h: 40 },
    strokeWidthPt: 2.25,
    strokeColor: { r: 0.2, g: 0.6, b: 0.2 },
  },
  {
    type: "shape",
    pageIndex: 0,
    shape: "line",
    from: { x: 20, y: 130 },
    to: { x: 120, y: 150 },
    strokeWidthPt: 3,
    strokeColor: { r: 0.4, g: 0.4, b: 0.4 },
  },
  {
    type: "shape",
    pageIndex: 0,
    shape: "arrow",
    from: { x: 140, y: 130 },
    to: { x: 220, y: 165 },
    strokeWidthPt: 2.75,
    strokeColor: { r: 0.5, g: 0.1, b: 0.5 },
  },
  {
    type: "callout",
    pageIndex: 0,
    rect: { x: 150, y: 40, w: 90, h: 34 },
    tip: { x: 120, y: 20 },
    text: "Callout text",
    fontSizePt: 11,
    align: "center",
    strokeWidthPt: 2.5,
    strokeColor: { r: 0.8, g: 0.3, b: 0 },
  },
] satisfies PdfEdit[];

describe("reopened ink, shape, and callout annotations", () => {
  it("comes back as editable overlay objects, one per authored annotation", async () => {
    const { overlays, imports, savedBytes } = await authorSaveAndReopen();

    // The regression this guards: the annotations rendered fine but RaioPDF no
    // longer claimed them, so the overlay got nothing to select. A dropped kind
    // is silently filtered out by `pendingEditsFromRaioAnnotations`, so the
    // count is the assertion that matters most.
    expect(await countRaioPdfMarkupAnnotations(savedBytes)).toBe(AUTHORED.length);
    expect(imports).toHaveLength(AUTHORED.length);
    expect(overlays).toHaveLength(AUTHORED.length);
    expect(overlays.map((overlay) => overlay.kind)).toEqual([
      "ink",
      "shape",
      "shape",
      "shape",
      "shape",
      "callout",
    ]);

    for (const [index, overlay] of overlays.entries()) {
      const annotId = imports[index]!.annotId;

      // `annotSource` + `annotId` are what mark an overlay item as a live
      // RaioPDF annotation rather than an unsaved draft; without them the
      // overlay cannot update or delete it in place. These are the only
      // fields here that a regression could plausibly drop — `pageIndex` is
      // not asserted because every fixture sits on page 0, so it would hold
      // whether the import read it or hard-coded it.
      expect(overlay).toMatchObject({
        annotSource: "raio",
        annotId,
        id: `annot-${annotId}`,
        status: "applied",
      });
    }
  });

  it("preserves every styling and geometry field the overlay edits", async () => {
    const { overlays, imports } = await authorSaveAndReopen();

    // Exact equality, not a subset match: converting the reopened overlay back
    // through `toPdfEdit` has to reproduce the authored edit field for field.
    // Anything the file lost, or any default the import path invented, shows up
    // here — and a lost stroke width or fill is a restyle the user can't undo.
    for (const [index, overlay] of overlays.entries()) {
      expect(toPdfEdit(overlay)).toEqual({
        ...AUTHORED[index]!,
        annotId: imports[index]!.annotId,
      });
    }

    // Line-like shapes must import on the from/to branch of the pending union
    // and box-like shapes on the rect branch; collapsing the two would make the
    // overlay render an arrow as a rectangle.
    const shapes = overlays.filter((overlay) => overlay.kind === "shape");

    expect(
      shapes.map((shape) => [shape.shape, "rect" in shape ? "rect" : "from-to"]),
    ).toEqual([
      ["rect", "rect"],
      ["ellipse", "rect"],
      ["line", "from-to"],
      ["arrow", "from-to"],
    ]);
  });

  it("moves, restyles, and deletes them in place instead of appending duplicates", async () => {
    const { engine, reopened, overlays, imports } = await authorSaveAndReopen();
    const importedAnnotIds = new Set(imports.map((entry) => entry.annotId));
    const inkId = imports[0]!.annotId;
    const arrowId = imports[4]!.annotId;
    const calloutId = imports[5]!.annotId;
    const movedStrokes = [[{ x: 30, y: 30 }, { x: 60, y: 70 }]];

    const edited = overlays
      .filter((overlay) => overlay.annotId !== arrowId)
      .map((overlay): PendingEdit => {
        if (overlay.annotId === inkId && overlay.kind === "ink") {
          return { ...overlay, strokes: movedStrokes, strokeWidthPt: 4 };
        }

        if (overlay.annotId === calloutId && overlay.kind === "callout") {
          return { ...overlay, text: "Revised callout" };
        }

        return overlay;
      });
    const plan = buildAnnotationSavePlan(edited, importedAnnotIds);

    expect(annotationSavePlanHasChanges(plan)).toBe(true);
    // Nothing is re-appended: a reopened annotation that gets dragged has to be
    // rewritten by id, or saving would leave the old copy behind next to it.
    expect(plan.appendEdits).toEqual([]);
    expect(plan.updateEdits.map((update) => update.annotId).sort()).toEqual(
      [inkId, calloutId].sort(),
    );
    expect(plan.deleteAnnotIds).toEqual([arrowId]);

    let current = reopened;

    for (const update of plan.updateEdits) {
      current = await engine.updateAnnotationById(current, update.annotId, update.edit);
    }

    for (const annotId of plan.deleteAnnotIds) {
      current = await engine.deleteAnnotationById(current, annotId);
    }

    const finalEngine = createLocalPdfEngine();
    const finalOverlays = pendingEditsFromRaioAnnotations(
      await finalEngine.readRaioPdfAnnotations(
        await finalEngine.open(await engine.saveToBytes(current)),
      ),
    );
    const finalIds = finalOverlays.map((overlay) => overlay.annotId);

    expect(finalOverlays).toHaveLength(AUTHORED.length - 1);
    expect(new Set(finalIds).size).toBe(finalIds.length);
    expect(finalIds).not.toContain(arrowId);
    expect(finalOverlays.find((overlay) => overlay.annotId === inkId)).toMatchObject({
      kind: "ink",
      strokes: movedStrokes,
      strokeWidthPt: 4,
    });
    expect(finalOverlays.find((overlay) => overlay.annotId === calloutId)).toMatchObject({
      kind: "callout",
      text: "Revised callout",
      // The untouched fields of a restyled annotation survive the rewrite.
      tip: { x: 120, y: 20 },
      align: "center",
    });
  });
});

async function authorSaveAndReopen(): Promise<{
  engine: ReturnType<typeof createLocalPdfEngine>;
  reopened: Awaited<ReturnType<ReturnType<typeof createLocalPdfEngine>["open"]>>;
  imports: PdfRaioAnnotationImport[];
  overlays: PendingEdit[];
  savedBytes: Uint8Array;
}> {
  const source = await PDFDocument.create();

  source.addPage(PAGE_SIZE);

  const authoringEngine = createLocalPdfEngine();
  const document = await authoringEngine.open(await source.save());
  const applied = await authoringEngine.applyEdits(document, AUTHORED, {
    markupMode: "annotation",
  });
  const savedBytes = await authoringEngine.saveToBytes(applied);

  // A fresh engine, so nothing survives in memory from the authoring pass —
  // whatever the overlay gets back came out of the saved file.
  const engine = createLocalPdfEngine();
  const reopened = await engine.open(savedBytes);
  const imports = await engine.readRaioPdfAnnotations(reopened);

  return {
    engine,
    reopened,
    imports: [...imports],
    overlays: pendingEditsFromRaioAnnotations(imports),
    savedBytes,
  };
}
