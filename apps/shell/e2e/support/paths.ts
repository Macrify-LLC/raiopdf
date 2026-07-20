/**
 * Filesystem anchors shared by the WebDriver harness (wdio.conf) and the specs.
 *
 * The suite drives the REAL packaged shell binary built with the `e2e-webdriver`
 * Cargo feature. Two runtime seams make that deterministic:
 *
 *  - `RAIOPDF_ENGINE_PAYLOAD_DIR` points the shell's path-op toolchain (qpdf,
 *    Ghostscript) at the assembled payload, so the raw `target/release` exe
 *    resolves its bundled binaries without an installer step. Both the engine
 *    config and `PathOpsToolchain::discover` honor this override.
 *  - `RAIO_E2E_DIALOG_CONTROL` names the JSON control file the native-dialog
 *    stub reads. The stub re-reads the file on every picker call, so a single
 *    stable path (set once, before the app launches) plus a per-flow rewrite of
 *    the file is enough to steer each dialog — no per-test app restart needed.
 *
 * Every path is overridable by env so CI (or a contributor with a different
 * layout) can redirect without editing code.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: apps/shell/e2e/support -> up four. */
export const repoRoot = path.resolve(here, "..", "..", "..", "..");

/** The default target platform. Windows is the only WebDriver tier today. */
export const platform = "windows-x64";

/** The packaged shell binary to drive. Built with `--features e2e-webdriver`. */
export const appPath =
  process.env.RAIO_E2E_APP ??
  path.join(repoRoot, "target", "release", "raiopdf-shell.exe");

/** The assembled payload dir (qpdf/Ghostscript live here) — pointed at via env. */
export const payloadDir =
  process.env.RAIO_E2E_PAYLOAD_DIR ??
  path.join(repoRoot, "apps", "shell", "src-tauri", "payload", platform);

/** qpdf inside the payload — used to mint the encrypted Unlock fixture. */
export const payloadQpdf = path.join(payloadDir, "ocr", "qpdf", "bin", "qpdf.exe");

/** Scratch root for the control file, generated fixtures, and dialog outputs. */
export const tmpRoot =
  process.env.RAIO_E2E_TMP ?? path.join(os.tmpdir(), "raio-e2e");

/** The single, stable dialog-control file (rewritten per flow). */
export const controlFile = path.join(tmpRoot, "dialog-control.json");

/** Where generated fixture PDFs are written. */
export const fixturesDir = path.join(tmpRoot, "fixtures");

/** Where stubbed Save / Prepare-for-Filing outputs are written and asserted. */
export const outputsDir = path.join(tmpRoot, "outputs");
