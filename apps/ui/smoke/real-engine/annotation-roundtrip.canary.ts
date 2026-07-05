import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import type { PdfEdit } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import {
  buildAnnotationSavePlan,
  pendingEditsFromRaioAnnotations,
  type PendingEdit,
} from "../../src/lib/edits";

test("Annotation round-trip: RaioPDF markup imports, updates, deletes, and does not duplicate", async () => {
  const engine = createLocalPdfEngine();
  const sourcePdf = await PDFDocument.create();
  sourcePdf.addPage([360, 240]);
  const source = await engine.open(await sourcePdf.save());
  const authored = [
    {
      type: "highlight",
      pageIndex: 0,
      rects: [{ x: 24, y: 180, w: 90, h: 12 }],
      color: { r: 1, g: 0.82, b: 0.1 },
      opacity: 0.45,
    },
    {
      type: "underline",
      pageIndex: 0,
      rects: [{ x: 24, y: 150, w: 100, h: 10 }],
      color: { r: 0.1, g: 0.2, b: 0.7 },
      thicknessPt: 1.75,
    },
    {
      type: "strikethrough",
      pageIndex: 0,
      rects: [{ x: 24, y: 120, w: 110, h: 10 }],
      thicknessPt: 2,
    },
    {
      type: "textBox",
      pageIndex: 0,
      rect: { x: 160, y: 118, w: 120, h: 44 },
      text: "Round trip text",
      fontSizePt: 12,
      color: { r: 0.1, g: 0.1, b: 0.1 },
      backgroundColor: { r: 0.9, g: 0.95, b: 1 },
      backgroundOpacity: 0.8,
      fontFamily: "courier",
      bold: true,
      align: "center",
    },
    {
      type: "comment",
      pageIndex: 0,
      at: { x: 300, y: 185 },
      text: "Round trip comment",
    },
  ] satisfies PdfEdit[];

  const savedOnceHandle = await engine.applyEdits(source, authored, { markupMode: "annotation" });
  const savedOnce = await engine.saveToBytes(savedOnceHandle);
  const reopenedOnce = await engine.open(savedOnce);
  const imported = await engine.readRaioPdfAnnotations(reopenedOnce);

  expect(imported.map((entry) => entry.edit.type)).toEqual([
    "highlight",
    "underline",
    "strikethrough",
    "textBox",
    "comment",
  ]);
  expect(imported[0]?.edit).toMatchObject(authored[0]);
  expect(imported[1]?.edit).toMatchObject(authored[1]);
  expect(imported[2]?.edit).toMatchObject(authored[2]);
  expect(imported[3]?.edit).toMatchObject(authored[3]);
  expect(imported[4]?.edit).toMatchObject(authored[4]);

  const overlays = pendingEditsFromRaioAnnotations(imported);
  const underlineId = imported.find((entry) => entry.edit.type === "underline")?.annotId;
  const commentId = imported.find((entry) => entry.edit.type === "comment")?.annotId;

  if (!underlineId || !commentId) {
    throw new Error("Expected underline and comment imports.");
  }

  const movedUnderlineRect = { x: 52, y: 88, w: 115, h: 10 };
  const movedAndDeleted: PendingEdit[] = overlays
    .filter((edit) => edit.annotId !== commentId)
    .map((edit) =>
      edit.annotId === underlineId && edit.kind === "underline"
        ? { ...edit, rects: [movedUnderlineRect] }
        : edit,
    );
  const savePlan = buildAnnotationSavePlan(
    movedAndDeleted,
    new Set(imported.map((entry) => entry.annotId)),
  );

  expect(savePlan.appendEdits).toHaveLength(0);
  expect(savePlan.updateEdits).toHaveLength(1);
  expect(savePlan.deleteAnnotIds).toEqual([commentId]);

  let current = reopenedOnce;
  for (const update of savePlan.updateEdits) {
    current = await engine.updateAnnotationById(current, update.annotId, update.edit);
  }
  for (const annotId of savePlan.deleteAnnotIds) {
    current = await engine.deleteAnnotationById(current, annotId);
  }

  const savedTwice = await engine.saveToBytes(current);
  const reopenedTwice = await engine.open(savedTwice);
  const finalImports = await engine.readRaioPdfAnnotations(reopenedTwice);
  const finalIds = finalImports.map((entry) => entry.annotId);
  const finalUnderline = finalImports.find((entry) => entry.annotId === underlineId);

  expect(finalImports.map((entry) => entry.edit.type).sort()).toEqual([
    "highlight",
    "strikethrough",
    "textBox",
    "underline",
  ]);
  expect(finalUnderline?.edit).toMatchObject({
    type: "underline",
    rects: [movedUnderlineRect],
  });
  expect(finalIds).not.toContain(commentId);
  expect(new Set(finalIds).size).toBe(finalIds.length);
});
