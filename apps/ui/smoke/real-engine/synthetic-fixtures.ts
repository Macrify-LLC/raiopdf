// Synthetic canary fixtures — generated at test time, committed nowhere.
//
// The safety-critical canary tiers used to be gated on real client documents in
// the gitignored `fixtures.local/` dir, so on any machine without those files
// (including the release runner) the restricted-open, lossless-decrypt, and
// oversized-split acceptances silently skipped. These generators are the
// always-run stand-ins: deterministic, seconds-fast, and shaped to trip the
// same code paths the real documents do. The real-document tier remains as an
// additional maintainer-local layer on top.
//
// This module is imported by both Playwright canary specs and the vitest unit
// suite, so it must NOT import from "@playwright/test" or "./endpoint".

import { createHash } from "node:crypto";
import { assembleClassicPdf, latin1Bytes } from "./pdf-assembly";
import {
  concatTransformationMatrix,
  drawObject,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";

// --- Restricted-but-not-secured PDF (owner permissions, empty user password) ---

/**
 * The repeated body line of the restricted fixture. Common-word heavy on
 * purpose: the lossless-decrypt acceptance proves the text layer survived by
 * finding these exact words in the decrypted copy — a stronger check than the
 * byte-size proxy used for real (unknown-content) documents, whose size
 * comparison a recompressing decrypt would break on a tiny synthetic file.
 */
export const RESTRICTED_FIXTURE_LINE =
  "the court finds that the motion is timely and the record for this county supports the relief.";
export const RESTRICTED_FIXTURE_LINE_COUNT = 24;

/** Owner password of the synthetic restricted fixture (never the user password). */
export const RESTRICTED_FIXTURE_OWNER_PASSWORD = "raiopdf-canary-owner";

// R2 permissions: print allowed; modify/copy/annotate denied (bits 7+ set per spec).
const RESTRICTED_PERMISSIONS = -60;
const RESTRICTED_FILE_ID_HEX = "8a1f0c4d9e2b7f3a5c6d8e9f0a1b2c3d";

// Standard security handler padding string (PDF 32000-1, algorithm 2).
const STANDARD_SECURITY_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// MD5 (like RC4 below) is REQUIRED by the PDF 1.4 V1/R2 standard security
// handler this fixture generator implements — the whole point is emitting a
// spec-conformant legacy restricted PDF for tests. Nothing here hashes real
// credentials; code scanning's insufficient-password-hash alert on this file
// is dismissed as test-fixture code.
function md5(...chunks: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("md5");
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return new Uint8Array(hash.digest());
}

/** Plain RC4 — the (weak, legacy) cipher the V1/R2 standard handler mandates. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    state[i] = i;
  }
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i]! + key[i % key.length]!) & 0xff;
    const swap = state[i]!;
    state[i] = state[j]!;
    state[j] = swap;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let index = 0; index < data.length; index += 1) {
    a = (a + 1) & 0xff;
    b = (b + state[a]!) & 0xff;
    const swap = state[a]!;
    state[a] = state[b]!;
    state[b] = swap;
    out[index] = data[index]! ^ state[(state[a]! + state[b]!) & 0xff]!;
  }
  return out;
}

function padPassword(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password);
  const used = Math.min(bytes.length, 32);
  const padded = new Uint8Array(32);
  padded.set(bytes.subarray(0, used));
  padded.set(STANDARD_SECURITY_PAD.subarray(0, 32 - used), used);
  return padded;
}

function permissionsLE32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

/** Per-object RC4 key (PDF 32000-1, algorithm 1): MD5(fileKey + objNum(3LE) + gen(2LE)). */
export function restrictedPerObjectKey(
  fileKey: Uint8Array,
  objectNumber: number,
  generationNumber: number,
): Uint8Array {
  const extra = Uint8Array.from([
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
    generationNumber & 0xff,
    (generationNumber >> 8) & 0xff,
  ]);
  return md5(fileKey, extra).subarray(0, Math.min(fileKey.length + 5, 16));
}

/** The 40-bit file key of the synthetic restricted fixture (for round-trip tests). */
export function restrictedFileKey(): Uint8Array {
  const ownerKey = md5(padPassword(RESTRICTED_FIXTURE_OWNER_PASSWORD)).subarray(0, 5);
  const oValue = rc4(ownerKey, padPassword(""));
  return md5(
    padPassword(""),
    oValue,
    permissionsLE32(RESTRICTED_PERMISSIONS),
    Uint8Array.from(Buffer.from(RESTRICTED_FILE_ID_HEX, "hex")),
  ).subarray(0, 5);
}

function restrictedContentStream(): Buffer {
  const operations = ["BT", "/F1 10 Tf", "1 0 0 1 56 740 Tm", "12 TL"];
  for (let line = 1; line <= RESTRICTED_FIXTURE_LINE_COUNT; line += 1) {
    operations.push(`(Line ${line}: ${RESTRICTED_FIXTURE_LINE}) Tj`, "T*");
  }
  operations.push("ET");
  return latin1Bytes(`${operations.join("\n")}\n`);
}

/**
 * A deterministic RC4-40 (V1/R2) owner-restricted PDF with an EMPTY user
 * password — the classic "restricted but not secured" court-filed document: it
 * carries an /Encrypt dict and permission restrictions, but any viewer opens it
 * without prompting. One letter page of Helvetica text (a real /Font text
 * layer), hand-assembled in the same style as `createImageOnlyPdf` so the
 * encryption bytes are fully under our control.
 *
 * Why hand-rolled: qpdf (which could `--encrypt` one) ships only inside the
 * Windows/macOS desktop payload — unreachable from Linux CI and from this
 * module's vitest consumer — and pdf-lib 1.17.1 has no encrypt API, so
 * assembling the RC4-40 standard security handler on node:crypto primitives is
 * the only dependency-free route to an always-generatable fixture.
 *
 * Validated against qpdf (`--check` clean, "User password =", restrictions
 * listed), qpdf `--decrypt --password=` (text layer survives byte-perfect),
 * and pdf.js (opens with no password; full text extraction).
 */
export function createRestrictedTextPdf(): Uint8Array {
  const ownerKey = md5(padPassword(RESTRICTED_FIXTURE_OWNER_PASSWORD)).subarray(0, 5);
  const oValue = rc4(ownerKey, padPassword(""));
  const fileKey = restrictedFileKey();
  const uValue = rc4(fileKey, STANDARD_SECURITY_PAD);

  const content = restrictedContentStream();
  // The content stream is object 4 — encrypted with that object's derived key.
  const encryptedContent = rc4(restrictedPerObjectKey(fileKey, 4, 0), content);
  const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex").toUpperCase();

  return assembleClassicPdf(
    [
      latin1Bytes("<< /Type /Catalog /Pages 2 0 R >>"),
      latin1Bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      latin1Bytes(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
          "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      ),
      Buffer.concat([
        latin1Bytes(`<< /Length ${encryptedContent.length} >>\nstream\n`),
        Buffer.from(encryptedContent),
        latin1Bytes("\nendstream"),
      ]),
      latin1Bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
      latin1Bytes(
        `<< /Filter /Standard /V 1 /R 2 /O <${hex(oValue)}> /U <${hex(uValue)}> ` +
          `/P ${RESTRICTED_PERMISSIONS} >>`,
      ),
    ],
    {
      trailerEntries:
        ` /Encrypt 6 0 R /ID [<${RESTRICTED_FILE_ID_HEX}> <${RESTRICTED_FILE_ID_HEX}>]`,
    },
  );
}

// --- Oversized-noise PDF (deterministic, incompressible, portal-over-cap) ------

/** Raw DeviceGray noise bytes carried per generated page (2048 × 2048 × 8-bit). */
export const OVERSIZED_NOISE_BYTES_PER_PAGE = 2048 * 2048;

/**
 * A deterministic multi-MB PDF of incompressible pseudo-random raster pages —
 * the synthetic stand-in for a real over-the-portal-cap filing (a plat, a
 * scanned appendix). Every page draws one 4 MiB DeviceGray noise image, so the
 * bytes cannot deflate away in a split re-serialization and page count stays
 * low (the split engine re-serializes per page, O(n²)). Generation is
 * sub-second even at ~30 MB; nothing is ever committed to the repo.
 */
export async function createOversizedNoisePdf(targetBytes: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  let seed = 0x9e3779b9;
  const nextNoise = (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      out[index] = seed & 0xff;
    }
    return out;
  };

  const side = Math.sqrt(OVERSIZED_NOISE_BYTES_PER_PAGE);
  const pages = Math.max(1, Math.ceil(targetBytes / OVERSIZED_NOISE_BYTES_PER_PAGE));
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([612, 792]);
    const stream = pdf.context.stream(nextNoise(OVERSIZED_NOISE_BYTES_PER_PAGE), {
      Type: "XObject",
      Subtype: "Image",
      Width: side,
      Height: side,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
    });
    const name = page.node.newXObject("NoiseIm", pdf.context.register(stream));
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(512, 0, 0, 680, 50, 56),
      drawObject(name),
      popGraphicsState(),
    );
  }
  return pdf.save();
}

