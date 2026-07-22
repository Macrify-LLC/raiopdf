// Real-engine canary for Edit Text. Authored for `pnpm canary`;
// do not run from the ordinary UI test command.

import { expect, test, type Page } from "@playwright/test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
} from "pdf-lib";
import { readEngineEndpoint } from "./endpoint";
import {
  captureLogs,
  installRealEngineBridge,
  openPdf,
  readOutlineTitles,
  saveCanaryArtifact,
  savePdf,
  searchHitCount,
} from "./helpers";

const endpoint = readEngineEndpoint();
const REVIEW_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 360_000;
const REVIEW_DISCLOSURE = "The whole document is rewritten by this operation. Pages not shown here may shift slightly.";

const BENIGN_LOG = [
  /Setting up fake worker/i,
  /Warning: /i,
  /fontkit/i,
];

test.describe.configure({ timeout: TEST_TIMEOUT_MS });

test("Edit Text: real engine replaces born-digital text and preserves restored bookmarks", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  const source = await createBookmarkedTextPdf("Plaintiff files the motion.");
  await openPdf(page, "edit-text-bookmarked.pdf", source);

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Edit Text", exact: true }).click();
  await page.getByLabel("Find text").fill("Plaintiff");
  await page.getByLabel("Replace with").fill("Petitioner");
  await page.getByRole("button", { name: "Add replacement" }).click();
  await page.getByRole("toolbar", { name: "Edit document text" }).getByRole("button", { name: "Review (1)" }).click();

  const reviewDialog = await expectTextEditReviewReady(page);
  // The review dialog is where the estimate surfaces ("N estimated
  // replacement(s) on M page(s)"). Apply commits the edit and reopens the
  // result as a fresh document, which by design leaves edit-text mode and
  // dismisses this dialog -- so the estimate must be asserted while the dialog
  // is still open, before Apply. The applied result itself is verified below by
  // reopening the saved PDF. Scope to the dialog: the same estimate also
  // echoes in the tool panel's status line, so an unscoped match is ambiguous.
  await expect(
    reviewDialog.getByText(/estimated replacement/).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();

  const saved = await savePdf(page);
  saveCanaryArtifact("edit text", "edit-text-bookmarked-output.pdf", saved,
    "real /api/v1/general/edit-text output; confirm Plaintiff changed to Petitioner and bookmark still opens page 1");

  await openPdf(page, "edit-text-bookmarked-output.pdf", saved);
  expect(await searchHitCount(page, "Petitioner")).toBeGreaterThan(0);
  expect(await searchHitCount(page, "Plaintiff")).toBe(0);
  expect(await readOutlineTitles(saved)).toEqual(["Motion"]);
  logs.assertClean(BENIGN_LOG);
});

test("Edit Text: image-bearing mixed document stays within the Phase 0 size envelope", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  const source = await createImageBearingTextPdf("Acme appears beside the logo.");
  await openPdf(page, "edit-text-image-bearing.pdf", source);

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Edit Text", exact: true }).click();
  await page.getByLabel("Find text").fill("Acme");
  await page.getByLabel("Replace with").fill("Raio");
  await page.getByRole("button", { name: "Add replacement" }).click();
  await page.getByRole("toolbar", { name: "Edit document text" }).getByRole("button", { name: "Review (1)" }).click();
  await expectTextEditReviewReady(page);
  await page.getByRole("button", { name: "Apply" }).click();

  const saved = await savePdf(page);
  saveCanaryArtifact("edit text", "edit-text-image-bearing-output.pdf", saved,
    "image-bearing text edit; compare logo/image fidelity against source");

  expect(saved.byteLength).toBeGreaterThan(source.byteLength * 0.5);
  expect(saved.byteLength).toBeLessThan(source.byteLength * 2);
  await openPdf(page, "edit-text-image-bearing-output.pdf", saved);
  expect(await searchHitCount(page, "Raio")).toBeGreaterThan(0);
  expect(await searchHitCount(page, "Acme")).toBe(0);
  logs.assertClean(BENIGN_LOG);
});

