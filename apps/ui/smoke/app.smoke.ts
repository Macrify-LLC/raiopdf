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

test("keeps command-bar icons inside explicitly sized buttons", async ({ page }) => {
  await page.goto("/");

  const buttons = page.locator(".command-bar .icon-button");
  await expect(buttons).toHaveCount(9);

  for (const button of await buttons.all()) {
    const geometry = await button.evaluate((element) => {
      const buttonRect = element.getBoundingClientRect();
      const slotRect = element.querySelector(".icon-button__icon")?.getBoundingClientRect();
      const iconRect = element.querySelector(".rp-icon")?.getBoundingClientRect();

      return {
        button: { left: buttonRect.left, right: buttonRect.right, width: buttonRect.width },
        slot: slotRect
          ? { left: slotRect.left, right: slotRect.right, width: slotRect.width }
          : null,
        icon: iconRect ? { left: iconRect.left, right: iconRect.right } : null,
      };
    });

    expect(geometry.button.width).toBe(30);
    expect(geometry.slot?.width).toBe(28);
    expect(geometry.slot?.left).toBeGreaterThanOrEqual(geometry.button.left);
    expect(geometry.slot?.right).toBeLessThanOrEqual(geometry.button.right);
    expect(geometry.icon?.left).toBeGreaterThan(geometry.button.left);
    expect(geometry.icon?.right).toBeLessThan(geometry.button.right);
  }
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
    // Scope to the tool panel: "Prepare for Filing" also names the
    // command-bar CTA, which stays mounted (disabled) with no document.
    await page
      .locator(".tool-panel")
      .getByRole("button", { name: legalTool.name, exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: legalTool.name });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(legalTool.emptyState)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("settings offers every jurisdiction pack in an enabled default-jurisdiction select", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("menuitem", { name: "File" }).click();
  await page.getByRole("menuitem", { name: "Settings..." }).click();

  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(settingsDialog).toBeVisible();

  const jurisdictionSelect = settingsDialog.getByRole("combobox", { name: "Default jurisdiction" });
  await expect(jurisdictionSelect).toBeEnabled();
  await expect(jurisdictionSelect.locator("option")).toHaveCount(5);
  await expect(jurisdictionSelect).toHaveValue("florida");
});

test("package-root inputs pair a Browse button, gated outside the desktop app", async ({ page }) => {
  await page.goto("/");

  const browseGateTitle = "Browsing for a folder only works in the installed RaioPDF app.";

  for (const legalTool of ["Batch Cleanup", "Production Set"]) {
    await page
      .locator(".tool-panel")
      .getByRole("button", { name: legalTool, exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: legalTool });
    await expect(dialog).toBeVisible();

    const browse = dialog.getByRole("button", { name: "Browse…" });
    await expect(browse).toBeVisible();
    // The browser runtime has no directory picker — the affordance stays
    // visible but disabled, with the reason on hover.
    await expect(browse).toBeDisabled();
    await expect(browse).toHaveAttribute("title", browseGateTitle);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  // Prepare for Filing keeps its package-root input on the Filing packet tab.
  // Scope to the tool panel: the command-bar CTA shares this name.
  await page
    .locator(".tool-panel")
    .getByRole("button", { name: "Prepare for Filing", exact: true })
    .click();
  const filingDialog = page.getByRole("dialog", { name: "Prepare for Filing" });
  await expect(filingDialog).toBeVisible();
  await filingDialog.getByRole("tab", { name: "Filing packet" }).click();

  const filingBrowse = filingDialog.getByRole("button", { name: "Browse…" });
  await expect(filingBrowse).toBeVisible();
  await expect(filingBrowse).toBeDisabled();
  await expect(filingBrowse).toHaveAttribute("title", browseGateTitle);
});

test("opens, rotates, deletes, reorders, and saves a PDF round trip", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "round-trip.pdf", await createPdf([200, 210, 220, 230]));

  await page.getByRole("button", { name: "Rotate selected pages" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Page 2" }).click();
  await page.getByRole("button", { name: "Delete selected pages" }).click();
  await page.getByRole("button", { name: "Delete Page", exact: true }).click();
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
  await expect(mainCanvas(page)).toBeVisible();
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
  const canvas = mainCanvas(page);
  const bounds = await canvas.boundingBox();

  if (!bounds) {
    throw new Error("Rendered canvas did not produce a bounding box.");
  }

  await clickCanvasAt(page, canvas, 0.5, 0.5);
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
  await expect(mainCanvas(page)).toBeVisible();
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
  await expectCommandBarPage(page, 2, 7);
  // Continuous scroll keeps neighboring pages mounted, so highlights on
  // adjacent pages can coexist — exactly one is ever the ACTIVE hit.
  await expect(
    page.locator('[data-testid="search-highlight"][data-active="true"]'),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Next search result" }).click();
  await expect(page.locator(".command-bar__search-count")).toHaveText(/2 of [1-9]\d*/);
  await expectCommandBarPage(page, 3, 7);

  await page.getByRole("button", { name: "Previous search result" }).click();
  await expect(page.locator(".command-bar__search-count")).toHaveText(/1 of [1-9]\d*/);
  await expectCommandBarPage(page, 2, 7);

  await searchInput.press("Enter");
  await expect(page.locator(".command-bar__search-count")).toHaveText(/2 of [1-9]\d*/);
  await expectCommandBarPage(page, 3, 7);

  await searchInput.press("Shift+Enter");
  await expect(page.locator(".command-bar__search-count")).toHaveText(/1 of [1-9]\d*/);
  await expectCommandBarPage(page, 2, 7);

  await searchInput.press("Escape");
  await expect(searchInput).toHaveValue("");
  await expect(page.locator(".command-bar__search-count")).toHaveCount(0);
});

test("queues rapid rotate and delete clicks without losing the delete", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "rapid-fire.pdf", await createPdf([200, 210, 220]));

  const rotate = page.getByRole("button", { name: "Rotate selected pages" });
  const deleteSelected = page.getByRole("button", { name: "Delete selected pages" });

  const firstRotate = rotate.click();
  const secondRotate = rotate.click();
  const deleteClick = deleteSelected.click();
  await Promise.all([firstRotate, secondRotate, deleteClick]);
  await page.getByRole("button", { name: "Delete Page", exact: true }).click();

  await expectCommandBarPage(page, 1, 2);
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

  await expect(page.getByText("All 1 page will be processed.")).toBeVisible();
  await expect(makeSearchable).toBeDisabled();
  await page.getByRole("button", { name: "Make searchable", exact: true }).click();

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
  await page.getByRole("button", { name: "Make searchable", exact: true }).click();

  const errorDialog = page.getByRole("dialog", { name: "Make Searchable" });
  const errorMessage = "OCR ran, but 1 page still has no searchable text — the original was kept unchanged; the underlying scan is likely too low-quality to read.";
  await expect(errorDialog.getByText(errorMessage)).toBeVisible();
  await expect(page.locator(".tool-panel").getByText(errorMessage)).toHaveCount(0);
  await expect(page.getByLabel("Unsaved changes")).toBeHidden();
  await errorDialog.getByRole("button", { name: "Cancel" }).click();

  const saved = await savePdf(page);
  expect(Buffer.from(saved).equals(Buffer.from(sourcePdf))).toBe(true);
});

test("status-bar image-only chip opens the Make Searchable confirm flow", async ({ page }) => {
  await installOcrBridgeMock(page, await createTextPdf("Verified OCR text"));
  await page.goto("/");
  await openPdf(page, "scan.pdf", await createPdf([200]));

  // UX-12: the chip that names the fix IS the fix — a button, like the
  // garbled chip, not an inert label.
  const chip = page.getByRole("contentinfo").getByRole("button", {
    name: "No searchable text — run Make Searchable",
  });
  await expect(chip).toBeVisible();
  await chip.click();

  await expect(page.getByText("All 1 page will be processed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make searchable", exact: true })).toBeVisible();
});

