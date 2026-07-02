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

  const makeSearchable = page.getByRole("button", { name: "Make Searchable (OCR)" });
  await makeSearchable.evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
  });

  await expect(page.getByText("Starting the PDF engine...")).toBeVisible();
  await expect(makeSearchable).toBeDisabled();
  await expect(page.getByText("Making searchable — page-by-page work happens in the engine.")).toBeVisible();
  await expect(page.getByText("Verifying the text layer...")).toBeVisible();
  await expect(page.getByLabel("Legal").getByText("Searchable — verified")).toBeVisible();
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

  await page.getByRole("button", { name: "Make Searchable (OCR)" }).click();

  await expect(page.getByText("OCR produced no text layer. The document was left unchanged.")).toBeVisible();
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

  await page.getByRole("button", { name: "Make Searchable (OCR)" }).click();
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

  const combine = page.getByRole("button", { name: "Combine with Exhibits" });
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
  await expect(page.getByRole("button", { name: "Page 5" })).toBeVisible();

  const saved = await savePdf(page);
  await expectPdf(saved, {
    widths: [200, 210, 350, 300, 310],
    rotations: [0, 0, 0, 0, 0],
  });
  await expectPageContentToContainLabel(saved, 2, "Exhibit A");
  await expectPageContentToContainLabel(saved, 3, "Exhibit B");
  await expectOutlineEntries(saved, [
    { title: "Main document", pageIndex: 0 },
    { title: "Exhibit A", pageIndex: 2 },
    { title: "Exhibit B", pageIndex: 3 },
  ]);
});

async function openPdf(page: Page, fileName: string, bytes: Uint8Array): Promise<void> {
  await page.getByLabel("Open PDF file").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });

  await expect(page.getByRole("button", { name: "Page 1" })).toBeVisible();
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

      return { port: 39393 } as T;
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

async function getOcrCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __RAIOPDF_TEST_OCR_CALL_COUNT__?: number;
    }).__RAIOPDF_TEST_OCR_CALL_COUNT__ ?? 0;
  });
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
