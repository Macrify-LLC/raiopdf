# Direct Text Editing — Execution Plan (entry point)

Date: 2026-07-05.
Audience: an implementer (human or agent) working in an environment that can
build the engine and run the full app test suite locally.
Detailed design: `docs/plans/direct-text-editing-plan-2026-07-05.md` (v2 — read
it before starting; this document is the runnable checklist, that one is the
contract). Engine-patch policy: `docs/decisions/0003-functional-engine-patches.md`.

## Mission

Ship find & replace against real PDF content streams ("Edit Document Text"),
driven by the bundled Stirling engine's MIT-core `/api/v1/general/edit-text`
endpoint, with honest UX around its hard limits (no reflow, case-sensitive
literal matching, whole-document regeneration, fallback fonts).

## Current state (this branch, PR #152)

Already done — do not redo:

- Plan v2 with adversarial-review findings folded in (`docs/plans/direct-text-editing-plan-2026-07-05.md`).
- Vendoring pipeline supports hash-pinned functional patches
  (`engine/vendor.sh`, `engine/build.sh`, `engine/PINNED_PATCHED_FILES_SHA256`,
  ADR 0003).
- `engine/patches/pdfjson-image-passthrough.patch` — fixes upstream's
  image re-encoding in the `/edit-text` round trip (the plan's critique finding
  C1). Verified `git apply --check` clean on v2.14.0; parse-clean under javac 25;
  **not yet compiled or live-verified** (authoring environment could not
  download Gradle). An upstream issue draft exists (delivered to Jacob; patch is
  slated for upstream contribution and eventual deletion).
- `engine/verify-live.sh` gained two checks: `edit-text` (asserts replaced
  output text) and `edit-text-image-passthrough` (zero-match edit must preserve
  image stream bytes — fails on an unpatched engine).
- Engine workflow accepts `workflow_dispatch`.

## Step 0 — Verify the patched engine (blocking everything else)

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm engine:vendor                       # clone v2.14.0, scrub, apply patches, hash gates
PLATFORM=<host-platform> pnpm engine:build   # linux-x64 | darwin-arm64 | windows-x64 ...
pnpm engine:verify                       # boots the JAR; must end "Live engine contract test passed"
```

- Expected: all checks pass, including `edit-text: output text verified` and
  `edit-text-image-passthrough: original image stream preserved byte-identically`.
- If the **build fails to compile** the patched files: fix the patch
  (`engine/patches/pdfjson-image-passthrough.patch`), re-run vendor/build, then
  re-pin both hashes in `engine/PINNED_PATCHED_FILES_SHA256` from the vendored
  tree (`sha256sum` the two files inside `engine/upstream/`). Keep fixes
  minimal and upstream-submittable.
- If the **image-passthrough check fails** on the patched engine: the patch's
  passthrough logic is wrong — debug via the Stirling log the script tails on
  failure. Do not weaken the check.
- The Engine CI workflow on PR #152 runs the same sequence on Linux; keep it
  green.

## Step 1 — Phase 0 fidelity spike (go/no-go)

Run the fixture battery from plan v2 "Phase 0" against the locally built
engine (drive `/edit-text` directly with curl or a scratch script): born-digital
justified pleading, JPEG + CCITT-G4 scans (image fidelity should now hold —
confirm), PDF/A-1b/2b, bookmarks + internal links, attachments, tagged PDF,
AcroForm, owner-password-only, 100 MB+ doc (wall time, multipart limits).

Record results by appending a short dated "Phase 0 findings" section to the
plan doc, including the explicit go/no-go call and any copy implications
(especially: whether mixed-document image handling is now clean enough to relax
the scanned-document gating decision — note it as a decision for Jacob, don't
silently change scope). If born-digital fidelity fails, stop and report.

## Step 2 — Engine seam (plan v2 "Phase 1")

Implement exactly per plan v2: types + `replaceText` + `SIGNED_DOCUMENT` code
in `packages/engine-api`; `countSignedSignatureFields` extracted in
`packages/engine-pdf-lib`; `UNSUPPORTED` stub in `packages/engine-local`;
sidecar implementation in `packages/engine-sidecar` (validation, client-side
preflights: permissions-encryption refusal, signed-doc gate, PDF/A opt-in +
XMP-strip; POST; `preserveSamePageOutline` restore; warnings incl.
`IMAGES_REENCODED` — revisit that warning's copy/necessity given the patch, it
now applies only to engines built without it). Add the endpoint row to the
sidecar's header mapping table. Unit tests per plan v2 "Phase 4".

Gates: `pnpm -r typecheck && pnpm -r build && pnpm -r test && pnpm -r lint`.

## Step 3 — Bridge (plan v2 "Phase 2")

Eighth op in `apps/ui/src/hooks/useEngineBridge.ts` following the `sanitize`
template; `PdfEngineError` passes through untouched; extend
`useEngineBridge.test.tsx`.

## Step 4 — UI (plan v2 "Phase 3")

Redact-style mode: `textEdit.ts` (engine-parity matcher — literal,
case-sensitive, ASCII-`\w` lookaround whole-word, positional-space detector),
`useTextEdit.ts`, `EditTextModeBar`, `EditTextReviewDialog` (stage-then-confirm,
before/after previews, whole-document-rewritten disclosure, zero-change blocks
Apply), `EditTextStatusPanel`; gating incl. scanned-docs-out, streamed gate,
pending-annotations Save/Discard/Cancel confirm; post-apply via `replaceBytes`
with cleared `filePath` and the existing signature-invalidation notice. Smoke
tests per plan v2.

## Step 5 — Verification & docs (plan v2 "Phase 4")

- Full repo gates + Playwright smoke suite.
- `pnpm prepare:shell-bundle` (once) then `pnpm canary`; add the replace-text
  canary scenario; paste the summary line into the PR.
- Same-PR docs: README feature row, `packages/help-content` `edit-text`
  article, `site/shared/COPY.md` only if the landing page will claim it.

## Sequencing / PR shape

This branch (PR #152) should stay scoped to: plans + engine patch + pipeline +
verify-live (Steps 0–1). Implement Steps 2–3 as the next PR ("seam + sidecar")
and Steps 4–5 as the one after ("UI + docs"), per plan v2's PR slicing — or
fold 2–3 into this PR only if Jacob prefers fewer PRs.

## Hard constraints (from CLAUDE.md — non-negotiable)

No hand-edits inside `engine/upstream` (changes go through
`engine/patches/` + re-pinned hashes); MIT-core files only; no telemetry, no
network beyond loopback + the signed update check; docs honesty (feature copy
states the real limits); this is a public repo.