test("mutating the document mid-OCR discards the stale OCR result", async ({ page }) => {
  const sourcePdf = await createPdf([200]);
  const searchablePdf = await createTextPdf("Verified OCR text");
  await installOcrBridgeMock(page, searchablePdf, {
    engineStartDelayMs: 20,
    ocrDelayMs: 350,
  });
  await page.goto("/");
  await openPdf(page, "scan.pdf", sourcePdf);

  await page.getByRole("button", { name: "Make Searchable (OCR)", exact: true }).click();
  await page.getByRole("button", { name: "Make searchable", exact: true }).click();
  await expect(page.getByText("Making searchable…")).toBeVisible();

  // The run is docked and non-modal now; the document can still be mutated
  // while OCR works. The late OCR result must be discarded.
  await page.getByRole("button", { name: "Rotate selected pages" }).click();

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

  await expectCommandBarPage(page, 1, 2);
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

test("sensitive info scanner finds and masks a planted SSN", async ({ page }) => {
  await page.goto("/");
  await openPdf(
    page,
    "scanner-fixture.pdf",
    await createTextPdf("Client SSN 123-45-6789 Account 987654321"),
  );

  await page.getByRole("button", { name: "Sensitive Info Scanner", exact: true }).click();
  await page.getByRole("button", { name: "Scan Document" }).click();

  await expect(page.getByText("•••-••-6789")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark for redaction" }).first()).toBeVisible();
});

test("sensitive info scanner refuses to report clean on a document with no readable text", async ({ page }) => {
  await installOcrBridgeMock(page, await createTextPdf("Verified OCR text"));
  await page.goto("/");
  await openPdf(page, "image-only-scan.pdf", await createPdf([200]));

  await page.getByRole("button", { name: "Sensitive Info Scanner", exact: true }).click();
  await page.getByRole("button", { name: "Scan Document" }).click();

  // UX-4: an image-only document must never read as "no patterns found" —
  // the scanner says the text couldn't be read and offers OCR instead.
  await expect(
    page.getByText("This document has no readable text to scan — it looks like a scanned image. Run Make Searchable (OCR) first, then scan again."),
  ).toBeVisible();
  await expect(page.getByText("No obvious sensitive patterns found. Review remains yours.")).toHaveCount(0);

  // The affordance is live: it opens the standard Make Searchable confirm flow.
  await page.getByRole("button", { name: "Make Searchable (OCR)…", exact: true }).click();
  await expect(page.getByText("All 1 page will be processed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make searchable", exact: true })).toBeVisible();
});

test("scanner Mark all queues every hit for redaction in one click", async ({ page }) => {
  await page.goto("/");
  await openPdf(
    page,
    "scanner-mark-all.pdf",
    // Two hyphenated SSNs on a letter-size page (the narrow createTextPdf
    // canvas runs the second SSN off the page edge and loses its hit area),
    // so Mark all has more than one hit to queue.
    await createMultiPageTextPdf(["SSN 123-45-6789 and SSN 987-65-4321"]),
  );

  await page.getByRole("button", { name: "Sensitive Info Scanner", exact: true }).click();
  await page.getByRole("button", { name: "Scan Document" }).click();

  const markAll = page.getByRole("button", { name: /Mark all \(\d+\) for redaction/ });
  await expect(markAll).toBeVisible();
  const markAllLabel = await markAll.textContent();
  const hitCount = Number(/\((\d+)\)/.exec(markAllLabel ?? "")?.[1] ?? "0");
  expect(hitCount).toBeGreaterThan(1);

  await markAll.click();

  // Marking switches to redaction mode with every hit queued as an area.
  await expect(
    page.getByText(`Redaction mode — ${hitCount} areas marked`),
  ).toBeVisible();

  // Back on the scanner panel, the hits reflect their queued state.
  await page.getByRole("button", { name: "Sensitive Info Scanner", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark all (0) for redaction" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Marked for redaction" }).first()).toBeDisabled();
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
  const confirmation = page.getByRole("dialog", { name: "Apply Redactions" });
  await expect(confirmation.getByText("Permanently remove content under 1 marked area?")).toBeVisible();
  await expect(page.locator(".tool-panel").getByText("Permanently remove content")).toHaveCount(0);
  await confirmation.getByRole("button", { name: "Apply Redactions", exact: true }).click();

  await expect(page.getByText("Redacted and verified: hidden text confirmed removed; redacted page images replaced; annotations cleaned; metadata scrubbed.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect.poll(() => getRedactionCallCount(page)).toBe(1);
});

test("highlight-to-redact merges a real multi-span browser selection into one area", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "select-redaction.pdf", await createFragmentedTextPdf());

  const textLayer = page.locator(".page-view__text-layer").first();
  await expect.poll(() => textLayer.locator("span").count()).toBeGreaterThanOrEqual(3);

  await page.getByRole("button", { name: "Redact", exact: true }).click();
  const redactionToolbar = page.getByRole("toolbar", { name: "Redaction mode" });
  await redactionToolbar.getByRole("button", { name: "Select text" }).click();
  await expect(
    redactionToolbar.getByRole("button", { name: "Select text" }),
  ).toHaveAttribute("aria-pressed", "true");

  const rawRects = await textLayer.evaluate((layer) => {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const textNodes: Node[] = [];
    let node = walker.nextNode();

    while (node) {
      if (node.textContent?.trim()) {
        textNodes.push(node);
      }
      node = walker.nextNode();
    }
    const first = textNodes[0];
    const last = textNodes.at(-1);

    if (!first || !last) {
      throw new Error("The PDF text layer did not expose selectable text nodes.");
    }

    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return Array.from(range.getClientRects(), ({ left, top, width, height }) => ({
      left,
      top,
      width,
      height,
    }));
  });

  // A real multi-span selection reports several client rects; the merge logic
  // must collapse them into a single redaction area.
  expect(rawRects.length).toBeGreaterThan(1);

  // Re-dispatch until the synthetic browser selection is captured. The live
  // selection persists until a successful capture clears it, so retries are
  // idempotent and cannot double-mark the page.
  const overlay = page.locator(".page-view__redaction-overlay");
  await expect(async () => {
    if ((await overlay.count()) === 0) {
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      });
    }
    expect(await overlay.count(), `selection rects: ${JSON.stringify(rawRects)}`).toBe(1);
  }).toPass({ timeout: 15_000 });

  await expect(page.getByText("Redaction mode — 1 area marked")).toBeVisible();

  // Leaving through another legal tool (not the mode bar's Exit button)
  // must still restore Draw box for the next redaction session.
  await page.getByRole("button", { name: "Bates Numbering", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Bates Numbering" })).toBeVisible();
  await page.getByRole("button", { name: "Close Bates Numbering" }).click();
  await page.getByRole("button", { name: "Redact", exact: true }).click();
  await expect(
    page.getByRole("toolbar", { name: "Redaction mode" })
      .getByRole("button", { name: "Draw box" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("selection dragged into inter-paragraph whitespace does not run into the next paragraph", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "dcm-order.pdf", await readFixture("dcm-order.pdf"));

  const textLayer = page.locator(".page-view__text-layer").first();
  await expect.poll(() => textLayer.locator("span").count()).toBeGreaterThan(10);
  // The whitespace guard's sentinel lands when the text layer finishes
  // rendering; the drags below rely on it.
  await expect(textLayer.locator(".page-view__text-end")).toHaveCount(1);

  const toolPanel = page.locator(".tool-panel");
  await toolPanel.getByRole("button", { name: "Edit", exact: true }).click();
  await selectMarkupTool(page, "Select");

  // Find the widest whitespace band between consecutive text lines, then
  // drag from the line above it down into the band. Before the endOfContent
  // sentinel guard, the browser snapped the selection focus to the nearest
  // text below the cursor and the highlight ran to the bottom of the next
  // paragraph; with the guard, the selection stops at the swept text.
  //
  // Retried as a whole: an early drag can race the page's layout (the tool
  // panel expanding shifts the canvas), so the geometry is re-measured each
  // attempt. The start point is jittered per attempt and the selection
  // cleared, so a retry cannot escalate into a double/triple-click.
  let attempt = 0;

  await expect(async () => {
    attempt += 1;
    const gap = await textLayer.evaluate((layer) => {
      const spans = [...layer.querySelectorAll("span")]
        .filter((span) => span.textContent && span.textContent.trim().length > 0)
        .map((span) => {
          const rect = span.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            text: span.textContent ?? "",
          };
        })
        .filter((rect) => rect.bottom > rect.top)
        .sort((a, b) => a.top - b.top);
      let best: { above: (typeof spans)[0]; below: (typeof spans)[0]; size: number } | null = null;

      for (let i = 0; i < spans.length - 1; i++) {
        const above = spans[i]!;

        // Spans are sorted by top, so the first hit is the nearest line below.
        for (let j = i + 1; j < spans.length; j++) {
          const below = spans[j]!;

          if (below.top <= above.bottom + 2) {
            continue;
          }
          const size = below.top - above.bottom;

          if (!best || size > best.size) {
            best = { above, below, size };
          }
          break;
        }
      }
      return best;
    });

    if (!gap) {
      throw new Error("The fixture's text layer exposed no inter-paragraph gap.");
    }

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const startX = gap.above.left + (gap.above.right - gap.above.left) * (0.5 + 0.05 * (attempt % 5));
    const startY = (gap.above.top + gap.above.bottom) / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(
      Math.max(gap.below.left + 5, gap.above.left + 5),
      gap.above.bottom + gap.size * 0.55,
      { steps: 8 },
    );
    await page.mouse.up();
    const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? "");

    expect(selectedText.length).toBeGreaterThan(0);
    expect(selectedText).not.toContain(gap.below.text.slice(0, 12));

    // The module paints the selection itself (native ::selection is
    // transparent in the text layer): a live selection must have produced
    // merged per-line paint boxes in the overlay.
    expect(
      await page.locator(".page-view__selection-paint > div").count(),
    ).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
});

test("switching from Select to a markup tool converts the selection; other tools clear it", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "dcm-order.pdf", await readFixture("dcm-order.pdf"));

  const textLayer = page.locator(".page-view__text-layer").first();
  await expect(textLayer.locator(".page-view__text-end")).toHaveCount(1);

  const toolPanel = page.locator(".tool-panel");
  await toolPanel.getByRole("button", { name: "Annotate", exact: true }).click();
  await selectMarkupTool(page, "Select");

  // Deterministic single-line target, anchored by content: position-based
  // finders can grab the multi-line caption block depending on scroll state,
  // which turns the converted markup into a different rect count per run.
  const selectBodyText = async () => {
    let attempt = 0;

    await expect(async () => {
      attempt += 1;
      const line = await textLayer.evaluate((layer, jitter) => {
        const span = [...layer.querySelectorAll("span")].find((s) =>
          s.textContent?.includes("comes before the Court"),
        );
        if (!span) {
          return null;
        }
        const r = span.getBoundingClientRect();
        return { left: r.left + 6 + jitter, right: r.right, y: r.top + r.height / 2 };
      }, (attempt % 5) * 9);

      if (!line) {
        throw new Error("body line not found");
      }
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.mouse.move(line.left, line.y);
      await page.mouse.down();
      await page.mouse.move(line.left + (line.right - line.left) * 0.6, line.y, { steps: 6 });
      await page.mouse.up();
      const text = await page.evaluate(() => window.getSelection()?.toString() ?? "");

      expect(text.length).toBeGreaterThan(5);
    }).toPass({ timeout: 15_000 });
  };

  // Select text, switch to Highlight: the selection becomes highlight
  // markup and the browser selection clears.
  await selectBodyText();
  await selectMarkupTool(page, "Highlight");
  await expect(page.locator(".edit-layer__highlight").first()).toBeVisible();
  const highlightCount = await page.locator(".edit-layer__highlight").count();
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);

  // Select text, switch to a non-markup tool: the selection clears without
  // creating any further markup.
  await selectMarkupTool(page, "Select");
  await selectBodyText();
  await selectMarkupTool(page, "Rectangle");
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);
  await expect(page.locator(".edit-layer__highlight")).toHaveCount(highlightCount);

  // The side panel's Edit rows are a second tool-switch entry point and must
  // preserve the selection the same way the floating toolbar does.
  await selectMarkupTool(page, "Select");
  await selectBodyText();
  await toolPanel.getByRole("button", { name: "Underline", exact: true }).click();
  await expect(page.locator(".edit-layer__text-markup-lines").first()).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);
});

