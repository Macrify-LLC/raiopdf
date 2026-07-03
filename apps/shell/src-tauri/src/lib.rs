mod diagnostics;
mod mcp;
mod sidecar;

use diagnostics::AppDiagnostics;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
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

#[derive(Default)]
struct FileGrants {
    paths: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedPdf {
    name: String,
    file_grant: String,
    bytes_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPdf {
    name: String,
    file_grant: String,
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
    fn grant(&self, path: PathBuf) -> Result<String, String> {
        let grant = Uuid::new_v4().to_string();
        let mut paths = self.paths.lock().map_err(|_| "File grant lock poisoned")?;
        paths.insert(grant.clone(), path);
        Ok(grant)
    }

    fn resolve(&self, grant: &str) -> Result<PathBuf, String> {
        let paths = self.paths.lock().map_err(|_| "File grant lock poisoned")?;
        paths
            .get(grant)
            .cloned()
            .ok_or_else(|| "File grant not found".to_string())
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

    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read PDF at {}: {error}", path.to_string_lossy()))?;
    let bytes_token = pending_pdf_bytes.insert(bytes)?;
    let file_grant = file_grants.grant(path.clone())?;

    Ok(Some(OpenedPdf {
        name: file_name(&path),
        file_grant,
        bytes_token,
    }))
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
    write_pdf_bytes(&path, request.body())?;

    Ok(Some(saved_pdf(&path, file_grants.inner())?))
}

#[tauri::command]
fn save_pdf_to_path(
    request: tauri::ipc::Request<'_>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<SavedPdf, String> {
    let grant = required_header(&request, HEADER_FILE_GRANT)?;
    let path = file_grants.resolve(&grant)?;
    write_pdf_bytes(&path, request.body())?;

    saved_pdf(&path, file_grants.inner())
}

fn write_pdf_bytes(path: &Path, body: &tauri::ipc::InvokeBody) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("Expected raw PDF bytes".to_string());
    };

    fs::write(path, bytes)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))
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
            resolve_file_grants,
            save_pdf_dialog,
            save_pdf_to_path,
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
            mcp::build_filing_packet
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

    MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&view)
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
}
