#!/usr/bin/env node
// scan-macos-min-os.mjs — audits the declared minimum macOS of every Mach-O.
//
// The bundle advertises bundle.macOS.minimumSystemVersion in
// apps/shell/src-tauri/tauri.macos.conf.json, but the payload is assembled
// from third-party toolchains (JRE, Node, Python wheels, Ghostscript,
// Tesseract, qpdf) that each declare their own deployment target in
// LC_BUILD_VERSION (minos) or the legacy LC_VERSION_MIN_MACOSX load command.
// A binary whose min-OS exceeds the advertised floor will fail to load on the
// oldest supported macOS even though the installer accepted it.
//
// This scans every Mach-O under the payload (and optionally a built .app via
// --app), parses the load commands directly, and exits 1 listing offenders
// whose declared min-OS exceeds the floor. It always prints the MAXIMUM
// min-OS found - the true floor of the shipped bits.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { platformPath } from "../installer/platforms.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MACOS_CONF_PATH = path.join(REPO_ROOT, "apps", "shell", "src-tauri", "tauri.macos.conf.json");

const MACH_O_64_MAGICS = new Set(["feedfacf", "cffaedfe"]);
const MACH_HEADER_64_SIZE = 32;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const BUILD_VERSION_PLATFORM_MACOS = 1;

