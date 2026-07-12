mod diagnostics;
mod instance;
mod mcp;
mod path_ops;
mod print;
mod range_read;
mod sidecar;
mod word;

use diagnostics::AppDiagnostics;
use engine_sidecar_core::{docx_scan, word_ops as core_word};
use range_read::{
    large_doc_threshold_bytes, range_call_cap_bytes, read_file_range, snapshot_file, FileSnapshot,
    RangeReadError,
};
use serde::Serialize;
use std::{
    borrow::Cow,
    collections::HashMap,
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{self, Command},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuBuilder, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const MENU_EVENT: &str = "raiopdf-menu";
const MENU_EXIT: &str = "file:exit";
const HEADER_FILE_GRANT: &str = "x-raio-file-grant";
const HEADER_DIRECTORY_GRANT: &str = "x-raio-directory-grant";
const HEADER_SUGGESTED_NAME: &str = "x-raio-suggested-name";
const HEADER_FILE_NAME: &str = "x-raio-file-name";
const HEADER_DROPPED_PDF_SIZE: &str = "x-raio-dropped-pdf-size";
const HEADER_DROPPED_PDF_TOKEN: &str = "x-raio-dropped-pdf-token";
const MAX_DROPPED_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IN_FLIGHT_DROPPED_UPLOADS: usize = 4;

#[derive(Default)]
struct PendingPdfBytes {
    next_token: AtomicU64,
    bytes: Mutex<HashMap<String, Vec<u8>>>,
}

struct UploadState {
    temp_dir: PathBuf,
    file_path: PathBuf,
    file: fs::File,
    bytes_written: u64,
    expected_total: u64,
    sanitized_name: String,
}

#[derive(Default)]
struct DroppedUploads {
    uploads: Mutex<HashMap<String, UploadState>>,
}

/// Grant-time state for one shell-issued file grant. The snapshot is the
/// drift baseline for ranged reads: `read_pdf_range` refuses to serve bytes
/// from a file whose `{len, mtime}` no longer match [R1-5].
#[derive(Clone)]
struct FileGrantEntry {
    path: PathBuf,
    snapshot: Option<FileSnapshot>,
}

#[derive(Default)]
struct FileGrants {
    paths: Mutex<HashMap<String, FileGrantEntry>>,
}

#[derive(Default)]
struct DirectoryGrants {
    paths: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Default)]
