import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

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

test("makes an image-only PDF searchable through the desktop OCR bridge", async ({ page }) => {
  const sourcePdf = await createPdf([200]);
  const searchablePdf = await createTextPdf("Verified OCR text");
  await installOcrBridgeMock(page, searchablePdf);
  await page.goto("/");
  await openPdf(page, "scan.pdf", sourcePdf);

  await page.getByRole("button", { name: "Make Searchable (OCR)" }).click();

  await expect(page.getByText("Starting the PDF engine...")).toBeVisible();
  await expect(page.getByText("Making searchable — page-by-page work happens in the engine.")).toBeVisible();
  await expect(page.getByText("Verifying the text layer...")).toBeVisible();
  await expect(page.getByLabel("Legal").getByText("Searchable — verified")).toBeVisible();
  await expect(page.getByRole("contentinfo").getByText("Searchable — verified")).toBeVisible();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();
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
): Promise<void> {
  await page.addInitScript((ocrContents: number[]) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_ENGINE_FETCH__?: typeof fetch;
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
    };

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string) => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 120);
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
        await new Promise((resolve) => {
          window.setTimeout(resolve, 120);
        });

        return new Response(new Uint8Array(ocrContents), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }, [...ocrBytes]);
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
