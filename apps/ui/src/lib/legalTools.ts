import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
} from "pdf-lib";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { PDFDocumentProxy } from "./pdfjs";

export type LegalScanCategory =
  | "SSN"
  | "Bank / Account"
  | "Credit Card"
  | "Driver License"
  | "Birth Date";
export type LegalScanConfidence = "high" | "lower";

export interface ExtractedTextBox {
  pageIndex: number;
  text: string;
  area: PdfRedactionArea;
}

export interface SensitiveHit {
  id: string;
  category: LegalScanCategory;
  confidence: LegalScanConfidence;
  pageIndex: number;
  excerpt: string;
  area: PdfRedactionArea;
}

export interface PdfMetadataSummary {
  rows: ReadonlyArray<{ label: string; value: string }>;
  removedFields: readonly string[];
}

export type RedactionVerificationStatus = "pass" | "fail" | "skipped";

export interface RedactionVerificationCheck {
  status: RedactionVerificationStatus;
  detail: string;
}

export interface RedactionVerificationResult {
  ok: boolean;
  textLayer: RedactionVerificationCheck;
  rasterizedPages: RedactionVerificationCheck;
  annotations: RedactionVerificationCheck;
  metadata: RedactionVerificationCheck;
}

type TextItemLike = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  hasEOL?: unknown;
};

const REDACTION_PADDING_PT = 2;

const SCAN_PATTERNS: ReadonlyArray<{
  category: LegalScanCategory;
  confidence?: LegalScanConfidence;
  regex: RegExp;
}> = [
  { category: "SSN", regex: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g },
  { category: "SSN", confidence: "lower", regex: /\b\d{9}\b/g },
  {
    category: "Bank / Account",
    regex: /\b(?:account|acct|routing|aba)\b[^\n]{0,32}?\b\d{4,17}\b/gi,
  },
  {
    category: "Credit Card",
    regex: /\b(?:\d[ -]?){13,16}\b/g,
  },
  {
    category: "Driver License",
    regex: /\b(?:driver(?:'s)? license|dl)\b[^\n]{0,24}?\b[A-Z0-9-]{5,18}\b/gi,
  },
  {
    category: "Birth Date",
    regex: /\b(?:dob|date of birth)\b[^\n]{0,16}?\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
  },
];

export async function extractTextBoxes(
  pdfDocument: PDFDocumentProxy,
): Promise<ExtractedTextBox[]> {
  const boxes: ExtractedTextBox[] = [];
  const pages = await extractPageText(pdfDocument);

  for (const page of pages) {
    for (const span of page.spans) {
      boxes.push({
        pageIndex: page.pageIndex,
        text: page.text.slice(span.start, span.end),
        area: span.area,
      });
    }
  }

  return boxes;
}

export async function findTextRedactionAreas(
  pdfDocument: PDFDocumentProxy,
  query: string,
): Promise<PdfRedactionArea[]> {
  const pages = await extractPageText(pdfDocument);

  return findTextRedactionAreasInPages(pages, query);
}

export function findTextRedactionAreasInPages(
  pages: readonly ExtractedPageText[],
  query: string,
): PdfRedactionArea[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const queryPattern = new RegExp(
    escapeRegExp(normalizedQuery).replace(/\s+/g, "\\s+"),
    "g",
  );
  const areas: PdfRedactionArea[] = [];

  for (const page of pages) {
    const normalizedPageText = page.text.toLowerCase();
    queryPattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = queryPattern.exec(normalizedPageText)) !== null) {
      const matchedText = match[0] ?? "";

      if (!matchedText) {
        queryPattern.lastIndex += 1;
        continue;
      }

      const area = areaForTextRange(page, match.index, match.index + matchedText.length);

      if (area) {
        areas.push(area);
      }
    }
  }

  return areas;
}

export async function scanSensitivePatterns(
  pdfDocument: PDFDocumentProxy,
): Promise<SensitiveHit[]> {
  const pages = await extractPageText(pdfDocument);
  const hits: SensitiveHit[] = [];

  pages.forEach((page) => {
    for (const pattern of SCAN_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(page.text)) !== null) {
        const matchedText = match[0] ?? "";
        const area = areaForTextRange(page, match.index, match.index + matchedText.length);

        if (!area) {
          continue;
        }

        if (
          pattern.category === "Credit Card" &&
          !looksLikeCreditCard(matchedText)
        ) {
          continue;
        }

        hits.push({
          id: `${page.pageIndex}-${pattern.category}-${match.index}`,
          category: pattern.category,
          confidence: pattern.confidence ?? "high",
          pageIndex: page.pageIndex,
          excerpt: maskExcerpt(page.text, match.index, matchedText.length),
          area,
        });
      }
    }
  });

  return hits;
}

