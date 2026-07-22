import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  APP_ENTITLEMENTS,
  APP_EXECUTABLE,
  AUTOMATION_ENTITLEMENT,
  EXTERNAL_BINARIES,
  assertAutomationEntitlementBoundary,
  assertBundleLayout,
  binaryPaths,
  hasGrantedEntitlement,
  hardenBundledPythonTree,
  makeBundledPythonTreeReplaceable,
  parseArgs,
  readOnlyDirectoryMode,
  replaceableDirectoryMode,
  signingPlan,
} from "./sign-macos-app-binaries.mjs";

const APP_PATH = "/tmp/RaioPDF.app";
const IDENTITY = "Developer ID Application: Macrify LLC (AB12CD34EF)";
const AUTOMATION_PLIST = `<plist><dict><key>${AUTOMATION_ENTITLEMENT}</key><true/></dict></plist>`;

describe("macOS app binary signing", () => {
  it("requires an app path and parses verification mode", () => {
    assert.deepEqual(parseArgs(["--app", APP_PATH]), { app: APP_PATH, verify: false, help: false });
    assert.deepEqual(parseArgs([`--app=${APP_PATH}`, "--verify"]), {
      app: APP_PATH,
      verify: true,
      help: false,
    });
    assert.equal(parseArgs(["--help"]).help, true);
    assert.throws(() => parseArgs([]), /--app PATH is required/);
    assert.throws(() => parseArgs(["--nope", APP_PATH]), /unknown argument/);
  });

  it("uses the exact bundled executable locations", () => {
    assert.deepEqual(binaryPaths(APP_PATH), {
      main: path.join(APP_PATH, "Contents", "MacOS", APP_EXECUTABLE),
      sidecars: EXTERNAL_BINARIES.map((name) => path.join(APP_PATH, "Contents", "MacOS", name)),
    });
  });

  it("fails closed when the app or one expected sidecar is absent", () => {
    assert.throws(() => assertBundleLayout(APP_PATH, () => false), /app bundle not found/);
    assert.throws(
      () =>
        assertBundleLayout(
          APP_PATH,
          (candidate) => !candidate.endsWith(path.join("MacOS", EXTERNAL_BINARIES[1])),
        ),
      new RegExp(EXTERNAL_BINARIES[1]),
    );
  });

  it("signs every externalBin without entitlements before the app bundle", () => {
    const plan = signingPlan(APP_PATH, IDENTITY);
    assert.equal(plan.length, EXTERNAL_BINARIES.length + 1);
    assert.deepEqual(
      plan.slice(0, -1).map((command) => path.basename(command.target)),
      EXTERNAL_BINARIES,
    );
    for (const command of plan.slice(0, -1)) {
      assert.equal(command.args.includes("--entitlements"), false);
      assert.equal(command.args.at(-1), command.target);
    }
    const appCommand = plan.at(-1);
    assert.equal(appCommand.target, APP_PATH);
    assert.deepEqual(appCommand.args, [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      APP_ENTITLEMENTS,
      "--sign",
      IDENTITY,
      APP_PATH,
    ]);
    assert.throws(() => signingPlan(APP_PATH, ""), /RAIOPDF_MAC_SIGN_IDENTITY is not set/);
  });

  it("requires Automation on the main executable and rejects it on a sidecar", () => {
    assert.equal(hasGrantedEntitlement(AUTOMATION_PLIST), true);
    assert.equal(hasGrantedEntitlement("<plist><dict></dict></plist>"), false);
    assert.doesNotThrow(() =>
      assertAutomationEntitlementBoundary({
        mainEntitlements: AUTOMATION_PLIST,
        sidecarEntitlements: {
          [EXTERNAL_BINARIES[0]]: "<plist><dict></dict></plist>",
          [EXTERNAL_BINARIES[1]]: "",
        },
      }),
    );
    assert.throws(
      () =>
        assertAutomationEntitlementBoundary({
          mainEntitlements: "",
          sidecarEntitlements: {},
        }),
      /main app executable is missing/,
    );
    assert.throws(
      () =>
        assertAutomationEntitlementBoundary({
          mainEntitlements: AUTOMATION_PLIST,
          sidecarEntitlements: { [EXTERNAL_BINARIES[0]]: AUTOMATION_PLIST },
        }),
      new RegExp(`leaked to externalBin sidecar ${EXTERNAL_BINARIES[0]}`),
    );
  });

  it("removes every directory write bit from the sealed Python runtime", () => {
    assert.equal(readOnlyDirectoryMode(0o755), 0o555);
    assert.equal(readOnlyDirectoryMode(0o775), 0o555);
    assert.equal(readOnlyDirectoryMode(0o700), 0o500);
  });

  it("restores only owner write permission before replacing a generated bundle", () => {
    assert.equal(replaceableDirectoryMode(0o555), 0o755);
    assert.equal(replaceableDirectoryMode(0o500), 0o700);
    assert.equal(replaceableDirectoryMode(0o775), 0o775);
  });

  it("makes a previously hardened generated Python tree replaceable, then reseals it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-signing-tree-"));
    const app = path.join(root, "RaioPDF.app");
    const python = path.join(app, "Contents", "Resources", "payload", "ocr", "python");
    const nested = path.join(python, "lib", "python3.13", "site-packages");
    mkdirSync(nested, { recursive: true });
    try {
      hardenBundledPythonTree(app);
      assert.equal(statSync(python).mode & 0o200, 0);
      assert.equal(statSync(nested).mode & 0o200, 0);

      makeBundledPythonTreeReplaceable(app);
      assert.equal(statSync(python).mode & 0o200, 0o200);
      assert.equal(statSync(nested).mode & 0o200, 0o200);

      hardenBundledPythonTree(app);
      assert.equal(statSync(python).mode & 0o222, 0);
      assert.equal(statSync(nested).mode & 0o222, 0);
    } finally {
      // The test itself intentionally reseals the tree; restore owner write so
      // cleanup can remove it on every platform/filesystem.
      for (const directory of [python, path.join(python, "lib"), path.join(python, "lib", "python3.13"), nested]) {
        if (statSync(directory, { throwIfNoEntry: false })) chmodSync(directory, 0o700);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
