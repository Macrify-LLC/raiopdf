mod diagnostics;
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
    collections::HashMap,
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{self, Command},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
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

#[derive(Default)]
struct PendingPdfBytes {
    next_token: AtomicU64,
    bytes: Mutex<HashMap<String, Vec<u8>>>,
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
        let mut pending = self.bytes.lock().map_err(|_| "PDF cache lock poisoned")?;
        pending.insert(token.clone(), bytes);
        Ok(token)
    }

    fn remove(&self, token: &str) -> Result<Vec<u8>, String> {
        let mut pending = self.bytes.lock().map_err(|_| "PDF cache lock poisoned")?;
        pending
            .remove(token)
            .ok_or_else(|| "PDF bytes token not found".to_string())
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
        .map_err(|error| format!("Failed to stat PDF at {}: {error}", path.to_string_lossy()))?
        .len();

    // Snapshot BEFORE any read so the grant is minted from exactly this baseline
    // (below threshold: the bytes handed to the WebView; above: the file streamed
    // by range). The file-based engine route (path_ops) trusts that a clean
    // memory document's in-WebView bytes and its on-disk grant file match; an
    // external replace during open would otherwise desync them and let an op
    // process content the user never saw.
    let snapshot_before = snapshot_file(&path).ok();
    let bytes_token = if size_bytes < threshold_bytes {
        let bytes = fs::read(&path).map_err(|error| {
            format!("Failed to read PDF at {}: {error}", path.to_string_lossy())
        })?;
        if let Some(before) = snapshot_before {
            let after = snapshot_file(&path).map_err(|error| {
                format!(
                    "Failed to verify PDF at {}: {error}",
                    path.to_string_lossy()
                )
            })?;
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
            .map_err(|error| format!("Failed to stat file at {}: {error}", path.to_string_lossy()))?
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
        .map_err(|error| format!("Failed to stat file at {}: {error}", path.to_string_lossy()))?
        .len();

    Ok(Some(PickedPdfForWord {
        grant: file_grants.grant(path.clone())?,
        name: file_name(&path),
        size_bytes,
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
    let path = write_pdf_bytes_into_directory(&directory, &file_name, raw_pdf_bytes(&request)?)?;

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
    write_pdf_bytes_atomic(&path, raw_pdf_bytes(&request)?)?;

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
    write_pdf_bytes_atomic_if_unchanged(&entry, raw_pdf_bytes(&request)?)?;

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

fn raw_pdf_bytes<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw PDF bytes".to_string());
    };

    Ok(bytes)
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

fn write_pdf_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_file(path, bytes)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))
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
    atomic_write_new_file(&path, bytes)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;
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
    let path = fs::canonicalize(&entry.path).map_err(|error| {
        format!(
            "Failed to write PDF at {}: {error}",
            entry.path.to_string_lossy()
        )
    })?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let permissions = replacement_permissions(&path, None)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref())
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;
    temp.write_all(bytes)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;
    apply_replacement_permissions(&temp, permissions)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;
    temp.flush()
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;

    let backup = backup_path_for(&path);
    fs::rename(&path, &backup)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))?;

    let result = (|| {
        let backup_entry = FileGrantEntry {
            path: backup.clone(),
            snapshot: entry.snapshot,
        };
        ensure_grant_file_unchanged(&backup_entry)?;
        persist_atomic_file_noclobber(temp, &path)
            .and_then(|_| sync_parent_dir(parent))
            .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))
    })();

    match result {
        Ok(()) => {
            fs::remove_file(&backup).map_err(|error| {
                format!(
                    "Failed to remove old PDF at {}: {error}",
                    backup.to_string_lossy()
                )
            })?;
            Ok(())
        }
        Err(error) => {
            restore_staged_original(&backup, &path).map_err(|restore_error| {
                format!(
                    "{error} Original file could not be restored from {}: {restore_error}",
                    backup.to_string_lossy()
                )
            })?;
            Err(error)
        }
    }
}

