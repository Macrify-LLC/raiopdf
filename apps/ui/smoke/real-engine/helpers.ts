import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { readEngineEndpoint } from "./endpoint";
import { assembleClassicPdf, latin1Bytes } from "./pdf-assembly";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import type { EngineEndpoint } from "./endpoint";

// --- Real-engine bridge -------------------------------------------------------

/**
 * Wire the app's engine bridge to the LIVE payload engine instead of a canned
 * mock. We override only the Tauri `engine_start` command (to hand back the
 * real proxy port/token). Crucially we leave `__RAIOPDF_TEST_ENGINE_FETCH__`
 * UNSET, so the real browser `fetch` goes to the real auth-proxy — exercising
 * the X-RaioPDF-Auth token check and the CORS preflight for real. That path is
 * exactly where packaged-build-only regressions (e.g. the "illegal fetch
 * invocation" bug) hide, which the mocked suite is blind to.
 *
 * The page MUST be served from a `localhost` origin: the proxy CORS-allowlists
 * `localhost` / `tauri.localhost` only, never `127.0.0.1`.
 */
export async function installRealEngineBridge(page: Page, endpoint: EngineEndpoint): Promise<void> {
  await page.addInitScript((engine) => {
    const testWindow = window as typeof window & {
      __RAIOPDF_TEST_TAURI_INVOKE__?: <T>(command: string) => Promise<T>;
    };

    testWindow.__RAIOPDF_TEST_TAURI_INVOKE__ = async <T,>(command: string): Promise<T> => {
      if (command !== "engine_start") {
        throw new Error(`Unexpected Tauri command in canary: ${command}`);
      }
      return {
        port: engine.port,
        token: engine.token,
        ocrToolchain: { available: true, missing: [] },
      } as T;
    };
  }, { port: endpoint.port, token: endpoint.token });
}

// --- Error / console capture (error-logging coverage) -------------------------

export interface CapturedLogs {
  consoleErrors: string[];
  pageErrors: string[];
  /** Fail if any unexpected console.error / uncaught error was logged. */
  assertClean(allow?: RegExp[]): void;
}

/**
 * Attach console + pageerror listeners so a test can assert the app either
 * logged nothing unexpected (happy path) or logged the RIGHT diagnostic on an
 * error path. Call before `page.goto`.
 */
export function captureLogs(page: Page): CapturedLogs {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  return {
    consoleErrors,
    pageErrors,
    assertClean(allow: RegExp[] = []) {
      const unexpected = [...consoleErrors, ...pageErrors].filter(
        (line) => !allow.some((pattern) => pattern.test(line)),
      );
      expect(unexpected, `Unexpected error logs:\n${unexpected.join("\n")}`).toHaveLength(0);
    },
  };
}

// --- UI drivers (mirrors app.smoke.ts so the canary drives the app the same) --

export async function openPdf(page: Page, fileName: string, bytes: Uint8Array): Promise<void> {
  await page.getByLabel("Open PDF file").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });

  await expect(page.getByRole("button", { name: "Page 1" })).toBeVisible();
  await expect(mainCanvas(page)).toBeVisible();
}

export function mainCanvas(page: Page): ReturnType<Page["locator"]> {
  return page.locator('[data-testid="pdf-page-canvas"]').first();
}

/**
 * Open a restricted-but-not-secured PDF (an /Encrypt dict, empty user
 * password) and assert it ends up fully usable. Either it opens straight away
 * or the Repair dialog appears — this drives whichever real path the build
 * takes. Shared by the synthetic and real-document tiers of the restricted
 * acceptance in real-fixtures.canary.ts.
 */
export async function openRestrictedPdfExpectUsable(
  page: Page,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  await page.getByLabel("Open PDF file").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });

  const pageOne = page.getByRole("button", { name: "Page 1" });
  const repair = page.getByRole("button", { name: "Repair PDF" });
  await expect(async () => {
    expect((await pageOne.isVisible()) || (await repair.isVisible())).toBe(true);
  }).toPass({ timeout: 30_000 });

  if (await repair.isVisible()) {
    await expect(repair, "Repair must be actionable, not disabled").toBeEnabled();
    await repair.click();
  }

  // The end state the user cares about: the restricted PDF is open, rendered,
  // and fully usable — NOT treated as locked. (Print is a doc-dependent
  // action that's disabled in the empty state.)
  await expect(pageOne).toBeVisible({ timeout: 180_000 });
  await expect(mainCanvas(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Print" }),
    "a restricted-not-secured PDF should open fully usable, not locked",
  ).toBeEnabled();
}