test("Edit Text: right-click selected replacement changes only the chosen occurrence", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  // Two occurrences of the same word on separate lines; the test replaces
  // ONLY the second, which is exactly what selected replacement exists for
  // (whole-document Find & Replace would change both).
  const source = await createTwoLinePdf("Smith files the motion.", "Smith replies today.");
  await openPdf(page, "edit-text-selected.pdf", source);

  // Programmatic selection over the leading "Smith" of the SECOND line — a
  // real DOM Range against the pdf.js text layer, the same selection the
  // capture path consumes in production.
  const textLayer = page.locator(".page-view__text-layer").first();
  await expect(textLayer.locator(".page-view__text-end")).toHaveCount(1);
  const anchor = await textLayer.evaluate((layer) => {
    const span = [...layer.querySelectorAll("span")].find((candidate) =>
      candidate.textContent?.startsWith("Smith replies"),
    );
    const node = span?.firstChild;
    if (!span || !node || node.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, "Smith".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  expect(anchor).not.toBeNull();

  await page.mouse.click(anchor!.x, anchor!.y, { button: "right" });
  const replaceItem = page.getByRole("menuitem", { name: "Replace text..." });
  await expect(replaceItem).toBeEnabled();
  await replaceItem.click();

  await expect(page.getByText("Selected text: Smith")).toBeVisible();
  // Deliberately shorter than the selected word: legal corrections commonly
  // change length, and the text-editor round-trip must not only work when the
  // replacement happens to have the same number of characters.
  await page.getByLabel("Replace selected text with").fill("Lee");
  await page.getByRole("button", { name: "Review replacement" }).click();

  // This action is direct: it resolves the target and opens review without
  // requiring the hidden Edit sidebar's generic Review button. The dialog is
  // explicitly scoped and verified, never described as a bulk estimate.
  const reviewDialog = await expectTextEditReviewReady(page, { selected: true });
  await expect(reviewDialog.getByText(/scoped to the selected occurrence/i)).toBeVisible();
  await expect(reviewDialog.getByText(REVIEW_DISCLOSURE)).toHaveCount(0);
  await expect(reviewDialog.getByText(/estimated replacement/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Apply" }).click();

  const saved = await savePdf(page);
  saveCanaryArtifact("edit text", "edit-text-selected-output.pdf", saved,
    "real replaceSelectedText output; confirm ONLY the second Smith became Lee");

  await openPdf(page, "edit-text-selected-output.pdf", saved);
  expect(await searchHitCount(page, "Lee")).toBe(1);
  expect(await searchHitCount(page, "Smith")).toBe(1);
  logs.assertClean(BENIGN_LOG);
});

async function expectTextEditReviewReady(
  page: Page,
  options: { selected?: boolean } = {},
): Promise<ReturnType<Page["getByRole"]>> {
  const dialog = page.getByRole("dialog", {
    name: options.selected ? "Review selected replacement" : "Review text replacements",
  });
  // The review dialog mounts only after the real engine finishes staging (a docked
  // loader covers that window, PR #202), which can run for minutes on image-heavy
  // documents — so wait the full review budget, not the default 20s expect timeout.
  await expect(dialog, "Review dialog should open once staging completes.").toBeVisible({
    timeout: REVIEW_TIMEOUT_MS,
  });

  try {
    if (options.selected) {
      await expect(dialog.getByText(/scoped to the selected occurrence/i)).toBeVisible({ timeout: REVIEW_TIMEOUT_MS });
    } else {
      await expect(dialog.getByText(REVIEW_DISCLOSURE)).toBeVisible({ timeout: REVIEW_TIMEOUT_MS });
    }
  } catch (error) {
    const [dialogText, statusText] = await Promise.all([
      dialog.textContent().catch(() => null),
      page.locator(".tool-panel__field-error, .tool-panel__status-line")
        .allTextContents()
        .catch(() => []),
    ]);
    throw new Error([
      `Text replacement staging did not reach review within ${REVIEW_TIMEOUT_MS}ms.`,
      `Dialog text: ${JSON.stringify(dialogText ?? "")}`,
      `Status text: ${JSON.stringify(statusText)}`,
    ].join("\n"), { cause: error });
  }

  return dialog;
}

async function createTwoLinePdf(lineOne: string, lineTwo: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(lineOne, { x: 72, y: 700, size: 14, font });
  page.drawText(lineTwo, { x: 72, y: 660, size: 14, font });
  return pdf.save();
}

async function createBookmarkedTextPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 14, font });

  const pageRef = pdf.getPage(0).ref;
  const dest = pdf.context.obj([pageRef, PDFName.of("XYZ"), PDFNumber.of(0), PDFNumber.of(792), PDFNumber.of(0)]);
  const itemRef = pdf.context.nextRef();
  const outlinesRef = pdf.context.nextRef();
  const item = PDFDict.withContext(pdf.context);
  item.set(PDFName.of("Title"), PDFHexString.fromText("Motion"));
  item.set(PDFName.of("Parent"), outlinesRef);
  item.set(PDFName.of("Dest"), dest);
  const outlines = PDFDict.withContext(pdf.context);
  outlines.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlines.set(PDFName.of("First"), itemRef);
  outlines.set(PDFName.of("Last"), itemRef);
  outlines.set(PDFName.of("Count"), PDFNumber.of(1));
  pdf.context.assign(itemRef, item);
  pdf.context.assign(outlinesRef, outlines);
  pdf.catalog.set(PDFName.of("Outlines"), outlinesRef);

  return pdf.save();
}

async function createImageBearingTextPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 14, font });

  const imageBytes = new Uint8Array(80 * 80 * 3);
  for (let index = 0; index < imageBytes.length; index += 3) {
    imageBytes[index] = 24;
    imageBytes[index + 1] = 96;
    imageBytes[index + 2] = 160;
  }
  const imageRef = pdf.context.nextRef();
  const image = PDFRawStream.of(PDFDict.withContext(pdf.context), imageBytes);
  image.dict.set(PDFName.of("Type"), PDFName.of("XObject"));
  image.dict.set(PDFName.of("Subtype"), PDFName.of("Image"));
  image.dict.set(PDFName.of("Width"), PDFNumber.of(80));
  image.dict.set(PDFName.of("Height"), PDFNumber.of(80));
  image.dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
  image.dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  pdf.context.assign(imageRef, image);

  const resources = page.node.Resources() ?? PDFDict.withContext(pdf.context);
  const xobjects = PDFDict.withContext(pdf.context);
  xobjects.set(PDFName.of("Logo"), imageRef);
  resources.set(PDFName.of("XObject"), xobjects);
  page.node.set(PDFName.of("Resources"), resources);
  page.pushOperators(...[]);
  const existing = page.node.Contents();
  const draw = pdf.context.flateStream("q\n80 0 0 80 72 580 cm\n/Logo Do\nQ\n");
  const drawRef = pdf.context.register(draw);
  page.node.set(PDFName.of("Contents"), PDFArray.withContext(pdf.context));
  const contents = page.node.lookup(PDFName.of("Contents"), PDFArray);
  // pdf-lib already stores the drawn text as a Contents *array* (one stream
  // ref). Pushing `existing` whole would nest that array inside the new one --
  // an invalid Contents of the shape [[textStream], imageDraw] that pdf.js
  // cannot walk, so the text layer vanishes and the page reads as scanned.
  // Flatten it: keep the text stream ref, then append the image draw after it.
  if (existing instanceof PDFArray) {
    for (const entry of existing.asArray()) {
      contents.push(entry);
    }
  } else if (existing) {
    contents.push(existing);
  }
  contents.push(drawRef);

  return pdf.save();
}
