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
  verification passes. Nothing is saved on a failed verification. The check is
  garble-aware: text that survives only as corrupted or unmappable glyphs is
  treated as *still present*, biasing the verifier toward failing a clean-looking
  redaction rather than ever passing a leaked one.

## Tools

**20 tools as of 2026-07-03** (the Bates row below covers two). This table is
the canonical list — the README, the landing page, and the macrify.me product
card all quote the count from here; update them when it changes.

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
| `remove_encryption` | Save a decrypted copy of a password- or owner-restricted PDF (you supply the password when one is required). |
| `sanitize_pdf` | Remove JavaScript, attachments, external links. |
| `scrub_metadata` | Remove document metadata. |
| `page_numbers` | Stamp page numbers. |
| `bates_stamp` / `bates_stamp_folder` | Bates numbers on one file, or one continuous sequence across an ordered set. |
| `build_exhibit_binder` | Assemble a main document + ordered, labeled exhibits into one bookmarked binder. |
| `build_production_set` | Build a Bates-numbered discovery production from a document set: confidentiality designations, index files, volume splits. |
| `batch_cleanup` | Run OCR, compression, sanitizing, metadata scrubbing, and filing splits across many PDFs in one queue. |
| `redact_terms` | Redact terms with verified removal (see above). |
| `prepare_for_filing` | Read-only e-filing preflight: page size, orientation, searchable text, file-size caps, PDF/A — each with its rule citation. |
| `build_filing_packet` | Assemble a multi-document filing as one packet with a manifest and per-document rule checks. |

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
- **`raiopdf-mcp`** — a small Rust launcher (workspace member
  `apps/mcp-launcher`) added to the Tauri bundle via `externalBin`. The launcher
  starts the bundled Node runtime and the bundled `apps/mcp` entrypoint from the
  installer payload.

  This intentionally uses **bundled Node** instead of Node SEA. SEA would require
  proving the full ESM dependency graph and pdf.js asset loading inside a blob;
  the launcher/runtime split keeps the installed connector inspectable and keeps
  pdf.js assets as ordinary files. `installer/assemble-payload.sh` pins and
  copies `node.exe`, `installer/build-mcp-runtime.mjs` bundles the MCP JS
  entrypoint with `esbuild`, and the MCP pdf.js loader resolves `cmaps/`,
  `standard_fonts/`, and `wasm/` from the installed payload before falling back
  to source `node_modules`.

The UI reads the resolved binary path via the shell's `mcp_status` command
(overridable with `RAIOPDF_MCP_BIN`). In an installed build this resolves the
bundled `raiopdf-mcp.exe`, so the copy buttons show an AI-client-ready command
without requiring a development checkout.