struct StartupPdf {
    pending: Mutex<Option<OpenedPdf>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedPdf {
    name: String,
    file_grant: String,
    size_bytes: u64,
    /// Present only below the large-doc threshold; large files are never
    /// materialized (`fs::read`) — the UI streams them via `read_pdf_range`.
    bytes_token: Option<String>,
    /// The shell-owned threshold, echoed so UI and shell agree on the branch.
    threshold_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPdf {
    name: String,
    file_grant: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDocx {
    name: String,
    file_grant: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedDirectory {
    grant: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedPdf {
    grant: String,
    name: String,
    size_bytes: u64,
    source: PickedAddSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    markup_scan: Option<docx_scan::MarkupScan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    converted_from_grant: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedPdfs {
    files: Vec<PickedPdf>,
    threshold_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedPdfForWord {
    grant: String,
    name: String,
    size_bytes: u64,
}

/// A single `.docx` the user picked to import (convert to PDF and open). Carries
/// the tracked-changes scan so the UI can gate final-vs-show-markup before the
/// conversion, mirroring the docx add-into-existing-PDF flow.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedDocxForImport {
    grant: String,
    name: String,
    size_bytes: u64,
    markup_scan: docx_scan::MarkupScan,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PickedAddSource {
    Pdf,
    Docx,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocxAddInput {
    grant: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxAddBatchResult {
    files: Vec<PickedPdf>,
    errors: Vec<DocxAddError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxAddError {
    grant: String,
    name: String,
    code: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxConvertProgressPayload {
    index: usize,
    total: usize,
    file: String,
    phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxConvertDonePayload {
    index: usize,
    total: usize,
    file: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const DOCX_CONVERT_PROGRESS_EVENT: &str = "docx-convert:progress";
const DOCX_CONVERT_FILE_DONE_EVENT: &str = "docx-convert:file-done";

impl PendingPdfBytes {
    fn insert(&self, bytes: Vec<u8>) -> Result<String, String> {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed).to_string();
        let mut pending = self.bytes.lock().map_err(|_| {
            "RaioPDF hit an internal error opening that file. Reopen it and try again."
        })?;
        pending.insert(token.clone(), bytes);
        Ok(token)
    }

    fn remove(&self, token: &str) -> Result<Vec<u8>, String> {
        let mut pending = self.bytes.lock().map_err(|_| {
            "RaioPDF hit an internal error opening that file. Reopen it and try again."
        })?;
        pending.remove(token).ok_or_else(|| {
            "RaioPDF couldn't process this PDF. It may be corrupt or unsupported.".to_string()
        })
    }
}

impl DroppedUploads {
    fn begin_upload(
        &self,
        path_ops_root: &Path,
        expected_total: u64,
        file_name: &str,
    ) -> Result<String, String> {
        if expected_total > MAX_DROPPED_UPLOAD_BYTES {
            return Err("Dropped PDF is too large to prepare for filing".to_string());
        }

        let root = canonical_path_ops_root(path_ops_root)?;
        let sanitized_name = sanitize_pdf_file_name(file_name);
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Dropped PDF upload lock poisoned".to_string())?;

        if uploads.len() >= MAX_IN_FLIGHT_DROPPED_UPLOADS {
            return Err("Too many dropped PDF uploads are already in progress".to_string());
        }

        for _ in 0..16 {
            let token = Uuid::new_v4().to_string();
            if uploads.contains_key(&token) {
                continue;
            }

            let temp_dir = root.join(&token);
            match fs::create_dir(&temp_dir) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("Failed to create dropped PDF temp folder: {error}"));
                }
            }
            // Upload staging shares the path-ops root — mark ownership so a
            // concurrently-starting instance's sweep leaves it alone.
            path_ops::mark_dir_owned_by_current_instance(&temp_dir);

            match create_upload_state(&root, temp_dir, sanitized_name.clone(), expected_total) {
                Ok(state) => {
                    uploads.insert(token.clone(), state);
                    return Ok(token);
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(root.join(&token));
                    return Err(error);
                }
            }
        }

        Err("RaioPDF couldn't prepare that PDF. Try again.".to_string())
    }

    fn append_upload(&self, token: &str, bytes: &[u8]) -> Result<(), String> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Dropped PDF upload lock poisoned".to_string())?;
        let upload = uploads
            .get_mut(token)
            .ok_or_else(|| "Dropped PDF upload token not found".to_string())?;
        let chunk_len = u64::try_from(bytes.len())
            .map_err(|_| "Dropped PDF upload chunk is too large".to_string())?;
        let next_len = upload
            .bytes_written
            .checked_add(chunk_len)
            .ok_or_else(|| "Dropped PDF upload size overflow".to_string())?;

        if next_len > upload.expected_total {
            return Err("RaioPDF couldn't prepare that PDF. Try again.".to_string());
        }

        upload.file.write_all(bytes).map_err(|error| {
            format!(
                "Failed to write dropped PDF at {}: {error}",
                upload.file_path.to_string_lossy()
            )
        })?;
        upload.bytes_written = next_len;
        Ok(())
    }

    fn finish_upload(
        &self,
        token: &str,
        path_ops_root: &Path,
        file_grants: &FileGrants,
    ) -> Result<OpenedPdf, String> {
        let root = canonical_path_ops_root(path_ops_root)?;
        // Take the entry out of the map up front: whether this finish succeeds
        // or fails, the slot must be released. A failed finish used to leave
        // the entry behind, permanently pinning one of the
        // MAX_IN_FLIGHT_DROPPED_UPLOADS slots (plus its temp file) until the
        // app restarted.
        let mut upload = {
            let mut uploads = self
                .uploads
                .lock()
                .map_err(|_| "Dropped PDF upload lock poisoned".to_string())?;
            uploads
                .remove(token)
                .ok_or_else(|| "Dropped PDF upload token not found".to_string())?
        };

        let finished = (|| {
            if upload.bytes_written != upload.expected_total {
                return Err("Dropped PDF upload is incomplete".to_string());
            }

            upload.file.flush().map_err(|error| {
                format!(
                    "Failed to flush dropped PDF at {}: {error}",
                    upload.file_path.to_string_lossy()
                )
            })?;
            upload.file.sync_all().map_err(|error| {
                format!(
                    "Failed to sync dropped PDF at {}: {error}",
                    upload.file_path.to_string_lossy()
                )
            })
        })();

        let UploadState {
            temp_dir,
            file_path,
            file,
            sanitized_name,
            ..
        } = upload;
        drop(file);

        let result = finished.and_then(|()| {
            opened_pdf_for_temp_upload(&file_path, &root, &sanitized_name, file_grants)
        });
        if result.is_err() {
            // A failed finish releases its staging dir exactly like an abort.
            let _ = fs::remove_dir_all(&temp_dir);
        }
        result
    }

    fn abort_upload(&self, token: &str) -> Result<(), String> {
        let upload = {
            let mut uploads = self
                .uploads
                .lock()
                .map_err(|_| "Dropped PDF upload lock poisoned".to_string())?;
            uploads
                .remove(token)
                .ok_or_else(|| "Dropped PDF upload token not found".to_string())?
        };

        let UploadState { temp_dir, file, .. } = upload;
        drop(file);
        fs::remove_dir_all(&temp_dir).map_err(|error| {
            format!(
                "Failed to delete dropped PDF temp folder at {}: {error}",
                temp_dir.to_string_lossy()
            )
        })
    }

    #[cfg(test)]
    fn upload_temp_dir(&self, token: &str) -> Option<PathBuf> {
        self.uploads
            .lock()
            .ok()
            .and_then(|uploads| uploads.get(token).map(|upload| upload.temp_dir.clone()))
    }
}

impl FileGrants {
    /// Issue a grant, snapshotting `{len, mtime}` best-effort so ranged reads
    /// have a drift baseline. Grants whose file could not be stat'ed still
    /// resolve to a path (save flows need that) but refuse ranged reads.
    fn grant(&self, path: PathBuf) -> Result<String, String> {
        let snapshot = snapshot_file(&path).ok();
        self.grant_with_snapshot(path, snapshot)
    }

    /// Issue a grant with a caller-supplied drift baseline. The open path uses
    /// this to mint the grant from the snapshot it already verified the read
    /// bytes against, so a file replaced between that verification and grant
    /// issuance can't leave the WebView holding old bytes while the grant
    /// baseline describes the replacement.
    fn grant_with_snapshot(
        &self,
        path: PathBuf,
        snapshot: Option<FileSnapshot>,
    ) -> Result<String, String> {
        let grant = Uuid::new_v4().to_string();
        let mut paths = self.paths.lock().map_err(|_| "File grant lock poisoned")?;
        paths.insert(grant.clone(), FileGrantEntry { path, snapshot });
        Ok(grant)
    }

    fn resolve(&self, grant: &str) -> Result<PathBuf, String> {
        Ok(self.resolve_entry(grant)?.path)
    }

    fn resolve_entry(&self, grant: &str) -> Result<FileGrantEntry, String> {
        let paths = self.paths.lock().map_err(|_| "File grant lock poisoned")?;
        paths
            .get(grant)
            .cloned()
            .ok_or_else(|| "File grant not found".to_string())
    }

    /// Drop a grant (used when a path-op temp output is released). Best-effort:
    /// a poisoned lock just leaves the entry behind for the startup sweep.
    fn remove(&self, grant: &str) {
        if let Ok(mut paths) = self.paths.lock() {
            paths.remove(grant);
        }
    }
}

impl DirectoryGrants {
    fn grant(&self, path: PathBuf) -> Result<String, String> {
        let grant = Uuid::new_v4().to_string();
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| "Directory grant lock poisoned")?;
        paths.insert(grant.clone(), path);
        Ok(grant)
    }

    fn resolve(&self, grant: &str) -> Result<PathBuf, String> {
        let paths = self
            .paths
            .lock()
            .map_err(|_| "Directory grant lock poisoned")?;
        paths
            .get(grant)
            .cloned()
            .ok_or_else(|| "Directory grant not found".to_string())
    }
}

impl StartupPdf {
    fn set(&self, pdf: OpenedPdf) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Startup PDF lock poisoned".to_string())?;
        *pending = Some(pdf);
        Ok(())
    }

    fn take(&self) -> Result<Option<OpenedPdf>, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Startup PDF lock poisoned".to_string())?;
        Ok(pending.take())
    }
}

fn opened_pdf_for_path(
    path: PathBuf,
    pending_pdf_bytes: &PendingPdfBytes,
    file_grants: &FileGrants,
) -> Result<OpenedPdf, String> {
    require_pdf_extension(&path)?;

    // Stat first: the branch between "materialize bytes" and "stream by
    // range" is decided before any read, so a 283 MB filing never touches
    // the heap on open.
    let threshold_bytes = large_doc_threshold_bytes();
    let size_bytes = fs::metadata(&path)
        .map_err(|_| READ_PDF_ERROR.to_string())?
        .len();

    // Snapshot BEFORE any read so the grant is minted from exactly this baseline
    // (below threshold: the bytes handed to the WebView; above: the file streamed
    // by range). The file-based engine route (path_ops) trusts that a clean
    // memory document's in-WebView bytes and its on-disk grant file match; an
    // external replace during open would otherwise desync them and let an op
    // process content the user never saw.
    let snapshot_before = snapshot_file(&path).ok();
    let bytes_token = if size_bytes < threshold_bytes {
        let bytes = fs::read(&path).map_err(|_| READ_PDF_ERROR.to_string())?;
        if let Some(before) = snapshot_before {
            let after = snapshot_file(&path).map_err(|_| READ_PDF_ERROR.to_string())?;
            if after != before {
                return Err("This file changed while it was being opened — reopen it.".to_string());
            }
        }
        Some(pending_pdf_bytes.insert(bytes)?)
    } else {
        None
    };
    // Mint the grant from the pre-read snapshot rather than letting `grant` take
    // a fresh one after the read — a replace between the verify above and grant
    // issuance can't desync the WebView bytes from the grant baseline.
    let file_grant = file_grants.grant_with_snapshot(path.clone(), snapshot_before)?;

    Ok(OpenedPdf {
        name: file_name(&path),
        file_grant,
        size_bytes,
        bytes_token,
        threshold_bytes,
    })
}

fn path_ops_root_for_app(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir unavailable: {error}"))?
        .join(path_ops::PATH_OPS_DIR))
}

fn canonical_path_ops_root(path_ops_root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path_ops_root)
        .map_err(|error| format!("Failed to create path-ops temp root: {error}"))?;
    fs::canonicalize(path_ops_root)
        .map_err(|error| format!("Failed to resolve path-ops temp root: {error}"))
}

fn create_upload_state(
    root: &Path,
    temp_dir: PathBuf,
    sanitized_name: String,
    expected_total: u64,
) -> Result<UploadState, String> {
    let temp_dir = fs::canonicalize(&temp_dir)
        .map_err(|error| format!("Failed to resolve dropped PDF temp folder: {error}"))?;
    if temp_dir.parent() != Some(root) {
        return Err("Dropped PDF temp folder resolved outside the temp root".to_string());
    }

    let file_path = temp_dir.join(&sanitized_name);
    require_pdf_extension(&file_path)?;
    let file = fs::OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(&file_path)
        .map_err(|error| {
            format!(
                "Failed to create dropped PDF temp file at {}: {error}",
                file_path.to_string_lossy()
            )
        })?;
    let file_path = fs::canonicalize(&file_path)
        .map_err(|error| format!("Failed to resolve dropped PDF temp file: {error}"))?;
    if file_path.parent() != Some(temp_dir.as_path()) {
        return Err("Dropped PDF temp file resolved outside its upload folder".to_string());
    }

    Ok(UploadState {
        temp_dir,
        file_path,
        file,
        bytes_written: 0,
        expected_total,
        sanitized_name,
    })
}

fn opened_pdf_for_temp_upload(
    path: &Path,
    root: &Path,
    sanitized_name: &str,
    file_grants: &FileGrants,
) -> Result<OpenedPdf, String> {
    let path = fs::canonicalize(path).map_err(|error| {
        format!(
            "Failed to resolve dropped PDF temp file at {}: {error}",
            path.to_string_lossy()
        )
    })?;
    require_pdf_extension(&path)?;
    if path.parent().and_then(Path::parent) != Some(root) {
        return Err("Dropped PDF temp file resolved outside the temp root".to_string());
    }

    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "Failed to stat dropped PDF temp file at {}: {error}",
            path.to_string_lossy()
        )
    })?;
    if !metadata.is_file() {
        return Err("Dropped PDF temp path is not a file".to_string());
    }

    let snapshot = snapshot_file(&path).map_err(|error| {
        format!(
            "Failed to snapshot dropped PDF temp file at {}: {error}",
            path.to_string_lossy()
        )
    })?;
    let file_grant = file_grants.grant_with_snapshot(path, Some(snapshot))?;

    Ok(OpenedPdf {
        name: sanitized_name.to_string(),
        file_grant,
        size_bytes: metadata.len(),
        bytes_token: None,
        threshold_bytes: large_doc_threshold_bytes(),
    })
}

#[tauri::command]
fn open_pdf_dialog(
    app: tauri::AppHandle,
    pending_pdf_bytes: tauri::State<'_, PendingPdfBytes>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<OpenedPdf>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    Ok(Some(opened_pdf_for_path(
        path,
        pending_pdf_bytes.inner(),
        file_grants.inner(),
    )?))
}

#[tauri::command]
fn take_startup_pdf(
    startup_pdf: tauri::State<'_, StartupPdf>,
) -> Result<Option<OpenedPdf>, String> {
    startup_pdf.take()
}

#[tauri::command]
fn open_pdf_in_new_window_dialog(app: tauri::AppHandle) -> Result<bool, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file()
    else {
        return Ok(false);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    open_in_new_window_path(&path)?;
    Ok(true)
}

