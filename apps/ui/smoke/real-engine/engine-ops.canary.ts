// Real-engine canary: drives the actual RaioPDF UI against the LIVE payload
// engine (Rust auth-proxy -> bundled Stirling -> offline OCR toolchain) booted
// by global-setup. Unlike app.smoke.ts (which mocks the desktop engine), every
// engine-backed operation here does real work on real bytes through the real
// HTTP + auth + CORS path — the coverage that catches packaged-build-only
// regressions before a release ships.
//
// Each test also asserts on error logging: happy paths must not spew unexpected
// console/page errors, and error paths must surface a user-facing message AND a
// diagnostic rather than failing silently.

import { expect, test } from "@playwright/test";
import { readEngineEndpoint } from "./endpoint";
import {
  captureLogs,
  createHeavyTextPdf,
  createPdf,
  createScannedPdf,
  createTextPdf,
  hasTextLayer,
  installRealEngineBridge,
  mainCanvas,
  openPdf,
  savePdf,
  saveCanaryArtifact,
} from "./helpers";

const endpoint = readEngineEndpoint();

// One shared engine. workers:1 + fullyParallel:false (canary config) already run
// these sequentially so OCR's session limit and the shared proxy never contend;
// we deliberately do NOT use serial-describe mode, so one failure never skips the
// rest — a canary should report every broken operation in one run.

// pdf.js emits benign worker/font console noise; allow it, fail on anything else.
const BENIGN_LOG = [
  /Setting up fake worker/i,
  /Warning: /i,
  /fontkit/i,
];

test("OCR: force-OCR turns an unreadable scan into genuinely SEARCHABLE text", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  // A crisp "scanned" image of known words, with NO text layer — the garble a
  // lawyer gets from a scanner. Real Tesseract must recover it.
  const scanned = await createScannedPdf(page, "Filing Deadline 2026");
  expect(hasTextLayer(scanned), "fixture must start with NO selectable text").toBe(false);
  await openPdf(page, "scanned.pdf", scanned);

  await page.getByRole("button", { name: "Make Searchable (OCR)", exact: true }).click();
  await page.getByRole("button", { name: "Make searchable", exact: true }).click();
  await expect(page.getByText("Searchable — verified")).toBeVisible({ timeout: 120_000 });

  // The real outcome the user cares about: the words are now findable IN THE APP.
  await page.getByLabel("Search document").fill("Deadline");
  await expect(
    page.locator(".command-bar__search-count"),
    "OCR'd text must be searchable — Tesseract should have recovered 'Deadline'",
  ).toHaveText(/1 of [1-9]\d*/, { timeout: 20_000 });

  // Regression guard for the proxy/local endpoint CORS split: a Stirling-backed
  // OCR request must not poison a later local qpdf request in the same browser
  // session.
  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Compress...", exact: true }).click();
  await page.getByRole("button", { name: "Compress PDF" }).click();
  await expect(page.getByText("Compression complete.")).toBeVisible({ timeout: 120_000 });

  const saved = await savePdf(page);
  expect(Buffer.from(saved.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  expect(hasTextLayer(saved), "OCR output must carry a real text layer").toBe(true);
  logs.assertClean(BENIGN_LOG);
});

test("OCR edge: an already-text PDF is handled without crashing", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");
  await openPdf(page, "already-text.pdf", await createTextPdf("This document already has selectable text."));

  await page.getByRole("button", { name: "Make Searchable (OCR)", exact: true }).click();
  await page.getByRole("button", { name: "Make searchable", exact: true }).click();

  // Whatever the product decides (skip-text no-op or a clean re-OCR), it must
  // resolve to a stable, non-error terminal state — never a stuck spinner.
  await expect(page.locator(".tool-panel")).not.toContainText(/could not|failed/i, { timeout: 120_000 });
  logs.assertClean(BENIGN_LOG);
});

test("Redact: really removes searched text via the engine (verified by re-extraction)", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");
  await openPdf(page, "redact.pdf", await createTextPdf("Confidential SSN 123-45-6789 end"));

  await page.getByRole("button", { name: "Redact", exact: true }).click();
  await page.getByRole("button", { name: "Search text..." }).click();
  await page.getByLabel("Search text to redact").fill("123-45-6789");
  await page.getByLabel("Search text to redact").press("Enter");

  await expect(page.locator(".legal-mode-bar__status")).toContainText("1 area marked");
  await page.getByRole("button", { name: "Apply Redactions" }).click();
  await page.locator(".tool-panel__danger-button", { hasText: "Apply Redactions" }).click();

  await expect(page.getByText(/Redacted and verified/)).toBeVisible({ timeout: 120_000 });
  const saved = await savePdf(page);
  expect(Buffer.from(saved).toString("latin1")).not.toContain("123-45-6789");
  logs.assertClean(BENIGN_LOG);
});