interface TextSpan {
  start: number;
  end: number;
  area: PdfRedactionArea;
}

export interface ExtractedPageText {
  pageIndex: number;
  text: string;
  spans: TextSpan[];
}

export async function extractPageText(pdfDocument: PDFDocumentProxy): Promise<ExtractedPageText[]> {
  const pages: ExtractedPageText[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const spans: TextSpan[] = [];
    let text = "";
    let previousTextItem: TextItemLike | null = null;

    for (const rawItem of textContent.items) {
      const item = rawItem as TextItemLike;
      const itemText = typeof item.str === "string" ? item.str : "";

      if (previousTextItem && itemText) {
        text += inferTextSeparator(previousTextItem, item);
      }

      const start = text.length;
      text += itemText;
      const end = text.length;

      if (itemText.trim()) {
        const area = textItemToRedactionArea(item, pageNumber - 1);

        if (area) {
          spans.push({ start, end, area });
        }
      }

      if (item.hasEOL === true && text && !text.endsWith("\n")) {
        text += "\n";
      }

      if (!itemText) {
        continue;
      }

      previousTextItem = item;
    }

    pages.push({
      pageIndex: pageNumber - 1,
      text,
      spans,
    });
  }

  return pages;
}

function inferTextSeparator(previous: TextItemLike, current: TextItemLike): "" | " " | "\n" {
  const previousText = typeof previous.str === "string" ? previous.str : "";
  const currentText = typeof current.str === "string" ? current.str : "";

  if (
    !previousText ||
    !currentText ||
    /\s$/.test(previousText) ||
    /^\s/.test(currentText) ||
    previous.hasEOL === true
  ) {
    return "";
  }

  const previousMetrics = getTextItemMetrics(previous);
  const currentMetrics = getTextItemMetrics(current);

  if (!previousMetrics || !currentMetrics) {
    return "";
  }

  const lineThreshold = Math.max(previousMetrics.height, currentMetrics.height, 8) * 0.5;

  if (Math.abs(previousMetrics.y - currentMetrics.y) > lineThreshold) {
    return "\n";
  }

  const gap = currentMetrics.x - (previousMetrics.x + previousMetrics.width);
  const spaceThreshold = Math.max(1, Math.max(previousMetrics.height, currentMetrics.height, 8) * 0.15);

  return gap > spaceThreshold ? " " : "";
}

function getTextItemMetrics(
  item: TextItemLike,
): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(item.transform) || item.transform.length < 6) {
    return null;
  }

  const transform = item.transform;
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  const width = Number(item.width);
  const transformHeight = Math.abs(Number(transform[3]));
  const itemHeight = Number(item.height);
  const height = Math.max(
    Number.isFinite(itemHeight) ? Math.abs(itemHeight) : 0,
    Number.isFinite(transformHeight) ? transformHeight : 0,
    8,
  );

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return { x, y, width, height };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function areaForTextRange(
  page: ExtractedPageText,
  start: number,
  end: number,
): PdfRedactionArea | null {
  const matchingSpans = page.spans.filter((span) => span.start < end && span.end > start);

  if (matchingSpans.length === 0) {
    return null;
  }

  return matchingSpans
    .map((span) => span.area)
    .reduce(unionAreas);
}

function unionAreas(left: PdfRedactionArea, right: PdfRedactionArea): PdfRedactionArea {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.w, right.x + right.w);
  const maxY = Math.max(left.y + left.h, right.y + right.h);

  return {
    pageIndex: left.pageIndex,
    x,
    y,
    w: Math.max(1, maxX - x),
    h: Math.max(1, maxY - y),
  };
}

