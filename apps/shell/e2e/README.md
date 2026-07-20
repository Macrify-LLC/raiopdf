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

Overridable env: `RAIO_E2E_APP` (exe path), `RAIO_E2E_PAYLOAD_DIR`, `RAIO_E2E_TMP`,
and — for machines whose username contains a space, which the service's
tauri-driver spawn mishandles — `RAIO_E2E_TAURI_DRIVER` / `RAIO_E2E_MSEDGEDRIVER`
pointed at copies of those binaries under a space-free path.

## CI: self-hosted Windows runner (required)

This tier runs in `canary.yml` as an **informational** (non-blocking) job, but
**only on a self-hosted Windows runner** — never a GitHub-hosted one.

Why: GitHub-hosted Windows runners launch the app in an account/session where
WebView2 refuses to open its remote-debugging port, so session creation fails
with `DevToolsActivePort file doesn't exist`. The exact same build drives WebView2
fine on a normal interactive Windows desktop.

Runner requirements:

1. **Windows, x64.** WebView2 is Windows-only.
2. **Accessible to this repo.** Register the runner at the **org level**
   (`Macrify-LLC`, shared across repos) or directly to `Macrify-LLC/raiopdf`.
   A runner scoped to a *different* repo will not pick up these jobs.
3. **Interactive desktop session — NOT a service.** WebView2 automation needs a
   real desktop; a runner installed as a Windows service (session 0) can't drive
   the GUI. Run the runner from a logged-in desktop session
   (`run.cmd`), or configure it for autologon + interactive run.
4. **Custom label `webview2`.** The job targets
   `runs-on: [self-hosted, windows, webview2]`. Add `webview2` when configuring
   the runner so only the designated (interactive) machine is chosen. Edge +
   WebView2 runtime must be present (they are on any Windows dev machine).

The workflow installs Node/Rust/JDK and builds the payload + shell itself, so a
bare Windows runner works; pre-installed toolchains just make it faster.

Triggering: **explicit opt-in only** — `workflow_dispatch` on `canary.yml`, or add
the **`run-webdriver`** label to a PR. It is not on every push/nightly because the
run pops real app windows on the runner's desktop. If the runner's username has a
space, set the `RAIO_E2E_TAURI_DRIVER` / `RAIO_E2E_MSEDGEDRIVER` repo variables (or
`env`) to space-free driver copies (see above).
