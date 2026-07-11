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

/// Deadline for the package one-shot commands, scaled by input volume so a
/// legitimately large job never gets cut short while a wedged child can't
/// hang the app forever. `per_file` carries the per-document cost of the
/// heaviest operation the tool can run (OCR dominates batch cleanup; PDF/A
/// conversion dominates filing packets).
fn package_one_shot_timeout(file_count: usize, total_bytes: u64, per_file: Duration) -> Duration {
    const BASE: Duration = Duration::from_secs(600);
    let per_size = Duration::from_secs(15 * total_bytes.div_ceil(50 * 1024 * 1024));
    BASE + per_file * u32::try_from(file_count).unwrap_or(u32::MAX) + per_size
}

fn file_size_or_zero(path: &str) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

/// One-shot children block the calling thread for the whole run, so commands
/// must never execute them inline — a sync `#[tauri::command]` runs on the
/// main/UI thread and would freeze the window for the duration of the job.
async fn run_one_shot_on_blocking_pool<T: Serialize + Send + 'static>(
    tool_name: &'static str,
    input: T,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_mcp_one_shot_with_options(
            tool_name,
            &input,
            McpOneShotOptions {
                timeout: Some(timeout),
                node_options: None,
            },
        )
    })
    .await
    .map_err(|error| format!("RaioPDF's background task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn build_production_set(
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
    let file_count = sources.len();
    let total_bytes = sources
        .iter()
        .map(|source| file_size_or_zero(&source.path))
        .sum();

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
    let timeout = package_one_shot_timeout(file_count, total_bytes, Duration::from_secs(30));
    let stdout = run_one_shot_on_blocking_pool("build_production_set", input, timeout).await?;
    let output: ProductionSetOneShotOutput = serde_json::from_slice(&stdout).map_err(|_| {
        "RaioPDF couldn't finish building that package. Please try again.".to_string()
    })?;

    if !output.ok {
        return Err(format_tool_error("build_production_set", output.error));
    }

    let package_root = output.package_root.ok_or_else(|| {
        "RaioPDF couldn't finish building that package. Please try again.".to_string()
    })?;
    let next_number = output.next_number.ok_or_else(|| {
        "RaioPDF couldn't finish building that package. Please try again.".to_string()
    })?;
    let file_count = output.outputs.as_ref().map_or(0, Vec::len);

    Ok(ProductionSetShellOutput {
        package_root,
        index_location: output.index_pdf,
        next_number,
        file_count,
    })
}

#[tauri::command]
pub async fn batch_cleanup(
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
    let file_count = inputs.len();
    let total_bytes = inputs.iter().map(|path| file_size_or_zero(path)).sum();
    // OCR is the open-ended cost: the toolchain itself allows up to 30 minutes
    // per document, so the deadline must never undercut a legitimate run.
    let per_file = if operations.ocr_mode == "off" {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(1800)
    };

    let input = BatchCleanupOneShotInput {
        inputs,
        output_dir,
        pack_id,
        operations,
    };
    let timeout = package_one_shot_timeout(file_count, total_bytes, per_file);
    let stdout = run_one_shot_on_blocking_pool("batch_cleanup", input, timeout).await?;
    let output: BatchCleanupOneShotOutput = serde_json::from_slice(&stdout).map_err(|_| {
        "RaioPDF couldn't finish building that package. Please try again.".to_string()
    })?;

    if !output.ok {
        return Err(format_tool_error("batch_cleanup", output.error));
    }

    Ok(BatchCleanupShellOutput {
        package_root: output.package_root.ok_or_else(|| {
            "RaioPDF couldn't finish building that package. Please try again.".to_string()
        })?,
        report_pdf: output.report_pdf.ok_or_else(|| {
            "RaioPDF couldn't finish building that package. Please try again.".to_string()
        })?,
        report_json: output.report_json.ok_or_else(|| {
            "RaioPDF couldn't finish building that package. Please try again.".to_string()
        })?,
        files: output.files.unwrap_or_default(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn build_filing_packet(
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
    let file_count = sources.len();
    let total_bytes = sources
        .iter()
        .map(|source| file_size_or_zero(&source.path))
        .sum();

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
    let timeout = package_one_shot_timeout(file_count, total_bytes, Duration::from_secs(120));
    let stdout = run_one_shot_on_blocking_pool("build_filing_packet", input, timeout).await?;
    let output: FilingPacketOneShotOutput = serde_json::from_slice(&stdout).map_err(|_| {
        "RaioPDF couldn't finish building that package. Please try again.".to_string()
    })?;

    if !output.ok {
        return Err(format_tool_error("build_filing_packet", output.error));
    }

    Ok(FilingPacketShellOutput {
        package_root: output.package_root.ok_or_else(|| {
            "RaioPDF couldn't finish building that package. Please try again.".to_string()
        })?,
        outputs: output.outputs.unwrap_or_default(),
        manifest_pdf: output.manifest_pdf.ok_or_else(|| {
            "RaioPDF couldn't finish building that package. Please try again.".to_string()
        })?,
        packet_json: output.packet_json.ok_or_else(|| {
            "RaioPDF couldn't finish building that package. Please try again.".to_string()
        })?,
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

/// Node hardening flag applied to every one-shot child. It MUST travel via
/// `NODE_OPTIONS`: the launcher execs `node <entrypoint> <args...>`, so any
/// flag passed as a command-line argument lands AFTER the entrypoint where
/// Node treats it as an inert script argument — and it shifts the
/// `--one-shot` marker the runtime dispatches on. Passing it positionally
/// shipped in v0.1.0–v0.1.2 and broke every one-shot tool.
pub(crate) const NODE_SECURITY_FLAG: &str = "--disallow-code-generation-from-strings";

/// This spawn choke point is the single owner of the security flag — callers
/// never add it themselves. The ambient-`NODE_OPTIONS` dedup below only guards
/// against a user's own environment already carrying the flag.
fn one_shot_node_options(explicit: Option<String>) -> String {
    let base = explicit.unwrap_or_else(|| match std::env::var("NODE_OPTIONS") {
        Ok(existing) if !existing.trim().is_empty() => existing,
        _ => String::new(),
    });
    if base
        .split_whitespace()
        .any(|flag| flag == NODE_SECURITY_FLAG)
    {
        base
    } else if base.is_empty() {
        NODE_SECURITY_FLAG.to_string()
    } else {
        format!("{base} {NODE_SECURITY_FLAG}")
    }
}

pub(crate) fn run_mcp_one_shot_with_options<T: Serialize>(
    tool_name: &str,
    input: &T,
    options: McpOneShotOptions,
) -> Result<Vec<u8>, String> {
    let binary = resolve_mcp_binary().ok_or_else(|| {
        "RaioPDF's built-in tools are missing. Your installation may be incomplete — reinstall RaioPDF and try again."
            .to_string()
    })?;
    let payload = serde_json::to_vec(input)
        .map_err(|error| format!("failed to encode {tool_name} request: {error}"))?;

    let mut command = Command::new(&binary);
    command
        // `--one-shot <tool>` must be the ONLY arguments, with the marker
        // first — see `NODE_SECURITY_FLAG` for why nothing may precede it.
        .args(["--one-shot", tool_name])
        .env("NODE_OPTIONS", one_shot_node_options(options.node_options))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_platform_spawn_flags(&mut command);

    let child = command.spawn().map_err(|_| {
        "RaioPDF couldn't start its built-in tools. Reinstall RaioPDF and try again.".to_string()
    })?;

    let output = run_one_shot_child(child, payload, tool_name, options.timeout)?;

    if !output.status.success() {
        return Err(sanitize_one_shot_failure(&output.stderr));
    }

    Ok(output.stdout)
}

/// On a tool failure the one-shot MCP runtime writes a structured
/// `{ "ok": false, "error": { "code", "message", "action" } }` blob to stderr
/// (see apps/mcp `runOneShot` → `toolError`). Many of those failures are
/// user-correctable — a non-empty output folder, an unwritable destination — so
/// surfacing only a generic "please try again" strips the actionable guidance
/// and the retry can't succeed. Recover the child's `error.message` (which the
/// UI's `formatWorkflowError` then maps to friendly text) and fall back to the
/// generic line only when stderr isn't the expected shape.
fn sanitize_one_shot_failure(stderr: &[u8]) -> String {
    const GENERIC: &str = "RaioPDF couldn't complete that operation. Please try again.";
    let Ok(text) = std::str::from_utf8(stderr) else {
        return GENERIC.to_string();
    };
    // The structured payload is a single JSON line, but tolerate leading Node
    // warnings by scanning for the last line that parses with an error message.
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
        {
            return message.to_string();
        }
    }
    GENERIC.to_string()
}

struct OneShotChildOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Drives a spawned one-shot child to completion. The request payload is
/// written from a dedicated thread and stdout/stderr are drained concurrently
/// so neither side can deadlock on a full pipe (a large request plus a chatty
/// child would otherwise block both processes forever), then the optional
/// deadline is enforced against the whole tree.
fn run_one_shot_child(
    mut child: std::process::Child,
    payload: Vec<u8>,
    tool_name: &str,
    timeout: Option<Duration>,
) -> Result<OneShotChildOutput, String> {
    use std::io::Read;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open RaioPDF MCP stdin".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open RaioPDF MCP stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open RaioPDF MCP stderr".to_string())?;

    // Write errors are intentionally ignored: a child that exits before
    // consuming the payload surfaces through its exit status, not the broken
    // pipe. Dropping stdin at thread end delivers EOF.
    let stdin_writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
    });
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if let Some(timeout) = timeout {
                    if started.elapsed() >= timeout {
                        kill_child_tree(&mut child);
                        let _ = child.wait();
                        join_io(stdin_writer, stdout_reader, stderr_reader);
                        return Err(
                            "That took too long and was stopped. Try again, or with fewer or smaller files."
                                .to_string(),
                        );
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                kill_child_tree(&mut child);
                let _ = child.wait();
                join_io(stdin_writer, stdout_reader, stderr_reader);
                return Err(format!("failed to poll {tool_name} response: {error}"));
            }
        }
    };

    let (stdout, stderr) = join_io(stdin_writer, stdout_reader, stderr_reader);
    Ok(OneShotChildOutput {
        status,
        stdout,
        stderr,
    })
}

fn join_io(
    stdin_writer: std::thread::JoinHandle<()>,
    stdout_reader: std::thread::JoinHandle<Vec<u8>>,
    stderr_reader: std::thread::JoinHandle<Vec<u8>>,
) -> (Vec<u8>, Vec<u8>) {
    let _ = stdin_writer.join();
    (
        stdout_reader.join().unwrap_or_default(),
        stderr_reader.join().unwrap_or_default(),
    )
}

/// The Node one-shot spawns its own helpers (qpdf, Ghostscript, the engine
/// host); killing only the direct child would orphan them with open handles
/// inside the work dir, so take the whole tree down.
#[cfg(windows)]
fn kill_child_tree(child: &mut std::process::Child) {
    let pid = child.id().to_string();
    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid, "/T", "/F"]);
    apply_platform_spawn_flags(&mut command);
    let _ = command.output();
    let _ = child.kill();
}

#[cfg(not(windows))]
fn kill_child_tree(child: &mut std::process::Child) {
    let _ = child.kill();
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
    use super::{
        one_shot_node_options, package_one_shot_timeout, resolve_output_dir,
        sanitize_one_shot_failure, NODE_SECURITY_FLAG,
    };
    use std::time::Duration;

    const GENERIC_FAILURE: &str = "RaioPDF couldn't complete that operation. Please try again.";

    #[test]
    fn node_security_flag_travels_via_node_options() {
        assert_eq!(one_shot_node_options(None), NODE_SECURITY_FLAG);
        assert_eq!(
            one_shot_node_options(Some("--max-old-space-size=8192".to_string())),
            format!("--max-old-space-size=8192 {NODE_SECURITY_FLAG}")
        );
        // An ambient NODE_OPTIONS that already carries the flag isn't doubled.
        let ambient = format!("--max-old-space-size=8192 {NODE_SECURITY_FLAG}");
        assert_eq!(one_shot_node_options(Some(ambient.clone())), ambient);
    }

    #[test]
    fn package_timeout_scales_with_files_and_bytes() {
        let base = package_one_shot_timeout(0, 0, Duration::from_secs(30));
        assert_eq!(base, Duration::from_secs(600));
        let scaled = package_one_shot_timeout(4, 120 * 1024 * 1024, Duration::from_secs(30));
        // 600 base + 4×30 per-file + 3 chunks × 15s.
        assert_eq!(scaled, Duration::from_secs(600 + 120 + 45));
    }

    #[test]
    fn recovers_the_structured_child_error_message() {
        let stderr = br#"{"ok":false,"error":{"code":"ENGINE_ERROR","message":"Refusing to create a package in non-empty directory /out.","action":"Confirm RaioPDF's engine payload is installed and try again."}}"#;
        assert_eq!(
            sanitize_one_shot_failure(stderr),
            "Refusing to create a package in non-empty directory /out."
        );
    }

    #[test]
    fn skips_leading_node_warnings_before_the_json_line() {
        let stderr = b"(node:123) ExperimentalWarning: something\n{\"ok\":false,\"error\":{\"code\":\"PATH_POLICY\",\"message\":\"Output folder is not writable.\"}}\n";
        assert_eq!(
            sanitize_one_shot_failure(stderr),
            "Output folder is not writable."
        );
    }

    #[test]
    fn falls_back_to_generic_when_stderr_is_not_structured() {
        assert_eq!(sanitize_one_shot_failure(b""), GENERIC_FAILURE);
        assert_eq!(
            sanitize_one_shot_failure(b"segfault: core dumped"),
            GENERIC_FAILURE
        );
        assert_eq!(
            sanitize_one_shot_failure(br#"{"ok":false,"error":{"code":"ENGINE_ERROR"}}"#),
            GENERIC_FAILURE
        );
    }

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
