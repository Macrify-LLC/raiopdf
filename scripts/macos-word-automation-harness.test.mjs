import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_ENTITLEMENT,
  HARNESS_IDS,
  SWIFT_SOURCE,
  entitlementForMode,
  infoPlist,
  parseArgs,
  signingArgs,
  validateRunReport,
} from "./macos-word-automation-harness.mjs";

test("Word Automation harness keeps positive and negative TCC clients distinct", () => {
  assert.notEqual(HARNESS_IDS.positive, HARNESS_IDS.negative);
  assert.match(HARNESS_IDS.positive, /^com\.macrify\.raiopdf\./u);
  assert.match(HARNESS_IDS.negative, /^com\.macrify\.raiopdf\./u);
  assert.match(infoPlist(HARNESS_IDS.positive, "Positive"), /NSAppleEventsUsageDescription/u);
});

test("only the positive direct-sender harness has Automation entitlement", () => {
  assert.match(entitlementForMode("positive"), new RegExp(AUTOMATION_ENTITLEMENT));
  assert.equal(entitlementForMode("negative"), null);
  const positive = signingArgs("/tmp/Positive.app", "Developer ID Application: Test", "/tmp/e.plist");
  const negative = signingArgs("/tmp/Negative.app", "Developer ID Application: Test", null);
  assert.ok(positive.includes("--entitlements"));
  assert.ok(!negative.includes("--entitlements"));
  assert.ok(positive.includes("runtime"));
  assert.ok(negative.includes("runtime"));
});

test("the harness sends its Apple Event in process, never by spawning osascript", () => {
  assert.match(SWIFT_SOURCE, /AEDeterminePermissionToAutomateTarget/u);
  assert.match(SWIFT_SOURCE, /NSAppleScript/u);
  assert.doesNotMatch(SWIFT_SOURCE, /osascript/u);
});

test("argument parsing requires a Developer ID and a known mode", () => {
  assert.deepEqual(parseArgs(["--identity", "Developer ID Application: Test", "--mode", "positive"]), {
    identity: "Developer ID Application: Test",
    mode: "positive",
    output: null,
    reset: false,
    run: false,
    help: false,
  });
  assert.throws(() => parseArgs(["--mode", "positive"]), /--identity is required/u);
  assert.throws(() => parseArgs(["--identity", "x", "--mode", "maybe"]), /positive or negative/u);
});

test("the report gate requires a real -1743 negative and successful positive", () => {
  const base = { wordBundleIdentifier: "com.microsoft.Word", wordProcessIdentifier: 42 };
  assert.doesNotThrow(() => validateRunReport("negative", { ...base, permissionStatus: -1743 }));
  assert.throws(
    () => validateRunReport("negative", { ...base, permissionStatus: 0 }),
    /must be denied with -1743/u,
  );
  assert.doesNotThrow(() =>
    validateRunReport("positive", { ...base, permissionStatus: 0, scriptResult: "Microsoft Word" }),
  );
  assert.throws(
    () => validateRunReport("positive", { ...base, permissionStatus: -1743, scriptResult: "" }),
    /not authorized/u,
  );
});
