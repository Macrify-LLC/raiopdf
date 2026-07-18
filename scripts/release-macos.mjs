// macOS release orchestrator: takes the repo from source to a signed, notarized,
// stapled DMG plus a Tauri-signed updater archive, in the final-byte order the
// release contract requires (see docs/SIGNING.md, "macOS"):
//
//   1. assemble       payload assembled, every Mach-O Developer ID signed, THEN
//                     the payload manifest generated over the signed bytes
//                     (RAIOPDF_MACOS_SIGN_PAYLOAD=1 hook in the assembler)
//   2. build          version stamped, sidecars compiled, Tauri builds + signs
//                     the .app (hardened runtime, entitlements overlay)
//   3. verify-app     strict recursive codesign verification
//   4. notarize-app   notarytool submit --wait, log fetched on failure
//   5. staple-app     staple + validate + Gatekeeper assessment
//   6. updater        .app.tar.gz built FROM THE STAPLED APP, Tauri-minisigned,
//                     signature verified against the updater pubkey
//   7. dmg            DMG built from the stapled app, codesigned
//   8. notarize-dmg   notarize + staple + Gatekeeper assessment
//   9. stage          canonical release assets staged + validated
//
// Environment:
//   RAIOPDF_MAC_SIGN_IDENTITY        required. Full identity string, e.g.
//                                    "Developer ID Application: NAME (TEAMID)".
//   RAIOPDF_NOTARY_PROFILE           notarytool keychain profile (default
//                                    "raiopdf-notary"; see docs/SIGNING.md).
//   TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]  required at the `updater` step.
//
// Usage:
//   node scripts/release-macos.mjs [--version X.Y.Z] [--resume-from STEP]
//                                  [--stop-after STEP] [--skip-stage]
//
// Without --version the version comes from the exact git tag on HEAD (vX.Y.Z),
// matching the Windows signed-release flow. --resume-from re-enters after a
// failed step without redoing earlier work (artifacts are looked up on disk).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalArtifactNames, platformPath } from "../installer/platforms.mjs";
import { verifyTauriUpdaterSignature } from "./minisign.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLATFORM_ID = "macos-arm64";
const APP_NAME = "RaioPDF.app";
const BUNDLE_MACOS_DIR = path.join(REPO_ROOT, "target", "release", "bundle", "macos");
const BUILD_OUT_DIR = path.join(REPO_ROOT, "release-assets", "build", PLATFORM_ID);
const SIGNING_CONFIG = "src-tauri/tauri.macos.signing.conf.json";

const STEPS = [
  "assemble",
  "build",
  "verify-app",
  "notarize-app",
  "staple-app",
  "updater",
  "dmg",
  "notarize-dmg",
  "stage",
];

function usageError(message) {
  console.error(`release-macos: ${message}`);
  console.error(
    "Usage: node scripts/release-macos.mjs [--version X.Y.Z] [--resume-from STEP] [--stop-after STEP] [--skip-stage]",
  );
  console.error(`Steps: ${STEPS.join(" -> ")}`);
  process.exit(2);
}

export function parseArgs(argv) {
  const args = { version: null, resumeFrom: null, stopAfter: null, skipStage: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") args.version = argv[++index];
    else if (arg === "--resume-from") args.resumeFrom = argv[++index];
    else if (arg === "--stop-after") args.stopAfter = argv[++index];
    else if (arg === "--skip-stage") args.skipStage = true;
    else return { error: `unknown argument: ${arg}` };
  }
  for (const [flag, value] of [
    ["--resume-from", args.resumeFrom],
    ["--stop-after", args.stopAfter],
  ]) {
    if (value !== null && !STEPS.includes(value)) {
      return { error: `${flag} must be one of: ${STEPS.join(", ")}` };
    }
  }
  return { args };
}

