import type { PdfCoverStyle } from "@raiopdf/engine-api";
import { type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { fitTextToWidth, sanitizeIndexTextForFont } from "./textFit";

export type { PdfCoverStyle } from "@raiopdf/engine-api";

export interface CoverDrawFonts {
  regular: PDFFont;
  bold: PDFFont;
}

export interface CoverDrawInput {
  label: string;
  description?: string | undefined;
  style: PdfCoverStyle;
}

const STAMP_COLOR = rgb(0.08, 0.08, 0.08);
const DESCRIPTION_COLOR = rgb(0.35, 0.35, 0.35);
const COVER_FONT_SIZE_PT = 11;
const DESCRIPTION_FONT_SIZE_PT = 8;
const BORDER_INSET_PT = 72;
const BORDER_THICKNESS_PT = 0.75;
const COVER_TEXT_GAP_PT = 12;

export function drawCoverPage(page: PDFPage, fonts: CoverDrawFonts, input: CoverDrawInput): void {
  if (input.style === "minimal") {
    drawMinimalCoverPage(page, fonts.regular, input.label);
    return;
  }

  if (input.style === "bordered") {
    drawBorderedCoverPage(page, fonts, input);
    return;
  }

  drawLabeledCoverPage(page, fonts, input);
}

function drawMinimalCoverPage(page: PDFPage, font: PDFFont, label: string): void {
  const sanitizedLabel = sanitizeAndFit(font, label, COVER_FONT_SIZE_PT, page.getWidth() - 144);
  const textWidth = font.widthOfTextAtSize(sanitizedLabel, COVER_FONT_SIZE_PT);

  page.drawText(sanitizedLabel, {
    x: (page.getWidth() - textWidth) / 2,
    y: (page.getHeight() - COVER_FONT_SIZE_PT) / 2,
    size: COVER_FONT_SIZE_PT,
    font,
    color: STAMP_COLOR,
  });
}

function drawLabeledCoverPage(page: PDFPage, fonts: CoverDrawFonts, input: CoverDrawInput): void {
  const label = sanitizeAndFit(fonts.regular, input.label, COVER_FONT_SIZE_PT, page.getWidth() - 144);
  const description = sanitizeAndFit(
    fonts.regular,
    input.description ?? "",
    DESCRIPTION_FONT_SIZE_PT,
    page.getWidth() - 144,
  );
  const labelWidth = fonts.regular.widthOfTextAtSize(label, COVER_FONT_SIZE_PT);
  const descriptionWidth = fonts.regular.widthOfTextAtSize(description, DESCRIPTION_FONT_SIZE_PT);
  const labelY = (page.getHeight() - COVER_FONT_SIZE_PT) / 2 + (description ? COVER_TEXT_GAP_PT / 2 : 0);

  page.drawText(label, {
    x: (page.getWidth() - labelWidth) / 2,
    y: labelY,
    size: COVER_FONT_SIZE_PT,
    font: fonts.regular,
    color: STAMP_COLOR,
  });

  if (description) {
    page.drawText(description, {
      x: (page.getWidth() - descriptionWidth) / 2,
      y: labelY - DESCRIPTION_FONT_SIZE_PT - COVER_TEXT_GAP_PT,
      size: DESCRIPTION_FONT_SIZE_PT,
      font: fonts.regular,
      color: DESCRIPTION_COLOR,
    });
  }
}

function drawBorderedCoverPage(page: PDFPage, fonts: CoverDrawFonts, input: CoverDrawInput): void {
  const width = page.getWidth();
  const height = page.getHeight();
  const contentWidth = width - BORDER_INSET_PT * 2 - 48;
  const label = sanitizeAndFit(fonts.bold, input.label, COVER_FONT_SIZE_PT, contentWidth);
  const description = sanitizeAndFit(
    fonts.regular,
    input.description ?? "",
    DESCRIPTION_FONT_SIZE_PT,
    contentWidth,
  );
  const labelWidth = fonts.bold.widthOfTextAtSize(label, COVER_FONT_SIZE_PT);
  const descriptionWidth = fonts.regular.widthOfTextAtSize(description, DESCRIPTION_FONT_SIZE_PT);
  const labelY = (height - COVER_FONT_SIZE_PT) / 2 + (description ? COVER_TEXT_GAP_PT / 2 : 0);

  page.drawRectangle({
    x: BORDER_INSET_PT,
    y: BORDER_INSET_PT,
    width: width - BORDER_INSET_PT * 2,
    height: height - BORDER_INSET_PT * 2,
    borderColor: STAMP_COLOR,
    borderWidth: BORDER_THICKNESS_PT,
  });
  page.drawText(label, {
    x: (width - labelWidth) / 2,
    y: labelY,
    size: COVER_FONT_SIZE_PT,
    font: fonts.bold,
    color: STAMP_COLOR,
  });

  if (description) {
    page.drawText(description, {
      x: (width - descriptionWidth) / 2,
      y: labelY - DESCRIPTION_FONT_SIZE_PT - COVER_TEXT_GAP_PT,
      size: DESCRIPTION_FONT_SIZE_PT,
      font: fonts.regular,
      color: DESCRIPTION_COLOR,
    });
  }
}

function sanitizeAndFit(font: PDFFont, text: string, fontSize: number, maxWidth: number): string {
  return fitTextToWidth(font, sanitizeIndexTextForFont(font, text), fontSize, maxWidth);
}