test("right-click Replace text... enters Edit Text with the selection primed", async ({ page }) => {
  // The bridge mock only unlocks the engine gate; priming itself is pure UI.
  await installTextEditBridgeMock(page, await createTextPdf("unused"));
  await page.goto("/");
  await openPdf(page, "dcm-order.pdf", await readFixture("dcm-order.pdf"));

  const textLayer = page.locator(".page-view__text-layer").first();
  await expect(textLayer.locator(".page-view__text-end")).toHaveCount(1);

  // Deterministic single-line selection, anchored by content (same approach
  // as the markup-conversion smoke above).
  let midpoint = { x: 0, y: 0 };
  let attempt = 0;
  await expect(async () => {
    attempt += 1;
    const line = await textLayer.evaluate((layer, jitter) => {
      const span = [...layer.querySelectorAll("span")].find((s) =>
        s.textContent?.includes("comes before the Court"),
      );
      if (!span) {
        return null;
      }
      const r = span.getBoundingClientRect();
      return { left: r.left + 6 + jitter, right: r.right, y: r.top + r.height / 2 };
    }, (attempt % 5) * 9);

    if (!line) {
      throw new Error("body line not found");
    }
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(line.left, line.y);
    await page.mouse.down();
    const endX = line.left + (line.right - line.left) * 0.6;
    await page.mouse.move(endX, line.y, { steps: 6 });
    await page.mouse.up();
    const text = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(text.length).toBeGreaterThan(5);
    midpoint = { x: (line.left + endX) / 2, y: line.y };
  }).toPass({ timeout: 15_000 });

  await page.mouse.click(midpoint.x, midpoint.y, { button: "right" });

  const replaceItem = page.getByRole("menuitem", { name: "Replace text..." });
  await expect(replaceItem).toBeVisible();
  await expect(replaceItem).toBeEnabled();
  await replaceItem.click();

  // The Edit Text mode bar opens with the selection captured and the
  // Replace-with field focused, ready to type.
  await expect(page.getByRole("toolbar", { name: "Edit document text" })).toBeVisible();
  await expect(page.getByText("Selection captured")).toBeVisible();
  await expect(page.getByLabel("Replace with")).toBeFocused();
});

