import { useMemo, type CSSProperties } from "react";
import type { PdfEditColor, PdfTextBoxFontFamily } from "@raiopdf/engine-api";
import { usePreviewFont } from "../hooks/usePreviewFont";
import { TEXT_BOX_LINE_HEIGHT } from "../lib/edits";
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_FAMILY,
  pdfEditColorToHex,
} from "../lib/editStyles";
import { cssTextBoxFontFamily } from "../lib/previewFonts";
import { computeStampPreviewLayout } from "../lib/stampPreview";
import "./StampPreview.css";

/**
 * Everything needed to draw one exhibit sticker on screen. Deliberately the
 * intersection of `PendingExhibitStamp` and `ExhibitStampTemplateV1`, so the
 * placed overlay, the drag ghost, and the template gallery all render through
 * this one component and can never drift from each other.
 */
export interface StampPreviewStyle {
  lines: readonly string[];
  widthPt: number;
  heightPt: number;
  fontSizePt: number;
  fontFamily?: PdfTextBoxFontFamily | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  color?: PdfEditColor | undefined;
  /** Omitted or null draws no fill. */
  fillColor?: PdfEditColor | null | undefined;
  /** Omitted defaults to the text ink color; null draws no border. */
  borderColor?: PdfEditColor | null | undefined;
  borderWidthPt?: number | undefined;
  cornerRadiusPt?: number | undefined;
}

/**
 * Renders an exhibit sticker at `scale` screen pixels per PDF point, filling
 * whatever box the caller positions. Border thickness, corner rounding, and
 * shrink-to-fit all come from the shared engine-mirroring layout, so what the
 * user drags around is what the saved PDF draws.
 */
export function StampPreview({
  stamp,
  scale,
  className,
}: {
  stamp: StampPreviewStyle;
  scale: number;
  className?: string | undefined;
}) {
  const font = usePreviewFont(
    stamp.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY,
    Boolean(stamp.bold),
    Boolean(stamp.italic),
  );
  const layout = useMemo(
    () =>
      computeStampPreviewLayout({
        lines: stamp.lines,
        widthPt: stamp.widthPt,
        heightPt: stamp.heightPt,
        fontSizePt: stamp.fontSizePt,
        borderWidthPt: stamp.borderWidthPt ?? 0,
        cornerRadiusPt: stamp.cornerRadiusPt ?? 0,
        hasBorder: stamp.borderColor !== null,
        font,
      }),
    [font, stamp],
  );
  const style: CSSProperties = {
    borderWidth: `${layout.borderWidthPt * scale}px`,
    borderStyle: layout.borderWidthPt > 0 ? "solid" : "none",
    borderColor: pdfEditColorToHex(stamp.borderColor ?? DEFAULT_TEXT_COLOR),
    borderRadius: `${layout.cornerRadiusPt * scale}px`,
    background: stamp.fillColor ? pdfEditColorToHex(stamp.fillColor) : "transparent",
    color: pdfEditColorToHex(stamp.color ?? DEFAULT_TEXT_COLOR),
    fontFamily: cssTextBoxFontFamily(stamp.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY),
    fontSize: `${layout.fontSizePt * scale}px`,
    fontWeight: stamp.bold ? 700 : 400,
    fontStyle: stamp.italic ? "italic" : "normal",
    lineHeight: TEXT_BOX_LINE_HEIGHT,
  };

  return (
    <span
      className={className ? `stamp-preview ${className}` : "stamp-preview"}
      style={style}
      aria-hidden="true"
    >
      {layout.lines.map((line, lineIndex) => (
        <span key={lineIndex} className="stamp-preview__line">
          {line}
        </span>
      ))}
    </span>
  );
}
