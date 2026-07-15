#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalInstallerFilename, isPrereleaseTag } from "./generate-latest-json.mjs";
import { verifyAuthenticodeSignature } from "./authenticode.mjs";
import { verifyTauriUpdaterSignature } from "./minisign.mjs";
import {
  canonicalArtifactNames,
  getPlatform,
  platformPath,
} from "../installer/platforms.mjs";
import {
  expectedPlatformReleaseAssets,
  validateInstallerSize,
  validatePackageBoundary,
  validatePayloadSize,
} from "./validate-package-boundary.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WINDOWS_PLATFORM = getPlatform("windows-x64");
const DEFAULT_ASSET_DIR = platformPath(REPO_ROOT, "windows-x64", "releaseStageDir");
const DEFAULT_PINS_PATH = path.resolve(REPO_ROOT, WINDOWS_PLATFORM.pinsFile);
const DEFAULT_PAYLOAD_DIR = platformPath(REPO_ROOT, "windows-x64", "payloadOutputDir");
const REPO = "Macrify-LLC/raiopdf";
const PLATFORM = "windows-x86_64";
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const args = {
    tag: undefined,
    dir: DEFAULT_ASSET_DIR,
    pinsPath: DEFAULT_PINS_PATH,
    github: false,
    prerelease: false,
    payloadDir: DEFAULT_PAYLOAD_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--tag") {
      args.tag = argv[++index];
    } else if (arg.startsWith("--tag=")) {
      args.tag = arg.slice("--tag=".length);
    } else if (arg === "--dir") {
      args.dir = argv[++index];
    } else if (arg.startsWith("--dir=")) {
      args.dir = arg.slice("--dir=".length);
    } else if (arg === "--pins") {
      args.pinsPath = argv[++index];
    } else if (arg.startsWith("--pins=")) {
      args.pinsPath = arg.slice("--pins=".length);
    } else if (arg === "--github") {
      args.github = true;
    } else if (arg === "--prerelease") {
      args.prerelease = true;
    } else if (arg === "--payload-dir") {
      args.payloadDir = argv[++index];
    } else if (arg.startsWith("--payload-dir=")) {
      args.payloadDir = arg.slice("--payload-dir=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`validate-release-assets: unknown argument ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/validate-release-assets.mjs --tag vX.Y.Z [--dir release-assets/signed/windows-x64] [--payload-dir PATH] [--pins PATH] [--github] [--prerelease]

Validates the canonical public release asset set locally. With --github, also
rejects draft GitHub Releases, checks the release asset names via gh, downloads
the full public asset set, and validates those downloaded files the same way as
the local staging dir. Stable releases also confirm GitHub's latest-release
endpoint resolves to this tag. Prerelease tags, or --prerelease, require the
GitHub Release to be marked prerelease and skip the stable latest-release check.

Requires RAIOPDF_SIGN_EXPECTED_THUMBPRINT, RAIOPDF_SIGN_THUMBPRINT, or exact
RAIOPDF_SIGN_EXPECTED_SUBJECT unless called from tests with the programmatic
skipAuthenticode option. Also verifies the Tauri updater .sig against the
installer bytes and configured updater pubkey.`);
}

function versionFromTag(tag) {
  if (!tag || typeof tag !== "string") {
    throw new Error("validate-release-assets: --tag vX.Y.Z is required.");
  }
  const version = tag.trim().replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`validate-release-assets: tag must resolve to semver (got ${tag}).`);
  }
  return version;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parsePins(pinsPath) {
  if (!existsSync(pinsPath)) {
    throw new Error(`validate-release-assets: pins file not found: ${pinsPath}`);
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
  if (!pins.GHOSTSCRIPT_VERSION || !pins.GHOSTSCRIPT_SOURCE_URL || !pins.GHOSTSCRIPT_SOURCE_SHA256) {
    throw new Error(
      "validate-release-assets: the selected platform pins file must pin Ghostscript source version, URL, and SHA256.",
    );
  }
  return pins;
}

function listLocalAssets(dir) {
  if (!existsSync(dir)) {
    throw new Error(`validate-release-assets: asset directory does not exist: ${dir}`);
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function expectedAssets(version, pins) {
  const installer = canonicalInstallerFilename(version);
  return [
    installer,
    `${installer}.sig`,
    `RaioPDF-${version}-third-party-notices.txt`,
    `RaioPDF-${version}-component-manifest.json`,
    `RaioPDF-${version}-source-correspondence.md`,
    `RaioPDF-${version}-license-notices.txt`,
    `RaioPDF-${version}-ghostscript-source-offer.txt`,
    `ghostscript-${pins.GHOSTSCRIPT_VERSION}-source.tar.xz`,
    "latest.json",
    "SHA256SUMS.txt",
  ].sort((a, b) => a.localeCompare(b));
}

export function validatePublicAssetNames(names, version, pins, { allowMac = false } = {}) {
  const installer = canonicalInstallerFilename(version);
  const expectedWindows = expectedAssets(version, pins);
  const actual = [...names].sort((a, b) => a.localeCompare(b));
  const macSourcePattern = /^ghostscript-([0-9]+\.[0-9]+\.[0-9]+)-macos-arm64-source\.tar\.xz$/u;
  const macSourceVersions = actual
    .map((name) => macSourcePattern.exec(name)?.[1])
    .filter(Boolean);
  const macGhostscriptVersion = macSourceVersions.length === 1
    ? macSourceVersions[0]
    : pins.GHOSTSCRIPT_VERSION;
  const expectedMac = expectedPlatformReleaseAssets({
    platformId: "macos-arm64",
    version,
    ghostscriptVersion: macGhostscriptVersion,
  });
  const expectedCombined = [...new Set([...expectedWindows, ...expectedMac])]
    .sort((a, b) => a.localeCompare(b));

  const unsigned = actual.filter((name) => /unsigned/i.test(name));
  if (unsigned.length > 0) {
    throw new Error(`validate-release-assets: unsigned public assets are forbidden: ${unsigned.join(", ")}`);
  }

  const exeFiles = actual.filter((name) => name.toLowerCase().endsWith(".exe"));
  if (exeFiles.length !== 1 || exeFiles[0] !== installer) {
    throw new Error(
      `validate-release-assets: expected exactly ${installer}; found ${exeFiles.join(", ") || "(none)"}`,
    );
  }

  const matches = (expected) =>
    expected.length === actual.length && expected.every((name, index) => name === actual[index]);
  const windowsOnly = matches(expectedWindows);
  if (windowsOnly || (allowMac && macSourceVersions.length === 1 && matches(expectedCombined))) {
    return windowsOnly
      ? { includesMac: false }
      : { includesMac: true, macGhostscriptVersion };
  }

  const target = allowMac && actual.some((name) => name.includes("macos-arm64"))
    ? expectedCombined
    : expectedWindows;
  const missing = target.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(`validate-release-assets: missing required assets: ${missing.join(", ")}`);
  }
  const unexpected = actual.filter((name) => !target.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`validate-release-assets: unexpected public assets: ${unexpected.join(", ")}`);
  }
  throw new Error("validate-release-assets: public asset set is incomplete.");
}

function validateLatestJson(dir, tag, version, { expectMac = false } = {}) {
  const installer = canonicalInstallerFilename(version);
  const manifest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(`validate-release-assets: latest.json version ${manifest.version} does not match ${version}`);
  }
  const platform = manifest.platforms?.[PLATFORM];
  if (!platform?.signature || !platform?.url) {
    throw new Error(`validate-release-assets: latest.json missing platforms.${PLATFORM}.signature/url`);
  }
  const url = new URL(platform.url);
  const expectedPath = `/Macrify-LLC/raiopdf/releases/download/${tag}/${installer}`;
  if (url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new Error(`validate-release-assets: latest.json URL is not canonical: ${platform.url}`);
  }
  const signature = readFileSync(path.join(dir, `${installer}.sig`), "utf8").trim();
  if (platform.signature !== signature) {
    throw new Error("validate-release-assets: latest.json signature does not match installer .sig file.");
  }
  const expectedPlatforms = expectMac
    ? ["darwin-aarch64", "windows-x86_64"]
    : ["windows-x86_64"];
  const actualPlatforms = Object.keys(manifest.platforms ?? {}).sort((a, b) => a.localeCompare(b));
  if (
    actualPlatforms.length !== expectedPlatforms.length ||
    expectedPlatforms.some((name, index) => name !== actualPlatforms[index])
  ) {
    throw new Error(
      `validate-release-assets: latest.json platform set is ${actualPlatforms.join(", ") || "empty"}.`,
    );
  }
}

function validateUpdaterSignature(dir, version, updaterPubkey) {
  const installer = canonicalInstallerFilename(version);
  verifyTauriUpdaterSignature(path.join(dir, installer), path.join(dir, `${installer}.sig`), {
    pubkey: updaterPubkey,
    label: `updater signature for ${installer}`,
  });
}

function validateChecksums(dir, version, pins) {
  const installer = canonicalInstallerFilename(version);
  const expected = expectedAssets(version, pins).filter((name) => name !== "SHA256SUMS.txt");
  const checksumLines = readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const byName = new Map();
  for (const line of checksumLines) {
    const [hash, filename] = line.trim().split(/\s+/, 2);
    if (!hash || !filename) {
      throw new Error(`validate-release-assets: malformed checksum line: ${line}`);
    }
    byName.set(filename, hash);
  }
  for (const filename of expected) {
    const hash = byName.get(filename);
    if (!hash) {
      throw new Error(`validate-release-assets: SHA256SUMS.txt is missing ${filename}`);
    }
    const actual = sha256(path.join(dir, filename));
    if (hash !== actual) {
      throw new Error(`validate-release-assets: SHA256SUMS.txt hash does not match ${filename}.`);
    }
  }
  for (const filename of byName.keys()) {
    if (!expected.includes(filename)) {
      throw new Error(`validate-release-assets: SHA256SUMS.txt includes unexpected file ${filename}`);
    }
  }
  const ghostscriptSource = `ghostscript-${pins.GHOSTSCRIPT_VERSION}-source.tar.xz`;
  if (byName.get(ghostscriptSource) !== pins.GHOSTSCRIPT_SOURCE_SHA256) {
    throw new Error("validate-release-assets: Ghostscript source checksum does not match the selected platform pins file.");
  }
  if (!byName.has(installer)) {
    throw new Error(`validate-release-assets: SHA256SUMS.txt is missing ${installer}`);
  }
}

function validateMacChecksums(dir, version, pins, ghostscriptVersion) {
  const expected = expectedPlatformReleaseAssets({
    platformId: "macos-arm64",
    version,
    ghostscriptVersion,
  });
  const checksumName = "SHA256SUMS-macos-arm64.txt";
  const entries = new Map();
  for (const line of readFileSync(path.join(dir, checksumName), "utf8").trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error(`validate-release-assets: malformed Mac checksum line: ${line}`);
    }
    entries.set(match[2], match[1]);
  }
  for (const filename of expected.filter((name) => name !== checksumName)) {
    if (entries.get(filename) !== sha256(path.join(dir, filename))) {
      throw new Error(`validate-release-assets: Mac checksum is missing or stale for ${filename}.`);
    }
  }
  const extras = [...entries.keys()].filter((name) => !expected.includes(name));
  if (extras.length > 0) {
    throw new Error(`validate-release-assets: Mac checksum contains unexpected files: ${extras.join(", ")}`);
  }
  const source = `ghostscript-${ghostscriptVersion}-macos-arm64-source.tar.xz`;
  const manifest = JSON.parse(
    readFileSync(
      path.join(dir, `RaioPDF-${version}-macos-arm64-component-manifest.json`),
      "utf8",
    ),
  );
  const ghostscript = manifest.components?.find((entry) => entry.name === "Ghostscript");
  if (
    ghostscript?.version !== ghostscriptVersion ||
    ghostscript?.source?.sha256 !== entries.get(source) ||
    typeof ghostscript?.source?.url !== "string" ||
    ghostscript.source.url.trim() === ""
  ) {
    throw new Error("validate-release-assets: Mac Ghostscript source does not match its component manifest.");
  }
  if (
    ghostscriptVersion === pins.GHOSTSCRIPT_VERSION &&
    entries.get(source) !== pins.GHOSTSCRIPT_SOURCE_SHA256
  ) {
    throw new Error("validate-release-assets: shared-version Mac Ghostscript source does not match the Windows pins.");
  }
}

function validateMacUpdater(dir, tag, version, updaterPubkey) {
  const names = canonicalArtifactNames("macos-arm64", version);
  const manifest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  const platform = manifest.platforms?.["darwin-aarch64"];
  const signature = readFileSync(path.join(dir, `${names.updater}.sig`), "utf8").trim();
  const expectedUrl = `https://github.com/Macrify-LLC/raiopdf/releases/download/${tag}/${names.updater}`;
  if (platform?.signature !== signature || platform?.url !== expectedUrl) {
    throw new Error("validate-release-assets: latest.json Mac updater entry is missing or noncanonical.");
  }
  verifyTauriUpdaterSignature(
    path.join(dir, names.updater),
    path.join(dir, `${names.updater}.sig`),
    { pubkey: updaterPubkey, label: `updater signature for ${names.updater}` },
  );
}

function validateComponentManifest(dir, version, pins) {
  const manifest = JSON.parse(
    readFileSync(path.join(dir, `RaioPDF-${version}-component-manifest.json`), "utf8"),
  );
  if (manifest.product !== "RaioPDF") {
    throw new Error(`validate-release-assets: component manifest product is ${manifest.product}.`);
  }
  if (manifest.releaseVersion !== version) {
    throw new Error(
      `validate-release-assets: component manifest releaseVersion ${manifest.releaseVersion} does not match ${version}.`,
    );
  }
  const raio = manifest.components?.find((entry) => entry.name === "RaioPDF");
  if (raio?.version !== version) {
    throw new Error("validate-release-assets: component manifest RaioPDF version is stale.");
  }
  const ghostscript = manifest.components?.find((entry) => entry.name === "Ghostscript");
  if (!ghostscript) {
    throw new Error("validate-release-assets: component manifest is missing Ghostscript.");
  }
  if (ghostscript.version !== pins.GHOSTSCRIPT_VERSION) {
    throw new Error("validate-release-assets: component manifest Ghostscript version is stale.");
  }
  if (ghostscript.license !== "AGPL-3.0-only") {
    throw new Error("validate-release-assets: component manifest Ghostscript license is not AGPL-3.0-only.");
  }
  if (ghostscript.source?.url !== pins.GHOSTSCRIPT_SOURCE_URL) {
    throw new Error("validate-release-assets: component manifest Ghostscript source URL is stale.");
  }
  if (ghostscript.source?.sha256 !== pins.GHOSTSCRIPT_SOURCE_SHA256) {
    throw new Error("validate-release-assets: component manifest Ghostscript source SHA256 is stale.");
  }
}

function githubReleaseMetadata(tag) {
  const raw = execFileSync(
    "gh",
    ["release", "view", tag, "--repo", REPO, "--json", "assets,isDraft,isPrerelease,tagName,url"],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

function githubLatestReleaseMetadata() {
  const raw = execFileSync(
    "gh",
    ["release", "view", "--repo", REPO, "--json", "isDraft,isPrerelease,tagName,url"],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

export function validateGitHubReleaseState(release, { expectedPrerelease = false } = {}) {
  if (!release || typeof release !== "object") {
    throw new Error("validate-release-assets: GitHub release metadata was not an object.");
  }
  const tagName = typeof release.tagName === "string" && release.tagName.trim() ? release.tagName : "(unknown tag)";
  if (release.isDraft) {
    throw new Error(
      `validate-release-assets: ${tagName} is still a draft. Publish it before validating updater availability with --github.`,
    );
  }
  if (expectedPrerelease) {
    if (!release.isPrerelease) {
      throw new Error(
        `validate-release-assets: ${tagName} must be marked as a GitHub prerelease for preview validation.`,
      );
    }
    return;
  }
  if (release.isPrerelease) {
    throw new Error(
      `validate-release-assets: ${tagName} is marked as a GitHub prerelease. ` +
        "RaioPDF's updater uses /releases/latest/download/latest.json, which only works when this is the latest normal GitHub Release.",
    );
  }
}

export function validateGitHubLatestRelease(tag, latest) {
  if (!latest || typeof latest !== "object") {
    throw new Error("validate-release-assets: GitHub latest release metadata was not an object.");
  }
  validateGitHubReleaseState(latest);
  if (latest.tagName !== tag) {
    throw new Error(
      `validate-release-assets: /releases/latest resolves to ${latest.tagName || "(unknown tag)"}, not ${tag}. ` +
        "Publish this tag as the latest normal GitHub Release before shipping the updater manifest.",
    );
  }
}

function githubAssetNames(release) {
  return (release.assets ?? []).map((asset) => asset.name).sort((a, b) => a.localeCompare(b));
}

function downloadGitHubAssets(tag) {
  const downloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-release-verify-"));
  try {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        tag,
        "--repo",
        REPO,
        "--dir",
        downloadDir,
        "--clobber",
      ],
      { stdio: "inherit" },
    );
    return downloadDir;
  } catch (error) {
    rmSync(downloadDir, { recursive: true, force: true });
    throw error;
  }
}

export function validateReleaseAssets({
  tag,
  dir = DEFAULT_ASSET_DIR,
  pinsPath = DEFAULT_PINS_PATH,
  github = false,
  skipAuthenticode = false,
  skipUpdaterSignature = false,
  updaterPubkey,
  prerelease = false,
  payloadDir = DEFAULT_PAYLOAD_DIR,
  skipPayloadSize = false,
}) {
  const version = versionFromTag(tag);
  const expectedPrerelease = prerelease || isPrereleaseTag(tag);
  const pins = parsePins(pinsPath);
  const localNames = listLocalAssets(dir);
  validatePackageBoundary({ rootDir: dir, platformId: "windows-x64" });
  validatePublicAssetNames(localNames, version, pins);
  validateLatestJson(dir, tag, version);
  validateChecksums(dir, version, pins);
  validateComponentManifest(dir, version, pins);
  validateInstallerSize({
    installerPath: path.join(dir, canonicalInstallerFilename(version)),
    platformId: "windows-x64",
  });
  if (!skipPayloadSize) {
    validatePayloadSize({ payloadRoot: payloadDir, platformId: "windows-x64" });
  }
  if (!skipUpdaterSignature) {
    validateUpdaterSignature(dir, version, updaterPubkey);
  }

  if (!skipAuthenticode) {
    verifyAuthenticodeSignature(path.join(dir, canonicalInstallerFilename(version)), {
      label: "local release installer",
    });
  }

  if (github) {
    const release = githubReleaseMetadata(tag);
    validateGitHubReleaseState(release, { expectedPrerelease });
    if (expectedPrerelease) {
      console.log(
        `validate-release-assets: ${tag} is a prerelease; skipping /releases/latest assertion so the stable auto-update target remains unchanged.`,
      );
    } else {
      validateGitHubLatestRelease(tag, githubLatestReleaseMetadata());
    }
    const publicSet = validatePublicAssetNames(githubAssetNames(release), version, pins, {
      allowMac: true,
    });
    const downloadDir = downloadGitHubAssets(tag);
    try {
      if (!publicSet.includesMac) {
        validatePackageBoundary({ rootDir: downloadDir, platformId: "windows-x64" });
      }
      validatePublicAssetNames(listLocalAssets(downloadDir), version, pins, { allowMac: true });
      validateLatestJson(downloadDir, tag, version, { expectMac: publicSet.includesMac });
      validateChecksums(downloadDir, version, pins);
      validateComponentManifest(downloadDir, version, pins);
      if (publicSet.includesMac) {
        validateMacChecksums(
          downloadDir,
          version,
          pins,
          publicSet.macGhostscriptVersion,
        );
        if (!skipUpdaterSignature) {
          validateMacUpdater(downloadDir, tag, version, updaterPubkey);
        }
      }
      validateInstallerSize({
        installerPath: path.join(downloadDir, canonicalInstallerFilename(version)),
        platformId: "windows-x64",
      });
      if (!skipUpdaterSignature) {
        validateUpdaterSignature(downloadDir, version, updaterPubkey);
      }
      if (!skipAuthenticode) {
        verifyAuthenticodeSignature(path.join(downloadDir, canonicalInstallerFilename(version)), {
          label: "published GitHub release installer",
        });
      }
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  }

  return { version, localNames };
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
    const result = validateReleaseAssets(args);
    console.log(`validate-release-assets: ok for ${args.tag} (${result.version})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
