# Direct Text Editing (Find & Replace) — Plan (v1)

Date: 2026-07-05.
Repo: `Macrify-LLC/raiopdf`. Baseline: `origin/main` at `560321e`.

## Summary

Add the first capability that rewrites a document's *real* text — not overlays, not
redaction — as a literal find & replace driven by the bundled Stirling engine's
`POST /api/v1/general/edit-text` endpoint, which ships (enabled, MIT core, pure
PDFBox) in the exact engine version we already pin (`v2.14.0`). No new libraries, no
new licenses, no Rust changes, no vendoring changes.

What v1 ships: ordered find/replace operations, whole-word matching, page scoping, a
staged review with real before/after previews, and honest warnings about the three
ways this can look wrong (no reflow, centered text anchors left, substitute fonts).

What v1 does not ship, on purpose: paragraph reflow (no GPL-compatible open-source
engine does it), click-on-text inline editing (needs occurrence-level targeting the
endpoint lacks — sketched as a future phase), case-insensitive matching (endpoint is
case-sensitive literal), and an MCP tool (deferred; see Decisions).

## Verified engine contract (Stirling v2.14.0, MIT core)

Verified against the pinned tag's sources (`EditTextController.java`,
`EditTextRequest.java`, `EditTextOperation.java`, `EndpointConfiguration.java`,
`PdfJsonConversionService.java`).

**Route.** `POST /api/v1/general/edit-text`, multipart/form-data, synchronous.
Ungrouped in `EndpointConfiguration` (enabled by default), no premium gating, no
external tool dependency — present in the `STIRLING_FLAVOR=core` JAR we build.

**Request fields.**

| Field | Semantics |
|---|---|
| `fileInput` | The PDF (file part). |
| `edits` | Text part holding a JSON array: `[{"find":"…","replace":"…"}]`. Ordered; each op replaces **every** occurrence on the selected pages; later ops see earlier output. `find` non-empty (else 400); `replace` may be `""` (delete). Both literal — `Pattern.quote`d, no regex. Case-sensitive. |
| `wholeWordSearch` | `"true"`/`"false"` (default false). Lookaround-based, works when the term starts/ends with non-word chars. |
| `pageNumbers` | `"all"` (default), 1-based ranges `"1,3,5-9"`. |

**Matching.** All text elements on a page are joined before matching, so finds span
kerning-split runs. Cross-element replacements anchor at the first element; no
reflow; centered/tracked text shifts left.

**Response.** HTTP 200 with raw PDF bytes only. Per-op counts and fallback-font
usage are logged server-side and **not returned**. Font handling: if the original
embedded (possibly subset) font can encode the replacement, the original stream is
token-rewritten in place; otherwise the run is regenerated in a bundled Noto
fallback font (visible font change).

**Round-trip caveats.** The document is fully regenerated (PDF→JSON→PDF) even on
zero matches. Preserved: text, images, per-page annotations, AcroForm fields,
resources, XMP metadata. **Dropped: bookmarks/outline** (not in the JSON model) —
the sidecar must restore them client-side. Embedded file attachments and tagged-PDF
structure trees are also absent from the model — verify live (see Risks).

**Errors.** 400 with Stirling's JSON error body (already parsed by the sidecar);
encrypted input fails PDFBox load with a password-flavored message (existing
`ENCRYPTED_DOCUMENT` mapping); disabled endpoint → 403 (existing `UNSUPPORTED`
mapping).

## Decisions log

- **Counts and warnings are computed client-side.** The endpoint returns bytes
  only, so the UI's review step is the source of truth: it re-extracts text from
  the candidate bytes (pdf.js) and diffs against the original to report authoritative
  counts and affected pages — the same verify-by-re-extraction philosophy as
  redaction. The seam result type still carries a `replacedCounts` slot (null for
  now) so a future engine that reports counts slots in without a seam break.