// --- Planted-metadata PDF (Info dict + XMP) ------------------------------------

/** Sentinel metadata values planted in both the Info dict and the XMP packet. */
export const METADATA_MARKERS = {
  title: "RAIOPDF-CANARY-TITLE-7d1f",
  author: "RAIOPDF-CANARY-AUTHOR-2b8e",
  subject: "RAIOPDF-CANARY-SUBJECT-9c4a",
  keywords: "RAIOPDF-CANARY-KEYWORD-5f60",
  producer: "RAIOPDF-CANARY-PRODUCER-e3d2",
  creator: "RAIOPDF-CANARY-CREATOR-81ab",
} as const;

export const ALL_METADATA_MARKERS: readonly string[] = Object.values(METADATA_MARKERS);

/**
 * A one-page text PDF carrying the sentinel markers in BOTH metadata surfaces a
 * scrub must clear: the trailer Info dictionary (Title/Author/Subject/Keywords/
 * Producer/Creator — stored UTF-16BE by pdf-lib, as real files are) and a
 * catalog XMP metadata stream (dc/xmp/pdf properties, plain XML).
 */
export async function createTaggedMetadataPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("This document carries planted Info-dict and XMP metadata markers.", {
    x: 56,
    y: 720,
    size: 12,
    font,
  });

  pdf.setTitle(METADATA_MARKERS.title);
  pdf.setAuthor(METADATA_MARKERS.author);
  pdf.setSubject(METADATA_MARKERS.subject);
  pdf.setKeywords([METADATA_MARKERS.keywords]);
  pdf.setProducer(METADATA_MARKERS.producer);
  pdf.setCreator(METADATA_MARKERS.creator);

  const xmp = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${METADATA_MARKERS.title}</rdf:li></rdf:Alt></dc:title>`,
    `   <dc:creator><rdf:Seq><rdf:li>${METADATA_MARKERS.author}</rdf:li></rdf:Seq></dc:creator>`,
    `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${METADATA_MARKERS.subject}</rdf:li></rdf:Alt></dc:description>`,
    `   <pdf:Keywords>${METADATA_MARKERS.keywords}</pdf:Keywords>`,
    `   <pdf:Producer>${METADATA_MARKERS.producer}</pdf:Producer>`,
    `   <xmp:CreatorTool>${METADATA_MARKERS.creator}</xmp:CreatorTool>`,
    "  </rdf:Description>",
    " </rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
  const stream = pdf.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));

  return pdf.save();
}

function decodeAnyPdfString(value: unknown): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return null;
}

function decodeStreamText(pdf: PDFDocument, object: unknown): string {
  const stream = object instanceof PDFRef ? pdf.context.lookup(object) : object;
  if (stream instanceof PDFRawStream) {
    return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  }
  if (stream instanceof PDFStream) {
    return Buffer.from(stream.getContents()).toString("latin1");
  }
  return "";
}

/**
 * Which of the given markers are still present in ANY metadata surface of the
 * PDF — checked structurally (Info dict values decoded through pdf-lib, so
 * UTF-16BE hex strings can't hide, and every /Metadata stream in the file) AND
 * as a raw byte scan (so a marker left in plain sight can't hide inside an
 * unparsed corner). An empty return list is the "fully scrubbed" signal.
 */
export async function findMetadataMarkers(
  bytes: Uint8Array,
  markers: readonly string[] = ALL_METADATA_MARKERS,
): Promise<string[]> {
  const surfaces: string[] = [Buffer.from(bytes).toString("latin1")];

  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoRef = pdf.context.trailerInfo.Info;
  const info = infoRef instanceof PDFRef ? pdf.context.lookup(infoRef) : infoRef;
  if (info instanceof PDFDict) {
    for (const [, value] of info.entries()) {
      const resolved = value instanceof PDFRef ? pdf.context.lookup(value) : value;
      const decoded = decodeAnyPdfString(resolved);
      if (decoded !== null) {
        surfaces.push(decoded);
      }
    }
  }
  const metadataName = PDFName.of("Metadata");
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.has(metadataName)) {
      surfaces.push(decodeStreamText(pdf, object.get(metadataName)));
    }
  }

  const haystack = surfaces.join("\n");
  return markers.filter((marker) => haystack.includes(marker));
}

// --- Embedded-JavaScript PDF (sanitize input) ----------------------------------

/** The sentinel JavaScript payload planted in the sanitize fixture. */
export const JS_SENTINEL = "RAIOPDF-CANARY-EMBEDDED-JS";
const JS_SENTINEL_CODE = `app.alert("${JS_SENTINEL}");`;

/**
 * A one-page text PDF carrying embedded JavaScript in the two places a dirty
 * real-world PDF carries it: the document /Names → /JavaScript name tree and a
 * catalog /OpenAction JavaScript action (the auto-runs-on-open shape). Sanitize
 * must strip both.
 */
export async function createJavaScriptPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("This document carries embedded JavaScript that sanitize must remove.", {
    x: 56,
    y: 720,
    size: 12,
    font,
  });

  pdf.addJavaScript("RaioPDFCanaryScript", JS_SENTINEL_CODE);
  const openAction = pdf.context.obj({
    Type: "Action",
    S: "JavaScript",
    JS: PDFString.of(JS_SENTINEL_CODE),
  });
  pdf.catalog.set(PDFName.of("OpenAction"), pdf.context.register(openAction));

  // No object streams: keeps the action dicts (and the sentinel) visible in the
  // raw bytes, so the pre-sanitize fixture assertions can scan them directly.
  return pdf.save({ useObjectStreams: false });
}

export interface JavaScriptFacts {
  /** Catalog /Names tree carries a /JavaScript branch. */
  namesTreeJavaScript: boolean;
  /** Catalog /OpenAction is a /JavaScript action. */
  openActionJavaScript: boolean;
  /** The sentinel payload string is visible in the raw bytes. */
  rawSentinel: boolean;
}

/**
 * Structural read of a PDF's document-level JavaScript. Structural on purpose:
 * a raw byte scan alone could false-pass if an engine rewrite tucked the name
 * tree inside a compressed object stream.
 */
export async function readJavaScriptFacts(bytes: Uint8Array): Promise<JavaScriptFacts> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const lookupDict = (value: unknown): PDFDict | null => {
    const resolved = value instanceof PDFRef ? pdf.context.lookup(value) : value;
    return resolved instanceof PDFDict ? resolved : null;
  };

  const names = lookupDict(pdf.catalog.get(PDFName.of("Names")));
  const namesTreeJavaScript = names?.has(PDFName.of("JavaScript")) ?? false;

  const openAction = lookupDict(pdf.catalog.get(PDFName.of("OpenAction")));
  const openActionJavaScript =
    openAction?.get(PDFName.of("S")) === PDFName.of("JavaScript");

  return {
    namesTreeJavaScript,
    openActionJavaScript,
    rawSentinel: Buffer.from(bytes).toString("latin1").includes(JS_SENTINEL),
  };
}