function run(command, commandArgs, { env = {}, cwd = REPO_ROOT, capture = false } = {}) {
  const display = [command, ...commandArgs].join(" ");
  console.log(`\n$ ${display}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`command failed (exit ${result.status}): ${display}`);
  }
  return capture ? result.stdout : "";
}

function resolveVersion(explicit) {
  if (explicit) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(explicit)) {
      throw new Error(`--version must be semver, got: ${explicit}`);
    }
    return explicit;
  }
  const result = spawnSync("git", ["describe", "--tags", "--exact-match"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      "HEAD carries no exact tag. Tag the release commit (git tag vX.Y.Z) or pass --version explicitly.",
    );
  }
  return result.stdout.trim().replace(/^v/u, "");
}

function requireSigningIdentity() {
  const identity = process.env.RAIOPDF_MAC_SIGN_IDENTITY;
  if (!identity || identity.trim() === "") {
    throw new Error(
      "RAIOPDF_MAC_SIGN_IDENTITY is not set. Export the full Developer ID Application identity string; see docs/SIGNING.md (macOS).",
    );
  }
  const listing = run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
  if (!listing.includes(identity)) {
    throw new Error(
      `signing identity not found in the keychain: ${identity}\nAvailable identities:\n${listing.trim()}`,
    );
  }
  return identity;
}

function notaryProfile() {
  return process.env.RAIOPDF_NOTARY_PROFILE || "raiopdf-notary";
}

function ghostscriptVersionFromPins() {
  const pins = readFileSync(path.join(REPO_ROOT, "installer", "PINS.macos-arm64.env"), "utf8");
  const match = /^GHOSTSCRIPT_VERSION=["']?([0-9][0-9.]*)["']?\s*$/mu.exec(pins);
  if (!match) throw new Error("GHOSTSCRIPT_VERSION not found in installer/PINS.macos-arm64.env");
  return match[1];
}

function appPath() {
  return path.join(BUNDLE_MACOS_DIR, APP_NAME);
}

function requireApp() {
  if (!existsSync(appPath())) {
    throw new Error(`built app not found at ${appPath()} — run the build step first`);
  }
  return appPath();
}

function notarize(artifactPath, label) {
  const submitJson = run(
    "xcrun",
    [
      "notarytool",
      "submit",
      artifactPath,
      "--keychain-profile",
      notaryProfile(),
      "--wait",
      "--output-format",
      "json",
    ],
    { capture: true },
  );
  let parsed;
  try {
    parsed = JSON.parse(submitJson.trim().split("\n").filter(Boolean).at(-1));
  } catch {
    throw new Error(`notarytool returned unparseable output for ${label}:\n${submitJson}`);
  }
  console.log(`notarytool: ${label} submission ${parsed.id} -> ${parsed.status}`);
  if (parsed.status !== "Accepted") {
    if (parsed.id) {
      // Surface the per-file issues before failing — this is the actionable part.
      run("xcrun", ["notarytool", "log", parsed.id, "--keychain-profile", notaryProfile()]);
    }
    throw new Error(`notarization of ${label} was not accepted (status: ${parsed.status})`);
  }
}

const stepImplementations = {
  assemble(context) {
    // Stamp BEFORE assembly: the payload's legal records (COMPONENT-MANIFEST
    // releaseVersion, RaioPDF component version) are baked in at assembly time
    // and must match the version the release ships as.
    run("node", ["scripts/stamp-shell-version.mjs", context.version]);
    run("pnpm", ["--filter", "@raiopdf/mcp", "build"]);
    run("node", ["installer/run-payload-assembler.mjs", "--platform", PLATFORM_ID], {
      env: { RAIOPDF_MACOS_SIGN_PAYLOAD: "1" },
    });
  },

  build(context) {
    run("node", ["scripts/stamp-shell-version.mjs", context.version]);
    run("pnpm", ["build:external-bins"]);
    run("pnpm", ["--filter", "@raiopdf/shell", "tauri", "build", "--config", SIGNING_CONFIG], {
      env: { APPLE_SIGNING_IDENTITY: context.identity },
    });
    requireApp();
  },

  "verify-app"() {
    const app = requireApp();
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    // Informational: show the outer app's entitlements so a review can confirm
    // the main executable carries none of the payload-only exceptions.
    run("codesign", ["--display", "--entitlements", "-", app]);
  },

  "notarize-app"() {
    const app = requireApp();
    const zip = path.join(BUILD_OUT_DIR, "RaioPDF-notarize.zip");
    rmSync(zip, { force: true });
    run("ditto", ["-c", "-k", "--keepParent", app, zip]);
    notarize(zip, APP_NAME);
    rmSync(zip, { force: true });
  },

  "staple-app"() {
    const app = requireApp();
    run("xcrun", ["stapler", "staple", app]);
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  },

  updater(context) {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
      throw new Error(
        "TAURI_SIGNING_PRIVATE_KEY is not set — the updater archive must be minisigned; see docs/SIGNING.md.",
      );
    }
    requireApp();
    const archive = path.join(BUILD_OUT_DIR, context.names.updater);
    rmSync(archive, { force: true });
    rmSync(`${archive}.sig`, { force: true });
    run("tar", ["-czf", archive, "-C", BUNDLE_MACOS_DIR, APP_NAME]);
    run("pnpm", ["--filter", "@raiopdf/shell", "exec", "tauri", "signer", "sign", archive]);
    verifyTauriUpdaterSignature(archive, `${archive}.sig`);
    console.log(`updater signature verified against the configured pubkey: ${archive}.sig`);
  },

  dmg(context) {
    const app = requireApp();
    const staging = path.join(BUILD_OUT_DIR, "dmg-staging");
    const dmg = path.join(BUILD_OUT_DIR, context.names.installer);
    rmSync(staging, { recursive: true, force: true });
    rmSync(dmg, { force: true });
    mkdirSync(staging, { recursive: true });
    // ditto preserves signatures, extended attributes, and symlinks exactly —
    // the DMG must contain the stapled bytes, not an approximation of them.
    run("ditto", [app, path.join(staging, APP_NAME)]);
    symlinkSync("/Applications", path.join(staging, "Applications"));
    run("hdiutil", [
      "create",
      "-volname",
      "RaioPDF",
      "-srcfolder",
      staging,
      "-ov",
      "-format",
      "UDZO",
      dmg,
    ]);
    rmSync(staging, { recursive: true, force: true });
    run("codesign", ["--sign", context.identity, "--timestamp", dmg]);
  },

  "notarize-dmg"(context) {
    const dmg = path.join(BUILD_OUT_DIR, context.names.installer);
    if (!existsSync(dmg)) throw new Error(`DMG not found at ${dmg} — run the dmg step first`);
    notarize(dmg, path.basename(dmg));
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
  },

  stage(context) {
    const dmg = path.join(BUILD_OUT_DIR, context.names.installer);
    const archive = path.join(BUILD_OUT_DIR, context.names.updater);
    run("node", [
      "scripts/prepare-signed-release-assets.mjs",
      "--platform",
      PLATFORM_ID,
      "--tag",
      `v${context.version}`,
      "--dmg",
      dmg,
      "--updater",
      archive,
      "--updater-sig",
      `${archive}.sig`,
      // Two built payloads exist after a bundle (the .app's copy and Tauri's
      // build-time staging copy); compliance assets come from the shipped one.
      "--payload-dir",
      path.join(appPath(), "Contents", "Resources", "payload"),
    ]);
    run("node", [
      "scripts/validate-package-boundary.mjs",
      "--platform",
      PLATFORM_ID,
      "--root",
      platformPath(REPO_ROOT, PLATFORM_ID, "releaseStageDir"),
      "--release-version",
      context.version,
      "--ghostscript-version",
      ghostscriptVersionFromPins(),
      "--payload-root",
      platformPath(REPO_ROOT, PLATFORM_ID, "payloadOutputDir"),
    ]);
  },
};

async function main() {
  if (os.platform() !== "darwin") usageError("this orchestrator only runs on macOS");
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) usageError(parsed.error);
  const { version: versionArg, resumeFrom, stopAfter, skipStage } = parsed.args;

  const version = resolveVersion(versionArg);
  const identity = requireSigningIdentity();
  const names = canonicalArtifactNames(PLATFORM_ID, version);
  mkdirSync(BUILD_OUT_DIR, { recursive: true });

  const context = { version, identity, names };
  const startIndex = resumeFrom ? STEPS.indexOf(resumeFrom) : 0;
  const endIndex = stopAfter ? STEPS.indexOf(stopAfter) : STEPS.length - 1;
  if (startIndex > endIndex) usageError("--resume-from is after --stop-after");

  console.log(`release-macos: v${version} as "${identity}"`);
  console.log(`steps: ${STEPS.slice(startIndex, endIndex + 1).join(" -> ")}`);

  for (const step of STEPS.slice(startIndex, endIndex + 1)) {
    if (step === "stage" && skipStage) {
      console.log("\n=== stage (skipped: --skip-stage) ===");
      continue;
    }
    console.log(`\n=== ${step} ===`);
    await stepImplementations[step](context);
  }

  console.log(`\nrelease-macos: complete through "${STEPS[endIndex]}".`);
  console.log(`artifacts: ${BUILD_OUT_DIR}`);
  console.log(`  installer: ${context.names.installer}`);
  console.log(`  updater:   ${context.names.updater} (+.sig)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`\nrelease-macos: ${error.message}`);
    process.exit(1);
  });
}
