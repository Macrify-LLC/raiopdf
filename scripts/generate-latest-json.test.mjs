import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assertSourceInstallerMatchesTag,
  buildLatestJsonManifest,
  canonicalInstallerFilename,
  canonicalUpdaterFilename,
  findStagedUpdaterArtifacts,
  isPrereleaseTag,
  isSemverPrereleaseVersion,
  sourceInstallerVersion,
  validateLatestJsonManifest,
} from "./generate-latest-json.mjs";

describe("buildLatestJsonManifest", () => {
  it("strips the leading v from the version and composes the release URL", () => {
    const manifest = buildLatestJsonManifest({
      tag: "v0.1.2",
      exeFilename: "RaioPDF-0.1.2-windows-x64-setup.exe",
      signature: "trusted-signature",
      pubDate: new Date("2026-07-03T12:34:56.000Z"),
    });

    assert.equal(manifest.version, "0.1.2");
    assert.equal(manifest.pub_date, "2026-07-03T12:34:56.000Z");
    assert.equal(
      manifest.platforms["windows-x86_64"].url,
      "https://github.com/Macrify-LLC/raiopdf/releases/download/v0.1.2/RaioPDF-0.1.2-windows-x64-setup.exe",
    );
  });

  it("passes the signature through unchanged", () => {
    const signature = "signature-with-newline\n";
    const manifest = buildLatestJsonManifest({
      tag: "v0.1.2",
      exeFilename: "RaioPDF-0.1.2-windows-x64-setup.exe",
      signature,
      pubDate: "2026-07-03T12:34:56.000Z",
    });

    assert.equal(manifest.platforms["windows-x86_64"].signature, signature);
  });

  it("rejects missing required inputs", () => {
    const validInput = {
      tag: "v0.1.2",
      exeFilename: "RaioPDF-0.1.2-windows-x64-setup.exe",
      signature: "trusted-signature",
      pubDate: new Date("2026-07-03T12:34:56.000Z"),
    };

    for (const key of Object.keys(validInput)) {
      assert.throws(
        () => buildLatestJsonManifest({ ...validInput, [key]: "" }),
        /is required|valid Date/,
      );
    }
  });

  it("rejects an installer filename whose version does not match the tag", () => {
    assert.throws(
      () =>
        buildLatestJsonManifest({
          tag: "v0.2.0",
          exeFilename: "RaioPDF-0.1.0-windows-x64-setup.exe",
          signature: "trusted-signature",
          pubDate: new Date("2026-07-03T12:34:56.000Z"),
        }),
      /windows-x64 updater asset must be RaioPDF-0\.2\.0-windows-x64-setup\.exe/,
    );
  });

  it("rejects non-canonical public installer filenames", () => {
    assert.throws(
      () =>
        buildLatestJsonManifest({
          tag: "v0.1.2",
          exeFilename: "RaioPDF_0.1.2_x64-setup.exe",
          signature: "trusted-signature",
          pubDate: new Date("2026-07-03T12:34:56.000Z"),
        }),
      /windows-x64 updater asset must be RaioPDF-0\.1\.2-windows-x64-setup\.exe/,
    );
  });

  it("builds the canonical public installer filename", () => {
    assert.equal(
      canonicalInstallerFilename("0.1.2"),
      "RaioPDF-0.1.2-windows-x64-setup.exe",
    );
  });

  it("builds one lockstep manifest with independent Windows and Apple Silicon assets", () => {
    const platformArtifacts = [
      {
        platformId: "windows-x64",
        filename: canonicalUpdaterFilename("0.2.0", "windows-x64"),
        signature: "windows-signature",
      },
      {
        platformId: "macos-arm64",
        filename: canonicalUpdaterFilename("0.2.0", "macos-arm64"),
        signature: "mac-signature",
      },
    ];
    const manifest = buildLatestJsonManifest({
      tag: "v0.2.0",
      platformArtifacts,
      pubDate: "2026-07-15T12:00:00.000Z",
    });

    assert.equal(manifest.version, "0.2.0");
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "windows-x86_64",
    ]);
    assert.equal(
      manifest.platforms["darwin-aarch64"].url,
      "https://github.com/Macrify-LLC/raiopdf/releases/download/v0.2.0/RaioPDF-0.2.0-macos-arm64.app.tar.gz",
    );
    assert.doesNotThrow(() =>
      validateLatestJsonManifest(manifest, { tag: "v0.2.0", platformArtifacts }),
    );
    manifest.platforms["darwin-aarch64"].signature = "tampered";
    assert.throws(
      () => validateLatestJsonManifest(manifest, { tag: "v0.2.0", platformArtifacts }),
      /signature does not match the staged updater \.sig/,
    );
  });

  it("rejects mixed versions and unexpected updater platform entries", () => {
    assert.throws(
      () =>
        buildLatestJsonManifest({
          tag: "v0.2.0",
          platformArtifacts: [
            {
              platformId: "macos-arm64",
              filename: "RaioPDF-0.1.9-macos-arm64.app.tar.gz",
              signature: "mac-signature",
            },
          ],
          pubDate: "2026-07-15T12:00:00.000Z",
        }),
      /must be RaioPDF-0\.2\.0-macos-arm64\.app\.tar\.gz/,
    );

    const manifest = buildLatestJsonManifest({
      tag: "v0.2.0",
      platformArtifacts: [
        {
          platformId: "windows-x64",
          filename: "RaioPDF-0.2.0-windows-x64-setup.exe",
          signature: "windows-signature",
        },
      ],
      pubDate: "2026-07-15T12:00:00.000Z",
    });
    manifest.platforms["darwin-aarch64"] = {
      signature: "unexpected",
      url: "https://example.invalid/unexpected",
    };
    assert.throws(
      () =>
        validateLatestJsonManifest(manifest, {
          tag: "v0.2.0",
          exeFilename: "RaioPDF-0.2.0-windows-x64-setup.exe",
        }),
      /platform keys darwin-aarch64, windows-x86_64 do not match expected windows-x86_64/,
    );
  });

  it("discovers updater artifacts only inside their platform-specific stage", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-updater-stages-"));
    try {
      const windowsDir = path.join(root, "windows-x64");
      const macDir = path.join(root, "macos-arm64");
      mkdirSync(windowsDir);
      mkdirSync(macDir);
      const windows = "RaioPDF-0.2.0-windows-x64-setup.exe";
      const mac = "RaioPDF-0.2.0-macos-arm64.app.tar.gz";
      writeFileSync(path.join(windowsDir, windows), "windows");
      writeFileSync(path.join(windowsDir, `${windows}.sig`), "windows-signature\n");
      writeFileSync(path.join(macDir, mac), "mac");
      writeFileSync(path.join(macDir, `${mac}.sig`), "mac-signature\n");

      assert.deepEqual(findStagedUpdaterArtifacts(root), [
        { platformId: "windows-x64", filename: windows, signature: "windows-signature" },
        { platformId: "macos-arm64", filename: mac, signature: "mac-signature" },
      ]);
      assert.deepEqual(findStagedUpdaterArtifacts(root, ["macos-arm64"]), [
        { platformId: "macos-arm64", filename: mac, signature: "mac-signature" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes semver prerelease tags from stable versions", () => {
    assert.equal(isPrereleaseTag("v0.2.0-beta.1"), true);
    assert.equal(isPrereleaseTag("v0.2.0-rc.1"), true);
    assert.equal(isPrereleaseTag("v0.2.0"), false);
    assert.equal(isSemverPrereleaseVersion("0.2.0+build.5"), false);
  });
});

describe("source installer version enforcement", () => {
  it("reads the version from raw Tauri NSIS output and canonical asset names", () => {
    assert.equal(sourceInstallerVersion("RaioPDF_0.1.2_x64-setup.exe"), "0.1.2");
    assert.equal(sourceInstallerVersion("RaioPDF-0.1.2-windows-x64-setup.exe"), "0.1.2");
    assert.equal(
      sourceInstallerVersion("RaioPDF_0.2.0-beta.1_x64-setup.exe"),
      "0.2.0-beta.1",
    );
  });

  it("rejects filenames that carry no readable version", () => {
    assert.throws(
      () => sourceInstallerVersion("RaioPDF-setup.exe"),
      /could not read a version/,
    );
  });

  it("accepts a source installer whose version matches the tag", () => {
    assert.doesNotThrow(() =>
      assertSourceInstallerMatchesTag("RaioPDF_0.1.2_x64-setup.exe", "0.1.2"),
    );
  });

  it("hard-fails on a stale installer from a previous version", () => {
    // The exact failure mode this guard exists for: a stale build dir under a
    // new tag would publish the OLD installer's signature at the NEW tag's
    // canonical URL and break auto-update signature verification fleet-wide.
    assert.throws(
      () => assertSourceInstallerMatchesTag("RaioPDF_0.1.1_x64-setup.exe", "0.1.2"),
      /is version 0\.1\.1, not tag version 0\.1\.2[\s\S]*stale build/,
    );
  });

  it("allows a mismatch only behind the explicit escape hatch", () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      assert.doesNotThrow(() =>
        assertSourceInstallerMatchesTag("RaioPDF_0.1.1_x64-setup.exe", "0.1.2", {
          allowVersionMismatch: true,
        }),
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /--allow-version-mismatch/);
  });
});
