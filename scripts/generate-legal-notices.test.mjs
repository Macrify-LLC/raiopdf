import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repoRoot, "scripts", "generate-legal-notices.mjs");

function readPin(pinsFile, key) {
  const contents = readFileSync(path.join(repoRoot, "installer", pinsFile), "utf8");
  const match = new RegExp(`^${key}=(.*)$`, "mu").exec(contents);
  if (!match) {
    throw new Error(`${key} not found in ${pinsFile}`);
  }
  return match[1].trim();
}

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

  // installer/PINS.macos-arm64.env is complete (macOS is a supported
  // platform now), so exercise the incomplete-provenance gate with a
  // deliberately truncated pins file instead — missing every
  // macOS-only source-build pin (PYTHON_STANDALONE_*, TESSERACT_SOURCE_*,
  // LEPTONICA_*, ...).
  const incompletePinsPath = path.join(payloadDir, "incomplete-macos-arm64.env");
  writeFileSync(
    incompletePinsPath,
    [
      "TEMURIN_JRE_VERSION=25.0.3+9",
      "TEMURIN_JRE_URL=https://example.invalid/jre.tar.gz",
      "TEMURIN_JRE_SHA256=0000000000000000000000000000000000000000000000000000000000000",
    ].join("\n"),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [generator, "--platform", "macos-arm64", "--pins", incompletePinsPath, "--payload-dir", payloadDir],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /macos-arm64 legal provenance is incomplete/);
  assert.match(result.stderr, /PYTHON_STANDALONE_VERSION/);
  assert.equal(existsSync(path.join(payloadDir, "legal")), false);
});

test("macOS PINS file in the repo is complete (real-pins regression guard)", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-mac-complete-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "macos-arm64", "PINS.macos-arm64.env");
  assert.equal(result.status, 0, result.stderr);
});

test("Mac selection refuses Windows pins rather than emitting Windows claims", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-cross-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "macos-arm64", "PINS.windows-x64.env");
  assert.notEqual(result.status, 0);
  // The Windows pins file has none of the macOS source-build pins
  // (PYTHON_STANDALONE_*, TESSERACT_SOURCE_*, LEPTONICA_*, ...), so mac
  // selection fails the same incomplete-provenance gate as an empty file
  // rather than silently emitting Windows binary claims under a mac label.
  assert.match(result.stderr, /macos-arm64 legal provenance is incomplete/);
  assert.match(result.stderr, /PYTHON_STANDALONE_VERSION/);
  assert.equal(existsSync(path.join(payloadDir, "legal")), false);
});

test("Windows legal payload keeps the byte-identical Ghostscript alias narrative", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-windows-gs-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "windows-x64", "PINS.windows-x64.env");
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(
    readFileSync(path.join(payloadDir, "legal", "COMPONENT-MANIFEST.json"), "utf8"),
  );
  const ghostscript = manifest.components.find((entry) => entry.name === "Ghostscript");
  assert.equal(ghostscript.license, "AGPL-3.0-only");
  assert.deepEqual(ghostscript.binary.payloadPaths, ["ocr/gs/bin/gswin64c.exe", "ocr/gs/bin/gs.exe"]);
  assert.match(ghostscript.modificationStatus, /Unmodified upstream Windows x64 installer payload/);

  const notices = readFileSync(path.join(payloadDir, "legal", "THIRD-PARTY-NOTICES.txt"), "utf8");
  assert.match(notices, /byte-identical convenience alias/);
});

test("macOS legal payload records the source-built pins and platform", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-macos-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const result = runGenerator(payloadDir, "macos-arm64", "PINS.macos-arm64.env");
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(
    readFileSync(path.join(payloadDir, "legal", "COMPONENT-MANIFEST.json"), "utf8"),
  );
  assert.equal(manifest.provenancePins, "installer/PINS.macos-arm64.env");
  assert.deepEqual(
    manifest.platforms.map(({ id, status, enginePlatform }) => ({ id, status, enginePlatform })),
    [{ id: "macos-arm64", status: "shipping", enginePlatform: "darwin-arm64" }],
  );

  const ghostscript = manifest.components.find((entry) => entry.name === "Ghostscript");
  assert.equal(ghostscript.license, "AGPL-3.0-only");
  assert.equal(ghostscript.binary, undefined);
  assert.equal(ghostscript.source.url, readPin("PINS.macos-arm64.env", "GHOSTSCRIPT_SOURCE_URL"));
  assert.equal(ghostscript.source.sha256, readPin("PINS.macos-arm64.env", "GHOSTSCRIPT_SOURCE_SHA256"));
  assert.deepEqual(ghostscript.payloadPaths, ["ocr/gs/bin/gs"]);
  assert.doesNotMatch(ghostscript.modificationStatus, /Unmodified upstream Windows/);
  assert.match(ghostscript.modificationStatus, /Built from the pinned upstream/);

  const tesseract = manifest.components.find((entry) => entry.name === "Tesseract OCR");
  assert.deepEqual(tesseract.payloadPaths, ["ocr/tesseract/bin/tesseract"]);
  assert.equal(tesseract.binary, undefined);

  const qpdf = manifest.components.find((entry) => entry.name === "qpdf");
  assert.deepEqual(qpdf.payloadPaths, ["ocr/qpdf/bin/qpdf"]);

  const python = manifest.components.find((entry) => entry.name === "Python (python-build-standalone)");
  assert.ok(python, "expected a python-build-standalone component on macOS");
  assert.deepEqual(python.payloadPaths, ["ocr/python/bin/python3"]);

  for (const name of ["Leptonica", "libpng", "libtiff", "libjpeg-turbo"]) {
    assert.ok(
      manifest.components.some((entry) => entry.name === name),
      `expected ${name} in the macOS component manifest`,
    );
  }

  const notices = readFileSync(path.join(payloadDir, "legal", "THIRD-PARTY-NOTICES.txt"), "utf8");
  assert.doesNotMatch(notices, /gswin64c\.exe/);
  assert.match(notices, /built from the pinned upstream AGPL-3\.0 source archive/i);

  const correspondence = readFileSync(
    path.join(payloadDir, "legal", "RELEASE-SOURCE-CORRESPONDENCE.md"),
    "utf8",
  );
  assert.doesNotMatch(correspondence, /gswin64c\.exe/);

  const sourceOffer = readFileSync(
    path.join(payloadDir, "legal", "source-offers", "GHOSTSCRIPT-SOURCE-OFFER.txt"),
    "utf8",
  );
  assert.doesNotMatch(sourceOffer, /gswin64c\.exe/);
});

test("macOS legal payload check passes against a matching fake payload", (context) => {
  const payloadDir = mkdtempSync(path.join(os.tmpdir(), "raiopdf-legal-macos-check-"));
  context.after(() => rmSync(payloadDir, { recursive: true, force: true }));

  const generateResult = runGenerator(payloadDir, "macos-arm64", "PINS.macos-arm64.env");
  assert.equal(generateResult.status, 0, generateResult.stderr);

  const checkResult = spawnSync(
    process.execPath,
    [
      generator,
      "--platform",
      "macos-arm64",
      "--pins",
      path.join(repoRoot, "installer", "PINS.macos-arm64.env"),
      "--payload-dir",
      payloadDir,
      "--check",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(checkResult.status, 0, checkResult.stderr);
});
