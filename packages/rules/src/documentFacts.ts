import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import type {
  ActiveContentSignals,
  BuildDocumentFactsOptions,
  DocumentFactError,
  DocumentFactName,
  DocumentFacts,
  EncryptionState,
  FormFieldFacts,
  PageFacts,
  PossibleUnappliedRedactions,
} from "./types.js";

const POINTS_PER_INCH = 72;
const TEXT_DECODER = new TextDecoder("latin1");

/**
 * Build local document facts used by legal-workflow preflight checks. Detector
 * failures are recorded in `errors` and omitted from the fact payload, so
 * preflight can report unknown instead of treating an unreadable detector as a
 * pass or throwing away the whole report.
 */
export async function buildDocumentFacts(
  bytes: Uint8Array,
  options: BuildDocumentFactsOptions = {},
): Promise<DocumentFacts> {
  const errors: DocumentFactError[] = [];
  const encryptionState = detectEncryptionState(bytes);
  const base: DocumentFacts = {
    pages: [],
    fileBytes: bytes.byteLength,
    encryptionState,
  };

  if (encryptionState === "detector_failed") {
    errors.push({ fact: "pages", reason: "Encryption detection failed before PDF parsing." });
  }

  if (encryptionState === "encrypted" || encryptionState === "usage_restricted") {
    return withErrors({
      ...base,
      activeContentSignals: scanActiveContentSignals(bytes),
    }, [
      ...errors,
      detectorError("pages", "Encrypted PDFs are not parsed for page geometry here."),
      detectorError("embeddedFileCount", "Encrypted PDFs are not parsed for embedded-file facts here."),
      detectorError("formFields", "Encrypted PDFs are not parsed for form-field facts here."),
      detectorError("annotationCount", "Encrypted PDFs are not parsed for annotation facts here."),
      detectorError("signatureFieldCount", "Encrypted PDFs are not parsed for signature-field facts here."),
      detectorError("possibleUnappliedRedactions", "Encrypted PDFs are not parsed for redaction-annotation facts here."),
      detectorError("textLayerCoverage", "Encrypted PDFs are not parsed for text-layer coverage here."),
    ]);
  }

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return withErrors(base, [
      ...errors,
      detectorError("pages", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("activeContentSignals", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("embeddedFileCount", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("formFields", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("annotationCount", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("signatureFieldCount", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("possibleUnappliedRedactions", `PDF parsing failed: ${errorMessage(error)}`),
      detectorError("textLayerCoverage", `PDF parsing failed: ${errorMessage(error)}`),
    ]);
  }

  const facts: DocumentFacts = {
    ...base,
    pages: readPageFacts(pdf),
  };

  try {
    facts.activeContentSignals = readActiveContentSignals(pdf, bytes);
  } catch (error) {
    errors.push(detectorError("activeContentSignals", errorMessage(error)));
  }

  try {
    facts.embeddedFileCount = countEmbeddedFiles(pdf);
  } catch (error) {
    errors.push(detectorError("embeddedFileCount", errorMessage(error)));
  }

  try {
    facts.formFields = readFormFields(pdf);
    facts.signatureFieldCount = countSignatureFields(pdf);
  } catch (error) {
    errors.push(detectorError("formFields", errorMessage(error)));
    errors.push(detectorError("signatureFieldCount", errorMessage(error)));
  }

  try {
    const annotationFacts = readAnnotationFacts(pdf);
    facts.annotationCount = annotationFacts.annotationCount;
    facts.possibleUnappliedRedactions = annotationFacts.possibleUnappliedRedactions;
  } catch (error) {
    errors.push(detectorError("annotationCount", errorMessage(error)));
    errors.push(detectorError("possibleUnappliedRedactions", errorMessage(error)));
  }

  if (options.textExtractor) {
    try {
      facts.textLayerCoverage = await options.textExtractor.extractTextLayerCoverage(bytes);
      // Page-body text only, and every page must have it — one text page must
      // not make an otherwise image-only scan look searchable. A poisoned text
      // layer is also not verified-searchable, even when text is present.
      facts.searchableText = facts.pages.length > 0 &&
        facts.textLayerCoverage.imageOnlyPages.length === 0 &&
        facts.textLayerCoverage.garbledPages.length === 0;
    } catch (error) {
      errors.push(detectorError("textLayerCoverage", errorMessage(error)));
      try {
        const pageText = await options.textExtractor.extractPageTextByPage?.(bytes);
        if (pageText) {
          facts.searchableText = pageText.length > 0 &&
            pageText.every((page) => page.text.trim().length > 0);
        }
      } catch {
        // searchableText is derived from the same pdf.js detector family; leave it unknown.
      }
    }

    try {
      const pageText = await options.textExtractor.extractPageTextByPage?.(bytes);
      if (pageText) {
        facts.pageTextByPage = pageText;
      }
    } catch {
      // Text-body extraction is advisory for pack-declared phrase checks. Keep
      // text-layer coverage facts intact so preflight can report unknown.
    }
  }

  return withErrors(facts, errors);
}

export function detectEncryptionState(bytes: Uint8Array): EncryptionState {
  try {
    const source = TEXT_DECODER.decode(bytes);
    const encryptValue = findEncryptTrailerValue(source);

    if (!encryptValue) {
      return "none";
    }

    if (/^null\b/.test(encryptValue.trim())) {
      return "none";
    }

    const encryptDictionary = resolveEncryptDictionary(source, encryptValue);
    if (encryptDictionary && /\/P\b/.test(encryptDictionary) && !/\/[UO]\b/.test(encryptDictionary)) {
      return "usage_restricted";
    }

    return "encrypted";
  } catch {
    return "detector_failed";
  }
}

function readPageFacts(pdf: PDFDocument): PageFacts[] {
  return pdf.getPages().map((page, pageIndex) => {
    const rawWidthIn = page.getWidth() / POINTS_PER_INCH;
    const rawHeightIn = page.getHeight() / POINTS_PER_INCH;
    const rotation = normalizeRotation(page.getRotation().angle);
    const sideways = rotation === 90 || rotation === 270;
    const widthIn = sideways ? rawHeightIn : rawWidthIn;
    const heightIn = sideways ? rawWidthIn : rawHeightIn;

    return {
      pageIndex,
      size: { w: widthIn, h: heightIn, in: true },
      orientation: heightIn >= widthIn ? "portrait" : "landscape",
    };
  });
}

function readActiveContentSignals(pdf: PDFDocument, bytes: Uint8Array): ActiveContentSignals {
  const signals = new Set(scanActiveContentSignals(bytes).signals);

  if (pdf.catalog.has(PDFName.of("OpenAction"))) {
    signals.add("catalog.OpenAction");
  }

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const dict = asDict(object);
    if (!dict) {
      continue;
    }

    if (dict.has(PDFName.of("AA"))) {
      signals.add("additionalActions");
    }

    const names = dict.lookupMaybe(PDFName.of("Names"), PDFDict);
    if (names?.has(PDFName.of("JavaScript")) || dict.has(PDFName.of("JavaScript"))) {
      signals.add("javascriptNameTree");
    }

    if (nameValue(dict.lookupMaybe(PDFName.of("S"), PDFName)) === "JavaScript") {
      signals.add("javascriptAction");
    }

    if (nameValue(dict.lookupMaybe(PDFName.of("S"), PDFName)) === "Launch" || dict.has(PDFName.of("Launch"))) {
      signals.add("launchAction");
    }
  }

  return { possiblyPresent: signals.size > 0, signals: [...signals].sort() };
}

function scanActiveContentSignals(bytes: Uint8Array): ActiveContentSignals {
  const source = TEXT_DECODER.decode(bytes);
  const signals = new Set<string>();

  if (/\/OpenAction\b/.test(source)) {
    signals.add("catalog.OpenAction");
  }
  if (/\/AA\b/.test(source)) {
    signals.add("additionalActions");
  }
  if (/\/JavaScript\b/.test(source)) {
    signals.add("javascriptNameTree");
  }
  if (/\/S\s*\/JavaScript\b/.test(source)) {
    signals.add("javascriptAction");
  }
  if (/\/S\s*\/Launch\b|\/Launch\b/.test(source)) {
    signals.add("launchAction");
  }

  return { possiblyPresent: signals.size > 0, signals: [...signals].sort() };
}

function countEmbeddedFiles(pdf: PDFDocument): number {
  const names = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const embeddedFiles = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  return countNameTreeEntries(embeddedFiles) + readAnnotationFacts(pdf).fileAttachmentAnnotationCount;
}

function countNameTreeEntries(node: PDFDict | undefined): number {
  if (!node) {
    return 0;
  }

  const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
  const directCount = names ? Math.floor(names.size() / 2) : 0;
  const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);

  if (!kids) {
    return directCount;
  }

  let childCount = 0;
  for (let index = 0; index < kids.size(); index += 1) {
    childCount += countNameTreeEntries(kids.lookupMaybe(index, PDFDict));
  }
  return directCount + childCount;
}

function readFormFields(pdf: PDFDocument): FormFieldFacts {
  const fields = pdf.catalog.AcroForm()?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    return { count: 0, anyFilled: false };
  }

  let count = 0;
  let anyFilled = false;

  for (let index = 0; index < fields.size(); index += 1) {
    const result = readField(fields.lookupMaybe(index, PDFDict), {});
    count += result.count;
    anyFilled ||= result.anyFilled;
  }

  return { count, anyFilled };
}

function countSignatureFields(pdf: PDFDocument): number {
  const fields = pdf.catalog.AcroForm()?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    return 0;
  }

  let count = 0;
  for (let index = 0; index < fields.size(); index += 1) {
    count += readField(fields.lookupMaybe(index, PDFDict), {}).signatureCount;
  }
  return count;
}

function readField(
  field: PDFDict | undefined,
  inherited: { fieldType?: string; value?: PDFObject },
): { count: number; anyFilled: boolean; signatureCount: number } {
  if (!field) {
    return { count: 0, anyFilled: false, signatureCount: 0 };
  }

  const fieldType = nameValue(field.lookupMaybe(PDFName.of("FT"), PDFName)) ?? inherited.fieldType;
  const value = field.get(PDFName.of("V")) ?? inherited.value;
  const kids = field.lookupMaybe(PDFName.of("Kids"), PDFArray);

  if (kids && !fieldType) {
    let count = 0;
    let anyFilled = isFilledValue(value);
    let signatureCount = 0;
    for (let index = 0; index < kids.size(); index += 1) {
      const childInherited: { fieldType?: string; value?: PDFObject } = {};
      if (fieldType !== undefined) {
        childInherited.fieldType = fieldType;
      }
      if (value !== undefined) {
        childInherited.value = value;
      }
      const child = readField(kids.lookupMaybe(index, PDFDict), childInherited);
      count += child.count;
      anyFilled ||= child.anyFilled;
      signatureCount += child.signatureCount;
    }
    return { count, anyFilled, signatureCount };
  }

  if (!fieldType) {
    return { count: 0, anyFilled: false, signatureCount: 0 };
  }

  return {
    count: 1,
    anyFilled: isFilledValue(value),
    signatureCount: fieldType === "Sig" ? 1 : 0,
  };
}

function readAnnotationFacts(pdf: PDFDocument): {
  annotationCount: number;
  fileAttachmentAnnotationCount: number;
  possibleUnappliedRedactions: PossibleUnappliedRedactions;
} {
  let annotationCount = 0;
  let fileAttachmentAnnotationCount = 0;
  let redactAnnotationCount = 0;
  let blackRectangleAnnotationCount = 0;

  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    if (!annots) {
      continue;
    }

    annotationCount += annots.size();
    for (let index = 0; index < annots.size(); index += 1) {
      const annotation = annots.lookupMaybe(index, PDFDict);
      const subtype = nameValue(annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName));

      if (subtype === "FileAttachment") {
        fileAttachmentAnnotationCount += 1;
      }
      if (subtype === "Redact") {
        redactAnnotationCount += 1;
      }
      if (subtype === "Square" && hasOpaqueBlackInterior(annotation)) {
        blackRectangleAnnotationCount += 1;
      }
    }
  }

  return {
    annotationCount,
    fileAttachmentAnnotationCount,
    possibleUnappliedRedactions: {
      redactAnnotationCount,
      blackRectangleAnnotationCount,
      possiblyPresent: redactAnnotationCount + blackRectangleAnnotationCount > 0,
    },
  };
}

