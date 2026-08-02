/**
 * Litigation load-file (DAT) export for a production set.
 *
 * Profile: **"Relativity-compatible Concordance DAT defaults"** -- the field
 * layout and delimiter choices that Relativity (and most review platforms
 * that accept a Concordance-style DAT) expect out of the box. This is
 * deliberately NOT called "universal Concordance": Concordance DAT has no
 * single universal spec, every platform's importer has its own tolerances,
 * and this profile is fixed, not configurable. If a platform needs different
 * field names/order, this is the file to extend, not to work around.
 *
 * ## Format, byte for byte
 *
 * - **Field delimiter:** byte `0x14` (ASCII DC4, conventionally displayed as
 *   `¶`).
 * - **Text qualifier:** `þ` (U+00FE), wrapping EVERY field -- including the
 *   header row.
 * - **Embedded newlines** inside a value become `®` (U+00AE) -- a value can
 *   never legitimately contain a newline in a single-line-per-record format.
 * - **Encoding:** UTF-8 with a byte-order mark (`EF BB BF`).
 * - **Line endings:** CRLF, on every line including the last.
 * - **Header row first**, using the field names below, then one row per
 *   produced file.
 *
 * ## Field order (fixed)
 *
 * `BEGBATES, ENDBATES, BEGATTACH, ENDATTACH, PAGECOUNT, CONFIDENTIALITY,
 * CUSTODIAN, FILENAME, LINK, SHA256`
 *
 * - `BEGATTACH`/`ENDATTACH` are always blank -- RaioPDF tracks no document
 *   families (parent/child attachment relationships), and blank is the
 *   protocol-typical representation for a non-family record. They are never
 *   self-mirrored to `BEGBATES`/`ENDBATES`.
 * - `CONFIDENTIALITY` is the raw designation text only -- never
 *   `" (pages X-Y)"` appended for a partial-page designation. That detail
 *   stays where it already lives: the package manifest and production index.
 * - `FILENAME` is blank on every row (header stays) when the caller's
 *   `includeFilenameInIndex` is `false`, mirroring the same option on the
 *   production index PDF/CSV.
 * - `LINK` is the produced file's path relative to the load file's own
 *   location (the package root), BACKSLASH-separated regardless of the
 *   platform this ran on -- that's the load-file convention every review
 *   platform expects, e.g. `upload\VOL001\SMITH000001 - SMITH000004 -
 *   contract.pdf`.
 *
 * Only PRODUCED files get a row: a combined production PDF and any
 * produce-once-omitted duplicate occurrence never appear here, matching the
 * production index.
 *
 * ## Sanitization
 *
 * This format has NO escape mechanism -- a field delimiter or text qualifier
 * inside a value would desynchronize every field after it, and a raw newline
 * would desynchronize every ROW after it. Every value is sanitized before
 * it's written:
 *
 * 1. Any of `\r\n`, `\r`, or `\n` becomes `®` (U+00AE) -- the value's content
 *    survives, just not as a literal line break.
 * 2. A literal field delimiter (`0x14`) inside a value is replaced with a
 *    single space -- it cannot be preserved without breaking field
 *    alignment.
 * 3. A literal text qualifier (`þ`, U+00FE) inside a value is replaced with a
 *    single space -- same reasoning as the delimiter.
 *
 * Sanitization never touches a pre-existing `®` in a value; it isn't treated
 * as a marker on the way in, only produced on the way out.
 */

/** Fixed field order this profile writes -- see the module docstring. */
const DAT_FIELD_NAMES = [
  "BEGBATES",
  "ENDBATES",
  "BEGATTACH",
  "ENDATTACH",
  "PAGECOUNT",
  "CONFIDENTIALITY",
  "CUSTODIAN",
  "FILENAME",
  "LINK",
  "SHA256",
] as const;

/** Byte `0x14` (ASCII DC4), conventionally displayed as `¶`. */
const DAT_FIELD_DELIMITER = String.fromCharCode(0x14);
const DAT_TEXT_QUALIFIER = "þ";
const DAT_NEWLINE_SUBSTITUTE = "®";
/** Substitute for a stray delimiter or qualifier found inside a value --
 * see "Sanitization" above. A single space keeps the value readable without
 * reintroducing anything that could desynchronize the row. */
