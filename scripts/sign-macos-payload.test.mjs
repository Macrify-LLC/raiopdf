import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildBatches,
  buildSigningPlan,
  classifyMachO,
  entitlementClassFor,
  entitlementsFileFor,
  expectedTeamIdFrom,
  parseArgs,
} from "./sign-macos-payload.mjs";

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;
const MH_EXECUTE = 0x2;
const MH_DYLIB = 0x6;
const MH_BUNDLE = 0x8;

function machO64Header(fileType, cpuType = CPU_ARM64) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64, little-endian on disk
  buffer.writeUInt32LE(cpuType, 4);
  buffer.writeUInt32LE(0, 8); // cpusubtype
  buffer.writeUInt32LE(fileType, 12);
  return buffer;
}

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sign-macos-payload-test-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("argument parsing", () => {
  it("parses payload dir, dry-run, and verify", () => {
    assert.deepEqual(parseArgs([]), {
      payloadDir: undefined,
      dryRun: false,
      verify: false,
      help: false,
    });
    assert.equal(parseArgs(["--payload-dir", "/tmp/p"]).payloadDir, "/tmp/p");
    assert.equal(parseArgs(["--payload-dir=/tmp/p"]).payloadDir, "/tmp/p");
    assert.equal(parseArgs(["--dry-run"]).dryRun, true);
    assert.equal(parseArgs(["--verify"]).verify, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });

  it("rejects unknown arguments, empty paths, and conflicting modes", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown argument --nope/);
    assert.throws(() => parseArgs(["--payload-dir", "  "]), /requires a path/);
    assert.throws(() => parseArgs(["--dry-run", "--verify"]), /mutually exclusive/);
  });

  it("extracts the team id from a full Developer ID identity string", () => {
    assert.equal(
      expectedTeamIdFrom("Developer ID Application: Jane Doe (AB12CD34EF)"),
      "AB12CD34EF",
    );
    assert.equal(expectedTeamIdFrom("Developer ID Application: Jane Doe"), null);
    assert.equal(expectedTeamIdFrom(undefined), null);
    assert.equal(expectedTeamIdFrom(""), null);
  });
});

describe("Mach-O detection", () => {
  it("classifies thin arm64 executables and libraries", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "tool"), machO64Header(MH_EXECUTE));
      writeFileSync(path.join(root, "lib.dylib"), machO64Header(MH_DYLIB));
      writeFileSync(path.join(root, "mod.so"), machO64Header(MH_BUNDLE));
      assert.deepEqual(classifyMachO(path.join(root, "tool")), {
        signable: true,
        architecture: "arm64",
        kind: "executable",
      });
      assert.deepEqual(classifyMachO(path.join(root, "lib.dylib")), {
        signable: true,
        architecture: "arm64",
        kind: "library",
      });
      assert.equal(classifyMachO(path.join(root, "mod.so")).kind, "library");
    });
  });

  it("returns null for non-Mach-O files and flags foreign images as unsignable", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "readme.txt"), "not a binary");
      writeFileSync(path.join(root, "tiny"), Buffer.from([0x01]));
      writeFileSync(path.join(root, "intel"), machO64Header(MH_EXECUTE, CPU_X86_64));
      writeFileSync(path.join(root, "fat"), Buffer.from("cafebabe00000002", "hex"));
      writeFileSync(
        path.join(root, "mach32"),
        Buffer.from("feedface0000000c00000000", "hex"),
      );
      assert.equal(classifyMachO(path.join(root, "readme.txt")), null);
      assert.equal(classifyMachO(path.join(root, "tiny")), null);
      assert.equal(classifyMachO(path.join(root, "intel")).signable, false);
      assert.equal(classifyMachO(path.join(root, "fat")).architecture, "universal");
      assert.equal(classifyMachO(path.join(root, "mach32")).architecture, "32-bit");
    });
  });
});

