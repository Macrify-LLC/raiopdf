import type { PdfTableOfAuthoritiesOptions } from "@raiopdf/engine-api";
import { drawToaPages } from "@raiopdf/engine-local";

export async function generateToaPdf(
  options: PdfTableOfAuthoritiesOptions,
): Promise<Uint8Array> {
  const rendered = await drawToaPages(options);

  return rendered.doc.save();
}