fn atomic_copy_grant_if_unchanged(
    entry: &FileGrantEntry,
    destination: &Path,
) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(&entry.path).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    let permissions = replacement_permissions(destination, Some(&entry.path)).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref()).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    io::copy(&mut input, temp.as_file_mut()).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    apply_replacement_permissions(&temp, permissions).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    temp.flush().map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    temp.as_file().sync_all().map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;

    ensure_grant_file_unchanged(entry)?;
    persist_atomic_file(temp, destination)
        .and_then(|_| sync_parent_dir(parent))
        .map_err(|error| {
            format!(
                "Failed to save PDF copy at {}: {error}",
                destination.to_string_lossy()
            )
        })
}

fn atomic_copy_grant_if_unchanged_new(
    entry: &FileGrantEntry,
    destination: &Path,
) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(&entry.path).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    let permissions = replacement_permissions(destination, Some(&entry.path)).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref()).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    io::copy(&mut input, temp.as_file_mut()).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    apply_replacement_permissions(&temp, permissions).map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    temp.flush().map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    temp.as_file().sync_all().map_err(|error| {
        format!(
            "Failed to save PDF copy at {}: {error}",
            destination.to_string_lossy()
        )
    })?;

    ensure_grant_file_unchanged(entry)?;
    persist_atomic_file_noclobber(temp, destination)
        .and_then(|_| sync_parent_dir(parent))
        .map_err(|error| {
            format!(
                "Failed to save PDF copy at {}: {error}",
                destination.to_string_lossy()
            )
        })
}

fn atomic_copy_docx_grant_if_unchanged(
    entry: &FileGrantEntry,
    destination: &Path,
) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut input = fs::File::open(&entry.path).map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    let permissions = replacement_permissions(destination, Some(&entry.path)).map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    let mut temp = replacement_temp_file(parent, permissions.as_ref()).map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    io::copy(&mut input, temp.as_file_mut()).map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    apply_replacement_permissions(&temp, permissions).map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    temp.flush().map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;
    temp.as_file().sync_all().map_err(|error| {
        format!(
            "Failed to save Word document at {}: {error}",
            destination.to_string_lossy()
        )
    })?;

    ensure_grant_file_unchanged(entry)?;
    persist_atomic_file(temp, destination)
        .and_then(|_| sync_parent_dir(parent))
        .map_err(|error| {
            format!(
                "Failed to save Word document at {}: {error}",
                destination.to_string_lossy()
            )
        })
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
    let path = fs::canonicalize(path).map_err(|error| {
        format!(
            "Failed to resolve output folder at {}: {error}",
            path.to_string_lossy()
        )
    })?;
    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "Failed to read output folder at {}: {error}",
            path.to_string_lossy()
        )
    })?;

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
            let diagnostics = AppDiagnostics::new(app_data_dir.clone());
            let _ = diagnostics.capture_pending_crash_for_startup();
            let _ = diagnostics.mark_session_running();
            diagnostics.install_panic_hook();
            let _ = diagnostics.record_shell_event("startup", "RaioPDF shell started");
            let manager = sidecar::SidecarManager::new(sidecar::SidecarConfig::from_env(
                app_data_dir,
                resource_dir,
            ));
            app.manage(manager);
            app.manage(diagnostics);
            app.manage(PendingPdfBytes::default());
            app.manage(FileGrants::default());
            app.manage(DirectoryGrants::default());
            app.manage(StartupPdf::default());
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

            // Grants are in-memory, so every path-op temp dir left behind by a
            // previous run is dead on a fresh start — sweep them all, off the
            // startup path.
            let stale_path_ops_root = app.path().app_data_dir()?.join(path_ops::PATH_OPS_DIR);
            std::thread::spawn(move || path_ops::purge_stale_outputs(&stale_path_ops_root));
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();

            if id == MENU_EXIT {
                let _ = app
                    .state::<AppDiagnostics>()
                    .record_shell_event("shutdown", "menu exit requested");
                let _ = app.state::<AppDiagnostics>().mark_session_clean();
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
            read_pdf_range,
            pick_pdfs_for_add,
            pick_pdf_for_word,
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
        .run(|app_handle, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = event
            {
                if label == "main" {
                    let _ = app_handle
                        .state::<AppDiagnostics>()
                        .record_shell_event("shutdown", "main window destroyed");
                    let _ = app_handle.state::<AppDiagnostics>().mark_session_clean();
                    app_handle.state::<sidecar::SidecarManager>().shutdown();
                }
            }
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