test("edit document text stages, reviews, applies, and saves as a changed copy", async ({ page }) => {
  const sourcePdf = await createTextPdf("Plaintiff files the motion.");
  const editedPdf = await createTextPdf("Petitioner files the motion.");
  await installTextEditBridgeMock(page, editedPdf);
  await page.goto("/");
  await openPdf(page, "edit-text.pdf", sourcePdf);

  await openEditToolPanel(page);
  await page.getByRole("button", { name: "Edit Text", exact: true }).click();
  await expect(page.getByText("Replacements never reflow the page", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Search document")).toBeDisabled();

  await page.getByLabel("Find text").fill("Plaintiff");
  await page.getByLabel("Replace with").fill("Petitioner");
  await page.getByRole("button", { name: "Replace all" }).click();
  await page.getByRole("button", { name: "Review" }).click();

  const reviewDialog = page.getByRole("dialog", { name: "Review text replacements" });
  await expect(reviewDialog.getByText("The whole document is rewritten by this operation. Pages not shown here may shift slightly.")).toBeVisible();
  await expect(reviewDialog.getByText("1 estimated replacement on 1 page.")).toBeVisible();
  await expect(reviewDialog.getByText("The engine does not return replacement counts", { exact: false })).toBeVisible();
  await reviewDialog.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect.poll(() => getTextEditCallCount(page)).toBe(1);

  const saved = await savePdf(page);
  await expectPageContentToContainLabel(saved, 0, "Petitioner files the motion.");
});

test("edit document text cancel and zero-change review leave bytes untouched", async ({ page }) => {
  const sourcePdf = await createTextPdf("No replacement happens.");
  await installTextEditBridgeMock(page, sourcePdf);
  await page.goto("/");
  await openPdf(page, "edit-text-zero.pdf", sourcePdf);

  await openEditToolPanel(page);
  await page.getByRole("button", { name: "Edit Text", exact: true }).click();
  await page.getByLabel("Find text").fill("Missing");
  await page.getByLabel("Replace with").fill("Present");
  await page.getByRole("button", { name: "Replace all" }).click();
  await page.getByRole("button", { name: "Review" }).click();

  const reviewDialog = page.getByRole("dialog", { name: "Review text replacements" });
  await expect(reviewDialog.getByText("Nothing was replaced — the document was not modified.")).toBeVisible();
  await expect(reviewDialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await reviewDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeHidden();

  const saved = await savePdf(page);
  expect(Buffer.from(saved).equals(Buffer.from(sourcePdf))).toBe(true);
});

test("edit document text prompts for pending annotations and gates scanned documents", async ({ page }) => {
  await installTextEditBridgeMock(page, await createTextPdf("Prompt fixture."));
  await page.goto("/");
  await openPdf(page, "edit-text-prompt.pdf", await createTextPdf("Prompt fixture."));

  await openEditToolPanel(page);
  await selectMarkupTool(page, "Text box");
  await clickCanvasAt(page, mainCanvas(page), 0.3, 0.4);
  await page.getByLabel("Text box content").fill("Pending note");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit Text", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Pending annotations" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await openPdf(page, "image-only.pdf", await createPdf([200]));
  await openEditToolPanel(page);
  await page.getByRole("button", { name: "Edit Text", exact: true }).click();
  await expect(page.getByText("Text editing isn't available for scanned documents.")).toBeVisible();
});

test("Bates numbering gates Apply until a prefix is entered or no-prefix is chosen", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "bates.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Bates Numbering", exact: true }).click();
  await expect(mainCanvas(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Bates Numbering" })).toBeVisible();

  // UX-3: no sample "SMITH" default — the prefix starts empty (placeholder
  // only) and Apply stays disabled until the user names the matter.
  // (exact: the "No prefix (numbers only)" checkbox label also contains "prefix")
  const prefixInput = page.getByLabel("Prefix", { exact: true });
  await expect(prefixInput).toHaveValue("");
  await expect(prefixInput).toHaveAttribute("placeholder", "e.g. SMITH");
  await expect(page.getByRole("button", { name: "Apply Bates Numbers" })).toBeDisabled();

  await prefixInput.fill("CASE");
  await expect(page.getByRole("button", { name: "Apply Bates Numbers" })).toBeEnabled();
  await page.getByLabel("Start").fill("42");
  await page.getByLabel("Digits").fill("4");
  await expect(page.getByLabel("Bates preview")).toHaveText("CASE0042");

  // The explicit numbers-only opt-in also unlocks Apply and drops the prefix.
  await page.getByLabel("No prefix (numbers only)").check();
  await expect(prefixInput).toBeDisabled();
  await expect(page.getByLabel("Bates preview")).toHaveText("0042");
  await expect(page.getByRole("button", { name: "Apply Bates Numbers" })).toBeEnabled();

  await page.getByLabel("No prefix (numbers only)").uncheck();
  await expect(page.getByLabel("Bates preview")).toHaveText("CASE0042");
});

test("Bates numbering applies typed-prefix numbers into the saved page bytes", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "bates-apply.pdf", await createPdf([200, 210, 220]));

  await page.getByRole("button", { name: "Bates Numbering", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bates Numbering" });
  await expect(dialog).toBeVisible();

  // Type every format field explicitly — this test must not depend on any
  // default prefix (the default is moving from "SMITH" to a required,
  // empty-by-default field). `exact` keeps "Prefix" from substring-matching
  // that redesign's "No prefix (numbers only)" checkbox.
  await dialog.getByLabel("Prefix", { exact: true }).fill("CANARY");
  await dialog.getByLabel("Start", { exact: true }).fill("1");
  await dialog.getByLabel("Digits", { exact: true }).fill("6");
  await expect(dialog.getByLabel("Bates preview")).toHaveText("CANARY000001");

  await dialog.getByRole("button", { name: "Apply Bates Numbers" }).click();
  await expect(page.getByText("Bates numbers applied.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  // Stamping is client-side (pdf-lib), so per-PR CI can assert the actual
  // advertised outcome — sequential numbers stamped into each page's CONTENT
  // (not annotations) — instead of stopping at the preview string and leaving
  // stamping regressions for the release canary to catch.
  const saved = await savePdf(page);
  await expectPageContentToContainLabel(saved, 0, "CANARY000001");
  await expectPageContentToContainLabel(saved, 1, "CANARY000002");
  await expectPageContentToContainLabel(saved, 2, "CANARY000003");
});

test("fills an AcroForm text field and flatten-on-save carries the value into the page bytes", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "acroform.pdf", await createAcroFormPdf());

  // The form layer renders the real AcroForm field as a fillable input
  // labeled by its field name.
  const input = page.getByLabel("client_name");
  await expect(input).toBeVisible();
  await input.fill("Jane Q. Public");

  // Default save behavior flattens filled values permanently into the page:
  // no interactive field survives, and the typed value lives on as drawn page
  // content (an appearance stream flattened into the page's XObjects).
  const saved = await savePdf(page);
  const pdf = await PDFDocument.load(saved);
  expect(pdf.getForm().getFields()).toHaveLength(0);
  const streams = await readAllDecodedStreams(saved);
  expect(
    streams.includes(encodeTextAsHex("Jane Q. Public")) || streams.includes("(Jane Q. Public)"),
    "the flattened field value must be drawn into the saved bytes",
  ).toBe(true);
});

test("compresses through the mocked desktop engine from the inline Compress expansion", async ({ page }) => {
  const compressedPdf = await createPdf([180]);
  await installCompressBridgeMock(page, compressedPdf);
  await page.goto("/");
  await openPdf(page, "compress.pdf", await createPdf([200]));

  await page.getByRole("button", { name: "Organize", exact: true }).click();
  await page.getByRole("button", { name: "Compress...", exact: true }).click();
  // Item 18: Compress lives inline under its own ToolRow now, not a
  // FloatingDialog -- there is no dialog role to wait on.
  await expect(page.getByRole("button", { name: "Compress PDF" })).toBeVisible();
  await page.getByLabel("Quality").fill("6");
  await page.getByLabel("Grayscale").check();
  await page.getByRole("button", { name: "Compress PDF" }).click();

  await expect(page.getByText("Compression complete.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  await expect.poll(() => getCompressCallCount(page)).toBe(1);
  // Compress keeps its expansion open after success so the before/after
  // note stays visible, same as the floating dialog it replaced.
  await expect(page.getByRole("button", { name: "Compress PDF" })).toBeVisible();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [180],
    rotations: [0],
  });
});

test("page numbers apply as stamped bytes from the inline Page Numbers expansion", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "page-numbers.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Page Numbers...", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply Page Numbers" })).toBeVisible();
  await page.getByLabel("Format").selectOption("page-of-total");
  await page.getByRole("button", { name: "Apply Page Numbers" }).click();
  await expect(page.getByText("Page numbers applied.")).toBeVisible();

  const saved = await savePdf(page);
  expect(await readDecodedPageContent(saved, 0)).toContain(encodeTextAsHex("Page 1 of 2"));
  expect(await readDecodedPageContent(saved, 1)).toContain(encodeTextAsHex("Page 2 of 2"));
});

test("watermark applies from the inline Watermark expansion", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "watermark.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Watermark...", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply Watermark" })).toBeVisible();
  // Pre-existing quirk, unrelated to item 18 and left as-is: the default
  // Opacity value (0.18) doesn't line up with its own step="0.05", so a
  // browser's native constraint validation silently blocks submission
  // until the field is touched. Set a step-aligned value so this test
  // exercises the relocation, not that separate bug.
  await page.getByLabel("Opacity").fill("0.2");
  await page.getByRole("button", { name: "Apply Watermark" }).click();
  await expect(page.getByText("Watermark applied.")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
});

test("rotates the selected page through the inline Rotate expansion, then collapses on success", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "sidebar-rotate.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Organize", exact: true }).click();
  // Item 18: Rotate used to fire instantly from the row; it now expands
  // inline like every other tool, with explicit left/right actions.
  await page.getByRole("button", { name: "Rotate Pages", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rotate Right" })).toBeVisible();

  await page.getByRole("button", { name: "Rotate Right" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
  // A successful rotation collapses the expansion (there's no result to
  // review, unlike Compress/Page Numbers/Watermark).
  await expect(page.getByRole("button", { name: "Rotate Right" })).toBeHidden();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [200, 210],
    rotations: [90, 0],
  });
});