export async function verifyRedactionAreasClear(
  bytes: Uint8Array,
  areas: readonly PdfRedactionArea[],
  redactedTerms: readonly string[] = [],
): Promise<RedactionVerificationResult> {
  if (areas.length === 0) {
    return redactionVerificationResult({
      textLayer: pass("No redaction areas were marked."),
      rasterizedPages: pass("No redaction pages were marked."),
      annotations: pass("No redaction pages were marked."),
      metadata: pass("Document metadata is scrubbed."),
    });
  }

  const uniqueTerms = uniqueRedactionTerms(redactedTerms);
  const textLayer = await verifyFullDocumentTextLayer(bytes, uniqueTerms);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const redactedPageIndexes = uniquePageIndexes(areas);

  return redactionVerificationResult({
    textLayer,
    rasterizedPages: verifyRasterizedPages(pdf, redactedPageIndexes),
    annotations: verifyRedactedPageAnnotations(pdf, redactedPageIndexes),
    metadata: verifyDocumentMetadataScrubbed(pdf),
  });
}

export async function collectRedactionAreaTexts(
  pdfDocument: PDFDocumentProxy,
  areas: readonly PdfRedactionArea[],
): Promise<readonly string[]> {
  if (areas.length === 0) {
    return [];
  }

  const boxes = await extractTextBoxes(pdfDocument);

  return uniqueRedactionTerms(
    boxes
      .filter((box) => box.text.trim().length > 0)
      .filter((box) => areas.some((area) => areasIntersect(box.area, area)))
      .map((box) => box.text),
  );
}

export async function readMetadataSummary(
  bytes: Uint8Array,
): Promise<PdfMetadataSummary> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const rows = [
    { label: "Title", value: pdf.getTitle() ?? "" },
    { label: "Author", value: pdf.getAuthor() ?? "" },
    { label: "Creator", value: pdf.getCreator() ?? "" },
    { label: "Producer", value: pdf.getProducer() ?? "" },
    { label: "Created", value: formatPdfDate(pdf.getCreationDate()) },
    { label: "Modified", value: formatPdfDate(pdf.getModificationDate()) },
    { label: "Custom fields", value: "0" },
  ];

  return {
    rows: rows.map((row) => ({
      ...row,
      value: row.value || "Not set",
    })),
    removedFields: rows
      .filter((row) => row.value && row.value !== "0")
      .map((row) => row.label),
  };
}

function textItemToRedactionArea(
  item: TextItemLike,
  pageIndex: number,
): PdfRedactionArea | null {
  if (!Array.isArray(item.transform) || item.transform.length < 6) {
    return null;
  }

  const transform = item.transform;
  const x = Number(transform[4]);
  const baselineY = Number(transform[5]);
  const width = Number(item.width);
  const transformHeight = Math.abs(Number(transform[3]));
  const itemHeight = Number(item.height);
  const height = Math.max(
    Number.isFinite(itemHeight) ? Math.abs(itemHeight) : 0,
    Number.isFinite(transformHeight) ? transformHeight : 0,
    8,
  );

  if (!Number.isFinite(x) || !Number.isFinite(baselineY) || !Number.isFinite(width)) {
    return null;
  }

  return {
    pageIndex,
    x: Math.max(0, x - REDACTION_PADDING_PT),
    y: Math.max(0, baselineY - height * 0.35 - REDACTION_PADDING_PT),
    w: Math.max(1, width + REDACTION_PADDING_PT * 2),
    h: Math.max(1, height * 1.35 + REDACTION_PADDING_PT * 2),
  };
}

function maskExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 18);
  const end = Math.min(text.length, matchIndex + matchLength + 18);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";
  const before = text.slice(start, matchIndex);
  const match = text.slice(matchIndex, matchIndex + matchLength);
  const after = text.slice(matchIndex + matchLength, end);

  return `${prefix}${before}${maskSensitiveText(match)}${after}${suffix}`;
}

function maskSensitiveText(text: string): string {
  const visible = text.match(/[A-Za-z0-9]/g)?.slice(-4).join("") ?? "";
  const masked = text.replace(/[A-Za-z0-9]/g, "•");

  if (!visible) {
    return masked;
  }

  let remainingVisible = visible.length;

  return [...masked].reverse().map((character, index) => {
    const sourceCharacter = [...text].reverse()[index] ?? "";

    if (remainingVisible > 0 && /[A-Za-z0-9]/.test(sourceCharacter)) {
      remainingVisible -= 1;
      return sourceCharacter;
    }

    return character;
  }).reverse().join("");
}

