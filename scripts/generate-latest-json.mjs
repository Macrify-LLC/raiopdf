#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PLATFORM_IDS,
  canonicalArtifactNames,
  getPlatform,
} from "../installer/platforms.mjs";

const REPO = "Macrify-LLC/raiopdf";
const DEFAULT_PLATFORM_ID = "windows-x64";
const LATEST_JSON = "latest.json";
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
const SEMVER_PRERELEASE = /^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/;
const CANONICAL_INSTALLER_RE =
  /^RaioPDF-([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)-windows-x64-setup\.exe$/;
const NSIS_DIR = fileURLToPath(
  new URL("../apps/shell/src-tauri/target/release/bundle/nsis/", import.meta.url),
);

function requireNonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`generate-latest-json: ${name} is required.`);
  }
}

function normalizeTag(tag) {
  requireNonEmptyString("tag", tag);
  const normalized = tag.trim();
  const version = normalized.replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(
      `generate-latest-json: tag must resolve to semver like v1.2.3 (got ${JSON.stringify(
        tag,
      )}).`,
    );
  }
  return { tag: normalized, version };
}

export function isSemverPrereleaseVersion(version) {
  requireNonEmptyString("version", version);
  if (!SEMVER.test(version)) {
    throw new Error(
      `generate-latest-json: version must be semver like 1.2.3 (got ${JSON.stringify(
        version,
      )}).`,
    );
  }
  return SEMVER_PRERELEASE.test(version);
}

export function isPrereleaseTag(tag) {
  return isSemverPrereleaseVersion(normalizeTag(tag).version);
}

export function canonicalInstallerFilename(version) {
  requireNonEmptyString("version", version);
  if (!SEMVER.test(version)) {
    throw new Error(
      `generate-latest-json: version must be semver like 1.2.3 (got ${JSON.stringify(
        version,
      )}).`,
    );
  }
  return canonicalArtifactNames(DEFAULT_PLATFORM_ID, version).installer;
}

export function canonicalUpdaterFilename(version, platformId = DEFAULT_PLATFORM_ID) {
  requireNonEmptyString("version", version);
  if (!SEMVER.test(version)) {
    throw new Error(
      `generate-latest-json: version must be semver like 1.2.3 (got ${JSON.stringify(
        version,
      )}).`,
    );
  }
  return canonicalArtifactNames(platformId, version).updater;
}

function normalizePubDate(pubDate) {
  if (pubDate instanceof Date) {
    if (Number.isNaN(pubDate.getTime())) {
      throw new Error("generate-latest-json: pubDate must be a valid Date.");
    }
    return pubDate.toISOString();
  }
  requireNonEmptyString("pubDate", pubDate);
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `generate-latest-json: pubDate must be an ISO-8601 date string (got ${JSON.stringify(
        pubDate,
      )}).`,
    );
  }
  return pubDate;
}

function extractInstallerVersion(exeFilename) {
  const match = CANONICAL_INSTALLER_RE.exec(exeFilename);
  if (!match) {
    throw new Error(
      `generate-latest-json: could not read a version from installer filename ${JSON.stringify(
        exeFilename,
      )}. Expected a filename like RaioPDF-1.2.3-windows-x64-setup.exe.`,
    );
  }
  return match[1];
}

/**
 * Version embedded in a source installer filename — the raw Tauri NSIS output
 * (`RaioPDF_1.2.3_x64-setup.exe`) or an already-renamed canonical asset. Same
 * extraction the wired release path (prepare-signed-release-assets) uses.
 */
export function sourceInstallerVersion(exeFilename) {
  requireNonEmptyString("exeFilename", exeFilename);
  // Canonical asset names first: the loose fallback's semver prerelease part
  // would greedily swallow the "-windows-x64" suffix.
  const canonical = CANONICAL_INSTALLER_RE.exec(exeFilename);
  if (canonical) {
    return canonical[1];
  }
  const match = /(?:^|[_-])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:[_-])/.exec(
    exeFilename,
  );
  if (!match) {
    throw new Error(
      `generate-latest-json: could not read a version from installer filename ${JSON.stringify(
        exeFilename,
      )}.`,
    );
  }
  return match[1];
}

/**
 * Refuse to build a manifest around a stale build output. The manifest's
 * signature is read from the .sig sitting next to whatever .exe is in the
 * NSIS dir — if that installer isn't the tag's version, uploading the result
 * publishes the PREVIOUS version's signature under the new tag's canonical
 * URL, and every client's auto-update fails signature verification until the
 * manifest is fixed. Same enforcement the wired release path
 * (prepare-signed-release-assets) applies.
 */
