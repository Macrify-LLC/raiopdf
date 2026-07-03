import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import type { TextLayerCoverage } from "./types.js";

const require = createRequire(import.meta.url);

function assetDir(name: string): string {
  const packageDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return pathToFileURL(path.join(packageDir, name) + path.sep).href;
}

function openDocumentTask(bytes: Uint8Array): ReturnType<typeof getDocument> {
  return getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: assetDir("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetDir("standard_fonts"),
    wasmUrl: assetDir("wasm"),
    useSystemFonts: false,
  });
}

/**
 * Extract only page-body text, not annotations or form fields.
 */
export async function extractPageText(bytes: Uint8Array): Promise<string> {
  const pages = await extractPageTextByPage(bytes);
  return pages.map((page) => page.text).join("\n");
}

export async function extractPageTextByPage(
  bytes: Uint8Array,
): Promise<readonly { pageIndex: number; text: string }[]> {
  const task = openDocumentTask(bytes);
  try {
    const document = await task.promise;
    const pages: { pageIndex: number; text: string }[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({
        pageIndex: pageNumber - 1,
        text: content.items.map((item) => isTextItem(item) ? item.str : "").join(" "),
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

export async function extractTextLayerCoverage(bytes: Uint8Array): Promise<TextLayerCoverage> {
  const task = openDocumentTask(bytes);
  try {
    const document = await task.promise;
    const imageOnlyPages: number[] = [];
    const mixedPages: number[] = [];
    const textPages: number[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const hasText = content.items.some((item) => isTextItem(item) && item.str.trim().length > 0);
      const operatorList = await page.getOperatorList();
      const hasImage = operatorList.fnArray.some(isImageOperator);
      const pageIndex = pageNumber - 1;

      if (!hasText) {
        imageOnlyPages.push(pageIndex);
      } else if (hasImage) {
        mixedPages.push(pageIndex);
      } else {
        textPages.push(pageIndex);
      }
    }

    return { imageOnlyPages, mixedPages, textPages };
  } finally {
    await task.destroy();
  }
}

/**
 * Extract page text plus annotation contents and form field values. This is used
 * by the redaction verifier, where hidden annotation/form text still matters.
 */
export async function extractAllText(bytes: Uint8Array): Promise<string> {
  const task = openDocumentTask(bytes);

  try {
    const document = await task.promise;
    const parts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => isTextItem(item) ? item.str : "").join(" "));

      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        const record = annotation as {
          contents?: unknown;
          contentsObj?: { str?: unknown } | null;
          fieldValue?: unknown;
        };
        if (typeof record.contentsObj?.str === "string") {
          parts.push(record.contentsObj.str);
        }
        if (typeof record.contents === "string") {
          parts.push(record.contents);
        }
        const fieldValue = record.fieldValue;
        if (typeof fieldValue === "string") {
          parts.push(fieldValue);
        } else if (Array.isArray(fieldValue)) {
          for (const entry of fieldValue) {
            if (typeof entry === "string") {
              parts.push(entry);
            }
          }
        }
      }
    }
    return parts.join("\n");
  } finally {
    await task.destroy();
  }
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item;
}

function isImageOperator(fn: number): boolean {
  return fn === OPS.paintImageXObject ||
    fn === OPS.paintInlineImageXObject ||
    fn === OPS.paintInlineImageXObjectGroup ||
    fn === OPS.paintImageMaskXObject ||
    fn === OPS.paintImageMaskXObjectGroup ||
    fn === OPS.paintImageXObjectRepeat ||
    fn === OPS.paintImageMaskXObjectRepeat;
}
