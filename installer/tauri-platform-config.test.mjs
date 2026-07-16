import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function config(name) {
  return JSON.parse(readFileSync(path.join(repoRoot, "apps/shell/src-tauri", name), "utf8"));
}

test("base Tauri config cannot produce an accidental cross-platform bundle", () => {
  const base = config("tauri.conf.json");
  assert.equal(base.bundle.active, false);
  assert.equal(base.bundle.resources, undefined);
  assert.equal(base.bundle.windows, undefined);
});

test("Windows overlay maps only the Windows payload into the canonical installed path", () => {
  const windows = config("tauri.windows-x64.conf.json");
  assert.deepEqual(windows.bundle.targets, ["nsis"]);
  assert.deepEqual(windows.bundle.resources, { "payload/windows-x64": "payload" });
  assert.equal(windows.app.windows[0].decorations, false);
  assert.equal(windows.bundle.macOS, undefined);
});

test("macOS overlay is Apple Silicon-only by command contract and contains no Windows packaging", () => {
  const macos = config("tauri.macos.conf.json");
  assert.equal(macos.bundle.active, true);
  assert.deepEqual(macos.bundle.targets, ["app", "dmg"]);
  assert.deepEqual(macos.bundle.resources, { "payload/macos-arm64": "payload" });
  assert.equal(macos.bundle.macOS.minimumSystemVersion, "13.0");
  assert.equal(macos.app.windows[0].decorations, true);
  assert.equal(macos.bundle.windows, undefined);
  assert.equal(JSON.stringify(macos).includes("universal"), false);
});

test("signed Windows overlay preserves the Windows boundary", () => {
  const signed = config("tauri.windows.signing.conf.json");
  assert.deepEqual(signed.bundle.resources, { "payload/windows-x64": "payload" });
  assert.equal(signed.bundle.createUpdaterArtifacts, true);
  assert.equal(signed.bundle.windows.signCommand.cmd, "pwsh");
  assert.equal(signed.bundle.macOS, undefined);
});
