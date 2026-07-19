// Advertised-feature canary: the client-side legal features RaioPDF markets,
// verified against the REAL build (not the mocked breadth suite). These don't
// call the Stirling engine, but they must still do exactly what's advertised in
// a packaged build — especially the sensitive-data scanner, which is a
// correctness-and-liability feature (Fla. R. Jud. Admin. 2.425).

import { expect, test, type Download } from "@playwright/test";
import {
  captureLogs,
  createPdf,
  createTextPdf,
  expectPageStamp,
  openPdf,
  savePdf,
} from "./helpers";
import {
  ALL_METADATA_MARKERS,
  createTaggedMetadataPdf,
  findMetadataMarkers,
} from "./synthetic-fixtures";
import { PDFDocument, StandardFonts } from "pdf-lib";

const BENIGN_LOG = [/Setting up fake worker/i, /Warning: /i, /fontkit/i];

test("Sensitive-data scanner: finds and masks a planted SSN, offers one-click redaction", async ({ page }) => {
  const logs = captureLogs(page);
  await page.goto("/");
  await openPdf(page, "scanner.pdf", await createTextPdf("Client SSN 123-45-6789 filed under seal"));

  await page.getByRole("button", { name: "Sensitive Info Scanner", exact: true }).click();
  await page.getByRole("button", { name: "Scan Document" }).click();

  // The advertised outcome (Fla. R. Jud. Admin. 2.425): the SSN is detected,
  // shown masked, and can be sent straight to redaction. Assistive-only — but
  // it must actually fire on a real build.
  await expect(page.getByText("•••-••-6789")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark for redaction" }).first(),
    "scanner should offer to redact the detected SSN",
  ).toBeVisible();

  logs.assertClean(BENIGN_LOG);
});

test("Bates numbering: stamps sequential numbers into every page's content", async ({ page }) => {
  const logs = captureLogs(page);
  await page.goto("/");
  await openPdf(page, "bates.pdf", await createPdf([200, 210, 220]));

  await page.getByRole("button", { name: "Bates Numbering", exact: true }).click();
  // The prefix has no sample default any more (UX-3) — Apply stays disabled
  // until the user names the matter or explicitly opts into numbers-only.
  await expect(page.getByRole("button", { name: "Apply Bates Numbers" })).toBeDisabled();
  // Scope to the textbox role: #284 added a "No prefix (numbers only)" checkbox
  // whose label also contains "prefix", so a bare getByLabel("Prefix") now
  // resolves two controls.
  await page.getByRole("textbox", { name: "Prefix" }).fill("SMITH");
  await expect(page.getByLabel("Bates preview")).toHaveText("SMITH000001");
  await page.getByRole("button", { name: "Apply Bates Numbers" }).click();

  const saved = await savePdf(page);
  // "Stamped into page content, not annotations" — so it survives in the bytes,
  // sequentially, on every page.
  await expectPageStamp(saved, 0, "SMITH000001");
  await expectPageStamp(saved, 1, "SMITH000002");
  await expectPageStamp(saved, 2, "SMITH000003");

  logs.assertClean(BENIGN_LOG);
});

