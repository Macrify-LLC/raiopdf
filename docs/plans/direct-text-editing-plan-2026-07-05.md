# Direct Text Editing (Find & Replace) — Plan (v2)

Date: 2026-07-05. Supersedes v1 of this file.
v2 incorporates the adversarial critique (2026-07-05), which re-verified the
upstream sources and refuted several of v1's fidelity claims. All confirmed
findings are folded in below; the changes log records what moved and why.
Repo: `Macrify-LLC/raiopdf`. Baseline: `origin/main` at `560321e`.

## Summary

Add the first capability that rewrites a document's *real* text — not overlays, not
redaction — as a literal find & replace driven by the bundled Stirling engine's
`POST /api/v1/general/edit-text` endpoint, which ships (enabled, MIT core, pure
PDFBox) in the exact engine version we already pin (`v2.14.0`). No new libraries, no
new licenses, no Rust changes, no vendoring changes.

What v1 ships: ordered find/replace operations, whole-word matching, page scoping, a
staged review with real before/after previews, and honest disclosure that the
**entire document is regenerated** by the engine — including page-level relayout
when fallback fonts fire and re-encoding of embedded images.

What v1 does not ship, on purpose: editing on scanned/image-only documents (cut —
see Decisions), paragraph reflow, click-on-text inline editing, case-insensitive
matching, PDF/A-preserving edits, or an MCP tool.

**Phase 0 is a go/no-go fidelity spike.** The critique confirmed that the engine's
PDF→JSON→PDF round trip re-encodes images and can regenerate whole pages. Before
any UI work, we build the pinned engine and measure fidelity on a realistic fixture
battery. If scanned-image degradation or born-digital fidelity is unacceptable, the
feature stops there and this plan is shelved until upstream improves.

## Changes log (v1 → v2, from the adversarial critique)

- **Images are NOT preserved** (critique C1, confirmed upstream): every image is
  decoded and re-encoded (base64/PNG-fallback via ImageIO) on every call, including
  zero-match runs — generational JPEG loss, CCITT-G4/JBIG2 format swaps. v1's
  "Preserved: images" claim removed. Consequence: **scanned and image-only
  documents are gated out of v1 entirely**, including the "fix hidden OCR text"
  use case — degrading the visible scan to edit invisible text is a bad trade and
  contradicts the product's own OCR promise ("visible page images unchanged").
  Mixed documents (born-digital with embedded images/logos) proceed with explicit
  image-re-encoding disclosure, contingent on Phase 0 measurements.
- **PDF/A documents would come back falsely claiming PDF/A** (critique C2,
  confirmed): the rebuild drops the OutputIntent but preserves the XMP `pdfaid`
  claim. v1 never mentioned PDF/A. New rule: sidecar preflights PDF/A
  identification (helper already exists in `@raiopdf/engine-pdf-lib` and is already
  imported by engine-sidecar); editing a PDF/A document requires an explicit
  opt-in and the sidecar **strips the PDF/A identification** from the output XMP,
  with a `PDFA_IDENTIFICATION_REMOVED` warning. An e-filing product must never
  manufacture a false conformance claim.
- **Multi-word finds can silently fail** (critique H1, confirmed): the engine joins
  page text with no separators, so PDFs that space words positionally (justified
  text — most pleadings) yield `JohnSmith`, which `"John Smith"` never matches;
  meanwhile pdf.js extraction is whitespace-unstable in the other direction. The
  preview and the engine disagree most on exactly these documents. v1's honesty
  section named only ligatures/hyphenation. New: the limitation is named in the
  UI copy and help article, the review's zero-change path handles it gracefully,
  Phase 0 includes a justified-text fixture, and the UX nudges toward single-word
  (whole-word) replacements as the reliable case.
- **Fallback-font regeneration is page-level, not run-level** (critique H2,
  confirmed): one un-encodable glyph anywhere on a page causes the *whole page* to
  be regenerated (all runs re-laid out, vector graphics recovered lossily) — and
  complex streams can trigger regeneration even on zero-match pages. The review
  dialog therefore cannot promise "only these pages changed" from a text diff.
  Reframed: the review shows text-diffed pages as primary evidence **plus a
  standing disclosure that the entire document is rewritten** and unlisted pages
  may shift subtly.
