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
  findStagedUpdaterArtifacts,
  validateLatestJsonManifest,
} from "./generate-latest-json.mjs";
import { verifyAuthenticodeSignature } from "./authenticode.mjs";
import { verifyTauriUpdaterSignature } from "./minisign.mjs";
import {
  PLATFORM_IDS,
  canonicalArtifactNames,
  getPlatform,
  platformPath,
} from "../installer/platforms.mjs";
import { expectedPlatformReleaseAssets } from "./validate-package-boundary.mjs";

const SEMVER_PATTERN = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?";
const SEMVER = new RegExp(`^${SEMVER_PATTERN}$`);
const DEFAULT_NSIS_SEARCH_DIRS = [
  fileURLToPath(new URL("../target/release/bundle/nsis/", import.meta.url)),
  fileURLToPath(new URL("../apps/shell/src-tauri/target/release/bundle/nsis/", import.meta.url)),
];
const DEFAULT_DMG_SEARCH_DIRS = [
  fileURLToPath(new URL("../target/release/bundle/dmg/", import.meta.url)),
  fileURLToPath(new URL("../apps/shell/src-tauri/target/release/bundle/dmg/", import.meta.url)),
];
const DEFAULT_MAC_UPDATER_SEARCH_DIRS = [
  fileURLToPath(new URL("../target/release/bundle/macos/", import.meta.url)),
  fileURLToPath(new URL("../apps/shell/src-tauri/target/release/bundle/macos/", import.meta.url)),
];
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WINDOWS_PLATFORM = getPlatform("windows-x64");
const DEFAULT_ASSET_DIR = platformPath(REPO_ROOT, "windows-x64", "releaseStageDir");
const DEFAULT_PINS_PATH = path.resolve(REPO_ROOT, WINDOWS_PLATFORM.pinsFile);
const DEFAULT_STAGE_ROOT = path.resolve(REPO_ROOT, "release-assets", "signed");
const DEFAULT_BUILT_PAYLOAD_SEARCH_ROOTS = [
  fileURLToPath(new URL("../target/release/", import.meta.url)),
  fileURLToPath(new URL("../apps/shell/src-tauri/target/release/", import.meta.url)),
];
const DEFAULT_SOURCE_PAYLOAD_SEARCH_ROOTS = [
  platformPath(REPO_ROOT, "windows-x64", "payloadOutputDir"),
];
const DEFAULT_MAC_SOURCE_PAYLOAD_SEARCH_ROOTS = [
  platformPath(REPO_ROOT, "macos-arm64", "payloadOutputDir"),
];
const REQUIRED_LEGAL_FILES = [
  ["THIRD-PARTY-NOTICES.txt", "third-party-notices.txt"],
  ["COMPONENT-MANIFEST.json", "component-manifest.json"],
  ["RELEASE-SOURCE-CORRESPONDENCE.md", "source-correspondence.md"],
  ["RAIOPDF-LICENSE-NOTICES.txt", "license-notices.txt"],
  [path.join("source-offers", "GHOSTSCRIPT-SOURCE-OFFER.txt"), "ghostscript-source-offer.txt"],
];

/** Platform-qualified compliance asset name (matches expectedPlatformReleaseAssets). */
function complianceQualifier(platformId) {
  return platformId === "macos-arm64" ? "-macos-arm64" : "";
}

function ghostscriptSourceAssetName(platformId, ghostscriptVersion) {
  return platformId === "macos-arm64"
    ? `ghostscript-${ghostscriptVersion}-macos-arm64-source.tar.xz`
    : `ghostscript-${ghostscriptVersion}-source.tar.xz`;
}

