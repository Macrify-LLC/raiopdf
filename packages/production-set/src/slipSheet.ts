/**
 * Slip-sheet placeholder generation for a withheld source's canonical
 * occurrence (`withheldHandling: "slip-sheet"` on `BuildProductionSetInput`).
 *
 * A slip sheet is a generated, ONE-PAGE, Letter-size (portrait) pdf-lib
 * document: a centered "DOCUMENT WITHHELD" title, the privilege asserted,
 * and an optional (wrapped, length-capped) basis. It carries no content from
 * the withheld source itself -- the source's bytes are never read for this
 * page, only re-hashed for drift detection (see `readPlannedSourceBytes` in
 * `./index.ts`). The caller Bates-stamps the returned page afterward via the
 * normal `PdfEngine.batesStamp` pass -- the same placement/font options as
 * any other produced page -- so the Bates number itself is never drawn here.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { wrapTextBoxLines } from "@raiopdf/engine-api";
import { sanitizeIndexTextForFont } from "@raiopdf/engine-local";

/** US Letter, portrait -- independent of the withheld source's own page
 * size, since a slip sheet stands in for the document, not a reproduction of
 * one of its pages. */
export const SLIP_SHEET_PAGE_WIDTH_PT = 612;
export const SLIP_SHEET_PAGE_HEIGHT_PT = 792;

/** The page geometry every slip-sheet `ProductionSourcePlan` carries for the
 * shared pre-output stamp-fit check (`assertStampsFitAtMinimumSize` in
 * `./index.ts`) -- a slip sheet flows through that check exactly like any
 * other produced page. */
export const SLIP_SHEET_PAGE_GEOMETRY = {
  widthPt: SLIP_SHEET_PAGE_WIDTH_PT,
  heightPt: SLIP_SHEET_PAGE_HEIGHT_PT,
  rotationDegrees: 0,
} as const;

const SLIP_SHEET_MARGIN_PT = 90;
const SLIP_SHEET_TITLE_TEXT = "DOCUMENT WITHHELD";
const SLIP_SHEET_TITLE_FONT_SIZE_PT = 20;
/** Largest first; the last entry is the hard floor -- never rendered smaller
 * than this, even if the wrapped text would still overflow the page. */
const SLIP_SHEET_BODY_FONT_SIZES_PT = [12, 11, 10, 9, 8] as const;
export const SLIP_SHEET_MIN_BODY_FONT_SIZE_PT = 8;
/** Rendered basis length cap -- see `truncateSlipSheetBasis`. The FULL,
 * untruncated basis still reaches the package manifest via the caller's own
 * `plan.basis`; only the drawn page text is capped. */
export const SLIP_SHEET_BASIS_MAX_CHARS = 500;
const SLIP_SHEET_LINE_HEIGHT_FACTOR = 1.45;
const SLIP_SHEET_BLOCK_GAP_PT = 18;

export interface SlipSheetContentInput {
  privilegeAsserted: string;
  basis: string;
}

export interface SlipSheetTextLayout {
  fontSizePt: number;
  privilegeLines: readonly string[];
  basisLines: readonly string[];
  basisTruncated: boolean;
}

/**
 * Caps `basis` to `SLIP_SHEET_BASIS_MAX_CHARS` characters, appending an
 * ellipsis when truncated. Pure length-based (not width-based, unlike
 * `fitTextToWidth` in `engine-local`) -- the requirement is a rendered
 * character-count cap, not a single-line width fit, since the basis wraps
 * across multiple lines below.
 */
export function truncateSlipSheetBasis(basis: string): { text: string; truncated: boolean } {
  if (basis.length <= SLIP_SHEET_BASIS_MAX_CHARS) {
    return { text: basis, truncated: false };
  }
  return { text: `${basis.slice(0, SLIP_SHEET_BASIS_MAX_CHARS)}...`, truncated: true };
}

/**
 * Sanitizes and wraps the "Privilege asserted" and "Description" (basis)
 * blocks, picking the largest font size (from `SLIP_SHEET_BODY_FONT_SIZES_PT`,
 * largest first) whose wrapped lines fit within `maxContentHeightPt` --
 * falling back to `SLIP_SHEET_MIN_BODY_FONT_SIZE_PT` (the hard floor,
 * accepted even if it still overflows) when none do. Sanitization reuses
 * `sanitizeIndexTextForFont` -- the same font-encoding pass the production
 * index PDF applies to arbitrary source text -- so an unencodable character
 * (the font here is always the standard WinAnsi-encoded Helvetica) is
 * replaced with a space, never thrown.
 *
 * Pure and exported for direct unit testing -- mirrors the
 * measure-before-draw discipline `assertStampsFitAtMinimumSize` applies to
 * the Bates/designation stamps, at the slip-sheet body-text layer instead.
 */
