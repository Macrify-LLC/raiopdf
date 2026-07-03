//! Commands backing the "Open Raio to AI" preference.
//!
//! The enable flag is a single OS/user-scoped file that the standalone
//! `raiopdf-mcp` connector reads on startup (see `apps/mcp/src/gate.ts`). Both
//! sides MUST agree on the location and the "enabled" markers, so this mirrors
//! `gate.ts` exactly: `($XDG_CONFIG_HOME || $APPDATA || ~/.config)/me.macrify.raiopdf/mcp-enabled`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

const FLAG_DIR: &str = "me.macrify.raiopdf";
const FLAG_FILE: &str = "mcp-enabled";
const ENABLED_MARKERS: [&str; 6] = ["1", "true", "enabled", "enable", "on", "yes"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    enabled: bool,
    path: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionSetSource {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    designation: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionSetOneShotInput {
    sources: Vec<ProductionSetSource>,
    output_dir: String,
    prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    digits: Option<u32>,
    include_filename_in_index: bool,
    include_index: bool,
    combined_pdf: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    volume_size_mb: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductionSetOneShotOutput {
    ok: bool,
    error: Option<ToolError>,
    package_root: Option<String>,
    outputs: Option<Vec<String>>,
    next_number: Option<u32>,
    index_pdf: Option<String>,
}

#[derive(Deserialize)]
struct ToolError {
    message: String,
    action: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionSetShellOutput {
    package_root: String,
    index_location: Option<String>,
    next_number: u32,
    file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchCleanupOneShotInput {
    inputs: Vec<String>,
    output_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pack_id: Option<String>,
    operations: BatchCleanupOperations,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCleanupOperations {
    ocr_mode: String,
    compress: bool,
    sanitize: bool,
    scrub_metadata: bool,
    repair: bool,
    split_by_size: bool,
    split_size_mb: f64,
    normalize_pages: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchCleanupOneShotOutput {
    ok: bool,
    error: Option<ToolError>,
    package_root: Option<String>,
    report_pdf: Option<String>,
    report_json: Option<String>,
    files: Option<Vec<BatchCleanupFileOutput>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCleanupFileOutput {
    source_filename: String,
    status: String,
    reason: Option<String>,
    outputs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCleanupShellOutput {
    package_root: String,
    report_pdf: String,
    report_json: String,
    files: Vec<BatchCleanupFileOutput>,
}

fn config_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("APPDATA") {
        return PathBuf::from(dir);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".config");
    }
    std::env::temp_dir()
}

fn flag_path() -> PathBuf {
    config_root().join(FLAG_DIR).join(FLAG_FILE)
}

fn is_enabled() -> bool {
    match fs::read_to_string(flag_path()) {
        Ok(contents) => ENABLED_MARKERS.contains(&contents.trim().to_ascii_lowercase().as_str()),
        Err(_) => false,
    }
}

fn resolve_mcp_binary() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("RAIOPDF_MCP_BIN").map(PathBuf::from) {
        return explicit.exists().then_some(explicit);
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))?;
    let binary = if cfg!(windows) {
        "raiopdf-mcp.exe"
    } else {
        "raiopdf-mcp"
    };

    [
        exe_dir.join(binary),
        exe_dir.join("resources").join(binary),
        exe_dir.join("binaries").join(binary),
    ]
    .into_iter()
    .find(|candidate| candidate.exists())
}

#[tauri::command]
pub fn mcp_status() -> McpStatus {
    McpStatus {
        enabled: is_enabled(),
        path: resolve_mcp_binary().map(|path| path.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn mcp_set_enabled(enabled: bool) -> Result<(), String> {
    let path = flag_path();

    if enabled {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create MCP config directory: {error}"))?;
        }
        fs::write(&path, "enabled\n")
            .map_err(|error| format!("failed to enable RaioPDF MCP: {error}"))?;
    } else {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to disable RaioPDF MCP: {error}")),
        }
    }

    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn build_production_set(
    sources: Vec<ProductionSetSource>,
    output_dir: String,
    prefix: String,
    start: Option<u32>,
    digits: Option<u32>,
    include_filename_in_index: bool,
    include_index: bool,
    combined_pdf: bool,
    volume_size_mb: Option<f64>,
) -> Result<ProductionSetShellOutput, String> {
    let input = ProductionSetOneShotInput {
        sources,
        output_dir,
        prefix,
        start,
        digits,
        include_filename_in_index,
        include_index,
        combined_pdf,
        volume_size_mb,
    };
    let stdout = run_mcp_one_shot("build_production_set", &input)?;
    let output: ProductionSetOneShotOutput = serde_json::from_slice(&stdout)
        .map_err(|error| format!("failed to parse build_production_set result: {error}"))?;

    if !output.ok {
        return Err(format_tool_error("build_production_set", output.error));
    }

    let package_root = output
        .package_root
        .ok_or_else(|| "build_production_set result did not include packageRoot".to_string())?;
    let next_number = output
        .next_number
        .ok_or_else(|| "build_production_set result did not include nextNumber".to_string())?;
    let file_count = output.outputs.as_ref().map_or(0, Vec::len);

    Ok(ProductionSetShellOutput {
        package_root,
        index_location: output.index_pdf,
        next_number,
        file_count,
    })
}

#[tauri::command]
pub fn batch_cleanup(
    inputs: Vec<String>,
    output_dir: String,
    pack_id: Option<String>,
    operations: BatchCleanupOperations,
) -> Result<BatchCleanupShellOutput, String> {
    let input = BatchCleanupOneShotInput {
        inputs,
        output_dir,
        pack_id,
        operations,
    };
    let stdout = run_mcp_one_shot("batch_cleanup", &input)?;
    let output: BatchCleanupOneShotOutput = serde_json::from_slice(&stdout)
        .map_err(|error| format!("failed to parse batch_cleanup result: {error}"))?;

    if !output.ok {
        return Err(format_tool_error("batch_cleanup", output.error));
    }

    Ok(BatchCleanupShellOutput {
        package_root: output
            .package_root
            .ok_or_else(|| "batch_cleanup result did not include packageRoot".to_string())?,
        report_pdf: output
            .report_pdf
            .ok_or_else(|| "batch_cleanup result did not include reportPdf".to_string())?,
        report_json: output
            .report_json
            .ok_or_else(|| "batch_cleanup result did not include reportJson".to_string())?,
        files: output.files.unwrap_or_default(),
    })
}

fn run_mcp_one_shot<T: Serialize>(tool_name: &str, input: &T) -> Result<Vec<u8>, String> {
    let binary = resolve_mcp_binary().ok_or_else(|| {
        "RaioPDF MCP binary is not configured; set RAIOPDF_MCP_BIN or install the bundled MCP executable."
            .to_string()
    })?;
    let mut child = Command::new(&binary)
        .arg("--one-shot")
        .arg(tool_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to launch RaioPDF MCP at {}: {error}",
                binary.to_string_lossy()
            )
        })?;

    let payload = serde_json::to_vec(input)
        .map_err(|error| format!("failed to encode {tool_name} request: {error}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open RaioPDF MCP stdin".to_string())?;
        stdin
            .write_all(&payload)
            .map_err(|error| format!("failed to send {tool_name} request: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to read {tool_name} response: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{tool_name} failed with status {}", output.status)
        } else {
            stderr
        });
    }

    Ok(output.stdout)
}

fn format_tool_error(tool_name: &str, error: Option<ToolError>) -> String {
    match error {
        Some(error) => match error.action {
            Some(action) => format!("{} {}", error.message, action),
            None => error.message,
        },
        None => format!("{tool_name} failed"),
    }
}
