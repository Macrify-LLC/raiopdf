import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { verifyMinisignSignature } from "./minisign.mjs";
import { prepareSignedReleaseAssets } from "./prepare-signed-release-assets.mjs";
import {
  validateGitHubLatestRelease,
  validateGitHubReleaseState,
  validateReleaseAssets,
} from "./validate-release-assets.mjs";

const TEST_PUBLIC_KEY_TEXT = [
  "untrusted comment: minisign public key E7620F1842B4E81F",
  "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
].join("\n");
const TEST_UPDATER_PUBKEY = Buffer.from(TEST_PUBLIC_KEY_TEXT, "utf8").toString("base64");
const TEST_PREHASHED_SIGNATURE_TEXT = [
  "untrusted comment: signature from minisign secret key",
  "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
  "trusted comment: timestamp:1556193335\tfile:test",
  "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
].join("\n");
const TEST_TAURI_SIGNATURE = Buffer.from(TEST_PREHASHED_SIGNATURE_TEXT, "utf8").toString("base64");

describe("signed release asset preparation", () => {
  it("rejects GitHub release states the updater latest endpoint cannot discover", () => {
    assert.doesNotThrow(() =>
      validateGitHubReleaseState({ tagName: "v0.1.2", isDraft: false, isPrerelease: false }),
    );
    assert.throws(
      () => validateGitHubReleaseState({ tagName: "v0.1.2", isDraft: true, isPrerelease: false }),
      /still a draft/,
    );
    assert.throws(
      () => validateGitHubReleaseState({ tagName: "v0.1.2", isDraft: false, isPrerelease: true }),
      /GitHub prerelease/,
    );
  });

  it("rejects a valid release tag when GitHub latest points elsewhere", () => {
    assert.doesNotThrow(() =>
      validateGitHubLatestRelease("v0.1.2", { tagName: "v0.1.2", isDraft: false, isPrerelease: false }),
    );
    assert.throws(
      () => validateGitHubLatestRelease("v0.1.2", { tagName: "v0.1.1", isDraft: false, isPrerelease: false }),
      /\/releases\/latest resolves to v0\.1\.1/,
    );
  });

  it("verifies minisign updater signatures the same way Tauri does", () => {
    assert.equal(
      verifyMinisignSignature(Buffer.from("test"), TEST_PREHASHED_SIGNATURE_TEXT, TEST_PUBLIC_KEY_TEXT),
      true,
    );
    assert.throws(
      () => verifyMinisignSignature(Buffer.from("Test"), TEST_PREHASHED_SIGNATURE_TEXT, TEST_PUBLIC_KEY_TEXT),
      /does not match installer bytes/,
    );
  });

  it("stages canonical installer, signature, updater manifest, and checksum", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-release-assets-"));
    try {
      const nsisDir = path.join(root, "nsis");
      const outDir = path.join(root, "signed");
      const payloadDir = path.join(root, "payload");
      const legalDir = path.join(payloadDir, "legal");
      const sourceOffersDir = path.join(legalDir, "source-offers");
      const pinsPath = path.join(root, "PINS.env");
      const ghostscriptSource = path.join(root, "ghostscript-source.tar.xz");
      const installer = path.join(nsisDir, "RaioPDF_0.1.2_x64-setup.exe");
      const signature = `${installer}.sig`;
      const ghostscriptSourceBytes = "fake ghostscript source archive";
      const ghostscriptSourceSha = sha256Text(ghostscriptSourceBytes);

      mkdirSync(nsisDir, { recursive: true });
      mkdirSync(sourceOffersDir, { recursive: true });
      writeFileSync(installer, "test");
      writeFileSync(signature, `${TEST_TAURI_SIGNATURE}\n`);
      writeFileSync(path.join(legalDir, "THIRD-PARTY-NOTICES.txt"), "third party notices");
      writeFileSync(
        path.join(legalDir, "COMPONENT-MANIFEST.json"),
        `${JSON.stringify(
          {
            product: "RaioPDF",
            releaseVersion: "0.1.2",
            components: [
              { name: "RaioPDF", version: "0.1.2", license: "GPL-3.0-only" },
              {
                name: "Ghostscript",
                version: "10.07.1",
                license: "AGPL-3.0-only",
                source: {
                  url: "https://example.invalid/ghostscript.tar.xz",
                  sha256: ghostscriptSourceSha,
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(path.join(legalDir, "RELEASE-SOURCE-CORRESPONDENCE.md"), "# source\n");
      writeFileSync(path.join(legalDir, "RAIOPDF-LICENSE-NOTICES.txt"), "license notices");
      writeFileSync(
        path.join(sourceOffersDir, "GHOSTSCRIPT-SOURCE-OFFER.txt"),
        "ghostscript source offer",
      );
      writeFileSync(ghostscriptSource, ghostscriptSourceBytes);
      writeFileSync(
        pinsPath,
        [
          "GHOSTSCRIPT_VERSION=10.07.1",
          "GHOSTSCRIPT_SOURCE_URL=https://example.invalid/ghostscript.tar.xz",
          `GHOSTSCRIPT_SOURCE_SHA256=${ghostscriptSourceSha}`,
          "",
        ].join("\n"),
      );

      const prepared = prepareSignedReleaseAssets({
        tag: "v0.1.2",
        nsisDir,
        outDir,
        payloadDir,
        pinsPath,
        ghostscriptSource,
        skipAuthenticode: true,
        skipLegalCheck: true,
        updaterPubkey: TEST_UPDATER_PUBKEY,
      });
      assert.deepEqual(prepared.assetNames, [
        "RaioPDF-0.1.2-windows-x64-setup.exe",
        "RaioPDF-0.1.2-windows-x64-setup.exe.sig",
        "RaioPDF-0.1.2-third-party-notices.txt",
        "RaioPDF-0.1.2-component-manifest.json",
        "RaioPDF-0.1.2-source-correspondence.md",
        "RaioPDF-0.1.2-license-notices.txt",
        "RaioPDF-0.1.2-ghostscript-source-offer.txt",
        "ghostscript-10.07.1-source.tar.xz",
        "latest.json",
        "SHA256SUMS.txt",
      ]);

      const validated = validateReleaseAssets({
        tag: "v0.1.2",
        dir: outDir,
        pinsPath,
        skipAuthenticode: true,
        updaterPubkey: TEST_UPDATER_PUBKEY,
      });
      assert.deepEqual(validated.localNames, [
        "RaioPDF-0.1.2-windows-x64-setup.exe",
        "RaioPDF-0.1.2-windows-x64-setup.exe.sig",
        "RaioPDF-0.1.2-third-party-notices.txt",
        "RaioPDF-0.1.2-component-manifest.json",
        "RaioPDF-0.1.2-source-correspondence.md",
        "RaioPDF-0.1.2-license-notices.txt",
        "RaioPDF-0.1.2-ghostscript-source-offer.txt",
        "ghostscript-10.07.1-source.tar.xz",
        "latest.json",
        "SHA256SUMS.txt",
      ].sort((a, b) => a.localeCompare(b)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