export function layoutSlipSheetText(
  privilegeAsserted: string,
  basis: string,
  font: PDFFont,
  boxWidthPt: number,
  maxContentHeightPt: number,
): SlipSheetTextLayout {
  const sanitizedPrivilege = sanitizeIndexTextForFont(font, privilegeAsserted);
  const { text: cappedBasis, truncated: basisTruncated } = truncateSlipSheetBasis(basis);
  const sanitizedBasis = sanitizeIndexTextForFont(font, cappedBasis);

  const privilegeText = sanitizedPrivilege === "" ? "" : `Privilege asserted: ${sanitizedPrivilege}`;
  const basisText = sanitizedBasis === "" ? "" : `Description: ${sanitizedBasis}`;

  let chosen: SlipSheetTextLayout | null = null;

  for (const fontSizePt of SLIP_SHEET_BODY_FONT_SIZES_PT) {
    const privilegeLines = privilegeText === ""
      ? []
      : wrapTextBoxLines({ text: privilegeText, boxWidthPt, fontSizePt, font });
    const basisLines = basisText === ""
      ? []
      : wrapTextBoxLines({ text: basisText, boxWidthPt, fontSizePt, font });
    const totalLines = privilegeLines.length + basisLines.length;
    const contentHeightPt = totalLines * fontSizePt * SLIP_SHEET_LINE_HEIGHT_FACTOR;

    chosen = { fontSizePt, privilegeLines, basisLines, basisTruncated };
    if (contentHeightPt <= maxContentHeightPt || fontSizePt === SLIP_SHEET_MIN_BODY_FONT_SIZE_PT) {
      break;
    }
  }

  // `SLIP_SHEET_BODY_FONT_SIZES_PT` always has at least one entry (its own
  // floor), so the loop always assigns `chosen` before exiting.
  return chosen!;
}

/**
 * Builds a single Letter-size (portrait) placeholder page: centered
 * "DOCUMENT WITHHELD" title, then the privilege asserted and (optional)
 * basis, centered and wrapped. Never throws on unencodable input -- see
 * `layoutSlipSheetText`. The page's Bates number is drawn by the caller
 * afterward via `PdfEngine.batesStamp`, not here.
 */
export async function createSlipSheetPageBytes(input: SlipSheetContentInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const titleFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const bodyFont = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([SLIP_SHEET_PAGE_WIDTH_PT, SLIP_SHEET_PAGE_HEIGHT_PT]);

  const boxWidthPt = SLIP_SHEET_PAGE_WIDTH_PT - 2 * SLIP_SHEET_MARGIN_PT;
  const maxContentHeightPt =
    SLIP_SHEET_PAGE_HEIGHT_PT - 2 * SLIP_SHEET_MARGIN_PT - SLIP_SHEET_TITLE_FONT_SIZE_PT - SLIP_SHEET_BLOCK_GAP_PT;

  const layout = layoutSlipSheetText(
    input.privilegeAsserted,
    input.basis,
    bodyFont,
    boxWidthPt,
    Math.max(0, maxContentHeightPt),
  );

  const titleText = sanitizeIndexTextForFont(titleFont, SLIP_SHEET_TITLE_TEXT) || SLIP_SHEET_TITLE_TEXT;
  const bodyLines = [...layout.privilegeLines, ...layout.basisLines];
  const lineHeightPt = layout.fontSizePt * SLIP_SHEET_LINE_HEIGHT_FACTOR;
  const bodyHeightPt = bodyLines.length * lineHeightPt;
  const blockHeightPt =
    SLIP_SHEET_TITLE_FONT_SIZE_PT + (bodyLines.length > 0 ? SLIP_SHEET_BLOCK_GAP_PT + bodyHeightPt : 0);

  let y = SLIP_SHEET_PAGE_HEIGHT_PT / 2 + blockHeightPt / 2;
  drawCentered(page, titleFont, titleText, SLIP_SHEET_TITLE_FONT_SIZE_PT, y);
  y -= SLIP_SHEET_TITLE_FONT_SIZE_PT;

  if (bodyLines.length > 0) {
    y -= SLIP_SHEET_BLOCK_GAP_PT;
    for (const line of bodyLines) {
      drawCentered(page, bodyFont, line, layout.fontSizePt, y);
      y -= lineHeightPt;
    }
  }

  return pdf.save();
}

function drawCentered(page: PDFPage, font: PDFFont, text: string, size: number, y: number): void {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (SLIP_SHEET_PAGE_WIDTH_PT - width) / 2,
    y,
    size,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
}