- **Signature machinery relocated** (critique H3, confirmed): the field-counting
  helpers (`countSignatureFields`, `detectSignatureFacts`) live in
  `@raiopdf/rules`, which is not a sidecar dependency. v1 cited a helper that
  doesn't exist where claimed. New: add a minimal signed-signature-field counter
  to `@raiopdf/engine-pdf-lib` (already a sidecar dependency; already
  signature-aware via `assessPdfAConversionImpact`) and use it from the sidecar.
  Post-apply, the UI routes through the **existing** signature-invalidation
  notice/banner pipeline instead of inventing a parallel one. Follow-up noted:
  `redactText` today silently invalidates signatures — align it with the same
  preflight in a separate PR rather than shipping two philosophies forever.
- **Zero-change Apply is now specified** (critique M1): if the candidate's
  extracted text is identical to the original's, Apply is disabled, the staged
  bytes are discarded, and the copy says "Nothing was replaced — the document was
  not modified." This also protects against pointless whole-document regeneration
  when the engine matched nothing. Per-op reporting is derived by re-running the
  matcher against extracted text op-by-op ("found on pages 2, 7" / "not found"),
  not by attributing raw diffs to ops (ambiguous when ordered ops interact).
- **Permissions-protected PDFs refused** (critique M2): owner-password-only
  (no-modify-permission) documents load without a password upstream and come back
  decrypted — silent protection stripping. New: sidecar preflights the encryption
  dictionary (pdf-lib, client-side) and refuses permission-protected inputs with
  `ENCRYPTED_DOCUMENT` in v1.
- **Mutual exclusion is real UX, not one `if`** (critique M3): no save-or-discard
  gate exists anywhere today (Redact doesn't require one). The plan now specifies
  a confirm dialog (Save annotations / Discard / Cancel) when entering text-edit
  mode with pending annotation edits, and the reverse direction blocks with a
  message.
- **Whole-word parity pinned to the exact regex** (critique M4): the engine uses
  ASCII `\w` lookarounds. The UI matcher must use the identical construction —
  `(?<!\w)(?:<quoted find>)(?!\w)` — not `\b`, not Unicode-aware classes.
- Smaller: verify-live check asserts replaced output text, not just HTTP 200; the
  sync endpoint has **no progress channel** (image extraction can take minutes on
  image-heavy docs — loader copy must not promise progress); internal-link/GoTo
  destination fidelity added to Phase 0; "canary summary line" phrasing kept per
  CLAUDE.md though no formal convention exists in-repo.

## Verified engine contract (Stirling v2.14.0, MIT core)

Verified twice against the pinned tag's sources (plan author, then independently by
the adversarial critique): `EditTextController.java`, `EditTextRequest.java`,
`EditTextOperation.java`, `EndpointConfiguration.java`,
`PdfJsonConversionService.java`.

**Route.** `POST /api/v1/general/edit-text`, multipart/form-data, synchronous (no
progress reporting in sync mode). Ungrouped in `EndpointConfiguration` (enabled by
default), no premium gating, no external tool dependency — present in the
`STIRLING_FLAVOR=core` JAR we build.

**Request fields.**

| Field | Semantics |
|---|---|
| `fileInput` | The PDF (file part). |
| `edits` | Text part holding a JSON array: `[{"find":"…","replace":"…"}]`. Ordered; each op replaces **every** occurrence on the selected pages; later ops see earlier output (the page join is rebuilt per edit). `find` non-empty (else 400); `replace` may be `""` (delete). Both literal — `Pattern.quote`d, no regex. Case-sensitive. |
| `wholeWordSearch` | `"true"`/`"false"` (default false). Implemented as `(?<!\w)(?:…)(?!\w)` with ASCII `\w` (no `UNICODE_CHARACTER_CLASS`). |
| `pageNumbers` | `"all"` (default), 1-based ranges `"1,3,5-9"`. |

**Matching.** Per page, all text elements are concatenated **with no separators**
before matching. Finds span kerning-split runs — but when inter-word spacing is
positional (TJ offsets, justified text) the joined text has no space character and
multi-word finds fail silently. Cross-element replacements anchor at the first
element; no reflow; centered/tracked text shifts left.