export async function savePdf(page: Page): Promise<Uint8Array> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save" }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  if (!filePath) {
    throw new Error("Saved PDF download did not produce a local file.");
  }
  return new Uint8Array(await readFile(filePath));
}

// --- Fixtures -----------------------------------------------------------------

export async function createPdf(pageWidths: readonly number[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const width of pageWidths) {
    pdf.addPage([width, 300]);
  }
  return pdf.save();
}

export async function createTextPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 24, y: 240, size: 12, font });
  return pdf.save();
}

/** A larger, text-heavy multi-page PDF — useful as real compress/pdfa input. */
export async function createHeavyTextPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p += 1) {
    const page = pdf.addPage([612, 792]);
    for (let line = 0; line < 40; line += 1) {
      page.drawText(`Page ${p + 1} line ${line + 1}: the quick brown fox jumps over the lazy dog.`, {
        x: 48,
        y: 740 - line * 17,
        size: 10,
        font,
      });
    }
  }
  return pdf.save();
}

/** A landscape multi-page PDF — trips the filing "letter portrait" normalization. */
export async function createLandscapePdf(pageTexts: readonly string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pageTexts.forEach((text, index) => {
    const page = pdf.addPage([792, 612]);
    page.drawText(text, { x: 72, y: 520, size: 14, font });
    page.drawText(`Page ${index + 1} of ${pageTexts.length}`, { x: 72, y: 48, size: 10, font });
  });
  return pdf.save();
}

/**
 * A heavy landscape doc — enough bytes per page that a low custom split cap
 * yields several parts, and landscape so normalization must rotate it to
 * letter-portrait. Each page carries dense text so content streams are large.
 */
export async function createHeavyLandscapePdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p += 1) {
    const page = pdf.addPage([792, 612]);
    for (let line = 0; line < 34; line += 1) {
      page.drawText(
        `Page ${p + 1} line ${line + 1}: Motion for summary judgment and certificate of service — the quick brown fox.`,
        { x: 40, y: 560 - line * 16, size: 10, font },
      );
    }
  }
  return pdf.save();
}

/** Pad with trailing spaces (ignored after %%EOF) to force a size-based split. */
export function padToBytes(bytes: Uint8Array, targetBytes: number): Uint8Array {
  if (bytes.byteLength >= targetBytes) {
    return bytes;
  }
  return new Uint8Array(
    Buffer.concat([Buffer.from(bytes), Buffer.alloc(targetBytes - bytes.byteLength, 0x20)]),
  );
}

/**
 * A genuine IMAGE-ONLY PDF (no text layer) that Tesseract can read — a raster of
 * the letters "RAIO PDF" as a DeviceGray image XObject. Ported from the release
 * workflow's offline-OCR smoke fixture so the canary's OCR path feeds the real
 * toolchain something it must actually recognize.
 */
export function createImageOnlyPdf(): Uint8Array {
  const scale = 28;
  const glyphs: Record<string, string[]> = {
    R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    " ": ["000", "000", "000", "000", "000", "000", "000"],
  };
  const text = "RAIO PDF";
  const width = [...text].reduce((sum, ch) => sum + (glyphs[ch][0].length + 1) * scale, 0) + scale;
  const height = 9 * scale;
  const pixels = new Uint8Array(width * height).fill(255);
  let x = Math.floor(scale / 2);
  const y = scale;
  for (const ch of text) {
    const glyph = glyphs[ch];
    glyph.forEach((bits, row) => {
      [...bits].forEach((bit, col) => {
        if (bit === "1") {
          for (let yy = y + row * scale; yy < y + (row + 1) * scale; yy += 1) {
            const start = yy * width + x + col * scale;
            pixels.fill(0, start, start + scale);
          }
        }
      });
    });
    x += (glyph[0].length + 1) * scale;
  }

  // Assemble via Buffer chunks — never spread the multi-KB pixel array into
  // push()/concat args (that overflows the call stack).
  const content = latin1Bytes("q\n500 0 0 160 56 520 cm\n/Im1 Do\nQ\n");
  const imageStream = Buffer.concat([
    latin1Bytes(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
    ),
    Buffer.from(pixels),
    latin1Bytes("\nendstream"),
  ]);
  const contentStream = Buffer.concat([
    latin1Bytes(`<< /Length ${content.length} >>\nstream\n`),
    content,
    latin1Bytes("endstream"),
  ]);
  return assembleClassicPdf([
    latin1Bytes("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1Bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1Bytes("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"),
    imageStream,
    contentStream,
  ]);
}

// --- Local regression fixtures (real, uncommitted PDFs) -----------------------

const FIXTURES_LOCAL_DIR = process.env.RAIOPDF_CANARY_FIXTURES_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures.local");

// Default cap for tests that OPEN a file in the browser (pdf.js). It is NOT
// about the portal size limit — filing tests that split over-cap files pass a
// higher cap (see localFixtureNames' maxBytes). Only the truly enormous files
// (hundreds of MB / thousands of pages) that break pdf.js are excluded.
const BROWSER_OPEN_CAP_BYTES = 40 * 1024 * 1024;

/** All fixture files under the dir, recursively, as paths relative to it. */
function walkFixtures(dir: string, base = ""): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFixtures(path.join(dir, entry.name), rel));
    } else if (entry.isFile() || (entry.isSymbolicLink() && statSync(path.join(dir, entry.name)).isFile())) {
      out.push(rel);
    }
  }
  return out;
}