function looksLikeCreditCard(value: string): boolean {
  const digits = value.replace(/\D/g, "");

  if (digits.length < 13 || digits.length > 16) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function areasIntersect(left: PdfRedactionArea, right: PdfRedactionArea): boolean {
  if (left.pageIndex !== right.pageIndex) {
    return false;
  }

  return !(
    left.x + left.w <= right.x ||
    right.x + right.w <= left.x ||
    left.y + left.h <= right.y ||
    right.y + right.h <= left.y
  );
}

async function verifyFullDocumentTextLayer(
  bytes: Uint8Array,
  terms: readonly string[],
): Promise<RedactionVerificationCheck> {
  if (terms.length === 0) {
    return skipped("No source text was extractable from the marked redaction areas.");
  }

  try {
    const { loadPdfDocument } = await import("./pdfjs");
    const pdfDocument = await loadPdfDocument(bytes);

    try {
      const pages = await extractPageText(pdfDocument);
      const documentText = normalizeSearchText(pages.map((page) => page.text).join("\n"));
      const remainingTerm = terms.find((term) => documentText.includes(normalizeSearchText(term)));

      if (remainingTerm) {
        return fail(`Text layer still contains "${remainingTerm}".`);
      }

      return pass("Text layer verified clean across the full document.");
    } finally {
      await pdfDocument.loadingTask.destroy();
    }
  } catch (error) {
    return fail(`Text layer verification could not run: ${errorMessage(error)}`);
  }
}

function verifyRasterizedPages(
  pdf: PDFDocument,
  pageIndexes: readonly number[],
): RedactionVerificationCheck {
  const pagesWithTextOperators = pageIndexes.filter((pageIndex) => {
    return hasTextShowingOperator(readDecodedPageContent(pdf, pageIndex));
  });

  if (pagesWithTextOperators.length > 0) {
    return fail(`Redacted pages still contain text operators: ${formatPageNumbers(pagesWithTextOperators)}.`);
  }

  return pass("Redacted page images replaced; no text operators remain on redacted pages.");
}

function verifyRedactedPageAnnotations(
  pdf: PDFDocument,
  pageIndexes: readonly number[],
): RedactionVerificationCheck {
  const pagesWithAnnotations = pageIndexes.filter((pageIndex) => {
    const annotations = pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    return annotations !== undefined && annotations.size() > 0;
  });

  if (pagesWithAnnotations.length > 0) {
    return fail(`Annotations remain on redacted pages: ${formatPageNumbers(pagesWithAnnotations)}.`);
  }

  return pass("Annotations cleaned on redacted pages.");
}

function verifyDocumentMetadataScrubbed(pdf: PDFDocument): RedactionVerificationCheck {
  if (pdf.context.trailerInfo.Info !== undefined || pdf.catalog.has(PDFName.of("Metadata"))) {
    return fail("Document metadata remains after redaction.");
  }

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.has(PDFName.of("Metadata"))) {
      return fail("Nested metadata remains after redaction.");
    }
  }

  return pass("Document metadata scrubbed after redaction.");
}

function readDecodedPageContent(pdf: PDFDocument, pageIndex: number): string {
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects =
    contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];

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

function hasTextShowingOperator(content: string): boolean {
  return /(?:^|\s)(?:Tj|TJ|'|")(?=\s|$)/.test(content);
}

function uniqueRedactionTerms(terms: readonly string[]): readonly string[] {
  return [...new Set(terms.map(normalizeDisplayText).filter(Boolean))];
}

function uniquePageIndexes(areas: readonly PdfRedactionArea[]): readonly number[] {
  return [...new Set(areas.map((area) => area.pageIndex))].sort((a, b) => a - b);
}

function redactionVerificationResult(
  checks: Omit<RedactionVerificationResult, "ok">,
): RedactionVerificationResult {
  return {
    ...checks,
    ok: Object.values(checks).every((check) => check.status !== "fail"),
  };
}

function pass(detail: string): RedactionVerificationCheck {
  return { status: "pass", detail };
}

function fail(detail: string): RedactionVerificationCheck {
  return { status: "fail", detail };
}

function skipped(detail: string): RedactionVerificationCheck {
  return { status: "skipped", detail };
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(text: string): string {
  return normalizeDisplayText(text).toLocaleLowerCase();
}

function formatPageNumbers(pageIndexes: readonly number[]): string {
  return pageIndexes.map((pageIndex) => pageIndex + 1).join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPdfDate(date: Date | undefined): string {
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
}
