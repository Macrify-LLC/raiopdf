import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_IDS,
  assertOutsideForeignPlatformRoots,
  canonicalArtifactNames,
  getHostPlatformId,
  getPlatform,
  platformPath,
} from "./platforms.mjs";

test("descriptors expose distinct package and updater identities", () => {
  assert.deepEqual(PLATFORM_IDS, ["windows-x64", "macos-arm64"]);

  const windows = getPlatform("windows-x64");
  assert.equal(windows.rustTarget, "x86_64-pc-windows-msvc");
  assert.equal(windows.updaterPlatform, "windows-x86_64");
  assert.equal(windows.pinsFile, "installer/PINS.windows-x64.env");
  assert.equal(windows.paths.payloadOutputDir.endsWith("/windows-x64"), true);
  assert.deepEqual(windows.nativeBinaryExceptions, [
    { path: "ocr/gs/vcredist_x64.exe", format: "pe", architecture: "x86" },
  ]);

  const macos = getPlatform("macos-arm64");
  assert.equal(macos.rustTarget, "aarch64-apple-darwin");
  assert.equal(macos.updaterPlatform, "darwin-aarch64");
  assert.equal(macos.pinsFile, "installer/PINS.macos-arm64.env");
  assert.equal(macos.paths.payloadOutputDir.endsWith("/macos-arm64"), true);
  assert.deepEqual(macos.nativeBinaryExceptions, []);
  assert.notEqual(windows.paths.payloadCacheDir, macos.paths.payloadCacheDir);
  assert.notEqual(windows.paths.releaseStageDir, macos.paths.releaseStageDir);
});

test("artifact names and patterns are platform-specific", () => {
  const windows = canonicalArtifactNames("windows-x64", "1.2.3");
  assert.deepEqual(windows, {
    installer: "RaioPDF-1.2.3-windows-x64-setup.exe",
    updater: "RaioPDF-1.2.3-windows-x64-setup.exe",
  });
  assert.match(windows.installer, getPlatform("windows-x64").artifact.installerPattern);
  assert.match("RaioPDF_1.2.3_x64-setup.exe", getPlatform("windows-x64").artifact.rawInstallerPattern);

  const macos = canonicalArtifactNames("macos-arm64", "1.2.3-beta.1");
  assert.deepEqual(macos, {
    installer: "RaioPDF-1.2.3-beta.1-macos-arm64.dmg",
    updater: "RaioPDF-1.2.3-beta.1-macos-arm64.app.tar.gz",
  });
  assert.match(macos.installer, getPlatform("macos-arm64").artifact.installerPattern);
  assert.match("RaioPDF_1.2.3_aarch64.dmg", getPlatform("macos-arm64").artifact.rawInstallerPattern);
  assert.match(macos.updater, getPlatform("macos-arm64").artifact.updaterPattern);
});

test("foreign file markers reject cross-platform payload leakage", () => {
  const windowsMarkers = getPlatform("windows-x64").foreignFileMarkers;
  assert.equal(windowsMarkers.some((pattern) => pattern.test("payload/bin/helper.dylib")), true);
  assert.equal(windowsMarkers.some((pattern) => pattern.test("payload/ocr/qpdf/bin/qpdf.exe")), false);

  const macMarkers = getPlatform("macos-arm64").foreignFileMarkers;
  assert.equal(macMarkers.some((pattern) => pattern.test("payload/ocr/ocrmypdf.cmd")), true);
  assert.equal(macMarkers.some((pattern) => pattern.test("payload/lib/libqpdf.dylib")), false);
});

test("host and path resolution remain explicit", () => {
  assert.equal(getHostPlatformId({ platform: "win32", arch: "x64" }), "windows-x64");
  assert.equal(getHostPlatformId({ platform: "darwin", arch: "arm64" }), "macos-arm64");
  assert.throws(() => getHostPlatformId({ platform: "darwin", arch: "x64" }), /Unsupported/);
  assert.match(platformPath("C:/repo", "windows-x64", "payloadOutputDir"), /windows-x64$/);
  assert.throws(() => getPlatform("linux-x64"), /Unsupported RaioPDF platform/);
  assert.throws(
    () =>
      assertOutsideForeignPlatformRoots(
        "C:/repo",
        "windows-x64",
        "payloadOutputDir",
        "C:/repo/apps/shell/src-tauri/payload/macos-arm64/nested",
      ),
    /enters the macos-arm64 namespace/,
  );
  assert.throws(
    () =>
      assertOutsideForeignPlatformRoots(
        "C:/repo",
        "macos-arm64",
        "pinsFile",
        "C:/repo/installer/PINS.windows-x64.env",
      ),
    /enters the windows-x64 namespace/,
  );
  assert.doesNotThrow(() =>
    assertOutsideForeignPlatformRoots(
      "C:/repo",
      "macos-arm64",
      "payloadOutputDir",
      "D:/temporary/raiopdf-macos-arm64",
    ),
  );
});
