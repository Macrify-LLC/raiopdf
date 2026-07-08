# Changelog

All notable, user-facing changes to RaioPDF are recorded here, newest first. RaioPDF is
a public **alpha** — expect rough edges, and please report anything that trips you up.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions match the app's release tags on GitHub. Dates are the day the signed installer
was published.

Every Windows installer is signed (Certum). Because the certificate is still building
reputation, Windows SmartScreen may show a "Run anyway" prompt on first launch — that
fades as download volume accrues.

## [Unreleased]

## [0.1.2] - 2026-07-08

Third public alpha. Headline: **Word support, both directions** — turn a PDF into an
editable Word document, or bring a Word document into RaioPDF as a PDF — all on your own
machine, nothing uploaded.

### Added

- **Export a PDF to editable Word (.docx).** Reflow a PDF back into an editable Word
  document, from the document menu or as a standalone tool. Scanned PDFs get an offer to
  OCR first so there's real text to export. Experimental — check the result before you
  rely on it.
- **Import a Word document (.docx) — a first-class "Import Word Document" menu item.**
  Open a `.docx` straight into RaioPDF as a PDF (you no longer have to add it into an
  already-open document). Before converting, RaioPDF scans for leftover tracked changes
  and comments so a redline doesn't go out by accident.
- **Word features require Microsoft Word, and say so.** Both directions run through your
  own installed copy of Microsoft Word — nothing is uploaded. If Word isn't installed the
  menu items gray out and tell you why, and both are labeled *experimental* since Word's
  conversion is approximate.
- **Update notifications.** An unobtrusive pill appears when a new version is available;
  downloading and installing it stays an explicit, one-tap-at-a-time choice — nothing
  updates behind your back.
- **Prepare for Filing shows per-page OCR progress** instead of a single indefinite
  spinner, so you can see a long scan actually moving.

### Changed

- **Prepare for Filing always produces your file.** Court/portal rules and the OCR
  quality check are now **advisory** — RaioPDF still warns you, loudly, when a file is
  over a portal's size cap or a page didn't come out cleanly searchable, but it never
  refuses to save. You decide whether to file it.
- **Plainer error and status messages.** Error text, progress toasts, and tooltips were
  rewritten so they read in everyday language and no longer leak the names of internal
  engine components you never chose.
- **Honest PDF/A wording.** RaioPDF now distinguishes a document that genuinely claims
  PDF/A conformance from one that merely passed a check, so the status it shows you means
  what it says.

### Fixed

- Large PDFs opened by drag-and-drop can now run Prepare for Filing (they're staged to a
  temporary working copy on demand).
- Saving edited PDFs back to disk works reliably again.
- Guarded against a stale engine start that could leave an operation hanging.
- Output packages are now written atomically — an interrupted run no longer leaves a
  half-written package behind.
- Fixed an intermittent engine connection failure on Windows (socket error 10035).
- Find & Replace no longer stalls on the first use right after launch.
- Clearer diagnostics when something does go wrong, and a fix for a misleading
  "file not found" message that was really a different problem.
- Plus various smaller bug fixes and polish across the app.

## [0.1.1] - 2026-07-07

Second public alpha. Mostly annotation and editing improvements, plus a few fixes.

### Added

- A right-click menu for annotations that works in every tool mode: pin, delete, or edit
  text on a callout / text box / shape / image; remove a highlight, underline, or
  strike-through; or copy and mark up selected text without switching tools.
- Callouts and text boxes are editable in place — double-click (or right-click → Edit
  text) to change the text. The callout keeps pointing at the same spot.
- Pin an annotation to lock it in place and make it click-through; pinned shapes no longer
  get deleted by a stray click.
- Text-selection highlight / underline / strike-through, with multi-column selections no
  longer painting the gap between columns.
- Movable shapes and signatures; text-box fill color.
- Find & Replace: replace selected text.
- Organize Pages: selectable exhibit cover styles and Insert Slip Sheet.

### Fixed

- Help panel scrolls when its content overflows.
- Landing page leads with features and adds a short FAQ.

## [0.1.0] - 2026-07-06

First public alpha of RaioPDF — a free, open-source, fully on-device PDF suite for law
firms. No cloud, no account, no telemetry, no AI. Everything, including OCR, runs on your
own machine. Windows only for now (macOS later).

### Added

- Day-to-day PDF work: view, organize, OCR, annotate, fill forms, sign.
- Legal workflows: e-filing prep with rule-cited preflight, exhibit binders, verified
  redaction (content actually removed, then confirmed), Bates numbering, a Fla. R. Jud.
  Admin. 2.425 sensitive-info scanner (assistive — always verify), and metadata scrubbing.
- An off-by-default MCP connector so RaioPDF can talk to your own AI agents; no AI runs
  inside the app itself.

[Unreleased]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Macrify-LLC/raiopdf/releases/tag/v0.1.0
