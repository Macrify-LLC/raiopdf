mod diagnostics;
mod mcp;
mod path_ops;
mod print;
mod range_read;
mod sidecar;

use diagnostics::AppDiagnostics;
use range_read::{
    large_doc_threshold_bytes, range_call_cap_bytes, read_file_range, snapshot_file, FileSnapshot,
    RangeReadError,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process,
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

const HEADER_FILE_GRANT: &str = "x-raio-file-grant";
const HEADER_SUGGESTED_NAME: &str = "x-raio-suggested-name";
const MENU_EVENT: &str = "raiopdf-menu";
const MENU_EXIT: &str = "file:exit";

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

#[derive(Serialize)]
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
struct PickedPdf {
    grant: String,
    name: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedPdfs {
    files: Vec<PickedPdf>,
    threshold_bytes: u64,
}

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
        let grant = Uuid::new_v4().to_string();
        let snapshot = snapshot_file(&path).ok();
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
    require_pdf_extension(&path)?;

    // Stat first: the branch between "materialize bytes" and "stream by
    // range" is decided before any read, so a 283 MB filing never touches
    // the heap on open.
    let threshold_bytes = large_doc_threshold_bytes();
    let size_bytes = fs::metadata(&path)
        .map_err(|error| format!("Failed to stat PDF at {}: {error}", path.to_string_lossy()))?
        .len();

    let bytes_token = if size_bytes < threshold_bytes {
        let bytes = fs::read(&path).map_err(|error| {
            format!("Failed to read PDF at {}: {error}", path.to_string_lossy())
        })?;
        Some(pending_pdf_bytes.insert(bytes)?)
    } else {
        None
    };
    let file_grant = file_grants.grant(path.clone())?;

    Ok(Some(OpenedPdf {
        name: file_name(&path),
        file_grant,
        size_bytes,
        bytes_token,
        threshold_bytes,
    }))
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
        .add_filter("PDF", &["pdf"])
        .blocking_pick_files()
    else {
        return Ok(None);
    };

    let threshold_bytes = large_doc_threshold_bytes();
    let mut files = Vec::with_capacity(paths.len());

    for path in paths {
        let path = path.into_path().map_err(|error| error.to_string())?;
        require_pdf_extension(&path)?;
        let size_bytes = fs::metadata(&path)
            .map_err(|error| format!("Failed to stat PDF at {}: {error}", path.to_string_lossy()))?
            .len();
        files.push(PickedPdf {
            grant: file_grants.grant(path.clone())?,
            name: file_name(&path),
            size_bytes,
        });
    }

    Ok(Some(PickedPdfs {
        files,
        threshold_bytes,
    }))
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
fn resolve_file_grants(
    grants: Vec<String>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<Vec<String>, String> {
    grants
        .into_iter()
        .map(|grant| {
            file_grants
                .resolve(&grant)?
                .into_os_string()
                .into_string()
                .map_err(|_| "File grant path is not valid UTF-8".to_string())
        })
        .collect()
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
    write_pdf_bytes_atomic(&path, request.body())?;

    Ok(Some(saved_pdf(&path, file_grants.inner())?))
}

#[tauri::command]
fn save_pdf_to_path(
    request: tauri::ipc::Request<'_>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<SavedPdf, String> {
    let grant = required_header(&request, HEADER_FILE_GRANT)?;
    let entry = file_grants.resolve_entry(&grant)?;
    write_pdf_bytes_atomic_if_unchanged(&entry, request.body())?;

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

fn write_pdf_bytes_atomic(path: &Path, body: &tauri::ipc::InvokeBody) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("Expected raw PDF bytes".to_string());
    };

    atomic_write_file(path, bytes)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))
}

fn write_pdf_bytes_atomic_if_unchanged(
    entry: &FileGrantEntry,
    body: &tauri::ipc::InvokeBody,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("Expected raw PDF bytes".to_string());
    };

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

fn ensure_pdf_extension(file_name: &str) -> String {
    if file_name.to_ascii_lowercase().ends_with(".pdf") {
        file_name.to_string()
    } else {
        format!("{file_name}.pdf")
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled.pdf")
        .to_string()
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
            app.manage(print::PrintJobs::default());
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
            read_opened_pdf_bytes,
            read_pdf_range,
            pick_pdfs_for_add,
            resolve_file_grants,
            save_pdf_dialog,
            save_pdf_to_path,
            save_pdf_copy_dialog,
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
            print::print_cancel
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
        .text("file:save", "Save")
        .text("file:save-as", "Save As...")
        .separator()
        .text("file:export-pdfa", "Export PDF/A...")
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
