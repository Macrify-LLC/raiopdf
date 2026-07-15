import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  validateInstallerSize,
  validatePayloadSize,
  validatePackageBoundary,
  expectedPlatformReleaseAssets,
  validatePlatformReleaseStage,
} from "./validate-package-boundary.mjs";

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

describe("platform package boundary", () => {
  it("accepts Windows files and rejects foreign names and Mach-O bytes", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "RaioPDF.exe"), peHeader(0x8664));
      assert.equal(
        validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }).fileCount,
        1,
      );

      mkdirSync(path.join(root, "ocr", "gs"), { recursive: true });
      writeFileSync(path.join(root, "ocr", "gs", "vcredist_x64.exe"), peHeader(0x014c));
      assert.equal(
        validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }).fileCount,
        2,
      );

      writeFileSync(path.join(root, "unapproved-x86.exe"), peHeader(0x014c));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }),
        /contains x86 PE binary unapproved-x86\.exe/,
      );
      rmSync(path.join(root, "unapproved-x86.exe"));

      writeFileSync(path.join(root, "RaioPDF_1.2.3_x64-setup.exe"), peHeader(0x014c));
      writeFileSync(
        path.join(root, "RaioPDF-1.2.3-windows-x64-setup.exe"),
        peHeader(0x014c),
      );
      assert.doesNotThrow(() =>
        validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }),
      );

      writeFileSync(path.join(root, "hidden-native"), machOHeader(0x0100000c));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }),
        /contains Mach-O binary hidden-native/,
      );
      rmSync(path.join(root, "hidden-native"));

      writeFileSync(path.join(root, "hidden-linux"), elfHeader(0x3e));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }),
        /contains Linux ELF binary hidden-linux/,
      );
      rmSync(path.join(root, "hidden-linux"));

      writeFileSync(path.join(root, "arm-helper"), peHeader(0xaa64));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }),
        /contains arm64 PE binary arm-helper/,
      );
      rmSync(path.join(root, "arm-helper"));

      writeFileSync(path.join(root, "accidental.dylib"), "not actually native");
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "windows-x64" }),
        /foreign marker.*accidental\.dylib/,
      );
    });
  });

  it("allows only arm64 thin Mach-O binaries in a macOS arm64 package", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "raiopdf"), machOHeader(0x0100000c));
      assert.equal(
        validatePackageBoundary({ rootDir: root, platformId: "macos-arm64" }).fileCount,
        1,
      );

      writeFileSync(path.join(root, "intel-helper"), machOHeader(0x01000007));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "macos-arm64" }),
        /contains x86_64 Mach-O binary intel-helper/,
      );
      rmSync(path.join(root, "intel-helper"));

      writeFileSync(path.join(root, "universal-helper"), Buffer.from("cafebabe", "hex"));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "macos-arm64" }),
        /contains universal Mach-O binary universal-helper/,
      );
      rmSync(path.join(root, "universal-helper"));

      writeFileSync(path.join(root, "universal64-helper"), Buffer.from("cafebabf", "hex"));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "macos-arm64" }),
        /contains universal Mach-O binary universal64-helper/,
      );
      rmSync(path.join(root, "universal64-helper"));

      writeFileSync(path.join(root, "hidden-pe"), peHeader(0x8664));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "macos-arm64" }),
        /contains PE binary hidden-pe/,
      );
      rmSync(path.join(root, "hidden-pe"));

      writeFileSync(path.join(root, "hidden-linux"), elfHeader(0xb7));
      assert.throws(
        () => validatePackageBoundary({ rootDir: root, platformId: "macos-arm64" }),
        /contains Linux ELF binary hidden-linux/,
      );
    });
  });
});

describe("installer size baseline", () => {
  it("accepts packages inside the allowance and rejects unexplained growth", () => {
    withTempDir((root) => {
      const installerPath = path.join(root, "installer.bin");
      writeFileSync(installerPath, Buffer.alloc(106));
      const baselines = sizePolicy(100, 10, 10);

      const result = validateInstallerSize({
        installerPath,
        platformId: "windows-x64",
        baselines,
      });
      assert.equal(result.maximumBytes, 110);
      assert.equal(result.growthOverride, false);

      writeFileSync(installerPath, Buffer.alloc(111));
      assert.throws(
        () =>
          validateInstallerSize({
            installerPath,
            platformId: "windows-x64",
            baselines,
          }),
        /above the 110-byte limit/,
      );
      assert.doesNotThrow(() =>
        validateInstallerSize({
          installerPath,
          platformId: "windows-x64",
          baselines,
          allowGrowth: true,
          growthReason: "Bundled a reviewed security update to the PDF engine.",
        }),
      );
    });
  });

  it("requires a committed baseline before the first macOS release", () => {
    withTempDir((root) => {
      const installerPath = path.join(root, "RaioPDF.dmg");
      writeFileSync(installerPath, "dmg");
      assert.throws(
        () =>
          validateInstallerSize({
            installerPath,
            platformId: "macos-arm64",
            baselines: sizePolicy(100, 10, 10),
          }),
        /has no installer size baseline/,
      );
    });
  });

  it("checks total unpacked payload bytes independently from installer compression", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "engine.bin"), Buffer.alloc(70));
      writeFileSync(path.join(root, "runtime.bin"), Buffer.alloc(36));
      const baselines = sizePolicy(100, 10, 10);

      const result = validatePayloadSize({
        payloadRoot: root,
        platformId: "windows-x64",
        baselines,
      });
      assert.equal(result.actualBytes, 106);
      assert.equal(result.maximumBytes, 110);

      writeFileSync(path.join(root, "runtime.bin"), Buffer.alloc(41));
      assert.throws(
        () => validatePayloadSize({ payloadRoot: root, platformId: "windows-x64", baselines }),
        /unpacked payload is 111 bytes, above the 110-byte limit/,
      );
    });
  });
});

