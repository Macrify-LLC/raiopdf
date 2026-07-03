import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { scoreGarbledPage, type TextLayerCoverage } from "@raiopdf/rules";

const require = createRequire(import.meta.url);
const PDFJS_ASSET_DIR_ENV = "RAIOPDF_PDFJS_ASSET_DIR";

function assetDir(name: string): string {
  for (const root of assetRootCandidates()) {
    const candidate = path.join(root, name);
    if (isDirectory(candidate)) {
      return toPdfjsFactoryUrl(candidate);
    }
  }

  const packageDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return toPdfjsFactoryUrl(path.join(packageDir, name));
}

function toPdfjsFactoryUrl(directory: string): string {
  const withTrailingSeparator = /[\\/]$/.test(directory) ? directory : directory + path.sep;
  return pathToFileURL(withTrailingSeparator).href;
}

function assetRootCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env[PDFJS_ASSET_DIR_ENV];
  if (explicit) {
    candidates.push(explicit);
  }

  const execDir = path.dirname(process.execPath);
  candidates.push(path.resolve(execDir, "..", "pdfjs"));
  candidates.push(path.join(execDir, "pdfjs"));

  const entry = process.argv[1];
  if (entry) {
    candidates.push(path.resolve(path.dirname(path.resolve(entry)), "..", "pdfjs"));
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(moduleDir, "..", "pdfjs"));

  return [...new Set(candidates)];
}

function isDirectory(candidate: string): boolean {
  try {
    accessSync(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
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
    const garbledPages: TextLayerCoverage["garbledPages"][number][] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => isTextItem(item) ? item.str : "").join(" ");
      const hasText = pageText.trim().length > 0;
      const operatorList = await page.getOperatorList();
      const hasImage = operatorList.fnArray.some(isImageOperator);
      const pageIndex = pageNumber - 1;
      const garbleInfo = scoreGarbledPage(pageText, pageIndex);
      if (garbleInfo) {
        garbledPages.push(garbleInfo);
      }

      if (!hasText) {
        imageOnlyPages.push(pageIndex);
      } else if (hasImage) {
        mixedPages.push(pageIndex);
      } else {
        textPages.push(pageIndex);
      }
    }

    return { imageOnlyPages, mixedPages, textPages, garbledPages };
  } finally {
    await task.destroy();
  }
}

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
