#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import {
  buildLatestJsonManifest,
  canonicalInstallerFilename,
} from "./generate-latest-json.mjs";
import { verifyAuthenticodeSignature } from "./authenticode.mjs";
import { verifyTauriUpdaterSignature } from "./minisign.mjs";

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
const DEFAULT_NSIS_DIR = fileURLToPath(
  new URL("../apps/shell/src-tauri/target/release/bundle/nsis/", import.meta.url),
);
const DEFAULT_ASSET_DIR = fileURLToPath(new URL("../release-assets/signed/", import.meta.url));
const DEFAULT_PINS_PATH = fileURLToPath(new URL("../installer/PINS.env", import.meta.url));
const DEFAULT_PAYLOAD_SEARCH_ROOTS = [
  fileURLToPath(new URL("../target/release/", import.meta.url)),
  fileURLToPath(new URL("../apps/shell/src-tauri/target/release/", import.meta.url)),
  fileURLToPath(new URL("../apps/shell/src-tauri/payload/", import.meta.url)),
];
const REQUIRED_LEGAL_FILES = [
  ["THIRD-PARTY-NOTICES.txt", (version) => `RaioPDF-${version}-third-party-notices.txt`],
  ["COMPONENT-MANIFEST.json", (version) => `RaioPDF-${version}-component-manifest.json`],
  ["RELEASE-SOURCE-CORRESPONDENCE.md", (version) => `RaioPDF-${version}-source-correspondence.md`],
  ["RAIOPDF-LICENSE-NOTICES.txt", (version) => `RaioPDF-${version}-license-notices.txt`],
  [
    path.join("source-offers", "GHOSTSCRIPT-SOURCE-OFFER.txt"),
    (version) => `RaioPDF-${version}-ghostscript-source-offer.txt`,
  ],
];

