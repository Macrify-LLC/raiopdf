# 0003 — Functional patches to the vendored engine, carried as upstream candidates

- Status: accepted
- Date: 2026-07-05
- Related: `docs/ENGINE-VENDORING.md` (patch mechanics), `docs/plans/direct-text-editing-plan-2026-07-05.md` (the feature that surfaced the first one)

## Context

The vendoring pipeline was built around a "pristine upstream" guarantee: the
engine tree is byte-for-byte the pinned Stirling-PDF commit, minus the scripted
non-MIT scrub, plus exactly one build-plumbing patch (`settings-gradle.patch`).
Two independent worktree-status gates (`engine/vendor.sh`, `engine/build.sh`)
enforced that nothing else could differ, and no policy existed for changing
upstream *behavior*.

Planning direct text editing exposed a real fidelity defect in upstream's
`/edit-text` pipeline: `PdfJsonConversionService` decodes and re-encodes every
image XObject through `BufferedImage`/`ImageIO` on every call — generational
JPEG recompression and CCITT/JBIG2 format swaps, even when nothing matches.
For a product whose users edit scanned legal exhibits, that is disqualifying.
The fix is small (~200 lines, MIT-core files only — the lossless raw-stream
machinery already exists upstream; images were just deliberately excluded from
it), but upstream is unfixed as of v2.14.0, no upstream issue existed, and
Stirling's contribution process (issue → assignment → PR → release) puts a fix
months out. Waiting would block the text-editing feature on someone else's
release cadence; forking the engine outright would betray the vendoring model.

## Decision

Allow **functional patches** to the vendored engine, under tight rules:

1. **Every functional patch is an upstream candidate.** A patch is only
   acceptable if it is written to upstream's standards, filed (or ready to
   file) as an upstream issue/PR, and intended to be **deleted** once a pinned
   engine release contains the fix. Patches are a queue for upstream, not a
   fork.
2. **Patches live in `engine/patches/*.patch`** (git-diff format, applied in
   sorted order after `settings-gradle.patch`). Each file a patch modifies is
   pinned by its post-patch SHA-256 in `engine/PINNED_PATCHED_FILES_SHA256`,
   mirroring the existing `settings.gradle` hash gate. The worktree-status
   allowlists in `vendor.sh` and `build.sh` are driven by that manifest — a
   modified file that is not listed still hard-fails.
3. **MIT-core files only.** A patch may never touch, restore, or depend on
   carved-out non-MIT paths.
4. **Every patch must be exercised by `engine/verify-live.sh`** with a check
   that fails on an unpatched engine, so a future pin bump that silently drops
   or breaks the patch is caught by CI (`engine.yml`), not by users.
5. **Per-bump maintenance is on whoever bumps the pin**: re-apply, regenerate
   if drifted, re-pin hashes, and re-check whether upstream has landed the fix
   (in which case the patch is deleted). This extends the existing
   "patch maintenance" open risk in `docs/ENGINE-VENDORING.md`.

The first patch under this policy is `pdfjson-image-passthrough.patch`
(preserve raw image XObject streams through the `/edit-text` PDF→JSON→PDF
round trip), verified by the `edit-text-image-passthrough` check.

## Consequences

- The provenance guarantee changes from "pristine upstream + build plumbing"
  to "pinned upstream + enumerated, hash-pinned, CI-verified behavioral
  diffs". That is a real weakening, accepted deliberately and kept auditable:
  the full set of behavioral changes is always `ls engine/patches/`.
- Engine pin bumps get more expensive in proportion to the number of live
  patches — which is exactly the pressure that keeps the queue short and the
  upstream contributions moving.
- Rejected alternatives: waiting for upstream (blocks shipping on an external
  release cadence), maintaining a public fork of Stirling-PDF (heavier
  divergence, worse auditability, same maintenance cost without the
  self-deleting pressure), and client-side repair of re-encoded images in the
  sidecar (unsound — the original bytes are already destroyed by the time the
  response arrives).
