#!/usr/bin/env node
// Stamps the release-facing shell version in both Tauri's package.json source
// and Rust's package metadata. Run by BOTH the CI release workflow AND the local
// signed build (`pnpm build:shell:signed`), so updater artifacts and diagnostic
// reports can never ship as 0.0.0.
//
// Version resolution:
//   1. explicit arg:  node scripts/stamp-shell-version.mjs 1.2.3   (CI passes the tag)
//   2. otherwise:     the tag on the current commit (signed releases are cut from a
//                     tagged commit) via `git describe --tags --exact-match`.
// A leading "v" is stripped. If neither yields a valid semver, the script exits
// non-zero rather than silently stamping a bad version.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

function resolveVersion() {
  const arg = process.argv[2];
  if (arg) return arg.replace(/^v/, "");
  try {
    const tag = execSync("git describe --tags --exact-match", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return tag.replace(/^v/, "");
  } catch {
    return null;
  }
}

const version = resolveVersion();
if (!version || !SEMVER.test(version)) {
  console.error(
    `stamp-shell-version: could not resolve a valid semver version (got ${JSON.stringify(
      version,
    )}).\n` +
      `Pass one explicitly (node scripts/stamp-shell-version.mjs 1.2.3) or run on a ` +
      `commit tagged like v1.2.3.`,
  );
  process.exit(1);
}

function replaceRequired(path, pattern, replacement, label) {
  const before = readFileSync(path, "utf8");
  if (!pattern.test(before)) {
    throw new Error(`stamp-shell-version: could not find ${label} in ${path}`);
  }
  const after = before.replace(pattern, replacement);
  writeFileSync(path, after);
}

function stampCargoLockPackage(path, packageName, nextVersion) {
  const before = readFileSync(path, "utf8");
  const packagePattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\nversion = ")` +
      `[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?(")`,
    "m",
  );
  if (!packagePattern.test(before)) {
    throw new Error(`stamp-shell-version: could not find Cargo.lock package ${packageName}`);
  }
  writeFileSync(path, before.replace(packagePattern, `$1${nextVersion}$2`));
}

const pkgPath = fileURLToPath(new URL("../apps/shell/package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const shellCargoPath = fileURLToPath(new URL("../apps/shell/src-tauri/Cargo.toml", import.meta.url));
replaceRequired(
  shellCargoPath,
  /^version = "[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?"$/m,
  `version = "${version}"`,
  "apps/shell/src-tauri Cargo package version",
);

const cargoLockPath = fileURLToPath(new URL("../Cargo.lock", import.meta.url));
stampCargoLockPackage(cargoLockPath, "raiopdf-shell", version);

console.log(`stamp-shell-version: shell version = ${version}`);
