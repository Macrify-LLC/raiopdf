import { PDFDocument } from "pdf-lib";
import type { PdfRedactionArea } from "@raiopdf/engine-api";
import type { PDFDocumentProxy } from "./pdfjs";

export type LegalScanCategory =
  | "SSN"
  | "Bank / Account"
  | "Credit Card"
  | "Driver License"
  | "Birth Date";

export interface ExtractedTextBox {
  pageIndex: number;
  text: string;
  area: PdfRedactionArea;
}

export interface SensitiveHit {
  id: string;
  category: LegalScanCategory;
  pageIndex: number;
  excerpt: string;
  area: PdfRedactionArea;
}

export interface PdfMetadataSummary {
  rows: ReadonlyArray<{ label: string; value: string }>;
  removedFields: readonly string[];
}

type TextItemLike = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

const REDACTION_PADDING_PT = 2;

const SCAN_PATTERNS: ReadonlyArray<{
  category: LegalScanCategory;
  regex: RegExp;
}> = [
  { category: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
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

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();

    for (const rawItem of textContent.items) {
      const item = rawItem as TextItemLike;
      const text = typeof item.str === "string" ? item.str : "";

      if (!text.trim()) {
        continue;
      }

      const area = textItemToRedactionArea(item, pageNumber - 1);

      if (area) {
        boxes.push({ pageIndex: pageNumber - 1, text, area });
      }
    }
  }

  return boxes;
}

export async function findTextRedactionAreas(
  pdfDocument: PDFDocumentProxy,
  query: string,
): Promise<PdfRedactionArea[]> {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const boxes = await extractTextBoxes(pdfDocument);

  return boxes
    .filter((box) => box.text.toLowerCase().includes(normalizedQuery))
    .map((box) => box.area);
}

export async function scanSensitivePatterns(
  pdfDocument: PDFDocumentProxy,
): Promise<SensitiveHit[]> {
  const boxes = await extractTextBoxes(pdfDocument);
  const hits: SensitiveHit[] = [];

  boxes.forEach((box, boxIndex) => {
    for (const pattern of SCAN_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(box.text)) !== null) {
        const matchedText = match[0] ?? "";

        if (
          pattern.category === "Credit Card" &&
          !looksLikeCreditCard(matchedText)
        ) {
          continue;
        }

        hits.push({
          id: `${box.pageIndex}-${boxIndex}-${pattern.category}-${match.index}`,
          category: pattern.category,
          pageIndex: box.pageIndex,
          excerpt: maskExcerpt(box.text, match.index, matchedText.length),
          area: box.area,
        });
      }
    }
  });

  return hits;
}

export async function verifyRedactionAreasClear(
  bytes: Uint8Array,
  areas: readonly PdfRedactionArea[],
): Promise<boolean> {
  if (areas.length === 0) {
    return true;
  }

  const { loadPdfDocument } = await import("./pdfjs");
  const pdfDocument = await loadPdfDocument(bytes);

  try {
    const boxes = await extractTextBoxes(pdfDocument);

    return !boxes.some((box) => {
      return areas.some((area) => {
        return box.text.trim().length > 0 && areasIntersect(box.area, area);
      });
    });
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
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