**Response.** HTTP 200 with raw PDF bytes only. Replacement counts are logged
server-side (one aggregate modified-element count) and **not returned**.

**Font handling.** Per page: if every edited element's original font can encode the
replacement, the original streams are token-rewritten in place. If **any** element
on the page needs a fallback (bundled Noto set), token rewrite is skipped and the
**entire page is regenerated** — all runs re-laid out from extracted positions,
vector graphics recovered via a lossy extraction path. Complex content streams can
force page regeneration even without fallbacks.

**Round-trip caveats.** The document is fully regenerated (PDF→JSON→PDF, fresh
`PDDocument`) even on zero matches. Preserved: text, per-page annotations, AcroForm
fields, XMP metadata. **Not preserved:** images (decoded and re-encoded — JPEG
recompression, CCITT/JBIG2 format swaps), bookmarks/outline (dropped; sidecar
restores), PDF/A OutputIntent (dropped while XMP still claims conformance),
owner-password encryption (silently stripped). Unknown, Phase 0 verifies: embedded
file attachments, tagged-PDF structure trees, internal links/GoTo destinations,
page labels.

**Errors.** 400 with Stirling's JSON error body (already parsed by the sidecar);
user-password-encrypted input fails PDFBox load with a password-flavored message
(existing `ENCRYPTED_DOCUMENT` mapping); disabled endpoint → 403 (existing
`UNSUPPORTED` mapping).

## Decisions log

- **Scanned/image-only documents are out of scope for v1** (was: allowed with a
  hidden-text warning). Image re-encoding (C1) makes any edit degrade the visible
  scan; the OCR-layer-fix use case is cut. Gate copy routes scans away from the
  feature entirely. Mixed born-digital documents proceed behind Phase 0 evidence
  and review-dialog disclosure.
- **Phase 0 go/no-go before UI investment.** Fidelity is now a measured question,
  not an assumption.
- **Counts and warnings are computed client-side.** The endpoint returns bytes
  only. The review step re-extracts text from the candidate bytes (pdf.js) and
  reports per-op found/not-found with page lists by re-running the matcher; the
  seam result keeps a `replacedCounts` slot (null for now) for a future engine
  that reports counts.
- **Stage-then-confirm, batched.** One engine round trip produces candidate bytes
  held in memory; a review dialog shows results, warnings, and before/after page
  previews; only Apply commits via `replaceBytes`. Cancel (and zero-change) means
  the document was never modified — and the copy says so. Memory is bounded: docs
  ≥50 MiB always open streamed (`largeDocThreshold.ts`) and streamed docs are
  gated, so staging holds at most a few copies of a <50 MiB file.
- **Case-sensitive preview, exact-parity matcher.** The UI preview reimplements the
  engine's construction literally: `Pattern.quote` semantics, ASCII-`\w`
  lookarounds for whole-word, per-edit re-join. No case toggle in v1 (expandable
  later as one op per casing).
- **No occurrence-level targeting in v1.** Page scoping (`pageIndexes: [n]`) covers
  "replace on this page only"; Nth-match targeting would mean reimplementing
  upstream's span logic client-side. Options type leaves room.
- **Signed documents: refuse, then confirm.** New `SIGNED_DOCUMENT` error unless
  `allowSignatureInvalidation: true`; detection via a new minimal counter in
  `@raiopdf/engine-pdf-lib`; post-apply flows into the existing
  signature-invalidation notice pipeline. `redactText` alignment is a noted
  follow-up.
- **Permissions-protected documents: refuse in v1** (M2). Never silently strip
  document protection.
- **PDF/A documents: explicit opt-in + strip the conformance claim** (C2). Never
  output a false PDF/A identification.
- **A Redact-style mode, not part of the annotation EditLayer.** Same reasoning as
  v1: sidecar full-document rewrite with a review step belongs in the
  enter-mode → confirm → engine → verify → commit pattern users already know.
- **Mutual exclusion with pending annotation edits, via a real confirm flow** (M3):
  entering text-edit mode with pending annotations prompts Save / Discard /
  Cancel; annotation tools are blocked while text ops are queued.