function requireValue(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`prepare-signed-release-assets: ${name} is required.`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const args = {
    tag: undefined,
    nsisDir: DEFAULT_NSIS_DIR,
    outDir: DEFAULT_ASSET_DIR,
    payloadDir: undefined,
    pinsPath: DEFAULT_PINS_PATH,
    ghostscriptSource: undefined,
    upload: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = argv[++index];
    } else if (arg.startsWith("--tag=")) {
      args.tag = arg.slice("--tag=".length);
    } else if (arg === "--nsis-dir") {
      args.nsisDir = argv[++index];
    } else if (arg.startsWith("--nsis-dir=")) {
      args.nsisDir = arg.slice("--nsis-dir=".length);
    } else if (arg === "--out-dir") {
      args.outDir = argv[++index];
    } else if (arg.startsWith("--out-dir=")) {
      args.outDir = arg.slice("--out-dir=".length);
    } else if (arg === "--payload-dir") {
      args.payloadDir = argv[++index];
    } else if (arg.startsWith("--payload-dir=")) {
      args.payloadDir = arg.slice("--payload-dir=".length);
    } else if (arg === "--pins") {
      args.pinsPath = argv[++index];
    } else if (arg.startsWith("--pins=")) {
      args.pinsPath = arg.slice("--pins=".length);
    } else if (arg === "--ghostscript-source") {
      args.ghostscriptSource = argv[++index];
    } else if (arg.startsWith("--ghostscript-source=")) {
      args.ghostscriptSource = arg.slice("--ghostscript-source=".length);
    } else if (arg === "--upload") {
      args.upload = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`prepare-signed-release-assets: unknown argument ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log(`Usage: node scripts/prepare-signed-release-assets.mjs --tag vX.Y.Z [--upload]
       [--nsis-dir PATH] [--payload-dir PATH] [--out-dir PATH]
       [--ghostscript-source PATH] [--pins PATH]

Copies the locally signed NSIS installer and updater signature into canonical
public release asset names, stages release legal/source-correspondence assets,
writes latest.json, and writes SHA256SUMS.txt.

Default NSIS input: apps/shell/src-tauri/target/release/bundle/nsis
Default payload search: target/release, apps/shell/src-tauri/target/release
Default output: release-assets/signed

Requires RAIOPDF_SIGN_EXPECTED_THUMBPRINT, RAIOPDF_SIGN_THUMBPRINT, or exact
RAIOPDF_SIGN_EXPECTED_SUBJECT so the staged installer must have a valid
timestamped Authenticode signature from the expected signer. Also verifies the
Tauri updater .sig against the installer bytes and configured updater pubkey.`);
}

function resolveTag(tagOverride) {
  if (tagOverride !== undefined) {
    return requireValue("tag", tagOverride);
  }
  try {
    return execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "prepare-signed-release-assets: pass --tag vX.Y.Z or run on a tagged release commit.",
    );
  }
}

function versionFromTag(tag) {
  const version = tag.replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`prepare-signed-release-assets: tag must resolve to semver (got ${tag}).`);
  }
  return version;
}

function installerVersion(filename) {
  const match = /(?:^|[_-])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:[_-])/.exec(
    filename,
  );
  if (!match) {
    throw new Error(
      `prepare-signed-release-assets: could not read version from installer ${filename}.`,
    );
  }
  return match[1];
}

function findSignedInstaller(nsisDir, version) {
  if (!existsSync(nsisDir)) {
    throw new Error(`prepare-signed-release-assets: NSIS directory not found: ${nsisDir}`);
  }

  const exeFiles = readdirSync(nsisDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => entry.name)
    .filter((name) => !/unsigned/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (exeFiles.length !== 1) {
    throw new Error(
      `prepare-signed-release-assets: expected exactly one signed NSIS .exe in ${nsisDir}, found ${exeFiles.length}: ${exeFiles.join(
        ", ",
      )}`,
    );
  }

  const sourceExe = exeFiles[0];
  const sourceVersion = installerVersion(sourceExe);
  if (sourceVersion !== version) {
    throw new Error(
      `prepare-signed-release-assets: installer ${sourceExe} is version ${sourceVersion}, not ${version}.`,
    );
  }

  const sourceSig = `${sourceExe}.sig`;
  if (!existsSync(path.join(nsisDir, sourceSig))) {
    throw new Error(`prepare-signed-release-assets: missing updater signature ${sourceSig}.`);
  }

  return { sourceExe, sourceSig };
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parsePins(pinsPath) {
  if (!existsSync(pinsPath)) {
    throw new Error(`prepare-signed-release-assets: pins file not found: ${pinsPath}`);
  }
  const pins = {};
  for (const line of readFileSync(pinsPath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(trimmed);
    if (match) {
      pins[match[1]] = match[2];
    }
  }
  for (const key of ["GHOSTSCRIPT_VERSION", "GHOSTSCRIPT_SOURCE_URL", "GHOSTSCRIPT_SOURCE_SHA256"]) {
    requireValue(`pins.${key}`, pins[key]);
  }
  return pins;
}

function findPayloadLegalDir(payloadDir) {
  const explicit = payloadDir ? path.resolve(payloadDir) : null;
  const candidates = explicit
    ? [explicit.endsWith(`${path.sep}legal`) ? explicit : path.join(explicit, "legal")]
    : DEFAULT_PAYLOAD_SEARCH_ROOTS.flatMap((root) => collectPayloadLegalDirs(root));
  const existing = candidates
    .filter((candidate, index, list) => list.indexOf(candidate) === index)
    .filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
    .sort((a, b) => a.localeCompare(b));

  if (existing.length !== 1) {
    throw new Error(
      `prepare-signed-release-assets: expected exactly one payload legal directory, found ${existing.length}: ${existing.join(
        ", ",
      )}. Pass --payload-dir to disambiguate.`,
    );
  }

  return existing[0];
}

function collectPayloadLegalDirs(root) {
  const found = [];
  if (!existsSync(root)) {
    return found;
  }
  const rootStats = statSync(root);
  if (!rootStats.isDirectory()) {
    return found;
  }
  if (path.basename(root) === "payload" && existsSync(path.join(root, "legal"))) {
    found.push(path.join(root, "legal"));
  }
  collectPayloadLegalDirsInto(root, found);
  return found;
}

function collectPayloadLegalDirsInto(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.name === "payload" && existsSync(path.join(child, "legal"))) {
      found.push(path.join(child, "legal"));
      continue;
    }
    collectPayloadLegalDirsInto(child, found);
  }
}

function stageLegalAssets({ legalDir, outDir, version }) {
  const staged = [];
  for (const [relativePath, assetNameForVersion] of REQUIRED_LEGAL_FILES) {
    const source = path.join(legalDir, relativePath);
    if (!existsSync(source) || statSync(source).size === 0) {
      throw new Error(`prepare-signed-release-assets: missing legal payload file ${source}`);
    }
    const assetName = assetNameForVersion(version);
    copyFileSync(source, path.join(outDir, assetName));
    staged.push(assetName);
  }
  return staged;
}

function runLegalPayloadCheck({ legalDir, releaseTag }) {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./generate-legal-notices.mjs", import.meta.url)),
      "--payload-dir",
      path.dirname(legalDir),
      "--check",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: releaseTag,
      },
    },
  );
}

function validateComponentManifest({ legalDir, version, pins }) {
  const manifestPath = path.join(legalDir, "COMPONENT-MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.product !== "RaioPDF") {
    throw new Error(`prepare-signed-release-assets: component manifest product is ${manifest.product}.`);
  }
  if (manifest.releaseVersion !== version) {
    throw new Error(
      `prepare-signed-release-assets: component manifest releaseVersion ${manifest.releaseVersion} does not match ${version}.`,
    );
  }
  const raio = manifest.components?.find((entry) => entry.name === "RaioPDF");
  if (raio?.version !== version) {
    throw new Error("prepare-signed-release-assets: component manifest RaioPDF version is stale.");
  }
  const ghostscript = manifest.components?.find((entry) => entry.name === "Ghostscript");
  if (!ghostscript) {
    throw new Error("prepare-signed-release-assets: component manifest is missing Ghostscript.");
  }
  if (ghostscript.version !== pins.GHOSTSCRIPT_VERSION) {
    throw new Error("prepare-signed-release-assets: component manifest Ghostscript version is stale.");
  }
  if (ghostscript.license !== "AGPL-3.0-only") {
    throw new Error("prepare-signed-release-assets: component manifest Ghostscript license is not AGPL-3.0-only.");
  }
  if (ghostscript.source?.url !== pins.GHOSTSCRIPT_SOURCE_URL) {
    throw new Error("prepare-signed-release-assets: component manifest Ghostscript source URL is stale.");
  }
  if (ghostscript.source?.sha256 !== pins.GHOSTSCRIPT_SOURCE_SHA256) {
    throw new Error("prepare-signed-release-assets: component manifest Ghostscript source SHA256 is stale.");
  }
}

function stageGhostscriptSource({ pins, sourceArchive, outDir }) {
  const assetName = `ghostscript-${pins.GHOSTSCRIPT_VERSION}-source.tar.xz`;
  const target = path.join(outDir, assetName);
  if (sourceArchive) {
    copyFileSync(sourceArchive, target);
  } else {
    execFileSync(
      "curl",
      ["-fL", "--retry", "3", "--retry-delay", "2", "-o", target, pins.GHOSTSCRIPT_SOURCE_URL],
      { stdio: "inherit" },
    );
  }
  const actual = sha256(target);
  if (actual !== pins.GHOSTSCRIPT_SOURCE_SHA256) {
    throw new Error(
      `prepare-signed-release-assets: Ghostscript source SHA256 ${actual} does not match pinned ${pins.GHOSTSCRIPT_SOURCE_SHA256}.`,
    );
  }
  return assetName;
}

function writeSha256Sums(outDir, assetNames) {
  const lines = [...assetNames]
    .sort((a, b) => a.localeCompare(b))
    .map((assetName) => `${sha256(path.join(outDir, assetName))}  ${assetName}`);
  writeFileSync(path.join(outDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

function uploadAssets(tag, outDir, assetNames) {
  execFileSync("gh", ["release", "upload", tag, ...assetNames.map((name) => path.join(outDir, name)), "--clobber"], {
    stdio: "inherit",
  });
}

export function prepareSignedReleaseAssets({
  tag,
  nsisDir = DEFAULT_NSIS_DIR,
  outDir = DEFAULT_ASSET_DIR,
  payloadDir,
  pinsPath = DEFAULT_PINS_PATH,
  ghostscriptSource,
  skipAuthenticode = false,
  skipUpdaterSignature = false,
  skipLegalCheck = false,
  updaterPubkey,
}) {
  const releaseTag = resolveTag(tag);
  const version = versionFromTag(releaseTag);
  const pins = parsePins(pinsPath);
  const legalDir = findPayloadLegalDir(payloadDir);
  if (!skipLegalCheck) {
    runLegalPayloadCheck({ legalDir, releaseTag });
  }
  validateComponentManifest({ legalDir, version, pins });
  const { sourceExe, sourceSig } = findSignedInstaller(nsisDir, version);
  if (!skipAuthenticode) {
    verifyAuthenticodeSignature(path.join(nsisDir, sourceExe), {
      label: `signed NSIS installer ${sourceExe}`,
    });
  }
  if (!skipUpdaterSignature) {
    verifyTauriUpdaterSignature(path.join(nsisDir, sourceExe), path.join(nsisDir, sourceSig), {
      pubkey: updaterPubkey,
      label: `updater signature ${sourceSig}`,
    });
  }
  const canonicalExe = canonicalInstallerFilename(version);
  const canonicalSig = `${canonicalExe}.sig`;
  const assetNames = [canonicalExe, canonicalSig];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  copyFileSync(path.join(nsisDir, sourceExe), path.join(outDir, canonicalExe));
  copyFileSync(path.join(nsisDir, sourceSig), path.join(outDir, canonicalSig));
  assetNames.push(...stageLegalAssets({ legalDir, outDir, version }));
  assetNames.push(stageGhostscriptSource({ pins, sourceArchive: ghostscriptSource, outDir }));

  const signature = readFileSync(path.join(outDir, canonicalSig), "utf8").trim();
  const manifest = buildLatestJsonManifest({
    tag: releaseTag,
    exeFilename: canonicalExe,
    signature,
    pubDate: new Date(),
  });
  writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  assetNames.push("latest.json");
  writeSha256Sums(outDir, assetNames);
  assetNames.push("SHA256SUMS.txt");

  return { releaseTag, version, outDir, legalDir, assetNames };
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

    const result = prepareSignedReleaseAssets(args);
    console.log(`prepare-signed-release-assets: wrote ${result.outDir}`);
    for (const asset of result.assetNames) {
      console.log(`  ${asset}`);
    }
    if (args.upload) {
      uploadAssets(result.releaseTag, result.outDir, result.assetNames);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
