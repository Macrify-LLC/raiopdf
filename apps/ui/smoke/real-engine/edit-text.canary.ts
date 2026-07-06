// Real-engine canary for Edit Document Text. Authored for `pnpm canary`;
// do not run from the ordinary UI test command.

import { expect, test } from "@playwright/test";
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

const BENIGN_LOG = [
  /Setting up fake worker/i,
  /Warning: /i,
  /fontkit/i,
];

test("Edit Document Text: real engine replaces born-digital text and preserves restored bookmarks", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  const source = await createBookmarkedTextPdf("Plaintiff files the motion.");
  await openPdf(page, "edit-text-bookmarked.pdf", source);

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Edit Document Text", exact: true }).click();
  await page.getByLabel("Find text").fill("Plaintiff");
  await page.getByLabel("Replace with").fill("Petitioner");
  await page.getByRole("button", { name: "Replace all" }).click();
  await page.getByRole("button", { name: "Review" }).click();

  await expect(page.getByText("The whole document is rewritten by this operation. Pages not shown here may shift slightly.")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/estimated replacement/)).toBeVisible({ timeout: 120_000 });

  const saved = await savePdf(page);
  saveCanaryArtifact("edit text", "edit-text-bookmarked-output.pdf", saved,
    "real /api/v1/general/edit-text output; confirm Plaintiff changed to Petitioner and bookmark still opens page 1");

  await openPdf(page, "edit-text-bookmarked-output.pdf", saved);
  expect(await searchHitCount(page, "Petitioner")).toBeGreaterThan(0);
  expect(await searchHitCount(page, "Plaintiff")).toBe(0);
  expect(await readOutlineTitles(saved)).toEqual(["Motion"]);
  logs.assertClean(BENIGN_LOG);
});

test("Edit Document Text: image-bearing mixed document stays within the Phase 0 size envelope", async ({ page }) => {
  const logs = captureLogs(page);
  await installRealEngineBridge(page, endpoint);
  await page.goto("/");

  const source = await createImageBearingTextPdf("Acme appears beside the logo.");
  await openPdf(page, "edit-text-image-bearing.pdf", source);

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Edit Document Text", exact: true }).click();
  await page.getByLabel("Find text").fill("Acme");
  await page.getByLabel("Replace with").fill("Raio");
  await page.getByRole("button", { name: "Replace all" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("The whole document is rewritten by this operation. Pages not shown here may shift slightly.")).toBeVisible({ timeout: 120_000 });
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
  if (existing) {
    contents.push(existing);
  }
  contents.push(drawRef);

  return pdf.save();
}
