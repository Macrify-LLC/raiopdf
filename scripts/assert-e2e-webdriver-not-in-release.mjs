#!/usr/bin/env node
// Guard: the `e2e-webdriver` Cargo feature (which compiles the native-dialog
// test stub) must NEVER be reachable from a release build path. It is a
// non-default feature enabled only by the dedicated e2e build script; a release
// or signed build must not pass `--features`, and no shipped config or tooling
// script may enable the feature.
//
// The checks derive their target set by CONVENTION (glob + name pattern) rather
// than a hardcoded list, so a newly added tauri config, release script, or
// e2e build variant is covered automatically instead of silently slipping past.
//
// Static + fast (no cargo build). Run in CI on every canary trigger and locally
// via `pnpm assert:no-e2e-in-release`. A `cargo tree -e features` check is a
// heavier optional complement; this static guard is the fast gate.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FEATURE = "e2e-webdriver";
/**
 * Matches the feature being ENABLED via a Cargo/Tauri features flag on a single
 * command line (`--features e2e-webdriver`, `--features=a,e2e-webdriver`,
 * `-F e2e-webdriver`). Intra-arg whitespace is limited to spaces/tabs (never a
 * newline) so the pattern can't span unrelated lines of a scanned file.
 */
const FEATURE_ENABLE_RE = new RegExp(
  `(?:-F|--features)[=\\t ]+["']?[\\w,\\t -]*\\b${FEATURE}\\b`,
);
/** Scripts sanctioned to enable the feature: the dedicated e2e build, any platform. */
const ALLOWED_SCRIPT_RE = /^build:shell:e2e:/;
/** Scripts that ship a release/signed build — they must never pass a Cargo feature. */
const RELEASE_SCRIPT_RE = /^(build:shell|release:|prepare:release)/;
/** This guard's own basename — excluded from the scan (its doc examples name the flag). */
const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));

function readIfPresent(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Files in `dir` whose basename matches `pattern` (empty if the dir is absent). */
function listFiles(dir, pattern) {
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Returns a list of human-readable violation strings (empty when clean). */
export function findViolations(root) {
  const violations = [];

  // 1. package.json scripts: only a `build:shell:e2e:*` script may enable the
  //    feature, and no release/signed build script may pass ANY Cargo feature.
  const pkgRaw = readIfPresent(path.join(root, "package.json"));
  if (pkgRaw) {
    const scripts = JSON.parse(pkgRaw).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== "string") {
        continue;
      }
      const allowed = ALLOWED_SCRIPT_RE.test(name);
      if (FEATURE_ENABLE_RE.test(cmd) && !allowed) {
        violations.push(`package.json script "${name}" enables ${FEATURE}`);
      }
      if (RELEASE_SCRIPT_RE.test(name) && !allowed && cmd.includes("--features")) {
        violations.push(`release script "${name}" must not pass a Cargo feature: ${cmd}`);
      }
    }
  }

  // 2. The feature must not be in the shell crate's DEFAULT feature set.
  const cargo = readIfPresent(path.join(root, "apps/shell/src-tauri/Cargo.toml"));
  if (cargo) {
    const defaultMatch = cargo.match(/^\s*default\s*=\s*\[([^\]]*)\]/m);
    if (defaultMatch && defaultMatch[1].includes(FEATURE)) {
      violations.push(`apps/shell/src-tauri/Cargo.toml default features include ${FEATURE}`);
    }
  }

  // 3. Shipped tauri configs and tooling scripts (globbed, not enumerated) must
  //    not enable the feature. Test files are excluded — their fixture strings
  //    legitimately contain `--features e2e-webdriver`.
  const scannedFiles = [
    ...listFiles(path.join(root, "apps/shell/src-tauri"), /^tauri.*\.conf\.json$/),
    ...listFiles(path.join(root, "scripts"), /\.mjs$/).filter(
      (file) => !file.endsWith(".test.mjs") && path.basename(file) !== SELF_BASENAME,
    ),
  ];
  for (const file of scannedFiles) {
    const content = readIfPresent(file);
    if (content && FEATURE_ENABLE_RE.test(content)) {
      violations.push(`${path.relative(root, file)} enables ${FEATURE}`);
    }
  }

  return violations;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = findViolations(root);
  if (violations.length > 0) {
    console.error("Release build paths must never enable the e2e-webdriver feature:");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  console.log("OK: no release build path enables the e2e-webdriver feature.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
