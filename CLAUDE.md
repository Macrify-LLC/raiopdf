# RaioPDF — Repo Guide

RaioPDF is a free, GPL-3.0, fully local desktop PDF suite for law firms: a Tauri shell
(`apps/shell/src-tauri`) + React UI, a bundled MIT-core Stirling-PDF engine running as a
localhost sidecar, and a bundled Tesseract/Ghostscript/OCRmyPDF toolchain for fully
offline OCR. It replaces day-to-day Acrobat use (view, organize, OCR, annotate, forms,
sign) and adds legal workflows: e-filing prep with rule-cited preflight, exhibit binders,
filing packets, production sets, verified redaction, Bates numbering, sensitive-info
scanning, metadata scrubbing. No cloud, no account, no telemetry, no AI in the product —
the only automatic network access is the signed update check against GitHub Releases.
Runs on Windows and macOS (Apple Silicon; Intel later).

**Status (2026-07-12):** public alpha, version 0.1.3. Signed Windows installers are
published and downloadable on [GitHub Releases](https://github.com/Macrify-LLC/raiopdf/releases)
(0.1.0 shipped 2026-07-06, 0.1.1 on 2026-07-07, 0.1.2 on 2026-07-08); the landing page at raio.macrify.me tracks
the latest complete signed release. It's still an alpha — don't call it feature-complete,
"1.0," or production-stable. Per-release notes live in `CHANGELOG.md`.

## Monorepo map

pnpm workspace (Node ≥24, pnpm 10.33.2 via corepack) + Cargo workspace.

| Path | What lives there |
|---|---|
| `apps/ui` | React web UI (Vite). All document ops go through the `PdfEngine` seam — never straight to the sidecar. |
| `apps/shell` | Tauri desktop shell (`src-tauri`): windows, file access, engine launch/supervision, `path_ops.rs` (PathOpsEngine). |
| `apps/engine-host` | Standalone Rust host that boots the bundled Stirling engine for the MCP connector when the app isn't running. |
| `apps/mcp` | `@raiopdf/mcp` — the stdio MCP connector (Node). Off by default; see `docs/MCP.md`. |
| `apps/mcp-launcher` | Small Rust launcher binary that locates the bundled MCP runtime/resources and execs it. |
| `crates/engine-sidecar-core` | Shared Rust launch/supervise/authenticated-loopback-proxy logic, used by both the shell and engine-host. |
| `packages/engine-api` | The `PdfEngine` interface + shared types (handles, PDF/A options, outline types). The seam everything depends on. |
| `packages/engine-local` | In-process `PdfEngine` on pdf-lib: merge/split/stamps/binders, appearance-stream annotation layer. |
| `packages/engine-sidecar` | HTTP-client `PdfEngine` for the bundled Stirling sidecar (opaque handles, bytes stay client-side). |
| `packages/engine-pdf-lib` | Lower-level pdf-lib helpers: outline read/write, PDF/A identification, metadata scrubbing. |
| `packages/rules` | Jurisdiction e-filing rule packs (FL portal, Federal CM/ECF, GA eFileGA/PeachCourt, IN IEFS), document facts, garble scoring. |
| `packages/filing-packet` | Multi-document filing packet assembly with manifest + per-document rule checks. |
| `packages/production-set` | Bates-numbered discovery productions: designations, index files, volume splits. |
| `packages/batch-cleanup` | Batch queue: OCR/compress/sanitize/scrub/filing-split across many PDFs. |
| `packages/package-writer` | Shared packaged-output writer (sessions, manifests, hashing). |
| `packages/help-content` | Authored in-app help articles; built to `dist/` and published at raio.macrify.me/help. |
| `engine/` | Stirling-PDF vendoring/build scripts + pins (`PINNED_TAG`, `PINNED_COMMIT`, `settings-gradle.patch`). |
| `installer/` | Payload assembly (JRE + Stirling + OCR toolchain), external-bin prep, artwork, license notices. |
| `site/` | Landing page at raio.macrify.me. Copy source of truth: `site/shared/COPY.md`. |
| `docs/` | `ARCHITECTURE.md`, `MCP.md`, `SIGNING.md`, `ENGINE-VENDORING.md`, `RELEASE-CANARY.md`, `plans/`, `decisions/`. |

## Architecture essentials

Read `docs/ARCHITECTURE.md` first. The short version:

- **One seam.** The UI depends on the `PdfEngine` interface in `packages/engine-api`,
  never on a specific engine. `engine-local` (pdf-lib, in-process) and `engine-sidecar`
  (bundled Stirling over HTTP) both implement it. The UI must never call the Stirling
  sidecar directly.
- **Loopback only.** The shell launches Stirling on demand behind an authenticated
  loopback proxy — the UI's engine bridge gets a port + per-boot token from the shell.
  The Tauri CSP enforces it: `connect-src 'self' http://127.0.0.1:*`. Nothing binds
  beyond loopback; nothing talks to the internet except the signed update check.
- **PathOpsEngine** (`apps/shell/src-tauri/src/path_ops.rs`): file-to-file operations
  that shell out directly to the bundled qpdf / Ghostscript / OCRmyPDF binaries —
  decrypt, extract, OCR, sanitize, normalize-to-letter-portrait, PDF/A conversion —
  without materializing the document in memory or paying loopback HTTP.
- **Streamed viewer.** `apps/ui/src/hooks/useDocument.ts` models a `DocumentSource` as
  `memory | rangeGrant | rangeFile` with a generation counter for staleness. Large
  documents open streamed (range reads, never fully in memory); in-app mutation is gated
  but split/extract/compress/OCR still run file-to-file through path ops.
- **OCR toolchain** ships in the installer payload (`installer/`, assembled by
  `prepare:shell-bundle`) alongside the JRE and Stirling engine.
- **MCP** (`docs/MCP.md`): off-by-default stdio connector, gated by an enable flag the
  app writes to the user config dir. On first tool call it spawns its own
  `raiopdf-engine-host`, so the app doesn't need to be running. The tool count and
  canonical tool table live in `docs/MCP.md` — the README and landing page quote the
  count from there. **Only edit the count in `docs/MCP.md` and sync the quoting copies
  in the same PR** (this has drifted before — see PR #134).

## Dev workflow

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm dev          # web UI only
pnpm dev:shell    # full Tauri shell (needs Rust stable + platform deps in ci.yml)
```

Before a PR, run what CI runs: `pnpm -r typecheck && pnpm -r build && pnpm -r test &&
pnpm -r lint`, plus `cargo fmt --all --check`, `cargo clippy --workspace --all-targets
-- -D warnings`, `cargo test --workspace`. A pre-push hook runs the UI typecheck +
Playwright smoke suite (`--no-verify` in emergencies).

- **Trunk = `main`. PRs target `main`** and merge as a single squashed commit. Required
  checks: the `Web` + `Shell` CI jobs.
- **Canary:** if a PR touches `apps/ui`, the engine sidecar/host, or the payload, run
  `pnpm prepare:shell-bundle` (once) then `pnpm canary` and paste the summary line into
  the PR. It drives the real packaged engine, not mocks — see `docs/RELEASE-CANARY.md`
  and CONTRIBUTING.md. Docs-only / site-only / tooling-only PRs skip it.
- Release-asset tooling lives in `scripts/` (`prepare:release-assets`,
  `validate:release-assets`, `test:release-assets`).

## Hard constraints

1. **Licensing.** The repo is GPL-3.0; the vendored Stirling-PDF engine is consumed from
   its MIT-licensed core only. Never copy, vendor, adapt, or link code from Stirling's
   `app/proprietary`, `app/saas`, `engine/`, `frontend/editor/src/desktop`, or any other
   carved-out area — if a path isn't clearly MIT, treat it as unavailable.
2. **Don't hand-edit the vendored engine.** Vendoring is scripted: `engine/vendor.sh`
   clones the pinned tag/commit, scrubs non-MIT dirs, and applies
   `settings-gradle.patch`; builds use `STIRLING_FLAVOR=core`. Changes go into the
   scripts/patch/pins (`engine/PINNED_*`), never into a checked-out engine tree. Read
   `docs/ENGINE-VENDORING.md` before touching any of it (it documents real footguns).
3. **No telemetry, no cloud services, no accounts, no AI features — ever.** These are
   the product's identity, not gaps. Document operations must never touch the network;
   the sole automatic network call is the signed update check. Crash reporting is
   opt-in, user-reviewed (see `docs/decisions/0002-crash-reporting.md`).
4. **Loopback only.** Anything that adds a listener or widens the CSP beyond
   `127.0.0.1` is wrong by default.
5. **Signing is maintainer-local.** CI builds unsigned installers as artifacts only;
   signed releases are built locally with the Certum/SimplySign pipeline
   (`docs/SIGNING.md`). Never move signing credentials into CI.
6. **This is a public repo — internal work-process knowledge never gets committed.**
   No internal playbooks, business strategy, client or prospect information, private
   infrastructure details, credentials, or references to private repos, drives, or
   internal tooling — in code, docs, comments, commit messages, or PR bodies. Repo
   content is limited to what RaioPDF itself needs. If guidance lives in an internal
   doc, keep it there; don't mirror or link it here.

## Copy & naming

Landing/marketing copy derives from `site/shared/COPY.md` (source of truth — "do not
add claims not listed here"). The README's "philosophy" section is the canonical voice
sample: first-person, plainspoken, never corporate press-release tone. Landing-page
body copy always says "RaioPDF", never bare "Raio".

## Keep the docs honest

The README feature list has lagged merged PRs before — bookmark outline editing (#138),
save-all-to-folder for multi-part filing outputs (#146), OCR progress (#140/#141), and
the advisory prep checklist (#145) all shipped without README updates. If you ship a
user-facing feature, update the README feature tables, the relevant `docs/` page, and
`packages/help-content` article in the **same PR** — the product's promise is that the
advertised feature set is exactly what the packaged app does.