test("clicking an inline tool row again collapses its expansion", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "inline-toggle.pdf", await createPdf([200]));

  await page.getByRole("button", { name: "Organize", exact: true }).click();
  await page.getByRole("button", { name: "Compress...", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compress PDF" })).toBeVisible();

  await page.getByRole("button", { name: "Compress...", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compress PDF" })).toBeHidden();
});

test("inserts an image as a full PDF page", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "insert-image-pages.pdf", await createPdf([200, 210]));

  await page.getByRole("button", { name: "Organize", exact: true }).click();
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

  await page.getByRole("button", { name: "Organize", exact: true }).click();
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

  await page.getByRole("button", { name: "Annotate" }).click();
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

  await page.getByRole("button", { name: "Organize", exact: true }).click();
  await page.getByRole("button", { name: "Organize Pages", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Organize Pages" })).toBeVisible();

  await page.getByRole("button", { name: "Organize page 2" }).click();
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.getByRole("button", { name: "Organize page 4" }).click();
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");

  await page.getByRole("button", { name: "Extract", exact: true }).click();
  await expectCommandBarPage(page, 1, 2);
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

  await page.getByRole("button", { name: "Organize", exact: true }).click();
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
  // Enter through the command-bar CTA (renamed to match the tool's one name,
  // "Prepare for Filing") — same handler as the Legal sidebar row.
  await page
    .locator(".command-bar")
    .getByRole("button", { name: "Prepare for Filing", exact: true })
    .click();

  const filingDialog = page.getByRole("dialog", { name: "Prepare for Filing" });
  await expect(filingDialog).toBeVisible();
  const jurisdictionHeader = filingDialog.locator(".filing-card__jurisdiction");
  await expect(jurisdictionHeader.getByRole("combobox", { name: "Jurisdiction pack" })).toHaveValue("florida");
  await expect(page.getByText("State trial and appellate courts")).toBeVisible();
  await expect(page.getByText("These checks are guidance only")).toBeVisible();
  await expect(page.getByRole("button", { name: "View the rules applied" })).toBeVisible();

  // Item 6/7: the preflight report is now a collapsed "Prefiling check"
  // section -- expand it once; it stays open through the run below.
  await page.getByRole("button", { name: "Prefiling check", exact: true }).click();

  const lawRows = page.locator('.filing-row[data-kind="rule"]');
  const portalRows = page.locator('.filing-row[data-kind="portal"]');
  await expect(lawRows.filter({ hasText: "Letter portrait pages" })).toHaveAttribute("data-status", "warn");
  await expect(lawRows.locator(".filing-row__chip", { hasText: "warning" })).toHaveCount(0);
  await expect(portalRows.locator(".filing-row__chip", { hasText: "warning" })).toHaveCount(1);
  await expect(portalRows.filter({ hasText: "PDF/A preference" })).toHaveAttribute("data-status", "unknown");
  await expect(portalRows.filter({ hasText: "PDF/A preference" })).toContainText("compliance facts were not provided");

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

  await page.getByRole("button", { name: "Organize", exact: true }).click();
  await page.getByRole("button", { name: "Organize Pages", exact: true }).click();
  await expect(page.getByRole("list", { name: "Page grid" })).toBeVisible();

  await page.getByRole("button", { name: "Legal" }).click();
  await page
    .locator(".tool-panel")
    .getByRole("button", { name: "Prepare for Filing", exact: true })
    .click();

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
  await page
    .locator(".tool-panel")
    .getByRole("button", { name: "Prepare for Filing", exact: true })
    .click();

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
  await expect.poll(() => mainCanvasStats(page)).toMatchObject({
    widthReady: true,
    heightReady: true,
    hasTextPixels: true,
  });

  const canvas = mainCanvas(page);

  // Highlight: drag a band across the text line near the top of the page.
  // Retries in case the drag lands before the page's text layer resolves —
  // a miss adds nothing, so retrying cannot double-place.
  await selectMarkupTool(page, "Highlight");
  await waitForCanvasPointToHitTextLayer(page, canvas, 0.08, 0.06);
  await expect(async () => {
    if ((await page.locator(".edit-layer__highlight").count()) === 0) {
      await dragOnCanvas(page, canvas, 0.08, 0.06, 0.92, 0.13);
    }

    expect(await page.locator(".edit-layer__highlight").count()).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
  await expect(page.locator(".edit-layer__highlight").first()).toBeVisible();

  // Text box: click to place, type, Enter commits.
  await selectMarkupTool(page, "Text box");
  await clickCanvasAt(page, canvas, 0.3, 0.4);
  await page.getByLabel("Text box content").fill("Deposition note");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  // Comment: click drops a pin, popover takes the note text. Kept in the upper
  // portion of the tall first page so it stays within the viewport now that the
  // top markup strip + mode bar reserve more vertical space above page one.
  await selectMarkupTool(page, "Comment");
  await clickCanvasAt(page, canvas, 0.6, 0.4);
  await page.getByLabel("Comment text").fill("Check exhibit reference");
  await page.getByRole("button", { name: "Save Note" }).click();
  await expect(page.locator(".edit-layer__comment-pin")).toHaveCount(1);

  // Annotations and comments both live in the Annotate group; the Edit group
  // holds only substantive content edits.
  const toolPanel = page.locator(".tool-panel");
  await toolPanel.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    toolPanel.locator("#accordion-panel-edit").getByText("Check exhibit reference"),
  ).toHaveCount(0);
  await expect(
    toolPanel.locator("#accordion-panel-edit").getByText("pending edit", { exact: false }),
  ).toHaveCount(0);

  await toolPanel.getByRole("button", { name: "Annotate", exact: true }).click();
  await expect(toolPanel.getByText("2 pending edits")).toBeVisible();
  // The toolbar Undo mirrors Edit > Undo: enabled while pending edits exist.
  await expect(
    page.locator(".command-bar").getByRole("button", { name: "Undo" }),
  ).toBeEnabled();
  await expect(toolPanel.getByText("1 comment", { exact: true })).toBeVisible();
  await expect(
    toolPanel.locator("#accordion-panel-annotate").getByText("Check exhibit reference"),
  ).toBeVisible();

  const saved = await savePdf(page);

  // The document is clean after verified success, but saved RaioPDF-authored
  // annotations re-import as editable applied overlays.
  await expect(toolPanel.getByText("2 pending edits")).toHaveCount(1);
  await expect(page.getByLabel("Unsaved changes")).toBeHidden();

  // Saved bytes carry RaioPDF markup as live annotations, plus a regular
  // /Text annotation for the comment.
  await expectPdfAnnotation(saved, 0, "FreeText", "Deposition note");
  await expectPdfAnnotation(saved, 0, "Highlight");
  await expectPdfAnnotation(saved, 0, "Text", "Check exhibit reference");

  // Re-open the saved file: RaioPDF-authored annotations re-import as editable
  // overlays, while their saved PDF appearances are hidden from pdf.js' canvas
  // render to avoid drawing each annotation twice.
  await openPdf(page, "edit-round-trip-reopened.pdf", saved);
  await expect.poll(() => mainCanvasStats(page)).toMatchObject({
    widthReady: true,
    heightReady: true,
    hasTextPixels: true,
  });
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);
  await expect(page.locator(".edit-layer__highlight")).toHaveCount(1);
  await expect(page.locator(".edit-layer__comment-pin")).toHaveCount(1);
  await expect(page.locator(".edit-layer__text-box")).toContainText("Deposition note");
  await expect(page.getByRole("button", { name: "Comment: Check exhibit reference" })).toBeVisible();

  await page.locator(".edit-layer__text-box").dblclick();
  await expect(page.getByLabel("Text box content")).toHaveValue("Deposition note");
  await page.getByLabel("Text box content").press("Escape");
  await page.getByRole("button", { name: "Comment: Check exhibit reference" }).click();
  await expect(page.getByLabel("Comment text")).toHaveValue("Check exhibit reference");
  await page.getByLabel("Comment text").press("Escape");

  await expect.poll(() => canvasRegionInkPixels(page, 0.25, 0.34, 0.72, 0.47)).toBe(0);
  await expect.poll(() => canvasRegionInkPixels(page, 0.56, 0.46, 0.7, 0.58)).toBe(0);
  // The Annotate group is still open from above; the re-imported overlays
  // land back in its pending list.
  await expect(toolPanel.getByText("2 pending edits")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeHidden();
});

test("flattens pending markup into page content on an annotation-free PDF", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "flatten-pending-markup.pdf", await createPdf([300]));

  const canvas = mainCanvas(page);
  await selectMarkupTool(page, "Rectangle");
  await dragOnCanvas(page, canvas, 0.2, 0.25, 0.55, 0.45);
  await expect(page.locator("svg.edit-layer__shapes rect.edit-layer__shape-item")).toHaveCount(1);

  const toolPanel = page.locator(".tool-panel");
  await toolPanel.getByRole("button", { name: "Annotate", exact: true }).click();
  await toolPanel.getByRole("button", { name: "Make markup permanent" }).click();
  await expect(
    toolPanel.getByText("Merged 1 markup item permanently into the page."),
  ).toBeVisible();

  const saved = await savePdf(page);

  expect(await countPdfAnnotations(saved, 0, "Square")).toBe(0);
  expect(await readDecodedPageContent(saved, 0)).toContain("/RaioPDFAnnot");
});

test("flattens reopened imported markup once without re-appending it", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "flatten-imported-markup-source.pdf", await createPdf([300]));

  const canvas = mainCanvas(page);
  await selectMarkupTool(page, "Text box");
  await clickCanvasAt(page, canvas, 0.3, 0.4);
  await page.getByLabel("Text box content").fill("Flatten once");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  const savedWithAnnotation = await savePdf(page);
  expect(await countPdfAnnotations(savedWithAnnotation, 0, "FreeText")).toBe(1);

  await openPdf(page, "flatten-imported-markup-reopened.pdf", savedWithAnnotation);
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  const toolPanel = page.locator(".tool-panel");
  await toolPanel.getByRole("button", { name: "Annotate", exact: true }).click();
  await toolPanel.getByRole("button", { name: "Make markup permanent" }).click();
  await expect(
    toolPanel.getByText("Merged 1 markup item permanently into the page."),
  ).toBeVisible();

  const flattened = await savePdf(page);
  const flattenedContent = await readDecodedPageContent(flattened, 0);

  expect(await countPdfAnnotations(flattened, 0, "FreeText")).toBe(0);
  expect(countOccurrences(flattenedContent, "/RaioPDFAnnot")).toBe(1);
});

