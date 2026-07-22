#!/usr/bin/env node
// Per-binary macOS signing for the finished RaioPDF.app bundle.
//
// Tauri's regular macOS signing pass can apply its entitlement file to bundled
// code. That is too broad for the two `externalBin` sidecars: only the host app
// should be able to send Apple Events to Microsoft Word. This script signs both
// sidecars first with no entitlements, then signs the app bundle with
// app.entitlements. `codesign` signs the app's main executable while preserving
// already-signed nested code, so the final outer signature covers the sidecars
// without granting them Automation permission.

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const APP_EXECUTABLE = "raiopdf-shell";
export const EXTERNAL_BINARIES = ["raiopdf-engine-host", "raiopdf-mcp"];
export const AUTOMATION_ENTITLEMENT = "com.apple.security.automation.apple-events";
export const APP_ENTITLEMENTS = path.join(
  REPO_ROOT,
  "apps",
  "shell",
  "src-tauri",
  "entitlements",
  "app.entitlements",
);

export function bundledPythonRoot(appPath) {
  return path.join(
    appPath,
    "Contents",
    "Resources",
    "payload",
    "ocr",
    "python",
  );
}

export function readOnlyDirectoryMode(mode) {
  return mode & ~0o222;
}

export function replaceableDirectoryMode(mode) {
  return mode | 0o200;
}

/**
 * Undo only the directory-write hardening from a previous generated bundle so
 * Tauri can remove and replace it on the next build. Files stay untouched and
 * the freshly built bundle is hardened again before its final signature.
 */
export function makeBundledPythonTreeReplaceable(appPath) {
  const root = bundledPythonRoot(appPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) return;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const mode = statSync(directory).mode & 0o777;
    chmodSync(directory, replaceableDirectoryMode(mode));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
}

/**
 * Python descendants can ignore launcher environment variables and otherwise
 * create `__pycache__` inside the signed app. Directory write bits are removed
 * after Tauri has copied resources but before the final outer signature, so no
 * runtime child can mutate the sealed bundle.
 */
export function hardenBundledPythonTree(appPath) {
  const root = bundledPythonRoot(appPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`sign-macos-app-binaries: bundled Python tree is missing: ${root}`);
  }
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
    const mode = statSync(directory).mode & 0o777;
    chmodSync(directory, readOnlyDirectoryMode(mode));
  }
}

