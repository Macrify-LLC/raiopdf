# 0004 — Extend the Node one-shot lane for streamed large-document workflows

- Status: accepted
- Date: 2026-07-06
- Related: PR 1 `macro/node-lane-binder`, PR 2 `macro/node-lane-editing`

## Context

Streamed large documents render through pdf.js range transport and intentionally
do not materialize full PDF bytes in the WebView. Some local features still need
the TypeScript engine implementation, especially exhibit binders and annotation
mode edits in `engine-local`. PR 1 introduced a shell-owned Node one-shot lane
for `build_binder`; streamed editing needs the same file-to-file commit path.

## Decision

Extend the existing one-shot runner instead of creating a second Node runner.
The shell resolves file grants, writes any inline payload bytes to shell-owned
temp files, calls the bundled MCP entrypoint with `--one-shot <op>`, verifies
the output, and grants only the verified file. `apply_edits` joins
`build_binder` on this lane.

Shared policy:

- 400 MiB main-document ceiling, controlled by `RAIOPDF_NODE_LANE_MAX_BYTES`.
- `NODE_OPTIONS` includes `--max-old-space-size=8192` and
  `--disallow-code-generation-from-strings`.
- The shell chooses all input, temp, and output paths.
- Payloads use temp-file references for image/signature bytes instead of inline
  base64.
- Streamed edit saves are Save-As-only in v1: the generated copy reopens as a
  new document and the original range-read file is never overwritten.
- No user-facing cancel in v1; the shell still owns timeout enforcement.
- Network access is not part of the lane contract. The one-shot process is used
  for local file operations only.

## Consequences

One runner keeps packaging, timeout, status, and ceiling behavior uniform across
large-document Node operations. The tradeoff is that the lane remains an
unsandboxed local Node process, so mitigations are process flags, shell-chosen
paths, byte ceilings, temp directories, output verification, and narrow
one-shot entrypoints rather than a separate OS sandbox.

Save-As-only avoids corrupting or replacing a PDF that pdf.js is actively
range-reading. A future in-place streamed save can be designed separately if
the product needs it.
