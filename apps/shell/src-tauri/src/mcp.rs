//! Commands backing the "Open Raio to AI" preference.
//!
//! The enable flag is a single OS/user-scoped file that the standalone
//! `raiopdf-mcp` connector reads on startup (see `apps/mcp/src/gate.ts`). Both
//! sides MUST agree on the location and the "enabled" markers, so this mirrors
//! `gate.ts` exactly: `($XDG_CONFIG_HOME || $APPDATA || ~/.config)/me.macrify.raiopdf/mcp-enabled`.

use std::fs;
use std::io::Write;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::FileGrants;

const FLAG_DIR: &str = "me.macrify.raiopdf";
const FLAG_FILE: &str = "mcp-enabled";
const ENABLED_MARKERS: [&str; 6] = ["1", "true", "enabled", "enable", "on", "yes"];
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

/// What the renderer actually sends: an opaque grant, never a real path. The
/// grant is resolved to a filesystem path only here in Rust, immediately
/// before it's handed to the one-shot subprocess -- the resolved path never
/// crosses back over IPC to the renderer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionSetSourceGrant {
    grant: String,
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilingPacketSource {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
}

/// Renderer-facing counterpart to `FilingPacketSource` -- carries an opaque
/// grant instead of a path. See `ProductionSetSourceGrant` for why.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilingPacketSourceGrant {
    grant: String,
    display_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilingPacketOneShotInput {
    sources: Vec<FilingPacketSource>,
    output_dir: String,
    pack: String,
    layout_mode: String,
    prefix_filenames: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_file_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_envelope_bytes: Option<u64>,
    selected_step_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    split_size_mb: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilingPacketOneShotOutput {
    ok: bool,
    error: Option<ToolError>,
    package_root: Option<String>,
    outputs: Option<Vec<String>>,
    manifest_pdf: Option<String>,
    packet_json: Option<String>,
    combined_pdf: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilingPacketShellOutput {
    package_root: String,
    outputs: Vec<String>,
    manifest_pdf: String,
    packet_json: String,
    combined_pdf: Option<String>,
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
    #[serde(default)]
    signature_invalidated: bool,
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

pub(crate) fn mcp_one_shot_runtime_available(resource_dir: Option<&Path>) -> bool {
    if std::env::var_os("RAIOPDF_MCP_BIN")
        .map(PathBuf::from)
        .is_some_and(|path| path.is_file())
    {
        return true;
    }

    if resolve_mcp_binary().is_none() {
        return false;
    }

    let Some(resource_dir) = resolve_mcp_resource_dir(resource_dir) else {
        return false;
    };
    let node = resource_dir
        .join("payload")
        .join("mcp")
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let entrypoint = resource_dir
        .join("payload")
        .join("mcp")
        .join("app")
        .join("index.mjs");
    node.is_file() && entrypoint.is_file()
}

fn resolve_mcp_resource_dir(app_resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("RAIOPDF_RESOURCE_DIR").map(PathBuf::from) {
        if explicit.join("payload").is_dir() {
            return Some(explicit);
        }
    }

    if let Some(resource_dir) = app_resource_dir {
        if resource_dir.join("payload").is_dir() {
            return Some(resource_dir.to_path_buf());
        }
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))?;

    [
        exe_dir.clone(),
        exe_dir.join("resources"),
        exe_dir.join("resource"),
        exe_dir.join("Resources"),
        exe_dir.join("_up_"),
        exe_dir.join("_up_").join("resources"),
        exe_dir
            .parent()
            .map(|parent| parent.join("Resources"))
            .unwrap_or_else(|| exe_dir.join("..").join("Resources")),
    ]
    .into_iter()
    .find(|candidate| candidate.join("payload").is_dir())
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
    sources: Vec<ProductionSetSourceGrant>,
    output_dir: String,
    prefix: String,
    start: Option<u32>,
    digits: Option<u32>,
    include_filename_in_index: bool,
    include_index: bool,
    combined_pdf: bool,
    volume_size_mb: Option<f64>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<ProductionSetShellOutput, String> {
    let output_dir = resolve_output_dir(&output_dir)?;
    let sources = sources
        .into_iter()
        .map(|source| {
            Ok(ProductionSetSource {
                path: resolve_source_path(&file_grants, &source.grant)?,
                designation: source.designation,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

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
    input_grants: Vec<String>,
    output_dir: String,
    pack_id: Option<String>,
    operations: BatchCleanupOperations,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<BatchCleanupShellOutput, String> {
    let output_dir = resolve_output_dir(&output_dir)?;
    let inputs = input_grants
        .iter()
        .map(|grant| resolve_source_path(&file_grants, grant))
        .collect::<Result<Vec<_>, String>>()?;

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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn build_filing_packet(
    sources: Vec<FilingPacketSourceGrant>,
    output_dir: String,
    pack: String,
    layout_mode: String,
    prefix_filenames: bool,
    max_file_bytes: Option<u64>,
    max_envelope_bytes: Option<u64>,
    selected_step_ids: Vec<String>,
    split_size_mb: Option<f64>,
    file_grants: tauri::State<'_, FileGrants>,
) -> Result<FilingPacketShellOutput, String> {
    let output_dir = resolve_output_dir(&output_dir)?;
    let sources = sources
        .into_iter()
        .map(|source| {
            Ok(FilingPacketSource {
                path: resolve_source_path(&file_grants, &source.grant)?,
                display_name: source.display_name,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let input = FilingPacketOneShotInput {
        sources,
        output_dir,
        pack,
        layout_mode,
        prefix_filenames,
        max_file_bytes,
        max_envelope_bytes,
        selected_step_ids,
        split_size_mb,
    };
    let stdout = run_mcp_one_shot("build_filing_packet", &input)?;
    let output: FilingPacketOneShotOutput = serde_json::from_slice(&stdout)
        .map_err(|error| format!("failed to parse build_filing_packet result: {error}"))?;

    if !output.ok {
        return Err(format_tool_error("build_filing_packet", output.error));
    }

    Ok(FilingPacketShellOutput {
        package_root: output
            .package_root
            .ok_or_else(|| "build_filing_packet result did not include packageRoot".to_string())?,
        outputs: output.outputs.unwrap_or_default(),
        manifest_pdf: output
            .manifest_pdf
            .ok_or_else(|| "build_filing_packet result did not include manifestPdf".to_string())?,
        packet_json: output
            .packet_json
            .ok_or_else(|| "build_filing_packet result did not include packetJson".to_string())?,
        combined_pdf: output.combined_pdf,
    })
}

fn path_to_utf8_string(path: PathBuf, what: &str) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| format!("{what} path is not valid UTF-8"))
}

/// Resolves a renderer-supplied grant to a real filesystem path. The grant
/// registry is the same one backing every other file operation (open, save,
/// range reads) -- an unrecognized or expired grant fails closed rather than
/// falling back to treating the input as a literal path.
fn resolve_source_path(file_grants: &FileGrants, grant: &str) -> Result<String, String> {
    path_to_utf8_string(file_grants.resolve(grant)?, "File grant")
}

/// Validates the output folder in Rust before it's used by any of the
/// one-shot subprocess commands.
///
/// Unlike the other save/export flows that use `validate_output_directory`
/// directly, a fresh (not-yet-existing) package root is a supported input
/// here: `PackageWriter` (`packages/package-writer/src/index.ts`) creates the
/// root and its `upload/`/`raio-manifest/` subdirectories recursively,
/// refusing only an existing *non-empty* root. So rather than requiring the
/// full path to already exist, this walks up to the nearest existing
/// ancestor, validates that ancestor is a real directory, and re-appends
/// whatever trailing segments don't exist yet -- a nonsense path (no existing
/// ancestor at all) still fails fast.
fn resolve_output_dir(output_dir: &str) -> Result<String, String> {
    let path = Path::new(output_dir);

    let mut missing_segments = Vec::new();
    let mut existing_ancestor = path;
    while !existing_ancestor.exists() {
        let name = existing_ancestor.file_name().ok_or_else(|| {
            format!(
                "No existing parent folder found for {}",
                path.to_string_lossy()
            )
        })?;
        missing_segments.push(name.to_os_string());
        existing_ancestor = existing_ancestor.parent().ok_or_else(|| {
            format!(
                "No existing parent folder found for {}",
                path.to_string_lossy()
            )
        })?;
    }

    let mut resolved = crate::validate_output_directory(existing_ancestor)?;
    for segment in missing_segments.into_iter().rev() {
        resolved.push(segment);
    }

    path_to_utf8_string(resolved, "Selected output folder")
}

pub(crate) struct McpOneShotOptions {
    pub timeout: Option<Duration>,
    pub node_options: Option<String>,
}

impl McpOneShotOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            node_options: None,
        }
    }
}

fn run_mcp_one_shot<T: Serialize>(tool_name: &str, input: &T) -> Result<Vec<u8>, String> {
    run_mcp_one_shot_with_options(tool_name, input, McpOneShotOptions::default())
}

pub(crate) fn run_mcp_one_shot_with_options<T: Serialize>(
    tool_name: &str,
    input: &T,
    options: McpOneShotOptions,
) -> Result<Vec<u8>, String> {
    let binary = resolve_mcp_binary().ok_or_else(|| {
        "RaioPDF MCP binary is not configured; set RAIOPDF_MCP_BIN or install the bundled MCP executable."
            .to_string()
    })?;
    let mut command = Command::new(&binary);
    command
        .arg("--disallow-code-generation-from-strings")
        .arg("--one-shot")
        .arg(tool_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(node_options) = options.node_options {
        command.env("NODE_OPTIONS", node_options);
    }
    apply_platform_spawn_flags(&mut command);

    let mut child = command.spawn().map_err(|error| {
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

    let output = wait_with_optional_timeout(child, tool_name, options.timeout)?;

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

fn wait_with_optional_timeout(
    mut child: std::process::Child,
    tool_name: &str,
    timeout: Option<Duration>,
) -> Result<std::process::Output, String> {
    let Some(timeout) = timeout else {
        return child
            .wait_with_output()
            .map_err(|error| format!("failed to read {tool_name} response: {error}"));
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("failed to read {tool_name} response: {error}"));
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let output = child.wait_with_output().map_err(|error| {
                    format!("failed to read timed-out {tool_name} response: {error}")
                })?;
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("{tool_name} timed out after {} seconds", timeout.as_secs())
                } else {
                    format!(
                        "{tool_name} timed out after {} seconds: {stderr}",
                        timeout.as_secs()
                    )
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                return Err(format!("failed to poll {tool_name} response: {error}"));
            }
        }
    }
}

#[cfg(windows)]
fn apply_platform_spawn_flags(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_platform_spawn_flags(_command: &mut Command) {}

fn format_tool_error(tool_name: &str, error: Option<ToolError>) -> String {
    match error {
        Some(error) => match error.action {
            Some(action) => format!("{} {}", error.message, action),
            None => error.message,
        },
        None => format!("{tool_name} failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_output_dir;

    #[test]
    fn accepts_an_output_dir_that_already_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let resolved = resolve_output_dir(dir.path().to_str().expect("utf8 tempdir path"))
            .expect("existing directory should resolve");
        assert_eq!(
            std::path::Path::new(&resolved),
            dir.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn accepts_a_not_yet_created_package_root_under_an_existing_parent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let package_root = dir.path().join("Smith Production Set 001");

        let resolved = resolve_output_dir(package_root.to_str().expect("utf8 path"))
            .expect("a fresh package root under an existing parent should resolve");

        assert_eq!(
            std::path::Path::new(&resolved),
            dir.path()
                .canonicalize()
                .unwrap()
                .join("Smith Production Set 001")
        );
        assert!(
            !package_root.exists(),
            "resolving must not create the directory itself"
        );
    }

    #[test]
    fn accepts_multiple_missing_nested_segments_under_an_existing_ancestor() {
        let dir = tempfile::tempdir().expect("tempdir");
        let package_root = dir.path().join("2026").join("Q3").join("Filing Packet");

        let resolved = resolve_output_dir(package_root.to_str().expect("utf8 path"))
            .expect("nested missing segments under an existing ancestor should resolve");

        assert_eq!(
            std::path::Path::new(&resolved),
            dir.path()
                .canonicalize()
                .unwrap()
                .join("2026")
                .join("Q3")
                .join("Filing Packet")
        );
    }

    #[test]
    fn rejects_an_output_dir_whose_existing_ancestor_is_a_file_not_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file_path = dir.path().join("not-a-folder.txt");
        std::fs::write(&file_path, b"not a folder").expect("write file");
        let package_root = file_path.join("Package");

        let error = resolve_output_dir(package_root.to_str().expect("utf8 path"))
            .expect_err("a file cannot be treated as a folder ancestor");
        assert!(
            error.contains("not a folder") || error.contains("Failed"),
            "{error}"
        );
    }
}
