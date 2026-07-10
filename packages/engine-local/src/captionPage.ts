import type {
  PdfCaptionData,
  PdfCaptionParty,
  PdfCaptionStyle,
  PdfCoverPageOptions,
} from "@raiopdf/engine-api";
import { wrapTextBoxLines } from "@raiopdf/engine-api";
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
  const layout: CaptionLayout = {
    contentLeft: style.margins.left,
    contentRight: page.getWidth() - style.margins.right,
    contentWidth: page.getWidth() - style.margins.left - style.margins.right,
    cursorY: page.getHeight() - style.margins.top,
    bottom: style.margins.bottom,
  };

  for (const section of style.ordering) {
    if (layout.cursorY <= layout.bottom) {
      return;
    }

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

function drawCourt(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  caption: PdfCaptionData,
  style: PdfCaptionStyle,
  layout: CaptionLayout,
): void {
  const lines = compactStrings([caption.courtName, caption.county]);
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
  if (parties.length === 0) {
    return;
  }

  const blockLines = parties.flatMap((party, partyIndex) => {
    const partyLines = compactStrings([
      ...party.names,
      party.etAl ? "et al." : undefined,
      party.role,
    ]);

    return partyIndex === 0 ? partyLines : [style.vsSeparator, ...partyLines];
  });
  const boxPadding = style.partyBlockStyle === "boxed" ? PARTY_BOX_PADDING_PT : 0;
  const textWidth = layout.contentWidth - boxPadding * 2;
  const blockHeight = wrappedHeight(fonts.regular, blockLines, textWidth, BODY_FONT_SIZE_PT);
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

  drawPartyLines(page, fonts, parties, style, {
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
  fonts: CaptionDrawFonts,
  parties: readonly PdfCaptionParty[],
  style: PdfCaptionStyle,
  block: { x: number; y: number; width: number; align: TextAlign },
): void {
  let cursorY = block.y;

  parties.forEach((party, partyIndex) => {
    if (partyIndex > 0) {
      cursorY = drawWrappedLine(page, fonts.regular, style.vsSeparator, {
        ...block,
        y: cursorY,
        fontSize: BODY_FONT_SIZE_PT,
      }) - LINE_GAP_PT;
    }

    for (const name of party.names) {
      cursorY = drawWrappedLine(page, fonts.regular, name, {
        ...block,
        y: cursorY,
        fontSize: BODY_FONT_SIZE_PT,
      }) - LINE_GAP_PT;
    }

    if (party.etAl) {
      cursorY = drawWrappedLine(page, fonts.regular, "et al.", {
        ...block,
        y: cursorY,
        fontSize: BODY_FONT_SIZE_PT,
      }) - LINE_GAP_PT;
    }

    cursorY = drawWrappedLine(page, fonts.bold, party.role, {
      ...block,
      y: cursorY,
      fontSize: ROLE_FONT_SIZE_PT,
      color: MUTED_COLOR,
    }) - LINE_GAP_PT * 2;
  });
}

function drawCaseInfo(
  page: PDFPage,
  fonts: CaptionDrawFonts,
  caption: PdfCaptionData,
  style: PdfCaptionStyle,
  layout: CaptionLayout,
): void {
  const lines = compactStrings([
    caption.caseNumber ? `Case No. ${caption.caseNumber}` : undefined,
    caption.division ? `Division: ${caption.division}` : undefined,
    caption.judge ? `Judge: ${caption.judge}` : undefined,
  ]);

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

function compactStrings(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
