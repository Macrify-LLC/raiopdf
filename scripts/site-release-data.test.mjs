import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const SCRIPT = readFileSync(new URL("../site/shared/release-data.js", import.meta.url), "utf8");
const API_BASE = "https://api.github.com/repos/Macrify-LLC/raiopdf";

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
});

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
} = {}) {
  const tag = `v${version}`;
  const installer = `RaioPDF-${version}-windows-x64-setup.exe`;
  const signature = `${installer}.sig`;
  const names = [
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
  ].filter((name) => !missing.includes(name));
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
