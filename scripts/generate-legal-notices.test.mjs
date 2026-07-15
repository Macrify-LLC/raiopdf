import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repoRoot, "scripts", "generate-legal-notices.mjs");

function runGenerator(payloadDir, platform, pinsFile) {
  return spawnSync(
    process.execPath,
    [
      generator,
      "--platform",
      platform,
      "--pins",
      path.join(repoRoot, "installer", pinsFile),
      "--payload-dir",
      payloadDir,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("Windows legal payload records the explicit Windows pins and platform", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-windows-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "windows-x64", "PINS.windows-x64.env");
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(
    readFileSync(path.join(payloadDir, "legal", "COMPONENT-MANIFEST.json"), "utf8"),
  );
  assert.equal(manifest.provenancePins, "installer/PINS.windows-x64.env");
  assert.deepEqual(
    manifest.platforms.map(({ id, status }) => ({ id, status })),
    [{ id: "windows-x64", status: "shipping" }],
  );
});

test("Mac legal generation fails before writing when native pins are incomplete", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-mac-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "macos-arm64", "PINS.macos-arm64.env");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /macos-arm64 legal provenance is incomplete/);
  assert.equal(existsSync(path.join(payloadDir, "legal")), false);
});

test("Mac selection refuses Windows pins rather than emitting Windows claims", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-cross-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "macos-arm64", "PINS.windows-x64.env");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to emit Windows claims/);
  assert.equal(existsSync(path.join(payloadDir, "legal")), false);
});
