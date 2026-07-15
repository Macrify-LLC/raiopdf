#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalArtifactNames, getPlatform } from "../installer/platforms.mjs";
import { verifyTauriUpdaterSignature } from "./minisign.mjs";

const DEFAULT_BASELINES_PATH = fileURLToPath(
  new URL("./package-size-baselines.json", import.meta.url),
);
const MIN_GROWTH_REASON_LENGTH = 20;
const MACH_O_MAGICS = new Set([
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
]);
const ELF_MAGIC = "7f454c46";

function requireNonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`validate-package-boundary: ${name} is required.`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const args = {
    platformId: undefined,
    rootDir: undefined,
    installerPath: undefined,
    baselinesPath: DEFAULT_BASELINES_PATH,
    allowGrowth: false,
    growthReason: undefined,
    releaseVersion: undefined,
    ghostscriptVersion: undefined,
    includeLatest: false,
    payloadSize: false,
    payloadRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--platform") {
      args.platformId = argv[++index];
    } else if (arg.startsWith("--platform=")) {
      args.platformId = arg.slice("--platform=".length);
    } else if (arg === "--root") {
      args.rootDir = argv[++index];
    } else if (arg.startsWith("--root=")) {
      args.rootDir = arg.slice("--root=".length);
    } else if (arg === "--installer") {
      args.installerPath = argv[++index];
    } else if (arg.startsWith("--installer=")) {
      args.installerPath = arg.slice("--installer=".length);
    } else if (arg === "--baselines") {
      args.baselinesPath = argv[++index];
    } else if (arg.startsWith("--baselines=")) {
      args.baselinesPath = arg.slice("--baselines=".length);
    } else if (arg === "--allow-growth") {
      args.allowGrowth = true;
    } else if (arg === "--growth-reason") {
      args.growthReason = argv[++index];
    } else if (arg.startsWith("--growth-reason=")) {
      args.growthReason = arg.slice("--growth-reason=".length);
    } else if (arg === "--release-version") {
      args.releaseVersion = argv[++index];
    } else if (arg.startsWith("--release-version=")) {
      args.releaseVersion = arg.slice("--release-version=".length);
    } else if (arg === "--ghostscript-version") {
      args.ghostscriptVersion = argv[++index];
    } else if (arg.startsWith("--ghostscript-version=")) {
      args.ghostscriptVersion = arg.slice("--ghostscript-version=".length);
    } else if (arg === "--include-latest") {
      args.includeLatest = true;
    } else if (arg === "--payload-size") {
      args.payloadSize = true;
    } else if (arg === "--payload-root") {
      args.payloadRoot = argv[++index];
    } else if (arg.startsWith("--payload-root=")) {
      args.payloadRoot = arg.slice("--payload-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`validate-package-boundary: unknown argument ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/validate-package-boundary.mjs --platform PLATFORM --root PATH
       [--installer PATH] [--baselines PATH]
       [--allow-growth --growth-reason "why the package grew"]
       [--payload-size]
       [--release-version X.Y.Z --ghostscript-version X.Y.Z [--include-latest]]
       [--payload-root PATH]

Recursively rejects native files for the other operating system, universal or
non-arm64 Mach-O files in the macOS arm64 package, and symlinks. When --installer
is supplied, its size is checked against the committed per-platform baseline.
With --payload-size, checks the unpacked root against its payload baseline.
With --release-version, validates the exact platform release asset set,
checksums, updater minisign signature, installer size, and --payload-root.`);
}

function readPrefix(filePath, bytes = 12) {
  const buffer = Buffer.alloc(bytes);
  const descriptor = openSync(filePath, "r");
  try {
    const length = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function readRange(filePath, bytes, position) {
  const buffer = Buffer.alloc(bytes);
  const descriptor = openSync(filePath, "r");
  try {
    const length = readSync(descriptor, buffer, 0, bytes, position);
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function classifyNativeBinary(filePath) {
  const prefix = readPrefix(filePath, 64);
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) {
    if (prefix.length < 64) {
      return { format: "pe", architecture: "invalid" };
    }
    const peOffset = prefix.readUInt32LE(0x3c);
    const coff = readRange(filePath, 6, peOffset);
    if (coff.length < 6 || coff.subarray(0, 4).toString("hex") !== "50450000") {
      return { format: "pe", architecture: "invalid" };
    }
    const machine = coff.readUInt16LE(4);
    const architecture = machine === 0x8664
      ? "x86_64"
      : machine === 0xaa64
        ? "arm64"
        : machine === 0x014c
          ? "x86"
          : `machine-0x${machine.toString(16)}`;
    return { format: "pe", architecture };
  }
  if (prefix.length < 4) {
    return null;
  }
  const magic = prefix.subarray(0, 4).toString("hex");
  if (magic === ELF_MAGIC) {
    if (prefix.length < 20) {
      return { format: "elf", architecture: "invalid" };
    }
    const littleEndian = prefix[5] === 1;
    const machine = littleEndian ? prefix.readUInt16LE(18) : prefix.readUInt16BE(18);
    const architecture = machine === 0x3e
      ? "x86_64"
      : machine === 0xb7
        ? "arm64"
        : `machine-0x${machine.toString(16)}`;
    return { format: "elf", architecture };
  }
  if (!MACH_O_MAGICS.has(magic)) {
    return null;
  }
  if (["cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)) {
    return { format: "mach-o", architecture: "universal" };
  }
  if (prefix.length < 8) {
    return { format: "mach-o", architecture: "unknown" };
  }
  const littleEndian = magic === "cefaedfe" || magic === "cffaedfe";
  const cpuType = littleEndian ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4);
  const architecture = cpuType === 0x0100000c
    ? "arm64"
    : cpuType === 0x01000007
      ? "x86_64"
      : `cpu-0x${cpuType.toString(16)}`;
  return { format: "mach-o", architecture };
}

function matchesForeignMarker(relativePath, marker) {
  const candidate = relativePath.toLowerCase().replaceAll("\\", "/");
  marker.lastIndex = 0;
  return marker.test(candidate);
}

function collectFiles(rootDir) {
  const files = [];
  const visit = (currentDir) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `validate-package-boundary: symlinks are forbidden in package staging: ${path.relative(rootDir, fullPath)}`,
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
  return files;
}

export function validatePackageBoundary({ rootDir, platformId }) {
  const resolvedRoot = path.resolve(requireNonEmptyString("rootDir", rootDir));
  const platform = getPlatform(requireNonEmptyString("platformId", platformId));
  const rootStats = statSync(resolvedRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`validate-package-boundary: root is not a directory: ${resolvedRoot}`);
  }

  const files = collectFiles(resolvedRoot);
  let totalBytes = 0;
  for (const filePath of files) {
    const relativePath = path.relative(resolvedRoot, filePath);
    totalBytes += statSync(filePath).size;
    const marker = platform.foreignFileMarkers.find((value) =>
      matchesForeignMarker(relativePath, value),
    );
    if (marker) {
      throw new Error(
        `validate-package-boundary: ${platformId} package contains foreign marker ${marker} in ${relativePath}.`,
      );
    }

    const binary = classifyNativeBinary(filePath);
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const isInstallerBootstrap =
      binary?.format === "pe" &&
      binary.architecture === "x86" &&
      (platform.artifact.installerPattern.test(normalizedPath) ||
        platform.artifact.rawInstallerPattern.test(normalizedPath));
    const isNativeException = binary && platform.nativeBinaryExceptions.some(
      (exception) =>
        exception.path === normalizedPath &&
        exception.format === binary.format &&
        exception.architecture === binary.architecture,
    );
    if (platformId === "windows-x64" && binary?.format === "mach-o") {
      throw new Error(
        `validate-package-boundary: windows-x64 package contains Mach-O binary ${relativePath}.`,
      );
    }
    if (binary?.format === "elf") {
      throw new Error(
        `validate-package-boundary: ${platformId} package contains Linux ELF binary ${relativePath}.`,
      );
    }
    if (
      platformId === "windows-x64" &&
      binary?.format === "pe" &&
      binary.architecture !== "x86_64" &&
      !isNativeException &&
      !isInstallerBootstrap
    ) {
      throw new Error(
        `validate-package-boundary: windows-x64 package contains ${binary.architecture} PE binary ${relativePath}.`,
      );
    }
    if (platformId === "macos-arm64" && binary?.format === "pe") {
      throw new Error(
        `validate-package-boundary: macos-arm64 package contains PE binary ${relativePath}.`,
      );
    }
    if (
      platformId === "macos-arm64" &&
      binary?.format === "mach-o" &&
      binary.architecture !== "arm64"
    ) {
      throw new Error(
        `validate-package-boundary: macos-arm64 package contains ${binary.architecture} Mach-O binary ${relativePath}; universal and Intel binaries are not allowed.`,
      );
    }
  }

  return {
    platformId,
    rootDir: resolvedRoot,
    fileCount: files.length,
    totalBytes,
  };
}

function validateMeasuredSize({
  actualBytes,
  platformId,
  kind,
  label,
  baselinesPath = DEFAULT_BASELINES_PATH,
  baselines,
  allowGrowth = false,
  growthReason,
}) {
  getPlatform(requireNonEmptyString("platformId", platformId));
  const policy = baselines ?? JSON.parse(readFileSync(baselinesPath, "utf8"));
  if (policy.schemaVersion !== 1) {
    throw new Error(
      `validate-package-boundary: unsupported size baseline schema ${policy.schemaVersion}.`,
    );
  }
  const baseline = policy.platforms?.[platformId]?.[kind];
  if (!baseline || !Number.isSafeInteger(baseline.baselineBytes) || baseline.baselineBytes <= 0) {
    throw new Error(
      `validate-package-boundary: ${platformId} has no ${kind} size baseline. Record the first verified platform-only release in scripts/package-size-baselines.json before shipping.`,
    );
  }

  const percentAllowance = Math.floor(
    baseline.baselineBytes * (baseline.maxGrowthPercent / 100),
  );
  const allowedGrowth = Math.min(baseline.maxGrowthBytes, percentAllowance);
  const maximumBytes = baseline.baselineBytes + allowedGrowth;
  if (actualBytes > maximumBytes) {
    const reason = typeof growthReason === "string" ? growthReason.trim() : "";
    if (!allowGrowth || reason.length < MIN_GROWTH_REASON_LENGTH) {
      throw new Error(
        `validate-package-boundary: ${platformId} ${label} is ${actualBytes} bytes, above the ${maximumBytes}-byte limit based on ${baseline.baselineVersion}. ` +
          `Update the reviewed baseline, or pass --allow-growth with a specific --growth-reason of at least ${MIN_GROWTH_REASON_LENGTH} characters.`,
      );
    }
  }

  return {
    platformId,
    kind,
    actualBytes,
    baselineBytes: baseline.baselineBytes,
    maximumBytes,
    growthOverride: actualBytes > maximumBytes,
  };
}

export function validateInstallerSize({ installerPath, ...options }) {
  const resolvedInstaller = path.resolve(
    requireNonEmptyString("installerPath", installerPath),
  );
  return {
    ...validateMeasuredSize({
      ...options,
      actualBytes: statSync(resolvedInstaller).size,
      kind: "installer",
      label: "installer",
    }),
    installerPath: resolvedInstaller,
  };
}

export function validatePayloadSize({ payloadRoot, platformId, ...options }) {
  const boundary = validatePackageBoundary({ rootDir: payloadRoot, platformId });
  return {
    ...boundary,
    ...validateMeasuredSize({
      ...options,
      actualBytes: boundary.totalBytes,
      platformId,
      kind: "payload",
      label: "unpacked payload",
    }),
  };
}

export function expectedPlatformReleaseAssets({
  platformId,
  version,
  ghostscriptVersion,
  includeLatest = false,
}) {
  const names = canonicalArtifactNames(platformId, version);
  const platformQualifier = platformId === "macos-arm64" ? "-macos-arm64" : "";
  const complianceName = (suffix) => `RaioPDF-${version}${platformQualifier}-${suffix}`;
  const ghostscriptSource = platformId === "macos-arm64"
    ? `ghostscript-${requireNonEmptyString("ghostscriptVersion", ghostscriptVersion)}-macos-arm64-source.tar.xz`
    : `ghostscript-${requireNonEmptyString("ghostscriptVersion", ghostscriptVersion)}-source.tar.xz`;
  const checksums = platformId === "macos-arm64"
    ? "SHA256SUMS-macos-arm64.txt"
    : "SHA256SUMS.txt";
  const assets = new Set([
    names.installer,
    names.updater,
    `${names.updater}.sig`,
    complianceName("third-party-notices.txt"),
    complianceName("component-manifest.json"),
    complianceName("source-correspondence.md"),
    complianceName("license-notices.txt"),
    complianceName("ghostscript-source-offer.txt"),
    ghostscriptSource,
    checksums,
  ]);
  if (includeLatest) assets.add("latest.json");
  return [...assets].sort((a, b) => a.localeCompare(b));
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function validatePlatformReleaseStage({
  rootDir,
  platformId,
  version,
  ghostscriptVersion,
  includeLatest = false,
  baselines,
  baselinesPath = DEFAULT_BASELINES_PATH,
  allowGrowth = false,
  growthReason,
  skipUpdaterSignature = false,
  updaterPubkey,
  payloadRoot,
}) {
  const boundary = validatePackageBoundary({ rootDir, platformId });
  const expected = expectedPlatformReleaseAssets({
    platformId,
    version,
    ghostscriptVersion,
    includeLatest,
  });
  const actual = readdirSync(boundary.rootDir, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `validate-package-boundary: platform release stage contains unexpected non-file ${entry.name}.`,
        );
      }
      return entry.name;
    })
    .sort((a, b) => a.localeCompare(b));
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `validate-package-boundary: ${platformId} release stage asset mismatch; missing: ${missing.join(", ") || "(none)"}; unexpected: ${unexpected.join(", ") || "(none)"}.`,
    );
  }

  const checksumEntries = new Map();
  const checksumsName = platformId === "macos-arm64"
    ? "SHA256SUMS-macos-arm64.txt"
    : "SHA256SUMS.txt";
  for (const line of readFileSync(path.join(boundary.rootDir, checksumsName), "utf8")
    .trim()
    .split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
    if (!match || checksumEntries.has(match[2])) {
      throw new Error(`validate-package-boundary: malformed or duplicate checksum line: ${line}`);
    }
    checksumEntries.set(match[2], match[1]);
  }
  for (const filename of expected.filter((name) => name !== checksumsName)) {
    if (checksumEntries.get(filename) !== sha256(path.join(boundary.rootDir, filename))) {
      throw new Error(
        `validate-package-boundary: SHA256SUMS.txt is missing or stale for ${filename}.`,
      );
    }
  }
  const checksumExtras = [...checksumEntries.keys()].filter(
    (name) => name === checksumsName || !expected.includes(name),
  );
  if (checksumExtras.length > 0) {
    throw new Error(
      `validate-package-boundary: SHA256SUMS.txt contains unexpected entries: ${checksumExtras.join(", ")}.`,
    );
  }

  const installerPath = path.join(
    boundary.rootDir,
    canonicalArtifactNames(platformId, version).installer,
  );
  if (!skipUpdaterSignature) {
    const updaterPath = path.join(
      boundary.rootDir,
      canonicalArtifactNames(platformId, version).updater,
    );
    verifyTauriUpdaterSignature(updaterPath, `${updaterPath}.sig`, {
      pubkey: updaterPubkey,
      label: `${platformId} staged updater signature`,
    });
  }
  const size = validateInstallerSize({
    installerPath,
    platformId,
    baselines,
    baselinesPath,
    allowGrowth,
    growthReason,
  });
  const payloadSize = validatePayloadSize({
    payloadRoot: requireNonEmptyString("payloadRoot", payloadRoot),
    platformId,
    baselines,
    baselinesPath,
    allowGrowth,
    growthReason,
  });
  return { ...boundary, assets: actual, size, payloadSize };
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (import.meta.url === invokedUrl) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      usage();
      process.exit(0);
    }
    if (args.releaseVersion) {
      const stage = validatePlatformReleaseStage({
        ...args,
        version: args.releaseVersion,
      });
      console.log(
        `validate-package-boundary: ${stage.platformId} release stage ok (${stage.assets.length} assets, ${stage.size.actualBytes} installer bytes)`,
      );
    } else {
      const boundary = validatePackageBoundary(args);
      console.log(
        `validate-package-boundary: ${boundary.platformId} boundary ok (${boundary.fileCount} files, ${boundary.totalBytes} bytes)`,
      );
    }
    if (!args.releaseVersion && args.installerPath) {
      const size = validateInstallerSize(args);
      console.log(
        `validate-package-boundary: installer size ok (${size.actualBytes}/${size.maximumBytes} bytes)`,
      );
    }
    if (!args.releaseVersion && args.payloadSize) {
      const payload = validatePayloadSize({ ...args, payloadRoot: args.rootDir });
      console.log(
        `validate-package-boundary: payload size ok (${payload.actualBytes}/${payload.maximumBytes} bytes)`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
