import type { PdfTableOfAuthoritiesOptions } from "@raiopdf/engine-api";
import { drawToaPages, type ToaPageNumberMode } from "@raiopdf/engine-local";

/**
 * Renders a Table of Authorities PDF in-process.
 *
 * `pageNumberMode` defaults to `"source"` (page references point at the
 * source document — correct for previews and standalone Save as PDF). Pass
 * `"physical"` only when the generated pages will be prepended to the
 * document they index, so references shift by the table's own page count.
 */
export async function generateToaPdf(
  options: PdfTableOfAuthoritiesOptions,
  pageNumberMode: ToaPageNumberMode = "source",
): Promise<Uint8Array> {
  const rendered = await drawToaPages(options, pageNumberMode);

  return rendered.doc.save();
}
