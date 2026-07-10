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
import { PDFDocument } from "pdf-lib";

const BENIGN_LOG = [/Setting up fake worker/i, /Warning: /i, /fontkit/i];

test("Sensitive-data scanner: finds and masks a planted SSN, offers one-click redaction", async ({ page }) => {
  const logs = captureLogs(page);
  await page.goto("/");
  await openPdf(page, "scanner.pdf", await createTextPdf("Client SSN 123-45-6789 filed under seal"));

  await page.getByRole("button", { name: "2.425 Scanner", exact: true }).click();
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

test("Case caption: saves valid caption pages in multiple local styles", async ({ page }) => {
  const logs = captureLogs(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Caption" }).click();
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

async function downloadBytes(download: Download): Promise<Uint8Array> {
  const filePath = await download.path();
  if (!filePath) {
    throw new Error("Caption download did not produce a local file.");
  }
  return new Uint8Array(await (await import("node:fs/promises")).readFile(filePath));
}
