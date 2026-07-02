mod sidecar;

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
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const HEADER_PATH: &str = "x-raio-path";
const HEADER_SUGGESTED_NAME: &str = "x-raio-suggested-name";

#[derive(Default)]
struct PendingPdfBytes {
    next_token: AtomicU64,
    bytes: Mutex<HashMap<String, Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedPdf {
    name: String,
    path: String,
    bytes_token: String,
}

#[derive(Serialize)]
struct SavedPdf {
    name: String,
    path: String,
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

#[tauri::command]
fn open_pdf_dialog(
    app: tauri::AppHandle,
    pending_pdf_bytes: tauri::State<'_, PendingPdfBytes>,
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

    Ok(Some(OpenedPdf {
        name: file_name(&path),
        path: path.to_string_lossy().into_owned(),
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
fn save_pdf_dialog(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
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

    Ok(Some(saved_pdf(&path)))
}

#[tauri::command]
fn save_pdf_to_path(request: tauri::ipc::Request<'_>) -> Result<SavedPdf, String> {
    let path = PathBuf::from(required_header(&request, HEADER_PATH)?);
    write_pdf_bytes(&path, request.body())?;

    Ok(saved_pdf(&path))
}

fn write_pdf_bytes(path: &Path, body: &tauri::ipc::InvokeBody) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("Expected raw PDF bytes".to_string());
    };

    fs::write(path, bytes)
        .map_err(|error| format!("Failed to write PDF at {}: {error}", path.to_string_lossy()))
}

fn saved_pdf(path: &Path) -> SavedPdf {
    SavedPdf {
        name: file_name(path),
        path: path.to_string_lossy().into_owned(),
    }
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
        .setup(|app| {
            let manager = sidecar::SidecarManager::new(sidecar::SidecarConfig::from_env());
            app.manage(manager);
            app.manage(PendingPdfBytes::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_pdf_dialog,
            read_opened_pdf_bytes,
            save_pdf_dialog,
            save_pdf_to_path,
            sidecar::engine_start,
            sidecar::engine_status,
            sidecar::engine_stop
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
                    app_handle.state::<sidecar::SidecarManager>().shutdown();
                }
            }
        });
}