export function assertSourceInstallerMatchesTag(
  exeFilename,
  tagVersion,
  { allowVersionMismatch = false } = {},
) {
  const installerVersion = sourceInstallerVersion(exeFilename);
  if (installerVersion === tagVersion) {
    return;
  }
  if (allowVersionMismatch) {
    console.warn(
      `generate-latest-json: WARNING: source installer ${exeFilename} is version ${installerVersion}, ` +
        `not tag version ${tagVersion} — continuing because --allow-version-mismatch was passed. ` +
        "The manifest signature will belong to that installer's bytes; only use this if you know why.",
    );
    return;
  }
  throw new Error(
    `generate-latest-json: source installer ${exeFilename} is version ${installerVersion}, ` +
      `not tag version ${tagVersion}. The NSIS directory holds a stale build — publishing its ` +
      `signature under ${JSON.stringify(tagVersion)} would break auto-update signature ` +
      "verification for every client. Rebuild and sign the installer for this tag " +
      "(or pass --allow-version-mismatch if you are certain).",
  );
}

function normalizePlatformArtifacts({ resolved, exeFilename, signature, platformArtifacts }) {
  const artifacts = platformArtifacts ?? [
    { platformId: DEFAULT_PLATFORM_ID, filename: exeFilename, signature },
  ];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("generate-latest-json: at least one platform artifact is required.");
  }

  const normalized = [];
  const seenUpdaterPlatforms = new Set();
  for (const artifact of artifacts) {
    const platform = getPlatform(artifact?.platformId);
    requireNonEmptyString(`${platform.payloadId} updater filename`, artifact?.filename);
    requireNonEmptyString(`${platform.payloadId} signature`, artifact?.signature);
    if (/[\\/]/.test(artifact.filename)) {
      throw new Error(
        `generate-latest-json: ${platform.payloadId} updater filename must not be a path.`,
      );
    }
    const expectedFilename = canonicalUpdaterFilename(resolved.version, platform.payloadId);
    if (artifact.filename !== expectedFilename) {
      throw new Error(
        `generate-latest-json: ${platform.payloadId} updater asset must be ${expectedFilename} for ${resolved.tag} (got ${artifact.filename}).`,
      );
    }
    if (seenUpdaterPlatforms.has(platform.updaterPlatform)) {
      throw new Error(
        `generate-latest-json: duplicate updater platform ${platform.updaterPlatform}.`,
      );
    }
    seenUpdaterPlatforms.add(platform.updaterPlatform);
    normalized.push({
      platformId: platform.payloadId,
      updaterPlatform: platform.updaterPlatform,
      filename: artifact.filename,
      signature: artifact.signature,
    });
  }
  return normalized;
}

export function buildLatestJsonManifest({
  tag,
  exeFilename,
  signature,
  pubDate,
  platformArtifacts,
}) {
  const resolved = normalizeTag(tag);
  const artifacts = normalizePlatformArtifacts({
    resolved,
    exeFilename,
    signature,
    platformArtifacts,
  });

  const platforms = {};
  for (const artifact of artifacts) {
    platforms[artifact.updaterPlatform] = {
      signature: artifact.signature,
      url: `https://github.com/${REPO}/releases/download/${resolved.tag}/${artifact.filename}`,
    };
  }

  return {
    version: resolved.version,
    pub_date: normalizePubDate(pubDate),
    platforms,
  };
}