- **After apply, Save becomes Save As** (keep `fileName`, clear `filePath`) — the
  redaction precedent minus the `_redacted` rename. No undo exists for applied
  mutations; preserving the original on disk is the honest mitigation.
- **MCP tool: deferred.** Forces the `docs/MCP.md` count sync (PR #134 drift) and
  the caveats deserve a human in the loop. Follow-up once the seam is proven.

## Phase 0 — Fidelity spike (go/no-go)

Build the pinned engine (`pnpm engine:build`) and drive `/edit-text` directly with
a fixture battery; measure with scripted extraction/hashing, eyeball the outputs:

1. **Born-digital pleading** (Word-derived, justified text, footnotes): multi-word
   and single-word finds; verify replacement, layout drift, file-size delta.
2. **Scanned JPEG exhibit + CCITT-G4 fax scan:** zero-match run; measure image
   bytes/format/quality before vs after (confirms C1's real-world severity and
   the mixed-document disclosure copy).
3. **PDF/A-1b and PDF/A-2b files:** confirm OutputIntent loss + stale XMP claim;
   validate the strip-identification mitigation.
4. **Bookmarked + internally-linked document:** outline restore works on
   regenerated bytes; do GoTo destinations survive?
5. **Attachments + tagged PDF:** do embedded files and structure trees survive?
6. **Owner-password (permissions-only) document:** confirm silent decryption
   (validates the client-side refusal).
7. **AcroForm document:** fields and appearances after round trip.
8. **Large image-heavy document:** sync-call wall time (no progress channel —
   informs loader copy), multipart limits at 100 MB+.

Exit criteria: born-digital fidelity acceptable (text, forms, annotations, links);
mixed-document image degradation characterized well enough to write honest
disclosure copy; wall-time acceptable or bounded by a size gate. If born-digital
fidelity itself fails, stop — file upstream issues and shelve the plan.

## Phase 1 — Engine seam

### `packages/engine-api/src/index.ts`

New types (house naming), new `PdfEngineErrorCode` member `"SIGNED_DOCUMENT"`, and
a `replaceText` method placed near `redactText`:

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
  /** Match only on ASCII word boundaries (engine semantics). Defaults to false. */
  wholeWord?: boolean;
  /** Zero-based pages to search, or "all" (default). */
  pageIndexes?: PdfPageSelection;
  /** Required opt-in when the document has signed signature fields. */
  allowSignatureInvalidation?: boolean;
  /** Required opt-in when the document declares PDF/A conformance. */
  allowPdfAIdentificationRemoval?: boolean;
};

export type PdfReplaceTextWarning = {
  code:
    | "COUNTS_UNAVAILABLE"
    | "SIGNATURES_INVALIDATED"
    | "FALLBACK_FONT_POSSIBLE"
    | "PDFA_IDENTIFICATION_REMOVED"
    | "IMAGES_REENCODED";
  message: string;
};