test("places a text box rotation-correctly on a rotated page", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "rotated-edit.pdf", await createPdf([300]));

  // Rotate the page 90 degrees, then place a text box at a known spot.
  await page.getByRole("button", { name: "Rotate selected pages" }).click();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  const canvas = mainCanvas(page);
  await selectMarkupTool(page, "Text box");
  await clickCanvasAt(page, canvas, 0.25, 0.25);
  await page.getByLabel("Text box content").fill("ROTCHECK");
  await page.getByLabel("Text box content").press("Enter");
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);

  const saved = await savePdf(page);
  const pdf = await PDFDocument.load(saved);
  expect(pdf.getPage(0).getRotation().angle).toBe(90);
  await expectPdfAnnotation(saved, 0, "FreeText", "ROTCHECK");

  // Re-open the saved file: the annotation must re-import as an overlay where
  // it was placed (near the click point), not mirror to another corner by a bad
  // mapping or double-render through the canvas.
  await openPdf(page, "rotated-edit-reopened.pdf", saved);
  await expect(page.locator(".edit-layer__text-box")).toHaveCount(1);
  await expect(page.locator(".edit-layer__text-box")).toContainText("ROTCHECK");
  await expect
    .poll(() => elementIntersectsCanvasRegion(page, ".edit-layer__text-box", 0.2, 0.2, 0.6, 0.38))
    .toBe(true);
  await expect.poll(() => canvasRegionInkPixels(page, 0.2, 0.2, 0.6, 0.38)).toBe(0);
  expect(await canvasRegionInkPixels(page, 0.62, 0.55, 0.98, 0.98)).toBe(0);
});

