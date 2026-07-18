#!/usr/bin/env node
// sign-macos-payload.mjs — Developer ID signs every Mach-O in the macOS payload.
//
// The Tauri bundler signs the app binary and the externalBin sidecars, but the
// bundled payload (JRE + Stirling engine + OCR toolchain + MCP Node runtime)
// ships as plain resources that Tauri does not sign. Notarization requires
// every Mach-O in the bundle to carry a hardened-runtime Developer ID
// signature, so this script signs the payload tree leaf-out: libraries first,
// then executables, never `codesign --deep`.
//
// Entitlements are granted per binary class, only where proven necessary:
//   - jre/bin/* and jre/lib/jspawnhelper  -> entitlements/jvm.entitlements
//   - mcp/node/bin/node                   -> entitlements/node.entitlements
//   - every other Mach-O                  -> no entitlements
// (Libraries never receive entitlements; they are meaningless on dylibs.)
//
// The signing identity comes from RAIOPDF_MAC_SIGN_IDENTITY (the full string,
// e.g. "Developer ID Application: Name (TEAMID)"). If it is unset the script
// fails loudly - a misconfigured "signed" build must never silently produce an
// unsigned payload. The payload manifest must be regenerated AFTER this script
// runs, because signing rewrites every Mach-O.

import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { platformPath } from "../installer/platforms.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTITLEMENTS_DIR = path.join(REPO_ROOT, "apps", "shell", "src-tauri", "entitlements");
const MAX_FILES_PER_CODESIGN = 100;

/** @typedef {"jvm" | "node" | "none"} EntitlementClass */
/** @typedef {{ absPath: string, relPath: string, kind: "executable" | "library", entitlementClass: EntitlementClass }} SignEntry */

