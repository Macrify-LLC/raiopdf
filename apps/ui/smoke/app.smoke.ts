import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFStream,
  StandardFonts,
} from "pdf-lib";

test("disables doc-dependent chrome and hover echoes for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Print" })).toBeDisabled();

  const openIcon = page
    .locator(".command-bar")
    .getByRole("button", { name: "Open", exact: true })
    .locator(".rp-icon");
  await openIcon.hover();
  await expect.poll(async () => {
    return openIcon.locator(".rp-echo").first().evaluate((element) => {
      return getComputedStyle(element).animationName;
    });
  }).toBe("none");
});

test("opens legal workflow dialogs before a document is loaded", async ({ page }) => {
  await page.goto("/");

  for (const legalTool of [
    {
      name: "Prepare for Filing",
      emptyState: "Open a PDF before preparing a filing copy.",
    },
    {
      name: "Batch Cleanup",
      emptyState: "Add PDFs to build the cleanup queue.",
    },
    {
      name: "Production Set",
      emptyState: "Add PDFs to build the production order.",
    },
  ]) {
    await page.getByRole("button", { name: legalTool.name, exact: true }).click();

    const dialog = page.getByRole("dialog", { name: legalTool.name });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(legalTool.emptyState)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("opens, rotates, deletes, reorders, and saves a PDF round trip", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "round-trip.pdf", await createPdf([200, 210, 220, 230]));

  await page.getByRole("button", { name: "Rotate selected pages" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Page 2" }).click();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Delete selected pages" }).click();
  await expect(page.getByRole("button", { name: "Page 4" })).toBeHidden();

  await page.getByRole("button", { name: "Move selected pages down" }).click();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [200, 230, 220],
    rotations: [90, 0, 0],
  });
});

test("renders page 1 in the main canvas after opening a PDF", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "render-main-canvas.pdf", await createTextPdf("Main canvas render check"));

  await expect(page.locator(".canvas-well__empty")).toHaveCount(0);
  await expect(page.getByText("This PDF could not be opened. The file may be corrupt or unsupported.")).toHaveCount(0);
  await expect(page.locator('[data-testid="pdf-page-canvas"]')).toBeVisible();
  await expect.poll(() => mainCanvasStats(page)).toMatchObject({
    widthReady: true,
    heightReady: true,
    hasTextPixels: true,
  });
});

test("zooms the canvas with Acrobat-style shortcuts", async ({ page }) => {
  await page.goto("/");
  await openPdf(
    page,
    "zoom-shortcuts.pdf",
    await createMultiPageTextPdf(["Zoom shortcut smoke"]),
  );

  const zoomLabel = page.locator(".command-bar__zoom-label");
  const canvas = page.locator('[data-testid="pdf-page-canvas"]');
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Rendered canvas did not produce a bounding box.");
  }

  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await page.keyboard.press("Control+0");
  await expect(zoomLabel).toHaveText("100%");

  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.keyboard.down("Control");

  try {
    await page.mouse.wheel(0, 400);
  } finally {
    await page.keyboard.up("Control");
  }

  await expect.poll(async () => (await zoomLabel.textContent())?.trim()).not.toBe("100%");

  await page.keyboard.press("Control+0");
  await expect(zoomLabel).toHaveText("100%");
});

test("renders page 1 in the main canvas after opening a 4-page PDF", async ({ page }) => {
  await page.goto("/");
  await openPdf(
    page,
    "render-main-canvas-4-page.pdf",
    await createMultiPageTextPdf([
      "Line 1: the parties stipulate to the facts set forth herein.",
      "Line 2: the movant requests relief under the attached order.",
      "Line 3: counsel certifies conferral before filing.",
      "Line 4: the court retains jurisdiction for enforcement.",
    ]),
  );

  await expect(page.getByRole("button", { name: "Page 4" })).toBeVisible();
  await expect(page.locator(".canvas-well__empty")).toHaveCount(0);
  await expect(page.getByText("This PDF could not be opened. The file may be corrupt or unsupported.")).toHaveCount(0);
  await expect(page.locator('[data-testid="pdf-page-canvas"]')).toBeVisible();
  await expect.poll(() => mainCanvasStats(page)).toMatchObject({
    widthReady: true,
    heightReady: true,
    hasTextPixels: true,
  });
});

test("renders the Word-generated DCM order fixture", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "dcm-order.pdf", await readFixture("dcm-order.pdf"));

  await expect(page.getByRole("button", { name: "Page 7" })).toBeVisible();
  await expect.poll(() => mainCanvasStats(page)).toMatchObject({
    widthReady: true,
    heightReady: true,
    hasTextPixels: true,
  });

  const searchInput = page.getByLabel("Search document");
  await searchInput.fill("Uniform Order Setting Trial");
  await expect(page.locator(".command-bar__search-count")).toHaveText(/1 of [1-9]\d*/);
  await expect.poll(() => searchResultCount(page)).toBeGreaterThan(0);
  await expect(page.getByText("Page 2 / 7")).toBeVisible();
  await expect(page.locator('[data-testid="search-highlight"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Next search result" }).click();
  await expect(page.locator(".command-bar__search-count")).toHaveText(/2 of [1-9]\d*/);
  await expect(page.getByText("Page 3 / 7")).toBeVisible();

  await page.getByRole("button", { name: "Previous search result" }).click();
  await expect(page.locator(".command-bar__search-count")).toHaveText(/1 of [1-9]\d*/);
  await expect(page.getByText("Page 2 / 7")).toBeVisible();

  await searchInput.press("Enter");
  await expect(page.locator(".command-bar__search-count")).toHaveText(/2 of [1-9]\d*/);
  await expect(page.getByText("Page 3 / 7")).toBeVisible();

  await searchInput.press("Shift+Enter");
  await expect(page.locator(".command-bar__search-count")).toHaveText(/1 of [1-9]\d*/);
  await expect(page.getByText("Page 2 / 7")).toBeVisible();

  await searchInput.press("Escape");
  await expect(searchInput).toHaveValue("");
  await expect(page.locator(".command-bar__search-count")).toHaveCount(0);
});