export type PdfReplaceTextResult = {
  document: PdfDocumentHandle;
  /** Index-aligned per-op counts when the engine reports them; null otherwise. */
  replacedCounts: readonly number[] | null;
  warnings: readonly PdfReplaceTextWarning[];
};
```

The method doc comment states the contract plainly: literal case-sensitive
find/replace in real content streams; no reflow; the **whole document is
regenerated** (images re-encoded, pages with un-encodable glyphs fully re-laid
out) even on zero matches; positional word spacing can defeat multi-word finds;
engines that can't rewrite content streams reject `UNSUPPORTED`.

### `packages/engine-pdf-lib`

Add a minimal `countSignedSignatureFields(bytes)` helper (the logic exists inline
in `assessPdfAConversionImpact`; extract, don't duplicate). This package is
already a dependency of engine-sidecar and already exports
`readPdfAIdentificationFromBytes`, which the sidecar also needs here.

### `packages/engine-local/src/index.ts`

`replaceText` throws `PdfEngineError("UNSUPPORTED", …)` — pdf-lib cannot re-encode
glyph runs. Same pattern as `compress`/`repair`, plus test.

### `packages/engine-sidecar/src/index.ts`

1. Validate: ≥1 operation, every `find` non-empty, `assertPageSelection`.
2. Preflights on the input bytes (all client-side, pdf-lib):
   - encryption dictionary present (permissions-only protection) → refuse
     `ENCRYPTED_DOCUMENT` (the upstream engine would silently strip it);
   - `countSignedSignatureFields > 0` → `SIGNED_DOCUMENT` unless opted in
     (then `SIGNATURES_INVALIDATED` warning);
   - `readPdfAIdentificationFromBytes` claims PDF/A → refuse with a descriptive
     `UNSUPPORTED_INPUT`-style message unless `allowPdfAIdentificationRemoval`,
     in which case post-process the output to strip the `pdfaid` XMP claim and
     append `PDFA_IDENTIFICATION_REMOVED`.
3. POST `/api/v1/general/edit-text`: `createFormData(bytes)` +
   `edits: JSON.stringify(ops)` + `wholeWordSearch` + `pageNumbers` via
   `toSidecarPageNumbers`. Plain proxied Stirling call — no Rust changes (the
   loopback proxy forwards all authenticated `/api/*` paths).
4. **Restore the outline** onto the returned bytes with the existing
   `preserveSamePageOutline(sourceBytes, outputBytes)` — load-bearing.
5. Result: `replacedCounts: null` + `COUNTS_UNAVAILABLE`; `IMAGES_REENCODED`
   warning whenever the input contains image XObjects; heuristic
   `FALLBACK_FONT_POSSIBLE` when the output contains `Noto*` base fonts the input
   lacked (documented as heuristic).
6. Add the endpoint row to the header mapping table with the full caveat set
   (no-reflow, positional-space matching, page-level regeneration, image
   re-encoding, bookmark restore, counts log-only).

### `engine/verify-live.sh`

Add an `edit-text` check against the synthetic two-page PDF: find `Page`, replace
`Sheet`, assert 200 **and assert the output's extracted text contains `Sheet` and
not `Page`** (house `curl_ok` + a small extraction assert), so an engine bump that
moves, gates, or breaks the endpoint fails loudly.

## Phase 2 — Bridge

`apps/ui/src/hooks/useEngineBridge.ts` gains the eighth op, following the
`sanitize` template (`withEngineRetry` → open → op → `saveToBytes` → close both
handles in `finally`):

```ts
replaceText: (bytes: Uint8Array, options: ReplaceTextBridgeOptions) =>
  Promise<{ bytes: Uint8Array; replacedCounts: readonly number[] | null;
            warnings: readonly PdfReplaceTextWarning[] }>;
```

`PdfEngineError` passes through untouched so the UI can branch on
`SIGNED_DOCUMENT` (confirm-and-retry with the opt-in), `ENCRYPTED_DOCUMENT`
(explain protection; no unlock offer for permissions-only docs in v1),
PDF/A refusal (confirm-and-retry with the opt-in), and `UNSUPPORTED`. Warnings
travel in the resolved value, never as errors.

## Phase 3 — UI (apps/ui)

A canvas mode structurally sibling to Redact: `ToolRow` in the ToolPanel **Edit**
group → mode bar → inline status expansion → staged engine round trip → review
dialog → commit.

**New files.**

| Path | What |
|---|---|
| `apps/ui/src/lib/textEdit.ts` | Pure logic: `PendingTextReplacement`; `findTextMatchesInPages` with **engine-parity matching** (literal case-sensitive, ASCII-`\w` lookaround whole-word, per-edit re-join, plus a positional-space detector that flags multi-word finds likely to fail); `deriveTextEditGate`; length-delta advisory; candidate-vs-original per-op found/not-found reporting; warning-code → plain-language copy map; `formatReplaceTextResult`. |
| `apps/ui/src/hooks/useTextEdit.ts` | Mode state hook modeled on `useDocumentSearch` + redaction phases: query/replacement/wholeWord, matches + prev/next, `pendingOps`, `phase: idle\|staging\|review\|applying\|done\|error`, `staged`, `review()`, `apply()`, `cancelReview()`. Debounce, generation-reset, staleness guards. |
| `apps/ui/src/components/EditTextModeBar.tsx` | Find/replace fields, whole-word `Switch`, match label (`aria-live`), prev/next, "Replace all" (queues — never fires the engine), queued count, Exit. Reuses `LegalModeBar.css`. |
| `apps/ui/src/components/EditTextReviewDialog.tsx` | FloatingDialog: indeterminate `LongProcessLoader` while staging (sync endpoint has **no progress channel** — copy must not promise progress; image-heavy docs can take minutes); per-op found/not-found with page lists; grouped plain-language warnings; before/after page thumbnails for text-diffed pages **plus a standing disclosure: "The whole document is rewritten by this operation. Pages not shown here may shift slightly."**; zero-change path: Apply disabled, "Nothing was replaced — the document was not modified."; Apply / Cancel. |
| `apps/ui/src/components/EditTextStatusPanel.tsx` | ToolPanel expansion: gate messages, the always-visible advisory ("Replacements never reflow the page…"), a multi-word caution when the positional-space detector fires, pending-op list with per-op remove, Review button, done/error summary with jump links. |

**Modified:** `toolRegistry.ts` (new `edit-text` entry), `ToolPanel.tsx`, `App.tsx`
(mode state, pending-annotations confirm flow, mode-bar ternary, matches into the
existing `CanvasWell` highlight channel), `AppShell.tsx` (disable CommandBar search
with a tooltip while the mode owns the highlight channel), `useEngineBridge.ts`
(Phase 2), plus wiring post-apply signature state into the existing
signature-invalidation notice pipeline.

**Gating** (one pure `deriveTextEditGate`, surfaced as `InlineMessage`):

1. Streamed documents: gated with a specific message ("too large for in-app text
   editing") — not `STREAMED_DOCUMENT_GATE_MESSAGE`, which promises fallbacks this
   feature lacks.
2. **Scanned/image-only documents: gated outright** ("Text editing isn't available
   for scanned documents."). No OCR routing into this feature — editing the hidden
   OCR layer would degrade the visible scan (image re-encoding) for no visible
   benefit. Mixed pages: matches on image-backed pages are excluded, with a note.
3. Garbled pages: reuse the existing "matching may be incomplete" warning +
   force-OCR route (for search quality, not for editing scans).
4. Signed documents: `SIGNED_DOCUMENT` from the bridge → invalidation confirm →
   retry with opt-in; post-apply banner via the existing notice pipeline.
5. Permissions-protected documents: gated with an explanation (v1 refuses).
6. PDF/A documents: confirm dialog ("Editing removes this file's PDF/A marking —
   you can convert again afterward.") → retry with the opt-in.
7. Pending annotation edits: Save / Discard / Cancel confirm on entering the mode;
   annotation tools blocked while text ops are queued.

**Post-apply.** `replaceBytes(candidateBytes, { dirty: true, hasTextLayer: null,
expectedOpenToken, expectedGeneration })`; scroll intent to the first affected
page; summary in the expansion; keep `fileName`, clear `filePath` so Ctrl+S is
Save As.

**Preview honesty.** The preview count is labeled an estimate; the review's
re-extraction is authoritative; multi-word finds carry the positional-space
caution. `warmEngine()` fires when the first op is queued.

**A11y/keyboard:** Esc exits the mode, Enter/Shift+Enter next/previous in the find
field, `role="toolbar"`, no color-only warnings, alt text on before/after thumbs.
No global Ctrl+H in v1.

## Phase 4 — Verification & docs (same PR)

**Unit (Vitest).**
- `packages/engine-sidecar/test/sidecar-engine.test.ts`: request encoding; empty-op
  preflight rejections; signed-doc refuse + opt-in path; permissions-protected
  refusal; PDF/A refuse + opt-in + XMP-strip; outline restored; `replacedCounts:
  null` + `COUNTS_UNAVAILABLE`; `IMAGES_REENCODED` on image-bearing input; 403 →
  `UNSUPPORTED`.
- `packages/engine-pdf-lib`: `countSignedSignatureFields` fixtures.
- `packages/engine-local`: `replaceText` → `UNSUPPORTED`.
- `apps/ui`: `textEdit.test.ts` (engine-parity matching incl. the exact lookaround
  regex, positional-space detector, gate derivation, per-op reporting, advisory),
  `useTextEdit.test.tsx` (debounce, generation reset, stale apply, cancel/zero-
  change leave bytes untouched), component tests, `useEngineBridge.test.tsx` case.

**Smoke (`apps/ui/smoke/app.smoke.ts`).** Queue → review (mocked engine) →
warnings + previews + whole-document disclosure render → Apply → text changed,
Save prompts Save As. Cancel path: bytes unchanged. Zero-change path: Apply
disabled. Pending-annotations confirm flow. Scanned-document gate. Extend
`streamed-large.smoke.ts` for the streamed gate message.

**Canary (required — PR touches `apps/ui` + sidecar).** Real-engine replace round
trip in `apps/ui/smoke/real-engine/`, verified by pdf.js re-extraction (old string
gone, new present, bookmarks intact) on the Phase 0 born-digital fixture; an
image-bearing fixture asserting the output's images stay within the size/quality
envelope Phase 0 established. Run `pnpm prepare:shell-bundle` once, then
`pnpm canary`; paste the summary into the PR.

**Docs (CLAUDE.md "keep the docs honest").** README feature-table row stating the
limits plainly (born-digital only, no reflow, case-sensitive, whole document
regenerated); `packages/help-content` article `edit-text` covering whole-word,
page scoping, centered-text shift, substitute fonts, multi-word/justified-text
limitation, image re-encoding on mixed documents, signature invalidation, PDF/A
marking removal, and Save-As behavior; `site/shared/COPY.md` only if the landing
page will claim the feature. `docs/ARCHITECTURE.md` unchanged. `docs/MCP.md`
unchanged (tool deferred).

## Suggested PR slicing

0. **PR 0 — Phase 0 artifacts:** fixture battery + a short findings note appended
   to this plan (go/no-go recorded).
1. **PR 1 — seam + sidecar:** engine-api, engine-pdf-lib helper, engine-local
   stub, engine-sidecar, verify-live, bridge op, unit tests.
2. **PR 2 — UI + docs:** Phase 3 + smoke + canary + README/help article.

## Risks & open items

- **Phase 0 may kill or shrink the feature.** Image re-encoding severity and
  born-digital fidelity are measured, not assumed. Upstream issues get filed
  either way (counts/warnings in the response; separator-aware joining;
  image passthrough; OutputIntent preservation) — any of them landing in a future
  pinned engine simplifies this plan.
- **Multipart size limits:** check once at 100 MB+ (Phase 0 item 8); if fragile,
  the fix is a Spring property in the launch config, not a `/local` interceptor.
- **Encrypted-input mapping:** confirm the PDFBox failure message shape maps to
  `ENCRYPTED_DOCUMENT` (Phase 0).
- **Endpoint drift on engine bumps:** `edit-text` is ungrouped in
  `EndpointConfiguration` today; verify-live is the tripwire (it runs in
  `engine.yml` on engine changes + weekly cron — adequate for a vendoring
  tripwire, not per-PR).
- **`redactText` signature-preflight alignment** (follow-up PR).
- **Preview/engine disagreement** beyond positional spacing (ligatures,
  hyphenation): mitigated by the authoritative review diff + zero-change guard.

## Future (not in v1)

- **Inline click-to-edit:** needs a selectable pdf.js text-layer overlay plus
  occurrence-level targeting (upstream support or driving the pdf↔json pipeline).
  The staging/review/apply pipeline is reused unchanged.
- **Scanned-document visual correction:** a patch-and-retype overlay (cover old
  pixels, place new text, disclosed as an overlay) — a different feature with a
  different trust story; deliberately not this plan. Depends on stamps/appearance
  machinery, not on `/edit-text`.
- **MCP `replace-text` tool** (with the `docs/MCP.md` count sync).
- **Ctrl+F/Ctrl+H** after a CommandBar find shortcut exists.

## Phase 0 findings — 2026-07-05 (GO)

Ran the fixture battery against the locally-built pinned engine
(`stirling-pdf-2.14.0-linux-x64.jar`, this branch's vendored + patched source;
`pnpm engine:build` + `engine:verify` green, incl. the image-passthrough check).
Each fixture synthesized, driven through `/api/v1/general/edit-text`, and measured
with scripted extraction/hashing (pymupdf + pikepdf).

| # | Fixture | Result | Verdict |
|---|---------|--------|---------|
| 1 | Born-digital pleading (justified, footnote) | Single-word (`Plaintiff`→`Petitioner`) and same-run multi-word (`MOTION TO DISMISS`→`MOTION TO STRIKE`) both replaced; extracted text confirms. **Zero layout drift** on an unchanged control word (dx=0, dy=0). File 29% smaller after regeneration. | PASS |
| 2 | Scanned JPEG exhibit + CCITT-G4 fax (zero-match) | Image XObject raw-stream SHA, `/Filter`, and dimensions **byte-identical** before/after for *both* DCTDecode (JPEG) and CCITTFaxDecode. The passthrough patch holds on real scans. | PASS (patch confirmed) |
| 3 | PDF/A-1b and PDF/A-2b | `/OutputIntents` **dropped** (present→absent) for both; `pdfaid:part` XMP claim **retained** (1→1, 2→2). Output therefore advertises PDF/A conformance it no longer meets — a stale claim, exactly as anticipated. | Strip identification (planned mitigation confirmed necessary) |
| 4 | Bookmarks + internal GoTo links | Outline **dropped** (3→0); internal GoTo links **survive** (1→1). | `preserveSamePageOutline` restore confirmed load-bearing |
| 5 | Attachments + tagged (StructTree/Marked) | Embedded files **dropped** (1→0); `MarkInfo/Marked` and `StructTreeRoot` **dropped**. Text replaced fine. | **NEW — unmitigated in v2 (decision below)** |
| 6 | Owner-password (permissions-only) | Engine **silently decrypts** (input encrypted → output not encrypted), no password supplied. | Client-side `ENCRYPTED_DOCUMENT` refusal confirmed necessary |
| 7 | AcroForm (text field + checkbox) | Fields (2→2), widget appearance streams (2→2), and field value (`Jane Doe`) all **preserved**. | PASS |
| 8 | Large image-heavy doc | 244.6 MB input → HTTP 200 in **7.88 s**, output 244.6 MB (no bloat — images pass through). No multipart rejection at 244 MB. | PASS (size-gated loader copy) |
| + | Markup annotations (Highlight + FreeText) | Both **survive** the round trip. | PASS |

**Go/No-Go: GO.** Born-digital fidelity is clean across text, AcroForm fields,
markup annotations, and internal links; the one dropped structure (outline) is
restored by the sidecar's `preserveSamePageOutline`. Mixed-document image handling
is now byte-clean (patch). Wall time is acceptable and bounded by input size, not a
hard cap. Nothing here blocks the plan.

### Decisions for Jacob (do not silently change scope)

1. **RESOLVED - Attachments + tagged structure are silently dropped.** The seam
   warns and restores embedded file attachments by grafting the source
   `/Names /EmbeddedFiles` tree back onto the output. If attachment restoration
   fails or is partial, the sidecar emits `ATTACHMENTS_REMOVED`. Tagged-PDF
   structure cannot be restored faithfully, so tagged inputs emit
   `TAGS_REMOVED`.
2. **RESOLVED - Relax the scanned-document gate to image-only.** Mixed documents
   are safe for the UI phase because the bundled patched engine preserves image
   streams byte-identically. The UI phase should gate documents with no
   extractable text layer, not documents that merely contain images.

### Copy implications

- **`IMAGES_REENCODED` warning:** on our patched bundled engine, images are
  preserved (F2), so this warning should not fire for our build. Keep it only as a
  guard for an un-patched engine, or drop it — revisit in the sidecar phase.
- **Loader copy:** a large document round-trips in seconds with no progress
  channel (244 MB → ~8 s). A size-based "this may take a few seconds" message is
  sufficient; no streaming progress needed for v1.
- **PDF/A:** after an edit the file is no longer valid PDF/A (OutputIntent gone);
  stripping the stale `pdfaid` claim so the output stops advertising conformance is
  the honest behavior, and F3 confirms the engine leaves that claim behind.
