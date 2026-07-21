# macOS Word export/import (PDF ↔ .docx via installed Word) — Roadmap plan (v2, post-critique)

> v2 (2026-07-21): revised after adversarial review. Material changes from v1: the spike
> is split into terminal-testable vs signed-bundle-only items (TCC attribution can only
> be validated from a signed, hardened-runtime RaioPDF build — never in CI); the
> cooperative-cancel claim is corrected (Word conversions are timeout-only in the current
> code — no job token is threaded through `word.rs`; the CHANGELOG 0.1.2 cancel claim
> needs separate investigation); the third Word surface (`convert_docx_for_add` batch
> import) is now in scope; the Apple Events entitlement needs a per-binary split so the
> MCP/engine-host sidecars don't inherit it; estimate raised to 3–4 weeks.

Goal: bring the existing Word features — **PDF → Word (.docx) reflow export**,
**Import Word Document (.docx → PDF)**, and the **batch "add Word documents" flow** — to
the macOS build, using the user's own installed Microsoft Word, fully local, labeled
experimental, with menu items grayed-and-explained when Word can't run. No LibreOffice,
no bundled converter, no cloud.

Non-goals: bundling any conversion engine; Pages/TextEdit fallbacks; changing the
Windows implementation's behavior; hidden-Word parity with Windows (impossible on macOS
— see "UX contract" below).

## Where we are

- All Word logic lives in `crates/engine-sidecar-core/src/word_ops.rs`. The public
  surface (`word_capability`, `convert_pdf_to_docx`, `convert_docx_to_pdf`,
  `WordCapability`, error codes) is platform-neutral; everything real is
  `#[cfg(windows)]` (PowerShell + COM: read-only `Documents.Open` → `SaveAs2(…, 16)` /
  `ExportAsFixedFormat`). Non-Windows returns `NotApplicable` / `WORD_NOT_SUPPORTED`.
- **Three** integration surfaces, not two: `word_convert_docx` and
  `word_reflow_pdf_to_docx` (`apps/shell/src-tauri/src/word.rs`), plus
  `convert_docx_for_add` (`apps/shell/src-tauri/src/lib.rs`) — a sequential batch loop
  with per-file progress events (`docx-convert:progress` phase `"startingWord"`,
  `docx-convert:file-done`), driven by `apps/ui/src/lib/readFileForAdd.ts`. All three
  ungray automatically the moment capability stops returning `notApplicable`.
- Conversions are **timeout-only** (120 s, `run_word_powershell`); the `PathOpJobs`
  cooperative-cancel system is wired into OCR/prepare-filing, not Word. The Windows
  timeout-kill machinery (attributable WINWORD pid + windowless-process fallback) must
  NOT be ported — macOS scripts a shared visible Word instance.
- Open item to investigate (independent of this plan, flagged during review):
  CHANGELOG 0.1.2 says Word conversions can be cancelled mid-run; the current command
  surface accepts no job token. Reconcile the claim or the code.

## macOS UX contract (differs from Windows by design)

Windows runs an invisible dedicated COM instance. Word for Mac has no hidden-instance
equivalent: conversions open a real document window in the user's shared, visible Word.
The contract we ship and document honestly:

- Word may launch and become visible during a conversion; UI copy and the help articles
  say so ("Word will open briefly to do the conversion").
- We always hand Word a **temp copy** of the input, never the user's original — this
  prevents mid-conversion user edits corrupting output, avoids `~$` lock/AutoRecovery
  artifacts landing in synced client folders, and keeps `ensure_unchanged` honest.
- Output is saved to a Word-writable staging location, then moved to the destination.
- We never kill the Word process. On timeout we close our document (`saving no`); we
  quit Word only if it was not running when we started. Across the batch flow, one
  launch is reused and quit once at the end (if we launched it).
- The capability probe must not cause a visible launch-and-quit on top of the
  conversion's own launch (no double cold-launch on one click): the forced probe on
  macOS checks the bundle version without launching, sends an attach-only Apple Event
  when Word is already running, and otherwise defers the live check to the conversion
  itself (which reports consent/automation failures with the same error codes).
- After a TCC denial, macOS never re-prompts. The "check again" path and all copy must
  direct the user to System Settings → Privacy & Security → Automation, not imply that
  retrying will re-ask.

## Phase 0 — Spike (gate for everything else)

Apple Silicon Mac, Microsoft 365 Word installed. Deliverable: findings appended here;
go/no-go per direction. Two tracks with different tooling:

**Track A — terminal scripts (attribution-independent Word scriptability):**

1. **The 16.31 claim itself.** Verify Word for Mac's AppleScript dictionary can drive
   the PDF open/convert path at all (the dictionary predates PDF reflow; the manual
   File > Open path existing does not prove scriptability), and on which
   versions/licenses. Explicitly test: Microsoft 365 vs perpetual (2021/2024), and
   whether PDF reflow is subscription-gated.