test("queues rapid rotate and delete clicks without losing the delete", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "rapid-fire.pdf", await createPdf([200, 210, 220]));

  const rotate = page.getByRole("button", { name: "Rotate selected pages" });
  const deleteSelected = page.getByRole("button", { name: "Delete selected pages" });
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  const firstRotate = rotate.click();
  const secondRotate = rotate.click();
  const deleteClick = deleteSelected.click();
  await Promise.all([firstRotate, secondRotate, deleteClick]);

  await expect(page.getByText("Page 1 / 2")).toBeVisible();
  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [210, 220],
    rotations: [0, 0],
  });
});

test("makes an image-only PDF searchable through the mocked desktop OCR bridge", async ({ page }) => {
  const sourcePdf = await createPdf([200]);
  const searchablePdf = await createTextPdf("Verified OCR text");
  await installOcrBridgeMock(page, searchablePdf);
  await page.goto("/");
  await openPdf(page, "scan.pdf", sourcePdf);

  const makeSearchable = page.getByRole("button", { name: "Make Searchable (OCR)", exact: true });
  await makeSearchable.evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
  });

  await expect(page.getByText("Starting the PDF engine...")).toBeVisible();
  await expect(makeSearchable).toBeDisabled();
  await expect(page.getByText("Making searchable — page-by-page work happens in the engine.")).toBeVisible();
  await expect(page.getByText("Verifying the text layer...")).toBeVisible();
  await expect(page.locator(".tool-panel").getByText("Rebuilt the text layer on 1 page. Copy, paste, and search now return real text. Verified: all 1 page now has clean searchable text.")).toBeVisible();
  await expect(page.getByRole("contentinfo").getByText("Searchable — verified")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect.poll(() => getOcrCallCount(page)).toBe(1);
});

test("leaves the document unchanged when OCR returns no text layer", async ({ page }) => {
  const sourcePdf = await createPdf([200]);
  const imageOnlyOcrPdf = await createPdf([240]);
  await installOcrBridgeMock(page, imageOnlyOcrPdf);
  await page.goto("/");
  await openPdf(page, "scan.pdf", sourcePdf);

  await page.getByRole("button", { name: "Make Searchable (OCR)", exact: true }).click();

  await expect(page.getByText("OCR ran, but 1 page still has no searchable text — the original was kept unchanged; the underlying scan is likely too low-quality to read.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeHidden();

  const saved = await savePdf(page);
  expect(Buffer.from(saved).equals(Buffer.from(sourcePdf))).toBe(true);
});

test("keeps a rotate queued during mocked OCR and rejects the stale OCR result", async ({ page }) => {
  const sourcePdf = await createPdf([200]);
  const searchablePdf = await createTextPdf("Verified OCR text");
  await installOcrBridgeMock(page, searchablePdf, {
    engineStartDelayMs: 20,
    ocrDelayMs: 350,
  });
  await page.goto("/");
  await openPdf(page, "scan.pdf", sourcePdf);

  await page.getByRole("button", { name: "Make Searchable (OCR)", exact: true }).click();
  await expect(page.getByText("Making searchable — page-by-page work happens in the engine.")).toBeVisible();

  await page.getByRole("button", { name: "Rotate selected pages" }).click();

  await expect(page.getByText("The document changed before OCR finished. The result was not applied.")).toBeVisible();
  await expect.poll(() => getOcrCallCount(page)).toBe(1);

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [200],
    rotations: [90],
  });
});

test("builds an exhibit binder round trip from a keyboard-only assembly path", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "motion.pdf", await createPdf([200, 210]));

  const combine = page.getByRole("button", { name: "Combine with Exhibits", exact: true });
  await combine.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Page 1 / 2")).toBeVisible();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
  await expect(page.getByText(/Page 0/)).toHaveCount(0);
  await expect(page.getByText("0 x 0 in")).toHaveCount(0);
  await expect(page.getByText("0 KB")).toHaveCount(0);

  await page.getByLabel("Add exhibits").setInputFiles([
    {
      name: "exhibit-a.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await createPdf([300, 310])),
    },
    {
      name: "exhibit-b.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await createPdf([350])),
    },
  ]);

  const moveFirstDown = page.getByRole("button", { name: "Move exhibit-a.pdf down" });
  await moveFirstDown.focus();
  await page.keyboard.press("Enter");

  const buildBinder = page.getByRole("button", { name: "Build Binder" });
  await buildBinder.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 6" })).toBeVisible();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [200, 210, 200, 350, 300, 310],
    rotations: [0, 0, 0, 0, 0, 0],
  });
  await expectPageContentToContainLabel(saved, 2, "Exhibit Index");
  await expectPageContentToContainLabel(saved, 3, "Exhibit A");
  await expectPageContentToContainLabel(saved, 4, "Exhibit B");
  await expectOutlineEntries(saved, [
    { title: "Main document", pageIndex: 0 },
    { title: "Exhibit Index", pageIndex: 2 },
    { title: "Exhibit A", pageIndex: 3 },
    { title: "Exhibit B", pageIndex: 4 },
  ]);
});

