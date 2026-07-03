# Live Test 1 — Fix & UX Plan

> Date: 2026-07-03
> Source: Jacob's first hands-on test of the packaged Windows build (NSIS install at
> `D:\Macrify Programs\RaioPDF`). 19 reported issues, all root-caused against the
> code; live process/log evidence gathered while the app was running.
> Branch: `fix/first-live-test-feedback`.

## Verified root causes (live evidence + code)

| # | Symptom | Root cause | Evidence |
|---|---------|-----------|----------|
| 1 | "Stirling PDF Request Failed" on OCR, recurring | Engine sidecar previously idle-shut down after the old 5 min default (`crates/engine-sidecar-core/src/lib.rs:25`; A3 changes it to 15); UI caches port+token forever, never restarts/retries (`apps/ui/src/hooks/useEngineBridge.ts:86-89`); fetch has no retry (`packages/engine-sidecar/src/index.ts:773-793`). NOTE (Codex round 1): Rust `engine_start` DOES health-check to readiness before returning (`lib.rs:537, 657`) — the boot path is not the bug; stale port after idle shutdown is. One observed first-click ~4 s failure remains unexplained; the new UI-error logging (A2) exists to catch it if it recurs. | Live: ports 60891/60892 confirmed dead 5 min after ready while UI still held them; app.log sessions with no `engine_start` |
| — | "Make searchable does nothing" after a failure | Busy-guard leak: `runOcrWorkflow` early-returns `if (!isCurrentRun()) return;` in `.then`/`.catch` without clearing `ocrActiveRef` (`apps/ui/src/App.tsx:984, 1041-1043, 1103-1105`); also repeated failures repaint an identical error message, indistinguishable from no-op | Code inspection |
| 2 | Password-protected PDF called "encrypted", repair no-ops | No password prompt on open path (`apps/ui/src/lib/pdfjs.ts:20` has no `onPassword`; `packages/engine-local/src/index.ts:2107` throws `ENCRYPTED_DOCUMENT`); ANY failed open routes to Repair (`apps/ui/src/App.tsx:1153-1162`); Repair endpoint (`/api/v1/misc/repair`) is disabled server-side because payload lacks `qpdf` and Stirling can't find `gs` | engine.log: `Missing dependency: qpdf`, `Missing dependency: gs — Disabling group … Repair, Compress` |
| 3, 17 | Popup ✕ and ? buttons do nothing | Draggable dialog header calls `setPointerCapture` on pointerdown (`apps/ui/src/components/FloatingDialog.tsx:115`); ✕/? are children of the header → synthesized click retargets to header, button onClick never fires (Chromium/WebView2 pointer-capture semantics) | Affects every FloatingDialog (all tool popups); HelpPanel (`draggable={false}`) unaffected |
| 4 | Empty console window at launch | Shell exe missing `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` (`apps/shell/src-tauri/src/main.rs:1-3`) → console-subsystem binary. Also unguarded spawns: `mcp.rs:388` (raiopdf-mcp), `apps/mcp-launcher/src/main.rs:40-60` (node), `diagnostics.rs:725` (`cmd /C ver`) — all lack `CREATE_NO_WINDOW` | Live: `conhost.exe` child of shell PID; engine spawn correctly guarded (`engine-sidecar-core/src/lib.rs:1005-1008`) |
| 5 | Can't select text on OCRed docs | Viewer never builds a PDF.js text layer — canvas only (`apps/ui/src/components/CanvasWell.tsx`); selection impossible on ALL documents | grep: no `renderTextLayer`/`TextLayer` anywhere in UI |
| 8 | Prepare for Filing = window inside window | `PrepareForFilingWorkspace` renders its own headered `filing-card` (second ? + ⋯ menu, `PrepareForFilingWorkspace.tsx:326-373`) inside the outer FloatingDialog chrome (`App.tsx:2894-2900`) | Screenshot + code |
| 9, 16 | Placed image deletable only via tiny ✕; no Delete key; no right-click | No Delete/Backspace handler anywhere (`EditLayer.tsx` has no keydown; App.tsx window listeners are Escape/zoom/F1 only); zero `onContextMenu` infrastructure in the app | grep-confirmed |
| 12 | Organize pages drag-and-drop dead | `onDragStart` (`OrganizeWorkspace.tsx:368`) never calls `event.dataTransfer.setData`/`effectAllowed` → WebView2 refuses to initiate drag on a `<button><canvas>` source | Code inspection |
| 14 | Rotated page still renders portrait-aspect (sideways text) | UI derives size from `page.getViewport()` (rotation-correct); suspect `packages/engine-local` `rotatePages` writes rotated content without setting page `/Rotate` + swapping box aspect — **needs verification before fix** | Screenshot #2 |
| 15 | "Rotate pages" kicks you out of Organize view | `selectOrganizeTool("rotate")` runs `rotateSelected()` then `setActiveOrganizeTool(null)` (`App.tsx:1460-1471`), unmounting Organize | Code inspection |
| 6, 7, 10, 11, 13, 18, 19 | UX-level asks | See Workstream D | — |