test("Scrub Metadata: the in-app scrub removes planted Info and XMP metadata from the saved bytes", async ({ page }) => {
  const logs = captureLogs(page);
  // Sentinel Author/Title/Producer/... markers planted in BOTH surfaces a
  // scrub must clear: the trailer Info dict and a catalog XMP packet.
  const source = await createTaggedMetadataPdf();
  expect(
    await findMetadataMarkers(source),
    "the fixture must start fully tagged in Info and XMP",
  ).toEqual([...ALL_METADATA_MARKERS]);

  await page.goto("/");
  await openPdf(page, "tagged-metadata.pdf", source);

  // The user-facing scrub flow (client-side, no engine round trip) — the
  // same engine batch cleanup's scrub step runs on. The sidecar-seam scrub
  // used by the MCP scrub_metadata tool is covered in engine-ops.canary.ts.
  await page.getByRole("button", { name: "Scrub Metadata", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Scrub Metadata" });
  await expect(dialog).toBeVisible();
  // exact: #280 gave every FloatingDialog "Help: <title>" and "Close <title>"
  // buttons, so an inexact name matches the action button plus both of those.
  await dialog.getByRole("button", { name: "Scrub Metadata", exact: true }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  // The advertised outcome: no marker survives in the saved bytes — checked
  // structurally (decoded Info values + every /Metadata stream) and raw.
  const saved = await savePdf(page);
  const leftover = await findMetadataMarkers(saved);
  expect(
    leftover,
    `metadata markers surviving the in-app scrub: ${leftover.join(", ") || "none"}`,
  ).toEqual([]);

  logs.assertClean(BENIGN_LOG);
});

test("Case caption: saves valid caption pages in multiple local styles", async ({ page }) => {
  const logs = captureLogs(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Case Caption (experimental)...", exact: true }).click();
  await page.getByLabel("Court name").fill("Circuit Court");
  await page.getByLabel("Document title").fill("Notice of Filing");
  await page.getByLabel("Name 1").first().fill("Jane Smith");

  const firstDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as PDF" }).click();
  const first = await downloadBytes(await firstDownload);

  await page.getByRole("radio", { name: "Centered federal" }).click();
  const secondDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as PDF" }).click();
  const second = await downloadBytes(await secondDownload);

  const firstPdf = await PDFDocument.load(first);
  const secondPdf = await PDFDocument.load(second);
  expect(firstPdf.getPageCount()).toBe(1);
  expect(secondPdf.getPageCount()).toBe(1);
  expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);

  logs.assertClean(BENIGN_LOG);
});

test("Table of Authorities: saves grouped authority output from reviewed citations", async ({ page }) => {
  const logs = captureLogs(page);
  await page.goto("/");
  await openPdf(page, "toa-brief.pdf", await createAuthorityBriefPdf());

  await page.getByRole("button", { name: "Table of Authorities (experimental)...", exact: true }).click();
  // Detected citations render as editable "Citation" textboxes. Assert the two
  // seeded authorities were detected by reading the inputs' live values.
  // (getByDisplayValue is a Testing-Library API, not Playwright — this check
  // never actually ran until the ToA selector collision above was fixed.)
  await expect
    .poll(() =>
      page
        .getByRole("textbox", { name: "Citation" })
        .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)),
    )
    .toEqual(expect.arrayContaining(["123 So. 3d 456", "Fla. Stat. § 95.11"]));
  await page.getByLabel("Passim threshold").fill("2");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as PDF" }).click();
  const bytes = await downloadBytes(await download);

  await expectPageStamp(bytes, 0, "Cases");
  await expectPageStamp(bytes, 0, "123 So. 3d 456");
  await expectPageStamp(bytes, 0, "Statutes");
  await expectPageStamp(bytes, 0, "Fla. Stat. § 95.11");
  await expectPageStamp(bytes, 0, "Rules");
  await expectPageStamp(bytes, 0, "Fed. R. Civ. P. 56");

  logs.assertClean(BENIGN_LOG);
});

async function downloadBytes(download: Download): Promise<Uint8Array> {
  const filePath = await download.path();
  if (!filePath) {
    throw new Error("Caption download did not produce a local file.");
  }
  return new Uint8Array(await (await import("node:fs/promises")).readFile(filePath));
}

async function createAuthorityBriefPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageTexts = [
    "The motion relies on 123 So. 3d 456 and Fla. Stat. § 95.11.",
    "Summary judgment is governed by Fed. R. Civ. P. 56.",
    "The same case, 123 So. 3d 456, appears again here.",
  ];

  for (const text of pageTexts) {
    const page = pdf.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 700, size: 12, font });
  }

  return pdf.save();
}