test("2.425 scanner finds and masks a planted SSN", async ({ page }) => {
  await page.goto("/");
  await openPdf(
    page,
    "scanner-fixture.pdf",
    await createTextPdf("Client SSN 123-45-6789 Account 987654321"),
  );

  await page.getByRole("button", { name: "2.425 Scanner", exact: true }).click();
  await page.getByRole("button", { name: "Scan Document" }).click();

  await expect(page.getByText("•••-••-6789")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark for redaction" }).first()).toBeVisible();
});

test("redacts searched text through the mocked desktop engine and verifies output", async ({ page }) => {
  const sourcePdf = await createTextPdf("Confidential SSN 123-45-6789");
  const redactedPdf = await createPdf([200]);
  await installRedactionBridgeMock(page, redactedPdf);
  await page.goto("/");
  await openPdf(page, "redact.pdf", sourcePdf);

  await page.getByRole("button", { name: "Redact", exact: true }).click();
  await page.getByRole("button", { name: "Search text..." }).click();
  await page.getByLabel("Search text to redact").fill("123-45-6789");
  await page.getByLabel("Search text to redact").press("Enter");

  await expect(page.getByText("Redaction mode — 1 area marked")).toBeVisible();
  await page.getByRole("button", { name: "Apply Redactions" }).click();
  await expect(page.getByText("1 area will be permanently removed")).toBeVisible();
  await page.locator(".tool-panel__danger-button", { hasText: "Apply Redactions" }).click();

  await expect(page.getByText("Redacted and verified: text layer verified clean; redacted page images replaced; annotations cleaned; metadata scrubbed.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect.poll(() => getRedactionCallCount(page)).toBe(1);
});

test("Bates numbering card shows the live default format preview", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "bates.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Bates Numbering", exact: true }).click();
  await expect(page.locator('[data-testid="pdf-page-canvas"]')).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Bates Numbering" })).toBeVisible();
  await expect(page.getByLabel("Bates preview")).toHaveText("SMITH000001");
  await page.getByLabel("Prefix").fill("CASE");
  await page.getByLabel("Start").fill("42");
  await page.getByLabel("Digits").fill("4");
  await expect(page.getByLabel("Bates preview")).toHaveText("CASE0042");
});

test("compresses through the mocked desktop engine from the floating dialog", async ({ page }) => {
  const compressedPdf = await createPdf([180]);
  await installCompressBridgeMock(page, compressedPdf);
  await page.goto("/");
  await openPdf(page, "compress.pdf", await createPdf([200]));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Compress...", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Compress" })).toBeVisible();
  await page.getByLabel("Quality").fill("6");
  await page.getByLabel("Grayscale").check();
  await page.getByRole("button", { name: "Compress PDF" }).click();

  await expect(page.getByText("Compression complete.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect.poll(() => getCompressCallCount(page)).toBe(1);

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [180],
    rotations: [0],
  });
});

test("page numbers apply as stamped bytes", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "page-numbers.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Page Numbers...", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Page Numbers" })).toBeVisible();
  await page.getByLabel("Format").selectOption("page-of-total");
  await page.getByRole("button", { name: "Apply Page Numbers" }).click();
  await expect(page.getByText("Page numbers applied.")).toBeVisible();

  const saved = await savePdf(page);
  expect(await readDecodedPageContent(saved, 0)).toContain(encodeTextAsHex("Page 1 of 2"));
  expect(await readDecodedPageContent(saved, 1)).toContain(encodeTextAsHex("Page 2 of 2"));
});

test("inserts an image as a full PDF page", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "insert-image-pages.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Insert images as pages...", exact: true }).click();
  await page.locator("#insert-image-pages").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(onePixelPng()),
  });
  await page.getByRole("button", { name: "Insert Images", exact: true }).click();
  await expect(page.getByText("Image pages inserted.")).toBeVisible();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [1, 200, 210],
    rotations: [0, 0, 0],
  });
});

test("drops insert-image results if another PDF opens while images are read", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "insert-image-race.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Insert images as pages...", exact: true }).click();
  await page.locator("#insert-image-pages").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(onePixelPng()),
  });
  await page.evaluate(() => {
    (window as typeof window & {
      __RAIOPDF_TEST_INSERT_IMAGE_READ_DELAY_MS__?: number;
    }).__RAIOPDF_TEST_INSERT_IMAGE_READ_DELAY_MS__ = 250;
  });

  await page.getByRole("button", { name: "Insert Images", exact: true }).click();
  await openPdf(page, "opened-during-image-read.pdf", await createPdf([260]));

  await expect(page.getByText("The document changed before image pages finished loading.")).toBeVisible();
  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [260],
    rotations: [0],
  });
});