function hasOpaqueBlackInterior(annotation: PDFDict | undefined): boolean {
  const interiorColor = annotation?.lookupMaybe(PDFName.of("IC"), PDFArray);
  if (!interiorColor || interiorColor.size() < 3) {
    return false;
  }

  const channels = [0, 1, 2].map((index) => interiorColor.lookupMaybe(index, PDFNumber)?.asNumber());
  const isBlack = channels.every((value) => value !== undefined && value <= 0.05);
  const alpha = annotation?.lookupMaybe(PDFName.of("CA"), PDFNumber)?.asNumber() ?? 1;

  return isBlack && alpha >= 0.95;
}

function findEncryptTrailerValue(source: string): string | null {
  const trailerMatches = [...source.matchAll(/trailer\s*<</g)];
  for (let index = trailerMatches.length - 1; index >= 0; index -= 1) {
    const match = trailerMatches[index];
    if (match?.index === undefined) {
      continue;
    }
    const dictStart = source.indexOf("<<", match.index);
    const dict = readBalancedDictionary(source, dictStart);
    const value = dict ? readNameValue(dict, "Encrypt") : null;
    if (value) {
      return value;
    }
  }

  const fallback = source.match(/\/Encrypt\b\s+(null\b|\d+\s+\d+\s+R|<<[\s\S]*?>>)/);
  return fallback?.[1] ?? null;
}

