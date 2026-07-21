# macOS Word export/import (PDF ↔ .docx via installed Word) — Roadmap plan (v1, draft)

Goal: bring the two existing Word features — **PDF → Word (.docx) reflow export** and
**Import Word Document (.docx → PDF)** — to the macOS build, keeping the exact product
contract already shipped on Windows: conversions run through the user's own installed
Microsoft Word, fully local, labeled experimental, with the menu items grayed-and-explained
when Word can't run. No LibreOffice, no bundled converter, no cloud.

Non-goals: bundling any conversion engine; supporting Word older than 16.31 (the first
Word for Mac that opens PDFs); Pages/TextEdit fallbacks; changing conversion fidelity or
the Windows implementation's behavior.

## Where we are

- All Word logic lives in `crates/engine-sidecar-core/src/word_ops.rs`. The public
  surface (`word_capability`, `convert_pdf_to_docx`, `convert_docx_to_pdf`,
  `WordCapability`, error codes) is platform-neutral; everything real is `#[cfg(windows)]`
  (PowerShell + COM: `Documents.Open` → `SaveAs2(…, 16)` / `ExportAsFixedFormat`).
- Non-Windows returns `WordCapabilityState::NotApplicable` and `WORD_NOT_SUPPORTED`.
- The Tauri command layer (`apps/shell/src-tauri/src/word.rs`), grants, capability cache,
  UI gating (`apps/ui/src/lib/wordCapability.ts`, `wordReflow.ts`, `wordImport.ts`,
  Settings dialog) are already platform-agnostic and need only new states/copy.
- Windows has elaborate timeout-kill machinery (attributable hidden WINWORD pid +
  windowless-process fallback). This machinery must NOT be ported — macOS semantics
  differ (see Phase 1).

## Phase 0 — Spike on real hardware (gate for everything else)

Timebox: 2–3 days on an Apple Silicon Mac with Microsoft 365 Word installed.
Deliverable: a short findings note appended to this plan; go/no-go per direction.

Validate, with throwaway `osascript` scripts:

1. **PDF open + convert works headlessly.** `open` on a PDF via Word's AppleScript
   dictionary triggers the same reflow conversion as File > Open, with the conversion
   alert suppressible (Word's `display alerts` setting, and/or opening with
   `confirm conversions false`). Confirm no modal ever blocks an unattended run.
2. **Save-as to our chosen output path succeeds.** Word for Mac is sandboxed; verify
   `save as … file format format document` (and `format PDF` for import) can write to a
   temp directory we control, or find the writable location (e.g. Word's own container /
   a path pre-created by us) and plan a save-then-move. This is the highest-risk unknown.
3. **TCC flow.** First Apple Event from a signed RaioPDF build prompts
   "RaioPDF wants to control Microsoft Word"; denial yields error −1743. Confirm the
   prompt appears (requires `NSAppleEventsUsageDescription` in Info.plist) and that a
   denial is detectable and distinguishable from other failures.
4. **Detection without launching.** Enumerate Word install + version with no side
   effects: `LSCopyApplicationURLsForBundleIdentifier("com.microsoft.Word")` (or
   `mdfind` with a filesystem fallback), read `CFBundleShortVersionString`, gate ≥ 16.31.
5. **Shared-instance behavior.** With the user's Word already open on a document:
   our scripted open/close doesn't disturb their windows, `close … saving no` closes only
   our document, and Word quit policy (quit only if we launched it) is workable.
6. **Cancellation.** Mid-conversion, closing our document from a second script is
   possible; killing the Word process is never acceptable (shared instance).

If (1) or (2) fails for PDF → Word but works for .docx → PDF, ship import-only on macOS
and keep export grayed with an honest reason.

## Phase 1 — `engine-sidecar-core`: macOS automation module

The `#[cfg(target_os = "macos")]` sibling of the Windows code, same public surface.

