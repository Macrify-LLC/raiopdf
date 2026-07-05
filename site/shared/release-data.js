// Live release data for the RaioPDF landing page, sourced entirely from the
// public, CORS-open GitHub REST API. No backend, no analytics, no telemetry —
// every value on this page is either static copy or fetched straight from
// GitHub at load time in the visitor's own browser.
//
// RaioPDF is public alpha, but the GitHub Release must be a normal published
// release because the desktop updater reads /releases/latest/download/latest.json.
// Product copy can still say "alpha"; this page only shows a Windows download
// when the latest normal release metadata has the complete signed/compliance
// asset set expected by the release validator. Deep checks for latest.json,
// updater signatures, checksums, and Authenticode happen in the release
// validator because GitHub release asset bytes are not reliable to browser-fetch
// cross-origin from a static page.
//
// Plain global (not an ES module) on purpose: a bare `<script src>` tag
// works when this file is opened straight off disk (file://), where ES
// module imports get blocked by the browser's cross-origin module policy.
// Load with `<script src="./shared/release-data.js"></script>` before your
// inline page script, then call the functions on `window.RaioRelease`.

(function (global) {
  "use strict";

  const REPO = "Macrify-LLC/raiopdf";
  const API_BASE = `https://api.github.com/repos/${REPO}`;
  const GH_HEADERS = { Accept: "application/vnd.github+json" };
  const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
  const SIGNED_WINDOWS_INSTALLER =
    /^RaioPDF-([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)-windows-x64-setup\.exe$/;
  const GHOSTSCRIPT_SOURCE = /^ghostscript-\d+\.\d+\.\d+-source\.tar\.xz$/;

  function pickAsset(assets, pattern) {
    return (assets || []).find((asset) => pattern.test(asset.name));
  }

  function assetByName(assets, name) {
    return (assets || []).find((asset) => asset.name === name) || null;
  }

  function digestToSha256(digest) {
    if (!digest) return null;
    const [algo, hash] = digest.split(":");
    return algo === "sha256" ? hash : null;
  }

  function versionFromRelease(release) {
    return (release.tag_name || release.name || "").replace(/^v/, "");
  }

  function expectedAssetNames(version, ghostscriptSourceName) {
    const installer = `RaioPDF-${version}-windows-x64-setup.exe`;
    return [
      installer,
      `${installer}.sig`,
      `RaioPDF-${version}-third-party-notices.txt`,
      `RaioPDF-${version}-component-manifest.json`,
      `RaioPDF-${version}-source-correspondence.md`,
      `RaioPDF-${version}-license-notices.txt`,
      `RaioPDF-${version}-ghostscript-source-offer.txt`,
      ghostscriptSourceName,
      "latest.json",
      "SHA256SUMS.txt",
    ].sort((a, b) => a.localeCompare(b));
  }

  function releaseAssetSet(release) {
    const assets = release?.assets || [];
    const version = versionFromRelease(release);
    if (!SEMVER.test(version)) return null;

    const installer = pickAsset(assets, SIGNED_WINDOWS_INSTALLER);
    if (!installer) return null;
    const installerMatch = SIGNED_WINDOWS_INSTALLER.exec(installer.name);
    if (!installerMatch || installerMatch[1] !== version) return null;

    const ghostscriptSources = assets.filter((asset) => GHOSTSCRIPT_SOURCE.test(asset.name));
    if (ghostscriptSources.length !== 1) return null;

    const expected = expectedAssetNames(version, ghostscriptSources[0].name);
    const actual = assets.map((asset) => asset.name).sort((a, b) => a.localeCompare(b));
    if (actual.some((name) => /unsigned/i.test(name))) return null;
    if (actual.some((name) => name.toLowerCase().endsWith(".exe") && name !== installer.name)) {
      return null;
    }
    if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
      return null;
    }

    return {
      version,
      installer,
      installerSig: assetByName(assets, `${installer.name}.sig`),
      latestJson: assetByName(assets, "latest.json"),
      checksums: assetByName(assets, "SHA256SUMS.txt"),
      expected,
    };
  }

  async function fetchLatestRelease() {
    const res = await fetch(`${API_BASE}/releases/latest`, { headers: GH_HEADERS });
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchAllReleases() {
    const res = await fetch(`${API_BASE}/releases?per_page=100`, { headers: GH_HEADERS });
    if (!res.ok) return [];
    return res.json();
  }

  function pickDownloadRelease(latest) {
    if (!latest || latest.draft || latest.prerelease) {
      return null;
    }
    const assetSet = releaseAssetSet(latest);
    return assetSet ? { release: latest, assetSet } : null;
  }

  /**
   * Resolves the live install info shown in the hero + download panel.
   * Never throws — a GitHub outage or missing release response resolves to
   * `{ available: false }` rather than breaking the page.
   */
  async function loadReleaseInfo() {
    const [latestResult, allResult] = await Promise.allSettled([fetchLatestRelease(), fetchAllReleases()]);
    const latest = latestResult.status === "fulfilled" ? latestResult.value : null;
    const all = allResult.status === "fulfilled" ? allResult.value : [];

    const totalDownloads = (all || []).reduce(
      (sum, release) => sum + (release.assets || []).reduce((s, asset) => s + (asset.download_count || 0), 0),
      0
    );

    const selected = pickDownloadRelease(latest);

    if (!selected) {
      const release =
        latest && !latest.draft && !latest.prerelease
          ? latest
          : (all || []).find((candidate) => !candidate.draft && !candidate.prerelease) || null;
      return {
        available: false,
        version: release ? versionFromRelease(release) : null,
        publishedAt: release ? release.published_at : null,
        releaseUrl: release ? release.html_url : null,
        totalDownloads,
      };
    }

    const { release, assetSet } = selected;
    return {
      available: true,
      version: assetSet.version,
      publishedAt: release.published_at,
      releaseUrl: release.html_url,
      downloadUrl: assetSet.installer.browser_download_url,
      downloadName: assetSet.installer.name,
      sizeBytes: assetSet.installer.size,
      sha256: digestToSha256(assetSet.installer.digest),
      checksumsUrl: assetSet.checksums.browser_download_url,
      totalDownloads,
    };
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(i > 0 && value < 10 ? 1 : 0)} ${units[i]}`;
  }

  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  /** Animates a counter element from 0 to target over `duration` ms. Respects prefers-reduced-motion. */
  function animateCount(el, target, duration = 900) {
    if (!el) return;
    if (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = target.toLocaleString("en-US");
      return;
    }
    const start = performance.now();
    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  global.RaioRelease = {
    loadReleaseInfo,
    formatBytes,
    formatDate,
    animateCount,
  };
})(window);
