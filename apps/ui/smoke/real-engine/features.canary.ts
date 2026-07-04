// Advertised-feature canary: the client-side legal features RaioPDF markets,
// verified against the REAL build (not the mocked breadth suite). These don't
// call the Stirling engine, but they must still do exactly what's advertised in
// a packaged build — especially the sensitive-data scanner, which is a
// correctness-and-liability feature (Fla. R. Jud. Admin. 2.425).

import { expect, test } from "@playwright/test";
import {
  captureLogs,
  createPdf,
  createTextPdf,
  expectPageStamp,
  openPdf,
  savePdf,
} from "./helpers";

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
