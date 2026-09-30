import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const SCRIPT = readFileSync(new URL("../site/shared/release-data.js", import.meta.url), "utf8");
const LANDING_PAGE = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const API_BASE = "https://api.github.com/repos/Macrify-LLC/raiopdf";
const LANDING_PAGE_SCRIPT = extractLandingPageScript(LANDING_PAGE);

describe("site release data", () => {
  it("enables download for a complete signed latest normal release asset set", async () => {
    const fixture = releaseFixture();
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, true);
    assert.equal(info.version, "0.1.2");
    assert.equal(info.downloadName, "RaioPDF-0.1.2-windows-x64-setup.exe");
    assert.equal(info.checksumsUrl, fixture.assetUrl("SHA256SUMS.txt"));
    // A Windows-only release surfaces no macOS download.
    assert.equal(info.mac, null);
  });

  it("does not browser-fetch release asset bytes while resolving the download", async () => {
    const fixture = releaseFixture();
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: new Map(),
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, true);
    assert.equal(info.downloadName, "RaioPDF-0.1.2-windows-x64-setup.exe");
  });

  it("keeps the Windows download available when a complete collision-free Mac set is present", async () => {
    const fixture = releaseFixture({ includeMac: true });
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, true);
    assert.equal(info.downloadName, "RaioPDF-0.1.2-windows-x64-setup.exe");
  });

  it("surfaces the macOS DMG download when a complete Mac set is present", async () => {
    const fixture = releaseFixture({ includeMac: true });
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    assert.ok(info.mac, "expected info.mac to be populated for a combined release");
    assert.equal(info.mac.downloadName, "RaioPDF-0.1.2-macos-arm64.dmg");
    assert.equal(info.mac.downloadUrl, fixture.assetUrl("RaioPDF-0.1.2-macos-arm64.dmg"));
    assert.equal(info.mac.checksumsUrl, fixture.assetUrl("SHA256SUMS-macos-arm64.txt"));
    // The Windows baseline is unchanged by the additive mac surface.
    assert.equal(info.available, true);
    assert.equal(info.downloadName, "RaioPDF-0.1.2-windows-x64-setup.exe");
  });

  it("keeps macOS null when a partial Mac set fails validation", async () => {
    const fixture = releaseFixture({
      includeMac: true,
      missing: ["RaioPDF-0.1.2-macos-arm64-license-notices.txt"],
    });
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    // An incomplete mac set fails the combined gate → the whole release is
    // treated as not-downloadable rather than exposing a half-validated DMG.
    assert.equal(info.available, false);
    assert.equal(info.mac, null);
  });

  it("fails closed for a partial Mac set or an unknown extra asset", async () => {
    const partial = releaseFixture({
      includeMac: true,
      missing: ["RaioPDF-0.1.2-macos-arm64-component-manifest.json"],
    });
    const unknown = releaseFixture({ extraAssets: [asset("unexpected-notes.txt")] });

    const partialInfo = await loadApi({
      latest: partial.release,
      releases: [partial.release],
      textAssets: partial.textAssets,
    }).loadReleaseInfo();
    const unknownInfo = await loadApi({
      latest: unknown.release,
      releases: [unknown.release],
      textAssets: unknown.textAssets,
    }).loadReleaseInfo();

    assert.equal(partialInfo.available, false);
    assert.equal(unknownInfo.available, false);
  });

  it("stays pending for a GitHub prerelease because the updater latest endpoint cannot discover it", async () => {
    const fixture = releaseFixture({ prerelease: true });
    const api = loadApi({
      latest: null,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, false);
    assert.equal(info.downloadUrl, undefined);
  });

  it("keeps the stable download when a newer preview release exists", async () => {
    const stable = releaseFixture({ version: "0.1.2", id: 12 });
    const preview = releaseFixture({ version: "0.2.0-beta.1", id: 13, prerelease: true });
    const api = loadApi({
      latest: stable.release,
      releases: [preview.release, stable.release],
      textAssets: new Map([...stable.textAssets, ...preview.textAssets]),
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, true);
    assert.equal(info.version, "0.1.2");
    assert.equal(info.downloadName, "RaioPDF-0.1.2-windows-x64-setup.exe");
    assert.equal(info.releaseUrl, stable.release.html_url);
  });

  it("stays pending when a required compliance asset is missing", async () => {
    const fixture = releaseFixture({ missing: ["RaioPDF-0.1.2-component-manifest.json"] });
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, false);
    assert.equal(info.downloadUrl, undefined);
  });

  it("stays pending when an unsigned executable asset is present", async () => {
    const fixture = releaseFixture({
      extraAssets: [asset("RaioPDF-0.1.2-unsigned.exe")],
    });
    const api = loadApi({
      latest: fixture.release,
      releases: [fixture.release],
      textAssets: fixture.textAssets,
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, false);
    assert.equal(info.downloadUrl, undefined);
  });

  it("does not fall back to an older complete release when latest is incomplete", async () => {
    const latest = releaseFixture({
      version: "0.1.2",
      id: 12,
      missing: ["RaioPDF-0.1.2-component-manifest.json"],
    });
    const older = releaseFixture({ version: "0.1.1", id: 11 });
    const api = loadApi({
      latest: latest.release,
      releases: [latest.release, older.release],
      textAssets: new Map([...latest.textAssets, ...older.textAssets]),
    });

    const info = await api.loadReleaseInfo();

    assert.equal(info.available, false);
    assert.equal(info.downloadUrl, undefined);
    assert.equal(info.version, "0.1.2");
  });

  it("keeps the fallback panel and release notes visible when the latest release is unavailable", () => {
    const dom = createLandingPageDom();
    const context = {
      document: dom.document,
      window: {},
    };
    vm.createContext(context);
    vm.runInContext(SCRIPT, context);
    context.window.RaioRelease.loadReleaseInfo = () => unavailableReleaseThenable();

    assert.doesNotThrow(() => vm.runInContext(LANDING_PAGE_SCRIPT, context));

    assert.equal(dom.elements.downloadLoading.classList.contains("is-hidden"), true);
    assert.equal(dom.elements.downloadAvailable.classList.contains("is-hidden"), true);
    assert.equal(dom.elements.downloadPending.classList.contains("is-hidden"), false);
    assert.equal(dom.elements["latest-update"].classList.contains("is-hidden"), false);
    assert.equal(dom.elements.navWhatsNew.classList.contains("is-hidden"), false);
    assert.equal(dom.elements.updateVersion.textContent, "v0.1.2 · July 5, 2026");
    assert.equal(dom.elements.updateHeadline.textContent, "A safer release");
    assert.equal(dom.elements.updateSections.children.length, 1);
    assert.equal(dom.elements.updateSections.children[0].children[0].textContent, "Fixed");
    assert.equal(dom.elements.updateSections.children[0].children[1].children[0].textContent, "Fallback copy remains available");
    assert.equal(dom.elements.updateNotesLink.classList.contains("is-hidden"), false);
    assert.equal(dom.elements.updateNotesLink.href, "https://github.com/Macrify-LLC/raiopdf/releases/tag/v0.1.2");
  });
});