export function validateLatestJsonManifest(
  manifest,
  { tag, exeFilename, platformArtifacts },
) {
  const resolved = normalizeTag(tag);
  const artifacts = normalizePlatformArtifacts({
    resolved,
    exeFilename,
    signature: platformArtifacts ? undefined : "validation-placeholder",
    platformArtifacts: platformArtifacts?.map((artifact) => ({
      ...artifact,
      signature: artifact.signature ?? "validation-placeholder",
    })),
  });

  if (!manifest || typeof manifest !== "object") {
    throw new Error("generate-latest-json: latest.json must be a JSON object.");
  }
  if (manifest.version !== resolved.version) {
    throw new Error(
      `generate-latest-json: latest.json version ${JSON.stringify(
        manifest.version,
      )} does not match tag version ${JSON.stringify(resolved.version)}.`,
    );
  }
  requireNonEmptyString("latest.json pub_date", manifest.pub_date);

  const expectedKeys = artifacts.map((artifact) => artifact.updaterPlatform).sort();
  const actualKeys = Object.keys(manifest.platforms ?? {}).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `generate-latest-json: latest.json platform keys ${actualKeys.join(", ") || "(none)"} do not match expected ${expectedKeys.join(", ")}.`,
    );
  }

  for (const artifact of artifacts) {
    const platform = manifest.platforms?.[artifact.updaterPlatform];
    if (!platform || typeof platform !== "object") {
      throw new Error(
        `generate-latest-json: latest.json is missing platforms.${artifact.updaterPlatform}.`,
      );
    }
    requireNonEmptyString(
      `platforms.${artifact.updaterPlatform}.signature`,
      platform.signature,
    );
    if (artifact.signature !== "validation-placeholder" && platform.signature !== artifact.signature) {
      throw new Error(
        `generate-latest-json: platforms.${artifact.updaterPlatform}.signature does not match the staged updater .sig.`,
      );
    }
    requireNonEmptyString(`platforms.${artifact.updaterPlatform}.url`, platform.url);

    let url;
    try {
      url = new URL(platform.url);
    } catch {
      throw new Error(
        `generate-latest-json: platforms.${artifact.updaterPlatform}.url is not a valid URL: ${platform.url}`,
      );
    }
    const urlFilename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const expectedPath = `/Macrify-LLC/raiopdf/releases/download/${resolved.tag}/${artifact.filename}`;
    if (url.hostname !== "github.com" || url.pathname !== expectedPath || urlFilename !== artifact.filename) {
      throw new Error(
        `generate-latest-json: platforms.${artifact.updaterPlatform}.url is not the canonical URL for ${artifact.filename}.`,
      );
    }
  }
}

function parseArgs(argv) {
  const args = {
    tag: undefined,
    upload: false,
    allowVersionMismatch: false,
    stageRoot: undefined,
    platformIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      index += 1;
      if (!argv[index] || argv[index].startsWith("--")) {
        throw new Error("generate-latest-json: --tag requires a value like v1.2.3.");
      }
      args.tag = argv[index] ?? "";
    } else if (arg.startsWith("--tag=")) {
      args.tag = arg.slice("--tag=".length);
    } else if (arg === "--upload") {
      args.upload = true;
    } else if (arg === "--allow-version-mismatch") {
      args.allowVersionMismatch = true;
    } else if (arg === "--stage-root") {
      args.stageRoot = argv[++index];
    } else if (arg.startsWith("--stage-root=")) {
      args.stageRoot = arg.slice("--stage-root=".length);
    } else if (arg === "--platform") {
      args.platformIds.push(argv[++index]);
    } else if (arg.startsWith("--platform=")) {
      args.platformIds.push(arg.slice("--platform=".length));
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`generate-latest-json: unknown argument ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/generate-latest-json.mjs [--tag vX.Y.Z] [--upload]
       [--allow-version-mismatch]
       [--stage-root release-assets/signed [--platform windows-x64] [--platform macos-arm64]]

Generates apps/shell/src-tauri/target/release/bundle/nsis/latest.json for the
signed NSIS installer and its updater .sig file. With --stage-root, reads the
independent platform subdirectories and writes one lockstep latest.json at the
stage root. Existing platform directories are auto-detected unless --platform
is supplied.

The source installer's embedded version must match the tag; a stale build in
the NSIS directory otherwise publishes the previous version's signature under
the new tag and breaks auto-update fleet-wide. --allow-version-mismatch skips
that check (expert escape hatch only).`);
}

