// Streamed-open scenario for the large-pdf-handling plan: a multi-hundred-MB
// PDF must open through the range transport (browser runtime: File.slice —
// the same `RaioPdfRangeTransport` the Tauri grant path uses), render pages,
// and serve lazy windowed search — while the byte-based gates stay honest.
//
// The fixture is synthetic (random-noise images + per-page text markers) and
// large, so it is NEVER committed: it lives in gitignored
// `smoke/fixtures.local/` and is generated on demand by
// `node smoke/generate-large-fixture.mjs`. When absent, these tests skip —
// exactly like the real-engine canary's sensitive fixtures.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const FIXTURE_PATH = process.env.RAIOPDF_LARGE_FIXTURE ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures.local", "synthetic-large.pdf");

// The streamed branch triggers at the 50 MiB default threshold; anything
// smaller means the fixture was generated wrong and the test would silently
// exercise the ordinary byte path instead.
const MIN_FIXTURE_BYTES = 100 * 1024 * 1024;

const fixtureReady = existsSync(FIXTURE_PATH) && statSync(FIXTURE_PATH).size >= MIN_FIXTURE_BYTES;

if (!fixtureReady) {
  test.skip(
    "streamed large-PDF open (no synthetic-large.pdf — run `node smoke/generate-large-fixture.mjs` first)",
    () => {},
  );
}

test.describe("streamed large-PDF handling", () => {
  test.skip(!fixtureReady, "large fixture not generated");
  // A multi-hundred-MB file input + first render needs more than the default
  // smoke budget.
  test.setTimeout(240_000);

  test("opens streamed, renders pages, searches lazily, and keeps byte gates honest", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Open PDF file").setInputFiles(FIXTURE_PATH);

    // Streamed open succeeded: the first page renders from the range
    // transport and the page count comes from the pdf.js proxy.
    await expect(page.getByRole("button", { name: "Page 1", exact: true })).toBeVisible({
      timeout: 120_000,
    });
    const canvasRegion = page.getByRole("region", { name: "Document canvas" });
    await expect(canvasRegion).toBeVisible();

    // The unique first-page marker proves real content rendered, not a shell.
    await expect
      .poll(async () => canvasRegion.innerText(), { timeout: 60_000 })
      .toContain("MARKER-1 ");

    // Streamed docs cannot dirty — Save stays disabled; Save As (grant copy)
    // is the shell-side path and has no browser equivalent to assert here.
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    // Lazy, windowed search over the streamed proxy: a marker several pages
    // in must be found without the document ever being materialized.
    const searchInput = page.getByLabel("Search document");
    await searchInput.fill("MARKER-5 ");
    // The result label reads "1 of N" — anchored so the page text ("...page
    // 1 of 270") can never satisfy the assertion instead.
    await expect(page.getByText(/^1 of \d+$/)).toBeVisible({ timeout: 120_000 });

    // Byte-based mutations stay gated with the message naming what works.
    await page.getByRole("button", { name: "Rotate selected pages" }).click();
    await expect(
      page.getByText("This document is too large for in-app editing", { exact: false }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Edit Text", exact: true }).click();
    await expect(
      page.getByText("This document is too large for in-app text editing.", { exact: false }),
    ).toBeVisible();

    // Whole-document print is gated in the browser runtime (no shell grant
    // for the page-range extract op).
    await page.getByRole("button", { name: "Print" }).click();
    await expect(
      page.getByText("Printing a very large document isn't available here", { exact: false }),
    ).toBeVisible();
  });
});
