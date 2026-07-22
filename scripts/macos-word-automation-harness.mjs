#!/usr/bin/env node
// Build a pair of signed, hardened macOS apps that prove the Apple Events
// entitlement boundary used by RaioPDF's Word integration.
//
// This is deliberately not an `osascript` harness. `/usr/bin/osascript` is
// itself the immediate Apple Events sender, so a parent process that launches
// it cannot demonstrate whether *the parent app* needs the entitlement. The
// small Swift executable generated here calls AEDeterminePermissionToAutomate-
// Target and NSAppleScript in-process. The positive and negative apps differ
// only in their bundle identifier and Automation entitlement.
//
// Use on a desktop session with Microsoft Word installed:
//   node scripts/macos-word-automation-harness.mjs --identity "$RAIOPDF_MAC_SIGN_IDENTITY" --mode negative --reset --run
//   node scripts/macos-word-automation-harness.mjs --identity "$RAIOPDF_MAC_SIGN_IDENTITY" --mode positive --reset --run
//
// The negative run must return -1743 without a prompt. The positive run should
// prompt (after a reset) and succeed after the person clicks Allow. Each run
// writes a JSON report; retain it alongside `codesign --display --entitlements`
// output as release evidence. This probe changes only the two test bundle IDs'
// TCC decisions, never RaioPDF's production decision.

import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export const WORD_BUNDLE_ID = "com.microsoft.Word";
export const AUTOMATION_ENTITLEMENT = "com.apple.security.automation.apple-events";
export const HARNESS_IDS = {
  positive: "com.macrify.raiopdf.word-ae-positive",
  negative: "com.macrify.raiopdf.word-ae-negative",
};

export function parseArgs(argv) {
  const args = { identity: null, mode: null, output: null, reset: false, run: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--identity") args.identity = argv[++index];
    else if (arg.startsWith("--identity=")) args.identity = arg.slice("--identity=".length);
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "--output") args.output = argv[++index];
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--reset") args.reset = true;
    else if (arg === "--run") args.run = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`macos-word-automation-harness: unknown argument ${arg}`);
  }
  if (!args.help) {
    if (!args.identity?.trim()) throw new Error("macos-word-automation-harness: --identity is required.");
    if (!(args.mode in HARNESS_IDS)) {
      throw new Error("macos-word-automation-harness: --mode must be positive or negative.");
    }
  }
  return args;
}

export function entitlementForMode(mode) {
  return mode === "positive"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>${AUTOMATION_ENTITLEMENT}</key><true/></dict></plist>\n`
    : null;
}

export function infoPlist(bundleIdentifier, displayName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>raiopdf-word-ae-harness</string>
  <key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
  <key>CFBundleName</key><string>${displayName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>This signed RaioPDF release-validation harness needs permission to control Microsoft Word.</string>
</dict></plist>
`;
}

// Avoid `osascript` here. NSAppleScript is evaluated by this process and the
// authorization preflight calls the Carbon API from this exact code signature.
export const SWIFT_SOURCE = `import AppKit
import Carbon
import Foundation

let outputPath = CommandLine.arguments.dropFirst().first
let wordBundleID = "${WORD_BUNDLE_ID}"
// A command-line-shaped app has no window of its own. Give it a regular
// activation policy before asking TCC so the consent sheet is brought to the
// foreground instead of waiting invisibly behind another application.
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.activate(ignoringOtherApps: true)
var target = AEAddressDesc()
var wordProcessIdentifier: pid_t = NSRunningApplication
  .runningApplications(withBundleIdentifier: wordBundleID)
  .first?
  .processIdentifier ?? 0
let createStatus: OSStatus = withUnsafePointer(to: &wordProcessIdentifier) { pointer in
  OSStatus(AECreateDesc(DescType(typeKernelProcessID), pointer, MemoryLayout<pid_t>.size, &target))
}
var permissionStatus: OSStatus = wordProcessIdentifier == 0 ? -600 : createStatus
if createStatus == noErr && wordProcessIdentifier != 0 {
  permissionStatus = AEDeterminePermissionToAutomateTarget(
    &target, AEEventClass(kCoreEventClass), AEEventID(kAEOpenApplication), true
  )
}

var scriptError: NSDictionary?
var scriptResult = NSAppleEventDescriptor()
if permissionStatus == noErr && wordProcessIdentifier != 0 {
  let script = NSAppleScript(source: "tell application id \\\"${WORD_BUNDLE_ID}\\\" to get name")!
  scriptResult = script.executeAndReturnError(&scriptError)
} else {
  scriptError = ["message": "Skipped script execution because Word is not running or native Automation preflight did not authorize this bundle."]
}
let report: [String: Any] = [
  "pid": ProcessInfo.processInfo.processIdentifier,
  "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
  "wordBundleIdentifier": wordBundleID,
  "wordProcessIdentifier": wordProcessIdentifier,
  "createTargetStatus": createStatus,
  "permissionStatus": permissionStatus,
  "scriptResult": scriptResult.stringValue ?? "",
  "scriptError": scriptError ?? [:],
]
let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
if let outputPath {
  try! data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
} else {
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\\n".data(using: .utf8)!)
}
if permissionStatus != noErr || scriptError != nil { exit(1) }
`;

export function signingArgs(appPath, identity, entitlementsPath) {
  const args = ["--force", "--options", "runtime", "--timestamp"];
  if (entitlementsPath) args.push("--entitlements", entitlementsPath);
  args.push("--sign", identity, appPath);
  return args;
}