test("rapid double-clicks cannot double-place or double-save", async ({ page }) => {
  await page.goto("/");
  await openPdf(page, "double-click.pdf", await createPdf([300]));

  const canvas = mainCanvas(page);
  await selectMarkupTool(page, "Text box");

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
  expect(await countPdfAnnotations(saved, 0, "FreeText", "ONCE")).toBe(1);

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

  await expect(page.getByRole("button", { name: "Page 1", exact: true })).toBeVisible();
  await expect(mainCanvas(page)).toBeVisible();
}

async function openEditToolPanel(page: Page): Promise<void> {
  const toolPanel = page.locator(".tool-panel");
  const editButton = toolPanel.getByRole("button", { name: "Edit", exact: true });

  if (await editButton.getAttribute("aria-expanded") !== "true") {
    await editButton.click();
  }

  await expect(toolPanel.locator("#accordion-panel-edit")).toBeVisible();
}

async function selectMarkupTool(page: Page, name: string): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Markup tools" });

  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name, exact: true }).click();
}

async function expectCommandBarPage(page: Page, currentPage: number, pageCount: number): Promise<void> {
  await expect(page.getByLabel("Go to page")).toHaveValue(String(currentPage));
  await expect(page.locator(".command-bar__page-label")).toContainText(`/ ${pageCount}`);
}

function mainCanvas(page: Page): ReturnType<Page["locator"]> {
  return page.locator('[data-testid="pdf-page-canvas"]').first();
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

async function createAcroFormPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Client name:", { x: 72, y: 708, size: 12, font });
  const field = pdf.getForm().createTextField("client_name");
  field.addToPage(page, { x: 180, y: 700, width: 240, height: 24 });
  return pdf.save();
}

