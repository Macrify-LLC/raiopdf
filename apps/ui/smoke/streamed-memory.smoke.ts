// Phase-4 validation probe (raiopdf-large-pdf-v1-1): open the synthetic
// large fixture through the range transport and SAMPLE PEAK MEMORY while it
// renders + searches, against the plan's "< ~300 MB" streamed-viewer target.
//
// HONEST SCOPE: this is the BROWSER runtime (File.slice-backed
// `RaioPdfRangeTransport`) driven by real Chromium via Playwright/CDP — the
// same transport class the Tauri grant path uses, but NOT WebView2 IPC. It
// measures whether the streaming *architecture* keeps memory bounded
// regardless of file size (the load-bearing claim). A packaged-Tauri run
// over real WebView2 IPC is a separate, non-headless step noted in the report.
//
// Sampling: Chrome DevTools Protocol `Performance.getMetrics` (JSHeapUsedSize)
// polled across the whole open+render+search flow; peak reported. A pre-open
// baseline is captured so the delta attributable to the document is visible.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const FIXTURE_PATH = process.env.RAIOPDF_LARGE_FIXTURE ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures.local", "synthetic-large.pdf");
const MIN_FIXTURE_BYTES = 100 * 1024 * 1024;
const fixtureReady = existsSync(FIXTURE_PATH) && statSync(FIXTURE_PATH).size >= MIN_FIXTURE_BYTES;

// The streamed-viewer target from the plan's test section.
const PEAK_HEAP_TARGET_BYTES = 300 * 1024 * 1024;

test.describe("streamed large-PDF memory ceiling", () => {
  test.skip(!fixtureReady, "large fixture not generated (run generate-large-fixture.mjs)");
  test.setTimeout(300_000);

  test("peak JS heap stays bounded while streaming a 270 MB fixture", async ({ page }) => {
    const fixtureBytes = statSync(FIXTURE_PATH).size;
    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");

    const heapUsed = async (): Promise<number> => {
      const { metrics } = await client.send("Performance.getMetrics");
      return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
    };

    await page.goto("/");
    const baseline = await heapUsed();
    let peak = baseline;
    const sample = async () => { peak = Math.max(peak, await heapUsed()); };

    // Poll heap throughout the flow.
    const poller = setInterval(() => { void sample(); }, 250);

    try {
      await page.getByLabel("Open PDF file").setInputFiles(FIXTURE_PATH);

      await expect(page.getByRole("button", { name: "Page 1", exact: true }))
        .toBeVisible({ timeout: 120_000 });
      const canvasRegion = page.getByRole("region", { name: "Document canvas" });
      await expect.poll(async () => canvasRegion.innerText(), { timeout: 60_000 })
        .toContain("MARKER-1 ");
      await sample();

      // Page through a few screens to force more range fetches + renders —
      // if the whole file were being held, this is where it would balloon.
      for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press("PageDown");
        await page.waitForTimeout(400);
        await sample();
      }

      // Exercise lazy windowed search (touches many pages' text). Wait for
      // the actual result label ("1 of N", anchored so page text can't
      // satisfy it) rather than a fixed delay — a fixed wait could elapse
      // before search produces anything on a slow/real fixture, leaving the
      // search phase unsampled (Codex review, PR #129). Sample WHILE waiting.
      const search = page.getByLabel("Search document");
      await search.fill("MARKER-5 ");
      const resultLabel = page.getByText(/^1 of \d+$/);
      await expect
        .poll(async () => {
          await sample();
          return resultLabel.isVisible();
        }, { timeout: 120_000 })
        .toBe(true);
      await sample();
    } finally {
      clearInterval(poller);
      await sample();
    }

    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    const docDelta = peak - baseline;
    console.log(
      `\n[phase4-memory] fixture=${mb(fixtureBytes)}MB baseline-heap=${mb(baseline)}MB ` +
      `peak-heap=${mb(peak)}MB doc-delta=${mb(docDelta)}MB target<${mb(PEAK_HEAP_TARGET_BYTES)}MB\n`,
    );

    // The load-bearing assertion: peak heap is a SMALL FRACTION of the file
    // size — proof the file is not being materialized. (Whole-file-in-memory
    // would put heap at 2–3x the 270 MB file, i.e. > 540 MB.)
    expect(peak, `peak heap ${mb(peak)}MB should stay under the ${mb(PEAK_HEAP_TARGET_BYTES)}MB streamed target`)
      .toBeLessThan(PEAK_HEAP_TARGET_BYTES);
    expect(peak, `peak heap ${mb(peak)}MB should be far below the ${mb(fixtureBytes)}MB file size`)
      .toBeLessThan(fixtureBytes);
  });
});