#[tauri::command]
fn open_in_new_window(
    file_grant: String,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<(), String> {
    let path = file_grants.resolve(&file_grant)?;
    open_in_new_window_path(&path)
}

/// Multi-select picker for add-file flows (Organize adds, Binder exhibits,
/// pages-tab insert, package workspaces). Never reads bytes eagerly — below
/// the threshold the UI fetches the whole file with one ranged read
/// (`read_pdf_range(grant, 0, sizeBytes)`), above it the descriptors feed
/// the path-op pipeline [R5-1][R7-2].
#[tauri::command]
fn pick_pdfs_for_add(
    app: tauri::AppHandle,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<PickedPdfs>, String> {
    let Some(paths) = app
        .dialog()
        .file()
        .add_filter("PDF or Word", &["pdf", "docx"])
        .blocking_pick_files()
    else {
        return Ok(None);
    };

    let threshold_bytes = large_doc_threshold_bytes();
    let mut files = Vec::with_capacity(paths.len());

    for path in paths {
        let path = path.into_path().map_err(|error| error.to_string())?;
        require_pdf_or_docx_extension(&path)?;
        let size_bytes = fs::metadata(&path)
            .map_err(|_| READ_PDF_ERROR.to_string())?
            .len();
        let source = picked_add_source(&path);
        let markup_scan =
            matches!(source, PickedAddSource::Docx).then(|| docx_scan::scan_docx_markup(&path));
        files.push(PickedPdf {
            grant: file_grants.grant(path.clone())?,
            name: file_name(&path),
            size_bytes,
            source,
            markup_scan,
            converted_from_grant: None,
        });
    }

    Ok(Some(PickedPdfs {
        files,
        threshold_bytes,
    }))
}

#[tauri::command]
fn pick_pdf_for_word(
    app: tauri::AppHandle,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<PickedPdfForWord>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    require_pdf_extension(&path)?;
    let size_bytes = fs::metadata(&path)
        .map_err(|_| READ_PDF_ERROR.to_string())?
        .len();

    Ok(Some(PickedPdfForWord {
        grant: file_grants.grant(path.clone())?,
        name: file_name(&path),
        size_bytes,
    }))
}

#[tauri::command]
fn pick_docx_for_import(
    app: tauri::AppHandle,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<PickedDocxForImport>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Word Document", &["docx"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    require_docx_extension(&path)?;
    let size_bytes = fs::metadata(&path)
        .map_err(|_| READ_PDF_ERROR.to_string())?
        .len();
    let markup_scan = docx_scan::scan_docx_markup(&path);

    Ok(Some(PickedDocxForImport {
        grant: file_grants.grant(path.clone())?,
        name: file_name(&path),
        size_bytes,
        markup_scan,
    }))
}

#[tauri::command]
async fn convert_docx_for_add(
    app: tauri::AppHandle,
    file_grants: tauri::State<'_, FileGrants>,
    files: Vec<DocxAddInput>,
    markup: core_word::MarkupMode,
) -> Result<DocxAddBatchResult, engine_sidecar_core::path_ops::PathOpError> {
    let total = files.len();
    let mut converted = Vec::with_capacity(total);
    let mut errors = Vec::new();

    for (zero_index, file) in files.into_iter().enumerate() {
        let index = zero_index + 1;
        let _ = app.emit(
            DOCX_CONVERT_PROGRESS_EVENT,
            DocxConvertProgressPayload {
                index,
                total,
                file: file.name.clone(),
                phase: "startingWord".to_string(),
            },
        );

        let input = match file_grants.resolve(&file.grant) {
            Ok(input) => input,
            Err(message) => {
                let error = DocxAddError {
                    grant: file.grant,
                    name: file.name,
                    code: "INVALID_INPUT".to_string(),
                    message,
                };
                emit_docx_done_error(&app, index, total, &error);
                errors.push(error);
                continue;
            }
        };

        let _ = app.emit(
            DOCX_CONVERT_PROGRESS_EVENT,
            DocxConvertProgressPayload {
                index,
                total,
                file: file.name.clone(),
                phase: "converting".to_string(),
            },
        );

        match convert_one_docx_for_add(&app, file_grants.inner(), &input, &file.name, markup).await
        {
            Ok(output) => {
                let _ = app.emit(
                    DOCX_CONVERT_FILE_DONE_EVENT,
                    DocxConvertDonePayload {
                        index,
                        total,
                        file: file.name,
                        status: "ok".to_string(),
                        grant: Some(output.grant.clone()),
                        name: Some(output.name.clone()),
                        page_count: Some(output.page_count),
                        error: None,
                    },
                );
                converted.push(PickedPdf {
                    grant: output.grant,
                    name: output.name,
                    size_bytes: output.size_bytes,
                    source: PickedAddSource::Pdf,
                    markup_scan: None,
                    converted_from_grant: Some(file.grant),
                });
            }
            Err(error) => {
                let error = DocxAddError {
                    grant: file.grant,
                    name: file.name,
                    code: error.code.to_string(),
                    message: error.message,
                };
                emit_docx_done_error(&app, index, total, &error);
                errors.push(error);
            }
        }
    }

    Ok(DocxAddBatchResult {
        files: converted,
        errors,
    })
}

/// Ranged read for the streamed viewer. Raw binary response; bounds are
/// end-exclusive and validated against the grant-time snapshot (see
/// `range_read.rs` for the contract).
#[tauri::command]
fn read_pdf_range(
    grant: String,
    offset: u64,
    length: u64,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<tauri::ipc::Response, RangeReadError> {
    let entry = file_grants
        .resolve_entry(&grant)
        .map_err(|_| RangeReadError::grant_not_found())?;
    let snapshot = entry
        .snapshot
        .ok_or_else(RangeReadError::grant_without_snapshot)?;
    let cap = range_call_cap_bytes(large_doc_threshold_bytes());

    Ok(tauri::ipc::Response::new(read_file_range(
        &entry.path,
        &snapshot,
        offset,
        length,
        cap,
    )?))
}

/// Save As for streamed documents: a shell-side file copy by grant — the
/// bytes never cross into the WebView. The copy is refused if the source
/// drifted from its open-time snapshot (a changed file must be reopened,
/// not silently propagated).
#[tauri::command]
fn save_pdf_copy_dialog(
    app: tauri::AppHandle,
    source_grant: String,
    suggested_name: String,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<SavedPdf>, String> {
    let entry = file_grants.resolve_entry(&source_grant)?;
    let snapshot = entry
        .snapshot
        .ok_or("This file could not be verified against its open-time snapshot — reopen it.")?;
    let current = snapshot_file(&entry.path)
        .map_err(|_| "This file changed on disk — reopen it.".to_string())?;

    if current != snapshot {
        return Err("This file changed on disk — reopen it.".to_string());
    }

    let suggested_name = ensure_pdf_extension(&suggested_name);
    let Some(destination) = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(suggested_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let destination = destination.into_path().map_err(|error| error.to_string())?;

    // Copying a file onto itself truncates the source to zero bytes before
    // the copy begins (fs::copy opens the destination with truncation), which
    // would destroy the user's original. A streamed document is clean by
    // construction, so "save over the original" is already satisfied — treat
    // it as a successful no-op (Codex review, PR #124).
    if is_same_file(&entry.path, &destination) {
        ensure_grant_file_unchanged(&entry)?;
        return Ok(Some(saved_pdf(&destination, file_grants.inner())?));
    }

    atomic_copy_grant_if_unchanged(&entry, &destination)?;

    Ok(Some(saved_pdf(&destination, file_grants.inner())?))
}

#[tauri::command]
fn pick_output_directory(
    app: tauri::AppHandle,
    directory_grants: tauri::State<'_, DirectoryGrants>,
) -> Result<Option<PickedDirectory>, String> {
    let Some(path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    let path = validate_output_directory(&path)?;
    let display_path = path
        .clone()
        .into_os_string()
        .into_string()
        .map_err(|_| "Selected folder path is not valid UTF-8".to_string())?;
    let grant = directory_grants.grant(path)?;

    Ok(Some(PickedDirectory {
        grant,
        path: display_path,
    }))
}

#[tauri::command]
fn save_pdf_into_dir(
    request: tauri::ipc::Request<'_>,
    directory_grants: tauri::State<'_, DirectoryGrants>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<SavedPdf, String> {
    let directory_grant = required_header(&request, HEADER_DIRECTORY_GRANT)?;
    let file_name = required_header(&request, HEADER_FILE_NAME)?;
    let directory = validate_output_directory(&directory_grants.resolve(&directory_grant)?)?;
    let path = write_pdf_bytes_into_directory(&directory, &file_name, &raw_pdf_bytes(&request)?)?;

    saved_pdf(&path, file_grants.inner())
}

#[tauri::command]
fn save_pdf_copy_into_dir(
    source_grant: String,
    directory_grant: String,
    file_name: String,
    directory_grants: tauri::State<'_, DirectoryGrants>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<SavedPdf, String> {
    let entry = file_grants.resolve_entry(&source_grant)?;
    let directory = validate_output_directory(&directory_grants.resolve(&directory_grant)?)?;
    let path = copy_pdf_grant_into_directory(&entry, &directory, &file_name)?;

    saved_pdf(&path, file_grants.inner())
}

/// True when both paths refer to the same on-disk file. Canonicalization
/// resolves case/short-name/symlink differences; when the destination does
/// not exist yet (the common Save As case) the paths cannot be the same file.
fn is_same_file(source: &Path, destination: &Path) -> bool {
    match (fs::canonicalize(source), fs::canonicalize(destination)) {
        (Ok(source), Ok(destination)) => source == destination,
        _ => false,
    }
}

#[tauri::command]
fn read_opened_pdf_bytes(
    token: String,
    pending_pdf_bytes: tauri::State<'_, PendingPdfBytes>,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(pending_pdf_bytes.remove(&token)?))
}

#[tauri::command]
fn dropped_pdf_begin(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
    dropped_uploads: tauri::State<'_, DroppedUploads>,
) -> Result<String, String> {
    let expected_total = required_u64_header(&request, HEADER_DROPPED_PDF_SIZE)?;
    let file_name = required_header(&request, HEADER_FILE_NAME)?;
    let root = path_ops_root_for_app(&app)?;

    dropped_uploads.begin_upload(&root, expected_total, &file_name)
}

#[tauri::command]
fn dropped_pdf_append(
    request: tauri::ipc::Request<'_>,
    dropped_uploads: tauri::State<'_, DroppedUploads>,
) -> Result<(), String> {
    let token = required_header(&request, HEADER_DROPPED_PDF_TOKEN)?;
    let bytes = raw_pdf_bytes(&request)?;

    dropped_uploads.append_upload(&token, &bytes)
}

#[tauri::command]
fn dropped_pdf_finish(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
    dropped_uploads: tauri::State<'_, DroppedUploads>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<OpenedPdf, String> {
    let token = required_header(&request, HEADER_DROPPED_PDF_TOKEN)?;
    let root = path_ops_root_for_app(&app)?;

    dropped_uploads.finish_upload(&token, &root, file_grants.inner())
}

#[tauri::command]
fn dropped_pdf_abort(
    request: tauri::ipc::Request<'_>,
    dropped_uploads: tauri::State<'_, DroppedUploads>,
) -> Result<(), String> {
    let token = required_header(&request, HEADER_DROPPED_PDF_TOKEN)?;

    dropped_uploads.abort_upload(&token)
}

#[tauri::command]
fn save_pdf_dialog(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<SavedPdf>, String> {
    let suggested_name = required_header(&request, HEADER_SUGGESTED_NAME)?;
    let suggested_name = ensure_pdf_extension(&suggested_name);
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(suggested_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    write_pdf_bytes_atomic(&path, &raw_pdf_bytes(&request)?)?;

    Ok(Some(saved_pdf(&path, file_grants.inner())?))
}

#[tauri::command]
fn save_docx_dialog(
    app: tauri::AppHandle,
    source_grant: String,
    suggested_name: String,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Option<SavedDocx>, String> {
    let entry = file_grants.resolve_entry(&source_grant)?;
    ensure_docx_source(&entry.path)?;
    let suggested_name = ensure_docx_extension(&suggested_name);
    let Some(destination) = app
        .dialog()
        .file()
        .add_filter("Word Document", &["docx"])
        .set_file_name(suggested_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let destination = destination.into_path().map_err(|error| error.to_string())?;
    if is_same_file(&entry.path, &destination) {
        ensure_grant_file_unchanged(&entry)?;
        return Ok(Some(saved_docx(&destination, file_grants.inner())?));
    }

    atomic_copy_docx_grant_if_unchanged(&entry, &destination)?;
    Ok(Some(saved_docx(&destination, file_grants.inner())?))
}

#[tauri::command]
fn save_pdf_to_path(
    request: tauri::ipc::Request<'_>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<SavedPdf, String> {
    let file_grant = required_header(&request, HEADER_FILE_GRANT)?;
    let entry = file_grants.resolve_entry(&file_grant)?;
    write_pdf_bytes_atomic_if_unchanged(&entry, &raw_pdf_bytes(&request)?)?;

    saved_pdf(&entry.path, file_grants.inner())
}

#[tauri::command]
fn open_source_licenses(app: tauri::AppHandle) -> Result<(), String> {
    let notices = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve resource directory: {error}"))?
        .join("payload")
        .join("legal")
        .join("THIRD-PARTY-NOTICES.txt");

    if !notices.is_file() {
        return Err(format!(
            "Open source notices are missing from the bundled payload: {}",
            notices.display()
        ));
    }

    app.opener()
        .open_path(notices.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| format!("Could not open open-source notices: {error}"))
}

fn raw_pdf_bytes<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        // Tauri downgrades the binary IPC channel to `postMessage` when the raw
        // custom-protocol fetch is blocked (e.g. the WebView CSP does not allow
        // `http://ipc.localhost`), serializing the bytes as a JSON number array.
        // Accept that fallback shape so a save survives the downgrade instead of
        // failing after the Save dialog. The tauri.conf.json CSP entry keeps the
        // fast raw path available; this is belt-and-braces for the fallback.
        tauri::ipc::InvokeBody::Json(value) => Ok(Cow::Owned(json_pdf_bytes(value)?)),
        #[allow(unreachable_patterns)]
        _ => Err("Expected raw PDF bytes".to_string()),
    }
}

/// Decode a JSON number array (the `postMessage` IPC fallback shape) into raw
/// bytes. Every element must be an integer in `0..=255`.
fn json_pdf_bytes(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let array = value
        .as_array()
        .ok_or_else(|| "Expected raw PDF bytes".to_string())?;
    array
        .iter()
        .map(|entry| {
            entry
                .as_u64()
                .filter(|byte| *byte <= u8::MAX as u64)
                .map(|byte| byte as u8)
                .ok_or_else(|| "Expected raw PDF bytes".to_string())
        })
        .collect()
}

fn required_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("Missing {name} header"))?
        .to_str()
        .map_err(|_| format!("Invalid {name} header"))?;

    percent_decode(value)
}

fn required_u64_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<u64, String> {
    let value = required_header(request, name)?;
    value
        .parse::<u64>()
        .map_err(|_| format!("Invalid {name} header"))
}

fn percent_decode(value: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut chars = value.as_bytes().iter().copied();

    while let Some(byte) = chars.next() {
        if byte != b'%' {
            bytes.push(byte);
            continue;
        }

        let high = chars
            .next()
            .ok_or_else(|| "Invalid percent-encoded header".to_string())?;
        let low = chars
            .next()
            .ok_or_else(|| "Invalid percent-encoded header".to_string())?;
        let high = hex_value(high)?;
        let low = hex_value(low)?;
        bytes.push((high << 4) | low);
    }

    String::from_utf8(bytes).map_err(|_| "Invalid UTF-8 header value".to_string())
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("Invalid percent-encoded header".to_string()),
    }
}

/// Plain-language messages for file-IO failures. None of these leak a
/// filesystem path or a raw OS error code to the user.
const SAVE_PDF_ERROR: &str =
    "RaioPDF couldn't save this PDF. Check that the folder is writable and try again.";
const READ_PDF_ERROR: &str =
    "RaioPDF couldn't read this PDF. Check that the file is still there and try again.";
const SAVE_WORD_ERROR: &str =
    "RaioPDF couldn't save this Word document. Check that the folder is writable and try again.";
const OUTPUT_FOLDER_ERROR: &str =
    "RaioPDF couldn't use that output folder. Choose a different folder and try again.";

fn write_pdf_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_file(path, bytes).map_err(|_| SAVE_PDF_ERROR.to_string())
}

fn write_pdf_bytes_into_directory(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    write_pdf_bytes_into_directory_path(directory, file_name, bytes)
}

fn write_pdf_bytes_into_directory_path(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let path = collision_free_output_pdf_path(directory, file_name)?;
    atomic_write_new_file(&path, bytes).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    Ok(path)
}

fn copy_pdf_grant_into_directory(
    entry: &FileGrantEntry,
    directory: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    let path = collision_free_output_pdf_path(directory, file_name)?;
    atomic_copy_grant_if_unchanged_new(entry, &path)?;
    Ok(path)
}

fn write_pdf_bytes_atomic_if_unchanged(entry: &FileGrantEntry, bytes: &[u8]) -> Result<(), String> {
    atomic_write_grant_if_unchanged(entry, bytes)
}

fn ensure_grant_file_unchanged(entry: &FileGrantEntry) -> Result<(), String> {
    let snapshot = entry
        .snapshot
        .ok_or("This file could not be verified against its open-time snapshot — reopen it.")?;
    let current = snapshot_file(&entry.path)
        .map_err(|_| "This file changed on disk — reopen it.".to_string())?;

    if current != snapshot {
        return Err("This file changed on disk — reopen it.".to_string());
    }

    Ok(())
}

fn atomic_write_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let permissions = replacement_permissions(path, None)?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())?;
    temp.write_all(bytes)?;
    apply_replacement_permissions(&temp, permissions)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    persist_atomic_file(temp, path)?;

    sync_parent_dir(parent)
}

fn atomic_write_new_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = replacement_temp_file(parent, None)?;
    temp.write_all(bytes)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    persist_atomic_file_noclobber(temp, path)?;

    sync_parent_dir(parent)
}

#[cfg(test)]
fn atomic_copy_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(source)?;
    let permissions = replacement_permissions(destination, Some(source))?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())?;
    io::copy(&mut input, temp.as_file_mut())?;
    apply_replacement_permissions(&temp, permissions)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    persist_atomic_file(temp, destination)?;

    sync_parent_dir(parent)
}

