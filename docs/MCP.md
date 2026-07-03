# RaioPDF MCP Server

> The "bring your own AI" connector for RaioPDF's local tools.

RaioPDF has **no AI inside** — and this connector doesn't change that. It is an
optional, off-by-default bridge that lets *your own* AI assistant (Claude
Desktop, Claude Code) operate *your own* local RaioPDF tools. Everything runs on
your machine: the connector speaks [MCP](https://modelcontextprotocol.io) over
stdio (your AI client launches it as a subprocess — nothing listens on any
network), and every PDF operation runs locally through RaioPDF's bundled engine.
Files never leave your computer.

RaioPDF is the only PDF suite that is both **AI-free** and **first-class
AI-operable**: the toolbox stays deterministic; the AI just drives it.

## Turning it on

It is **off by default**, and the toggle is a real access gate — the connector
refuses to serve any tool until you enable it.

1. In RaioPDF, open **File → Open Raio to AI…** (or Preferences → "Open Raio to
   AI").
2. Flip the toggle on. RaioPDF writes a small enable flag to your user config dir
   (`$XDG_CONFIG_HOME` / `%APPDATA%` / `~/.config` → `me.macrify.raiopdf/mcp-enabled`)
   that the connector checks on startup.
3. Copy the shown config snippet into your AI client (below) and restart it.

Turning the toggle off removes the flag; the connector then serves nothing, even
if it is still registered in your AI client.

## Connecting your AI client

RaioPDF shows the exact snippet with the real binary path once the toggle is on.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "raiopdf": {
      "command": "<path-to>/raiopdf-mcp"
    }
  }
}
```

**Claude Code**:

```
claude mcp add raiopdf -- "<path-to>/raiopdf-mcp"
```

(A web browser client can't launch a local process — this is for the desktop
Claude app and Claude Code.)

## How it works

- The connector is a small stdio server. On the first tool call it lazily spawns
  its **own** engine host (`raiopdf-engine-host`), which starts the bundled
  Stirling engine behind an authenticated loopback proxy and hands the connector
  a per-boot token. The connector talks to that proxy exactly as the app does. It
  shuts the engine down when your AI client disconnects.
- Some tools (binder assembly, Bates numbering, page numbers, split, extract) run
  in-process on the bundled pdf-lib engine and need no engine host at all.
- The app does **not** need to be open — the connector manages its own engine.

## Security / threat model

- **Nothing leaves the machine, nothing listens on the network.** MCP is stdio;
  the engine binds loopback only.
- The authenticated proxy protects the *advertised* engine port with a per-boot
  token. As with the app, the underlying engine port is loopback and this is a
  single-user desktop trust model — another process running as the same user
  could reach loopback services. RaioPDF already trusts the local user.
- **Verified redaction.** `redact_terms` rasterizes the pages (truly removing
  recoverable text) and then verifies with an on-device text check that no
  redacted term remains extractable — it writes the output *only* if that
  verification passes. Nothing is saved on a failed verification.

## Tools

| Tool | What it does |
|------|--------------|
| `raiopdf_health` | Check the engine is reachable. |
| `pdf_page_count` | Count pages in a PDF. |
| `ocr_pdf` | Make a scanned PDF searchable (on-device OCR). |
| `merge_pdfs` | Concatenate PDFs in order. |
| `split_pdf` | Split a PDF into parts under a byte cap. |
| `extract_pages` | Keep only selected pages (original order). |
| `rotate_pages` | Rotate selected pages (multiples of 90°). |
| `compress_pdf` | Produce a smaller copy. |
| `sanitize_pdf` | Remove JavaScript, attachments, external links. |
| `scrub_metadata` | Remove document metadata. |
| `page_numbers` | Stamp page numbers. |
| `bates_stamp` / `bates_stamp_folder` | Bates numbers on one file, or one continuous sequence across an ordered set. |
| `build_exhibit_binder` | Assemble a main document + ordered, labeled exhibits into one bookmarked binder. |
| `redact_terms` | Redact terms with verified removal (see above). |
| `prepare_for_filing` | Read-only e-filing preflight: page size, orientation, searchable text, file-size caps, PDF/A — each with its rule citation. |

**File-handling rules** every tool follows: absolute paths only; inputs must be
regular files; outputs are never overwritten (a name collision is an error); each
output is written to a temp file and atomically renamed into place, and removed
if the operation fails.

## Notes

- `prepare_for_filing` is an assessment, not an auto-fixer. It reports readiness
  honestly: it will not confirm "ready" for checks it can't verify locally (e.g.
  clerk-stamp geometry, PDF/A) — those are listed as unverified for you to
  confirm.
- No AI runs *inside* RaioPDF or this connector. The intelligence is entirely
  your own client's.

## Packaging (for maintainers)

The connector ships as two executables bundled by the installer alongside the
app, resolved at runtime and shown to the user in the "Open Raio to AI" snippet:

- **`raiopdf-engine-host`** — a Rust binary (workspace member `apps/engine-host`),
  built by `cargo build` and added to the Tauri bundle via `externalBin`.
- **`raiopdf-mcp`** — the Node/TypeScript server (`apps/mcp`). It is bundled to a
  single self-contained executable via **Node's Single Executable Applications
  (SEA)**: `esbuild` bundles `src` to one entrypoint, then the SEA blob is
  injected into the `node` binary.

  One packaging detail to get right: the redaction/preflight verifier loads
  **pdf.js**, which needs its `cmaps/`, `standard_fonts/`, and `wasm/` asset
  directories at runtime. The current loader resolves them via
  `require.resolve("pdfjs-dist/...")`, which works from source / the built `dist`
  with `node_modules` present. Under SEA there is no `node_modules`, so that
  resolution won't work — so the SEA packaging step must copy those asset
  directories next to the `raiopdf-mcp` executable **and** add a loader fallback
  that resolves them relative to `process.execPath`. That loader fallback is part
  of the tracked packaging step below, not yet implemented.

The UI reads the resolved binary path via the shell's `mcp_status` command
(overridable with `RAIOPDF_MCP_BIN`). Until the installer bundles the exe, the
UI shows a placeholder and disables the Copy buttons.

> Status: the connector runs today from its built `apps/mcp/dist` with
> `node_modules` present; the single-executable installer bundling (SEA + copied
> pdf.js assets + `externalBin` wiring) is the remaining install-packaging step,
> tracked on the `pdf-suite-mcp` blueprint.