describe("entitlement classification", () => {
  it("routes JVM executables, jspawnhelper, and the MCP node runtime", () => {
    assert.equal(entitlementClassFor("jre/bin/java"), "jvm");
    assert.equal(entitlementClassFor("jre/bin/keytool"), "jvm");
    assert.equal(entitlementClassFor("jre/lib/jspawnhelper"), "jvm");
    assert.equal(entitlementClassFor("jre\\bin\\java"), "jvm");
    assert.equal(entitlementClassFor("mcp/node/bin/node"), "node");
  });

  it("gives everything else no entitlements", () => {
    assert.equal(entitlementClassFor("ocr/gs/bin/gs"), "none");
    assert.equal(entitlementClassFor("ocr/tesseract/bin/tesseract"), "none");
    assert.equal(entitlementClassFor("ocr/qpdf/bin/qpdf"), "none");
    assert.equal(entitlementClassFor("ocr/python/bin/python3"), "none");
    assert.equal(entitlementClassFor("jre/lib/libjvm.dylib"), "none");
    assert.equal(entitlementClassFor("jre/lib/jspawnhelper-extra"), "none");
    assert.equal(entitlementClassFor("mcp/node/bin/node-something"), "none");
    assert.equal(entitlementClassFor("engine/stirling.jar"), "none");
  });

  it("maps entitlement classes to plist files", () => {
    assert.match(entitlementsFileFor("jvm"), /entitlements[/\\]jvm\.entitlements$/);
    assert.match(entitlementsFileFor("node"), /entitlements[/\\]node\.entitlements$/);
    assert.equal(entitlementsFileFor("none"), null);
  });
});

describe("signing plan", () => {
  it("plans libraries before executables, grouped by entitlements class", () => {
    withTempDir((root) => {
      mkdirSync(path.join(root, "jre", "bin"), { recursive: true });
      mkdirSync(path.join(root, "jre", "lib"), { recursive: true });
      mkdirSync(path.join(root, "mcp", "node", "bin"), { recursive: true });
      mkdirSync(path.join(root, "ocr", "gs", "bin"), { recursive: true });
      writeFileSync(path.join(root, "jre", "bin", "java"), machO64Header(MH_EXECUTE));
      writeFileSync(path.join(root, "jre", "lib", "jspawnhelper"), machO64Header(MH_EXECUTE));
      writeFileSync(path.join(root, "jre", "lib", "libjvm.dylib"), machO64Header(MH_DYLIB));
      writeFileSync(path.join(root, "mcp", "node", "bin", "node"), machO64Header(MH_EXECUTE));
      writeFileSync(path.join(root, "ocr", "gs", "bin", "gs"), machO64Header(MH_EXECUTE));
      writeFileSync(path.join(root, "ocr", "gs", "bin", "notes.txt"), "plain text");

      const plan = buildSigningPlan(root);
      assert.equal(plan.entries.length, 5);
      assert.equal(plan.skippedCount, 1);

      const byRel = new Map(plan.entries.map((entry) => [entry.relPath, entry]));
      assert.equal(byRel.get("jre/bin/java").entitlementClass, "jvm");
      assert.equal(byRel.get("jre/lib/jspawnhelper").entitlementClass, "jvm");
      assert.equal(byRel.get("mcp/node/bin/node").entitlementClass, "node");
      assert.equal(byRel.get("ocr/gs/bin/gs").entitlementClass, "none");
      assert.equal(byRel.get("jre/lib/libjvm.dylib").kind, "library");
      assert.equal(byRel.get("jre/lib/libjvm.dylib").entitlementClass, "none");

      const batches = buildBatches(plan.entries);
      assert.deepEqual(
        batches.map((batch) => [batch.label, batch.files.map((entry) => entry.relPath)]),
        [
          ["libraries (no entitlements)", ["jre/lib/libjvm.dylib"]],
          ["executables (no entitlements)", ["ocr/gs/bin/gs"]],
          ["executables (jvm.entitlements)", ["jre/bin/java", "jre/lib/jspawnhelper"]],
          ["executables (node.entitlements)", ["mcp/node/bin/node"]],
        ],
      );
      assert.equal(batches[0].entitlementsFile, null);
      assert.equal(batches[1].entitlementsFile, null);
      assert.match(batches[2].entitlementsFile, /jvm\.entitlements$/);
      assert.match(batches[3].entitlementsFile, /node\.entitlements$/);
    });
  });

  it("fails closed on non-arm64 Mach-O files", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "intel-helper"), machO64Header(MH_EXECUTE, CPU_X86_64));
      assert.throws(
        () => buildSigningPlan(root),
        /intel-helper is a cpu-0x1000007 Mach-O; only thin arm64 is signable/,
      );
    });
  });

  it("rejects symlinks in the payload", () => {
    withTempDir((root) => {
      writeFileSync(path.join(root, "real"), machO64Header(MH_EXECUTE));
      symlinkSync(path.join(root, "real"), path.join(root, "alias"));
      assert.throws(() => buildSigningPlan(root), /symlinks are forbidden/);
    });
  });
});