fn atomic_write_grant_if_unchanged(entry: &FileGrantEntry, bytes: &[u8]) -> Result<(), String> {
    let path = fs::canonicalize(&entry.path).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let permissions =
        replacement_permissions(&path, None).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.write_all(bytes)
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;
    apply_replacement_permissions(&temp, permissions).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.flush().map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;

    let backup = backup_path_for(&path);
    fs::rename(&path, &backup).map_err(|_| SAVE_PDF_ERROR.to_string())?;

    let result = (|| {
        let backup_entry = FileGrantEntry {
            path: backup.clone(),
            snapshot: entry.snapshot,
        };
        ensure_grant_file_unchanged(&backup_entry)?;
        persist_atomic_file_noclobber(temp, &path)
            .and_then(|_| sync_parent_dir(parent))
            .map_err(|_| SAVE_PDF_ERROR.to_string())
    })();

    match result {
        Ok(()) => {
            // The save itself is complete — the new bytes are durably in
            // place. Backup cleanup must not fail the save: AV scanners and
            // indexers routinely hold a just-renamed file briefly on Windows,
            // and reporting SAVE_PDF_ERROR here told the user a successful
            // save had failed (while stranding the backup).
            remove_save_backup_best_effort(backup);
            Ok(())
        }
        Err(error) => {
            restore_staged_original(&backup, &path).map_err(|_| {
                "RaioPDF couldn't save this PDF, and the original file couldn't be restored. Check the folder and try again."
                    .to_string()
            })?;
            Err(error)
        }
    }
}

const SAVE_BACKUP_CLEANUP_RETRIES: usize = 5;
const SAVE_BACKUP_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(400);