export function assertBundledPythonTreeReadOnly(appPath) {
  const root = bundledPythonRoot(appPath);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const mode = statSync(directory).mode & 0o777;
    if ((mode & 0o222) !== 0) {
      throw new Error(`sign-macos-app-binaries: writable bundled Python directory: ${directory}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
}

export function parseArgs(argv) {
  const args = { app: undefined, verify: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app") args.app = argv[++index];
    else if (arg.startsWith("--app=")) args.app = arg.slice("--app=".length);
    else if (arg === "--verify") args.verify = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`sign-macos-app-binaries: unknown argument ${arg}`);
  }
  if (!args.help && (!args.app || args.app.trim() === "")) {
    throw new Error("sign-macos-app-binaries: --app PATH is required.");
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/sign-macos-app-binaries.mjs --app PATH [--verify]

Without --verify, re-signs the Rust externalBin sidecars without entitlements,
then signs the outer app bundle with app.entitlements. --verify strictly checks
the app signature and asserts that Apple Events is present only on the main app
executable, never on an externalBin sidecar.`);
}

export function binaryPaths(appPath) {
  const macOSDir = path.join(appPath, "Contents", "MacOS");
  return {
    main: path.join(macOSDir, APP_EXECUTABLE),
    sidecars: EXTERNAL_BINARIES.map((name) => path.join(macOSDir, name)),
  };
}

export function assertBundleLayout(appPath, fileExists = existsSync) {
  if (!fileExists(appPath)) {
    throw new Error(`sign-macos-app-binaries: app bundle not found: ${appPath}`);
  }
  const { main, sidecars } = binaryPaths(appPath);
  for (const binaryPath of [main, ...sidecars]) {
    if (!fileExists(binaryPath)) {
      throw new Error(
        `sign-macos-app-binaries: expected bundled executable is missing: ${binaryPath}`,
      );
    }
  }
  return { main, sidecars };
}

/**
 * The ordered commands needed for the entitlement boundary. Sidecars must be
 * signed before the bundle; changing nested code after the outer app is signed
 * invalidates the app's CodeResources seal.
 */
export function signingPlan(appPath, identity) {
  if (!identity || identity.trim() === "") {
    throw new Error("sign-macos-app-binaries: RAIOPDF_MAC_SIGN_IDENTITY is not set.");
  }
  const { sidecars } = binaryPaths(appPath);
  const base = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
  return [
    ...sidecars.map((sidecar) => ({
      target: sidecar,
      args: [...base, sidecar],
      purpose: "externalBin sidecar without entitlements",
    })),
    {
      target: appPath,
      args: [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        APP_ENTITLEMENTS,
        "--sign",
        identity,
        appPath,
      ],
      purpose: "outer app bundle and its main executable with Apple Events",
    },
  ];
}

function runCodesign(args, { capture = false } = {}) {
  const result = spawnSync("codesign", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    throw new Error(
      `sign-macos-app-binaries: failed to run codesign: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr ?? ""}${result.stdout ?? ""}`.trimEnd() : "";
    throw new Error(`sign-macos-app-binaries: codesign exited ${result.status}.${detail}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function hasGrantedEntitlement(entitlementsText, entitlement = AUTOMATION_ENTITLEMENT) {
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`, "u").test(
    entitlementsText,
  );
}

export function assertAutomationEntitlementBoundary({ mainEntitlements, sidecarEntitlements }) {
  if (!hasGrantedEntitlement(mainEntitlements)) {
    throw new Error(
      `sign-macos-app-binaries: main app executable is missing ${AUTOMATION_ENTITLEMENT}.`,
    );
  }
  for (const [sidecar, entitlements] of Object.entries(sidecarEntitlements)) {
    if (hasGrantedEntitlement(entitlements)) {
      throw new Error(
        `sign-macos-app-binaries: ${AUTOMATION_ENTITLEMENT} leaked to externalBin sidecar ${sidecar}.`,
      );
    }
  }
}

function entitlementsFor(binaryPath) {
  return runCodesign(["--display", "--entitlements", ":-", binaryPath], { capture: true });
}

export function verifyAppSigning(appPath) {
  const { main, sidecars } = assertBundleLayout(appPath);
  assertBundledPythonTreeReadOnly(appPath);
  runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  for (const binaryPath of [main, ...sidecars]) {
    runCodesign(["--verify", "--strict", "--verbose=2", binaryPath]);
  }
  assertAutomationEntitlementBoundary({
    mainEntitlements: entitlementsFor(main),
    sidecarEntitlements: Object.fromEntries(
      sidecars.map((sidecar) => [path.basename(sidecar), entitlementsFor(sidecar)]),
    ),
  });
}

export function signAppBinaries(appPath, identity) {
  assertBundleLayout(appPath);
  if (!existsSync(APP_ENTITLEMENTS) || !statSync(APP_ENTITLEMENTS).isFile()) {
    throw new Error(
      `sign-macos-app-binaries: app entitlements file is missing: ${APP_ENTITLEMENTS}`,
    );
  }
  hardenBundledPythonTree(appPath);
  for (const command of signingPlan(appPath, identity)) {
    console.log(`sign-macos-app-binaries: ${command.purpose}: ${command.target}`);
    runCodesign(command.args);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const appPath = path.resolve(args.app);
  if (args.verify) {
    verifyAppSigning(appPath);
    console.log("sign-macos-app-binaries: verified Apple Events entitlement boundary.");
    return;
  }
  signAppBinaries(appPath, process.env.RAIOPDF_MAC_SIGN_IDENTITY);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`\nsign-macos-app-binaries: ${error.message}`);
    process.exit(1);
  }
}