## Workstream A — Engine lifecycle & OCR flow (issues 1, busy-guard, new UX spec)

### A1. Self-healing engine bridge (`useEngineBridge.ts`)
- Dedupe concurrent `ensureEngine` calls behind a single in-flight promise (today two
  concurrent ops both invoke `engine_start`). **Reset the in-flight promise on
  rejection** so a failed start doesn't poison later attempts (Codex round 1).
- Wrap every engine operation in `withEngine(op)`: on **connection-level** failure,
  drop the cached engine, re-invoke `engine_start` (health-checked; returns fresh
  port+token), and retry the operation **once**. Second failure surfaces the error.
- **Generation-safe** (Codex round 1): on failure, clear `engineRef` only if it still
  `===` the engine instance that failed — a concurrent retry may already have
  installed a fresh engine that must not be wiped.
- **Retry classification by cause chain, not code** (Codex round 1): network failures
  and genuinely bad PDFs both surface as `PdfEngineError("INVALID_DOCUMENT")`; walk
  `error.cause` for the fetch `TypeError` to identify connection-level failures.
- Do NOT permanently latch `disabled` except for the genuine `{disabled:true}`
  response (no jar in payload / non-Tauri runtime).

### A2. New OCR interaction (replaces the yellow inline status box)
1. Click **Make Searchable** → immediately open a small **OCR dialog** (FloatingDialog)
   containing:
   - v1 scope (DECIDED 2026-07-03): **all-pages only** — the dialog states the page
     count ("All 12 pages will be processed"); no range input yet. The dialog shell
     is designed so a range selector can slot in later without changing the flow.
   - Primary action: "Make searchable". Secondary: Cancel.
2. Concurrently on dialog open, **kick off `engine_start` in the background** so the
   engine is warm (or warming) by the time the user confirms. No spinner shown for
   this pre-warm; it's silent.
