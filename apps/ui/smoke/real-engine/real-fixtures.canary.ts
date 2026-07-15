// Real-fixture regression canary: drives RaioPDF against ACTUAL problem PDFs
// that reproduce specific field-reported failures — font-mismatch "garble" and
// a restricted-but-not-secured (owner-permissions) PDF.
//
// The fixtures are REAL, often-sensitive client documents. They live in the
// gitignored `fixtures.local/` dir (or $RAIOPDF_CANARY_FIXTURES_DIR) and are
// NEVER committed. When they're absent (e.g. a contributor's clean checkout),
// these tests skip. Provide them locally as:
//   fixtures.local/garble-*.pdf              — one or more font-mismatch garble PDFs
//   fixtures.local/restricted-not-secured.pdf — owner-restricted, opens without a password

import { expect, test } from "@playwright/test";
import { createSidecarPdfEngine } from "@raiopdf/engine-sidecar";
import { readEngineEndpoint } from "./endpoint";
import {
  installRealEngineBridge,
  localFixture,
  localFixtureNames,
  mainCanvas,
  openPdf,
  saveCanaryArtifact,
  savePdf,
} from "./helpers";

const endpoint = readEngineEndpoint();

// --- Garble → readable (one test per garble fixture present) -------------------

const garbleFixtures = localFixtureNames(/^garble.*\.pdf$/i);

if (garbleFixtures.length === 0) {
  test.skip("Force re-OCR fixes garbled text (no garble-*.pdf in fixtures.local — skipped)", () => {});
}

// Count occurrences of very common English words — near-zero in a font-mismatch
// garble (random glyph codes), many in genuinely readable text. More reliable
// than the app's search feature, which is separately flaky on some real PDFs.
const COMMON_WORDS = /\b(the|and|of|to|in|is|for|that|with|shall|this|court|county)\b/gi;

// The garble check is split into two independent tests on purpose. DETECTION
// (below) is fast and deterministic — the app reads the broken text layer and
// flags it. RE-OCR VERIFICATION (further below) drives the real OCRmyPDF pass,
// whose completion is nondeterministic under full-suite load: Stirling caps
// concurrent OCR at `ocrMyPdfSessionLimit` (2), and a slot not yet released by an
// earlier OCR test can make this — the suite's 3rd OCR call — queue and stall.
// Keeping them separate means a re-OCR stall reports as exactly that, and never
// masks that detection (the reliable half) works. See docs/RELEASE-CANARY.md
// "Unfinished" for the determinism follow-up (raise the session limit above the
// suite's OCR-call count, or split the engine onto a fresh session per OCR).
for (const name of garbleFixtures) {
  test(`Detects a garbled text layer: ${name}`, async ({ page }) => {
    await installRealEngineBridge(page, endpoint);
    await page.goto("/");
    await openPdf(page, name, localFixture(name)!);

    await expect(
      page.getByText(/garbled on \d+ of \d+ pages/i),
      "the app should detect a garbled text layer",
    ).toBeVisible({ timeout: 20_000 });
  });

  test(`Force re-OCR rebuilds a garbled text layer into readable text: ${name}`, async ({ page }) => {
    test.setTimeout(240_000);
    await installRealEngineBridge(page, endpoint);
    await page.goto("/");
    await openPdf(page, name, localFixture(name)!);

    const canvasRegion = page.getByRole("region", { name: "Document canvas" });
    const commonWordCount = async (): Promise<number> =>
      ((await canvasRegion.innerText()).match(COMMON_WORDS) ?? []).length;
    const before = await commonWordCount();

    // Redo searchable text (NOT plain "Make Searchable", which SKIPS pages that
    // already carry a — broken — text layer). Confirm via "Redo Searchable Text".
    await page.getByRole("button", { name: "Redo searchable text" }).click();
    await page.getByRole("button", { name: "Redo Searchable Text", exact: true }).click();

    // Outcome: the rebuilt text layer now renders real, readable words. Poll the
    // rendered text (reliable) with a generous budget for a many-page scan.
    await expect
      .poll(commonWordCount, {
        timeout: 180_000,
        message: "re-OCR should rebuild the garble into readable words",
      })
      .toBeGreaterThan(10);
    expect(await commonWordCount(), `re-OCR should improve readability (before=${before})`).toBeGreaterThan(before);

    saveCanaryArtifact(`garble→readable: ${name}`, `re-ocr-${name}`, await savePdf(page),
      "re-OCR'd output — open and confirm the text is now readable");
  });
}

