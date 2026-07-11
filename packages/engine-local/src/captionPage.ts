import type {
  PdfCaptionData,
  PdfCaptionParty,
  PdfCaptionStyle,
  PdfCoverPageOptions,
} from "@raiopdf/engine-api";
import { PdfEngineError, wrapTextBoxLines } from "@raiopdf/engine-api";
import { type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { resolveCaptionStyle } from "./captionStyles";
import { fitTextToWidth, sanitizeIndexTextForFont } from "./textFit";

export interface CaptionDrawFonts {
  regular: PDFFont;
  bold: PDFFont;
}

type TextAlign = "left" | "center" | "right";

type CaptionLayout = {
  contentLeft: number;
  contentRight: number;
  contentWidth: number;
  cursorY: number;
  bottom: number;
};

const TEXT_COLOR = rgb(0.08, 0.08, 0.08);
const MUTED_COLOR = rgb(0.28, 0.28, 0.28);
const RULE_COLOR = rgb(0.12, 0.12, 0.12);
const COURT_FONT_SIZE_PT = 12;
const BODY_FONT_SIZE_PT = 11;
const ROLE_FONT_SIZE_PT = 10;
const TITLE_FONT_SIZE_PT = 13;
const SIGNATURE_FONT_SIZE_PT = 10;
const LINE_GAP_PT = 3;
const SECTION_GAP_PT = 18;
const PARTY_BOX_PADDING_PT = 14;
const BOX_BORDER_WIDTH_PT = 0.75;

export function drawCaptionPage(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  options: PdfCoverPageOptions,
): void {
  const style = resolveCaptionStyle(options.styleId);
  const contentWidth = page.getWidth() - style.margins.left - style.margins.right;
  const layout: CaptionLayout = {
    contentLeft: style.margins.left,
    contentRight: page.getWidth() - style.margins.right,
    contentWidth,
    cursorY: page.getHeight() - style.margins.top,
    bottom: style.margins.bottom,
  };

  // Captions are a one-page layout by contract, so the full measured height
  // is validated up front. Failing with a typed error beats silently
  // dropping the sections (title, signature block) that no longer fit.
  const availableHeight = page.getHeight() - style.margins.top - style.margins.bottom;
  const requiredHeight = measureCaptionContentHeight(fonts, options.caption, style, contentWidth);

  if (requiredHeight > availableHeight) {
    throw new PdfEngineError(
      "CONTENT_OVERFLOW",
      `The caption content does not fit on one page (needs about ${Math.ceil(requiredHeight)}pt of the ${Math.floor(availableHeight)}pt available). Remove parties, shorten names, or trim the signature block.`,
    );
  }

  for (const section of style.ordering) {
    switch (section) {
      case "court":
        drawCourt(page, fonts, options.caption, style, layout);
        break;
      case "parties":
        drawParties(page, fonts, options.caption.parties, style, layout);
        break;
      case "caseInfo":
        drawCaseInfo(page, fonts, options.caption, style, layout);
        break;
      case "title":
        drawTitle(page, fonts, options.caption.documentTitle, layout);
        break;
      case "signature":
        drawSignature(page, fonts, options.caption.signatureBlockLines ?? [], layout);
        break;
    }
  }
}

// Mirrors exactly what the draw functions below subtract from the cursor, so
// measurement can never drift from drawing. The trailing SECTION_GAP_PT after
// the last section is not required to fit on the page.
function measureCaptionContentHeight(
  fonts: CaptionDrawFonts,
  caption: PdfCaptionData,
  style: PdfCaptionStyle,
  contentWidth: number,
): number {
  let total = 0;

  for (const section of style.ordering) {
    switch (section) {
      case "court":
        total += wrappedHeight(
          fonts.bold,
          courtLines(caption),
          contentWidth,
          COURT_FONT_SIZE_PT,
        ) + SECTION_GAP_PT;
        break;
      case "parties": {
        const specs = buildPartyLineSpecs(fonts, caption.parties, style);

        if (specs.length === 0) {
          break;
        }

        const boxPadding = style.partyBlockStyle === "boxed" ? PARTY_BOX_PADDING_PT : 0;
        const textWidth = contentWidth - boxPadding * 2;
        total += partyBlockHeight(specs, textWidth) + boxPadding * 2 + SECTION_GAP_PT;
        break;
      }
      case "caseInfo": {
        const lines = caseInfoLines(caption);

        if (lines.length === 0) {
          break;
        }

        total += wrappedHeight(fonts.regular, lines, contentWidth, BODY_FONT_SIZE_PT) + SECTION_GAP_PT;
        break;
      }
      case "title":
        total += wrappedHeight(fonts.bold, [caption.documentTitle], contentWidth, TITLE_FONT_SIZE_PT) + SECTION_GAP_PT;
        break;
      case "signature": {
        const lines = caption.signatureBlockLines ?? [];

        if (lines.length === 0) {
          break;
        }

        total += SIGNATURE_FONT_SIZE_PT + LINE_GAP_PT * 2
          + wrappedHeight(fonts.regular, lines, contentWidth, SIGNATURE_FONT_SIZE_PT)
          + SECTION_GAP_PT;
        break;
      }
    }
  }

  return total - SECTION_GAP_PT;
}

// One logical line of the party block. Measurement and drawing both walk the
// same spec list with the same fonts, sizes, and gaps, so the measured block
// height can never drift from the drawn block height (the pre-fix bug: the
// block was measured entirely at 11pt regular with single gaps, but roles
// drew at 10pt bold with a double gap, pushing text through the box border).
type PartyLineSpec = {
  text: string;
  font: PDFFont;
  fontSize: number;
  color?: ReturnType<typeof rgb> | undefined;
  gapAfter: number;
};

function buildPartyLineSpecs(
  fonts: CaptionDrawFonts,
  parties: readonly PdfCaptionParty[],
  style: PdfCaptionStyle,
): PartyLineSpec[] {
  const specs: PartyLineSpec[] = [];

  parties.forEach((party, partyIndex) => {
    if (partyIndex > 0) {
      pushPartyLineSpec(specs, style.vsSeparator, fonts.regular, BODY_FONT_SIZE_PT, LINE_GAP_PT);
    }

    for (const name of party.names) {
      pushPartyLineSpec(specs, name, fonts.regular, BODY_FONT_SIZE_PT, LINE_GAP_PT);
    }

    if (party.etAl) {
      pushPartyLineSpec(specs, "et al.", fonts.regular, BODY_FONT_SIZE_PT, LINE_GAP_PT);
    }

    pushPartyLineSpec(
      specs,
      party.role,
      fonts.bold,
      ROLE_FONT_SIZE_PT,
      LINE_GAP_PT * 2,
      MUTED_COLOR,
    );
  });

  return specs;
}

function pushPartyLineSpec(
  specs: PartyLineSpec[],
  text: string,
  font: PDFFont,
  fontSize: number,
  gapAfter: number,
  color?: ReturnType<typeof rgb>,
): void {
  if (text.trim().length === 0) {
    return;
  }

  specs.push({ text, font, fontSize, color, gapAfter });
}

// Total cursor advance if the specs were drawn: every wrapped line advances
// by fontSize + LINE_GAP_PT, and each logical line adds its own gapAfter.
function partyBlockAdvance(specs: readonly PartyLineSpec[], width: number): number {
  let advance = 0;

  for (const spec of specs) {
    const wrappedLineCount = wrapTextForFont(spec.font, spec.text, width, spec.fontSize).length;
    advance += wrappedLineCount * (spec.fontSize + LINE_GAP_PT) + spec.gapAfter;
  }

  return advance;
}

// Tight text-block height: the advance minus the trailing gaps below the
// last baseline (drawWrappedLine's own LINE_GAP_PT plus the last gapAfter).
function partyBlockHeight(specs: readonly PartyLineSpec[], width: number): number {
  const last = specs[specs.length - 1];

  if (last === undefined) {
    return 0;
  }

  return partyBlockAdvance(specs, width) - LINE_GAP_PT - last.gapAfter;
}

function drawCourt(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  caption: PdfCaptionData,
  style: PdfCaptionStyle,
  layout: CaptionLayout,
): void {
  const lines = courtLines(caption);
  const align: TextAlign = style.partyBlockStyle === "centered" ? "center" : "center";

  drawWrappedLines(page, fonts.bold, lines, {
    x: layout.contentLeft,
    y: layout.cursorY,
    width: layout.contentWidth,
    fontSize: COURT_FONT_SIZE_PT,
    align,
  });
  layout.cursorY -= wrappedHeight(fonts.bold, lines, layout.contentWidth, COURT_FONT_SIZE_PT) + SECTION_GAP_PT;
}

function drawParties(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  parties: readonly PdfCaptionParty[],
  style: PdfCaptionStyle,
  layout: CaptionLayout,
): void {
  const specs = buildPartyLineSpecs(fonts, parties, style);

  if (specs.length === 0) {
    return;
  }

  const boxPadding = style.partyBlockStyle === "boxed" ? PARTY_BOX_PADDING_PT : 0;
  const textWidth = layout.contentWidth - boxPadding * 2;
  const blockHeight = partyBlockHeight(specs, textWidth);
  const boxHeight = blockHeight + boxPadding * 2;
  const textY = style.partyBlockStyle === "boxed"
    ? layout.cursorY - boxPadding
    : layout.cursorY;
  const align: TextAlign = style.partyBlockStyle === "centered" ? "center" : "left";

  if (style.partyBlockStyle === "boxed") {
    page.drawRectangle({
      x: layout.contentLeft,
      y: layout.cursorY - boxHeight + BODY_FONT_SIZE_PT,
      width: layout.contentWidth,
      height: boxHeight,
      borderColor: RULE_COLOR,
      borderWidth: BOX_BORDER_WIDTH_PT,
    });
  }

  drawPartyLines(page, specs, {
    x: layout.contentLeft + boxPadding,
    y: textY,
    width: textWidth,
    align,
  });

  layout.cursorY -= boxHeight + SECTION_GAP_PT;

  if (style.id === "underlined-parties") {
    page.drawLine({
      start: { x: layout.contentLeft, y: layout.cursorY + SECTION_GAP_PT / 2 },
      end: { x: layout.contentRight, y: layout.cursorY + SECTION_GAP_PT / 2 },
      thickness: BOX_BORDER_WIDTH_PT,
      color: RULE_COLOR,
    });
  }
}

function drawPartyLines(
  page: PDFPage,
  specs: readonly PartyLineSpec[],
  block: { x: number; y: number; width: number; align: TextAlign },
): void {
  let cursorY = block.y;

  for (const spec of specs) {
    cursorY = drawWrappedLine(page, spec.font, spec.text, {
      ...block,
      y: cursorY,
      fontSize: spec.fontSize,
      color: spec.color,
    }) - spec.gapAfter;
  }
}

function drawCaseInfo(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  caption: PdfCaptionData,
  style: PdfCaptionStyle,
  layout: CaptionLayout,
): void {
  const lines = caseInfoLines(caption);

  if (lines.length === 0) {
    return;
  }

  drawWrappedLines(page, fonts.regular, lines, {
    x: layout.contentLeft,
    y: layout.cursorY,
    width: layout.contentWidth,
    fontSize: BODY_FONT_SIZE_PT,
    align: style.caseInfoAlign,
  });
  layout.cursorY -= wrappedHeight(fonts.regular, lines, layout.contentWidth, BODY_FONT_SIZE_PT) + SECTION_GAP_PT;
}

function drawTitle(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  title: string,
  layout: CaptionLayout,
): void {
  drawWrappedLines(page, fonts.bold, [title], {
    x: layout.contentLeft,
    y: layout.cursorY,
    width: layout.contentWidth,
    fontSize: TITLE_FONT_SIZE_PT,
    align: "center",
  });
  layout.cursorY -= wrappedHeight(fonts.bold, [title], layout.contentWidth, TITLE_FONT_SIZE_PT) + SECTION_GAP_PT;
}

function drawSignature(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  lines: readonly string[],
  layout: CaptionLayout,
): void {
  if (lines.length === 0) {
    return;
  }

  drawWrappedLine(page, fonts.bold, "Signature", {
    x: layout.contentLeft,
    y: layout.cursorY,
    width: layout.contentWidth,
    fontSize: SIGNATURE_FONT_SIZE_PT,
    align: "left",
  });
  layout.cursorY -= SIGNATURE_FONT_SIZE_PT + LINE_GAP_PT * 2;
  drawWrappedLines(page, fonts.regular, lines, {
    x: layout.contentLeft,
    y: layout.cursorY,
    width: layout.contentWidth,
    fontSize: SIGNATURE_FONT_SIZE_PT,
    align: "left",
  });
  layout.cursorY -= wrappedHeight(fonts.regular, lines, layout.contentWidth, SIGNATURE_FONT_SIZE_PT) + SECTION_GAP_PT;
}

function drawWrappedLines(
  page: PDFPage,
  font: PDFFont,
  lines: readonly string[],
  options: {
    x: number;
    y: number;
    width: number;
    fontSize: number;
    align: TextAlign;
    color?: ReturnType<typeof rgb> | undefined;
  },
): number {
  let cursorY = options.y;

  for (const line of lines) {
    cursorY = drawWrappedLine(page, font, line, { ...options, y: cursorY }) - LINE_GAP_PT;
  }

  return cursorY;
}

function drawWrappedLine(
  page: PDFPage,
  font: PDFFont,
  text: string,
  options: {
    x: number;
    y: number;
    width: number;
    fontSize: number;
    align: TextAlign;
    color?: ReturnType<typeof rgb> | undefined;
  },
): number {
  const wrapped = wrapTextForFont(font, text, options.width, options.fontSize);
  let cursorY = options.y;

  for (const line of wrapped) {
    const fitted = fitTextToWidth(font, line, options.fontSize, options.width);
    const textWidth = font.widthOfTextAtSize(fitted, options.fontSize);
    page.drawText(fitted, {
      x: alignedX(options.x, options.width, textWidth, options.align),
      y: cursorY,
      size: options.fontSize,
      font,
      color: options.color ?? TEXT_COLOR,
    });
    cursorY -= options.fontSize + LINE_GAP_PT;
  }

  return cursorY;
}

function wrappedHeight(
  font: PDFFont,
  lines: readonly string[],
  width: number,
  fontSize: number,
): number {
  const wrappedLineCount = lines.reduce(
    (count, line) => count + wrapTextForFont(font, line, width, fontSize).length,
    0,
  );

  return wrappedLineCount * fontSize + Math.max(0, wrappedLineCount - 1) * LINE_GAP_PT;
}

function wrapTextForFont(
  font: PDFFont,
  text: string,
  width: number,
  fontSize: number,
): string[] {
  const sanitized = sanitizeIndexTextForFont(font, text);

  return wrapTextBoxLines({
    text: sanitized,
    boxWidthPt: width,
    fontSizePt: fontSize,
    font,
  }).filter((line) => line.length > 0);
}

function alignedX(x: number, width: number, textWidth: number, align: TextAlign): number {
  if (align === "center") {
    return x + (width - textWidth) / 2;
  }

  if (align === "right") {
    return x + width - textWidth;
  }

  return x;
}

function courtLines(caption: PdfCaptionData): string[] {
  return compactStrings([caption.courtName, caption.county]);
}

function caseInfoLines(caption: PdfCaptionData): string[] {
  return compactStrings([
    caption.caseNumber ? `Case No. ${caption.caseNumber}` : undefined,
    caption.division ? `Division: ${caption.division}` : undefined,
    caption.judge ? `Judge: ${caption.judge}` : undefined,
  ]);
}

function compactStrings(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