/// Delete the `.…raio-save-backup` staged next to the user's file after a
/// save has already succeeded. A transient lock (AV, indexer) gets a few
/// background retries; if the file is still held, it is simply left behind —
/// each save mints a unique backup name, so a stray one can never corrupt a
/// later save. (The same applies to a backup orphaned by a crash between
/// rename and persist: recovering it on the next open would mean scanning the
/// user's directories, which RaioPDF deliberately does not do.)
fn remove_save_backup_best_effort(backup: PathBuf) {
    match fs::remove_file(&backup) {
        Ok(()) => return,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(_) => {}
    }
    std::thread::spawn(move || {
        for _ in 0..SAVE_BACKUP_CLEANUP_RETRIES {
            std::thread::sleep(SAVE_BACKUP_CLEANUP_RETRY_DELAY);
            match fs::remove_file(&backup) {
                Ok(()) => return,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return,
                Err(_) => {}
            }
        }
    });
}

fn atomic_copy_grant_if_unchanged(
    entry: &FileGrantEntry,
    destination: &Path,
) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(&entry.path).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    let permissions = replacement_permissions(destination, Some(&entry.path))
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;
    io::copy(&mut input, temp.as_file_mut()).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    apply_replacement_permissions(&temp, permissions).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.flush().map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;

    ensure_grant_file_unchanged(entry)?;
    persist_atomic_file(temp, destination)
        .and_then(|_| sync_parent_dir(parent))
        .map_err(|_| SAVE_PDF_ERROR.to_string())
}

fn atomic_copy_grant_if_unchanged_new(
    entry: &FileGrantEntry,
    destination: &Path,
) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(&entry.path).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    let permissions = replacement_permissions(destination, Some(&entry.path))
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;
    io::copy(&mut input, temp.as_file_mut()).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    apply_replacement_permissions(&temp, permissions).map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.flush().map_err(|_| SAVE_PDF_ERROR.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|_| SAVE_PDF_ERROR.to_string())?;

    ensure_grant_file_unchanged(entry)?;
    persist_atomic_file_noclobber(temp, destination)
        .and_then(|_| sync_parent_dir(parent))
        .map_err(|_| SAVE_PDF_ERROR.to_string())
}

fn atomic_copy_docx_grant_if_unchanged(
    entry: &FileGrantEntry,
    destination: &Path,
) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(&entry.path).map_err(|_| SAVE_WORD_ERROR.to_string())?;
    let permissions = replacement_permissions(destination, Some(&entry.path))
        .map_err(|_| SAVE_WORD_ERROR.to_string())?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())
        .map_err(|_| SAVE_WORD_ERROR.to_string())?;
    io::copy(&mut input, temp.as_file_mut()).map_err(|_| SAVE_WORD_ERROR.to_string())?;
    apply_replacement_permissions(&temp, permissions).map_err(|_| SAVE_WORD_ERROR.to_string())?;
    temp.flush().map_err(|_| SAVE_WORD_ERROR.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|_| SAVE_WORD_ERROR.to_string())?;

    ensure_grant_file_unchanged(entry)?;
    persist_atomic_file(temp, destination)
        .and_then(|_| sync_parent_dir(parent))
        .map_err(|_| SAVE_WORD_ERROR.to_string())
}

fn persist_atomic_file(temp: tempfile::NamedTempFile, path: &Path) -> Result<(), std::io::Error> {
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn persist_atomic_file_noclobber(
    temp: tempfile::NamedTempFile,
    path: &Path,
) -> Result<(), std::io::Error> {
    temp.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(())
}

fn backup_path_for(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "document.pdf".into());

    parent.join(format!(
        ".{file_name}.{}.{}.raio-save-backup",
        process::id(),
        Uuid::new_v4()
    ))
}

fn restore_staged_original(backup: &Path, destination: &Path) -> Result<(), std::io::Error> {
    match fs::metadata(destination) {
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination path was recreated while saving",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::rename(backup, destination)
        }
        Err(error) => Err(error),
    }
}

fn replacement_permissions(
    destination: &Path,
    source_fallback: Option<&Path>,
) -> Result<Option<fs::Permissions>, std::io::Error> {
    match fs::metadata(destination) {
        Ok(metadata) => Ok(Some(metadata.permissions())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => source_fallback
            .map(fs::metadata)
            .transpose()
            .map(|metadata| metadata.map(|metadata| metadata.permissions())),
        Err(error) => Err(error),
    }
}

fn replacement_temp_file(
    parent: &Path,
    permissions: Option<&fs::Permissions>,
) -> Result<tempfile::NamedTempFile, std::io::Error> {
    let mut builder = tempfile::Builder::new();
    apply_default_create_permissions(&mut builder, permissions);
    builder.tempfile_in(parent)
}

fn apply_replacement_permissions(
    temp: &tempfile::NamedTempFile,
    permissions: Option<fs::Permissions>,
) -> Result<(), std::io::Error> {
    if let Some(permissions) = permissions {
        temp.as_file().set_permissions(permissions)?;
    }

    Ok(())
}

#[cfg(unix)]
fn apply_default_create_permissions(
    builder: &mut tempfile::Builder,
    permissions: Option<&fs::Permissions>,
) {
    use std::os::unix::fs::PermissionsExt;

    if permissions.is_none() {
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
}

#[cfg(not(unix))]
fn apply_default_create_permissions(
    _builder: &mut tempfile::Builder,
    _permissions: Option<&fs::Permissions>,
) {
}

fn sync_parent_dir(parent: &Path) -> Result<(), std::io::Error> {
    if let Ok(parent_dir) = fs::File::open(parent) {
        let _ = parent_dir.sync_all();
    }

    Ok(())
}

fn saved_pdf(path: &Path, file_grants: &FileGrants) -> Result<SavedPdf, String> {
    Ok(SavedPdf {
        name: file_name(path),
        file_grant: file_grants.grant(path.to_path_buf())?,
    })
}

fn saved_docx(path: &Path, file_grants: &FileGrants) -> Result<SavedDocx, String> {
    Ok(SavedDocx {
        name: file_name(path),
        file_grant: file_grants.grant(path.to_path_buf())?,
    })
}

fn ensure_docx_source(path: &Path) -> Result<(), String> {
    let extension_ok = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("docx"))
        .unwrap_or(false);
    if extension_ok {
        Ok(())
    } else {
        Err("Source file is not a Word document.".to_string())
    }
}

fn validate_output_directory(path: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|_| OUTPUT_FOLDER_ERROR.to_string())?;
    let metadata = fs::metadata(&path).map_err(|_| OUTPUT_FOLDER_ERROR.to_string())?;

    if !metadata.is_dir() {
        return Err("Selected output location is not a folder".to_string());
    }

    Ok(path)
}

fn collision_free_output_pdf_path(directory: &Path, file_name: &str) -> Result<PathBuf, String> {
    let file_name = sanitize_pdf_file_name(file_name);
    let path = directory.join(&file_name);

    if !path.exists() {
        return Ok(path);
    }

    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled");

    for suffix in 2..10_000 {
        let candidate = directory.join(format!("{stem} ({suffix}).pdf"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Could not choose an available filename for {}",
        file_name
    ))
}

fn sanitize_pdf_file_name(file_name: &str) -> String {
    let mut sanitized = file_name
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();

    sanitized = sanitized.trim_matches([' ', '.']).to_string();

    if sanitized.is_empty() {
        sanitized = "Untitled".to_string();
    }

    ensure_pdf_extension(&sanitized)
}

struct ConvertedDocxForAdd {
    grant: String,
    name: String,
    size_bytes: u64,
    page_count: u32,
}

async fn convert_one_docx_for_add(
    app: &tauri::AppHandle,
    file_grants: &FileGrants,
    input: &Path,
    source_name: &str,
    markup: core_word::MarkupMode,
) -> Result<ConvertedDocxForAdd, engine_sidecar_core::path_ops::PathOpError> {
    let toolchain = path_ops::discover_toolchain(app);
    let work_dir = path_ops::OpWorkDir::create(app)?;
    let output_name = converted_pdf_name_for_word_input(input, source_name);
    let output_path = work_dir.path().join(&output_name);

    let (page_count, size_bytes) = {
        let input = input.to_path_buf();
        let output_path = output_path.clone();
        let toolchain_for_work = toolchain.clone();
        path_ops::on_blocking_pool(move || {
            core_word::convert_docx_to_pdf_with_toolchain(
                &toolchain_for_work,
                &input,
                &output_path,
                markup,
            )?;
            let page_count =
                engine_sidecar_core::path_ops::page_count(&toolchain_for_work, &output_path)?;
            let size_bytes = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| engine_sidecar_core::path_ops::PathOpError {
                    code: "IO_ERROR",
                    message: format!("cannot stat converted PDF: {error}"),
                })?;
            Ok((page_count, size_bytes))
        })
        .await?
    };

    let grant = file_grants.grant(output_path).map_err(|message| {
        engine_sidecar_core::path_ops::PathOpError {
            code: "IO_ERROR",
            message,
        }
    })?;
    work_dir.keep();

    Ok(ConvertedDocxForAdd {
        grant,
        name: output_name,
        size_bytes,
        page_count,
    })
}

fn emit_docx_done_error(app: &tauri::AppHandle, index: usize, total: usize, error: &DocxAddError) {
    let _ = app.emit(
        DOCX_CONVERT_FILE_DONE_EVENT,
        DocxConvertDonePayload {
            index,
            total,
            file: error.name.clone(),
            status: "error".to_string(),
            grant: None,
            name: None,
            page_count: None,
            error: Some(error.message.clone()),
        },
    );
}