describe("strict platform release stage", () => {
  it("validates a complete isolated Mac stage and rejects extra or foreign assets", () => {
    withTempDir((root) => {
      const stageDir = path.join(root, "stage");
      const payloadRoot = path.join(root, "payload");
      mkdirSync(stageDir);
      mkdirSync(payloadRoot);
      writeFileSync(path.join(payloadRoot, "runtime.dat"), "arm64 payload");
      const version = "0.2.0";
      const names = expectedPlatformReleaseAssets({
        platformId: "macos-arm64",
        version,
        ghostscriptVersion: "10.07.1",
      });
      assert(names.includes("RaioPDF-0.2.0-macos-arm64-component-manifest.json"));
      assert(names.includes("ghostscript-10.07.1-macos-arm64-source.tar.xz"));
      assert(names.includes("SHA256SUMS-macos-arm64.txt"));
      assert.equal(names.includes("RaioPDF-0.2.0-component-manifest.json"), false);
      for (const name of names.filter((entry) => entry !== "SHA256SUMS.txt")) {
        writeFileSync(path.join(stageDir, name), `bytes:${name}`);
      }
      const updater = `RaioPDF-${version}-macos-arm64.app.tar.gz`;
      writeFileSync(path.join(stageDir, updater), "test");
      writeFileSync(path.join(stageDir, `${updater}.sig`), `${TEST_TAURI_SIGNATURE}\n`);
      writeChecksums(stageDir, names);
      const baselines = {
        schemaVersion: 1,
        platforms: {
          "macos-arm64": {
            installer: {
              baselineVersion: "test",
              baselineBytes: 1024,
              maxGrowthBytes: 100,
              maxGrowthPercent: 10,
            },
            payload: {
              baselineVersion: "test",
              baselineBytes: 1024,
              maxGrowthBytes: 100,
              maxGrowthPercent: 10,
            },
          },
        },
      };

      assert.doesNotThrow(() =>
        validatePlatformReleaseStage({
          rootDir: stageDir,
          platformId: "macos-arm64",
          version,
          ghostscriptVersion: "10.07.1",
          baselines,
          updaterPubkey: TEST_UPDATER_PUBKEY,
          payloadRoot,
        }),
      );

      writeFileSync(path.join(stageDir, "notes.txt"), "unexpected");
      assert.throws(
        () =>
          validatePlatformReleaseStage({
            rootDir: stageDir,
            platformId: "macos-arm64",
            version,
            ghostscriptVersion: "10.07.1",
            baselines,
            updaterPubkey: TEST_UPDATER_PUBKEY,
            payloadRoot,
          }),
        /unexpected: notes\.txt/,
      );
      rmSync(path.join(stageDir, "notes.txt"));

      writeFileSync(path.join(stageDir, "smuggled.exe"), peHeader(0x8664));
      assert.throws(
        () =>
          validatePlatformReleaseStage({
            rootDir: stageDir,
            platformId: "macos-arm64",
            version,
            ghostscriptVersion: "10.07.1",
            baselines,
            updaterPubkey: TEST_UPDATER_PUBKEY,
            payloadRoot,
          }),
        /foreign marker.*smuggled\.exe/,
      );
    });
  });
});

function machOHeader(cpuType) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

function elfHeader(machine) {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function peHeader(machine) {
  const bytes = Buffer.alloc(0x86);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

function sizePolicy(baselineBytes, maxGrowthBytes, maxGrowthPercent) {
  return {
    schemaVersion: 1,
    platforms: {
      "windows-x64": {
        installer: {
          baselineVersion: "test",
          baselineBytes,
          maxGrowthBytes,
          maxGrowthPercent,
        },
        payload: {
          baselineVersion: "test",
          baselineBytes,
          maxGrowthBytes,
          maxGrowthPercent,
        },
      },
      "macos-arm64": { installer: null },
    },
  };
}

function writeChecksums(root, names) {
  const checksumsName = names.find((name) => name.startsWith("SHA256SUMS"));
  const lines = names
    .filter((name) => name !== checksumsName)
    .map((name) =>
      `${createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")}  ${name}`,
    );
  writeFileSync(path.join(root, checksumsName), `${lines.join("\n")}\n`);
}

function withTempDir(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-platform-boundary-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