3. On confirm: dialog content swaps to the **rotating sun loader** (`LoadingSun`
   component) with a single status line ("Starting the PDF engine…" → "Making
   searchable…" → "Verifying…"). No yellow box under the tool button.
4. On success: dialog closes, subtle success notification (existing notification
   pattern) with the verification summary.
5. On failure: dialog closes (or shows inline error state with Retry) + a **general
   failure notification** ("Couldn't make this document searchable."), and the
   underlying error detail is **logged via the EXISTING `diagnostics_record_event`
   Tauri command** (`diagnostics.rs:339` — already writes source/kind/message/details
   to rotated app.log) with `source: "ui"`. No new logging command (Codex round 1).
- Page-range OCR mechanics: DEFERRED (decided 2026-07-03 — all-pages only for v1).
  When ranges land later, the design is extract → OCR → merge via Stirling endpoints,
  gated on fixture tests proving bookmarks/links/forms survive the round-trip.
- Fix busy-guard leak: clear `ocrActiveRef` in a `finally`, keep `isCurrentRun()`
  gating only for state writes.

### A3. Idle-shutdown tuning (small)
- DECIDED 2026-07-03: lengthen `DEFAULT_IDLE_SHUTDOWN_MINUTES` 5 → **15**
  (`crates/engine-sidecar-core/src/lib.rs:25`). A1 makes expiry transparent anyway;
  15 min just cuts re-warm waits during active sessions at a modest RAM cost.
- Codex round 1 recommended keeping 5 min — **rejected: owner decision** (Jacob,
  2026-07-03). The `RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES` env override remains the
  tuning escape hatch either way.

## Workstream B — Correctness fixes

### B1. Dialog close/help buttons (3, 17) — DONE on branch
`handlePointerDown` now ignores pointerdowns originating on interactive elements
(`button, a, input, select, textarea, [role='button']`) before capturing.

### B2. Console window (4)
- Add `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` to
  `apps/shell/src-tauri/src/main.rs`.
- Add `CREATE_NO_WINDOW` creation flags to `mcp.rs:388`, `diagnostics.rs:725`, and
  the node spawn in `apps/mcp-launcher/src/main.rs`.
- Leave `raiopdf-mcp` itself console-subsystem (it's a stdio MCP binary; CLI use and
  piped spawns both fine once spawners pass the flag).

### B3. Password-protected PDFs (2)
- **Discriminated open result** (Codex round 1): change `openFile()` from
  `Promise<boolean>` to `Promise<"opened" | "password-required" | "failed">` (carrying
  the error where useful) so App can branch explicitly instead of inferring from a
  bare `false` (`useDocument.ts:260-328`, `App.tsx:1147-1166`).
- On `password-required`: show a **password dialog** instead of routing to Repair.
- Submit → `engineBridge.removeEncryption(bytes, password)` →
  `/api/v1/security/remove-password` (works today; independent of gs/qpdf) → the
  decrypted bytes enter as a **fresh open marked dirty** (a new open-with-bytes path
  in `useDocument`; `replaceBytes` can't be used — it requires an active handle,
  which an encrypted open never produced — Codex round 1). Save As becomes the
  natural next step. Wrong password → inline "password not accepted" retry state.
- Repair routing remains only for opens that fail for non-encryption reasons.
- Messaging: distinguish "password-protected" (has open password) from "encrypted"
  (unsupported encryption) in user copy.

### B4. Organize pages (12, 15, 14)
- 12: set `dataTransfer.setData("text/plain", String(pageIndex))` +
  `effectAllowed = "move"` in `onDragStart`; `dropEffect = "move"` in `onDragOver`.
  Optional: `setDragImage` from the page thumb canvas.
- 15: `selectOrganizeTool("rotate")` preserves the Organize workspace when it is the
  active view (only reset to canvas when invoked from the plain canvas context).
- 14: root-cause hypothesis CORRECTED (verified live + Codex round 1):
  `LocalPdfEngine.rotatePages` properly sets page `/Rotate` (`engine-local/src/
  index.ts:179-183`), the UI rotate path uses the local engine (`useDocument.ts:113,
  428-440`), thumbnails derive size from `page.getViewport` (rotation-aware), and no
  CSS squish rule was found. **Investigation is repro-first**: reproduce on a fixture
  (rotate → check thumbnail, canvas, and exported bytes independently) before
  changing anything; also audit the Stirling sidecar partial-rotation path
  (`engine-sidecar/src/index.ts:261` rearrange/merge) used elsewhere. Add a
  regression test: rotate page → viewport dimensions swap.

### B5. Stamp deletion + context menu (9, 16)
- Delete/Backspace deletes the selected edit item (guard: not while focus is in an
  input/textarea/contenteditable).
- DECIDED 2026-07-03: in Organize view, Delete/Backspace also deletes the selected
  page(s) — **with a confirmation dialog** ("Delete 3 pages? This can't be undone
  after save."), since page deletion is destructive.
- Introduce a minimal shared `ContextMenu` component (first context-menu
  infrastructure in the app): right-click on a placed stamp/image/text →
  Delete (+ Duplicate later). Right-click on Organize page thumb → Rotate right/left,
  Delete page (extensible). Scoped small; not an app-wide menu system yet.

### B6. Ghostscript/qpdf server features (2 follow-on)
- Payload ships `ocr/gs/bin/gswin64c.exe` but Stirling probes for `gs` → provide
  `gs.exe` shim (copy of gswin64c.exe beside its DLLs) in the payload assembler and
  ensure the payload `PATH` entries cover it, so Repair/Compress/Scanner-effect
  groups enable.
- `qpdf` is not bundled at all: separate packaging task (qpdf is Apache-2.0 —
  license-compatible for bundling with attribution in RAIOPDF-LICENSE-NOTICES).
- Acceptance: engine.log shows no `Missing dependency: gs`; Repair endpoint returns
  200 on a fixture.

## Workstream C — Viewer modernization: continuous scroll + text selection (5, +new)

> Scope expanded 2026-07-03 (Jacob): the viewer is currently strictly single-page
> (`CanvasWell.tsx` renders one canvas for `currentPage`; page changes are
> click-driven). Continuous scrolling and the text layer both rework how pages
> mount, so they ship together as one workstream.

- **Continuous scroll**: replace the single-canvas well with a virtualized vertical
  page list — all pages laid out at their viewport-derived sizes, but only visible
  pages ± a small buffer actually render canvases (placeholder boxes elsewhere;
  recycle canvases on scroll-out to cap memory on large filings). `currentPage`
  becomes derived state (most-visible page) so the existing page indicator, zoom
  anchor logic, thumbnails, and tools keep working; clicking a thumbnail scrolls to
  that page.
- **Text layer**: render the pdf.js **v6 `TextLayer` class** (the repo is on
  pdfjs-dist 6.x; the old `renderTextLayer` API is gone) per mounted page, aligned by
  the same viewport as its canvas; standard `.textLayer` CSS (transparent glyphs,
  ::selection tint). **Lifecycle**: cancel + destroy the TextLayer on page unmount,
  zoom change, and document swap (Codex round 1). **Z-order/pointer spec**: canvas <
  textLayer < form fields < redaction overlays < edit layer < search highlights;
  when Select tool active, Edit/Form overlays get `pointer-events: none` so
  selection wins; in any other tool the textLayer itself is `pointer-events: none`.
  OCRed docs become selectable naturally (sandwich text layer is real PDF text);
  copy is browser-native.
- **Overlay migration**: redaction overlays, search highlights, EditLayer, and
  FormLayer are currently positioned against the single current page — they move to
  per-page containers so they scroll with their page.
- Zoom: preserve the existing anchor-point zoom behavior, now anchored within the
  scrolled page. Fit-width default.
- Risks: this is the largest-blast-radius workstream (every canvas-adjacent feature
  touches it). It ships as its own PR with a manual regression pass over redaction,
  search, stamps, forms, and rotation on a 100+ page fixture.
- **Round-2 Codex guardrails (accepted, binding on the implementation):**
  - pdf.js 6 `TextLayer` lifecycle = `cancel()` render + clear container DOM +
    release page/canvas refs (+ optional static `TextLayer.cleanup()` on document
    swap). There is no instance `destroy()`.
  - Every navigation path becomes scroll intent (prev/next commands, search
    next/previous, active search hit, every `setCurrentPage` caller) — not just
    thumbnail clicks.
  - Never recycle a canvas until its pdf.js render task is canceled/settled; reset
    dimensions on release (frees backing memory, prevents stale-bitmap flashes).
  - Cap overscan by pixel/canvas memory, not page count alone (high zoom!).
  - Don't unmount pages aggressively while a text-selection drag is active.
  - Per-page overlays carry their own `pageIndex`; redaction creation stops using
    global `currentPage - 1`.
  - Search highlight on an offscreen page = two steps: scroll page into mounted
    range, then highlight/scroll to match.
  - Page-size cache invalidates on document swap, rotation, reorder, and zoom.

## Workstream D — UX restructure (6, 7, 10, 11, 13, 18, 19) — needs Jacob's direction sign-off per item before build

- **6/7 Make Filing Ready**: promote to a persistent top-bar button (document loaded
  state). Dialog shows jurisdiction + a sleek single-line-per-rule checklist
  (rule name + pass/fail chip), each row expandable for detail; "Prefiling check"
  is a collapsed section that expands. Kill the current dense always-expanded list.
- **8 (bundled here)**: flatten Prepare for Filing to ONE chrome: outer FloatingDialog
  header keeps title/?/✕ and gains the ⋯ menu; inner `filing-card` header is reduced
  to a plain document-info line (no second ? button).
- **10 File menu / preferences**: FINDING (2026-07-03) — a complete native menu
  already exists and is wired end-to-end: `build_native_menu` (`apps/shell/
  src-tauri/src/lib.rs:347-385`) registers File/Edit/View/Help incl. "Preferences…"
  (`file:preferences` → `SettingsDialog`, handled at `App.tsx:2779`) and "Open Raio
  to AI…"; `app.set_menu` installs it (`lib.rs:274`). But the window is frameless
  (`decorations:false` in tauri.conf.json) so on Windows the native menu bar never
  renders — the whole menu is unreachable. Fix = render File/Edit/View/Help
  dropdowns in `TitleBar.tsx` that emit the SAME menu-event IDs the UI already
  handles (keep the native menu registered for future macOS, where frameless apps
  still get the global menu bar). Much smaller than building preferences from
  scratch — the Preferences dialog itself already exists and works.
- **11 Connect to AI Agent**: top-level tool in the sidebar ("Connect to AI Agent"),
  not buried in the Built-by-Macrify menu; opens the existing MCP enable/config
  surface. Copy must respect the two-halves framing: no AI *in* Raio; native
  interface *for* your own AI tools.
- **13 Help icons**: remove per-tool ? buttons from collapsed tool rows; keep the one
  global Help entry + contextual ? only inside an expanded tool/dialog.
- **18 Popups→sidebar expansions**: directional — convert simple tool dialogs
  (rotate, page numbers, watermark, compress) into inline expansions inside the tool
  sidebar; keep full dialogs only for genuinely modal flows (filing, redaction
  verify, binder). Needs a per-tool inventory + Jacob sign-off on which go inline.
- **19 Motion pass**: dedicated pass (emil-design-eng discipline): rotate animates a
  quarter-turn on the affected thumbs/canvas; tool expansions get height/opacity
  transitions; dialogs get enter/exit scale-fade; loader states cross-fade. Respect
  `prefers-reduced-motion`.

## Phasing / PRs

1. **PR 1 — stability**: B1 (done), A1, A2, A3, B2, B4, B5 busy-guard fix. Target:
   every reported hard bug dead.
2. **PR 2 — password + engine features**: B3, B6 (gs shim; qpdf packaging may split).
3. **PR 3 — text layer**: C.
4. **PR 4 — UX restructure**: D after direction sign-off (may split per item).
5. Rotation metadata fix (B4/14) rides PR 1 if the engine-local fix is small, else
   its own PR with tests.

## Open questions — DECIDED 2026-07-03 (Jacob)

1. Page-range OCR: **all-pages only for v1**; range + extract/ocr/merge deferred.
2. Idle shutdown: **15 minutes**.
3. Delete keystroke in Organize: **yes, deletes selected pages with confirmation**.
4. UI error log sink: **reuse app.log** (Claude's call) — one diagnostics file, one
   place to look, same shell-event plumbing (`AppDiagnostics::record_shell_event`);
   entries tagged with a `ui` source. Split into ui.log later only if volume/rotation
   demands it.

## Codex consensus log

**Round 1 (2026-07-03): verdict SHIP WITH CHANGES.** Disposition of each requested change:
- Readiness-wait wording corrected (engine_start does health-check) — ACCEPTED.
- A1 generation-safe retry + in-flight promise reset + cause-chain classification — ACCEPTED.
- Defer page-range OCR from PR1 — ACCEPTED (already owner-decided; also noted: range
  parser lacks `12-` open-ended syntax (`pageRanges.ts:62`) and whole-doc OCR
  verification (`ocrVerification.ts:17`) would false-fail partial OCR — both recorded
  as constraints for the future range feature).
- B3 discriminated open result + fresh-dirty-open path for decrypted bytes — ACCEPTED.
- Use existing `diagnostics_record_event` instead of new logging command — ACCEPTED.
- Workstream C: pdf.js v6 TextLayer + lifecycle + z-order/pointer spec — ACCEPTED.
- Rotation root-cause corrected to repro-first investigation — ACCEPTED.
- Keep idle shutdown at 5 min — REJECTED (owner decision: 15 min; env override
  remains).

**Round 2 (2026-07-03): verdict CONSENSUS — no substantive objections.** TextLayer
lifecycle correction + virtualization pitfalls folded into Workstream C above.
Plan is FINAL; execution proceeds commander-style (Codex = non-UI worker,
frontend-specialist = UI/UX worker, ≤3 parallel).

## Test plan (high level)

- Unit: useEngineBridge retry/dedupe (fake invoke + fetch), FloatingDialog header
  click-vs-drag, DnD dataTransfer population, rotate view-state reducer, password
  dialog flow (wrong → right password), busy-guard finally.
- Rust: spawn-flags compile-time cfg tests where feasible; existing sidecar tests
  keep passing.
- Manual on packaged build: engine kill → next OCR self-heals; 6-min idle → OCR
  works; console window absent; password PDF opens; drag reorder; rotate stays in
  Organize; Delete removes stamp; right-click menus; text selection on OCRed doc.
