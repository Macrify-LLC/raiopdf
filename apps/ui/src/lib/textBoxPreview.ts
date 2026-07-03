import {
  wrapTextBoxLines,
  type PdfTextMeasureFont,
} from "@raiopdf/engine-api";

export function computeTextBoxPreviewLines({
  text,
  boxWidthPt,
  fontSizePt,
  font,
}: {
  text: string;
  boxWidthPt: number;
  fontSizePt: number;
  font: PdfTextMeasureFont | null;
}): string[] {
  return font
    ? wrapTextBoxLines({
        text,
        boxWidthPt,
        fontSizePt,
        font,
      })
    : text.replace(/\r\n/g, "\n").split("\n");
}
