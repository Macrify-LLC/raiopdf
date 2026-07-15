#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getPlatform } from "./platforms.mjs";

export const PAYLOAD_MANIFEST = "RAIOPDF-PAYLOAD-MANIFEST.tsv";

export function listPayloadFiles(payloadDir) {
  const files = [];
  walk(path.resolve(payloadDir), "", files);
  return files.filter((relative) => relative !== PAYLOAD_MANIFEST);
}

export function writePayloadManifest(payloadDir) {
  const root = path.resolve(payloadDir);
  const rows = listPayloadFiles(root).map((relative) => {
    const file = path.join(root, ...relative.split("/"));
    return `${sha256(file)}\t${statSync(file).size}\t${relative}`;
  });
  const manifestPath = path.join(root, PAYLOAD_MANIFEST);
  writeFileSync(manifestPath, `sha256\tsize\tpath\n${rows.join("\n")}${rows.length ? "\n" : ""}`);
  return manifestPath;
}

export function verifyPayloadManifest(payloadDir, platformId, { requiredFiles = [] } = {}) {
  const root = path.resolve(payloadDir);
  const manifestPath = path.join(root, PAYLOAD_MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`Missing payload manifest: ${manifestPath}`);
  const lines = readFileSync(manifestPath, "utf8").split(/\r?\n/);
  if (lines.shift() !== "sha256\tsize\tpath") throw new Error(`Invalid payload manifest: ${manifestPath}`);

  const descriptor = getPlatform(platformId);
  const recorded = new Map();
  const errors = [];
  for (const [offset, line] of lines.entries()) {
    if (!line) continue;
    const [digest, sizeText, relative, ...extra] = line.split("\t");
    if (!digest || !sizeText || !relative || extra.length || !isSafeRelativePath(relative)) {
      errors.push(`${PAYLOAD_MANIFEST}:${offset + 2}: invalid row`);
      continue;
    }
    if (recorded.has(relative)) {
      errors.push(`${PAYLOAD_MANIFEST}:${offset + 2}: duplicate path ${relative}`);
      continue;
    }
    recorded.set(relative, { digest, size: Number(sizeText) });
  }

  const actual = listPayloadFiles(root);
  for (const relative of actual) {
    if (isGeneratedPython(relative)) {
      errors.push(`Generated Python cache file is not allowed in a release payload: ${relative}`);
    }
    const foreign = descriptor.foreignFileMarkers.find((pattern) => pattern.test(relative));
    if (foreign) errors.push(`Foreign file is not allowed in ${platformId}: ${relative}`);
    const expected = recorded.get(relative);
    if (!expected) {
      errors.push(`Payload file missing from manifest: ${relative}`);
      continue;
    }
    const file = path.join(root, ...relative.split("/"));
    if (expected.size !== statSync(file).size) errors.push(`Size mismatch for ${relative}`);
    if (expected.digest !== sha256(file)) errors.push(`SHA256 mismatch for ${relative}`);
  }
  for (const relative of recorded.keys()) {
    if (!actual.includes(relative)) errors.push(`Missing payload file from manifest: ${relative}`);
  }
  for (const required of requiredFiles) {
    if (!recorded.has(required)) errors.push(`Required payload file missing from manifest: ${required}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { files: actual.length, manifestPath };
}

function walk(root, relativeDir, files) {
  const directory = path.join(root, ...relativeDir.split("/").filter(Boolean));
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, relative, files);
    else if (entry.isFile()) files.push(relative);
  }
}

function isGeneratedPython(relative) {
  return relative.split("/").includes("__pycache__") || relative.endsWith(".pyc");
}

function isSafeRelativePath(relative) {
  return (
    relative === relative.replaceAll("\\", "/") &&
    !relative.startsWith("/") &&
    relative.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parseCli(argv) {
  const options = { mode: undefined, platform: undefined, payloadDir: undefined, requiredFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--generate" || arg === "--verify") options.mode = arg.slice(2);
    else if (arg === "--platform") options.platform = argv[++index];
    else if (arg === "--payload-dir") options.payloadDir = argv[++index];
    else if (arg === "--require") options.requiredFiles.push(argv[++index]);
    else throw new Error(`Unknown payload-manifest argument: ${arg}`);
  }
  if (!options.mode || !options.platform || !options.payloadDir) {
    throw new Error("Usage: payload-manifest.mjs (--generate|--verify) --platform ID --payload-dir DIR [--require PATH]");
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.mode === "generate") writePayloadManifest(options.payloadDir);
    const result = verifyPayloadManifest(options.payloadDir, options.platform, {
      requiredFiles: options.requiredFiles,
    });
    console.log(`Verified ${result.files} ${options.platform} payload files against ${result.manifestPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