fn converted_pdf_name_for_word_input(input: &Path, fallback_name: &str) -> String {
    let stem = input
        .file_stem()
        .and_then(|stem| stem.to_str())
        .or_else(|| {
            Path::new(fallback_name)
                .file_stem()
                .and_then(|stem| stem.to_str())
        })
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("converted");
    let sanitized = stem
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    format!("{sanitized}.pdf")
}

fn require_pdf_extension(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Ok(());
    }

    Err("Selected file is not a PDF".to_string())
}

fn require_pdf_or_docx_extension(path: &Path) -> Result<(), String> {
    if is_pdf_path(path) || is_docx_path(path) {
        return Ok(());
    }

    Err("Selected file is not a PDF or Word document".to_string())
}

fn require_docx_extension(path: &Path) -> Result<(), String> {
    if is_docx_path(path) {
        return Ok(());
    }

    Err("Selected file is not a Word document".to_string())
}

fn picked_add_source(path: &Path) -> PickedAddSource {
    if is_docx_path(path) {
        PickedAddSource::Docx
    } else {
        PickedAddSource::Pdf
    }
}

fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn is_docx_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
}

fn validate_pdf_file_arg(path: &Path) -> Result<PathBuf, String> {
    require_pdf_extension(path)?;

    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Could not inspect PDF at {}: {error}",
            path.to_string_lossy()
        )
    })?;
    if !metadata.is_file() {
        return Err("PDF argument is not a file".to_string());
    }

    fs::File::open(path)
        .map_err(|error| format!("Could not read PDF at {}: {error}", path.to_string_lossy()))?;
    Ok(path.to_path_buf())
}

fn startup_pdf_arg_from_args<I>(args: I) -> (Option<PathBuf>, Vec<String>)
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut diagnostics = Vec::new();

    for arg in args {
        match validate_pdf_file_arg(&arg) {
            Ok(path) => return (Some(path), diagnostics),
            Err(error) => diagnostics.push(format!(
                "Ignoring startup file argument {}: {error}",
                arg.to_string_lossy()
            )),
        }
    }

    (None, diagnostics)
}

fn open_in_new_window_path(path: &Path) -> Result<(), String> {
    open_in_new_window_path_with(path, spawn_detached_new_window)
}

fn open_in_new_window_path_with<F>(path: &Path, spawn: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let path = validate_pdf_file_arg(path)?;
    spawn(&path)
}

fn spawn_detached_new_window(path: &Path) -> Result<(), String> {
    let exe = env::current_exe().map_err(|error| format!("Could not find current app: {error}"))?;
    Command::new(exe)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open PDF in a new window: {error}"))
}

fn ensure_pdf_extension(file_name: &str) -> String {
    if file_name.to_ascii_lowercase().ends_with(".pdf") {
        file_name.to_string()
    } else {
        format!("{file_name}.pdf")
    }
}

fn ensure_docx_extension(file_name: &str) -> String {
    if file_name.to_ascii_lowercase().ends_with(".docx") {
        file_name.to_string()
    } else {
        format!("{file_name}.docx")
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled.pdf")
        .to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.set_menu(build_native_menu(app.handle())?)?;
            let app_data_dir = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir().ok();
            // Identity first: everything stamped with this instance's id
            // (session marker, path-op owner markers) must be written only
            // while the identity's lock file is already held, so other
            // instances' liveness probes can never race a startup.
            let instance_identity = instance::init_current(&app_data_dir);
            let diagnostics = AppDiagnostics::new(
                app_data_dir.clone(),
                instance_identity.map(|identity| identity.id().to_string()),
            );
            let _ = diagnostics.capture_pending_crash_for_startup();
            let _ = diagnostics.mark_session_running();
            diagnostics.install_panic_hook();
            let _ = diagnostics.record_shell_event("startup", "RaioPDF shell started");
            let manager = sidecar::SidecarManager::new(sidecar::SidecarConfig::from_env(
                app_data_dir.clone(),
                resource_dir,
            ));
            app.manage(manager);
            app.manage(diagnostics);
            app.manage(PendingPdfBytes::default());
            app.manage(FileGrants::default());
            app.manage(DirectoryGrants::default());
            app.manage(DroppedUploads::default());
            app.manage(StartupPdf::default());
            app.manage(path_ops::PathOpJobs::default());
            app.manage(print::PrintJobs::default());
            app.manage(word::WordCapabilityCache::default());

            let (startup_pdf_path, startup_arg_diagnostics) =
                startup_pdf_arg_from_args(env::args_os().skip(1).map(PathBuf::from));
            for message in startup_arg_diagnostics {
                let _ = app
                    .state::<AppDiagnostics>()
                    .record_shell_event("startup-arg", &message);
            }
            if let Some(path) = startup_pdf_path {
                // An "Open in New Window" handoff points at the spawning
                // instance's path-op output dir — adopt it so it survives
                // sweeps after that instance exits (including our own below).
                path_ops::adopt_containing_output_dir(&app_data_dir, &path);
                match opened_pdf_for_path(
                    path,
                    app.state::<PendingPdfBytes>().inner(),
                    app.state::<FileGrants>().inner(),
                ) {
                    Ok(pdf) => {
                        let _ = app.state::<StartupPdf>().set(pdf);
                    }
                    Err(error) => {
                        let _ = app.state::<AppDiagnostics>().record_shell_event(
                            "startup-arg",
                            &format!("Ignoring startup PDF: {error}"),
                        );
                    }
                }
            }

            // Grants are in-memory, so a path-op temp dir is dead once the
            // instance that created it has exited — but other instances may
            // be running right now ("Open in New Window", the .pdf file
            // association), so the sweep only reclaims dirs whose owner is
            // gone. Runs off the startup path.
            std::thread::spawn(move || path_ops::purge_stale_outputs(&app_data_dir));
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();

            if id == MENU_EXIT {
                let _ = app
                    .state::<AppDiagnostics>()
                    .record_shell_event("shutdown", "menu exit requested");
                let _ = app.state::<AppDiagnostics>().mark_session_clean();
                // `app.exit(0)` skips window destruction, so the Destroyed
                // hook never fires on this path. RunEvent::Exit below also
                // stops the sidecar; doing it here too is belt and braces
                // against the engine java process outliving the app.
                app.state::<sidecar::SidecarManager>().shutdown();
                app.exit(0);
                return;
            }

            let _ = app.emit(MENU_EVENT, id);
        })
        .invoke_handler(tauri::generate_handler![
            open_pdf_dialog,
            take_startup_pdf,
            open_pdf_in_new_window_dialog,
            open_in_new_window,
            read_opened_pdf_bytes,
            dropped_pdf_begin,
            dropped_pdf_append,
            dropped_pdf_finish,
            dropped_pdf_abort,
            read_pdf_range,
            pick_pdfs_for_add,
            pick_pdf_for_word,
            pick_docx_for_import,
            convert_docx_for_add,
            save_pdf_dialog,
            save_docx_dialog,
            save_pdf_to_path,
            save_pdf_copy_dialog,
            pick_output_directory,
            save_pdf_into_dir,
            save_pdf_copy_into_dir,
            sidecar::engine_start,
            sidecar::engine_status,
            sidecar::engine_stop,
            diagnostics::diagnostics_record_event,
            diagnostics::diagnostics_export_dialog,
            diagnostics::crash_report_take_pending,
            diagnostics::crash_report_never_ask,
            diagnostics::crash_report_is_opted_out,
            diagnostics::crash_report_set_opted_out,
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::build_production_set,
            mcp::batch_cleanup,
            mcp::build_filing_packet,
            path_ops::path_ops_status,
            path_ops::path_op_cancel,
            path_ops::path_op_page_count,
            path_ops::path_op_document_facts,
            path_ops::path_op_decrypt,
            path_ops::path_op_extract_pages,
            path_ops::path_op_merge,
            path_ops::path_op_insert_pages,
            path_ops::path_op_build_binder,
            path_ops::path_op_apply_edits,
            path_ops::path_op_split_by_max_bytes,
            path_ops::path_op_prepare_filing,
            path_ops::path_op_ocr,
            path_ops::path_op_repair,
            path_ops::path_op_redact_areas,
            path_ops::path_op_linearize,
            path_ops::path_op_compress,
            path_ops::path_op_sanitize,
            path_ops::path_op_normalize,
            path_ops::path_op_scrub_metadata,
            path_ops::path_op_bates_stamp,
            path_ops::path_op_page_numbers,
            path_ops::path_op_watermark,
            path_ops::path_op_release_output,
            open_source_licenses,
            print::print_status,
            print::print_list_printers,
            print::print_pdf,
            print::print_cancel,
            word::word_capability,
            word::word_convert_docx,
            word::word_pdf_has_text_layer,
            word::word_reflow_pdf_to_docx
        ])
        .build(tauri::generate_context!())
        .expect("failed to build RaioPDF shell")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                if label == "main" {
                    let _ = app_handle
                        .state::<AppDiagnostics>()
                        .record_shell_event("shutdown", "main window destroyed");
                    let _ = app_handle.state::<AppDiagnostics>().mark_session_clean();
                    app_handle.state::<sidecar::SidecarManager>().shutdown();
                }
            }
            // The deepest shared exit hook: Tauri dispatches RunEvent::Exit on
            // every exit path — window close AND `app.exit(0)` (menu exit, the
            // process plugin), which skips window destruction entirely and
            // used to orphan the engine java process. The Destroyed hook above
            // stays as belt and braces; `shutdown()` is idempotent.
            tauri::RunEvent::Exit => {
                let _ = app_handle
                    .state::<AppDiagnostics>()
                    .record_shell_event("shutdown", "app exiting");
                let _ = app_handle.state::<AppDiagnostics>().mark_session_clean();
                app_handle.state::<sidecar::SidecarManager>().shutdown();
            }
            _ => {}
        });
}