/** Load a gitignored local fixture by relative path, or null if absent. */
export function localFixture(name: string): Uint8Array | null {
  const filePath = path.join(FIXTURES_LOCAL_DIR, name);
  return existsSync(filePath) ? new Uint8Array(readFileSync(filePath)) : null;
}

/**
 * List local fixture paths whose BASENAME matches `pattern` (recursive), skipping
 * files over `maxBytes`. Browser-opened tests use the default cap; the filing
 * split test, whose whole point is genuinely-over-cap files, passes a high cap.
 */
export function localFixtureNames(pattern: RegExp, maxBytes = BROWSER_OPEN_CAP_BYTES): string[] {
  return walkFixtures(FIXTURES_LOCAL_DIR)
    .filter((rel) => pattern.test(path.basename(rel)))
    .filter((rel) => statSync(path.join(FIXTURES_LOCAL_DIR, rel)).size <= maxBytes)
    .sort();
}

/**
 * Load a whole exhibit SET: every PDF (under the size cap) inside the first
 * subfolder whose path matches `folderPattern`, sorted by name. For the
 * separate-files filing-packet test.
 */
export function localFixtureSet(folderPattern: RegExp): { name: string; bytes: Uint8Array }[] {
  return localFixtureSetUnder(folderPattern);
}

export function localFixtureSetUnder(
  folderPattern: RegExp,
  maxBytes = BROWSER_OPEN_CAP_BYTES,
): { name: string; bytes: Uint8Array }[] {
  const match = walkFixtures(FIXTURES_LOCAL_DIR).find(
    (rel) => folderPattern.test(rel) && rel.toLowerCase().endsWith(".pdf"),
  );
  if (!match) {
    return [];
  }
  const folder = path.dirname(match);
  return walkFixtures(FIXTURES_LOCAL_DIR)
    .filter((rel) => path.dirname(rel) === folder && rel.toLowerCase().endsWith(".pdf"))
    .filter((rel) => statSync(path.join(FIXTURES_LOCAL_DIR, rel)).size <= maxBytes)
    .sort()
    .map((rel) => ({ name: path.basename(rel), bytes: new Uint8Array(readFileSync(path.join(FIXTURES_LOCAL_DIR, rel))) }));
}

/**
 * Content-agnostic readability probe: how many times a very common word appears
 * via the app's own search. A readable legal doc has many "the"s; a
 * font-mismatch-garbled text layer has ~none. Returns 0 when nothing matches.
 */