const DAT_UNSAFE_CHAR_SUBSTITUTE = " ";
const CRLF = "\r\n";
/** `EF BB BF` -- the UTF-8 byte-order mark this profile always prepends. */
const UTF8_BOM_BYTES = new Uint8Array([0xef, 0xbb, 0xbf]);

/** One produced file's load-file record. Callers build this from their own
 * per-file production result; `formatProductionDat` itself does no lookups
 * and no I/O -- it's a pure function from rows to bytes. */
export interface ProductionDatRow {
  /** First Bates number of this file's range, already formatted (e.g.
   * `"SMITH000001"`). */
  begBates: string;
  /** Last Bates number of this file's range, already formatted. */
  endBates: string;
  /** Page count of the produced file. */
  pageCount: number;
  /** Raw confidentiality designation text, or `""` for none. Never carries a
   * page-range suffix -- see the module docstring. */
  confidentiality: string;
  /** Custodian name, or `""` when none was set for this source. */
  custodian: string;
  /** Produced output filename. Written to the `FILENAME` field only when
   * `FormatProductionDatOptions.includeFilenameInIndex` is `true`; the
   * caller does not need to blank this itself. */
  filename: string;
  /** Path of the produced file relative to the load file's own location
   * (the package root), forward-slash separated as it comes from the
   * package writer -- this function converts it to backslashes. */
  link: string;
  /** SHA-256 hex digest of the produced file. */
  sha256: string;
}

export interface FormatProductionDatOptions {
  /** Mirrors `BuildProductionSetInput.includeFilenameInIndex`. When `false`,
   * every row's `FILENAME` field is written blank; the column (and header)
   * still exist. */
  includeFilenameInIndex: boolean;
}

/**
 * Formats produced-file rows into a "Relativity-compatible Concordance DAT
 * defaults" load file -- see the module docstring for the exact byte-level
 * format. Pure: no I/O, no lookups, deterministic for the same input.
 */
export function formatProductionDat(
  rows: readonly ProductionDatRow[],
  options: FormatProductionDatOptions,
): Uint8Array {
  const header = formatDatLine(DAT_FIELD_NAMES);
  const lines = rows.map((row) => formatDatLine(datRowFields(row, options)));
  const text = [header, ...lines].map((line) => `${line}${CRLF}`).join("");
  const encoded = new TextEncoder().encode(text);

  const withBom = new Uint8Array(UTF8_BOM_BYTES.length + encoded.length);
  withBom.set(UTF8_BOM_BYTES, 0);
  withBom.set(encoded, UTF8_BOM_BYTES.length);
  return withBom;
}

function datRowFields(row: ProductionDatRow, options: FormatProductionDatOptions): readonly string[] {
  return [
    row.begBates,
    row.endBates,
    "", // BEGATTACH -- always blank; see the module docstring.
    "", // ENDATTACH -- always blank; see the module docstring.
    String(row.pageCount),
    row.confidentiality,
    row.custodian,
    options.includeFilenameInIndex ? row.filename : "",
    formatDatLink(row.link),
    row.sha256,
  ];
}

function formatDatLine(fields: readonly string[]): string {
  return fields.map((field) => qualifyDatField(field)).join(DAT_FIELD_DELIMITER);
}

function qualifyDatField(value: string): string {
  return `${DAT_TEXT_QUALIFIER}${sanitizeDatValue(value)}${DAT_TEXT_QUALIFIER}`;
}

/** Applies the three sanitization rules from the module docstring, in the
 * order that keeps them independent: newline collapse first (so a delimiter
 * or qualifier that happened to sit right next to a newline is still caught
 * on its own pass), then the two single-character replacements. */
function sanitizeDatValue(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, DAT_NEWLINE_SUBSTITUTE)
    .split(DAT_FIELD_DELIMITER)
    .join(DAT_UNSAFE_CHAR_SUBSTITUTE)
    .split(DAT_TEXT_QUALIFIER)
    .join(DAT_UNSAFE_CHAR_SUBSTITUTE);
}

/** Load files are a Windows-authored-tooling convention: backslash-separated
 * paths regardless of which platform actually built the package. The
 * package writer always hands back forward-slash relative paths, so this
 * only ever needs to flip the separator, never resolve or normalize
 * anything. */
function formatDatLink(relativePath: string): string {
  return relativePath.split("/").join("\\");
}