// --- Restricted but not secured (one test per restricted-*.pdf) ----------------

const restrictedFixtures = localFixtureNames(/^restricted.*\.pdf$/i);

if (restrictedFixtures.length === 0) {
  test.skip("Handles a restricted-but-not-secured PDF (no restricted-*.pdf in fixtures — skipped)", () => {});
}

for (const restrictedName of restrictedFixtures) {
  const restricted = localFixture(restrictedName);
  test(`Handles a restricted-but-not-secured PDF and makes it usable: ${restrictedName}`, async ({ page }) => {
    // Needs the engine: this owner-restricted (has an /Encrypt dict, no user
    // password) PDF doesn't open with pdf.js alone — RaioPDF routes it through
    // the engine-backed Repair path.
    await installRealEngineBridge(page, endpoint);
    await page.goto("/");
    await page.getByLabel("Open PDF file").setInputFiles({
      name: restrictedName,
      mimeType: "application/pdf",
      buffer: Buffer.from(restricted!),
    });

    // Either it opens straight away, or the Repair dialog appears — drive
    // whichever real path this build takes.
    const pageOne = page.getByRole("button", { name: "Page 1" });
    const repair = page.getByRole("button", { name: "Repair PDF" });
    await expect(async () => {
      expect((await pageOne.isVisible()) || (await repair.isVisible())).toBe(true);
    }).toPass({ timeout: 30_000 });

    if (await repair.isVisible()) {
      await expect(repair, "Repair must be actionable, not disabled").toBeEnabled();
      await repair.click();
    }

    // The end state the user cares about: the restricted PDF is open, rendered,
    // and fully editable — NOT treated as locked. (Print is a doc-dependent
    // action that's disabled in the empty state.)
    await expect(pageOne).toBeVisible({ timeout: 180_000 });
    await expect(mainCanvas(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Print" }),
      "a restricted-not-secured PDF should open fully usable, not locked",
    ).toBeEnabled();

    saveCanaryArtifact(`restricted handled: ${restrictedName}`, `opened-${restrictedName}`, await savePdf(page),
      "opened from the restricted original — confirm it's the right document");
  });
}

// --- Engine decrypt must PRESERVE the text layer (lossless qpdf) ----------------
// The engine's removeEncryption is now backed by the bundled qpdf (POST
// /local/decrypt). This is the regression guard for the finding that Stirling's
// remove-password and the Repair path both DROP the text layer.

for (const restrictedName of restrictedFixtures) {
  test(`Engine decrypt preserves the text layer (lossless qpdf): ${restrictedName}`, async ({ page }) => {
    const source = localFixture(restrictedName)!;

    // Decrypt through the production sidecar client so this canary exercises
    // the same bounded binary secret envelope as the app.
    const engine = createSidecarPdfEngine({
      baseUrl: endpoint.baseUrl,
      authToken: endpoint.token,
    });
    const decrypted = await engine.removeEncryption(new Uint8Array(source), "");
    const latin1 = Buffer.from(decrypted).toString("latin1");

    // Lossless, structurally: encryption removed, fonts kept, size ~preserved —
    // NOT the gutted output the lossy paths produced.
    expect(latin1.includes("/Encrypt"), "encryption dict should be removed").toBe(false);
    expect(/\/Font/.test(latin1), "the text-layer fonts must survive decryption").toBe(true);
    expect(
      decrypted.byteLength,
      "lossless output stays roughly the original size, not gutted",
    ).toBeGreaterThan(source.byteLength / 2);

    // End-to-end: the decrypted bytes open in the app and render REAL, extractable
    // text (the pdf.js text layer), proving the text layer survived decryption.
    await installRealEngineBridge(page, endpoint);
    await page.goto("/");
    await openPdf(page, `decrypted-${restrictedName}`, decrypted);
    const canvasRegion = page.getByRole("region", { name: "Document canvas" });
    await expect
      .poll(async () => (await canvasRegion.innerText()).length, {
        timeout: 20_000,
        message: "decrypted PDF must render an extractable text layer",
      })
      .toBeGreaterThan(200);
    expect(
      /\bthe\b/i.test(await canvasRegion.innerText()),
      "rendered text must contain real words, not gibberish",
    ).toBe(true);

    saveCanaryArtifact(`lossless decrypt: ${restrictedName}`, `decrypted-${restrictedName}`, decrypted,
      "qpdf-decrypted — confirm the text is intact and selectable");
  });
}