function resolveEncryptDictionary(source: string, encryptValue: string): string | null {
  const trimmed = encryptValue.trim();
  if (trimmed.startsWith("<<")) {
    return trimmed;
  }

  const ref = trimmed.match(/^(\d+)\s+(\d+)\s+R\b/);
  if (!ref) {
    return null;
  }

  const objectPattern = new RegExp(`\\b${ref[1]}\\s+${ref[2]}\\s+obj\\s*<<`);
  const objectMatch = objectPattern.exec(source);
  if (objectMatch?.index === undefined) {
    return null;
  }

  const dictStart = source.indexOf("<<", objectMatch.index);
  return readBalancedDictionary(source, dictStart);
}

function readBalancedDictionary(source: string, start: number): string | null {
  if (start < 0 || source.slice(start, start + 2) !== "<<") {
    return null;
  }

  let depth = 0;
  for (let index = start; index < source.length - 1; index += 1) {
    const pair = source.slice(index, index + 2);
    if (pair === "<<") {
      depth += 1;
      index += 1;
    } else if (pair === ">>") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

function readNameValue(dictionary: string, name: string): string | null {
  const nameMatch = new RegExp(`/${name}\\b`).exec(dictionary);
  if (!nameMatch) {
    return null;
  }

  const valueStart = nameMatch.index + nameMatch[0].length;
  const value = dictionary.slice(valueStart).trimStart();
  if (value.startsWith("<<")) {
    return readBalancedDictionary(value, 0);
  }

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? null : value.slice(0, end + 1);
  }

  const match = value.match(/^(null\b|\d+\s+\d+\s+R|\/\S+|\S+)/);
  return match?.[1] ?? null;
}

function isFilledValue(value: PDFObject | undefined): boolean {
  if (!value || value === PDFNull) {
    return false;
  }

  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText().trim().length > 0;
  }

  if (value instanceof PDFName) {
    return value.decodeText() !== "Off";
  }

  if (value instanceof PDFBool) {
    return value.asBoolean();
  }

  if (value instanceof PDFArray) {
    return value.asArray().some(isFilledValue);
  }

  if (value instanceof PDFNumber) {
    return true;
  }

  if (value instanceof PDFRef) {
    return true;
  }

  return value.toString().trim().length > 0;
}

function asDict(object: PDFObject): PDFDict | undefined {
  return object instanceof PDFDict ? object : undefined;
}

function nameValue(name: PDFName | undefined): string | undefined {
  return name?.decodeText();
}

function normalizeRotation(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function withErrors(facts: DocumentFacts, errors: readonly DocumentFactError[]): DocumentFacts {
  return errors.length === 0 ? facts : { ...facts, errors };
}

function detectorError(fact: DocumentFactName, reason: string): DocumentFactError {
  return { fact, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
