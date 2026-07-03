import { PDFDocument } from "pdf-lib";
// The main `pdfjs-dist` entry point expects browser APIs (Worker, etc.) that
// don't exist in a plain Vitest/Node run. The legacy Node-safe build is the
// same one `packages/rules/src/pdfjsNode.ts` already uses for server-side
// text extraction -- reused here for the same reason.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { createLocalPdfEngine } from "@raiopdf/engine-local";

/**
 * Live Test 1, issue 14 ("rotated page still renders portrait-aspect,
 * sideways text") -- repro-first investigation per the fix plan
 * (docs/plans/2026-07-03-live-test-1-fix-plan.md, Workstream B4).
 *
 * This proves the engine + pdf.js layer: rotate a portrait page 90 degrees
 * through the exact engine the UI uses, reload the result with pdf.js (the
 * same library the UI's thumbnails and canvas render through), and assert
 * the page's own viewport reports swapped width/height -- i.e. pdf.js sees
 * the page as landscape after rotation, not still portrait.
 */
describe("rotated page viewport (Live Test 1, issue 14 repro)", () => {
  it("swaps width/height in the rotated page's pdf.js viewport", async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]); // US Letter, portrait
    const sourceBytes = await source.save();

    const engine = createLocalPdfEngine();
    const handle = await engine.open(sourceBytes);
    const rotatedHandle = await engine.rotatePages(handle, [0], 90);
    const rotatedBytes = await engine.saveToBytes(rotatedHandle);

    const beforeViewport = await getPageOneViewport(sourceBytes);
    const afterViewport = await getPageOneViewport(rotatedBytes);

    // Sanity: the un-rotated source really is portrait.
    expect(beforeViewport.width).toBeLessThan(beforeViewport.height);

    // The bug report: after rotation, pdf.js should report a landscape
    // viewport (width/height swapped), not the original portrait shape.
    expect(afterViewport.width).toBeCloseTo(beforeViewport.height, 0);
    expect(afterViewport.height).toBeCloseTo(beforeViewport.width, 0);
  });
});

async function getPageOneViewport(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const task = getDocument({ data: new Uint8Array(bytes) });

  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  } finally {
    await task.destroy();
  }
}