export async function searchHitCount(page: Page, term: string): Promise<number> {
  const box = page.getByLabel("Search document");
  await box.fill("");
  await box.fill(term);
  const count = page.locator(".command-bar__search-count");
  try {
    // The count element appears immediately showing "Searching" / "Searching
    // N/M", and only resolves to a final "N of M" once indexing finishes. Wait
    // for that final label -- reading while it still says "Searching" (which
    // happens for slower-to-index documents) yields a spurious 0.
    await expect(count).toHaveText(/\bof\s+\d+/, { timeout: 20_000 });
  } catch {
    return 0; // no matches / search never resolved — no final "N of M" label
  }
  const text = (await count.textContent()) ?? "";
  const match = text.match(/of\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

/**
 * Save a real output artifact (a PDF a human should eyeball) into the run's
 * review folder and log a row in RESULT.md. No-op when RAIOPDF_CANARY_OUTPUT_DIR
 * isn't configured (e.g. CI / a contributor without the Drive folder).
 */
export function saveCanaryArtifact(testName: string, fileName: string, bytes: Uint8Array, note = ""): void {
  const dir = readEngineEndpoint().outputDir;
  if (!dir) {
    return;
  }
  const safe = fileName.replace(/[^\w.\- ]+/g, "_");
  writeFileSync(path.join(dir, safe), Buffer.from(bytes));
  appendFileSync(path.join(dir, "RESULT.md"), `| ${testName} | ${safe} | ${note} |\n`);
}

/** True when the PDF bytes contain a real text layer (a font / ToUnicode marker). */
export function hasTextLayer(bytes: Uint8Array): boolean {
  const haystack = Buffer.from(bytes).toString("latin1");
  return /\/Font|\/ToUnicode/.test(haystack);
}

/**
 * A realistic "scanned" (image-only) PDF: renders `text` with a real system font
 * onto a canvas, embeds it as a raster image, and returns a PDF with NO text
 * layer. Because the glyphs are crisp antialiased Arial (not a hand bitmap),
 * real Tesseract reads them back reliably — so a post-OCR search for a word from
 * `text` is a trustworthy "OCR made this readable" assertion.
 */
export async function createScannedPdf(page: Page, text: string): Promise<Uint8Array> {
  const dataUrl = await page.evaluate((value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 220;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable in the test browser.");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.font = "bold 96px Arial, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(value, 40, canvas.height / 2);
    return canvas.toDataURL("image/png");
  }, text);

  const pngBytes = Buffer.from(dataUrl.split(",")[1], "base64");
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(pngBytes);
  const pageDoc = pdf.addPage([612, 792]);
  pageDoc.drawImage(png, { x: 40, y: 560, width: 532, height: 84 });
  const bytes = await pdf.save();
  if (hasTextLayer(bytes)) {
    throw new Error("Scanned fixture unexpectedly contains a text layer.");
  }
  return bytes;
}

// --- PDF inspection (filing normalization + exhibit-binder stamps/outline) -----

export interface PageSize {
  width: number;
  height: number;
}

export async function pageSizes(bytes: Uint8Array): Promise<PageSize[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((p) => ({ width: Math.round(p.getWidth()), height: Math.round(p.getHeight()) }));
}

/** Letter portrait within a tolerance (normalization rounds/rescales slightly). */
export function isLetterPortrait({ width, height }: PageSize): boolean {
  return Math.abs(width - 612) <= 6 && Math.abs(height - 792) <= 6;
}

function encodeTextAsHex(text: string): string {
  // PDF simple fonts draw text one byte per glyph (WinAnsi/Latin-1), so encode
  // single-byte — NOT UTF-8, which would turn "§" (U+00A7) into two bytes (C2A7)
  // and never match the single 0xA7 byte the page content stream actually holds.
  return `<${[...text]
    .map((char) => (char.charCodeAt(0) & 0xff).toString(16).padStart(2, "0").toUpperCase())
    .join("")}>`;
}

function decodePdfStream(stream: PDFStream): string {
  if (stream instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }
  return new TextDecoder().decode(stream.getContents());
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

/**
 * Assert a stamped label (e.g. "Exhibit A", "SMITH000001") is drawn into a page's
 * content stream — tolerant of hex-encoded (`<...>`) or literal (`(...)`) PDF text.
 */
export async function expectPageStamp(bytes: Uint8Array, pageIndex: number, label: string): Promise<void> {
  const content = await readDecodedPageContent(bytes, pageIndex);
  const stamped = content.includes(encodeTextAsHex(label)) || content.includes(`(${label})`) || content.includes(label);
  expect(stamped, `page ${pageIndex} should be stamped "${label}"`).toBe(true);
}

export async function readOutlineTitles(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  const outlinesObject = pdf.catalog.get(PDFName.of("Outlines"));
  const outlines = outlinesObject instanceof PDFRef
    ? pdf.context.lookup(outlinesObject, PDFDict)
    : outlinesObject;
  if (!(outlines instanceof PDFDict)) {
    return [];
  }
  const titles: string[] = [];
  let itemRef = outlines.get(PDFName.of("First"));
  while (itemRef instanceof PDFRef) {
    const item = pdf.context.lookup(itemRef, PDFDict);
    titles.push(item.lookup(PDFName.of("Title"), PDFString, PDFHexString).decodeText());
    itemRef = item.get(PDFName.of("Next"));
  }
  return titles;
}