test("stacked floating dialogs let Escape close only the top dialog", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "stacked-dialogs.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Bates Numbering", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Bates Numbering" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".tool-panel").getByRole("button", { name: "Sign", exact: true }).click();
  const signatureDialog = page.getByRole("dialog", { name: "Signature", exact: true });
  await expect(signatureDialog).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(signatureDialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Bates Numbering" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog", { name: "Bates Numbering" })).toBeHidden();
});

test("organize page grid multi-select extracts selected pages round trip", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "organize-extract.pdf", await createPdf([200, 210, 220, 230]));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Organize Pages", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Organize Pages" })).toBeVisible();

  await page.getByRole("button", { name: "Organize page 2" }).click();
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.getByRole("button", { name: "Organize page 4" }).click();
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");

  await page.getByRole("button", { name: "Extract" }).click();
  await expect(page.getByText("Page 1 / 2")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [210, 230],
    rotations: [0, 0],
  });
});

test("organize page grid ignores rapid second drag while a reorder is pending", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & {
      __RAIOPDF_TEST_REORDER_DELAY_MS__?: number;
    }).__RAIOPDF_TEST_REORDER_DELAY_MS__ = 250;
  });
  await page.goto("/");
  await openPdf(page, "organize-rapid-drag.pdf", await createPdf([200, 210, 220, 230]));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Organize Pages", exact: true }).click();

  const grid = page.getByRole("list", { name: "Page grid" });
  await page.getByRole("button", { name: "Organize page 1" })
    .dragTo(page.getByRole("button", { name: "Organize page 3" }));
  await expect(grid).toHaveAttribute("aria-busy", "true");

  await page.getByRole("button", { name: "Organize page 4" })
    .dragTo(page.getByRole("button", { name: "Organize page 2" }), { force: true });
  await expect(grid).toHaveAttribute("aria-busy", "false");

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [210, 200, 220, 230],
    rotations: [0, 0, 0, 0],
  });
});

test("prepares an oversize landscape filing copy and re-runs preflight on output", async ({ page }) => {
  const sourcePdf = await createPaddedPdf(
    await createLandscapeTextPdf([
      "Motion for summary judgment",
      "Exhibit index and certificate text",
    ]),
    26 * 1024 * 1024,
  );
  const convertedPdf = await createMultiPageTextPdf([
    "Converted filing output page 1",
    "Converted filing output page 2",
  ]);
  await installFilingBridgeMock(page, convertedPdf);
  await page.goto("/");
  await openPdf(page, "landscape-oversize.pdf", sourcePdf);
  await page.getByRole("button", { name: "Prepare for Filing", exact: true }).click();

  const filingDialog = page.getByRole("dialog", { name: "Prepare for Filing" });
  await expect(filingDialog).toBeVisible();
  const jurisdictionHeader = filingDialog.locator(".filing-card__jurisdiction");
  await expect(jurisdictionHeader.getByRole("combobox", { name: "Jurisdiction pack" })).toHaveValue("florida");
  await expect(page.getByText("State trial and appellate courts")).toBeVisible();
  await expect(page.getByText("These checks are guidance only")).toBeVisible();
  await expect(page.getByRole("button", { name: "View the rules applied" })).toBeVisible();

  const lawRows = page.locator('.filing-row[data-kind="rule"]');
  await expect(lawRows.filter({ hasText: "Letter portrait pages" })).toHaveAttribute("data-status", "warn");
  await expect(lawRows.locator(".filing-row__chip", { hasText: "warning" })).toHaveCount(0);
  await expect(page.locator('.filing-row[data-kind="portal"] .filing-row__chip', { hasText: "warning" })).toHaveCount(2);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Make Filing-Ready" }).click();
  await downloadPromise;

  await expect(page.getByText("Filing output saved after output preflight verification.")).toBeVisible();
  await expect(page.getByText("Output preflight re-run complete")).toBeVisible();
  await expect(page.getByText("Verified after re-running preflight on the output.")).toBeVisible();
  await expect(page.getByText("landscape-oversize — filing.pdf")).toBeVisible();
  await expect(page.locator('.filing-row[data-kind="rule"] .filing-row__chip', { hasText: "warning" })).toHaveCount(0);
  await expect.poll(() => getFilingPreflightRuns(page)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => getPdfACallCount(page)).toBe(1);
});

test("prepare for filing closes an open organize workspace", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "organize-to-filing.pdf", await createPdf([200, 210, 220]));

  await page.getByRole("button", { name: "Organize" }).click();
  await page.getByRole("button", { name: "Organize Pages", exact: true }).click();
  await expect(page.getByRole("list", { name: "Page grid" })).toBeVisible();

  await page.getByRole("button", { name: "Legal" }).click();
  await page.getByRole("button", { name: "Prepare for Filing", exact: true }).click();

  await expect(page.getByRole("list", { name: "Page grid" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Prepare for Filing" })).toBeVisible();
});

test("compressing an oversize filing under the cap clears the split prompt", async ({ page }) => {
  const sourcePdf = await createPaddedPdf(
    await createMultiPageTextPdf(["Oversize filing page"]),
    26 * 1024 * 1024,
  );
  const compressedPdf = await createMultiPageTextPdf(["Compressed filing page"]);
  const convertedPdf = await createMultiPageTextPdf(["Converted compressed filing page"]);
  await installFilingAndCompressBridgeMock(page, {
    compressedBytes: compressedPdf,
    convertedBytes: convertedPdf,
  });
  await page.goto("/");
  await openPdf(page, "oversize-compressed.pdf", sourcePdf);
  await page.getByRole("button", { name: "Prepare for Filing", exact: true }).click();

  await expect(page.getByRole("button", { name: "Compress first" })).toBeVisible();
  await page.getByRole("button", { name: "Compress first" }).click();
  await expect(page.getByText("Compression complete. Preflight will re-run on the compressed document.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compress first" })).toBeHidden();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Make Filing-Ready" }).click();
  await downloadPromise;

  await expect(page.getByText("oversize-compressed — filing.pdf")).toBeVisible();
  await expect(page.getByText(/Part 1 of/)).toHaveCount(0);
  await expect.poll(() => getCompressCallCount(page)).toBe(1);
  await expect.poll(() => getPdfACallCount(page)).toBe(1);
});