- **Stage-then-confirm, batched.** Queued ops accumulate; one engine round trip
  produces candidate bytes held in memory; a review dialog shows per-op results,
  plain-language warnings, and before/after page previews; only Apply commits via
  `replaceBytes`. Cancel means the document was never modified (and the copy says
  so). Staging *is* the dry run — no backend dry-run flag needed.
- **Case-sensitive preview.** The engine matches case-sensitively; the UI preview
  must mirror it exactly (preview honesty over convenience). No case toggle in v1.
- **No occurrence-level targeting in v1.** Replace-only-the-Nth-match would mean
  reimplementing Stirling's cross-element span logic client-side over the pdf↔json
  endpoints — drift-prone duplication. v1 supports ordered ops + whole-word + page
  scoping (`pageIndexes: [n]` covers "replace on this page only"). The options type
  leaves room to add occurrence indexes later without a breaking change.
- **Signed documents: refuse, then confirm.** The sidecar preflights signature
  fields (existing `@raiopdf/engine-pdf-lib` machinery) and rejects with a new
  `SIGNED_DOCUMENT` error code unless the caller passes
  `allowSignatureInvalidation: true`; the UI catches the code, shows a
  signature-invalidation confirm, and retries with the opt-in. Editing a signed
  filing is exactly the kind of thing a legal product must not do silently.
- **A Redact-style mode, not part of the annotation EditLayer.** Annotations are
  UI-rendered overlays batched into an infallible local `applyEdits`; this is a
  sidecar full-document rewrite with warnings and a review step. The mode users
  already know for "permanently rewrites content" is Redact: enter mode → mark →
  confirm → engine → verify → commit. Text editing follows it.
- **Mutual exclusion with pending annotation edits.** Pending annotations are
  anchored to positions of text the user saw; font substitution and width changes
  can make them visually wrong. Entering Edit Text mode requires saving/discarding
  pending annotations, and vice versa. One `if`, zero ordering hazard.
- **After apply, Save becomes Save As** (keep `fileName`, clear `filePath`) — the
  redaction precedent minus the `_redacted` rename. There is no undo for applied
  mutations anywhere in the app; preserving the original on disk until the user
  explicitly overwrites is the honest mitigation.
