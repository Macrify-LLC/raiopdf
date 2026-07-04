// Flagship legal-workflow canary: verifies the two features that most need to
// "actually do their job" against the real build/engine —
//   1. Prepare for Filing: really NORMALIZES page size to letter-portrait and
//      really SPLITS the output by file size into correctly-named parts.
//   2. Exhibit binder: really emits a combined PDF with each exhibit stamped
//      with the right label and bookmarked in the right order.

import { expect, test, type Download } from "@playwright/test";
import { readEngineEndpoint } from "./endpoint";
import {
  captureLogs,
  createHeavyLandscapePdf,
  createPdf,
  expectPageStamp,
  installRealEngineBridge,
  isLetterPortrait,
  openPdf,
  pageSizes,
  readOutlineTitles,
  savePdf,
} from "./helpers";

const endpoint = readEngineEndpoint();

const BENIGN_LOG = [/Setting up fake worker/i, /Warning: /i, /fontkit/i];

test("Prepare for Filing: normalizes landscape to letter-portrait AND splits by file size", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  // Landscape, multi-page, well under the portal cap (so the oversize
  // "compress first" gate never triggers) — normalization must rotate every
  // page to portrait.
  await openPdf(page, "filing.pdf", await createHeavyLandscapePdf(4));

  await page.getByRole("button", { name: "Prepare for Filing", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Prepare for Filing" })).toBeVisible();

  // Focus this test on the two claims under test — page-size regulation and
  // split-by-size — both of which are pdf-lib operations. Deselect the
  // engine-backed steps (PDF/A convert, sanitize, scrub) so this test isn't
  // coupled to those endpoints; they're covered by the engine-ops canary.
  for (const step of ["Convert to PDFA-2B", "Sanitize active and embedded content", "Scrub metadata"]) {
    const checkbox = page.getByRole("checkbox", { name: step });
    if ((await checkbox.count()) > 0 && (await checkbox.isChecked())) {
      await checkbox.uncheck();
    }
  }

  // Force a real split with modest content: drop the per-run cap to ~15 KB
  // (the pack default is 24 MB, which this small doc would never exceed).
  await page.getByRole("button", { name: "Show details for Split by upload cap" }).click();
  // Below one page's worth of bytes, so each page becomes its own upload part —
  // a deterministic multi-part split regardless of exact fixture size.
  await page.getByLabel("Custom split size").fill("0.001");

  // Each part is saved individually, so collect every download event.
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));

  await page.getByRole("button", { name: "Make Filing-Ready" }).click();
  // The exact terminal message is written only AFTER every part is converted +
  // saved, so once it shows, all downloads have already fired. Real per-part
  // PDF/A conversion is slow — give it room.
  await expect(page.getByText("Filing output saved after output preflight verification.")).toBeVisible({
    timeout: 200_000,
  });
  await expect.poll(() => downloads.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  // (1) Split-by-size: every part is named "… Part N of M".
  const names = await Promise.all(downloads.map((d) => d.suggestedFilename()));
  for (const name of names) {
    expect(name, `part filename should carry a "Part N of M" label: ${name}`).toMatch(/Part \d+ of \d+/);
  }

  // (2) Page-size regulation: every page of every part is letter-portrait.
  for (const download of downloads) {
    const filePath = await download.path();
    expect(filePath, "each part must produce a real file").toBeTruthy();
    const bytes = new Uint8Array(await (await import("node:fs/promises")).readFile(filePath!));
    const sizes = await pageSizes(bytes);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(isLetterPortrait(size), `page ${JSON.stringify(size)} should be letter-portrait`).toBe(true);
    }
  }

  logs.assertClean(BENIGN_LOG);
});

test("Exhibit binder: assembles a combined PDF with each exhibit stamped and bookmarked", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");
  await openPdf(page, "motion.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Combine with Exhibits", exact: true }).click();
  await page.getByLabel("Add exhibits").setInputFiles([
    { name: "exhibit-a.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createPdf([300, 310])) },
    { name: "exhibit-b.pdf", mimeType: "application/pdf", buffer: Buffer.from(await createPdf([350])) },
  ]);

  await page.getByRole("button", { name: "Build Binder" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  const saved = await savePdf(page);

  // Right labels, stamped on the right pages. Layout (no reorder):
  //   0,1 main · 2 index · 3,4 Exhibit A (2 pages, stamp on p3) · 5 Exhibit B.
  await expectPageStamp(saved, 2, "Exhibit Index");
  await expectPageStamp(saved, 3, "Exhibit A");
  await expectPageStamp(saved, 5, "Exhibit B");

  // Bookmarked in order so the binder is navigable in any viewer.
  const outline = await readOutlineTitles(saved);
  expect(outline).toEqual(["Main document", "Exhibit Index", "Exhibit A", "Exhibit B"]);

  logs.assertClean(BENIGN_LOG);
});
