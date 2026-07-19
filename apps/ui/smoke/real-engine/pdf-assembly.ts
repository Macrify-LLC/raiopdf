// Minimal classic-PDF assembler shared by the hand-built canary fixtures
// (`createImageOnlyPdf` in helpers.ts, `createRestrictedTextPdf` in
// synthetic-fixtures.ts). Hand assembly is the point of those fixtures — the
// exact bytes (raw image streams, RC4-encrypted streams) must stay fully under
// the generator's control — but the object/xref/trailer bookkeeping around
// them is identical, so it lives here once.
//
// This module must stay dependency-free (no "@playwright/test", no pdf-lib):
// it is imported by both Playwright canary helpers and the vitest unit suite.

/** Encode a string 1-byte-per-char (latin1) — the PDF token/stream encoding. */
export function latin1Bytes(value: string): Buffer {
  return Buffer.from(value, "latin1");
}

/**
 * Assemble a classic (non-cross-reference-stream) PDF 1.4 file from finished
 * object bodies. `objects[i]` becomes indirect object `i + 1` (generation 0);
 * object 1 must be the /Root catalog. `trailerEntries` is spliced verbatim
 * into the trailer dict after `/Root 1 0 R` (e.g. an /Encrypt + /ID pair).
 */
export function assembleClassicPdf(
  objects: readonly Uint8Array[],
  options: { trailerEntries?: string } = {},
): Uint8Array {
  const parts: Buffer[] = [latin1Bytes("%PDF-1.4\n")];
  const totalLength = (): number => parts.reduce((sum, part) => sum + part.length, 0);
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(totalLength());
    parts.push(latin1Bytes(`${index + 1} 0 obj\n`), Buffer.from(body), latin1Bytes("\nendobj\n"));
  });
  const xref = totalLength();
  parts.push(latin1Bytes(`xref\n0 ${objects.length + 1}\n`), latin1Bytes("0000000000 65535 f \n"));
  for (const offset of offsets) {
    parts.push(latin1Bytes(`${String(offset).padStart(10, "0")} 00000 n \n`));
  }
  parts.push(
    latin1Bytes(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${options.trailerEntries ?? ""} >>\n` +
        `startxref\n${xref}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}
