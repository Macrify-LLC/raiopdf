#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "Macrify-LLC/raiopdf";
const PLATFORM = "windows-x86_64";
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
  return `RaioPDF-${version}-windows-x64-setup.exe`;
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

export function buildLatestJsonManifest({ tag, exeFilename, signature, pubDate }) {
  const resolved = normalizeTag(tag);
  requireNonEmptyString("exeFilename", exeFilename);
  requireNonEmptyString("signature", signature);
  if (/[\\/]/.test(exeFilename) || !exeFilename.toLowerCase().endsWith(".exe")) {
    throw new Error(
      `generate-latest-json: exeFilename must be the installer filename, not a path (got ${JSON.stringify(
        exeFilename,
      )}).`,
    );
  }
  if (!CANONICAL_INSTALLER_RE.test(exeFilename)) {
    throw new Error(
      `generate-latest-json: installer asset must use the canonical public filename ` +
        `RaioPDF-<version>-windows-x64-setup.exe (got ${JSON.stringify(exeFilename)}).`,
    );
  }
  const installerVersion = extractInstallerVersion(exeFilename);
  if (installerVersion !== resolved.version) {
    throw new Error(
      `generate-latest-json: installer version ${JSON.stringify(
        installerVersion,
      )} does not match release tag version ${JSON.stringify(
        resolved.version,
      )} for ${exeFilename}. Rebuild the signed installer for ${resolved.tag}.`,
    );
  }

  return {
    version: resolved.version,
    pub_date: normalizePubDate(pubDate),
    platforms: {
      [PLATFORM]: {
        signature,
        url: `https://github.com/${REPO}/releases/download/${resolved.tag}/${exeFilename}`,
      },
    },
  };
}

export function validateLatestJsonManifest(manifest, { tag, exeFilename }) {
  const { version } = normalizeTag(tag);
  requireNonEmptyString("exeFilename", exeFilename);

  if (!manifest || typeof manifest !== "object") {
    throw new Error("generate-latest-json: latest.json must be a JSON object.");
  }
  if (manifest.version !== version) {
    throw new Error(
      `generate-latest-json: latest.json version ${JSON.stringify(
        manifest.version,
      )} does not match tag version ${JSON.stringify(version)}.`,
    );
  }
  requireNonEmptyString("latest.json pub_date", manifest.pub_date);

  const platform = manifest.platforms?.[PLATFORM];
  if (!platform || typeof platform !== "object") {
    throw new Error(`generate-latest-json: latest.json is missing platforms.${PLATFORM}.`);
  }
  requireNonEmptyString(`platforms.${PLATFORM}.signature`, platform.signature);
  requireNonEmptyString(`platforms.${PLATFORM}.url`, platform.url);

  let urlFilename;
  try {
    const url = new URL(platform.url);
    urlFilename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  } catch {
    throw new Error(
      `generate-latest-json: platforms.${PLATFORM}.url is not a valid URL: ${platform.url}`,
    );
  }

  if (urlFilename !== exeFilename) {
    throw new Error(
      `generate-latest-json: URL filename ${JSON.stringify(
        urlFilename,
      )} does not match local installer ${JSON.stringify(exeFilename)}.`,
    );
  }
}

function parseArgs(argv) {
  const args = { tag: undefined, upload: false, allowVersionMismatch: false };
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

Generates apps/shell/src-tauri/target/release/bundle/nsis/latest.json for the
signed NSIS installer and its updater .sig file.

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

  const { exeFilename: sourceExeFilename, sigPath } = findNsisArtifacts(NSIS_DIR);
  assertSourceInstallerMatchesTag(sourceExeFilename, resolved.version, {
    allowVersionMismatch: args.allowVersionMismatch,
  });
  const publicExeFilename = canonicalInstallerFilename(resolved.version);
  const signature = readFileSync(sigPath, "utf8").trim();
  const manifest = buildLatestJsonManifest({
    tag: resolved.tag,
    exeFilename: publicExeFilename,
    signature,
    pubDate: new Date(),
  });

  const latestJsonPath = path.join(NSIS_DIR, LATEST_JSON);
  writeFileSync(latestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const readBack = JSON.parse(readFileSync(latestJsonPath, "utf8"));
  validateLatestJsonManifest(readBack, { tag: resolved.tag, exeFilename: publicExeFilename });

  console.log(`generate-latest-json: wrote ${latestJsonPath}`);
  console.log(`generate-latest-json: source installer = ${sourceExeFilename}`);
  console.log(`generate-latest-json: public installer asset = ${publicExeFilename}`);

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
