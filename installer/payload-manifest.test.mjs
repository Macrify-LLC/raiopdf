import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPayloadManifest, writePayloadManifest } from "./payload-manifest.mjs";

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "raiopdf-payload-"));
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

test("manifest verifies exact files for the selected platform", (context) => {
  const root = fixture({ "engine/stirling.jar": "engine", "jre/bin/java": "runtime" });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePayloadManifest(root);
  assert.deepEqual(verifyPayloadManifest(root, "macos-arm64", {
    requiredFiles: ["engine/stirling.jar", "jre/bin/java"],
  }).files, 2);
});

test("manifest rejects files from the other platform", (context) => {
  const root = fixture({ "engine/stirling.jar": "engine", "ocr/bin/helper.exe": "foreign" });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePayloadManifest(root);
  assert.throws(() => verifyPayloadManifest(root, "macos-arm64"), /Foreign file/);
});

test("manifest rejects generated Python caches instead of hiding their size", (context) => {
  const root = fixture({ "ocr/python/__pycache__/module.pyc": "cache" });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePayloadManifest(root);
  assert.throws(() => verifyPayloadManifest(root, "macos-arm64"), /Python cache/);
});

test("manifest detects unrecorded mutation", (context) => {
  const root = fixture({ "engine/stirling.jar": "before" });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writePayloadManifest(root);
  writeFileSync(path.join(root, "engine", "stirling.jar"), "after");
  assert.throws(() => verifyPayloadManifest(root, "macos-arm64"), /mismatch/i);
});
