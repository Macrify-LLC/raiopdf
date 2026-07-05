import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLatestJsonManifest, canonicalInstallerFilename } from "./generate-latest-json.mjs";

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
});
