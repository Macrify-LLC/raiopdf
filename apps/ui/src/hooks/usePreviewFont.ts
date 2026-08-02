import { useEffect, useState } from "react";
import type { PDFFont } from "pdf-lib";
import type { PdfTextBoxFontFamily } from "@raiopdf/engine-api";
import { loadPreviewFont, previewFontKey } from "../lib/previewFonts";

/**
 * The pdf-lib standard font a preview should measure with. Null until the
 * font resolves; callers fall back to un-measured text for that first frame.
 */
export function usePreviewFont(
  fontFamily: PdfTextBoxFontFamily,
  bold: boolean,
  italic: boolean,
): PDFFont | null {
  const [font, setFont] = useState<PDFFont | null>(null);
  const key = previewFontKey(fontFamily, bold, italic);

  useEffect(() => {
    let disposed = false;

    setFont(null);
    void loadPreviewFont(key).then((loadedFont) => {
      if (!disposed) {
        setFont(loadedFont);
      }
    });

    return () => {
      disposed = true;
    };
  }, [key]);

  return font;
}