function extractLandingPageScript(html) {
  const loadingMarker = 'var loadingEl = document.getElementById("downloadLoading");';
  const markerIndex = html.indexOf(loadingMarker);
  assert.notEqual(markerIndex, -1, "landing page download script marker should exist");
  const scriptStart = html.lastIndexOf("<script>", markerIndex);
  const scriptEnd = html.indexOf("\n\n  // Scroll-linked parallax", markerIndex);
  assert.notEqual(scriptStart, -1, "landing page download script should have an opening tag");
  assert.notEqual(scriptEnd, -1, "landing page download script should have a stable boundary");
  return html.slice(scriptStart + "<script>".length, scriptEnd);
}

function createLandingPageDom() {
  const elements = {};
  const ids = [
    ["downloadLoading", ""],
    ["downloadAvailable", "is-hidden"],
    ["downloadPending", "is-hidden"],
    ["downloadBtn", ""],
    ["downloadMeta", ""],
    ["downloadVerify", "is-hidden"],
    ["downloadButtons", ""],
    ["downloadOptionWin", ""],
    ["downloadOptionMac", "is-hidden"],
    ["downloadBtnMac", ""],
    ["downloadMetaMac", ""],
    ["downloadVerifyMac", "is-hidden"],
    ["statusBarPlatforms", ""],
    ["heroChipPlatform", ""],
    ["heroMetaNote", ""],
    ["latest-update", "is-hidden"],
    ["navWhatsNew", "is-hidden"],
    ["updateVersion", ""],
    ["updateHeadline", "is-hidden"],
    ["updateSections", ""],
    ["updateNotesLink", ""],
  ];

  for (const [id, className] of ids) {
    elements[id] = fakeElement(id, className);
  }
  elements.downloadOptionMac.parentNode = elements.downloadButtons;
  elements.downloadOptionWin.parentNode = elements.downloadButtons;

  return {
    elements,
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
      createElement(tagName) {
        return fakeElement(tagName, "");
      },
    },
  };
}

function fakeElement(id, className) {
  const element = {
    id,
    className: "",
    href: "",
    textContent: "",
    children: [],
    parentNode: null,
    classList: fakeClassList(className),
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
  };
  return element;
}

function fakeClassList(className) {
  const names = new Set(className ? className.split(/\s+/) : []);
  return {
    add(...values) {
      values.forEach((value) => names.add(value));
    },
    remove(...values) {
      values.forEach((value) => names.delete(value));
    },
    contains(value) {
      return names.has(value);
    },
  };
}