- **Capability probe.** Cheap path: detect install + version (no launch) →
  `NotDetected` / `Detected` (version < 16.31 → `Unavailable` with reason). Forced path:
  run a minimal Apple Event round-trip → `Available` / `Unavailable`, mapping −1743 to a
  new automation-consent reason ("RaioPDF isn't allowed to control Word — System
  Settings → Privacy & Security → Automation").
- **Conversion runner.** Spawn `osascript` with the script from a temp file and the
  input JSON path as argv (no string interpolation of user paths — same injection-safe
  shape as the PowerShell side). Keep the `@@RAIOPDF_WORD_RESULT@@` marker-line JSON
  protocol and stdout/stderr drain threads so `parse_word_script_stdout` and its tests
  are shared across platforms.
- **Scripts.** PDF → DOCX: suppress alerts, open PDF, `save as … format document`,
  close saving no. DOCX → PDF: open, honor `MarkupMode` (final vs. show markup) if
  Word for Mac's dictionary supports revision-view control — spike decides; if not,
  export final-only and surface that honestly in UI copy. Scrub exported PDF metadata
  through the existing `scrub_metadata` path, same as Windows.
- **Timeout & cancel semantics (differs from Windows by design).** On timeout or
  cooperative cancel: tell Word to close our document (saving no); quit Word only if the
  probe recorded that Word was not running when we started; never `kill -9` Word. Delete
  partial outputs, same contract as Windows.
- **Single-flight.** Keep the automation mutex — one Word conversion at a time.
- **Error mapping.** Map macOS failure surface (AppleScript error codes, sandbox write
  denials, password-protected PDFs, conversion failures) onto the existing
  `ERR_WORD_*` codes; add codes only if a state genuinely has no Windows analog
  (automation consent denied is the known one).

## Phase 2 — Shell integration (`apps/shell`)

- Add `NSAppleEventsUsageDescription` to the macOS bundle Info.plist via
  `tauri.conf.json` (copy states the local-only promise: "RaioPDF controls your
  installed Microsoft Word to convert documents on this Mac. Nothing is uploaded.").
- `word.rs` commands work unchanged; wire the new capability reason strings through
  diagnostics (`word_error` app.log events already exist and are platform-neutral).
- Confirm the hardened-runtime entitlements for the notarized build permit sending
  Apple Events (`com.apple.security.automation.apple-events` if sandboxed/hardened
  runtime requires it) — coordinate with `docs/SIGNING.md`; signing stays
  maintainer-local.

## Phase 3 — UI (`apps/ui`)

- No architecture change: `notApplicable` simply stops occurring on macOS. Menu items
  ungray by the same `isWordPresent` / click-time `available` gates.
- New copy: automation-consent-denied guidance (with the System Settings path), the
  version-too-old reason, and — if spike says markup view isn't controllable —
  import-dialog copy dropping the final/markup choice on macOS.
- Settings dialog: Word capability row already renders state + reason; verify the new
  reasons read well and the "check again" (force) path re-triggers the TCC prompt
  usefully after the user flips the toggle.

## Phase 4 — Tests & canaries

- Unit: script-outcome parsing stays shared; add macOS-only tests for capability
  parsing, version gating, error mapping, and the quit-policy decision (pure functions,
  CI-safe on Linux/macOS runners without Word).
- Canaries: macOS siblings of the three Windows self-gating canaries (docx→pdf,
  pdf→docx, round-trip) that skip cleanly when Word isn't installed/consented — they run
  on maintainer hardware, not CI.
- `pnpm canary` run on a real Mac before release; paste summary line in the PR per
  CONTRIBUTING.md.
- Manual test matrix (release checklist addition): Microsoft 365 Word, perpetual
  Word 2021/2024, Word absent, consent denied → re-granted, user's Word already open
  with unsaved work, password-protected PDF, scanned PDF (OCR-first prompt path).

## Phase 5 — Docs & release

Same-PR rule (per repo guide): README feature tables (drop the Windows-only caveat or
add the macOS row), `packages/help-content/articles/pdf-to-word.md` +
`word-import` article (state the Word-for-Mac ≥ 16.31 requirement and the one-time
automation permission prompt), CHANGELOG entry, and `site/shared/COPY.md` only if the
landing page ever claimed platform scope (verify; do not add new claims).

## Sequencing & estimate

Phase 0 gates all else (2–3 days). Phases 1–2 together are the bulk (4–6 days).
Phases 3–5 are small (2–3 days combined) but must land in the same PR as 1–2 per the
docs-honesty rule. Realistic total: ~2 weeks elapsed including real-hardware validation.
Ship as one feature PR (plus the spike notes PR-less), targeting the next minor alpha.

## Risks

| Risk | Mitigation |
|---|---|
| Sandboxed Word can't write to our output path | Spike item 2; save-then-move via a Word-writable location |
| Conversion alert not suppressible on PDF open | Spike item 1; if hard-blocked, ship import-only on macOS |
| TCC denial looks like generic failure | Explicit −1743 mapping + Settings guidance copy |
| User's own Word disturbed (closed doc / killed process) | No process kills ever; close only our document; quit only if we launched Word |
| Markup mode not scriptable on Mac | Final-only export with honest UI copy |
| Perpetual-license Word behaves differently | Test matrix row; version/edition in capability reason |