export function parseArgs(argv) {
  const args = { payloadDir: undefined, appPath: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--payload-dir") {
      args.payloadDir = argv[++index];
    } else if (arg.startsWith("--payload-dir=")) {
      args.payloadDir = arg.slice("--payload-dir=".length);
    } else if (arg === "--app") {
      args.appPath = argv[++index];
    } else if (arg.startsWith("--app=")) {
      args.appPath = arg.slice("--app=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`scan-macos-min-os: unknown argument ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/scan-macos-min-os.mjs [--payload-dir PATH] [--app PATH]

Scans every Mach-O in the macOS arm64 payload (and optionally a built .app)
for its declared minimum macOS (LC_BUILD_VERSION minos / LC_VERSION_MIN_MACOSX)
and compares it against bundle.macOS.minimumSystemVersion in
apps/shell/src-tauri/tauri.macos.conf.json. Exits 1 listing offenders whose
min-OS exceeds that floor; always prints the maximum min-OS found.`);
}

/** @param {number} encoded @returns {string} X.Y or X.Y.Z from a Mach-O nibble-packed version */
export function decodeVersion(encoded) {
  const major = (encoded >>> 16) & 0xffff;
  const minor = (encoded >>> 8) & 0xff;
  const patch = encoded & 0xff;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/** @param {string} version @returns {number} comparable numeric key for "X.Y[.Z]" */
export function versionKey(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number(part));
  return major * 1_000_000 + minor * 1_000 + patch;
}

/**
 * Parse the declared minimum macOS out of a thin 64-bit Mach-O's load
 * commands. Returns null for non-Mach-O files; a { minOS: null } record for
 * Mach-O files that declare no deployment target.
 *
 * @param {string} filePath
 * @returns {null | { minOS: string | null }}
 */
export function readMachOMinOS(filePath) {
  const fileSize = statSync(filePath).size;
  if (fileSize < MACH_HEADER_64_SIZE) return null;
  const descriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(MACH_HEADER_64_SIZE);
    readSync(descriptor, header, 0, MACH_HEADER_64_SIZE, 0);
    const magic = header.subarray(0, 4).toString("hex");
    if (!MACH_O_64_MAGICS.has(magic)) return null;
    const littleEndian = magic === "cffaedfe";
    const readU32 = (buffer, offset) =>
      littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const sizeOfCommands = readU32(header, 20);
    const commands = Buffer.alloc(Math.min(sizeOfCommands, fileSize - MACH_HEADER_64_SIZE));
    readSync(descriptor, commands, 0, commands.length, MACH_HEADER_64_SIZE);

    const commandCount = readU32(header, 16);
    let offset = 0;
    for (let index = 0; index < commandCount; index += 1) {
      if (offset + 8 > commands.length) break;
      const command = readU32(commands, offset);
      const commandSize = readU32(commands, offset + 4);
      if (commandSize < 8 || offset + commandSize > commands.length) break;
      if (command === LC_BUILD_VERSION && commandSize >= 16) {
        const platform = readU32(commands, offset + 8);
        if (platform === BUILD_VERSION_PLATFORM_MACOS) {
          return { minOS: decodeVersion(readU32(commands, offset + 12)) };
        }
      } else if (command === LC_VERSION_MIN_MACOSX && commandSize >= 12) {
        return { minOS: decodeVersion(readU32(commands, offset + 8)) };
      }
      offset += commandSize;
    }
    return { minOS: null };
  } finally {
    closeSync(descriptor);
  }
}

function collectFiles(rootDir) {
  const files = [];
  const visit = (currentDir) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) continue; // built .app bundles contain framework symlinks
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
 * @param {string} rootDir
 * @param {string} rootLabel
 * @returns {{ records: { relPath: string, minOS: string | null }[], nonMachOCount: number }}
 */
export function scanRoot(rootDir, rootLabel) {
  const resolvedRoot = path.resolve(rootDir);
  const records = [];
  let nonMachOCount = 0;
  for (const filePath of collectFiles(resolvedRoot)) {
    const parsed = readMachOMinOS(filePath);
    if (parsed === null) {
      nonMachOCount += 1;
      continue;
    }
    records.push({
      relPath: `${rootLabel}/${path.relative(resolvedRoot, filePath).replaceAll("\\", "/")}`,
      minOS: parsed.minOS,
    });
  }
  return { records, nonMachOCount };
}

export function readConfiguredFloor(confPath = MACOS_CONF_PATH) {
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const floor = conf?.bundle?.macOS?.minimumSystemVersion;
  if (typeof floor !== "string" || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(floor)) {
    throw new Error(
      `scan-macos-min-os: could not read bundle.macOS.minimumSystemVersion from ${confPath}.`,
    );
  }
  return floor;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }
  const floor = readConfiguredFloor();
  const roots = [
    {
      dir: path.resolve(args.payloadDir ?? platformPath(REPO_ROOT, "macos-arm64", "payloadOutputDir")),
      label: "payload",
    },
  ];
  if (args.appPath) {
    roots.push({ dir: path.resolve(args.appPath), label: "app" });
  }

  const records = [];
  let nonMachOCount = 0;
  for (const root of roots) {
    const scanned = scanRoot(root.dir, root.label);
    records.push(...scanned.records);
    nonMachOCount += scanned.nonMachOCount;
  }
  if (records.length === 0) {
    throw new Error("scan-macos-min-os: no Mach-O files found.");
  }

  const declared = records.filter((record) => record.minOS !== null);
  const undeclared = records.filter((record) => record.minOS === null);
  const byVersion = new Map();
  for (const record of declared) {
    if (!byVersion.has(record.minOS)) byVersion.set(record.minOS, []);
    byVersion.get(record.minOS).push(record.relPath);
  }
  const versions = [...byVersion.keys()].sort((a, b) => versionKey(a) - versionKey(b));

  console.log(`scan-macos-min-os: configured floor ${floor} (bundle.macOS.minimumSystemVersion)`);
  console.log(
    `scan-macos-min-os: scanned ${records.length} Mach-O files (${nonMachOCount} non-Mach-O skipped)`,
  );
  for (const version of versions) {
    console.log(`  min-OS ${version}: ${byVersion.get(version).length} files`);
  }
  if (undeclared.length > 0) {
    console.log(`  no declared min-OS: ${undeclared.length} files`);
  }

  const maximum = versions.at(-1);
  const maximumFiles = byVersion.get(maximum);
  console.log(
    `scan-macos-min-os: maximum min-OS found is ${maximum} ` +
      `(true floor of the shipped bits), e.g. ${maximumFiles[0]}`,
  );

  const offenders = declared.filter((record) => versionKey(record.minOS) > versionKey(floor));
  if (offenders.length > 0) {
    console.error(
      `scan-macos-min-os: ${offenders.length} files declare a min-OS above the ${floor} floor:`,
    );
    for (const offender of offenders) {
      console.error(`  ${offender.minOS.padEnd(7)} ${offender.relPath}`);
    }
    console.error(
      "scan-macos-min-os: raise bundle.macOS.minimumSystemVersion or rebuild the offenders " +
        "against the floor.",
    );
    return 1;
  }
  console.log(`scan-macos-min-os: all declared min-OS values are within the ${floor} floor.`);
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