function unavailableReleaseThenable() {
  const info = {
    available: false,
    version: "0.1.2",
    publishedAt: "2026-07-05T12:00:00.000Z",
    releaseUrl: "https://github.com/Macrify-LLC/raiopdf/releases/tag/v0.1.2",
    notesMarkdown: "**A safer release**\n\n## Fixed\n- **Fallback copy remains available.**",
    mac: null,
  };

  return {
    then(onFulfilled) {
      let error = null;
      try {
        onFulfilled(info);
      } catch (caught) {
        error = caught;
      }
      return {
        catch(onRejected) {
          if (error) onRejected(error);
        },
      };
    },
  };
}

function loadApi({ latest, releases, textAssets }) {
  const context = {
    URL,
    performance: { now: () => 0 },
    requestAnimationFrame: () => undefined,
    window: {},
  };
  context.fetch = async (url) => {
    if (url === `${API_BASE}/releases/latest`) {
      return response(latest, Boolean(latest));
    }
    if (url === `${API_BASE}/releases?per_page=100`) {
      return response(releases);
    }
    if (textAssets.has(url)) {
      return response(textAssets.get(url));
    }
    return response(null, false);
  };
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  return context.window.RaioRelease;
}

function response(body, ok = true) {
  return {
    ok,
    json: async () => body,
    text: async () => String(body),
  };
}

function releaseFixture({
  version = "0.1.2",
  id = 12,
  missing = [],
  extraAssets = [],
  latestSignature = "trusted-signature",
  prerelease = false,
  includeMac = false,
} = {}) {
  const tag = `v${version}`;
  const installer = `RaioPDF-${version}-windows-x64-setup.exe`;
  const signature = `${installer}.sig`;
  const windowsNames = [
    installer,
    signature,
    `RaioPDF-${version}-third-party-notices.txt`,
    `RaioPDF-${version}-component-manifest.json`,
    `RaioPDF-${version}-source-correspondence.md`,
    `RaioPDF-${version}-license-notices.txt`,
    `RaioPDF-${version}-ghostscript-source-offer.txt`,
    "ghostscript-10.07.1-source.tar.xz",
    "latest.json",
    "SHA256SUMS.txt",
  ];
  const macUpdater = `RaioPDF-${version}-macos-arm64.app.tar.gz`;
  const macNames = includeMac
    ? [
        `RaioPDF-${version}-macos-arm64.dmg`,
        macUpdater,
        `${macUpdater}.sig`,
        `RaioPDF-${version}-macos-arm64-third-party-notices.txt`,
        `RaioPDF-${version}-macos-arm64-component-manifest.json`,
        `RaioPDF-${version}-macos-arm64-source-correspondence.md`,
        `RaioPDF-${version}-macos-arm64-license-notices.txt`,
        `RaioPDF-${version}-macos-arm64-ghostscript-source-offer.txt`,
        "ghostscript-10.08.0-macos-arm64-source.tar.xz",
        "SHA256SUMS-macos-arm64.txt",
      ]
    : [];
  const names = [...windowsNames, ...macNames].filter((name) => !missing.includes(name));
  const assets = names.map((name) =>
    asset(name, name === installer ? { digest: sha256("installer-bytes"), size: 123 } : {}),
  );
  assets.push(...extraAssets);

  const assetUrl = (name) => `https://downloads.example.invalid/${encodeURIComponent(name)}`;
  for (const entry of assets) {
    entry.browser_download_url = assetUrl(entry.name);
  }

  const textAssets = new Map();
  textAssets.set(assetUrl(signature), "trusted-signature\n");
  textAssets.set(
    assetUrl("latest.json"),
    JSON.stringify({
      version,
      pub_date: "2026-07-05T00:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          signature: latestSignature,
          url: `https://github.com/Macrify-LLC/raiopdf/releases/download/${tag}/${installer}`,
        },
        ...(includeMac
          ? {
              "darwin-aarch64": {
                signature: "trusted-mac-signature",
                url: `https://github.com/Macrify-LLC/raiopdf/releases/download/${tag}/${macUpdater}`,
              },
            }
          : {}),
      },
    }),
  );
  textAssets.set(
    assetUrl("SHA256SUMS.txt"),
    names
      .filter((name) => name !== "SHA256SUMS.txt")
      .map((name) => `${name === installer ? sha256("installer-bytes") : sha256(name)}  ${name}`)
      .join("\n"),
  );

  return {
    assetUrl,
    textAssets,
    release: {
      id,
      draft: false,
      prerelease,
      tag_name: tag,
      name: tag,
      published_at: "2026-07-05T00:00:00.000Z",
      html_url: `https://github.com/Macrify-LLC/raiopdf/releases/tag/${tag}`,
      assets,
    },
  };
}

function asset(name, options = {}) {
  return {
    name,
    size: options.size ?? 1,
    digest: options.digest ? `sha256:${options.digest}` : undefined,
    download_count: 0,
    browser_download_url: `https://downloads.example.invalid/${encodeURIComponent(name)}`,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