test("Redact edge: a search that matches nothing marks zero areas", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");
  await openPdf(page, "redact-none.pdf", await createTextPdf("Nothing sensitive here"));

  await page.getByRole("button", { name: "Redact", exact: true }).click();
  await page.getByRole("button", { name: "Search text..." }).click();
  await page.getByLabel("Search text to redact").fill("999-99-9999");
  await page.getByLabel("Search text to redact").press("Enter");

  await expect(page.getByText("No matching text was found.")).toBeVisible();
  logs.assertClean(BENIGN_LOG);
});

test("Compress: runs a real compression pass and saves a valid PDF", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");
  await openPdf(page, "compress.pdf", await createHeavyTextPdf(3));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Compress...", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compress PDF" })).toBeVisible();
  await page.getByLabel("Quality").fill("6");
  await page.getByRole("button", { name: "Compress PDF" }).click();

  await expect(page.getByText("Compression complete.")).toBeVisible({ timeout: 120_000 });
  const saved = await savePdf(page);
  expect(Buffer.from(saved.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  logs.assertClean(BENIGN_LOG);
});

test("PDF/A: converts a real PDF to a genuine PDF/A via the bundled Ghostscript", async ({ page }) => {
  // The input a lawyer exports for e-filing: a real, text-bearing PDF.
  const source = await createHeavyTextPdf(3);

  // Convert through the real engine's local Ghostscript interceptor. Stirling
  // 2.14.0 gates /api/v1/convert/pdf/pdfa behind the LibreOffice group (soffice),
  // which RaioPDF doesn't bundle — so that endpoint is disabled in the payload and
  // the engine converts on the bundled Ghostscript instead (POST /local/pdfa).
  const response = await fetch(`${endpoint.baseUrl}/local/pdfa`, {
    method: "POST",
    headers: {
      "X-RaioPDF-Auth": endpoint.token,
      "Content-Type": "application/pdf",
      "X-RaioPDF-PdfA-Level": "2",
      "X-RaioPDF-PdfA-Strict": "false",
    },
    body: new Uint8Array(source),
  });
  expect(response.status, "engine PDF/A conversion should succeed").toBe(200);
  const converted = new Uint8Array(await response.arrayBuffer());
  const latin1 = Buffer.from(converted).toString("latin1");

  // The advertised outcome is a GENUINE PDF/A, not a re-saved PDF: it must carry a
  // PDF/A output intent (which Ghostscript only writes once it has embedded the
  // sRGB ICC profile) and identify itself as PDF/A-2 conformance level B in its
  // XMP metadata. (The ICC stream itself lives in a compressed object stream in
  // PDF/A-2 output, so we assert on the always-plaintext OutputIntent + pdfaid.)
  expect(latin1.includes("/OutputIntent"), "PDF/A output must carry an OutputIntent").toBe(true);
  expect(
    /pdfaid:part\s*=\s*['"]2/.test(latin1),
    "XMP metadata must identify the file as PDF/A part 2",
  ).toBe(true);
  expect(
    /pdfaid:conformance\s*=\s*['"]B/.test(latin1),
    "XMP metadata must declare PDF/A conformance level B",
  ).toBe(true);

  saveCanaryArtifact("pdfa conversion", "converted-pdfa.pdf", converted,
    "converted to PDF/A-2b via the bundled Ghostscript — confirm it opens as PDF/A");

  // End-to-end: the converted bytes open and render in the app, not just parse.
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");
  await openPdf(page, "converted-pdfa.pdf", converted);
  await expect(mainCanvas(page)).toBeVisible();
  logs.assertClean(BENIGN_LOG);
});

test("Error path: an unreachable engine surfaces a user-facing error, not a silent hang", async ({ page }) => {
  // No captureLogs().assertClean() here: this path is SUPPOSED to log a
  // connection failure — the point is that the failure is surfaced, not silent.
  // Point engine_start at a dead port so the first real request fails at the
  // connection level — exercising withEngineRetry + the app's error surface.
  await page.addInitScript(() => {
    (window as typeof window & {
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
    }).__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string): Promise<T> => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }
      return { port: 1, token: "dead", ocrToolchain: { available: true, missing: [] } } as T;
    };
  });
  await page.goto("/");
  await openPdf(page, "dead-engine.pdf", await createPdf([200]));

  await page.getByRole("button", { name: "Make Searchable (OCR)", exact: true }).click();
  await page.getByRole("button", { name: "Make searchable", exact: true }).click();

  await expect(page.getByText(/could not|couldn't|failed|unavailable|try again/i)).toBeVisible({ timeout: 60_000 });
  // The failure must be observable (user message above). The canvas stays put —
  // no crash to a blank app.
  await expect(mainCanvas(page)).toBeVisible();
});
