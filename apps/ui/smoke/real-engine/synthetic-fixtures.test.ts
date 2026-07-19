// Unit coverage for the synthetic canary fixture generators. The real-engine
// canary that consumes them only runs on a machine with the assembled desktop
// payload, so everything provable in plain Node is proven here, on every PR:
// the restricted fixture is spec-correct RC4-40 (independent key-derivation
// round trip), the oversized fixture genuinely splits through the REAL split
// engine, the metadata fixture plants markers exactly where a scrub clears
// them, and the JavaScript fixture carries both embedded-JS shapes.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { LocalPdfEngine } from "@raiopdf/engine-local";
import { scrubPdfMetadataBytes } from "@raiopdf/engine-pdf-lib";
import {
  ALL_METADATA_MARKERS,
  createJavaScriptPdf,
  createOversizedNoisePdf,
  createRestrictedTextPdf,
  createTaggedMetadataPdf,
  findMetadataMarkers,
  METADATA_MARKERS,
  OVERSIZED_NOISE_BYTES_PER_PAGE,
  readJavaScriptFacts,
  RESTRICTED_FIXTURE_LINE,
  rc4,
  restrictedFileKey,
  restrictedPerObjectKey,
} from "./synthetic-fixtures";

describe("createRestrictedTextPdf", () => {
  it("emits a deterministic PDF with an /Encrypt dict, a /Font, and no plaintext body", () => {
    const bytes = createRestrictedTextPdf();
    const latin1 = Buffer.from(bytes).toString("latin1");

    expect(latin1.startsWith("%PDF-1.4")).toBe(true);
    expect(latin1).toContain("/Encrypt 6 0 R");
    expect(latin1).toContain("/Filter /Standard");
    expect(latin1).toContain("/V 1 /R 2");
    expect(latin1).toContain("/Font");
    // The body text must be RC4-encrypted, never readable in the raw bytes.
    expect(latin1).not.toContain(RESTRICTED_FIXTURE_LINE);

    expect(Buffer.from(createRestrictedTextPdf()).equals(Buffer.from(bytes))).toBe(true);
  });

  it("round-trips through an independent standard-security-handler decryption", () => {
    // Independent of the generator's own helpers where it matters: the file
    // key is re-derived here from the raw /O, /P, and /ID values embedded in
    // the emitted bytes, exactly as a conforming reader would.
    const bytes = createRestrictedTextPdf();
    const latin1 = Buffer.from(bytes).toString("latin1");

    const oMatch = latin1.match(/\/O <([0-9A-F]{64})>/);
    const idMatch = latin1.match(/\/ID \[<([0-9a-f]{32})>/);
    const pMatch = latin1.match(/\/P (-?\d+)/);
    expect(oMatch && idMatch && pMatch).toBeTruthy();

    const pad = Uint8Array.from([
      0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
      0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
      0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
    ]);
    const pLE = new Uint8Array(4);
    new DataView(pLE.buffer).setInt32(0, Number(pMatch![1]), true);
    const derivedKey = new Uint8Array(
      createHash("md5")
        .update(pad) // padded EMPTY user password == the bare pad string
        .update(Buffer.from(oMatch![1]!, "hex"))
        .update(pLE)
        .update(Buffer.from(idMatch![1]!, "hex"))
        .digest(),
    ).subarray(0, 5);
    expect(Buffer.from(derivedKey).equals(Buffer.from(restrictedFileKey()))).toBe(true);

    // Decrypt the content stream (object 4) with the derived key: the known
    // text layer must come back, proving the fixture opens under an EMPTY user
    // password for any spec-conforming reader.
    const streamStart = latin1.indexOf("stream\n") + "stream\n".length;
    const streamEnd = latin1.indexOf("\nendstream");
    expect(streamStart).toBeGreaterThan("stream\n".length - 1);
    expect(streamEnd).toBeGreaterThan(streamStart);
    const decrypted = rc4(
      restrictedPerObjectKey(derivedKey, 4, 0),
      bytes.subarray(streamStart, streamEnd),
    );
    const text = Buffer.from(decrypted).toString("latin1");
    expect(text).toContain(RESTRICTED_FIXTURE_LINE);
    expect(text).toContain("BT");
  });
});

describe("createOversizedNoisePdf", () => {
  it("generates at least the requested bytes and splits through the real split engine", async () => {
    // Small-scale here (unit budget); the canary runs the full portal-cap
    // size. The mechanics are identical — page count scales, page size doesn't.
    const targetBytes = 2 * OVERSIZED_NOISE_BYTES_PER_PAGE;
    const bytes = await createOversizedNoisePdf(targetBytes);
    expect(bytes.byteLength).toBeGreaterThan(targetBytes);

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);

    const engine = new LocalPdfEngine();
    const handle = await engine.open(bytes);
    const capBytes = OVERSIZED_NOISE_BYTES_PER_PAGE + 1024 * 1024;
    const result = await engine.splitByMaxBytes(handle, capBytes);
    expect(result.parts.length).toBeGreaterThanOrEqual(2);
    for (const part of result.parts) {
      const partBytes = await engine.saveToBytes(part.document);
      if (!part.oversized) {
        expect(partBytes.byteLength).toBeLessThanOrEqual(capBytes);
      }
    }
  }, 60_000);

  it("is deterministic", async () => {
    const first = await createOversizedNoisePdf(OVERSIZED_NOISE_BYTES_PER_PAGE);
    const second = await createOversizedNoisePdf(OVERSIZED_NOISE_BYTES_PER_PAGE);
    // The generator pins its Info-dict dates, so the whole file is
    // byte-identical across generations — no stream-locating heuristics.
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  }, 30_000);
});

describe("createTaggedMetadataPdf", () => {
  it("plants every marker in surfaces a scrub clears, and the scrub clears them", async () => {
    const bytes = await createTaggedMetadataPdf();

    // All six markers present before the scrub — Info dict and XMP both.
    expect(await findMetadataMarkers(bytes)).toEqual([...ALL_METADATA_MARKERS]);
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toContain(METADATA_MARKERS.producer); // XMP packet is plain XML
    expect(raw).toContain("/Metadata");

    // Round trip through the SAME scrub library the app's client-side scrub
    // path uses: every marker must be gone. This proves the fixture plants
    // markers only where a metadata scrub is contracted to clear them — a
    // fixture bug here would otherwise surface as a false canary failure.
    const scrubbed = await scrubPdfMetadataBytes(bytes);
    expect(await findMetadataMarkers(scrubbed)).toEqual([]);
  });
});

describe("createJavaScriptPdf", () => {
  it("carries name-tree JavaScript, an OpenAction JavaScript action, and the sentinel", async () => {
    const bytes = await createJavaScriptPdf();
    const facts = await readJavaScriptFacts(bytes);
    expect(facts).toEqual({
      namesTreeJavaScript: true,
      openActionJavaScript: true,
      rawSentinel: true,
    });
    expect(Buffer.from(bytes).toString("latin1")).toContain("/JavaScript");
  });
});
