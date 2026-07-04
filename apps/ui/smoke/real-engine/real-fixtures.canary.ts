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

for (const name of garbleFixtures) {
  test(`Force re-OCR rebuilds a garbled text layer into readable text: ${name}`, async ({ page }) => {
    // NOTE: OCR completion is nondeterministic under load — this occasionally
    // stalls in a full-suite run (see docs/RELEASE-CANARY.md "Unfinished"). The
    // detection half is reliable; the re-OCR poll is kept short so a stall fails
    // fast (~3 min) instead of dragging the suite out.
    test.setTimeout(240_000);
    await installRealEngineBridge(page, endpoint);
    await page.goto("/");
    await openPdf(page, name, localFixture(name)!);

    // 1) Detection: the app must recognize the text layer is garbled.
    await expect(
      page.getByText(/garbled on \d+ of \d+ pages/i),
      "the app should detect a garbled text layer",
    ).toBeVisible({ timeout: 20_000 });

    const canvasRegion = page.getByRole("region", { name: "Document canvas" });
    const commonWordCount = async (): Promise<number> =>
      ((await canvasRegion.innerText()).match(COMMON_WORDS) ?? []).length;
    const before = await commonWordCount();

    // 2) Force re-OCR (NOT plain "Make Searchable", which SKIPS pages that already
    //    carry a — broken — text layer). Confirm via "Rebuild Text Layer".
    await page.getByRole("button", { name: "Force re-OCR text layer" }).click();
    await page.getByRole("button", { name: "Rebuild Text Layer", exact: true }).click();

    // 3) Outcome: the rebuilt text layer now renders real, readable words. Poll
    //    the rendered text (reliable) with a generous budget for a many-page scan.
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

    // Decrypt through the real engine, owner-restricted → empty password.
    const response = await fetch(`${endpoint.baseUrl}/local/decrypt`, {
      method: "POST",
      headers: {
        "X-RaioPDF-Auth": endpoint.token,
        "X-RaioPDF-Password-Hex": "",
        "Content-Type": "application/pdf",
      },
      body: new Uint8Array(source),
    });
    expect(response.status, "engine decrypt should succeed for an owner-restricted PDF").toBe(200);
    const decrypted = new Uint8Array(await response.arrayBuffer());
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