- **MCP tool: deferred.** Adding a tool forces the `docs/MCP.md` count/table sync
  (the drift that bit PR #134), and the feature's caveats deserve a human reviewing
  the result before an agent gets a fire-and-forget tool. Follow-up once the seam
  is proven.

## Phase 1 — Engine seam

### `packages/engine-api/src/index.ts`

New types (house naming: `Pdf*Options` / `Pdf*Result`), new `PdfEngineErrorCode`
member `"SIGNED_DOCUMENT"`, and a `replaceText` method placed near `redactText`:

```ts
export type PdfReplaceTextOperation = {
  /** Literal text to find. Must be non-empty. Not a regular expression. */
  find: string;
  /** Literal replacement. Empty string deletes the matched text. */
  replace: string;
};

export type PdfReplaceTextOptions = {
  /** Ordered ops; each replaces every occurrence on the selected pages. */
  operations: readonly PdfReplaceTextOperation[];
  /** Match only on word boundaries. Defaults to false. */
  wholeWord?: boolean;
  /** Zero-based pages to search, or "all" (default). */
  pageIndexes?: PdfPageSelection;
  /** Required opt-in when the document has signed signature fields. */
  allowSignatureInvalidation?: boolean;
};

export type PdfReplaceTextWarning = {
  code: "COUNTS_UNAVAILABLE" | "SIGNATURES_INVALIDATED" | "FALLBACK_FONT_POSSIBLE";
  message: string;
};

export type PdfReplaceTextResult = {
  document: PdfDocumentHandle;
  /** Index-aligned per-op counts when the engine reports them; null otherwise. */
  replacedCounts: readonly number[] | null;
  warnings: readonly PdfReplaceTextWarning[];
};
```

The method doc comment states the contract plainly: literal find/replace in real
content streams, no reflow, centered text may shift, whole document regenerated
even on zero matches (callers should confirm matches via their text layer first),
engines that can't rewrite content streams reject with `UNSUPPORTED`.

### `packages/engine-local/src/index.ts`

`replaceText` throws `PdfEngineError("UNSUPPORTED", …)` — pdf-lib cannot re-encode
glyph runs. Same pattern as `compress`/`repair`. Test alongside the existing
unsupported-op tests.

### `packages/engine-sidecar/src/index.ts`

1. Validate: ≥1 operation, every `find` non-empty, `assertPageSelection`.
2. Signed-document preflight via the signature-field counting already in
   `@raiopdf/engine-pdf-lib`; throw `SIGNED_DOCUMENT` or append a
   `SIGNATURES_INVALIDATED` warning on opt-in.
3. POST `/api/v1/general/edit-text`: `createFormData(bytes)` +
   `edits: JSON.stringify(ops)` + `wholeWordSearch` + `pageNumbers` via the
   existing `toSidecarPageNumbers` (zero-based → 1-based/"all"). Plain proxied
   Stirling call — not a `/local/*` interceptor, so no Rust changes.
4. **Restore the outline** onto the returned bytes with the existing
   `preserveSamePageOutline(sourceBytes, outputBytes)` — load-bearing, since the
   upstream round-trip drops bookmarks.
5. Result: `replacedCounts: null` + `COUNTS_UNAVAILABLE` warning, plus a
   documented-as-heuristic `FALLBACK_FONT_POSSIBLE` warning when the output
   contains `Noto*`/fallback base fonts the input lacked.
6. Add the endpoint row to the verified endpoint-mapping table in the file header,
   with the no-reflow / left-anchor / bookmark-restore / counts-are-log-only notes.

### `engine/verify-live.sh`

Add an `edit-text` check against the synthetic two-page PDF (find `Page`, replace
`Sheet`, assert 200) so a future engine bump that moves or gates the endpoint fails
loudly at vendoring time.

## Phase 2 — Bridge

`apps/ui/src/hooks/useEngineBridge.ts` gains the eighth op, following the
`sanitize` template exactly (`withEngineRetry` → open → op → `saveToBytes` → close
both handles in `finally`):

```ts
replaceText: (bytes: Uint8Array, options: ReplaceTextBridgeOptions) =>
  Promise<{ bytes: Uint8Array; replacedCounts: readonly number[] | null;
            warnings: readonly PdfReplaceTextWarning[] }>;
```

`ReplaceTextBridgeOptions` mirrors the seam options plus the standard
`onEngineReady` callback. `PdfEngineError` passes through untouched so the UI can
branch on `SIGNED_DOCUMENT` (confirm-and-retry), `ENCRYPTED_DOCUMENT` (unlock
flow), and `UNSUPPORTED` (endpoint disabled). Warnings travel in the resolved
value, never as errors.

## Phase 3 — UI (apps/ui)

A canvas mode structurally sibling to Redact: `ToolRow` in the ToolPanel **Edit**
group → mode bar over the canvas → inline status expansion → staged engine round
trip → review dialog → commit.

**New files.**

| Path | What |
|---|---|
| `apps/ui/src/lib/textEdit.ts` | Pure logic: `PendingTextReplacement`, `findTextMatchesInPages` (case-sensitive, whole-word with punctuation-safe boundaries; generalizes `findTextRedactionAreasInPages` to return match context), `deriveTextEditGate`, length-delta "may crowd neighbors" advisory, candidate-vs-original diff → per-op counts + affected pages, warning-code → plain-language copy map, `formatReplaceTextResult`. |
| `apps/ui/src/hooks/useTextEdit.ts` | Mode state hook modeled on `useDocumentSearch` + redaction phases: query/replacement/wholeWord, matches + prev/next, `pendingOps`, `phase: idle\|staging\|review\|applying\|done\|error`, `staged: { bytes, results } \| null`, `review()`, `apply()`, `cancelReview()`. Debounce, generation-reset, and staleness guards copied from `useDocumentSearch`. |
| `apps/ui/src/components/EditTextModeBar.tsx` | Find/replace fields, whole-word `Switch`, match label (`aria-live="polite"`), prev/next, "Replace all" (queues an op — never fires the engine), queued count, Exit. Reuses `LegalModeBar.css`. |
| `apps/ui/src/components/EditTextReviewDialog.tsx` | FloatingDialog: `LongProcessLoader` while staging; per-op results (client-side diff counts, flagged when they differ from the preview estimate); grouped plain-language warnings; before/after page thumbnails (original vs candidate bytes, both in memory — the round trip already happened); Apply / Cancel. |
| `apps/ui/src/components/EditTextStatusPanel.tsx` | ToolPanel expansion: gate messages, the always-visible advisory ("Replacements never reflow the page…"), pending-op list with per-op remove, Review button, done/error summary with per-page jump links. |

**Modified:** `toolRegistry.ts` (new `edit-text` entry), `ToolPanel.tsx`, `App.tsx`
(mode state, mutual exclusion in `selectEditTool`, mode-bar ternary, route matches
into the existing `CanvasWell` `searchResults` highlight channel), `AppShell.tsx`
(disable CommandBar search with a tooltip while the mode owns the highlight
channel), `useEngineBridge.ts` (Phase 2).

**Gating** (one pure `deriveTextEditGate`, surfaced as `InlineMessage`):

1. Streamed documents: gated with a specific message ("too large for in-app text
   editing") — do not reuse `STREAMED_DOCUMENT_GATE_MESSAGE`, which promises a
   path-ops fallback this feature doesn't have.
2. No text layer (scan): gated, routed to Make Searchable. After OCR (and on mixed
   pages), matches on image-backed pages carry a per-match warning: replacing OCR
   text changes only the hidden searchable layer, **not the visible page**. The UX
   must never let a user believe they visually corrected a scanned exhibit.
3. Garbled pages: reuse the existing "matching may be incomplete" warning +
   force-OCR route.
4. Signed documents: `SIGNED_DOCUMENT` from the bridge → invalidation confirm →
   retry with opt-in.
5. Pending annotation edits: mutual exclusion (see Decisions).

**Post-apply.** `replaceBytes(candidateBytes, { dirty: true, hasTextLayer: null,
expectedOpenToken, expectedGeneration })` — generation bump refreshes the viewer
and every cache by construction; scroll intent to the first affected page; summary
in the expansion ("3 replacements on 2 pages. 1 may use a substitute font."); keep
`fileName`, clear `filePath` so Ctrl+S is Save As.

**Preview honesty.** pdf.js extraction and the engine's joined-per-page matcher can
disagree on edge cases (ligatures, hyphenation); the preview count is labeled as an
estimate and the review diff is authoritative. `warmEngine()` fires when the first
op is queued so Review feels fast.

**A11y/keyboard:** Esc exits the mode (extend the existing effect), Enter/Shift+
Enter next/previous in the find field, `role="toolbar"`, no color-only warnings,
alt text on before/after thumbs. No global Ctrl+H in v1 (the app has no Ctrl+F yet;
note as a follow-up pair).

## Phase 4 — Verification & docs (same PR)

**Unit (Vitest).**
- `packages/engine-sidecar/test/sidecar-engine.test.ts`: request encoding
  (`edits` JSON, `wholeWordSearch`, page-number mapping), empty-op/empty-find
  preflight rejections, signed-doc refuse + opt-in path, outline restored onto
  returned bytes, `replacedCounts: null` + `COUNTS_UNAVAILABLE`, 403 → `UNSUPPORTED`.
- `packages/engine-local`: `replaceText` → `UNSUPPORTED`.
- `apps/ui`: `textEdit.test.ts` (whole-word boundaries incl. punctuation, gate
  derivation, diff counts, advisory), `useTextEdit.test.tsx` (debounce,
  generation reset clears the queue, stale apply, cancel leaves bytes untouched),
  component tests for the panel + review dialog, `useEngineBridge.test.tsx` case.

**Smoke (`apps/ui/smoke/app.smoke.ts`),** modeled on the search-to-redact test:
queue → review (mocked engine returns candidate bytes) → warning copy + previews
render → Apply → output text changed, Save prompts Save As. Second test: Cancel
leaves the document byte-identical ("NOT modified" copy). Third: pending-annotation
mutual exclusion. Extend `streamed-large.smoke.ts` for the gate message.

**Canary (required — PR touches `apps/ui` + sidecar):** a real-engine replace round
trip in `apps/ui/smoke/real-engine/`, verified by pdf.js re-extraction (old string
gone, new present, bookmarks intact). Run `pnpm prepare:shell-bundle` once, then
`pnpm canary`; paste the summary line into the PR.

**Docs (CLAUDE.md "keep the docs honest"):** README feature-table row with the
limits stated plainly; new `packages/help-content` article `edit-text` covering
whole-word, page scoping, no reflow, centered-text shift, substitute fonts,
signature invalidation, and the OCR-layer caveat; `site/shared/COPY.md` only if the
landing page will claim the feature (add there first). `docs/ARCHITECTURE.md`
unchanged (no new tier). `docs/MCP.md` unchanged (tool deferred).

## Suggested PR slicing

1. **PR 1 — seam + sidecar:** Phases 1–2 (engine-api, engine-local stub,
   engine-sidecar, verify-live, bridge op) + unit tests. Small, reviewable,
   independently canary-able via a bridge-level scenario.
2. **PR 2 — UI + docs:** Phase 3 + smoke tests + canary scenario + README/help
   article. Depends on PR 1.

(One combined PR is acceptable if PR 1 alone would strand an unused bridge op, but
the seam work is genuinely independent and the review audiences differ.)

## Risks & verify-live items

- **Whole-document regeneration fidelity** is the top risk: fonts re-embedded,
  content streams regenerated even on zero matches. Canary must use a realistic
  legal fixture (OCR hybrid, forms, bookmarks). Tagged-PDF structure trees are
  likely dropped — verify; if confirmed, warn in the result and document it.
- **Embedded file attachments** are absent from the upstream JSON model — verify
  with a fixture; if dropped, add a warning code or restore client-side via
  pdf-lib in a follow-up. Needs an explicit answer before this feature is
  advertised.
- **Multipart size limits:** same path as `sanitize`/`repair`; check once with a
  100 MB+ document. If fragile, the fix is a Spring property in the launch config,
  not a new `/local` interceptor.
- **Encrypted-input mapping:** confirm the actual PDFBox failure message shape maps
  to `ENCRYPTED_DOCUMENT` in the canary.
- **Endpoint drift on engine bumps:** `edit-text` is ungrouped in
  `EndpointConfiguration` today; the verify-live check is the tripwire.
- **Preview/engine disagreement** on ligatures/hyphenation: mitigated by the
  authoritative review diff; document the edge in the help article.

## Future (not in v1)

- **Inline click-to-edit (phase 2):** needs a selectable pdf.js text-layer overlay
  in `CanvasWell` plus occurrence-level targeting — either upstream endpoint
  support or driving Stirling's pdf↔json pipeline directly. The v1
  staging/review/apply pipeline is reused unchanged; inline editing is just another
  way to author a pending op.
- **MCP `replace-text` tool:** thin wrapper once the seam is proven; requires the
  `docs/MCP.md` count/table sync in the same PR.
- **Ctrl+F/Ctrl+H:** add a CommandBar find shortcut first, then a mode shortcut.
