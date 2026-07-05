#!/usr/bin/env node
/**
 * Generates the public /help section of the RaioPDF marketing site from the
 * precompiled help-content package that also powers the in-app Help panel.
 *
 * Source of truth: packages/help-content/dist/index.ts (built by
 * `pnpm --filter @raiopdf/help-content build` from packages/help-content/articles/*.md).
 * This script does not touch that markdown or its sanitized HTML — it only
 * lays the same `html` field into static pages and rewrites the in-app-only
 * `tool:<id>` links into real site URLs.
 *
 * The site has no build step of its own (site/index.html is committed,
 * hand-authored HTML), so the output of this script — site/help/*.html — is
 * committed too, like any other static asset. Re-run this script any time
 * packages/help-content/dist/index.ts changes:
 *
 *   node site/build-help.mjs
 *
 * URL scheme: flat files, `/help/` for the index and `/help/<id>.html` per
 * article (not `/help/<id>/index.html`) — this avoids depending on a static
 * host's directory-index behavior for every one of the 30 article routes,
 * while `/help/` itself relies only on the near-universal "serve index.html
 * for a directory" default (the same thing `/` already relies on for
 * site/index.html).
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpArticles } from "../packages/help-content/dist/index.ts";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(SITE_ROOT, "help");
const SITE_URL = "https://raio.macrify.me";

// Canonical group order + labels — mirrors apps/ui/src/components/HelpPanel.tsx's
// HELP_GROUPS exactly, so the public site and the in-app panel agree on how
// articles are categorized.
const GROUPS = [
  { id: "getting-started", label: "Getting Started" },
  { id: "edit", label: "Edit" },
  { id: "comment-ocr", label: "Comment & OCR" },
  { id: "organize", label: "Organize" },
  { id: "legal", label: "Legal" },
  { id: "preferences", label: "Preferences" },
];

async function main() {
  const byGroup = groupArticles(helpArticles);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  await writeFile(path.join(OUT_DIR, "index.html"), renderIndexPage(byGroup), "utf8");

  let articleCount = 0;
  for (const group of GROUPS) {
    const list = byGroup.get(group.id) ?? [];
    for (let i = 0; i < list.length; i += 1) {
      const article = list[i];
      const prev = list[i - 1] ?? null;
      const next = list[i + 1] ?? null;
      const html = renderArticlePage({ article, group, prev, next });
      await writeFile(path.join(OUT_DIR, `${article.id}.html`), html, "utf8");
      articleCount += 1;
    }
  }

  const written = await readdir(OUT_DIR);
  console.log(
    `[build-help] wrote ${written.length} files to site/help/ ` +
      `(1 index + ${articleCount} articles, ${helpArticles.length} total in source).`,
  );

  if (articleCount !== helpArticles.length) {
    console.warn(
      "[build-help] warning: an article's group id isn't in the GROUPS list above, so it " +
        "was dropped from the generated site. Add the missing group id to GROUPS.",
    );
  }
}

/** Buckets + sorts articles by group, in the canonical GROUPS order. */
function groupArticles(articles) {
  const byGroup = new Map(GROUPS.map((g) => [g.id, []]));

  for (const article of articles) {
    if (!byGroup.has(article.group)) {
      continue; // surfaced via the articleCount mismatch warning in main()
    }
    byGroup.get(article.group).push(article);
  }

  for (const list of byGroup.values()) {
    list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  return byGroup;
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

/**
 * The compiled article HTML links sibling articles as `tool:<id>` — that
 * scheme deep-links the in-app Help panel and means nothing on the web.
 * Rewrite every one to the corresponding static page, and open external
 * https links in a new tab.
 */
function rewriteLinks(html) {
  return html
    .replace(/href="tool:([a-zA-Z0-9-]+)"/g, (match, id) => `href="/help/${id}.html"`)
    .replace(/<a href="(https:[^"]*)">/g, '<a href="$1" target="_blank" rel="noopener noreferrer">');
}

/**
 * Every article ends with a mandatory "## Related" section (STYLE.md's
 * "Shape of a good article" #5) — `<h2>Related</h2><ul>...</ul>` as the very
 * last thing in the compiled HTML. Split it out so it can be rendered as its
 * own visually distinct "Related" panel instead of blending into the article
 * prose, without altering a single word of the (human-approved) content.
 */
function splitRelated(html) {
  const marker = "<h2>Related</h2>";
  const idx = html.lastIndexOf(marker);

  if (idx === -1) {
    return { body: html, related: "" };
  }

  return { body: html.slice(0, idx), related: html.slice(idx) };
}

// ---------------------------------------------------------------------------
// Shared page shell
// ---------------------------------------------------------------------------

function renderShell({ title, description, canonicalPath, bodyHtml, extraBodyEnd = "" }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttribute(description)}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="RaioPDF">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:title" content="${escapeAttribute(title)}">
<meta property="og:description" content="${escapeAttribute(description)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeAttribute(title)}">
<meta name="twitter:description" content="${escapeAttribute(description)}">

<link rel="stylesheet" href="/shared/reset.css">
<link rel="stylesheet" href="/shared/help.css">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Newsreader:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">

<link rel="icon" type="image/svg+xml" href="/assets/raiopdf/raiopdf-favicon.svg">
<link rel="icon" type="image/png" sizes="545x545" href="/assets/raiopdf/raiopdf-favicon.png">
<link rel="apple-touch-icon" href="/assets/raiopdf/raiopdf-favicon.png">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<div class="status-bar">
  <p><strong>Public alpha</strong> — Windows build available from GitHub Releases.
    <a href="https://github.com/Macrify-LLC/raiopdf/releases" target="_blank" rel="noopener">Get the latest release</a>.</p>
</div>

${renderNav()}

${bodyHtml}

${renderFooter()}
${extraBodyEnd}</body>
</html>
`;
}

function renderNav() {
  return `<header class="nav">
  <div class="nav__inner">
    <a class="nav__brand" href="/">
      <img class="nav__logo" src="/assets/raiopdf/raiopdf-wordmark-full.svg" alt="RaioPDF — home" width="332" height="80">
    </a>
    <nav class="nav__links" aria-label="Primary">
      <a href="/#philosophy">Why</a>
      <a href="/#inputs">How it works</a>
      <a href="/#outcomes">Features</a>
      <a href="/#honest">What it isn't</a>
      <a href="/help/" aria-current="page">Help</a>
      <a class="nav__cta" href="/#top">Download</a>
    </nav>
  </div>
</header>`;
}

function renderFooter() {
  return `<footer class="footer">
  <div class="footer__inner">
    <div class="footer__brand">
      <a href="https://macrify.me" target="_blank" rel="noopener" aria-label="Macrify">
        <img src="/assets/macrify-wordmark-light.png" alt="Macrify">
      </a>
      <p class="footer__license">
        Published as a public good and also to swag on em by
        <a href="https://macrify.me" target="_blank" rel="noopener">Macrify LLC</a>.
        Licensed under GPL-3.0. Bundles the MIT-licensed Stirling-PDF engine and other
        third-party components under their own licenses.
      </p>
    </div>
    <div class="footer__col">
      <h4>No telemetry, ever</h4>
      <p class="footer__telemetry">
        This page runs no analytics, sets no tracking cookies, and profiles no one. The only
        thing it fetches on its own is a single anonymous, unauthenticated call to GitHub's
        public API for the current release — the same thing your browser would show if you
        visited the repo directly.
      </p>
      <div class="footer__support">
        <a href="https://github.com/Macrify-LLC/raiopdf/issues" target="_blank" rel="noopener">Report a bug or request a feature — GitHub Issues</a>
        <a href="mailto:support@macrify.me">support@macrify.me (best-effort, community-supported)</a>
      </div>
    </div>
  </div>
  <div class="footer__bottom">
    <span>© 2026 Macrify LLC. RaioPDF is free and open source under GPL-3.0.</span>
    <a href="https://github.com/Macrify-LLC/raiopdf" target="_blank" rel="noopener">github.com/Macrify-LLC/raiopdf</a>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// /help/ index page
// ---------------------------------------------------------------------------

function renderIndexPage(byGroup) {
  const totalCount = helpArticles.length;
  const nonEmptyGroups = GROUPS.filter((g) => (byGroup.get(g.id) ?? []).length > 0);

  const searchIndex = {};
  for (const article of helpArticles) {
    searchIndex[article.id] = {
      title: article.title,
      summary: article.summary,
      body: article.plainText,
    };
  }

  const groupsHtml = nonEmptyGroups
    .map((group) => renderGroupSection(group, byGroup.get(group.id) ?? []))
    .join("\n");

  const body = `<main id="main">
  <section class="help-hero">
    <div class="container">
      <nav class="help-breadcrumb" aria-label="Breadcrumb">
        <a href="/">RaioPDF</a>
        <span class="help-breadcrumb__sep" aria-hidden="true">/</span>
        <span class="help-breadcrumb__current" aria-current="page">Help</span>
      </nav>
      <div class="help-hero__head">
        <span class="eyebrow">RaioPDF Help</span>
        <h1>Find out how to do anything in RaioPDF</h1>
        <p class="help-hero__subhead">
          Search or browse every article below — the same help that ships inside the app,
          organized by what you're trying to do.
        </p>
        <p class="help-hero__homelink">
          New here? <a href="/#philosophy">Read why RaioPDF exists →</a>
        </p>
      </div>

      <div class="help-search" role="search" aria-label="Search help articles">
        <div class="help-search__field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <label for="help-search-input" class="visually-hidden">Search help articles</label>
          <input type="search" id="help-search-input" placeholder="Search help articles" autocomplete="off" aria-describedby="help-search-count">
        </div>
        <p class="help-search__count" id="help-search-count" aria-live="polite">${totalCount} articles</p>
      </div>
    </div>
  </section>

  <section class="help-groups" aria-label="Help articles by category">
    <div class="container">
      <div class="help-empty" id="help-empty" data-visible="false">
        <p>No articles match that search.</p>
        <button type="button" id="help-clear-search">Clear search</button>
      </div>
      <div id="help-groups-list">
${groupsHtml}
      </div>
    </div>
  </section>
</main>`;

  const searchScript = `<script id="help-search-data" type="application/json">${safeJsonForScript(searchIndex)}</script>
<script>
(function () {
  "use strict";

  var data = JSON.parse(document.getElementById("help-search-data").textContent);
  var input = document.getElementById("help-search-input");
  var countEl = document.getElementById("help-search-count");
  var emptyEl = document.getElementById("help-empty");
  var clearBtn = document.getElementById("help-clear-search");
  var groups = Array.prototype.slice.call(document.querySelectorAll(".help-group"));
  var cards = Array.prototype.slice.call(document.querySelectorAll(".help-card"));
  var totalCount = cards.length;

  function normalize(value) {
    return (value || "").toLowerCase().replace(/\\s+/g, " ").trim();
  }

  // Same rank order as the in-app Help panel (apps/ui HelpPanel.tsx): a
  // title match outranks a summary match, which outranks a body-only match.
  function rank(id, query) {
    var entry = data[id];
    if (!entry) return 0;
    if (!query) return 1;
    if (normalize(entry.title).indexOf(query) !== -1) return 1;
    if (normalize(entry.summary).indexOf(query) !== -1) return 2;
    if (normalize(entry.body).indexOf(query) !== -1) return 3;
    return 0;
  }

  function applyFilter() {
    var query = normalize(input.value);
    var visibleCount = 0;

    cards.forEach(function (card) {
      var id = card.getAttribute("data-id");
      var cardRank = rank(id, query);
      var matched = cardRank > 0;
      card.hidden = !matched;
      card.style.order = query ? cardRank : card.getAttribute("data-order");
      if (matched) visibleCount += 1;
    });

    groups.forEach(function (group) {
      var visibleInGroup = group.querySelectorAll(".help-card:not([hidden])").length;
      group.setAttribute("data-visible", visibleInGroup > 0 ? "true" : "false");
    });

    emptyEl.setAttribute("data-visible", visibleCount === 0 ? "true" : "false");
    countEl.textContent = query
      ? (visibleCount === 1 ? "1 of " + totalCount + " articles" : visibleCount + " of " + totalCount + " articles")
      : (totalCount === 1 ? "1 article" : totalCount + " articles");
  }

  input.addEventListener("input", applyFilter);
  clearBtn.addEventListener("click", function () {
    input.value = "";
    applyFilter();
    input.focus();
  });

  applyFilter();
})();
</script>`;

  return renderShell({
    title: "RaioPDF Help",
    description:
      "Help articles for every RaioPDF tool — getting started, redaction, Bates numbering, OCR, e-filing prep, and more. Search or browse by category.",
    canonicalPath: "/help/",
    bodyHtml: body,
    extraBodyEnd: searchScript,
  });
}

function renderGroupSection(group, articles) {
  const cardsHtml = articles
    .map(
      (article, i) => `        <a class="help-card" href="/help/${article.id}.html" data-id="${escapeAttribute(article.id)}" data-order="${i}">
          <h3>${escapeHtml(article.title)}</h3>
          <p>${escapeHtml(article.summary)}</p>
          <span class="help-card__arrow" aria-hidden="true">→</span>
        </a>`,
    )
    .join("\n");

  return `      <section class="help-group" id="group-${group.id}" data-group="${group.id}" data-visible="true">
        <div class="help-group__head">
          <h2>${escapeHtml(group.label)}</h2>
          <span class="help-group__count">${articles.length}</span>
        </div>
        <div class="help-group__rule" aria-hidden="true"></div>
        <div class="help-group__grid">
${cardsHtml}
        </div>
      </section>`;
}

// ---------------------------------------------------------------------------
// /help/<id>.html article pages
// ---------------------------------------------------------------------------

function renderArticlePage({ article, group, prev, next }) {
  const rewritten = rewriteLinks(article.html);
  const { body: bodyBeforeRelated, related } = splitRelated(rewritten);
  const { html: body, toc } = addHeadingIds(bodyBeforeRelated);

  const relatedHtml = related
    ? `\n        <div class="help-related" id="related">${related}</div>`
    : "";

  if (related) {
    toc.push({ id: "related", text: "Related" });
  }

  const pagerHtml = renderPager(prev, next);
  const tocHtml = renderToc(toc);

  const bodyHtml = `<main id="main">
  <section class="help-article-section">
    <div class="container">
      <nav class="help-breadcrumb" aria-label="Breadcrumb">
        <a href="/">RaioPDF</a>
        <span class="help-breadcrumb__sep" aria-hidden="true">/</span>
        <a href="/help/">Help</a>
        <span class="help-breadcrumb__sep" aria-hidden="true">/</span>
        <a href="/help/#group-${group.id}">${escapeHtml(group.label)}</a>
        <span class="help-breadcrumb__sep" aria-hidden="true">/</span>
        <span class="help-breadcrumb__current" aria-current="page">${escapeHtml(article.title)}</span>
      </nav>

      <div class="help-article-layout">
        <article class="help-article">
          <div class="help-article__body">${body}</div>${relatedHtml}
${pagerHtml}
        </article>
${tocHtml}
      </div>
    </div>
  </section>
</main>`;

  return renderShell({
    title: `${article.title} — RaioPDF Help`,
    description: article.summary,
    canonicalPath: `/help/${article.id}.html`,
    bodyHtml,
  });
}

/**
 * Gives every `<h2>` in the article body a stable anchor id and collects a
 * table of contents from them. Safe because every heading in the compiled
 * help content is plain text (verified against dist/index.ts — no nested
 * `<strong>`/`<em>` inside an `<h2>`, no duplicate headings within one
 * article), so a non-greedy text-only match is enough.
 */
function addHeadingIds(bodyHtml) {
  const toc = [];

  const html = bodyHtml.replace(/<h2>([^<]*)<\/h2>/g, (match, text) => {
    const id = slugify(text);
    toc.push({ id, text });
    return `<h2 id="${id}">${text}</h2>`;
  });

  return { html, toc };
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderToc(toc) {
  if (toc.length === 0) {
    return "";
  }

  const items = toc
    .map((entry) => `          <li><a href="#${entry.id}">${escapeHtml(entry.text)}</a></li>`)
    .join("\n");

  return `        <aside class="help-toc" aria-label="On this page">
          <p class="help-toc__label">On this page</p>
          <ul>
${items}
          </ul>
        </aside>`;
}

function renderPager(prev, next) {
  if (!prev && !next) {
    return "";
  }

  const prevHtml = prev
    ? `          <a class="help-pager__link help-pager__link--prev" href="/help/${prev.id}.html">
            <span class="help-pager__eyebrow">← Previous</span>
            <span class="help-pager__title">${escapeHtml(prev.title)}</span>
          </a>`
    : "";

  const nextHtml = next
    ? `          <a class="help-pager__link help-pager__link--next" href="/help/${next.id}.html">
            <span class="help-pager__eyebrow">Next →</span>
            <span class="help-pager__title">${escapeHtml(next.title)}</span>
          </a>`
    : "";

  return `        <nav class="help-pager" aria-label="More in this category">
${[prevHtml, nextHtml].filter(Boolean).join("\n")}
        </nav>`;
}

// ---------------------------------------------------------------------------
// Small escaping helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

/** JSON-stringify for embedding inside a <script> tag, without a stray `</script>` breaking out. */
function safeJsonForScript(value) {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