async function createFragmentedTextPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([260, 300]);
  const fonts = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.TimesRoman),
    pdf.embedFont(StandardFonts.Courier),
  ]);
  const fragments = ["Confidential", " client", " number"];
  let x = 24;

  for (const [index, fragment] of fragments.entries()) {
    const font = fonts[index]!;
    page.drawText(fragment, { x, y: 240, size: 12, font });
    x += font.widthOfTextAtSize(fragment, 12);
  }

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
      const pathname = new URL(url).pathname;

      if (pathname === "/api/v1/analysis/basic-info") {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/api/v1/misc/ocr-pdf" || pathname === "/local/ocr") {
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
      const pathname = new URL(url).pathname;

      if (pathname === "/api/v1/analysis/basic-info") {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/local/redact-areas") {
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

async function installTextEditBridgeMock(
  page: Page,
  editedBytes: Uint8Array,
): Promise<void> {
  await page.addInitScript(({ editedContents }) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
      __RAIOPDF_TEST_TEXT_EDIT_CALL_COUNT__?: number;
    };
    testWindow.__RAIOPDF_TEST_TEXT_EDIT_CALL_COUNT__ = 0;

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      return { port: 39393, token: "smoke-token" } as T;
    };

    testWindow.__RAIOPDF_TEST_ENGINE_FETCH__ = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const pathname = new URL(url).pathname;

      if (pathname === "/api/v1/analysis/basic-info") {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/api/v1/general/edit-text") {
        testWindow.__RAIOPDF_TEST_TEXT_EDIT_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_TEXT_EDIT_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(editedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, {
    editedContents: [...editedBytes],
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
      const pathname = new URL(url).pathname;

      if (pathname === "/api/v1/analysis/basic-info") {
        return new Response(JSON.stringify({ pageCount: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/local/pdfa") {
        testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(convertedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (
        pathname === "/api/v1/security/sanitize-pdf" ||
        pathname === "/api/v1/misc/ocr-pdf" ||
        pathname === "/local/ocr"
      ) {
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
      const pathname = new URL(url).pathname;

      if (pathname === "/api/v1/analysis/basic-info") {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/local/compress") {
        testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_COMPRESS_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(compressedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (pathname === "/local/pdfa") {
        testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ =
          (testWindow.__RAIOPDF_TEST_PDFA_CALL_COUNT__ ?? 0) + 1;

        return new Response(new Uint8Array(convertedContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (
        pathname === "/api/v1/security/sanitize-pdf" ||
        pathname === "/api/v1/misc/ocr-pdf" ||
        pathname === "/local/ocr"
      ) {
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
      const pathname = new URL(url).pathname;

      if (pathname === "/api/v1/analysis/basic-info") {
        return new Response(JSON.stringify({ pageCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/local/compress") {
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

async function getTextEditCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_TEXT_EDIT_CALL_COUNT__?: number;
    }).__RAIOPDF_TEST_TEXT_EDIT_CALL_COUNT__ ?? 0;
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

async function waitForCanvasPointToHitTextLayer(
  page: Page,
  canvas: ReturnType<Page["locator"]>,
  xFraction: number,
  yFraction: number,
): Promise<void> {
  await expect.poll(async () => {
    const box = await canvas.boundingBox();

    if (!box) {
      return false;
    }

    return page.evaluate(
      ([x, y]) =>
        Boolean(document.elementFromPoint(x, y)?.closest(".page-view__text-layer")),
      [box.x + box.width * xFraction, box.y + box.height * yFraction],
    );
  }).toBe(true);
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

async function elementIntersectsCanvasRegion(
  page: Page,
  selector: string,
  x0Fraction: number,
  y0Fraction: number,
  x1Fraction: number,
  y1Fraction: number,
): Promise<boolean> {
  return page.evaluate(
    ([targetSelector, x0f, y0f, x1f, y1f]) => {
      const canvas = document.querySelector('[data-testid="pdf-page-canvas"]');
      const target = document.querySelector(targetSelector ?? "");

      if (!(canvas instanceof HTMLCanvasElement) || !(target instanceof HTMLElement)) {
        return false;
      }

      const canvasBox = canvas.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const region = {
        left: canvasBox.left + canvasBox.width * (x0f ?? 0),
        top: canvasBox.top + canvasBox.height * (y0f ?? 0),
        right: canvasBox.left + canvasBox.width * (x1f ?? 0),
        bottom: canvasBox.top + canvasBox.height * (y1f ?? 0),
      };

      return targetBox.left < region.right &&
        targetBox.right > region.left &&
        targetBox.top < region.bottom &&
        targetBox.bottom > region.top;
    },
    [selector, x0Fraction, y0Fraction, x1Fraction, y1Fraction],
  );
}

async function expectPdfAnnotation(
  bytes: Uint8Array,
  pageIndex: number,
  subtypeName: string,
  contents?: string,
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
      if (subtype !== PDFName.of(subtypeName)) {
        return false;
      }

      if (contents === undefined) {
        return true;
      }

      const text = dict.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString);
      return text?.decodeText() === contents;
    });

  expect(
    found,
    contents === undefined
      ? `expected a /${subtypeName} annotation`
      : `expected a /${subtypeName} annotation with contents "${contents}"`,
  ).toBe(true);
}

async function countPdfAnnotations(
  bytes: Uint8Array,
  pageIndex: number,
  subtypeName: string,
  contents?: string,
): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  const annotations = pdf
    .getPage(pageIndex)
    .node.lookupMaybe(PDFName.of("Annots"), PDFArray);

  if (!annotations) {
    return 0;
  }

  return annotations
    .asArray()
    .map((entry) => (entry instanceof PDFRef ? pdf.context.lookup(entry, PDFDict) : entry))
    .filter((entry): entry is PDFDict => entry instanceof PDFDict)
    .filter((dict) => {
      const subtype = dict.get(PDFName.of("Subtype"));

      if (subtype !== PDFName.of(subtypeName)) {
        return false;
      }

      if (contents === undefined) {
        return true;
      }

      const text = dict.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString);
      return text?.decodeText() === contents;
    }).length;
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

/** Every decodable stream in the document, concatenated — for asserting on
 * content that lives in flattened appearance XObjects rather than the page's
 * direct content streams. */
async function readAllDecodedStreams(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const decoded: string[] = [];

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream) {
      try {
        decoded.push(decodePdfStream(object));
      } catch {
        // Not a Flate/raw text stream (e.g. an image) — skip it.
      }
    }
  }

  return decoded.join("\n");
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

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
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