const MACH_O_UNIVERSAL_MAGICS = new Set(["cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
const MACH_O_32_MAGICS = new Set(["feedface", "cefaedfe"]);
const MACH_O_64_MAGICS = new Set(["feedfacf", "cffaedfe"]);
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 0x2;

export function parseArgs(argv) {
  const args = { payloadDir: undefined, dryRun: false, verify: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--payload-dir") {
      args.payloadDir = argv[++index];
    } else if (arg.startsWith("--payload-dir=")) {
      args.payloadDir = arg.slice("--payload-dir=".length);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--verify") {
      args.verify = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`sign-macos-payload: unknown argument ${arg}`);
    }
  }
  if (args.dryRun && args.verify) {
    throw new Error("sign-macos-payload: --dry-run and --verify are mutually exclusive.");
  }
  if (args.payloadDir !== undefined && String(args.payloadDir).trim() === "") {
    throw new Error("sign-macos-payload: --payload-dir requires a path.");
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/sign-macos-payload.mjs [--payload-dir PATH] [--dry-run | --verify]

Signs every Mach-O in the macOS arm64 payload with the Developer ID identity in
RAIOPDF_MAC_SIGN_IDENTITY: hardened runtime, secure timestamp, libraries before
executables, entitlements only for the JVM and Node runtimes. --dry-run lists
every Mach-O with its planned entitlements class without signing. --verify runs
codesign --verify --strict per file, rejects ad-hoc signatures, checks the team
id against RAIOPDF_MAC_SIGN_IDENTITY when set, and summarizes failures.`);
}

function readPrefix(filePath, bytes) {
  const buffer = Buffer.alloc(bytes);
  const descriptor = openSync(filePath, "r");
  try {
    const length = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Classify a file by Mach-O magic bytes. Returns null for non-Mach-O files.
 * Only thin arm64 64-bit images are accepted as signable; universal, 32-bit,
 * and foreign-architecture images are reported so the caller can fail closed
 * (the package boundary validator rejects those before signing ever runs).
 *
 * @param {string} filePath
 * @returns {null | { signable: boolean, architecture: string, kind: "executable" | "library" }}
 */
export function classifyMachO(filePath) {
  const prefix = readPrefix(filePath, 16);
  if (prefix.length < 4) return null;
  const magic = prefix.subarray(0, 4).toString("hex");
  if (MACH_O_UNIVERSAL_MAGICS.has(magic)) {
    return { signable: false, architecture: "universal", kind: "library" };
  }
  if (MACH_O_32_MAGICS.has(magic)) {
    return { signable: false, architecture: "32-bit", kind: "library" };
  }
  if (!MACH_O_64_MAGICS.has(magic)) return null;
  if (prefix.length < 16) {
    return { signable: false, architecture: "truncated", kind: "library" };
  }
  const littleEndian = magic === "cffaedfe";
  const cpuType = littleEndian ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4);
  const fileType = littleEndian ? prefix.readUInt32LE(12) : prefix.readUInt32BE(12);
  const kind = fileType === MH_EXECUTE ? "executable" : "library";
  if (cpuType !== CPU_TYPE_ARM64) {
    return { signable: false, architecture: `cpu-0x${cpuType.toString(16)}`, kind };
  }
  return { signable: true, architecture: "arm64", kind };
}

/**
 * Entitlements class for an executable at a payload-relative path.
 * Mirrors the per-binary policy documented in the entitlements plists.
 *
 * @param {string} relPath payload-relative path, either separator
 * @returns {EntitlementClass}
 */
export function entitlementClassFor(relPath) {
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized.startsWith("jre/bin/") || normalized === "jre/lib/jspawnhelper") {
    return "jvm";
  }
  if (normalized === "mcp/node/bin/node") {
    return "node";
  }
  return "none";
}

/** @param {EntitlementClass} entitlementClass @returns {string | null} */
export function entitlementsFileFor(entitlementClass) {
  if (entitlementClass === "jvm") return path.join(ENTITLEMENTS_DIR, "jvm.entitlements");
  if (entitlementClass === "node") return path.join(ENTITLEMENTS_DIR, "node.entitlements");
  return null;
}

function collectFiles(rootDir) {
  const files = [];
  const visit = (currentDir) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `sign-macos-payload: symlinks are forbidden in the payload: ${path.relative(rootDir, fullPath)}`,
        );
      }
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };
  visit(rootDir);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Walk the payload and produce the signing plan: which Mach-Os exist, their
 * executable/library kind, and their entitlements class. Fails closed on any
 * Mach-O that is not thin arm64.
 *
 * @param {string} payloadDir
 * @returns {{ entries: SignEntry[], skippedCount: number }}
 */
export function buildSigningPlan(payloadDir) {
  const resolvedRoot = path.resolve(payloadDir);
  const entries = [];
  let skippedCount = 0;
  for (const filePath of collectFiles(resolvedRoot)) {
    const relPath = path.relative(resolvedRoot, filePath).replaceAll("\\", "/");
    const machO = classifyMachO(filePath);
    if (machO === null) {
      skippedCount += 1;
      continue;
    }
    if (!machO.signable) {
      throw new Error(
        `sign-macos-payload: ${relPath} is a ${machO.architecture} Mach-O; only thin arm64 is signable. ` +
          "Run scripts/validate-package-boundary.mjs - the payload should never contain this.",
      );
    }
    entries.push({
      absPath: filePath,
      relPath,
      kind: machO.kind,
      entitlementClass: machO.kind === "executable" ? entitlementClassFor(relPath) : "none",
    });
  }
  return { entries, skippedCount };
}

/**
 * Group plan entries into ordered codesign batches: all libraries first, then
 * executables grouped by entitlements class. Files within a batch share
 * identical codesign flags, which is the only case where one codesign
 * invocation may take multiple files.
 *
 * @param {SignEntry[]} entries
 * @returns {{ label: string, entitlementsFile: string | null, files: SignEntry[] }[]}
 */
export function buildBatches(entries) {
  const libraries = entries.filter((entry) => entry.kind === "library");
  const executablesByClass = new Map([
    ["none", []],
    ["jvm", []],
    ["node", []],
  ]);
  for (const entry of entries) {
    if (entry.kind === "executable") {
      executablesByClass.get(entry.entitlementClass).push(entry);
    }
  }
  const batches = [];
  if (libraries.length > 0) {
    batches.push({ label: "libraries (no entitlements)", entitlementsFile: null, files: libraries });
  }
  for (const [entitlementClass, files] of executablesByClass) {
    if (files.length === 0) continue;
    batches.push({
      label: `executables (${entitlementClass === "none" ? "no entitlements" : `${entitlementClass}.entitlements`})`,
      entitlementsFile: entitlementsFileFor(/** @type {EntitlementClass} */ (entitlementClass)),
      files,
    });
  }
  return batches;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function requireIdentity() {
  const identity = process.env.RAIOPDF_MAC_SIGN_IDENTITY;
  if (typeof identity !== "string" || identity.trim() === "") {
    throw new Error(`RAIOPDF_MAC_SIGN_IDENTITY is not set.

Set it to the full Developer ID Application identity before signing, e.g.:

  export RAIOPDF_MAC_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"

This is intentional: a misconfigured "signed" build must never silently produce
an unsigned payload. To inspect what would be signed without an identity, use
--dry-run. See docs/SIGNING.md.`);
  }
  return identity.trim();
}

function runCodesign(args) {
  const result = spawnSync("codesign", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) {
    throw new Error(`sign-macos-payload: failed to run codesign: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function signBatches(batches, identity) {
  for (const batch of batches) {
    if (batch.entitlementsFile && !existsSync(batch.entitlementsFile)) {
      throw new Error(`sign-macos-payload: entitlements file missing: ${batch.entitlementsFile}`);
    }
    console.log(`sign-macos-payload: signing ${batch.files.length} ${batch.label}`);
    for (const files of chunk(batch.files, MAX_FILES_PER_CODESIGN)) {
      const args = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
      if (batch.entitlementsFile) {
        args.push("--entitlements", batch.entitlementsFile);
      }
      args.push(...files.map((entry) => entry.absPath));
      const status = runCodesign(args);
      if (status !== 0) {
        throw new Error(
          `sign-macos-payload: codesign exited ${status} on a batch of ${files.length} ${batch.label} ` +
            `(first file: ${files[0].relPath}).`,
        );
      }
    }
  }
}

/**
 * Extract the ten-character team id from a full Developer ID identity string,
 * e.g. "Developer ID Application: Name (TEAMID)" -> "TEAMID".
 *
 * @param {string | undefined} identity
 * @returns {string | null}
 */
export function expectedTeamIdFrom(identity) {
  if (typeof identity !== "string") return null;
  const match = /\(([A-Z0-9]{10})\)\s*$/.exec(identity.trim());
  return match ? match[1] : null;
}

function verifyEntries(entries, expectedTeamId) {
  const failures = [];
  for (const entry of entries) {
    const strict = spawnSync("codesign", ["--verify", "--strict", entry.absPath], {
      encoding: "utf8",
    });
    if (strict.error) {
      throw new Error(`sign-macos-payload: failed to run codesign: ${strict.error.message}`);
    }
    if (strict.status !== 0) {
      const detail = `${strict.stderr ?? ""}${strict.stdout ?? ""}`.trim().split("\n")[0] ?? "";
      failures.push({ relPath: entry.relPath, detail });
      continue;
    }
    // A linker-generated ad-hoc signature passes --verify --strict, so also
    // require a real identity (and the expected team, when known).
    const display = spawnSync("codesign", ["-dvv", entry.absPath], { encoding: "utf8" });
    const info = `${display.stderr ?? ""}${display.stdout ?? ""}`;
    if (/^Signature=adhoc$/mu.test(info)) {
      failures.push({ relPath: entry.relPath, detail: "ad-hoc signature (not Developer ID signed)" });
      continue;
    }
    const teamMatch = /^TeamIdentifier=(.+)$/mu.exec(info);
    const team = teamMatch ? teamMatch[1].trim() : null;
    if (expectedTeamId && team !== expectedTeamId) {
      failures.push({
        relPath: entry.relPath,
        detail: `signed by team ${team ?? "unknown"}, expected ${expectedTeamId}`,
      });
    }
  }
  return failures;
}

function summarize(entries, skippedCount, verb) {
  const executables = entries.filter((entry) => entry.kind === "executable").length;
  const libraries = entries.length - executables;
  console.log(
    `sign-macos-payload: ${verb} ${executables} executables / ${libraries} libraries, ` +
      `${skippedCount} skipped non-Mach-O files`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }
  const payloadDir = path.resolve(
    args.payloadDir ?? platformPath(REPO_ROOT, "macos-arm64", "payloadOutputDir"),
  );
  const { entries, skippedCount } = buildSigningPlan(payloadDir);
  if (entries.length === 0) {
    throw new Error(`sign-macos-payload: no Mach-O files found under ${payloadDir}.`);
  }

  if (args.dryRun) {
    for (const batch of buildBatches(entries)) {
      console.log(`# batch: ${batch.label}`);
      for (const entry of batch.files) {
        console.log(`${entry.kind.padEnd(10)} ${entry.entitlementClass.padEnd(4)} ${entry.relPath}`);
      }
    }
    summarize(entries, skippedCount, "would sign");
    return 0;
  }

  if (args.verify) {
    const failures = verifyEntries(entries, expectedTeamIdFrom(process.env.RAIOPDF_MAC_SIGN_IDENTITY));
    summarize(entries, skippedCount, "verified");
    if (failures.length > 0) {
      console.error(`sign-macos-payload: ${failures.length} files failed codesign --verify --strict:`);
      for (const failure of failures) {
        console.error(`  ${failure.relPath}${failure.detail ? ` - ${failure.detail}` : ""}`);
      }
      return 1;
    }
    console.log("sign-macos-payload: all signatures verified strictly.");
    return 0;
  }

  const identity = requireIdentity();
  signBatches(buildBatches(entries), identity);
  summarize(entries, skippedCount, "signed");
  console.log(
    "sign-macos-payload: regenerate the payload manifest now - signing rewrote every Mach-O.",
  );
  return 0;
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (import.meta.url === invokedUrl) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
