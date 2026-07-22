//! Test-only native-dialog overrides for the real-app WebDriver canary.
//!
//! Compiled ONLY under the `e2e-webdriver` Cargo feature — never in a release
//! build (no release path passes `--features`, and the feature is not a default;
//! see `Cargo.toml` `[features]`). When the env var `RAIO_E2E_DIALOG_CONTROL`
//! points at a JSON control file, the file-dialog commands read their canned
//! response here and skip the native OS picker, so the packaged binary can be
//! driven deterministically while the real command bodies (grant creation, file
//! writes, validation) still execute.
//!
//! Control file shape (all paths absolute):
//! ```json
//! {
//!   "open_pdf_dialog": "/abs/fixture.pdf",
//!   "save_pdf_dialog": "/abs/out.pdf",
//!   "pick_output_directory": "/abs/outdir",
//!   "pick_pdfs_for_add": ["/abs/a.pdf", "/abs/b.pdf"]
//! }
//! ```
//! A missing env var, unreadable file, or absent key yields `None`, so the real
//! native picker runs — the override is strictly opt-in per command.

use std::path::PathBuf;

use tauri_plugin_dialog::FilePath;

fn control() -> Option<serde_json::Value> {
    let path = std::env::var_os("RAIO_E2E_DIALOG_CONTROL")?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Canned single-path response for `slot`, or `None` to fall back to the picker.
pub fn path_for(slot: &str) -> Option<FilePath> {
    let value = control()?;
    let path = value.get(slot)?.as_str()?;
    Some(FilePath::from(PathBuf::from(path)))
}

/// Canned multi-path response for `slot`, or `None` to fall back to the picker.
pub fn paths_for(slot: &str) -> Option<Vec<FilePath>> {
    let value = control()?;
    let entries = value.get(slot)?.as_array()?;
    let paths: Vec<FilePath> = entries
        .iter()
        .filter_map(|entry| entry.as_str())
        .map(|path| FilePath::from(PathBuf::from(path)))
        .collect();
    (!paths.is_empty()).then_some(paths)
}