test("places a text box, highlight, and comment, saves, and re-opens with all present", async ({ page }) => {
  await page.goto("/");
  await openPdf(
    page,
    "edit-round-trip.pdf",
    await createMultiPageTextPdf(["The parties stipulate to the facts set forth herein."]),
  );

  const commandBar = page.locator(".command-bar");
  const canvas = page.locator('[data-testid="pdf-page-canvas"]');

  // Highlight: drag a band across the text line near the top of the page.
  // Retries in case the drag lands before the page's text layer resolves —
  // a miss adds nothing, so retrying cannot double-place.
  await commandBar.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(async () => {
    if ((await page.locator(".edit-layer__highlight").count()) === 0) {
      await dragOnCanvas(page, canvas, 0.08, 0.06, 0.92, 0.13);
    }

    await expect(page.locator(".edit-layer__highlight").first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });

  // Text box: click to place, type, Enter commits.
  await commandBar.getByRole("button", { name: "Text box", exact: true }).click();
  await clickCanvasAt(page, canvas, 0.3, 0.4);
  await page.getByLabel("Text box content").fill("Deposition note");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  // Comment: click drops a pin, popover takes the note text.
  await commandBar.getByRole("button", { name: "Comment", exact: true }).click();
  await clickCanvasAt(page, canvas, 0.6, 0.5);
  await page.getByLabel("Comment text").fill("Check exhibit reference");
  await page.getByRole("button", { name: "Save Note" }).click();
  await expect(page.locator(".edit-layer__comment-pin")).toHaveCount(1);

  // The Edit panel group lists content edits only; comments live in Comment.
  const toolPanel = page.locator(".tool-panel");
  await toolPanel.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(toolPanel.getByText("2 pending edits")).toBeVisible();
  await expect(
    toolPanel.locator("#accordion-panel-edit").getByText("Check exhibit reference"),
  ).toHaveCount(0);

  // The Comment panel group lists the note with its page and excerpt.
  await toolPanel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(toolPanel.getByText("1 comment", { exact: true })).toBeVisible();
  await expect(
    toolPanel.locator("#accordion-panel-comment").getByText("Check exhibit reference"),
  ).toBeVisible();

  const saved = await savePdf(page);

  // The pending list clears only on verified success.
  await expect(toolPanel.getByText("2 pending edits")).toHaveCount(0);
  await expect(page.getByLabel("Unsaved changes")).toBeHidden();

  // Saved bytes carry the baked text box, the highlight fill, and a live
  // /Text annotation for the comment.
  const content = await readDecodedPageContent(saved, 0);
  expect(content).toContain(encodeTextAsHex("Deposition note"));
  expect(content).toMatch(/1 0\.9 0\.3 rg/);
  await expectTextAnnotation(saved, 0, "Check exhibit reference");

  // Re-open the saved file: it loads and renders cleanly, with nothing pending.
  await openPdf(page, "edit-round-trip-reopened.pdf", saved);
  await expect.poll(() => mainCanvasStats(page)).toMatchObject({
    widthReady: true,
    heightReady: true,
    hasTextPixels: true,
  });
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(0);
  await expect(page.locator(".edit-layer__comment-pin")).toHaveCount(0);
});

test("places a text box rotation-correctly on a rotated page", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "rotated-edit.pdf", await createPdf([300]));

  // Rotate the page 90 degrees, then place a text box at a known spot.
  await page.getByRole("button", { name: "Rotate selected pages" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  const commandBar = page.locator(".command-bar");
  const canvas = page.locator('[data-testid="pdf-page-canvas"]');
  await commandBar.getByRole("button", { name: "Text box", exact: true }).click();
  await clickCanvasAt(page, canvas, 0.25, 0.25);
  await page.getByLabel("Text box content").fill("ROTCHECK");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  const saved = await savePdf(page);
  const pdf = await PDFDocument.load(saved);
  expect(pdf.getPage(0).getRotation().angle).toBe(90);
  expect(await readDecodedPageContent(saved, 0)).toContain(encodeTextAsHex("ROTCHECK"));

  // Re-open the saved file: the baked text must render where it was placed
  // (near the click point), not mirrored to another corner by a bad mapping.
  await openPdf(page, "rotated-edit-reopened.pdf", saved);
  await expect
    .poll(() => canvasRegionInkPixels(page, 0.2, 0.2, 0.6, 0.38))
    .toBeGreaterThan(0);
  expect(await canvasRegionInkPixels(page, 0.62, 0.55, 0.98, 0.98)).toBe(0);
});

test("rapid double-clicks cannot double-place or double-save", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "double-click.pdf", await createPdf([300]));

  const commandBar = page.locator(".command-bar");
  const canvas = page.locator('[data-testid="pdf-page-canvas"]');
  await commandBar.getByRole("button", { name: "Text box", exact: true }).click();

  // Two rapid clicks at the same spot must produce exactly one draft box.
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error("Canvas bounding box unavailable.");
  }

  await page.mouse.dblclick(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await expect(page.getByLabel("Text box content")).toHaveCount(1);
  await page.getByLabel("Text box content").fill("ONCE");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  // Two rapid Save clicks must apply the pending edits exactly once and
  // produce exactly one download.
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
  });
  const download = await downloadPromise;
  const path = await download.path();

  if (!path) {
    throw new Error("Saved PDF download did not produce a local file.");
  }

  const saved = new Uint8Array(await readFile(path));
  const content = await readDecodedPageContent(saved, 0);
  expect(countOccurrences(content, encodeTextAsHex("ONCE"))).toBe(1);

  // Give a second (erroneous) download a moment to appear, then confirm
  // there was only ever one.
  await page.waitForTimeout(500);
  expect(downloadCount).toBe(1);
});

