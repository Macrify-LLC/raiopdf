import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-expect-error - the pdf.js worker entry ships no type declarations.
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { scoreGarbledPage, type TextLayerCoverage } from "@raiopdf/rules";
import type { PdfEditRect } from "@raiopdf/engine-api";

// Pre-seed pdf.js's worker on globalThis. In Node, pdf.js sets up a "fake worker" by
// doing a runtime-string `import("./pdf.worker.mjs")` — a dynamic import esbuild can't
// see, so in the bundled MCP connector it fails with "Setting up fake worker failed"
// and every pdf.js-backed tool (redaction's removal verification, filing's
// searchable-text check) throws. A *static* import bundles the worker as code, and
// pdf.js skips fake-worker setup when globalThis.pdfjsWorker.WorkerMessageHandler is
// already present — so the runtime import never fires. Handled uniformly at bundle
// time, independent of the emitted file's location or cwd.
(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker ??= pdfjsWorker;

const require = createRequire(import.meta.url);
const PDFJS_ASSET_DIR_ENV = "RAIOPDF_PDFJS_ASSET_DIR";

function assetDir(name: string): string {
  for (const root of assetRootCandidates()) {
    const candidate = path.join(root, name);
    if (isDirectory(candidate)) {
      return toPdfjsFactoryPath(candidate);
    }
  }

  const packageDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return toPdfjsFactoryPath(path.join(packageDir, name));
}

function toPdfjsFactoryPath(directory: string): string {
  const withTrailingSeparator = /[\\/]$/.test(directory) ? directory : directory + path.sep;
  const href = pathToFileURL(withTrailingSeparator).href;

  return href.endsWith("/") ? href : `${href}/`;
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

export type PdfTextBoxItem = {
  str: string;
  rect: PdfEditRect;
  hasEOL: boolean;
};

export type PdfTextBoxPage = {
  pageIndex: number;
  width: number;
  height: number;
  items: PdfTextBoxItem[];
};

export async function extractTextBoxesByPage(bytes: Uint8Array): Promise<readonly PdfTextBoxPage[]> {
  const task = openDocumentTask(bytes);
  try {
    const document = await task.promise;
    const pages: PdfTextBoxPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextBoxItem[] = [];

      for (const item of content.items) {
        if (!isTextItem(item) || item.str.length === 0) {
          continue;
        }

        const textItem = item as TextItem & {
          width?: number;
          height?: number;
          transform?: readonly number[];
          hasEOL?: boolean;
        };
        const transform = textItem.transform;
        if (!Array.isArray(transform) || transform.length < 6) {
          continue;
        }

        const width = finitePositive(textItem.width) ?? Math.abs(transform[0] ?? 0);
        const height = finitePositive(textItem.height) ?? Math.abs(transform[3] ?? 0);
        if (width === undefined || height === undefined) {
          continue;
        }

        const baselineY = transform[5] ?? 0;
        items.push({
          str: textItem.str,
          rect: {
            x: transform[4] ?? 0,
            y: baselineY - 0.35 * height,
            w: width,
            h: 1.35 * height,
          },
          hasEOL: textItem.hasEOL ?? false,
        });
      }

      pages.push({
        pageIndex: pageNumber - 1,
        width: viewport.width,
        height: viewport.height,
        items,
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

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