2. **Headless-enough conversion.** `open` on a (temp-copied) PDF converts with alerts
   suppressed (`display alerts`/`confirm conversions`); no modal blocks an unattended
   run; unlicensed/view-only Word: what the version probe reports vs what save does.
3. **Save-as targets.** Where sandboxed Word can write (`save as … format document` /
   `format PDF`): our temp dir directly, or which staging location + move.
4. **Shared-instance safety.** With the user's Word open on a document: our open/close
   disturbs nothing; `close … saving no` closes only our document; quit policy works.
5. **Timing on realistic inputs.** Conversion time on 100+ page legal PDFs vs the
   AppleEvent reply timeout (−1712, ~2 min default). Determine the `with timeout`
   value the scripts need and how the runner timeout coordinates above it.
6. **Multi-install behavior.** With two Word copies installed, confirm which one
   `tell application id "com.microsoft.Word"` targets, so the version gate reads the
   same install that will be scripted.

**Track B — signed-bundle items (requires the maintainer signing machine; CI can never
cover these — `docs/SIGNING.md`, CI builds unsigned):**

7. **TCC attribution and prompting.** From a signed, hardened-runtime RaioPDF build
   carrying the candidate Info.plist + entitlement changes (Phase 2 artifacts —
   build via the release pipeline or a minimal signed harness): does spawning
   `/usr/bin/osascript` as a child attribute the consent prompt to RaioPDF
   (responsibility inheritance)? Does the missing `com.apple.security.automation.apple-events`
   entitlement produce a **silent −1743 with no prompt**? Is `NSAppleEventsUsageDescription`
   honored? Ad-hoc dev builds (`pnpm dev:shell`) do not answer this — results don't
   transfer.
8. **Consent-dialog race.** First-ever conversion blocks inside the AE send while the
   TCC dialog is up; confirm the runner's timeout doesn't expire the op under the
   user's nose, and design the first-run state accordingly.

If PDF → Word fails but .docx → PDF works, ship import-only on macOS with an honest
grayed reason.

## Phase 1 — `engine-sidecar-core`: macOS automation module

The `#[cfg(target_os = "macos")]` sibling, same public surface.

- **Capability probe.** Cheap path: locate Word + version with no launch — needs a
  small FFI/dependency decision (`objc2`/`core-foundation` for LaunchServices, noting
  `LSCopyApplicationURLsForBundleIdentifier` is deprecated) with a fixed-path
  fallback (`/Applications/Microsoft Word.app`), because `mdfind` fails on managed
  Macs with Spotlight disabled — exactly the law-firm fleet. Version gate per spike
  item 1 findings, read from the install that will actually be targeted (spike item 6).
  States: `NotDetected` / `Detected` / `Unavailable` (too old, or the new
  automation-consent-denied reason mapped from −1743) / `Available`.
- **Conversion runner.** Spawn `osascript` with the script from a temp file and the
  input JSON path as argv (no interpolation of user paths). Language choice per spike
  (JXA has native JSON; AppleScript needs Foundation) — decide once, both scripts.
  Stream discipline: the result marker must go to stdout (AppleScript `log` writes to
  stderr); keep the drain threads.
- **What's shared vs new.** Shared: the `@@RAIOPDF_WORD_RESULT@@` result-line JSON and
  `parse_word_script_stdout` + its tests (`winword_pid` stays `None` — the PID marker
  is Windows-only attribution machinery; do not port it). New: a macOS error
  classifier (the Windows one lives inside the PowerShell script keyed to COM message
  text; `word_error_code()` is `#[cfg(windows)]`), mapping AppleScript/AE errors —
  −1743 consent, −1712 AE timeout (distinct from our runner timeout), sandbox write
  denial, password-protected input, license-blocked save — onto `ERR_WORD_*` codes,
  adding codes only where no Windows analog exists.
- **Input/output handling.** Temp-copy input before Word sees it; staging save +
  move per spike item 3; scrub exported PDF metadata via the existing `scrub_metadata`
  path, same as Windows.
- **Timeout semantics.** Honest scoping: **timeout-only, like Windows today** — no
  cooperative-cancel claim. Scripts use `with timeout of N` sized from spike item 5;
  the Rust runner timeout sits above it; first-run consent state exempted from the
  race (spike item 8). On timeout: close our document saving no, quit only if we
  launched Word, delete partial outputs. (Threading `PathOpJobs` cancel tokens into
  Word commands on both platforms is a separate, explicitly-scoped follow-up if wanted.)
- **Batch (`convert_docx_for_add`).** Reuse one Word launch across the batch; quit
  once at the end if we launched it; per-file errors don't abort the batch (match
  current Windows per-file semantics); progress-phase copy reviewed ("Starting Word…"
  is wrong when Word was already running).
- **Single-flight.** Keep the automation mutex.
- **MarkupMode.** Honor final/show-markup on .docx → PDF if the Mac dictionary
  supports revision-view control (spike decides); otherwise export final-only and say
  so in UI copy.

## Phase 2 — Shell integration (`apps/shell`)