async function openPdf(page: Page, fileName: string, bytes: Uint8Array): Promise<void> {
  await page.getByLabel("Open PDF file").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });

  await expect(page.getByRole("button", { name: "Page 1" })).toBeVisible();
  await expect(page.locator('[data-testid="pdf-page-canvas"]')).toBeVisible();
}

async function readFixture(fileName: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./fixtures/${fileName}`, import.meta.url)));
}

async function mainCanvasStats(page: Page): Promise<{
  widthReady: boolean;
  heightReady: boolean;
  hasTextPixels: boolean;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="pdf-page-canvas"]');

    if (!(canvas instanceof HTMLCanvasElement)) {
      return { widthReady: false, heightReady: false, hasTextPixels: false };
    }

    const context = canvas.getContext("2d");
    const image = context?.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhitePixels = 0;

    if (image) {
      for (let index = 0; index < image.length; index += 4) {
        const alpha = image[index + 3] ?? 0;
        const red = image[index] ?? 255;
        const green = image[index + 1] ?? 255;
        const blue = image[index + 2] ?? 255;

        if (alpha !== 0 && (red < 245 || green < 245 || blue < 245)) {
          nonWhitePixels += 1;
        }
      }
    }

    return {
      widthReady: canvas.width > 0,
      heightReady: canvas.height > 0,
      hasTextPixels: nonWhitePixels > 0,
    };
  });
}

async function savePdf(page: Page): Promise<Uint8Array> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save" }).click();
  const download = await downloadPromise;
  const path = await download.path();

  if (!path) {
    throw new Error("Saved PDF download did not produce a local file.");
  }

  return new Uint8Array(await readFile(path));
}

async function searchResultCount(page: Page): Promise<number> {
  return page.locator(".command-bar__search-count").evaluate((element) => {
    const match = element.textContent?.match(/of\s+(\d+)/);
    return match ? Number(match[1]) : 0;
  });
}

async function createPdf(pageWidths: readonly number[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const width of pageWidths) {
    pdf.addPage([width, 300]);
  }

  return pdf.save();
}

async function createTextPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, {
    x: 24,
    y: 240,
    size: 12,
    font,
  });

  return pdf.save();
}

async function createMultiPageTextPdf(pageTexts: readonly string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  pageTexts.forEach((text, pageIndex) => {
    const page = pdf.addPage([612, 792]);
    page.drawText(text, {
      x: 72,
      y: 720,
      size: 14,
      font,
    });
    page.drawText(`Page ${pageIndex + 1} of ${pageTexts.length}`, {
      x: 72,
      y: 48,
      size: 10,
      font,
    });
  });

  return pdf.save();
}

async function createLandscapeTextPdf(pageTexts: readonly string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  pageTexts.forEach((text, pageIndex) => {
    const page = pdf.addPage([792, 612]);
    page.drawText(text, {
      x: 72,
      y: 520,
      size: 14,
      font,
    });
    page.drawText(`Page ${pageIndex + 1} of ${pageTexts.length}`, {
      x: 72,
      y: 48,
      size: 10,
      font,
    });
  });

  return pdf.save();
}

async function createPaddedPdf(bytes: Uint8Array, targetBytes: number): Promise<Uint8Array> {
  if (bytes.byteLength >= targetBytes) {
    return bytes;
  }

  return Buffer.concat([
    Buffer.from(bytes),
    Buffer.alloc(targetBytes - bytes.byteLength, 0x20),
  ]);
}

async function installOcrBridgeMock(
  page: Page,
  ocrBytes: Uint8Array,
  options: { engineStartDelayMs?: number; ocrDelayMs?: number } = {},
): Promise<void> {
  await page.addInitScript(({ ocrContents, engineStartDelayMs, ocrDelayMs }) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
      __RAIOPDF_TEST_OCR_CALL_COUNT__?: number;
    };
    testWindow.__RAIOPDF_TEST_OCR_CALL_COUNT__ = 0;

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, engineStartDelayMs);
      });

      return { port: 39393, token: "smoke-token" } as T;
    };

    testWindow.__RAIOPDF_TEST_ENGINE_FETCH__ = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith("/api/v1/analysis/basic-info")) {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/misc/ocr-pdf")) {
        testWindow.__RAIOPDF_TEST_OCR_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_OCR_CALL_COUNT__ ?? 0) + 1;
        await new Promise((resolve) => {
          window.setTimeout(resolve, ocrDelayMs);
        });

        return new Response(new Uint8Array(ocrContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, {
    ocrContents: [...ocrBytes],
    engineStartDelayMs: options.engineStartDelayMs ?? 120,
    ocrDelayMs: options.ocrDelayMs ?? 120,
  });
}

async function installRedactionBridgeMock(
  page: Page,
  redactedBytes: Uint8Array,
): Promise<void> {
  await page.addInitScript(({ redactedContents }) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
      __RAIOPDF_TEST_REDACTION_CALL_COUNT__?: number;
    };
    testWindow.__RAIOPDF_TEST_REDACTION_CALL_COUNT__ = 0;

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      return { port: 39393, token: "smoke-token" } as T;
    };

    testWindow.__RAIOPDF_TEST_ENGINE_FETCH__ = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith("/api/v1/analysis/basic-info")) {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/security/redact-execute")) {
        testWindow.__RAIOPDF_TEST_REDACTION_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_REDACTION_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(redactedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, {
    redactedContents: [...redactedBytes],
  });
}

async function installFilingBridgeMock(
  page: Page,
  convertedBytes: Uint8Array,
): Promise<void> {
  await page.addInitScript(({ convertedContents }) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
      __RAIOPDF_TEST_PDFA_CALL_COUNT__?: number;
      __RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__?: number;
    };
    testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ = 0;
    testWindow.__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ = 0;

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      return { port: 39393, token: "smoke-token" } as T;
    };

    testWindow.__RAIOPDF_TEST_ENGINE_FETCH__ = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith("/api/v1/analysis/basic-info")) {
        return new Response(JSON.stringify({ pageCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/convert/pdf/pdfa")) {
        testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(convertedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (url.endsWith("/api/v1/security/sanitize-pdf") || url.endsWith("/api/v1/misc/ocr-pdf")) {
        return new Response(new Uint8Array(convertedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, {
    convertedContents: [...convertedBytes],
  });
}

async function installFilingAndCompressBridgeMock(
  page: Page,
  options: {
    compressedBytes: Uint8Array;
    convertedBytes: Uint8Array;
  },
): Promise<void> {
  await page.addInitScript(({ compressedContents, convertedContents }) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
      __RAIOPDF_TEST_COMPRESS_CALL_COUNT__?: number;
      __RAIOPDF_TEST_PDFA_CALL_COUNT__?: number;
      __RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__?: number;
    };
    testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ = 0;
    testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ = 0;
    testWindow.__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ = 0;

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      return { port: 39393, token: "smoke-token" } as T;
    };

    testWindow.__RAIOPDF_TEST_ENGINE_FETCH__ = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith("/api/v1/analysis/basic-info")) {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/misc/compress-pdf")) {
        testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(compressedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (url.endsWith("/api/v1/convert/pdf/pdfa")) {
        testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(convertedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (url.endsWith("/api/v1/security/sanitize-pdf") || url.endsWith("/api/v1/misc/ocr-pdf")) {
        return new Response(new Uint8Array(convertedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, {
    compressedContents: [...options.compressedBytes],
    convertedContents: [...options.convertedBytes],
  });
}

async function installCompressBridgeMock(
  page: Page,
  compressedBytes: Uint8Array,
): Promise<void> {
  await page.addInitScript(({ compressedContents }) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
      __RAIOPDF_TEST_COMPRESS_CALL_COUNT__?: number;
    };
    testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ = 0;

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      return { port: 39393, token: "smoke-token" } as T;
    };

    testWindow.__RAIOPDF_TEST_ENGINE_FETCH__ = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.endsWith("/api/v1/analysis/basic-info")) {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/misc/compress-pdf")) {
        testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(compressedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, {
    compressedContents: [...compressedBytes],
  });
}

async function getOcrCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_OCR_CALL_COUNT__?: number;
    }).__RAIOPDF_TEST_OCR_CALL_COUNT__ ?? 0;
  });
}

async function getRedactionCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_REDACTION_CALL_COUNT__?: number;
    }).__RAIOPDF_TEST_REDACTION_CALL_COUNT__ ?? 0;
  });
}

async function getPdfACallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_PDFA_CALL_COUNT__?: number;
    }).__RAIOPDF_TEST_PDFA_CALL_COUNT__ ?? 0;
  });
}

async function getCompressCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_COMPRESS_CALL_COUNT__?: number;
    }).__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ ?? 0;
  });
}

async function getFilingPreflightRuns(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__?: number;
    }).__RAIOPDF_TEST_FILING_PREFLIGHT_RUNS__ ?? 0;
  });
}

async function clickCanvasAt(
  page: Page,
  canvas: ReturnType<Page["locator"]>,
  xFraction: number,
  yFraction: number,
): Promise<void> {
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error("Canvas bounding box unavailable.");
  }

  await page.mouse.click(box.x + box.width * xFraction, box.y + box.height * yFraction);
}

async function dragOnCanvas(
  page: Page,
  canvas: ReturnType<Page["locator"]>,
  x0Fraction: number,
  y0Fraction: number,
  x1Fraction: number,
  y1Fraction: number,
): Promise<void> {
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error("Canvas bounding box unavailable.");
  }

  await page.mouse.move(box.x + box.width * x0Fraction, box.y + box.height * y0Fraction);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1Fraction, box.y + box.height * y1Fraction, {
    steps: 6,
  });
  await page.mouse.up();
}

async function canvasRegionInkPixels(
  page: Page,
  x0Fraction: number,
  y0Fraction: number,
  x1Fraction: number,
  y1Fraction: number,
): Promise<number> {
  return page.evaluate(
    ([x0f, y0f, x1f, y1f]) => {
      const canvas = document.querySelector('[data-testid="pdf-page-canvas"]');

      if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) {
        return -1;
      }

      const context = canvas.getContext("2d");

      if (!context) {
        return -1;
      }

      const x = Math.floor(canvas.width * (x0f ?? 0));
      const y = Math.floor(canvas.height * (y0f ?? 0));
      const width = Math.max(1, Math.floor(canvas.width * ((x1f ?? 0) - (x0f ?? 0))));
      const height = Math.max(1, Math.floor(canvas.height * ((y1f ?? 0) - (y0f ?? 0))));
      const image = context.getImageData(x, y, width, height).data;
      let inkPixels = 0;

      for (let index = 0; index < image.length; index += 4) {
        const alpha = image[index + 3] ?? 0;
        const red = image[index] ?? 255;
        const green = image[index + 1] ?? 255;
        const blue = image[index + 2] ?? 255;

        if (alpha !== 0 && (red < 200 || green < 200 || blue < 200)) {
          inkPixels += 1;
        }
      }

      return inkPixels;
    },
    [x0Fraction, y0Fraction, x1Fraction, y1Fraction],
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

async function expectTextAnnotation(
  bytes: Uint8Array,
  pageIndex: number,
  contents: string,
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const annotations = pdf
    .getPage(pageIndex)
    .node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  expect(annotations, "expected the page to carry an /Annots array").toBeTruthy();

  const found = annotations!
    .asArray()
    .map((entry) => (entry instanceof PDFRef ? pdf.context.lookup(entry, PDFDict) : entry))
    .filter((entry): entry is PDFDict => entry instanceof PDFDict)
    .some((dict) => {
      const subtype = dict.get(PDFName.of("Subtype"));
      const text = dict.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString);

      return subtype === PDFName.of("Text") && text?.decodeText() === contents;
    });

  expect(found, `expected a /Text annotation with contents "${contents}"`).toBe(true);
}

async function expectPdf(
  bytes: Uint8Array,
  expected: { widths: readonly number[]; rotations: readonly number[] },
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages();

  expect(pages.map((pdfPage) => pdfPage.getWidth())).toEqual(expected.widths);
  expect(pages.map((pdfPage) => pdfPage.getRotation().angle)).toEqual(expected.rotations);
}

async function expectPageContentToContainLabel(
  bytes: Uint8Array,
  pageIndex: number,
  label: string,
): Promise<void> {
  expect(await readDecodedPageContent(bytes, pageIndex)).toContain(encodeTextAsHex(label));
}

async function readDecodedPageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

  return contentObjects
    .map((object) => (object instanceof PDFStream ? object : pdf.context.lookup(object)))
    .filter((object): object is PDFStream => object instanceof PDFStream)
    .map((stream) => decodePdfStream(stream))
    .join("\n");
}

function decodePdfStream(stream: PDFStream): string {
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }

  return new TextDecoder().decode(stream.getContents());
}

function encodeTextAsHex(text: string): string {
  return `<${[...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("")}>`;
}

function onePixelPng(): Uint8Array {
  return new Uint8Array(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ));
}

async function expectOutlineEntries(
  bytes: Uint8Array,
  expectedEntries: ReadonlyArray<{ title: string; pageIndex: number }>,
): Promise<void> {
  const pdf = await PDFDocument.load(bytes);
  const outlinesObject = pdf.catalog.get(PDFName.of("Outlines"));
  const outlines = outlinesObject instanceof PDFRef
    ? pdf.context.lookup(outlinesObject, PDFDict)
    : outlinesObject;

  if (!(outlines instanceof PDFDict)) {
    throw new Error("Expected PDF outlines dictionary.");
  }

  expect(outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBe(expectedEntries.length);
  expect(readOutlineEntries(pdf, outlines)).toEqual(expectedEntries);
}

function readOutlineEntries(
  pdf: PDFDocument,
  outlines: PDFDict,
): Array<{ title: string; pageIndex: number }> {
  const entries: Array<{ title: string; pageIndex: number }> = [];
  let itemRef = outlines.get(PDFName.of("First"));

  while (itemRef) {
    if (!(itemRef instanceof PDFRef)) {
      throw new Error("Expected PDF outline item reference.");
    }

    const item = pdf.context.lookup(itemRef, PDFDict);
    const title = item.lookup(PDFName.of("Title"), PDFString, PDFHexString).decodeText();
    const dest = item.lookup(PDFName.of("Dest"), PDFArray);
    const destPageRef = dest.get(0);

    if (!(destPageRef instanceof PDFRef)) {
      throw new Error("Expected PDF outline destination page reference.");
    }

    const pageIndex = pdf.getPages().findIndex((pdfPage) => {
      return pdfPage.ref.toString() === destPageRef.toString();
    });

    entries.push({ title, pageIndex });
    itemRef = item.get(PDFName.of("Next"));
  }

  return entries;
}
