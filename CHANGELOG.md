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

### Added

- **PDF Security.** Create a separate AES-256 protected copy with an open
  password and optional advisory print/copy restrictions, or save an unlocked
  copy of a protected PDF. RaioPDF includes current unsaved edits without changing the
  original, verifies the protected output before reporting success, and never
  stores the password.
- **Highlight-to-redact.** Redaction mode now has a "Select text" sub-mode: highlight
  text with the pointer and each line becomes a marked area, alongside the existing
  draw-a-box and search-text methods. It needs no full-document text extraction, so it
  also works on very large files where search-to-redact isn't available.

## [0.1.3] - 2026-07-12

Fourth public alpha. Headline: **two new front-matter tools for briefs** — build a court
**case caption / cover page**, and generate a **Table of Authorities** from the citations
in your brief — plus a round of reliability fixes, including restoring the batch and
packaging tools.

### Added

- **Table of Authorities.** Point RaioPDF at a brief and it finds the legal citations,
  groups them (cases, statutes, rules, and the rest), and builds a Table of Authorities
  with real page numbers and dot leaders. A review workspace lets you check and correct
  what it caught before you insert it — citation detection is assistive, so you stay in
  control. Runs entirely on your machine.
- **Case caption & cover page generator.** Build a court caption or cover page with live
  previews of several styles, then drop it onto the document.
- **A floating markup toolbar** that follows your work, so the annotation tools are within
  reach instead of pinned to the edge of the window.
- **"Email a report" button on error screens.** When something goes wrong, one click
  drafts an email in your own mail app with the details, so reporting a problem doesn't
  mean retyping what happened.
- **Set RaioPDF as your default PDF app.** The installer now registers a Windows file
  association, so you can open PDFs straight into RaioPDF by double-clicking them.

### Changed

- **Big PDFs now get the full toolset.** Large documents that open streamed (rather than
  fully into memory) can now run the same file-to-file operations — split, extract,
  compress, OCR, and the rest — instead of being limited to viewing.
- **Make Searchable keeps the searchable copy when a few pages have thin text over a
  scan.** When normal OCR skips pages that already carry a sliver of text over a scanned
  image, RaioPDF now hands you the searchable copy anyway with a light heads-up naming
  those pages (and pointing to Force OCR to rebuild them), instead of refusing the whole
  result and keeping the original.
- **A freshly OCR'd document now counts as unsaved,** so closing it prompts you to save
  first — the OCR work can't be discarded by accident.

### Fixed

- **The batch and packaging tools work again.** Production sets, batch cleanup, filing
  packets, and streamed binder/save-out — the "run one tool over a set of files" lane —
  were broken in every release up to now; they're restored.
- **Prepare for Filing no longer flattens filled forms and annotations** when it
  normalizes pages to letter size — your form fields and markups survive the resize.
- **No more silent loss of edits, or building the wrong file.** Document and tab state is
  tracked so edits and generated outputs can't quietly disappear or get crossed between
  open documents.
- **Running two copies of RaioPDF at once is safe.** Temporary-file cleanup only touches
  its own instance's files, each window keeps its own crash marker, and the background
  engine shuts down whenever a window closes.
- **The app stays responsive during file work.** File reads and writes moved off the
  interface thread, background engine calls time out instead of hanging, and a
  Bates-numbering resource leak was closed.
- Redaction and stamping now handle accented and other non-ASCII characters correctly,
  and a hidden Microsoft Word process left behind by an interrupted conversion is cleaned
  up.
- Plus various smaller bug fixes and polish across the app.

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
- **Cancel a long operation.** OCR, Prepare for Filing, and the Word conversions can now
  be cancelled mid-run — the work stops promptly and any tool it started (including a
  hidden Microsoft Word) is shut down, instead of leaving you to wait out a stuck run.

### Changed

- **Progress shows in a docked bar, not a blocking popup.** Long operations now report
  progress in a bar pinned to the bottom of the viewer, with a Cancel button, so your
  document stays visible and you never have to drag a dialog out of the way. Document-facts
  checks show as a loading overlay on the prep checklist instead of a bare spinner.

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

[Unreleased]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Macrify-LLC/raiopdf/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Macrify-LLC/raiopdf/releases/tag/v0.1.0
