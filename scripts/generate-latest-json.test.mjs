import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertSourceInstallerMatchesTag,
  buildLatestJsonManifest,
  canonicalInstallerFilename,
  isPrereleaseTag,
  isSemverPrereleaseVersion,
  sourceInstallerVersion,
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
      /installer version "0\.1\.0" does not match release tag version "0\.2\.0"/,
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
      /canonical public filename/,
    );
  });

  it("builds the canonical public installer filename", () => {
    assert.equal(
      canonicalInstallerFilename("0.1.2"),
      "RaioPDF-0.1.2-windows-x64-setup.exe",
    );
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
