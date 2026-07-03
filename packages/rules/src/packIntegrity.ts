import type { JurisdictionPackId } from "./types";

export type PackManifest = {
  version: 1;
  packs: Record<string, PackManifestEntry>;
};

export type PackManifestEntry = {
  file: string;
  sha256: string;
};

export type PackIntegrityIssue = {
  packId: JurisdictionPackId;
  expectedSha256?: string;
  actualSha256: string;
  reason: string;
};

export type PackAcknowledgmentStore = {
  hasAcknowledgment: (packId: JurisdictionPackId, sha256: string) => boolean;
};

export type AppDataPackIntegrityResult =
  | { accepted: true; sha256: string }
  | { accepted: false; sha256: string; reason: string };

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function verifyBundledPackIntegrity(
  manifest: PackManifest,
  packId: JurisdictionPackId,
  packJson: unknown,
): PackIntegrityIssue | null {
  const entry = manifest.packs[packId];
  const actualSha256 = packJsonSha256(packJson);

  if (!entry) {
    return {
      packId,
      actualSha256,
      reason: "No manifest entry exists for bundled pack.",
    };
  }

  if (entry.sha256 !== actualSha256) {
    return {
      packId,
      expectedSha256: entry.sha256,
      actualSha256,
      reason: "Bundled pack hash does not match packs.manifest.json.",
    };
  }

  return null;
}

export function verifyAppDataPackIntegrity(
  packId: JurisdictionPackId,
  packJson: unknown,
  options: {
    manifestEntry?: PackManifestEntry;
    acknowledgments?: PackAcknowledgmentStore;
  } = {},
): AppDataPackIntegrityResult {
  const sha256 = packJsonSha256(packJson);

  if (options.manifestEntry?.sha256 === sha256) {
    return { accepted: true, sha256 };
  }

  if (options.acknowledgments?.hasAcknowledgment(packId, sha256)) {
    return { accepted: true, sha256 };
  }

  return {
    accepted: false,
    sha256,
    reason: "App-data pack hash has not been signed or explicitly acknowledged.",
  };
}

export function packJsonSha256(packJson: unknown): string {
  return sha256Hex(canonicalPackJson(packJson));
}

export function canonicalPackJson(packJson: unknown): string {
  return `${JSON.stringify(packJson, null, 2)}\n`;
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const padded = padSha256Message(bytes);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] = (
        (padded[byteOffset]! << 24) |
        (padded[byteOffset + 1]! << 16) |
        (padded[byteOffset + 2]! << 8) |
        padded[byteOffset + 3]!
      ) >>> 0;
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15]!, 7) ^ rotr(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3);
      const s1 = rotr(words[index - 2]!, 17) ^ rotr(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10);
      words[index] = add32(words[index - 16]!, s0, words[index - 7]!, s1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = add32(h, s1, ch, SHA256_K[index]!, words[index]!);
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(s0, maj);

      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    h0 = add32(h0, a);
    h1 = add32(h1, b);
    h2 = add32(h2, c);
    h3 = add32(h3, d);
    h4 = add32(h4, e);
    h5 = add32(h5, f);
    h6 = add32(h6, g);
    h7 = add32(h7, h);
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

function padSha256Message(bytes: Uint8Array): Uint8Array {
  const byteLength = bytes.length;
  const paddedLength = Math.ceil((byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  const bitLength = byteLength * 8;

  padded.set(bytes);
  padded[byteLength] = 0x80;
  padded[paddedLength - 4] = (bitLength >>> 24) & 0xff;
  padded[paddedLength - 3] = (bitLength >>> 16) & 0xff;
  padded[paddedLength - 2] = (bitLength >>> 8) & 0xff;
  padded[paddedLength - 1] = bitLength & 0xff;

  return padded;
}

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function add32(...values: readonly number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}