fn build_native_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .text("file:open", "Open...")
        .text("file:open-new-window", "Open in New Window...")
        .text("file:save", "Save")
        .text("file:save-as", "Save As...")
        .separator()
        .text("file:export-pdfa", "Export PDF/A...")
        .text("file:export-docx", "Export Editable Word (.docx)...")
        .text("file:print", "Print...")
        .text("file:protect", "Protect (passwords)...")
        .text("file:properties", "Document Properties")
        .separator()
        .text("file:export-diagnostics", "Export Diagnostics...")
        .separator()
        .text("file:preferences", "Preferences...")
        .text("file:open-raio-to-ai", "Open Raio to AI...")
        .separator()
        .text("file:about-macrify", "About Macrify...")
        .separator()
        .text(MENU_EXIT, "Exit")
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .text("edit:undo", "Undo")
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .text("view:zoom-in", "Zoom In")
        .text("view:zoom-out", "Zoom Out")
        .text("view:fit", "Fit")
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .text("help:open", "RaioPDF Help")
        .build()?;

    MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&help)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_grants_resolve_only_shell_owned_paths() {
        let grants = FileGrants::default();
        let path = PathBuf::from("/tmp/case.pdf");

        let grant = grants.grant(path.clone()).expect("grant should be issued");

        assert_eq!(grants.resolve(&grant).expect("grant should resolve"), path);
        assert!(!grant.contains("case.pdf"));
        assert!(grants.resolve("/tmp/case.pdf").is_err());
    }

    #[test]
    fn grants_snapshot_existing_files_and_serve_ranged_reads() {
        use std::io::Write;

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        std::fs::File::create(&path)
            .expect("create")
            .write_all(b"0123456789")
            .expect("write");

        let grants = FileGrants::default();
        let grant = grants.grant(path.clone()).expect("grant");
        let entry = grants.resolve_entry(&grant).expect("entry");
        let snapshot = entry.snapshot.expect("existing files get a snapshot");

        let bytes = read_file_range(&entry.path, &snapshot, 4, 3, 1024).expect("range");
        assert_eq!(bytes, b"456");
    }

    #[test]
    fn grants_for_missing_files_carry_no_snapshot() {
        let grants = FileGrants::default();
        let grant = grants
            .grant(PathBuf::from("/definitely/not/present.pdf"))
            .expect("grant");

        // Path still resolves (save flows need it) but there is no drift
        // baseline, so ranged reads must be refused upstream.
        let entry = grants.resolve_entry(&grant).expect("entry");
        assert!(entry.snapshot.is_none());
    }

    #[test]
    fn startup_pdf_arg_accepts_first_readable_pdf() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pdf = dir.path().join("case.PDF");
        fs::write(&pdf, b"%PDF-1.7").expect("write pdf");
        let ignored = dir.path().join("notes.txt");
        fs::write(&ignored, b"not a pdf").expect("write text");

        let (path, diagnostics) = startup_pdf_arg_from_args(vec![ignored, pdf.clone()]);

        assert_eq!(path, Some(pdf));
        assert_eq!(diagnostics.len(), 1);
    }

    #[test]
    fn startup_pdf_arg_ignores_bad_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("missing.pdf");

        let (path, diagnostics) = startup_pdf_arg_from_args(vec![missing]);

        assert!(path.is_none());
        assert_eq!(diagnostics.len(), 1);
    }

    #[test]
    fn main_document_arg_stays_pdf_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        let docx = dir.path().join("source.docx");
        fs::write(&docx, b"not a real docx").expect("write docx");

        let error = validate_pdf_file_arg(&docx).expect_err("DOCX is not a main-document input");

        assert_eq!(error, "Selected file is not a PDF");
    }

    #[test]
    fn add_picker_extension_gate_accepts_pdf_and_docx_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pdf = dir.path().join("case.PDF");
        let docx = dir.path().join("exhibit.DOCX");
        let txt = dir.path().join("notes.txt");

        assert!(require_pdf_or_docx_extension(&pdf).is_ok());
        assert!(require_pdf_or_docx_extension(&docx).is_ok());
        assert_eq!(
            require_pdf_or_docx_extension(&txt).expect_err("text should be rejected"),
            "Selected file is not a PDF or Word document",
        );
    }

    #[test]
    fn open_in_new_window_rejects_non_pdf_without_spawning() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.txt");
        fs::write(&path, b"not a pdf").expect("write text");
        let mut spawned = false;

        let error = open_in_new_window_path_with(&path, |_| {
            spawned = true;
            Ok(())
        })
        .expect_err("non-PDF should be rejected");

        assert_eq!(error, "Selected file is not a PDF");
        assert!(!spawned);
    }

    #[test]
    fn open_in_new_window_rejects_missing_pdf_without_spawning() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("missing.pdf");
        let mut spawned = false;

        let error = open_in_new_window_path_with(&path, |_| {
            spawned = true;
            Ok(())
        })
        .expect_err("missing PDF should be rejected");

        assert!(error.contains("Could not inspect PDF"));
        assert!(!spawned);
    }

    #[test]
    fn open_in_new_window_spawns_readable_pdf() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        fs::write(&path, b"%PDF-1.7").expect("write pdf");
        let mut spawned_path: Option<PathBuf> = None;

        open_in_new_window_path_with(&path, |path| {
            spawned_path = Some(path.to_path_buf());
            Ok(())
        })
        .expect("readable PDF should spawn");

        assert_eq!(spawned_path, Some(path));
    }

    #[test]
    fn json_pdf_bytes_decodes_number_array_fallback() {
        // The `postMessage` IPC fallback delivers bytes as a JSON number array.
        let value = serde_json::json!([37, 80, 68, 70]); // "%PDF"
        assert_eq!(json_pdf_bytes(&value).expect("decode"), b"%PDF");
    }

    #[test]
    fn json_pdf_bytes_rejects_non_array_and_out_of_range_values() {
        assert!(json_pdf_bytes(&serde_json::json!("not-an-array")).is_err());
        assert!(json_pdf_bytes(&serde_json::json!([256])).is_err());
        assert!(json_pdf_bytes(&serde_json::json!([-1])).is_err());
        assert!(json_pdf_bytes(&serde_json::json!([1, "x", 3])).is_err());
    }

    #[test]
    fn dropped_upload_finish_grants_temp_pdf_with_original_bytes() {
        let root = tempfile::tempdir().expect("temp dir");
        let uploads = DroppedUploads::default();
        let grants = FileGrants::default();
        let bytes = b"%PDF-1.7\nbody";
        let token = uploads
            .begin_upload(root.path(), bytes.len() as u64, "case.pdf")
            .expect("begin");

        uploads
            .append_upload(&token, &bytes[..5])
            .expect("append a");
        uploads
            .append_upload(&token, &bytes[5..])
            .expect("append b");
        let opened = uploads
            .finish_upload(&token, root.path(), &grants)
            .expect("finish");

        assert_eq!(opened.name, "case.pdf");
        assert_eq!(opened.size_bytes, bytes.len() as u64);
        assert!(opened.bytes_token.is_none());
        let entry = grants
            .resolve_entry(&opened.file_grant)
            .expect("grant resolves");
        assert_eq!(fs::read(&entry.path).expect("read temp"), bytes);
        let root = fs::canonicalize(root.path()).expect("canonical root");
        let path = fs::canonicalize(entry.path).expect("canonical path");
        assert_eq!(path.parent().and_then(Path::parent), Some(root.as_path()));
    }

    #[test]
    fn dropped_upload_append_rejects_unknown_token_and_declared_size_overflow() {
        let root = tempfile::tempdir().expect("temp dir");
        let uploads = DroppedUploads::default();

        assert!(uploads.append_upload("missing", b"%PDF").is_err());

        let token = uploads
            .begin_upload(root.path(), 3, "case.pdf")
            .expect("begin");
        uploads.append_upload(&token, b"%P").expect("append");
        assert!(uploads.append_upload(&token, b"DF").is_err());
        uploads.abort_upload(&token).expect("abort");
    }

    #[test]
    fn dropped_upload_finish_rejects_incomplete_upload_and_releases_the_slot() {
        let root = tempfile::tempdir().expect("temp dir");
        let uploads = DroppedUploads::default();
        let grants = FileGrants::default();
        let token = uploads
            .begin_upload(root.path(), 8, "case.pdf")
            .expect("begin");
        let temp_dir = uploads
            .upload_temp_dir(&token)
            .expect("upload temp dir recorded");

        uploads.append_upload(&token, b"%PDF").expect("append");

        let error = match uploads.finish_upload(&token, root.path(), &grants) {
            Ok(_) => panic!("finish should reject incomplete upload"),
            Err(error) => error,
        };
        assert!(error.contains("incomplete"));
        // The failed finish must free its in-flight slot and staging dir —
        // it used to pin one of the MAX_IN_FLIGHT_DROPPED_UPLOADS slots (and
        // leak the temp file) until restart.
        assert!(uploads.upload_temp_dir(&token).is_none());
        assert!(!temp_dir.exists());
        // The token is fully consumed, so a late abort has nothing to do.
        assert!(uploads.abort_upload(&token).is_err());
    }

    #[test]
    fn dropped_upload_failed_finish_frees_a_slot_for_a_new_upload() {
        let root = tempfile::tempdir().expect("temp dir");
        let uploads = DroppedUploads::default();
        let grants = FileGrants::default();
        let mut tokens = Vec::new();
        for index in 0..MAX_IN_FLIGHT_DROPPED_UPLOADS {
            tokens.push(
                uploads
                    .begin_upload(root.path(), 8, &format!("case-{index}.pdf"))
                    .expect("begin"),
            );
        }
        assert!(uploads
            .begin_upload(root.path(), 8, "case-full.pdf")
            .is_err());

        // Fail one finish (incomplete bytes) — its slot must become available.
        assert!(uploads
            .finish_upload(&tokens[0], root.path(), &grants)
            .is_err());
        uploads
            .begin_upload(root.path(), 8, "case-freed.pdf")
            .expect("slot freed by failed finish");
    }

    #[test]
    fn dropped_upload_abort_deletes_temp_dir() {
        let root = tempfile::tempdir().expect("temp dir");
        let uploads = DroppedUploads::default();
        let token = uploads
            .begin_upload(root.path(), 4, "case.pdf")
            .expect("begin");
        let temp_dir = uploads
            .upload_temp_dir(&token)
            .expect("upload temp dir recorded");

        assert!(temp_dir.exists());
        uploads.abort_upload(&token).expect("abort");
        assert!(!temp_dir.exists());
    }

    #[test]
    fn dropped_upload_sanitizes_messy_non_pdf_filename() {
        let root = tempfile::tempdir().expect("temp dir");
        let uploads = DroppedUploads::default();
        let grants = FileGrants::default();
        let token = uploads
            .begin_upload(root.path(), 0, "../nested\\case:part.txt")
            .expect("begin");

        let opened = uploads
            .finish_upload(&token, root.path(), &grants)
            .expect("finish");

        assert_eq!(opened.name, "_nested_case_part.txt.pdf");
        assert!(grants
            .resolve_entry(&opened.file_grant)
            .expect("grant")
            .path
            .ends_with("_nested_case_part.txt.pdf"));
    }

    #[test]
    fn output_file_name_sanitization_blocks_path_traversal() {
        assert_eq!(
            sanitize_pdf_file_name("../nested\\case:part"),
            "_nested_case_part.pdf"
        );
        assert_eq!(sanitize_pdf_file_name(""), "Untitled.pdf");
        assert_eq!(sanitize_pdf_file_name("already.pdf"), "already.pdf");
    }

    #[test]
    fn directory_saves_suffix_collisions_without_overwriting() {
        let dir = tempfile::tempdir().expect("temp dir");
        let existing = dir.path().join("case.pdf");
        fs::write(&existing, b"existing").expect("write existing");

        let path = write_pdf_bytes_into_directory_path(dir.path(), "case.pdf", b"new")
            .expect("write suffixed");

        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("case (2).pdf")
        );
        assert_eq!(fs::read(existing).expect("read existing"), b"existing");
        assert_eq!(fs::read(path).expect("read suffixed"), b"new");
    }

    #[test]
    fn directory_copy_uses_sanitized_name_and_preserves_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.pdf");
        fs::write(&source, b"source bytes").expect("write source");
        let grants = FileGrants::default();
        let grant = grants.grant(source.clone()).expect("grant");
        let entry = grants.resolve_entry(&grant).expect("entry");

        let path =
            copy_pdf_grant_into_directory(&entry, dir.path(), "../copy").expect("copy into dir");

        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("_copy.pdf")
        );
        assert_eq!(fs::read(source).expect("read source"), b"source bytes");
        assert_eq!(fs::read(path).expect("read copied"), b"source bytes");
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        fs::write(&path, b"old pdf bytes").expect("write original");

        atomic_write_file(&path, b"new pdf bytes").expect("atomic write");

        assert_eq!(fs::read(&path).expect("read replaced"), b"new pdf bytes");
    }

    #[test]
    fn atomic_copy_replaces_destination_without_changing_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.pdf");
        let destination = dir.path().join("destination.pdf");
        fs::write(&source, b"source pdf bytes").expect("write source");
        fs::write(&destination, b"old destination bytes").expect("write destination");

        atomic_copy_file(&source, &destination).expect("atomic copy");

        assert_eq!(fs::read(&source).expect("read source"), b"source pdf bytes");
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"source pdf bytes"
        );
    }

    #[test]
    fn grant_copy_refuses_drift_and_leaves_destination_intact() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.pdf");
        let destination = dir.path().join("destination.pdf");
        fs::write(&source, b"opened bytes").expect("write source");
        fs::write(&destination, b"existing destination").expect("write destination");
        let grants = FileGrants::default();
        let grant = grants
            .grant(source.clone())
            .expect("grant should be issued");
        fs::write(&source, b"changed externally after open").expect("external edit");

        let entry = grants.resolve_entry(&grant).expect("entry");
        let error = atomic_copy_grant_if_unchanged(&entry, &destination)
            .expect_err("drift should be refused");

        assert_eq!(error, "This file changed on disk — reopen it.");
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"existing destination"
        );
    }

    #[test]
    fn grant_write_replaces_unchanged_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        fs::write(&path, b"opened bytes").expect("write original");
        let grants = FileGrants::default();
        let grant = grants.grant(path.clone()).expect("grant should be issued");
        let entry = grants.resolve_entry(&grant).expect("entry");

        atomic_write_grant_if_unchanged(&entry, b"saved bytes").expect("save unchanged grant");

        assert_eq!(fs::read(&path).expect("read saved"), b"saved bytes");
    }

    #[test]
    fn save_backup_cleanup_removes_file_and_tolerates_missing_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let backup = dir.path().join(".case.pdf.123.abc.raio-save-backup");
        fs::write(&backup, b"backup bytes").expect("write backup");

        remove_save_backup_best_effort(backup.clone());
        assert!(!backup.exists());

        // A backup that is already gone must not spawn retries or panic.
        remove_save_backup_best_effort(dir.path().join("never-existed.raio-save-backup"));
    }

    #[test]
    fn grant_write_refuses_drift_and_restores_current_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        fs::write(&path, b"opened bytes").expect("write original");
        let grants = FileGrants::default();
        let grant = grants.grant(path.clone()).expect("grant should be issued");
        fs::write(&path, b"changed externally after open").expect("external edit");
        let entry = grants.resolve_entry(&grant).expect("entry");

        let error = atomic_write_grant_if_unchanged(&entry, b"saved bytes")
            .expect_err("drift should be refused");

        assert_eq!(error, "This file changed on disk — reopen it.");
        assert_eq!(
            fs::read(&path).expect("read restored"),
            b"changed externally after open"
        );
    }

    #[cfg(unix)]
    #[test]
    fn grant_write_through_symlink_preserves_link_and_updates_target() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("target.pdf");
        let link = dir.path().join("link.pdf");
        fs::write(&target, b"opened target bytes").expect("write target");
        symlink(&target, &link).expect("symlink");
        let grants = FileGrants::default();
        let grant = grants.grant(link.clone()).expect("grant should be issued");
        let entry = grants.resolve_entry(&grant).expect("entry");

        atomic_write_grant_if_unchanged(&entry, b"saved target bytes")
            .expect("save through symlink");

        assert_eq!(fs::read_link(&link).expect("link preserved"), target);
        assert_eq!(
            fs::read(&target).expect("read target"),
            b"saved target bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_respects_restrictive_umask_for_new_files() {
        if std::env::var("RAIOPDF_UMASK_CHILD").as_deref() == Ok("1") {
            atomic_write_respects_restrictive_umask_child();
            return;
        }

        let output = std::process::Command::new(std::env::current_exe().expect("current exe"))
            .env("RAIOPDF_UMASK_CHILD", "1")
            .arg("--exact")
            .arg("tests::atomic_write_respects_restrictive_umask_for_new_files")
            .arg("--nocapture")
            .output()
            .expect("spawn umask child");

        assert!(
            output.status.success(),
            "child failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn atomic_write_respects_restrictive_umask_child() {
        use std::os::unix::fs::PermissionsExt;

        unsafe extern "C" {
            fn umask(mask: u32) -> u32;
        }

        struct UmaskGuard(u32);

        impl Drop for UmaskGuard {
            fn drop(&mut self) {
                unsafe {
                    umask(self.0);
                }
            }
        }

        let _guard = UmaskGuard(unsafe { umask(0o077) });
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("new.pdf");

        atomic_write_file(&path, b"new pdf bytes").expect("atomic write");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_existing_destination_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        fs::write(&path, b"old pdf bytes").expect("write original");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("set mode");

        atomic_write_file(&path, b"new pdf bytes").expect("atomic write");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_copy_preserves_existing_destination_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.pdf");
        let destination = dir.path().join("destination.pdf");
        fs::write(&source, b"source pdf bytes").expect("write source");
        fs::write(&destination, b"old destination bytes").expect("write destination");
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).expect("set mode");

        atomic_copy_file(&source, &destination).expect("atomic copy");

        let mode = fs::metadata(&destination)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_copy_uses_source_permissions_for_new_destination() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.pdf");
        let destination = dir.path().join("destination.pdf");
        fs::write(&source, b"source pdf bytes").expect("write source");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).expect("set mode");

        atomic_copy_file(&source, &destination).expect("atomic copy");

        let mode = fs::metadata(&destination)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn in_place_save_refuses_a_drifted_grant() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        fs::write(&path, b"opened bytes").expect("write original");
        let grants = FileGrants::default();
        let grant = grants.grant(path.clone()).expect("grant should be issued");
        fs::write(&path, b"changed externally after open").expect("external edit");

        let entry = grants
            .resolve_entry(&grant)
            .expect("grant should resolve to entry");
        let error = ensure_grant_file_unchanged(&entry).expect_err("drift should be refused");

        assert_eq!(error, "This file changed on disk — reopen it.");
    }
}