function checksumFilename(platformId) {
  return platformId === "macos-arm64" ? "SHA256SUMS-macos-arm64.txt" : "SHA256SUMS.txt";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireValue(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`prepare-signed-release-assets: ${name} is required.`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const args = {
    tag: undefined,
    platform: "windows-x64",
    nsisDir: undefined,
    dmg: undefined,
    updater: undefined,
    updaterSig: undefined,
    outDir: undefined,
    payloadDir: undefined,
    pinsPath: undefined,
    ghostscriptSource: undefined,
    upload: false,
    platformStageOnly: false,
    combine: false,
    stageRoot: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--tag") {
      args.tag = argv[++index];
    } else if (arg.startsWith("--tag=")) {
      args.tag = arg.slice("--tag=".length);
    } else if (arg === "--platform") {
      args.platform = argv[++index];
    } else if (arg.startsWith("--platform=")) {
      args.platform = arg.slice("--platform=".length);
    } else if (arg === "--nsis-dir") {
      args.nsisDir = argv[++index];
    } else if (arg.startsWith("--nsis-dir=")) {
      args.nsisDir = arg.slice("--nsis-dir=".length);
    } else if (arg === "--dmg") {
      args.dmg = argv[++index];
    } else if (arg.startsWith("--dmg=")) {
      args.dmg = arg.slice("--dmg=".length);
    } else if (arg === "--updater") {
      args.updater = argv[++index];
    } else if (arg.startsWith("--updater=")) {
      args.updater = arg.slice("--updater=".length);
    } else if (arg === "--updater-sig") {
      args.updaterSig = argv[++index];
    } else if (arg.startsWith("--updater-sig=")) {
      args.updaterSig = arg.slice("--updater-sig=".length);
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
    } else if (arg === "--platform-stage-only") {
      args.platformStageOnly = true;
    } else if (arg === "--combine") {
      args.combine = true;
    } else if (arg === "--stage-root") {
      args.stageRoot = argv[++index];
    } else if (arg.startsWith("--stage-root=")) {
      args.stageRoot = arg.slice("--stage-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`prepare-signed-release-assets: unknown argument ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log(`Usage:
  Windows staging (default, unchanged):
    node scripts/prepare-signed-release-assets.mjs --tag vX.Y.Z [--upload]
         [--platform windows-x64] [--nsis-dir PATH] [--payload-dir PATH]
         [--out-dir PATH] [--ghostscript-source PATH] [--pins PATH]
         [--platform-stage-only]

  macOS staging (run on the Mac that built and signed the DMG):
    node scripts/prepare-signed-release-assets.mjs --tag vX.Y.Z --platform macos-arm64
         [--dmg PATH] [--updater PATH] [--updater-sig PATH] [--payload-dir PATH]
         [--out-dir PATH] [--ghostscript-source PATH] [--pins PATH] [--upload]

  Combine (run wherever BOTH platform stages are present):
    node scripts/prepare-signed-release-assets.mjs --tag vX.Y.Z --combine
         [--stage-root release-assets/signed] [--upload]

Windows: copies the locally signed NSIS installer and updater signature into
canonical public release asset names, stages release legal/source-correspondence
assets, writes latest.json, and writes SHA256SUMS.txt.
--platform-stage-only omits latest.json from the Windows stage and its checksum
so one shared cross-platform manifest can be generated at the stage root.

macOS: copies the signed + notarized/stapled DMG and the updater .app.tar.gz +
.sig into canonical names under release-assets/signed/macos-arm64, stages the
macOS compliance assets and Ghostscript source tarball from the macOS pins, and
writes SHA256SUMS-macos-arm64.txt. The macOS stage never contains latest.json;
the shared manifest is produced by --combine. The DMG is verified with
"codesign --verify --strict" and "xcrun stapler validate" (macOS host required).

--combine: requires both platform stage directories under the stage root to be
complete for the tag's version, then writes the single cross-platform
latest.json (windows-x86_64 + darwin-aarch64) and the top-level SHA256SUMS.txt
at the stage root, and prints the exact upload set. The Windows stage must have
been produced with --platform-stage-only (no per-platform latest.json).

Default NSIS search: target/release/bundle/nsis, apps/shell/src-tauri/target/release/bundle/nsis
Default DMG search: target/release/bundle/dmg, apps/shell/src-tauri/target/release/bundle/dmg
Default macOS updater search: target/release/bundle/macos, apps/shell/src-tauri/target/release/bundle/macos
Default payload search: target/release, apps/shell/src-tauri/target/release; source payload fallback
Default output: release-assets/signed/<platform>

Windows staging requires RAIOPDF_SIGN_EXPECTED_THUMBPRINT, RAIOPDF_SIGN_THUMBPRINT,
or exact RAIOPDF_SIGN_EXPECTED_SUBJECT so the staged installer must have a valid
timestamped Authenticode signature from the expected signer. Both platforms verify
the Tauri updater .sig against the updater bytes and configured updater pubkey.`);
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

function findSignedInstallerFromDefaults(searchDirs, version) {
  const errors = [];
  for (const candidate of searchDirs) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      return { nsisDir: candidate, ...findSignedInstaller(candidate, version) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const searched = searchDirs.join(", ");
  throw new Error(
    `prepare-signed-release-assets: no signed NSIS installer for ${version} found in default search dirs: ${searched}` +
      (errors.length ? `; errors: ${errors.join(" | ")}` : ""),
  );
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

function findPayloadLegalDir(payloadDir, {
  builtSearchRoots = DEFAULT_BUILT_PAYLOAD_SEARCH_ROOTS,
  sourceSearchRoots = DEFAULT_SOURCE_PAYLOAD_SEARCH_ROOTS,
} = {}) {
  const explicit = payloadDir ? path.resolve(payloadDir) : null;
  if (explicit) {
    const candidates = [explicit.endsWith(`${path.sep}legal`) ? explicit : path.join(explicit, "legal")];
    return selectSingleLegalDir(candidates, "explicit payload legal directory");
  }

  const built = selectSingleLegalDir(
    builtSearchRoots.flatMap((root) => collectPayloadLegalDirs(root)),
    "built payload legal directory",
    { allowNone: true },
  );
  if (built) {
    return built;
  }

  return selectSingleLegalDir(
    sourceSearchRoots.flatMap((root) => collectPayloadLegalDirs(root)),
    "source payload legal directory",
  );
}

function selectSingleLegalDir(candidates, label, { allowNone = false } = {}) {
  const existing = candidates
    .filter((candidate, index, list) => list.indexOf(candidate) === index)
    .filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
    .sort((a, b) => a.localeCompare(b));

  if (allowNone && existing.length === 0) {
    return null;
  }
  if (existing.length !== 1) {
    throw new Error(
      `prepare-signed-release-assets: expected exactly one ${label}, found ${existing.length}: ${existing.join(
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
  if (existsSync(path.join(root, "legal"))) {
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

function stageLegalAssets({ legalDir, outDir, version, platformId = "windows-x64" }) {
  const qualifier = complianceQualifier(platformId);
  const staged = [];
  for (const [relativePath, assetSuffix] of REQUIRED_LEGAL_FILES) {
    const source = path.join(legalDir, relativePath);
    if (!existsSync(source) || statSync(source).size === 0) {
      throw new Error(`prepare-signed-release-assets: missing legal payload file ${source}`);
    }
    const assetName = `RaioPDF-${version}${qualifier}-${assetSuffix}`;
    copyFileSync(source, path.join(outDir, assetName));
    staged.push(assetName);
  }
  return staged;
}

function runLegalPayloadCheck({ legalDir, releaseTag, platformId = "windows-x64", pinsPath }) {
  const checkArgs = [
    fileURLToPath(new URL("./generate-legal-notices.mjs", import.meta.url)),
    "--payload-dir",
    path.dirname(legalDir),
    "--check",
  ];
  if (platformId !== "windows-x64") {
    checkArgs.push("--platform", platformId);
    if (pinsPath) {
      checkArgs.push("--pins", pinsPath);
    }
  }
  execFileSync(
    process.execPath,
    checkArgs,
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

function stageGhostscriptSource({ pins, sourceArchive, outDir, platformId = "windows-x64" }) {
  const assetName = ghostscriptSourceAssetName(platformId, pins.GHOSTSCRIPT_VERSION);
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

function writeSha256Sums(outDir, assetNames, filename = "SHA256SUMS.txt") {
  const lines = [...assetNames]
    .sort((a, b) => a.localeCompare(b))
    .map((assetName) => `${sha256(path.join(outDir, assetName))}  ${assetName}`);
  writeFileSync(path.join(outDir, filename), `${lines.join("\n")}\n`);
}

function uploadAssets(tag, outDir, assetNames) {
  execFileSync("gh", ["release", "upload", tag, ...assetNames.map((name) => path.join(outDir, name)), "--clobber"], {
    stdio: "inherit",
  });
}

function macDmgVersion(filename) {
  const canonical = new RegExp(
    `^RaioPDF-(${SEMVER_PATTERN})-macos-arm64\\.dmg$`,
  ).exec(filename);
  if (canonical) {
    return canonical[1];
  }
  const raw = new RegExp(`^RaioPDF_(${SEMVER_PATTERN})_aarch64\\.dmg$`).exec(filename);
  if (raw) {
    return raw[1];
  }
  throw new Error(
    `prepare-signed-release-assets: could not read a version from DMG filename ${filename}. ` +
      "Expected RaioPDF_<version>_aarch64.dmg (raw Tauri output) or RaioPDF-<version>-macos-arm64.dmg (canonical).",
  );
}

function findSignedDmgInDir(dmgDir, version) {
  if (!existsSync(dmgDir)) {
    throw new Error(`prepare-signed-release-assets: DMG directory not found: ${dmgDir}`);
  }
  const dmgFiles = readdirSync(dmgDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dmg"))
    .map((entry) => entry.name)
    .filter((name) => !/unsigned/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (dmgFiles.length !== 1) {
    throw new Error(
      `prepare-signed-release-assets: expected exactly one signed DMG in ${dmgDir}, found ${dmgFiles.length}: ${dmgFiles.join(
        ", ",
      )}`,
    );
  }
  const sourceDmg = dmgFiles[0];
  const sourceVersion = macDmgVersion(sourceDmg);
  if (sourceVersion !== version) {
    throw new Error(
      `prepare-signed-release-assets: DMG ${sourceDmg} is version ${sourceVersion}, not ${version}. ` +
        "The bundle directory holds a stale build — rebuild and sign the DMG for this tag.",
    );
  }
  return path.join(dmgDir, sourceDmg);
}

function findSignedDmg({ dmg, dmgSearchDirs, version }) {
  if (dmg) {
    const resolved = path.resolve(dmg);
    if (!existsSync(resolved)) {
      throw new Error(`prepare-signed-release-assets: --dmg does not exist: ${resolved}`);
    }
    const sourceVersion = macDmgVersion(path.basename(resolved));
    if (sourceVersion !== version) {
      throw new Error(
        `prepare-signed-release-assets: --dmg ${path.basename(resolved)} is version ${sourceVersion}, not ${version}.`,
      );
    }
    return resolved;
  }
  const errors = [];
  for (const candidate of dmgSearchDirs) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      return findSignedDmgInDir(candidate, version);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `prepare-signed-release-assets: no signed DMG for ${version} found in default search dirs: ${dmgSearchDirs.join(
      ", ",
    )}` + (errors.length ? `; errors: ${errors.join(" | ")}` : ""),
  );
}

function resolveMacUpdaterPair(updaterPath, updaterSigPath, version) {
  const resolved = path.resolve(updaterPath);
  if (!existsSync(resolved)) {
    throw new Error(`prepare-signed-release-assets: updater archive not found: ${resolved}`);
  }
  const basename = path.basename(resolved);
  if (!basename.endsWith(".app.tar.gz")) {
    throw new Error(
      `prepare-signed-release-assets: macOS updater must be a .app.tar.gz archive (got ${basename}).`,
    );
  }
  const canonical = new RegExp(
    `^RaioPDF-(${SEMVER_PATTERN})-macos-arm64\\.app\\.tar\\.gz$`,
  ).exec(basename);
  if (canonical && canonical[1] !== version) {
    throw new Error(
      `prepare-signed-release-assets: updater ${basename} is version ${canonical[1]}, not ${version}.`,
    );
  }
  const sig = updaterSigPath ? path.resolve(updaterSigPath) : `${resolved}.sig`;
  if (!existsSync(sig)) {
    throw new Error(
      `prepare-signed-release-assets: missing updater signature ${sig}. ` +
        "The signed macOS build must be produced with createUpdaterArtifacts and the Tauri updater key.",
    );
  }
  return { updaterPath: resolved, updaterSigPath: sig };
}

function findMacUpdater({ updater, updaterSig, updaterSearchDirs, version }) {
  if (updater) {
    return resolveMacUpdaterPair(updater, updaterSig, version);
  }
  if (updaterSig) {
    throw new Error(
      "prepare-signed-release-assets: --updater-sig requires --updater to be passed as well.",
    );
  }
  const errors = [];
  for (const candidate of updaterSearchDirs) {
    if (!existsSync(candidate)) {
      continue;
    }
    const archives = readdirSync(candidate, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".app.tar.gz"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (archives.length === 0) {
      continue;
    }
    if (archives.length > 1) {
      errors.push(
        `multiple .app.tar.gz candidates in ${candidate}: ${archives.join(", ")}`,
      );
      continue;
    }
    try {
      return resolveMacUpdaterPair(path.join(candidate, archives[0]), undefined, version);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `prepare-signed-release-assets: no updater .app.tar.gz found in default search dirs: ${updaterSearchDirs.join(
      ", ",
    )}` + (errors.length ? `; errors: ${errors.join(" | ")}` : ""),
  );
}

function verifyMacDmgSignature(dmgPath) {
  try {
    execFileSync("codesign", ["--verify", "--strict", dmgPath], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `prepare-signed-release-assets: codesign verification failed for ${dmgPath}: ${
        error instanceof Error ? error.message : String(error)
      }. The staged DMG must be signed; run this on the macOS build host.`,
      { cause: error },
    );
  }
  try {
    execFileSync("xcrun", ["stapler", "validate", dmgPath], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `prepare-signed-release-assets: notarization staple validation failed for ${dmgPath}: ${
        error instanceof Error ? error.message : String(error)
      }. The public DMG must be notarized and stapled before staging.`,
      { cause: error },
    );
  }
}

export function prepareSignedReleaseAssets(options = {}) {
  const { platform = "windows-x64" } = options;
  if (platform === "windows-x64") {
    return prepareWindowsSignedReleaseAssets(options);
  }
  if (platform === "macos-arm64") {
    return prepareMacosSignedReleaseAssets(options);
  }
  throw new Error(
    `prepare-signed-release-assets: unsupported --platform ${JSON.stringify(platform)}. Expected one of: ${PLATFORM_IDS.join(
      ", ",
    )}.`,
  );
}

function prepareWindowsSignedReleaseAssets({
  tag,
  nsisDir,
  nsisSearchDirs = DEFAULT_NSIS_SEARCH_DIRS,
  outDir = DEFAULT_ASSET_DIR,
  payloadDir,
  builtPayloadSearchRoots = DEFAULT_BUILT_PAYLOAD_SEARCH_ROOTS,
  sourcePayloadSearchRoots = DEFAULT_SOURCE_PAYLOAD_SEARCH_ROOTS,
  pinsPath = DEFAULT_PINS_PATH,
  ghostscriptSource,
  skipAuthenticode = false,
  skipUpdaterSignature = false,
  skipLegalCheck = false,
  updaterPubkey,
  platformStageOnly = false,
}) {
  const releaseTag = resolveTag(tag);
  const version = versionFromTag(releaseTag);
  const pins = parsePins(pinsPath);
  const legalDir = findPayloadLegalDir(payloadDir, {
    builtSearchRoots: builtPayloadSearchRoots,
    sourceSearchRoots: sourcePayloadSearchRoots,
  });
  if (!skipLegalCheck) {
    runLegalPayloadCheck({ legalDir, releaseTag });
  }
  validateComponentManifest({ legalDir, version, pins });
  const resolvedInstaller = nsisDir
    ? { nsisDir, ...findSignedInstaller(nsisDir, version) }
    : findSignedInstallerFromDefaults(nsisSearchDirs, version);
  const { sourceExe, sourceSig } = resolvedInstaller;
  const resolvedNsisDir = resolvedInstaller.nsisDir;
  if (!skipAuthenticode) {
    verifyAuthenticodeSignature(path.join(resolvedNsisDir, sourceExe), {
      label: `signed NSIS installer ${sourceExe}`,
    });
  }
  if (!skipUpdaterSignature) {
    verifyTauriUpdaterSignature(path.join(resolvedNsisDir, sourceExe), path.join(resolvedNsisDir, sourceSig), {
      pubkey: updaterPubkey,
      label: `updater signature ${sourceSig}`,
    });
  }
  const canonicalExe = canonicalInstallerFilename(version);
  const canonicalSig = `${canonicalExe}.sig`;
  const assetNames = [canonicalExe, canonicalSig];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  copyFileSync(path.join(resolvedNsisDir, sourceExe), path.join(outDir, canonicalExe));
  copyFileSync(path.join(resolvedNsisDir, sourceSig), path.join(outDir, canonicalSig));
  assetNames.push(...stageLegalAssets({ legalDir, outDir, version }));
  assetNames.push(stageGhostscriptSource({ pins, sourceArchive: ghostscriptSource, outDir }));

  if (!platformStageOnly) {
    const signature = readFileSync(path.join(outDir, canonicalSig), "utf8").trim();
    const manifest = buildLatestJsonManifest({
      tag: releaseTag,
      exeFilename: canonicalExe,
      signature,
      pubDate: new Date(),
    });
    writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    assetNames.push("latest.json");
  }
  writeSha256Sums(outDir, assetNames);
  assetNames.push("SHA256SUMS.txt");

  return { releaseTag, version, outDir, nsisDir: resolvedNsisDir, legalDir, assetNames };
}

function prepareMacosSignedReleaseAssets({
  tag,
  dmg,
  updater,
  updaterSig,
  dmgSearchDirs = DEFAULT_DMG_SEARCH_DIRS,
  updaterSearchDirs = DEFAULT_MAC_UPDATER_SEARCH_DIRS,
  outDir,
  payloadDir,
  builtPayloadSearchRoots = DEFAULT_BUILT_PAYLOAD_SEARCH_ROOTS,
  sourcePayloadSearchRoots = DEFAULT_MAC_SOURCE_PAYLOAD_SEARCH_ROOTS,
  pinsPath,
  ghostscriptSource,
  skipAuthenticode = false,
  skipUpdaterSignature = false,
  skipLegalCheck = false,
  updaterPubkey,
}) {
  const platformId = "macos-arm64";
  const releaseTag = resolveTag(tag);
  const version = versionFromTag(releaseTag);
  const resolvedOutDir = path.resolve(
    outDir ?? platformPath(REPO_ROOT, platformId, "releaseStageDir"),
  );
  const resolvedPinsPath = path.resolve(
    pinsPath ?? path.resolve(REPO_ROOT, getPlatform(platformId).pinsFile),
  );
  const pins = parsePins(resolvedPinsPath);
  const legalDir = findPayloadLegalDir(payloadDir, {
    builtSearchRoots: builtPayloadSearchRoots,
    sourceSearchRoots: sourcePayloadSearchRoots,
  });
  if (!skipLegalCheck) {
    runLegalPayloadCheck({ legalDir, releaseTag, platformId, pinsPath: resolvedPinsPath });
  }
  validateComponentManifest({ legalDir, version, pins });

  const dmgPath = findSignedDmg({ dmg, dmgSearchDirs, version });
  const { updaterPath, updaterSigPath } = findMacUpdater({
    updater,
    updaterSig,
    updaterSearchDirs,
    version,
  });
  if (!skipAuthenticode) {
    verifyMacDmgSignature(dmgPath);
  }
  if (!skipUpdaterSignature) {
    verifyTauriUpdaterSignature(updaterPath, updaterSigPath, {
      pubkey: updaterPubkey,
      label: `updater signature ${path.basename(updaterSigPath)}`,
    });
  }

  const names = canonicalArtifactNames(platformId, version);
  const canonicalSig = `${names.updater}.sig`;
  const assetNames = [names.installer, names.updater, canonicalSig];

  rmSync(resolvedOutDir, { recursive: true, force: true });
  mkdirSync(resolvedOutDir, { recursive: true });

  copyFileSync(dmgPath, path.join(resolvedOutDir, names.installer));
  copyFileSync(updaterPath, path.join(resolvedOutDir, names.updater));
  copyFileSync(updaterSigPath, path.join(resolvedOutDir, canonicalSig));
  assetNames.push(
    ...stageLegalAssets({ legalDir, outDir: resolvedOutDir, version, platformId }),
  );
  assetNames.push(
    stageGhostscriptSource({
      pins,
      sourceArchive: ghostscriptSource,
      outDir: resolvedOutDir,
      platformId,
    }),
  );

  // The macOS stage is always platform-scoped: the single cross-platform
  // latest.json is generated at the stage root by --combine, never here.
  const checksums = checksumFilename(platformId);
  writeSha256Sums(resolvedOutDir, assetNames, checksums);
  assetNames.push(checksums);

  return {
    releaseTag,
    version,
    outDir: resolvedOutDir,
    dmgPath,
    updaterPath,
    legalDir,
    assetNames,
  };
}

function parseChecksumFile(checksumPath) {
  const entries = new Map();
  for (const line of readFileSync(checksumPath, "utf8").trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error(
        `prepare-signed-release-assets: malformed or duplicate checksum line in ${checksumPath}: ${line}`,
      );
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function validateStageForCombine({ platformId, stageDir, version }) {
  const platform = getPlatform(platformId);
  if (!existsSync(stageDir)) {
    const stageHint = platformId === "windows-x64"
      ? `--platform ${platformId} --platform-stage-only`
      : `--platform ${platformId}`;
    throw new Error(
      `prepare-signed-release-assets: ${platformId} platform stage is missing: ${stageDir}. ` +
        `Stage it first with prepare-signed-release-assets --tag v${version} ${stageHint}.`,
    );
  }
  const names = readdirSync(stageDir, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `prepare-signed-release-assets: ${platformId} stage contains unexpected non-file ${entry.name}.`,
        );
      }
      return entry.name;
    })
    .sort((a, b) => a.localeCompare(b));

  // Version check first, so a stale stage reports as a version mismatch rather
  // than a wall of missing/unexpected asset names.
  const installerRe = new RegExp(
    `^RaioPDF-(${SEMVER_PATTERN})-${escapeRegExp(platform.artifact.installerSuffix)}$`,
  );
  const installers = names
    .map((name) => installerRe.exec(name))
    .filter(Boolean);
  if (installers.length !== 1) {
    throw new Error(
      `prepare-signed-release-assets: ${platformId} stage must contain exactly one canonical installer; found ${
        installers.map((match) => match[0]).join(", ") || "(none)"
      } in ${stageDir}.`,
    );
  }
  if (installers[0][1] !== version) {
    throw new Error(
      `prepare-signed-release-assets: ${platformId} stage holds version ${installers[0][1]}, but --tag resolves to ${version}. ` +
        "Both platform stages must be built from the same tag before --combine.",
    );
  }

  const ghostscriptRe = platformId === "macos-arm64"
    ? /^ghostscript-([0-9]+\.[0-9]+\.[0-9]+)-macos-arm64-source\.tar\.xz$/u
    : /^ghostscript-([0-9]+\.[0-9]+\.[0-9]+)-source\.tar\.xz$/u;
  const ghostscriptVersions = names
    .map((name) => ghostscriptRe.exec(name)?.[1])
    .filter(Boolean);
  if (ghostscriptVersions.length !== 1) {
    throw new Error(
      `prepare-signed-release-assets: ${platformId} stage must contain exactly one Ghostscript source tarball; found ${ghostscriptVersions.length} in ${stageDir}.`,
    );
  }
  const ghostscriptVersion = ghostscriptVersions[0];

  const expected = expectedPlatformReleaseAssets({ platformId, version, ghostscriptVersion });
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (platformId === "windows-x64" && unexpected.includes("latest.json")) {
    throw new Error(
      `prepare-signed-release-assets: the windows-x64 stage at ${stageDir} contains latest.json. ` +
        "Re-stage it with --platform-stage-only so --combine can write the single cross-platform manifest at the stage root.",
    );
  }
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `prepare-signed-release-assets: ${platformId} stage at ${stageDir} is incomplete; missing: ${
        missing.join(", ") || "(none)"
      }; unexpected: ${unexpected.join(", ") || "(none)"}.`,
    );
  }

  const checksums = checksumFilename(platformId);
  const entries = parseChecksumFile(path.join(stageDir, checksums));
  for (const name of expected.filter((assetName) => assetName !== checksums)) {
    if (entries.get(name) !== sha256(path.join(stageDir, name))) {
      throw new Error(
        `prepare-signed-release-assets: ${platformId} stage checksum is missing or stale for ${name}. ` +
          "The stage was modified after staging — re-run platform staging before --combine.",
      );
    }
  }
  const extras = [...entries.keys()].filter(
    (name) => name === checksums || !expected.includes(name),
  );
  if (extras.length > 0) {
    throw new Error(
      `prepare-signed-release-assets: ${platformId} stage checksum file contains unexpected entries: ${extras.join(", ")}.`,
    );
  }

  return { platformId, stageDir, names, ghostscriptVersion };
}

export function combineSignedReleaseAssets({
  tag,
  stageRoot = DEFAULT_STAGE_ROOT,
  pubDate = new Date(),
  skipUpdaterSignature = false,
  updaterPubkey,
} = {}) {
  const releaseTag = resolveTag(tag);
  const version = versionFromTag(releaseTag);
  const resolvedRoot = path.resolve(stageRoot);

  const stages = {};
  for (const platformId of PLATFORM_IDS) {
    const platform = getPlatform(platformId);
    const stageDir = path.join(resolvedRoot, path.basename(platform.paths.releaseStageDir));
    stages[platformId] = validateStageForCombine({ platformId, stageDir, version });
  }

  const platformArtifacts = findStagedUpdaterArtifacts(resolvedRoot, [...PLATFORM_IDS]);
  if (!skipUpdaterSignature) {
    for (const artifact of platformArtifacts) {
      const stageDir = stages[artifact.platformId].stageDir;
      verifyTauriUpdaterSignature(
        path.join(stageDir, artifact.filename),
        path.join(stageDir, `${artifact.filename}.sig`),
        {
          pubkey: updaterPubkey,
          label: `${artifact.platformId} staged updater signature`,
        },
      );
    }
  }

  const manifest = buildLatestJsonManifest({ tag: releaseTag, platformArtifacts, pubDate });
  const latestJsonPath = path.join(resolvedRoot, "latest.json");
  writeFileSync(latestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  validateLatestJsonManifest(JSON.parse(readFileSync(latestJsonPath, "utf8")), {
    tag: releaseTag,
    platformArtifacts,
  });

  // The top-level SHA256SUMS.txt is the release-wide checksum file consumed by
  // validate-release-assets: the full Windows asset set plus the shared
  // latest.json. The macOS assets are covered by the macOS stage's own
  // SHA256SUMS-macos-arm64.txt, which is uploaded as-is.
  const windowsStage = stages["windows-x64"];
  const rootChecksumTargets = [
    ...expectedPlatformReleaseAssets({
      platformId: "windows-x64",
      version,
      ghostscriptVersion: windowsStage.ghostscriptVersion,
    })
      .filter((name) => name !== "SHA256SUMS.txt")
      .map((name) => [name, path.join(windowsStage.stageDir, name)]),
    ["latest.json", latestJsonPath],
  ];
  const sha256SumsPath = path.join(resolvedRoot, "SHA256SUMS.txt");
  writeFileSync(
    sha256SumsPath,
    `${rootChecksumTargets
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, filePath]) => `${sha256(filePath)}  ${name}`)
      .join("\n")}\n`,
  );

  // The exact public upload set. The Windows stage's own SHA256SUMS.txt is a
  // platform-scoped file (it omits latest.json) and is superseded by the
  // stage-root SHA256SUMS.txt — it must NOT be uploaded.
  const uploadPlan = [
    ...windowsStage.names
      .filter((name) => name !== "SHA256SUMS.txt")
      .map((name) => path.join(windowsStage.stageDir, name)),
    ...stages["macos-arm64"].names.map((name) =>
      path.join(stages["macos-arm64"].stageDir, name),
    ),
    latestJsonPath,
    sha256SumsPath,
  ];

  return {
    releaseTag,
    version,
    stageRoot: resolvedRoot,
    latestJsonPath,
    sha256SumsPath,
    uploadPlan,
    ghostscriptVersions: {
      "windows-x64": windowsStage.ghostscriptVersion,
      "macos-arm64": stages["macos-arm64"].ghostscriptVersion,
    },
  };
}

function uploadFiles(tag, filePaths) {
  execFileSync("gh", ["release", "upload", tag, ...filePaths, "--clobber"], {
    stdio: "inherit",
  });
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

    if (args.combine) {
      const incompatible = [
        ["--nsis-dir", args.nsisDir],
        ["--dmg", args.dmg],
        ["--updater", args.updater],
        ["--updater-sig", args.updaterSig],
        ["--out-dir", args.outDir],
        ["--payload-dir", args.payloadDir],
        ["--pins", args.pinsPath],
        ["--ghostscript-source", args.ghostscriptSource],
        ["--platform-stage-only", args.platformStageOnly || undefined],
      ].filter(([, value]) => value !== undefined);
      if (incompatible.length > 0) {
        throw new Error(
          `prepare-signed-release-assets: --combine only accepts --tag, --stage-root, and --upload (got ${incompatible
            .map(([flag]) => flag)
            .join(", ")}).`,
        );
      }
      const combined = combineSignedReleaseAssets({
        tag: args.tag,
        stageRoot: args.stageRoot,
      });
      console.log(
        `prepare-signed-release-assets: wrote ${combined.latestJsonPath} and ${combined.sha256SumsPath}`,
      );
      console.log("prepare-signed-release-assets: public upload set for this release:");
      for (const filePath of combined.uploadPlan) {
        console.log(`  ${filePath}`);
      }
      if (args.upload) {
        uploadFiles(combined.releaseTag, combined.uploadPlan);
      }
    } else {
      if (args.stageRoot !== undefined) {
        throw new Error(
          "prepare-signed-release-assets: --stage-root is only meaningful with --combine.",
        );
      }
      const result = prepareSignedReleaseAssets(args);
      console.log(`prepare-signed-release-assets: wrote ${result.outDir}`);
      for (const asset of result.assetNames) {
        console.log(`  ${asset}`);
      }
      if (args.upload) {
        uploadAssets(result.releaseTag, result.outDir, result.assetNames);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
