import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { findViolations } from "./assert-e2e-webdriver-not-in-release.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("assert-e2e-webdriver-not-in-release", () => {
  const tempDirs = [];
  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Build a throwaway repo root. `files` maps repo-relative paths to contents;
   * directories are created as needed.
   */
  function fixtureRoot({ scripts = {}, cargoFeatures = "e2e-webdriver = []\n", files = {} } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), "e2e-guard-"));
    tempDirs.push(root);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }, null, 2));
    mkdirSync(path.join(root, "apps/shell/src-tauri"), { recursive: true });
    writeFileSync(
      path.join(root, "apps/shell/src-tauri/Cargo.toml"),
      `[features]\n${cargoFeatures}`,
    );
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return root;
  }

  it("passes on the real repo", () => {
    assert.deepEqual(findViolations(repoRoot), []);
  });

  it("allows any build:shell:e2e:* script to enable the feature", () => {
    const root = fixtureRoot({
      scripts: {
        "build:shell:e2e:windows-x64":
          "tauri build --config x --no-bundle --features e2e-webdriver",
        "build:shell:e2e:macos-arm64":
          "tauri build --config y --no-bundle --features e2e-webdriver",
        "build:shell:windows-x64": "tauri build --config x",
      },
    });
    assert.deepEqual(findViolations(root), []);
  });

  it("flags a release script that enables the feature", () => {
    const root = fixtureRoot({ scripts: { "build:shell:signed": "tauri build --features e2e-webdriver" } });
    assert.match(findViolations(root).join("\n"), /build:shell:signed/);
  });

  it("flags any non-allowed script naming the feature", () => {
    const root = fixtureRoot({ scripts: { "sneaky:build": "cargo build --features e2e-webdriver" } });
    assert.match(findViolations(root).join("\n"), /sneaky:build/);
  });

  it("flags the feature in the Cargo default feature set", () => {
    const root = fixtureRoot({ cargoFeatures: 'default = ["e2e-webdriver"]\ne2e-webdriver = []\n' });
    assert.match(findViolations(root).join("\n"), /default features include/);
  });

  it("scans a newly added tauri config, not just an enumerated list", () => {
    const root = fixtureRoot({
      files: {
        "apps/shell/src-tauri/tauri.newplatform.conf.json":
          '{ "build": { "beforeBuildCommand": "tauri build --features e2e-webdriver" } }',
      },
    });
    assert.match(findViolations(root).join("\n"), /tauri\.newplatform\.conf\.json/);
  });

  it("scans a newly added tooling script but ignores test fixtures", () => {
    const root = fixtureRoot({
      files: {
        "scripts/release-linux.mjs": "// tauri build --features e2e-webdriver\nexport {};\n",
        "scripts/some.test.mjs": 'const fixture = "tauri build --features e2e-webdriver";\n',
      },
    });
    const violations = findViolations(root).join("\n");
    assert.match(violations, /release-linux\.mjs/);
    assert.doesNotMatch(violations, /some\.test\.mjs/);
  });
});
