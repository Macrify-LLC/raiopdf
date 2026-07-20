# Real-app WebDriver dialog canary (`@raiopdf/shell-e2e`)

Drives the **actual packaged RaioPDF shell binary** (WebView2 + real Tauri IPC +
real Rust command bodies) through its dialog-heavy workflows. This is the tier
the Playwright-against-Vite smoke/canary suites can't reach: those run mocked
code paths in plain Chromium and never launch the real binary.

Only the native OS pickers are swapped out — for canned absolute paths — via the
Rust `e2e_dialog` stub compiled under the `e2e-webdriver` Cargo feature. The
feature is off by default and never enabled in a release build.

## How it works

- **WebdriverIO + `@wdio/tauri-service`** drives the built exe. On Windows the
  service manages `tauri-driver` and keeps **`msedgedriver` matched to the
  WebView2 runtime embedded in the binary** (not the machine's Edge browser
  version — a mismatch there is the classic "DevToolsActivePort" session
  failure). No in-app plugin is needed on Windows.
- The specs click the real "Open" / "Save As" / "Add exhibits" / etc. controls,
  which invoke the real Tauri commands. The `e2e_dialog` stub returns canned
  paths from a JSON control file instead of showing the native picker.
- The stub re-reads its control file on every picker call, so each spec rewrites
  the file for its flow. Each spec file is its own session — a fresh app launch —
  so the flows never share state.
- The raw `target/release` exe resolves its bundled tools (qpdf, Ghostscript) via
  `RAIOPDF_ENGINE_PAYLOAD_DIR`, so no installer step is required.

## Scope

Covered here (per-PR gate, engine-less): **Open**, **Save As**,
**Prepare for Filing** (multi-part → folder), **Combine with Exhibits**,
**Unlock PDF**. OCR (Make Searchable) and Apply Redactions boot the JVM engine
and belong in the slower release/canary tier, not this gate.

The stub only covers **user-gesture** pickers
(`open_pdf_dialog`, `save_pdf_dialog`, `pick_output_directory`,
`pick_pdfs_for_add`). It does **not** cover startup-path invokes
(`take_startup_pdf`, eager engine start) — there is no pre-load injection hook.

## Running locally (Windows)

```bash
# 1. Build the app WITH the test feature (produces target/release/raiopdf-shell.exe)
pnpm build:shell:e2e:windows-x64

# 2. Install tauri-driver (once; the service consumes it from PATH)
cargo install tauri-driver --locked

# 3. Run the suite (@wdio/tauri-service auto-downloads the WebView2-matched
#    msedgedriver and manages tauri-driver)
pnpm --filter @raiopdf/shell-e2e test:e2e:windows-x64
```

Overridable env: `RAIO_E2E_APP` (exe path), `RAIO_E2E_PAYLOAD_DIR`, `RAIO_E2E_TMP`.

CI runs this as an **informational** (non-blocking) tier of `canary.yml`.
