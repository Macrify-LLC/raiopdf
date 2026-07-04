#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "Macrify-LLC/raiopdf";
const PLATFORM = "windows-x86_64";
const LATEST_JSON = "latest.json";
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
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
  const args = { tag: undefined, upload: false };
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

Generates apps/shell/src-tauri/target/release/bundle/nsis/latest.json for the
signed NSIS installer and its updater .sig file.`);
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
    "generate-latest-json: reminder: the release must be published, and be the latest release, for /latest/download/latest.json to serve this manifest.",
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

  const { exeFilename, sigPath } = findNsisArtifacts(NSIS_DIR);
  const signature = readFileSync(sigPath, "utf8").trim();
  const manifest = buildLatestJsonManifest({
    tag,
    exeFilename,
    signature,
    pubDate: new Date(),
  });

  const latestJsonPath = path.join(NSIS_DIR, LATEST_JSON);
  writeFileSync(latestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const readBack = JSON.parse(readFileSync(latestJsonPath, "utf8"));
  validateLatestJsonManifest(readBack, { tag, exeFilename });

  console.log(`generate-latest-json: wrote ${latestJsonPath}`);
  console.log(`generate-latest-json: installer asset = ${exeFilename}`);

  if (args.upload) {
    uploadLatestJson(tag, latestJsonPath);
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