export function validateRunReport(mode, report) {
  if (report.wordBundleIdentifier !== WORD_BUNDLE_ID || !Number.isInteger(report.wordProcessIdentifier) || report.wordProcessIdentifier <= 0) {
    throw new Error("macos-word-automation-harness: Microsoft Word was not running for the native entitlement probe.");
  }
  if (mode === "negative") {
    if (report.permissionStatus !== -1743) {
      throw new Error(
        `macos-word-automation-harness: negative app must be denied with -1743, got ${report.permissionStatus}.`,
      );
    }
    return;
  }
  if (report.permissionStatus !== 0 || report.scriptResult !== "Microsoft Word") {
    throw new Error(
      `macos-word-automation-harness: positive app was not authorized and able to control Word (status ${report.permissionStatus}).`,
    );
  }
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw new Error(`macos-word-automation-harness: ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `macos-word-automation-harness: ${command} exited ${result.status}.${capture ? `\n${result.stderr ?? ""}` : ""}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function resetTestClientTcc(bundleIdentifier) {
  const result = spawnSync("tccutil", ["reset", "AppleEvents", bundleIdentifier], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`macos-word-automation-harness: tccutil: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // A never-run, uniquely scoped probe has no TCC row yet. macOS reports
  // that case as -10814/exit 64 instead of accepting an idempotent reset.
  // It is exactly the fresh state this harness needs; any other failure is
  // still fatal so the negative result cannot be accidentally stale.
  if (result.status === 64 && /No such bundle identifier/u.test(detail)) {
    console.log("macos-word-automation-harness: no prior TCC decision for this fresh test app.");
    return;
  }
  throw new Error(`macos-word-automation-harness: tccutil exited ${result.status}.\n${detail}`);
}

export function buildHarness({ mode, identity, root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-word-ae-")) }) {
  const bundleIdentifier = HARNESS_IDS[mode];
  const appPath = path.join(root, `RaioPDFWordAE${mode === "positive" ? "Positive" : "Negative"}.app`);
  const macOSDir = path.join(appPath, "Contents", "MacOS");
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  mkdirSync(macOSDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  const sourcePath = path.join(root, "main.swift");
  const binaryPath = path.join(macOSDir, "raiopdf-word-ae-harness");
  const entitlementsPath = path.join(root, "automation.entitlements");
  writeFileSync(sourcePath, SWIFT_SOURCE, "utf8");
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), infoPlist(bundleIdentifier, path.basename(appPath, ".app")), "utf8");
  run("xcrun", [
    "swiftc",
    sourcePath,
    "-o",
    binaryPath,
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "Carbon",
  ]);
  chmodSync(binaryPath, 0o755);
  const entitlements = entitlementForMode(mode);
  if (entitlements) writeFileSync(entitlementsPath, entitlements, "utf8");
  run("codesign", signingArgs(appPath, identity, entitlements ? entitlementsPath : null));
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  return { root, appPath, bundleIdentifier, binaryPath, entitlementsPath: entitlements ? entitlementsPath : null };
}

function usage() {
  console.log(`Usage: node scripts/macos-word-automation-harness.mjs --identity "Developer ID Application: ..." --mode positive|negative [--reset] [--run] [--output report.json]

Builds a temporary signed, hardened .app. --reset clears only the selected test
bundle's AppleEvents TCC decision. --run launches it through LaunchServices and
writes a JSON report. Run negative first: it must fail -1743 with no prompt;
then run positive and click Allow. Do not use this to infer RaioPDF's release
state until both reports and the final app's codesign evidence are recorded.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (process.platform !== "darwin") throw new Error("macos-word-automation-harness: macOS is required.");
  const harness = buildHarness(args);
  if (args.reset) {
    // tccutil resolves the client via LaunchServices, even for a fresh,
    // perfectly valid signed .app. Register the ephemeral probe first so a
    // reset is scoped to its exact test bundle ID rather than failing -10814.
    if (!existsSync(LSREGISTER)) {
      throw new Error(`macos-word-automation-harness: LaunchServices registration tool is missing: ${LSREGISTER}`);
    }
    run(LSREGISTER, ["-f", harness.appPath]);
    resetTestClientTcc(harness.bundleIdentifier);
  }
  const output = path.resolve(args.output ?? path.join(harness.root, `${args.mode}-report.json`));
  if (args.run) {
    if (existsSync(output)) rmSync(output, { force: true });
    // LaunchServices gives the process the same bundle-launch shape as a real
    // GUI app. Executing Contents/MacOS directly from an SSH/agent shell can
    // let TCC inherit that shell's responsible-process consent, which is not
    // evidence about this bundle's identity or entitlement.
    const result = spawnSync("open", ["-W", "-n", harness.appPath, "--args", output], {
      stdio: "inherit",
    });
    if (result.error) throw new Error(`macos-word-automation-harness: open: ${result.error.message}`);
    if (!existsSync(output)) {
      throw new Error("macos-word-automation-harness: the launched app wrote no report.");
    }
    validateRunReport(args.mode, JSON.parse(readFileSync(output, "utf8")));
    console.log(`macos-word-automation-harness: launch exit=${result.status}; report=${output}`);
  }
  console.log(`macos-word-automation-harness: app=${harness.appPath}`);
  console.log(`macos-word-automation-harness: bundle=${harness.bundleIdentifier}`);
  console.log(`macos-word-automation-harness: inspect= codesign --display --entitlements :- "${harness.binaryPath}"`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`\nmacos-word-automation-harness: ${error.message}`);
    process.exit(1);
  }
}
