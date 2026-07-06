# Direct Click-to-Edit Phase 0 Findings

Date: 2026-07-06.
Scope: local feasibility spike for selection-backed, occurrence-targeted text
replacement above the shipped Find & Replace path.

## Goal

Prove or disprove the narrow contract needed for a first direct edit experience:
the user selects visible text, RaioPDF maps that selection to exactly one engine
text span, and the engine replacement changes only that selected span. This is
not a proof of freeform caret editing, paragraph reflow, or Acrobat-style text
box editing.

## Local Artifact

Added a dependency-free Node harness:

```bash
node scripts/direct-click-edit-phase0.mjs
node --test scripts/direct-click-edit-phase0.test.mjs
```

The harness models the engine-side PDFBox/PdfJson text map used by the current
bulk `/edit-text` path: text elements are joined with no inferred separators,
each target carries a page fingerprint, and replacement mutates only the text
elements overlapped by the selected range.

Added a live-engine check for the existing text-editor JSON route:

```bash
RAIOPDF_ENGINE_JAR=/path/to/stirling-pdf-2.14.0-windows-x64.jar \
  node scripts/direct-click-edit-live-engine.mjs
```

That script starts a local Stirling JAR, creates a PDF with two `John Smith`
occurrences, converts the PDF through `/api/v1/convert/pdf/text-editor`, edits
only the second occurrence in the JSON model, rebuilds through
`/api/v1/convert/text-editor/pdf`, and converts the output back to JSON to
verify the text.

## Cases Covered

| Case | Result |
|---|---|
| Repeated party name, selected second occurrence | PASS: only the second occurrence is edited. |
| Split text run across multiple elements | PASS: deleting the selected name clears overlapped elements and preserves following text. |
| Same-run middle edit | PASS: prefix and suffix survive. |
| Source changed after target capture | PASS: stale fingerprint is refused before mutation. |
| Duplicate candidates with indistinguishable geometry | PASS: resolver refuses ambiguous target. |
| pdf.js inferred space where engine has no literal space | PASS: resolver refuses with text-model mismatch instead of guessing. |
| Repeated table/column term with different geometry | PASS: geometry selects the intended occurrence. |
| Live engine JSON edit of second `John Smith` occurrence | PASS: output text is `John Smith v. Jane Doe`. |

## Finding

**Local GO to proceed to an engine prototype.** The targeted edit contract is
feasible when the target is resolved against the engine text map, not just the
pdf.js text layer. The important positive result is duplicate safety: both the
local harness and live text-editor JSON route can edit one selected occurrence
without falling back to global Find & Replace.

This is **not yet a production GO**. The live test uses Stirling's existing
full-document text-editor JSON route, not a hardened RaioPDF engine seam. The
production gate remains a real sidecar/engine prototype that exposes the engine
text map, accepts an occurrence target with a source fingerprint, rewrites PDF
bytes through the `PdfEngine` seam, and then passes live PDF fixtures.

## Implementation Implications

1. Treat the UI text layer as a selection affordance only. Do not use pdf.js
   selection text as the authoritative string to mutate.
2. Add an engine-backed inspect route before an apply route. The inspect route
   should return page text elements, rectangles, joined text offsets, and a
   source fingerprint.
3. Apply must accept page index, start/end offsets or element offsets, expected
   text, replacement text, and source fingerprint. If the fingerprint or
   expected text differs, return a stale/unsafe-target error.
4. The first shippable UI should be "Replace selected text" with review, not
   live caret editing. Backspace can be modeled as replacing the selected span
   with a shorter string or empty string after the engine target exists.
5. Ambiguity is a hard stop. If text and geometry do not resolve to exactly one
   engine span, the UI should ask the user to select a smaller/different span
   or use Find & Replace.

## Local Environment Note

This clean worktree did not contain `engine/upstream`, and the repo's engine
vendoring scripts are Bash entrypoints. `pnpm engine:vendor` was first attempted
from the normal PowerShell PATH and failed at `bash engine/vendor.sh` with
`'bash' is not recognized as an internal or external command`; Git Bash exists at
`C:\Program Files\Git\bin\bash.exe` but is not on PATH. The live-engine route
test was run against the existing built Windows JAR from the anchor checkout.
The next phase should still run from a clean, vendored worktree that can execute
`pnpm engine:vendor`, `pnpm engine:build`, and `pnpm engine:verify`.
