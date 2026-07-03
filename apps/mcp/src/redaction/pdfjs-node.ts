import { createRequire } from "node:module";
import path from "node:path";
// The legacy build is the Node-safe entry point (no browser-only globals). It
// runs pdf.js on the main thread (fake worker) — no worker file needed.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);

function assetDir(name: string): string {
  const packageDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return path.join(packageDir, name) + path.sep;
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
 * Extract only the page-body text (the text layer, NOT annotations or form
 * fields), in Node. Used to decide whether a document is "searchable" for
 * e-filing preflight — an annotation or sticky note must not make an
 * image-only scan look searchable. Throws on an unreadable document.
 */
export async function extractPageText(bytes: Uint8Array): Promise<string> {
  const task = openDocumentTask(bytes);
  try {
    const document = await task.promise;
    const parts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return parts.join("\n");
  } finally {
    await task.destroy();
  }
}

/**
 * Extract all recoverable text from a PDF entirely in Node (no browser, no
 * worker, no canvas): the page text layer PLUS annotation contents and form
 * field values (a redacted term could survive in an annotation or form field
 * even when the visible page is clean). Used to verify redaction removed the
 * text. cMap / standard-font / wasm assets are resolved from the installed
 * pdfjs-dist package on disk. If assets are missing or the document is
 * unreadable, this THROWS rather than returning empty — the caller must treat a
 * throw as verification failure, never as "no text".
 */
export async function extractAllText(bytes: Uint8Array): Promise<string> {
  const task = openDocumentTask(bytes);

  try {
    const document = await task.promise;
    const parts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));

      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        const record = annotation as {
          contents?: unknown;
          contentsObj?: { str?: unknown } | null;
          fieldValue?: unknown;
        };
        // pdf.js v6 exposes annotation text as contentsObj.str; older shapes use
        // a plain `contents` string.
        if (typeof record.contentsObj?.str === "string") {
          parts.push(record.contentsObj.str);
        }
        if (typeof record.contents === "string") {
          parts.push(record.contents);
        }
        // Form field values may be a string or an array of strings (multi-select).
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
