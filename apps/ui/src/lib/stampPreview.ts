import type { PdfTextMeasureFont } from "@raiopdf/engine-api";
import { TEXT_BOX_LINE_HEIGHT } from "./edits";

/**
 * On-screen geometry for an exhibit sticker, mirroring what the engine draws.
 *
 * The engine centers the label inside the box and shrinks it in fixed steps
 * until it fits (`fitStampLines` in `engine-local`). The overlay has to reach
 * the same numbers or a placed stamp jumps size the moment it is saved, so
 * these constants and the shrink loop are deliberate copies of the engine's.
 */

/** Gap between the inside of the border and the label block. */
export const STAMP_TEXT_PADDING_PT = 2;
/** Floor for shrink-to-fit; below this the label stops being legible in print. */
export const MIN_STAMP_FONT_SIZE_PT = 6;
const STAMP_FONT_SIZE_STEP_PT = 0.5;
/** A border thicker than this fraction of the short side would eat the label. */
const STAMP_MAX_BORDER_WIDTH_FRACTION = 0.25;

export interface StampPreviewLayout {
  /** Border thickness actually drawn, after the short-side clamp. */
  borderWidthPt: number;
  /** Corner rounding actually drawn, after the half-short-side clamp. */
  cornerRadiusPt: number;
  /** Label size after shrink-to-fit. */
  fontSizePt: number;
  /** Lines after shrink-to-fit; surplus lines are dropped at the floor. */
  lines: readonly string[];
}

export interface StampPreviewGeometryInput {
  lines: readonly string[];
  widthPt: number;
  heightPt: number;
  fontSizePt: number;
  borderWidthPt: number;
  cornerRadiusPt: number;
  /** Omitted or null draws no border, so its thickness resolves to zero. */
  hasBorder: boolean;
  /** Null until the standard font loads; the label then renders un-shrunk. */
  font: PdfTextMeasureFont | null;
}

export function computeStampPreviewLayout(
  input: StampPreviewGeometryInput,
): StampPreviewLayout {
  const borderWidthPt = input.hasBorder
    ? clampToRange(
        input.borderWidthPt,
        0,
        Math.min(input.widthPt, input.heightPt) * STAMP_MAX_BORDER_WIDTH_FRACTION,
      )
    : 0;
  const cornerRadiusPt = clampToRange(
    input.cornerRadiusPt,
    0,
    Math.min(input.widthPt - borderWidthPt, input.heightPt - borderWidthPt) / 2,
  );
  const inset = borderWidthPt + STAMP_TEXT_PADDING_PT;
  const contentWidthPt = Math.max(0, input.widthPt - inset * 2);
  const contentHeightPt = Math.max(0, input.heightPt - inset * 2);

  return {
    borderWidthPt,
    cornerRadiusPt,
    ...fitStampPreviewLines(input, contentWidthPt, contentHeightPt),
  };
}

/**
 * Shrinks the label in the engine's fixed steps until it fits the content box.
 *
 * At the floor the engine also ellipsizes over-wide lines; the preview only
 * drops surplus lines and lets CSS clip the width, because an ellipsized
 * preview would misreport what the saved file contains.
 */
function fitStampPreviewLines(
  input: StampPreviewGeometryInput,
  contentWidthPt: number,
  contentHeightPt: number,
): { fontSizePt: number; lines: readonly string[] } {
  const startFontSizePt = Math.max(MIN_STAMP_FONT_SIZE_PT, input.fontSizePt);
  const font = input.font;

  if (!font) {
    return { fontSizePt: startFontSizePt, lines: input.lines };
  }

  // The engine sanitizes every stamp line against the embedded font before it
  // ever measures or draws them (`computeStampLayout` in engine-local), so a
  // glyph the font can't encode becomes a space long before `widthOfTextAtSize`
  // sees it. The preview mirrors that sanitize-then-fit order for the same
  // reason it mirrors the shrink-to-fit constants above: measuring the raw
  // label here would size the preview against text the saved stamp never
  // actually contains, and an emoji or other non-WinAnsi character would hit
  // pdf-lib's `widthOfTextAtSize` unsanitized and throw.
  const sanitizedLines = input.lines.map((line) => sanitizeStampPreviewLine(font, line));
  const steps = Math.ceil((startFontSizePt - MIN_STAMP_FONT_SIZE_PT) / STAMP_FONT_SIZE_STEP_PT);

  for (let step = 0; step <= steps; step += 1) {
    const fontSizePt = Math.max(
      MIN_STAMP_FONT_SIZE_PT,
      startFontSizePt - step * STAMP_FONT_SIZE_STEP_PT,
    );

    if (stampPreviewLinesFit(sanitizedLines, font, fontSizePt, contentWidthPt, contentHeightPt)) {
      return { fontSizePt, lines: sanitizedLines };
    }
  }

  const lineHeight = MIN_STAMP_FONT_SIZE_PT * TEXT_BOX_LINE_HEIGHT;

  return {
    fontSizePt: MIN_STAMP_FONT_SIZE_PT,
    lines: sanitizedLines.slice(0, Math.max(1, Math.floor(contentHeightPt / lineHeight))),
  };
}

function stampPreviewLinesFit(
  lines: readonly string[],
  font: PdfTextMeasureFont,
  fontSizePt: number,
  maxWidthPt: number,
  maxHeightPt: number,
): boolean {
  return (
    lines.length * fontSizePt * TEXT_BOX_LINE_HEIGHT <= maxHeightPt &&
    lines.every((line) => measureStampPreviewLineWidth(font, line, fontSizePt) <= maxWidthPt)
  );
}

/**
 * A deliberate copy of `sanitizeIndexTextForFont` in engine-local
 * (`packages/engine-local/src/textFit.ts`): replaces whitespace, control
 * characters, and any character the font can't encode (emoji, most
 * non-WinAnsi glyphs) with a space, then collapses runs of spaces. Copied
 * rather than imported for the same reason the fit constants above are —
 * this file mirrors the engine's stamp geometry for a live drag preview.
 */
function sanitizeStampPreviewLine(font: PdfTextMeasureFont, text: string): string {
  let sanitized = "";

  for (const character of text) {
    if (/\s/u.test(character) || isControlCharacter(character)) {
      sanitized += " ";
      continue;
    }

    try {
      font.widthOfTextAtSize(character, 1);
      sanitized += character;
    } catch {
      sanitized += " ";
    }
  }

  return sanitized.replace(/\s+/gu, " ").trim();
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);

  return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
}

/**
 * Falls back to an approximate width (0.6 × font size per character) if
 * measuring throws. Sanitizing above should make this unreachable — every
 * character left in a sanitized line already measured successfully at size 1
 * — but the live preview must never crash the app's error boundary on
 * user-entered text, so this stays as a defensive backstop rather than an
 * assumption that sanitization is airtight.
 */
function measureStampPreviewLineWidth(
  font: PdfTextMeasureFont,
  line: string,
  fontSizePt: number,
): number {
  try {
    return font.widthOfTextAtSize(line, fontSizePt);
  } catch {
    return line.length * fontSizePt * 0.6;
  }
}

function clampToRange(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}
