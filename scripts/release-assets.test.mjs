import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { verifyMinisignSignature } from "./minisign.mjs";
import { validatePlatformReleaseStage } from "./validate-package-boundary.mjs";
import {
  combineSignedReleaseAssets,
  prepareSignedReleaseAssets,
} from "./prepare-signed-release-assets.mjs";
import {
  validateGitHubLatestRelease,
  validateGitHubReleaseState,
  validatePublicAssetNames,
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
    assert.doesNotThrow(() =>
      validateGitHubReleaseState(
        { tagName: "v0.2.0-beta.1", isDraft: false, isPrerelease: true },
        { expectedPrerelease: true },
      ),
    );
    assert.throws(
      () =>
        validateGitHubReleaseState(
          { tagName: "v0.2.0-beta.1", isDraft: false, isPrerelease: false },
          { expectedPrerelease: true },
        ),
      /must be marked as a GitHub prerelease/,
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

  it("accepts only the legacy Windows set or the complete combined public set", () => {
    const version = "0.2.0";
    const pins = { GHOSTSCRIPT_VERSION: "10.07.1" };
    const windows = [
      `RaioPDF-${version}-windows-x64-setup.exe`,
      `RaioPDF-${version}-windows-x64-setup.exe.sig`,
      `RaioPDF-${version}-third-party-notices.txt`,
      `RaioPDF-${version}-component-manifest.json`,
      `RaioPDF-${version}-source-correspondence.md`,
      `RaioPDF-${version}-license-notices.txt`,
      `RaioPDF-${version}-ghostscript-source-offer.txt`,
      "ghostscript-10.07.1-source.tar.xz",
      "latest.json",
      "SHA256SUMS.txt",
    ];
    const mac = [
      `RaioPDF-${version}-macos-arm64.dmg`,
      `RaioPDF-${version}-macos-arm64.app.tar.gz`,
      `RaioPDF-${version}-macos-arm64.app.tar.gz.sig`,
      `RaioPDF-${version}-macos-arm64-third-party-notices.txt`,
      `RaioPDF-${version}-macos-arm64-component-manifest.json`,
      `RaioPDF-${version}-macos-arm64-source-correspondence.md`,
      `RaioPDF-${version}-macos-arm64-license-notices.txt`,
      `RaioPDF-${version}-macos-arm64-ghostscript-source-offer.txt`,
      "ghostscript-10.08.0-macos-arm64-source.tar.xz",
      "SHA256SUMS-macos-arm64.txt",
    ];

    assert.deepEqual(validatePublicAssetNames(windows, version, pins), { includesMac: false });
    assert.deepEqual(
      validatePublicAssetNames([...windows, ...mac], version, pins, { allowMac: true }),
      { includesMac: true, macGhostscriptVersion: "10.08.0" },
    );
    assert.throws(
      () => validatePublicAssetNames([...windows, ...mac.slice(1)], version, pins, { allowMac: true }),
      /missing required assets/,
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
        skipPayloadSize: true,
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

      const platformOnly = prepareSignedReleaseAssets({
        tag: "v0.1.2",
        nsisDir,
        outDir,
        payloadDir,
        pinsPath,
        ghostscriptSource,
        skipAuthenticode: true,
        skipLegalCheck: true,
        updaterPubkey: TEST_UPDATER_PUBKEY,
        platformStageOnly: true,
      });
      assert.equal(platformOnly.assetNames.includes("latest.json"), false);
      assert.equal(existsSync(path.join(outDir, "latest.json")), false);
      assert.doesNotMatch(readFileSync(path.join(outDir, "SHA256SUMS.txt"), "utf8"), /latest\.json/);
      assert.doesNotThrow(() =>
        validatePlatformReleaseStage({
          rootDir: outDir,
          platformId: "windows-x64",
          version: "0.1.2",
          ghostscriptVersion: "10.07.1",
          updaterPubkey: TEST_UPDATER_PUBKEY,
          payloadRoot: payloadDir,
          baselines: {
            schemaVersion: 1,
            platforms: {
              "windows-x64": {
                installer: {
                  baselineVersion: "test",
                  baselineBytes: 1024,
                  maxGrowthBytes: 100,
                  maxGrowthPercent: 10,
                },
                payload: {
                  baselineVersion: "test",
                  baselineBytes: 1024 * 1024,
                  maxGrowthBytes: 1024,
                  maxGrowthPercent: 10,
                },
              },
            },
          },
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a semver prerelease tag with the same signed asset set", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-preview-release-assets-"));
    try {
      const { outDir, pinsPath } = writeValidatedReleaseAssets({
        root,
        tag: "v0.2.0-beta.1",
        version: "0.2.0-beta.1",
      });

      const validated = validateReleaseAssets({
        tag: "v0.2.0-beta.1",
        dir: outDir,
        pinsPath,
        skipAuthenticode: true,
        skipUpdaterSignature: true,
        skipPayloadSize: true,
      });

      assert.equal(validated.version, "0.2.0-beta.1");
      assert(validated.localNames.includes("RaioPDF-0.2.0-beta.1-windows-x64-setup.exe"));
      assert(validated.localNames.includes("latest.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults to the workspace NSIS bundle and built payload legal assets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-release-defaults-"));
    try {
      const workspaceNsisDir = path.join(root, "target", "release", "bundle", "nsis");
      const shellNsisDir = path.join(root, "apps", "shell", "src-tauri", "target", "release", "bundle", "nsis");
      const builtRoot = path.join(root, "target", "release");
      const shellBuildRoot = path.join(root, "apps", "shell", "src-tauri", "target", "release");
      const builtLegalDir = path.join(builtRoot, "resources", "payload", "legal");
      const sourcePayloadRoot = path.join(root, "apps", "shell", "src-tauri", "payload");
      const sourceLegalDir = path.join(sourcePayloadRoot, "legal");
      const outDir = path.join(root, "signed");
      const pinsPath = path.join(root, "PINS.env");
      const ghostscriptSource = path.join(root, "ghostscript-source.tar.xz");
      const installer = path.join(workspaceNsisDir, "RaioPDF_0.1.2_x64-setup.exe");
      const signature = `${installer}.sig`;
      const ghostscriptSourceBytes = "fake ghostscript source archive";
      const ghostscriptSourceSha = sha256Text(ghostscriptSourceBytes);

      mkdirSync(workspaceNsisDir, { recursive: true });
      mkdirSync(shellNsisDir, { recursive: true });
      writeFileSync(installer, "test");
      writeFileSync(signature, `${TEST_TAURI_SIGNATURE}\n`);
      writeLegalPayload({
        legalDir: builtLegalDir,
        version: "0.1.2",
        ghostscriptSourceSha,
        thirdPartyNotices: "built third party notices",
      });
      writeLegalPayload({
        legalDir: sourceLegalDir,
        version: "0.1.2",
        ghostscriptSourceSha,
        thirdPartyNotices: "source third party notices",
      });
      writeFileSync(ghostscriptSource, ghostscriptSourceBytes);
      writePins(pinsPath, ghostscriptSourceSha);

      const prepared = prepareSignedReleaseAssets({
        tag: "v0.1.2",
        nsisSearchDirs: [workspaceNsisDir, shellNsisDir],
        builtPayloadSearchRoots: [builtRoot, shellBuildRoot],
        sourcePayloadSearchRoots: [sourcePayloadRoot],
        outDir,
        pinsPath,
        ghostscriptSource,
        skipAuthenticode: true,
        skipLegalCheck: true,
        updaterPubkey: TEST_UPDATER_PUBKEY,
      });

      assert.equal(prepared.nsisDir, workspaceNsisDir);
      assert.equal(prepared.legalDir, builtLegalDir);
      assert.equal(
        readFileSync(path.join(outDir, "RaioPDF-0.1.2-third-party-notices.txt"), "utf8"),
        "built third party notices",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown staging platform", () => {
    assert.throws(
      () => prepareSignedReleaseAssets({ tag: "v0.1.2", platform: "linux-x64" }),
      /unsupported --platform "linux-x64"/,
    );
  });
});

describe("macOS release asset staging", () => {
  const MAC_ASSET_NAMES = [
    "RaioPDF-0.1.2-macos-arm64.dmg",
    "RaioPDF-0.1.2-macos-arm64.app.tar.gz",
    "RaioPDF-0.1.2-macos-arm64.app.tar.gz.sig",
    "RaioPDF-0.1.2-macos-arm64-third-party-notices.txt",
    "RaioPDF-0.1.2-macos-arm64-component-manifest.json",
    "RaioPDF-0.1.2-macos-arm64-source-correspondence.md",
    "RaioPDF-0.1.2-macos-arm64-license-notices.txt",
    "RaioPDF-0.1.2-macos-arm64-ghostscript-source-offer.txt",
    "ghostscript-10.07.1-macos-arm64-source.tar.xz",
    "SHA256SUMS-macos-arm64.txt",
  ];

  it("stages canonical macOS names and checksums the platform validator accepts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-mac-release-assets-"));
    try {
      const outDir = path.join(root, "signed", "macos-arm64");
      const { prepared, payloadDir } = stageMacFixture({
        root: path.join(root, "mac"),
        tag: "v0.1.2",
        version: "0.1.2",
        outDir,
      });

      assert.deepEqual(prepared.assetNames, MAC_ASSET_NAMES);
      assert.equal(
        readFileSync(path.join(outDir, "RaioPDF-0.1.2-macos-arm64.dmg"), "utf8"),
        "fake signed dmg bytes",
      );
      assert.equal(
        readFileSync(path.join(outDir, "RaioPDF-0.1.2-macos-arm64.app.tar.gz"), "utf8"),
        "test",
      );
      assert.equal(
        readFileSync(path.join(outDir, "RaioPDF-0.1.2-macos-arm64.app.tar.gz.sig"), "utf8").trim(),
        TEST_TAURI_SIGNATURE,
      );
      assert.equal(existsSync(path.join(outDir, "latest.json")), false);

      const checksumLines = readFileSync(path.join(outDir, "SHA256SUMS-macos-arm64.txt"), "utf8")
        .trim()
        .split("\n");
      const hashed = MAC_ASSET_NAMES.filter((name) => name !== "SHA256SUMS-macos-arm64.txt");
      assert.deepEqual(
        checksumLines,
        hashed
          .sort((a, b) => a.localeCompare(b))
          .map((name) => `${sha256File(path.join(outDir, name))}  ${name}`),
      );

      assert.doesNotThrow(() =>
        validatePlatformReleaseStage({
          rootDir: outDir,
          platformId: "macos-arm64",
          version: "0.1.2",
          ghostscriptVersion: "10.07.1",
          updaterPubkey: TEST_UPDATER_PUBKEY,
          payloadRoot: payloadDir,
          baselines: testBaselines("macos-arm64"),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a missing updater signature or a stale DMG version", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-mac-release-negative-"));
    try {
      const missingSig = writeMacBuildFixture({ root: path.join(root, "no-sig"), version: "0.1.2" });
      rmSync(path.join(missingSig.macosDir, "RaioPDF.app.tar.gz.sig"));
      assert.throws(
        () =>
          prepareSignedReleaseAssets({
            tag: "v0.1.2",
            platform: "macos-arm64",
            dmgSearchDirs: [missingSig.dmgDir],
            updaterSearchDirs: [missingSig.macosDir],
            outDir: path.join(root, "no-sig-out"),
            payloadDir: missingSig.payloadDir,
            pinsPath: missingSig.pinsPath,
            ghostscriptSource: missingSig.ghostscriptSource,
            skipAuthenticode: true,
            skipLegalCheck: true,
            updaterPubkey: TEST_UPDATER_PUBKEY,
          }),
        /missing updater signature/,
      );

      const staleDmg = writeMacBuildFixture({ root: path.join(root, "stale"), version: "0.1.2" });
      rmSync(path.join(staleDmg.dmgDir, "RaioPDF_0.1.2_aarch64.dmg"));
      writeFileSync(path.join(staleDmg.dmgDir, "RaioPDF_0.1.3_aarch64.dmg"), "stale dmg bytes");
      assert.throws(
        () =>
          prepareSignedReleaseAssets({
            tag: "v0.1.2",
            platform: "macos-arm64",
            dmgSearchDirs: [staleDmg.dmgDir],
            updaterSearchDirs: [staleDmg.macosDir],
            outDir: path.join(root, "stale-out"),
            payloadDir: staleDmg.payloadDir,
            pinsPath: staleDmg.pinsPath,
            ghostscriptSource: staleDmg.ghostscriptSource,
            skipAuthenticode: true,
            skipLegalCheck: true,
            updaterPubkey: TEST_UPDATER_PUBKEY,
          }),
        /is version 0\.1\.3, not 0\.1\.2/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cross-platform combine", () => {
  it("writes the shared latest.json and release-wide SHA256SUMS.txt from complete stages", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-combine-release-assets-"));
    try {
      const stageRoot = path.join(root, "signed");
      const windows = stageWindowsFixture({
        root: path.join(root, "win"),
        tag: "v0.1.2",
        version: "0.1.2",
        outDir: path.join(stageRoot, "windows-x64"),
        platformStageOnly: true,
      });
      stageMacFixture({
        root: path.join(root, "mac"),
        tag: "v0.1.2",
        version: "0.1.2",
        outDir: path.join(stageRoot, "macos-arm64"),
      });

      const combined = combineSignedReleaseAssets({
        tag: "v0.1.2",
        stageRoot,
        updaterPubkey: TEST_UPDATER_PUBKEY,
      });

      assert.equal(combined.version, "0.1.2");
      const manifest = JSON.parse(readFileSync(combined.latestJsonPath, "utf8"));
      assert.equal(manifest.version, "0.1.2");
      assert.deepEqual(Object.keys(manifest.platforms).sort(), [
        "darwin-aarch64",
        "windows-x86_64",
      ]);
      assert.equal(
        manifest.platforms["windows-x86_64"].url,
        "https://github.com/Macrify-LLC/raiopdf/releases/download/v0.1.2/RaioPDF-0.1.2-windows-x64-setup.exe",
      );
      assert.equal(
        manifest.platforms["darwin-aarch64"].url,
        "https://github.com/Macrify-LLC/raiopdf/releases/download/v0.1.2/RaioPDF-0.1.2-macos-arm64.app.tar.gz",
      );
      assert.equal(manifest.platforms["windows-x86_64"].signature, TEST_TAURI_SIGNATURE);
      assert.equal(manifest.platforms["darwin-aarch64"].signature, TEST_TAURI_SIGNATURE);

      const rootChecksums = new Map(
        readFileSync(combined.sha256SumsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const [hash, name] = line.split(/\s{2}/);
            return [name, hash];
          }),
      );
      const expectedRootNames = [
        "RaioPDF-0.1.2-windows-x64-setup.exe",
        "RaioPDF-0.1.2-windows-x64-setup.exe.sig",
        "RaioPDF-0.1.2-third-party-notices.txt",
        "RaioPDF-0.1.2-component-manifest.json",
        "RaioPDF-0.1.2-source-correspondence.md",
        "RaioPDF-0.1.2-license-notices.txt",
        "RaioPDF-0.1.2-ghostscript-source-offer.txt",
        "ghostscript-10.07.1-source.tar.xz",
        "latest.json",
      ].sort((a, b) => a.localeCompare(b));
      assert.deepEqual([...rootChecksums.keys()], expectedRootNames);
      assert.equal(rootChecksums.get("latest.json"), sha256File(combined.latestJsonPath));
      assert.equal(
        rootChecksums.get("RaioPDF-0.1.2-windows-x64-setup.exe"),
        sha256File(path.join(stageRoot, "windows-x64", "RaioPDF-0.1.2-windows-x64-setup.exe")),
      );

      const uploadNames = combined.uploadPlan.map((filePath) => path.basename(filePath));
      assert.equal(
        combined.uploadPlan.includes(path.join(stageRoot, "windows-x64", "SHA256SUMS.txt")),
        false,
      );
      assert.equal(combined.uploadPlan.includes(combined.sha256SumsPath), true);
      assert.equal(combined.uploadPlan.includes(combined.latestJsonPath), true);
      assert.equal(uploadNames.includes("SHA256SUMS-macos-arm64.txt"), true);
      assert.equal(
        new Set(uploadNames).size,
        combined.uploadPlan.length,
        "upload plan must not contain colliding asset names",
      );

      // The exact public asset name set the release validator accepts for a
      // combined Windows + macOS release.
      assert.deepEqual(
        validatePublicAssetNames(
          uploadNames,
          "0.1.2",
          { GHOSTSCRIPT_VERSION: "10.07.1" },
          { allowMac: true },
        ),
        { includesMac: true, macGhostscriptVersion: "10.07.1" },
      );

      // Windows stage stays platform-stage-only and valid on its own.
      assert.doesNotThrow(() =>
        validatePlatformReleaseStage({
          rootDir: path.join(stageRoot, "windows-x64"),
          platformId: "windows-x64",
          version: "0.1.2",
          ghostscriptVersion: "10.07.1",
          updaterPubkey: TEST_UPDATER_PUBKEY,
          payloadRoot: windows.payloadDir,
          baselines: testBaselines("windows-x64"),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to combine when a platform stage is missing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-combine-missing-"));
    try {
      const stageRoot = path.join(root, "signed");
      stageWindowsFixture({
        root: path.join(root, "win"),
        tag: "v0.1.2",
        version: "0.1.2",
        outDir: path.join(stageRoot, "windows-x64"),
        platformStageOnly: true,
      });
      assert.throws(
        () =>
          combineSignedReleaseAssets({
            tag: "v0.1.2",
            stageRoot,
            skipUpdaterSignature: true,
          }),
        /macos-arm64 platform stage is missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to combine platform stages built from different versions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-combine-mismatch-"));
    try {
      const stageRoot = path.join(root, "signed");
      stageWindowsFixture({
        root: path.join(root, "win"),
        tag: "v0.1.2",
        version: "0.1.2",
        outDir: path.join(stageRoot, "windows-x64"),
        platformStageOnly: true,
      });
      stageMacFixture({
        root: path.join(root, "mac"),
        tag: "v0.1.3",
        version: "0.1.3",
        outDir: path.join(stageRoot, "macos-arm64"),
      });
      assert.throws(
        () =>
          combineSignedReleaseAssets({
            tag: "v0.1.2",
            stageRoot,
            skipUpdaterSignature: true,
          }),
        /macos-arm64 stage holds version 0\.1\.3/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a Windows stage that still contains its own latest.json", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-combine-latestjson-"));
    try {
      const stageRoot = path.join(root, "signed");
      stageWindowsFixture({
        root: path.join(root, "win"),
        tag: "v0.1.2",
        version: "0.1.2",
        outDir: path.join(stageRoot, "windows-x64"),
        platformStageOnly: false,
      });
      assert.throws(
        () =>
          combineSignedReleaseAssets({
            tag: "v0.1.2",
            stageRoot,
            skipUpdaterSignature: true,
          }),
        /--platform-stage-only/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writePins(pinsPath, ghostscriptSourceSha) {
  writeFileSync(
    pinsPath,
    [
      "GHOSTSCRIPT_VERSION=10.07.1",
      "GHOSTSCRIPT_SOURCE_URL=https://example.invalid/ghostscript.tar.xz",
      `GHOSTSCRIPT_SOURCE_SHA256=${ghostscriptSourceSha}`,
      "",
    ].join("\n"),
  );
}

function writeLegalPayload({ legalDir, version, ghostscriptSourceSha, thirdPartyNotices }) {
  const sourceOffersDir = path.join(legalDir, "source-offers");
  mkdirSync(sourceOffersDir, { recursive: true });
  writeFileSync(path.join(legalDir, "THIRD-PARTY-NOTICES.txt"), thirdPartyNotices);
  writeFileSync(
    path.join(legalDir, "COMPONENT-MANIFEST.json"),
    `${JSON.stringify(
      {
        product: "RaioPDF",
        releaseVersion: version,
        components: [
          { name: "RaioPDF", version, license: "GPL-3.0-only" },
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
  writeFileSync(path.join(sourceOffersDir, "GHOSTSCRIPT-SOURCE-OFFER.txt"), "ghostscript source offer");
}

function writeValidatedReleaseAssets({ root, tag, version }) {
  const outDir = path.join(root, "signed");
  const pinsPath = path.join(root, "PINS.env");
  const ghostscriptSourceBytes = "fake ghostscript source archive";
  const ghostscriptSourceSha = sha256Text(ghostscriptSourceBytes);
  const installer = `RaioPDF-${version}-windows-x64-setup.exe`;
  const signature = `${installer}.sig`;

  mkdirSync(outDir, { recursive: true });
  writePins(pinsPath, ghostscriptSourceSha);
  writeFileSync(path.join(outDir, installer), "preview installer bytes");
  writeFileSync(path.join(outDir, signature), "preview-updater-signature\n");
  writeFileSync(path.join(outDir, `RaioPDF-${version}-third-party-notices.txt`), "third party notices");
  writeFileSync(
    path.join(outDir, `RaioPDF-${version}-component-manifest.json`),
    `${JSON.stringify(
      {
        product: "RaioPDF",
        releaseVersion: version,
        components: [
          { name: "RaioPDF", version, license: "GPL-3.0-only" },
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
  writeFileSync(path.join(outDir, `RaioPDF-${version}-source-correspondence.md`), "# source\n");
  writeFileSync(path.join(outDir, `RaioPDF-${version}-license-notices.txt`), "license notices");
  writeFileSync(path.join(outDir, `RaioPDF-${version}-ghostscript-source-offer.txt`), "ghostscript source offer");
  writeFileSync(path.join(outDir, "ghostscript-10.07.1-source.tar.xz"), ghostscriptSourceBytes);
  writeFileSync(
    path.join(outDir, "latest.json"),
    `${JSON.stringify(
      {
        version,
        pub_date: "2026-07-05T00:00:00.000Z",
        platforms: {
          "windows-x86_64": {
            signature: "preview-updater-signature",
            url: `https://github.com/Macrify-LLC/raiopdf/releases/download/${tag}/${installer}`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const assetNames = [
    installer,
    signature,
    `RaioPDF-${version}-third-party-notices.txt`,
    `RaioPDF-${version}-component-manifest.json`,
    `RaioPDF-${version}-source-correspondence.md`,
    `RaioPDF-${version}-license-notices.txt`,
    `RaioPDF-${version}-ghostscript-source-offer.txt`,
    "ghostscript-10.07.1-source.tar.xz",
    "latest.json",
  ];
  writeFileSync(
    path.join(outDir, "SHA256SUMS.txt"),
    `${assetNames
      .sort((a, b) => a.localeCompare(b))
      .map((assetName) => `${sha256File(path.join(outDir, assetName))}  ${assetName}`)
      .join("\n")}\n`,
  );

  return { outDir, pinsPath };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function testBaselines(platformId) {
  return {
    schemaVersion: 1,
    platforms: {
      [platformId]: {
        installer: {
          baselineVersion: "test",
          baselineBytes: 1024,
          maxGrowthBytes: 100,
          maxGrowthPercent: 10,
        },
        payload: {
          baselineVersion: "test",
          baselineBytes: 1024 * 1024,
          maxGrowthBytes: 1024,
          maxGrowthPercent: 10,
        },
      },
    },
  };
}

function writeMacBuildFixture({ root, version }) {
  const dmgDir = path.join(root, "bundle", "dmg");
  const macosDir = path.join(root, "bundle", "macos");
  const payloadDir = path.join(root, "payload");
  const pinsPath = path.join(root, "PINS.macos.env");
  const ghostscriptSource = path.join(root, "ghostscript-source.tar.xz");
  const ghostscriptSourceBytes = "fake ghostscript source archive";
  const ghostscriptSourceSha = sha256Text(ghostscriptSourceBytes);

  mkdirSync(dmgDir, { recursive: true });
  mkdirSync(macosDir, { recursive: true });
  writeFileSync(path.join(dmgDir, `RaioPDF_${version}_aarch64.dmg`), "fake signed dmg bytes");
  // "test" matches the minisign test vector so real updater verification runs.
  writeFileSync(path.join(macosDir, "RaioPDF.app.tar.gz"), "test");
  writeFileSync(path.join(macosDir, "RaioPDF.app.tar.gz.sig"), `${TEST_TAURI_SIGNATURE}\n`);
  writeLegalPayload({
    legalDir: path.join(payloadDir, "legal"),
    version,
    ghostscriptSourceSha,
    thirdPartyNotices: "mac third party notices",
  });
  writeFileSync(ghostscriptSource, ghostscriptSourceBytes);
  writePins(pinsPath, ghostscriptSourceSha);

  return { dmgDir, macosDir, payloadDir, pinsPath, ghostscriptSource };
}

function stageMacFixture({ root, tag, version, outDir }) {
  const fixture = writeMacBuildFixture({ root, version });
  const prepared = prepareSignedReleaseAssets({
    tag,
    platform: "macos-arm64",
    dmgSearchDirs: [fixture.dmgDir],
    updaterSearchDirs: [fixture.macosDir],
    outDir,
    payloadDir: fixture.payloadDir,
    pinsPath: fixture.pinsPath,
    ghostscriptSource: fixture.ghostscriptSource,
    skipAuthenticode: true,
    skipLegalCheck: true,
    updaterPubkey: TEST_UPDATER_PUBKEY,
  });
  return { ...fixture, prepared };
}

function stageWindowsFixture({ root, tag, version, outDir, platformStageOnly = true }) {
  const nsisDir = path.join(root, "nsis");
  const payloadDir = path.join(root, "payload");
  const pinsPath = path.join(root, "PINS.env");
  const ghostscriptSource = path.join(root, "ghostscript-source.tar.xz");
  const ghostscriptSourceBytes = "fake ghostscript source archive";
  const ghostscriptSourceSha = sha256Text(ghostscriptSourceBytes);

  mkdirSync(nsisDir, { recursive: true });
  // "test" matches the minisign test vector so real updater verification runs.
  writeFileSync(path.join(nsisDir, `RaioPDF_${version}_x64-setup.exe`), "test");
  writeFileSync(path.join(nsisDir, `RaioPDF_${version}_x64-setup.exe.sig`), `${TEST_TAURI_SIGNATURE}\n`);
  writeLegalPayload({
    legalDir: path.join(payloadDir, "legal"),
    version,
    ghostscriptSourceSha,
    thirdPartyNotices: "win third party notices",
  });
  writeFileSync(ghostscriptSource, ghostscriptSourceBytes);
  writePins(pinsPath, ghostscriptSourceSha);

  const prepared = prepareSignedReleaseAssets({
    tag,
    platform: "windows-x64",
    nsisDir,
    outDir,
    payloadDir,
    pinsPath,
    ghostscriptSource,
    skipAuthenticode: true,
    skipLegalCheck: true,
    updaterPubkey: TEST_UPDATER_PUBKEY,
    platformStageOnly,
  });
  return { nsisDir, payloadDir, pinsPath, prepared };
}
