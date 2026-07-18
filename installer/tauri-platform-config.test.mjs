import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function config(name) {
  return JSON.parse(readFileSync(path.join(repoRoot, "apps/shell/src-tauri", name), "utf8"));
}

test("base Tauri config cannot produce an accidental cross-platform bundle", () => {
  const base = config("tauri.conf.json");
  assert.equal(base.bundle.active, false);
  assert.equal(base.bundle.resources, undefined);
  assert.equal(base.bundle.windows, undefined);
});

test("Windows overlay maps only the Windows payload into the canonical installed path", () => {
  const windows = config("tauri.windows-x64.conf.json");
  assert.deepEqual(windows.bundle.targets, ["nsis"]);
  assert.deepEqual(windows.bundle.resources, { "payload/windows-x64": "payload" });
  assert.equal(windows.app.windows[0].decorations, false);
  assert.equal(windows.bundle.macOS, undefined);
});

test("macOS overlay is Apple Silicon-only by command contract and contains no Windows packaging", () => {
  const macos = config("tauri.macos.conf.json");
  assert.equal(macos.bundle.active, true);
  assert.deepEqual(macos.bundle.targets, ["app", "dmg"]);
  assert.deepEqual(macos.bundle.resources, { "payload/macos-arm64": "payload" });
  assert.equal(macos.bundle.macOS.minimumSystemVersion, "14.0");
  assert.equal(macos.app.windows[0].decorations, true);
  assert.equal(macos.app.windows[0].titleBarStyle, "Overlay");
  assert.equal(macos.app.windows[0].hiddenTitle, true);
  assert.deepEqual(macos.app.windows[0].trafficLightPosition, { x: 14, y: 16 });
  assert.equal(macos.bundle.windows, undefined);
  assert.equal(JSON.stringify(macos).includes("universal"), false);
});

test("signed Windows overlay preserves the Windows boundary", () => {
  const signed = config("tauri.windows.signing.conf.json");
  assert.deepEqual(signed.bundle.resources, { "payload/windows-x64": "payload" });
  assert.equal(signed.bundle.createUpdaterArtifacts, true);
  assert.equal(signed.bundle.windows.signCommand.cmd, "pwsh");
  assert.equal(signed.bundle.macOS, undefined);
});

// `tauri-plugin-opener` ACL-checks every openUrl against the capability scope
// using `glob::Pattern::matches`, whose default options let `*` and `?` match
// any character. Mirror that here rather than pulling in a matcher.
function globToRegExp(pattern) {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[\\s\\S]*";
    else if (character === "?") source += "[\\s\\S]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function openerScopePatterns() {
  const capabilities = JSON.parse(
    readFileSync(path.join(repoRoot, "apps/shell/src-tauri/capabilities/default.json"), "utf8"),
  );
  const permission = capabilities.permissions.find(
    (entry) => typeof entry === "object" && entry.identifier === "opener:allow-open-url",
  );
  assert.ok(permission, "the shell declares an opener:allow-open-url permission");
  return permission.allow.map((entry) => entry.url);
}

test("the opener scope allows the URLs the app actually opens", () => {
  // The scope and the URL builders live on opposite sides of the IPC boundary,
  // so nothing links them: a URL the UI builds but the scope omits is rejected
  // by the ACL at runtime and surfaces only as a soft "Couldn't open your email
  // app" — on every platform. That is exactly how the crash-report mailto
  // shipped broken. Read the real constants so either side drifting fails here.
  const source = readFileSync(path.join(repoRoot, "apps/ui/src/lib/errorReportMailto.ts"), "utf8");
  const email = /ERROR_REPORT_EMAIL = "([^"]+)"/.exec(source)?.[1];
  const subject = /ERROR_REPORT_SUBJECT = "([^"]+)"/.exec(source)?.[1];
  assert.ok(email && subject, "found the crash-report address and subject in the UI source");

  const mailto = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    "RaioPDF 0.1.0\nsomething went wrong: /tmp/a b?c&d",
  )}`;
  const patterns = openerScopePatterns();
  assert.ok(
    patterns.some((pattern) => globToRegExp(pattern).test(mailto)),
    `no opener scope entry allows the crash-report mailto (scope: ${patterns.join(", ")})`,
  );

  // The crash dialog's "open a GitHub issue" path must keep working too.
  assert.ok(
    patterns.some((pattern) =>
      globToRegExp(pattern).test("https://github.com/Macrify-LLC/raiopdf/issues/new?title=crash"),
    ),
    "the GitHub issue link stays allowed",
  );
});

test("the opener scope stays narrow", () => {
  // openUrl is reachable from the webview, so the scope is a real boundary:
  // keep it to our own issue tracker and our own crash-report alias.
  for (const pattern of openerScopePatterns()) {
    assert.ok(
      pattern.startsWith("https://github.com/Macrify-LLC/raiopdf/") ||
        pattern.startsWith("mailto:crash-reports@macrify.me"),
      `unexpected opener scope entry: ${pattern}`,
    );
  }
});
