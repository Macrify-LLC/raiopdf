// Live release data for the RaioPDF landing page, sourced entirely from the
// public, CORS-open GitHub REST API. No backend, no analytics, no telemetry —
// every value on this page is either static copy or fetched straight from
// GitHub at load time in the visitor's own browser.
//
// Repo is pre-alpha: /releases/latest 404s until the first signed release is
// published. That 404 IS the launch gate — the page renders a "coming soon"
// state automatically and starts showing real numbers the moment Jacob
// publishes a release. No code change needed to "go live."
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

  function pickAsset(assets, pattern) {
    return (assets || []).find((a) => pattern.test(a.name));
  }

  function digestToSha256(digest) {
    if (!digest) return null;
    const [algo, hash] = digest.split(":");
    return algo === "sha256" ? hash : null;
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

  /**
   * Resolves the live install info shown in the hero + download panel.
   * Never throws — a GitHub outage or the pre-release 404 both resolve to
   * `{ available: false }` rather than breaking the page.
   */
  async function loadReleaseInfo() {
    const [latestResult, allResult] = await Promise.allSettled([fetchLatestRelease(), fetchAllReleases()]);
    const latest = latestResult.status === "fulfilled" ? latestResult.value : null;
    const all = allResult.status === "fulfilled" ? allResult.value : [];

    const totalDownloads = (all || []).reduce(
      (sum, release) => sum + (release.assets || []).reduce((s, a) => s + (a.download_count || 0), 0),
      0
    );

    if (!latest) {
      return { available: false, totalDownloads };
    }

    const msi = pickAsset(latest.assets, /\.msi$/i);
    const exe = pickAsset(latest.assets, /\.exe$/i);
    const primary = msi || exe;
    const checksums = pickAsset(latest.assets, /SHA256SUMS/i);

    return {
      available: true,
      version: (latest.tag_name || latest.name || "").replace(/^v/, ""),
      publishedAt: latest.published_at,
      releaseUrl: latest.html_url,
      downloadUrl: primary ? primary.browser_download_url : latest.html_url,
      downloadName: primary ? primary.name : null,
      sizeBytes: primary ? primary.size : null,
      sha256: primary ? digestToSha256(primary.digest) : null,
      checksumsUrl: checksums ? checksums.browser_download_url : null,
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
