import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TAURI_CONFIG = fileURLToPath(
  new URL("../apps/shell/src-tauri/tauri.conf.json", import.meta.url),
);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";

export function readUpdaterPubkeyFromTauriConfig(configPath = DEFAULT_TAURI_CONFIG) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const pubkey = config.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || pubkey.trim() === "") {
    throw new Error(`minisign: missing plugins.updater.pubkey in ${configPath}`);
  }
  return pubkey.trim();
}

export function verifyTauriUpdaterSignature(
  filePath,
  signaturePath,
  { pubkey, configPath = DEFAULT_TAURI_CONFIG, label = path.basename(filePath) } = {},
) {
  const publicKeyText = base64ToUtf8(pubkey ?? readUpdaterPubkeyFromTauriConfig(configPath), "updater pubkey");
  const signatureText = base64ToUtf8(readFileSync(signaturePath, "utf8").trim(), "updater signature");
  const data = readFileSync(filePath);

  verifyMinisignSignature(data, signatureText, publicKeyText);
  return { label };
}

export function verifyMinisignSignature(data, signatureText, publicKeyText) {
  const publicKey = parseMinisignPublicKey(publicKeyText);
  const signature = parseMinisignSignature(signatureText);

  if (!publicKey.keyId.equals(signature.keyId)) {
    throw new Error("minisign: signature key id does not match updater public key");
  }

  const signedData = signature.prehashed
    ? createHash("blake2b512").update(data).digest()
    : Buffer.from(data);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]),
    format: "der",
    type: "spki",
  });

  if (!verifySignature(null, signedData, key, signature.signature)) {
    throw new Error("minisign: updater signature does not match installer bytes");
  }

  const trustedCommentBytes = Buffer.from(signature.trustedComment, "utf8");
  const globalMessage = Buffer.concat([signature.signature, trustedCommentBytes]);
  if (!verifySignature(null, globalMessage, key, signature.globalSignature)) {
    throw new Error("minisign: updater trusted comment signature is invalid");
  }

  return true;
}

function parseMinisignPublicKey(text) {
  const lines = String(text).trim().split(/\r?\n/u);
  if (lines.length < 2) {
    throw new Error("minisign: public key must contain a comment line and base64 key line");
  }
  const decoded = base64Line(lines[1], "public key");
  if (decoded.length !== 42) {
    throw new Error(`minisign: public key payload is ${decoded.length} bytes, expected 42`);
  }
  assertAlgorithm(decoded.subarray(0, 2), "public key");
  return {
    keyId: decoded.subarray(2, 10),
    key: decoded.subarray(10, 42),
  };
}

function parseMinisignSignature(text) {
  const lines = String(text).trim().split(/\r?\n/u);
  if (lines.length < 4) {
    throw new Error("minisign: signature must contain four minisign lines");
  }
  const decoded = base64Line(lines[1], "signature");
  if (decoded.length !== 74) {
    throw new Error(`minisign: signature payload is ${decoded.length} bytes, expected 74`);
  }
  if (!lines[2].startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error("minisign: signature is missing trusted comment");
  }
  const globalSignature = base64Line(lines[3], "trusted comment signature");
  if (globalSignature.length !== 64) {
    throw new Error(
      `minisign: trusted comment signature is ${globalSignature.length} bytes, expected 64`,
    );
  }
  const algorithm = decoded.subarray(0, 2);
  assertAlgorithm(algorithm, "signature");
  return {
    keyId: decoded.subarray(2, 10),
    signature: decoded.subarray(10, 74),
    trustedComment: lines[2].slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature,
    prehashed: algorithm[0] === 0x45 && algorithm[1] === 0x44,
  };
}

function assertAlgorithm(algorithm, label) {
  const legacy = algorithm[0] === 0x45 && algorithm[1] === 0x64;
  const prehashed = algorithm[0] === 0x45 && algorithm[1] === 0x44;
  if (!legacy && !prehashed) {
    throw new Error(`minisign: unsupported ${label} algorithm ${algorithm.toString("hex")}`);
  }
}

function base64Line(line, label) {
  try {
    return Buffer.from(line.trim(), "base64");
  } catch {
    throw new Error(`minisign: ${label} is not valid base64`);
  }
}

function base64ToUtf8(value, label) {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    throw new Error(`minisign: ${label} is not valid base64 text`);
  }
}
