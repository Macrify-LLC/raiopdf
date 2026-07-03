#!/usr/bin/env node
// Stamps apps/shell/package.json `version` — the single source of truth that
// tauri.conf.json reads (`"version": "../package.json"`). Run by BOTH the CI
// release workflow AND the local signed build (`pnpm build:shell:signed`), so
// updater artifacts can never ship as 0.0.0 and break client version comparison.
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

const pkgPath = fileURLToPath(new URL("../apps/shell/package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`stamp-shell-version: apps/shell/package.json version = ${version}`);