function resolveTag(tagOverride) {
  if (tagOverride !== undefined) return tagOverride.trim();
  try {
    return execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function findNsisArtifacts(nsisDir) {
  if (!existsSync(nsisDir)) {
    throw new Error(`generate-latest-json: NSIS bundle directory does not exist: ${nsisDir}`);
  }

  const exeFilenames = readdirSync(nsisDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (exeFilenames.length === 0) {
    throw new Error(`generate-latest-json: no NSIS installer .exe found in ${nsisDir}`);
  }
  if (exeFilenames.length > 1) {
    throw new Error(
      `generate-latest-json: multiple NSIS installer .exe candidates found in ${nsisDir}: ${exeFilenames.join(
        ", ",
      )}`,
    );
  }

  const exeFilename = exeFilenames[0];
  const sigPath = path.join(nsisDir, `${exeFilename}.sig`);
  if (!existsSync(sigPath)) {
    throw new Error(`generate-latest-json: missing updater signature: ${sigPath}`);
  }

  return { exeFilename, sigPath };
}

export function findStagedUpdaterArtifacts(stageRoot, platformIds = []) {
  requireNonEmptyString("stageRoot", stageRoot);
  const resolvedRoot = path.resolve(stageRoot);
  const selected = platformIds.length > 0 ? platformIds : PLATFORM_IDS;
  const artifacts = [];
  for (const platformId of selected) {
    const platform = getPlatform(platformId);
    const platformDir = path.join(resolvedRoot, path.basename(platform.paths.releaseStageDir));
    if (!existsSync(platformDir)) {
      if (platformIds.length > 0) {
        throw new Error(
          `generate-latest-json: requested platform stage does not exist: ${platformDir}`,
        );
      }
      continue;
    }
    const candidates = readdirSync(platformDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && platform.artifact.updaterPattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (candidates.length !== 1) {
      throw new Error(
        `generate-latest-json: ${platformId} stage must contain exactly one updater artifact; found ${candidates.join(", ") || "(none)"}.`,
      );
    }
    const filename = candidates[0];
    const sigPath = path.join(platformDir, `${filename}.sig`);
    if (!existsSync(sigPath)) {
      throw new Error(`generate-latest-json: missing updater signature: ${sigPath}`);
    }
    artifacts.push({
      platformId,
      filename,
      signature: readFileSync(sigPath, "utf8").trim(),
    });
  }
  if (artifacts.length === 0) {
    throw new Error(
      `generate-latest-json: no platform updater artifacts found below ${resolvedRoot}.`,
    );
  }
  return artifacts;
}

function uploadLatestJson(tag, latestJsonPath) {
  console.log(`generate-latest-json: uploading ${latestJsonPath} to release ${tag}`);
  execFileSync("gh", ["release", "upload", tag, latestJsonPath, "--clobber"], {
    stdio: "inherit",
  });
  console.log(
    "generate-latest-json: reminder: the release must be the latest published non-prerelease GitHub Release for /latest/download/latest.json to serve this manifest.",
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const tag = resolveTag(args.tag);
  if (!tag) {
    throw new Error(
      "generate-latest-json: could not resolve a release tag. Pass --tag v1.2.3 or run on a commit tagged like v1.2.3.",
    );
  }

  const resolved = normalizeTag(tag);
  if (isSemverPrereleaseVersion(resolved.version)) {
    console.log(
      `generate-latest-json: refusing to write or upload stable ${LATEST_JSON} for prerelease tag ${resolved.tag}.`,
    );
    console.log(
      "generate-latest-json: stable auto-update uses /releases/latest/download/latest.json, and GitHub /latest skips prereleases.",
    );
    console.log(
      "generate-latest-json: stable latest.json was left untouched; publish preview assets on a GitHub prerelease for manual download instead.",
    );
    return;
  }

  let platformArtifacts;
  let latestJsonPath;
  let sourceExeFilename;
  if (args.stageRoot) {
    platformArtifacts = findStagedUpdaterArtifacts(args.stageRoot, args.platformIds);
    latestJsonPath = path.join(path.resolve(args.stageRoot), LATEST_JSON);
  } else {
    const legacy = findNsisArtifacts(NSIS_DIR);
    sourceExeFilename = legacy.exeFilename;
    assertSourceInstallerMatchesTag(sourceExeFilename, resolved.version, {
      allowVersionMismatch: args.allowVersionMismatch,
    });
    platformArtifacts = [{
      platformId: DEFAULT_PLATFORM_ID,
      filename: canonicalInstallerFilename(resolved.version),
      signature: readFileSync(legacy.sigPath, "utf8").trim(),
    }];
    latestJsonPath = path.join(NSIS_DIR, LATEST_JSON);
  }
  const manifest = buildLatestJsonManifest({
    tag: resolved.tag,
    platformArtifacts,
    pubDate: new Date(),
  });

  writeFileSync(latestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const readBack = JSON.parse(readFileSync(latestJsonPath, "utf8"));
  validateLatestJsonManifest(readBack, { tag: resolved.tag, platformArtifacts });

  console.log(`generate-latest-json: wrote ${latestJsonPath}`);
  if (sourceExeFilename) {
    console.log(`generate-latest-json: source installer = ${sourceExeFilename}`);
  }
  for (const artifact of platformArtifacts) {
    console.log(
      `generate-latest-json: ${artifact.platformId} updater asset = ${artifact.filename}`,
    );
  }

  if (args.upload) {
    uploadLatestJson(resolved.tag, latestJsonPath);
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (import.meta.url === invokedUrl) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