- **Info.plist:** Tauri 2 has no config key for arbitrary plist entries — create the
  merge file `apps/shell/src-tauri/Info.plist` with `NSAppleEventsUsageDescription`
  ("RaioPDF controls your installed Microsoft Word to convert documents on this Mac.
  Nothing is uploaded.") and verify it lands in both dev and signed bundles. Note the
  layered config: base `tauri.conf.json` has `bundle.active: false`; macOS bundling
  lives in the `tauri.macos.conf.json` / `tauri.macos.signing.conf.json` overlays.
- **Entitlements — per-binary split (design task, not a checkbox):**
  `com.apple.security.automation.apple-events` is required under hardened runtime
  (without it: silent −1743). But `entitlements/app.entitlements` is applied to the
  app binary **and** both externalBin sidecars (`raiopdf-engine-host`, `raiopdf-mcp`);
  granting them Apple Events scripting is unnecessary capability widening. Design a
  per-binary split — post-bundle re-sign of the app binary alone in the release
  pipeline (precedent exists: `jvm.entitlements` / `node.entitlements` in the payload
  signer) or Tauri per-binary support — plus `verify-app` coverage. Signing stays
  maintainer-local.
- `word.rs` commands and diagnostics events carry over; wire the new reason strings.

## Phase 3 — UI (`apps/ui`)

- `notApplicable` stops occurring on macOS; the existing `isWordPresent` /
  click-time `available` gates carry over for all three flows (`wordReflow.ts`,
  `wordImport.ts`, `readFileForAdd.ts`).
- Fix the now-false platform string in `SettingsDialog.tsx` ("Word integration is only
  available on Windows.") and review every capability-state string against the new
  macOS states.
- New copy: consent-denied guidance (System Settings path; retry does **not**
  re-prompt), version-too-old, license-blocked, "Word will open briefly" expectation,
  and final-only markup note if applicable.
- Batch progress copy per Phase 1.

## Phase 4 — Tests & canaries

- Unit (CI-safe, no Word): shared result-line parsing; macOS capability parsing,
  version gating, error mapping (−1743/−1712/sandbox/license), quit-policy and
  batch-reuse decisions as pure functions.
- Canaries: macOS siblings of the three Windows self-gating canaries (docx→pdf,
  pdf→docx, round-trip) plus a batch-add canary; all skip cleanly when Word isn't
  installed/consented; run on maintainer hardware. `pnpm canary` on a real Mac before
  release; summary line in the PR.
- Manual matrix: Microsoft 365 vs perpetual 2021/2024 vs unlicensed/view-only Word;
  Mac App Store vs direct-download Word (different containers can shift the staging
  location); Word absent; consent denied → re-granted via System Settings; user's Word
  already open with unsaved work; password-protected PDF; scanned PDF (OCR-first
  prompt); 100+ page PDF (timeout sizing); iCloud dataless input file (download eats
  the clock); macOS 14 vs 15 (app floor is 14.0).
- **Standing limitation:** every TCC/entitlement behavior is maintainer-hardware
  validation forever — CI builds are unsigned and can never exercise it.

## Phase 5 — Docs & release

Same-PR rule: README Word rows (platform note); `pdf-to-word.md` update (Word for Mac
version requirement, one-time automation permission, Word-becomes-visible note);
**write a new** word-import help article (none exists today — the import flow shipped
without one); CHANGELOG. `site/shared/COPY.md` makes no Word claims — verify only, add
nothing.

## Sequencing & estimate

Phase 0 Track A first (2–3 days, any Mac); Track B needs the Phase 2 Info.plist +
entitlement candidates built early and the maintainer signing machine (1–2 days, can
interleave with early Phase 1). Phases 1–2 are the bulk (6–8 days — three surfaces,
entitlement pipeline work, error classifier). Phases 3–5 (2–3 days) land in the same
PR as 1–2 per the docs-honesty rule. Realistic total: **3–4 weeks elapsed**, dominated
by real-hardware iteration. One feature PR, targeting a minor alpha.

## Risks

| Risk | Mitigation |
|---|---|
| TCC prompt attributes to osascript, not RaioPDF, or silent −1743 | Spike Track B item 7 on a signed bundle before committing to Phase 1 |
| Sandboxed Word can't write to our output path | Spike item 3; staging save + move |
| PDF open not scriptable / subscription-gated | Spike item 1; import-only fallback on macOS |
| AE reply timeout (−1712) on large legal PDFs | Spike item 5; `with timeout` sized accordingly; distinct error mapping |
| Consent dialog races the 120 s runner timeout | Spike item 8; first-run state exempt from the race |
| Sidecars inherit Apple Events entitlement | Per-binary entitlement split in the release pipeline + verify-app |
| User's Word disturbed / user edits mid-conversion | Temp-copy input; close only our doc; never kill; quit only if we launched |
| Version gate reads a different install than gets scripted | Gate on the targeted instance (spike item 6) |
| Unlicensed Word passes probe, fails save | License-blocked error mapping + capability reason |
| Managed Macs with Spotlight disabled break detection | LaunchServices FFI + fixed-path fallback, no mdfind dependency |
