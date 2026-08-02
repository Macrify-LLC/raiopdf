//! Commands backing the "Open Raio to AI" preference.
//!
//! The enable flag is a single OS/user-scoped file that the standalone
//! `raiopdf-mcp` connector reads on startup (see `apps/mcp/src/gate.ts`). Both
//! sides MUST agree on the location and the "enabled" markers, so this mirrors
//! `gate.ts` exactly: `($XDG_CONFIG_HOME || $APPDATA || ~/.config)/me.macrify.raiopdf/mcp-enabled`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{DirectoryGrants, FileGrants};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    designation_pages: Option<String>,
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
    #[serde(default)]
    designation_pages: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionSetContinuationOverride {
    reason: String,
}

/// Mirrors `packages/production-set`'s `PdfStampPlacement` (via
/// `@raiopdf/engine-api`) over the Node one-shot JSON boundary. Same shape as
/// `path_ops::BinderStampPlacement` -- kept as its own type rather than
/// shared because the two one-shot input structs are otherwise unrelated.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionSetStampPlacement {
    edge: String,
    align: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    bates_placement: Option<ProductionSetStampPlacement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    designation_placement: Option<ProductionSetStampPlacement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stamp_font_size_pt: Option<f64>,
    /// Absolute root of a prior production package to continue the same
    /// Bates series from -- resolved from a directory grant by
    /// `build_production_set` before this is constructed; see
    /// `resolve_source_path` for why the shell never accepts a raw path from
    /// the renderer.
    #[serde(skip_serializing_if = "Option::is_none")]
    continue_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    continuation_override: Option<ProductionSetContinuationOverride>,
}

/// Mirrors `packages/production-set`'s `ProductionSetResult.continuation`
/// (via the Node one-shot JSON boundary) and is re-serialized straight back
/// to the renderer on `ProductionSetShellOutput.continuation`.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProductionSetContinuationResult {
    mode: String,
    prior_last_bates: String,
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
    #[serde(default)]
    continuation: Option<ProductionSetContinuationResult>,
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
    continuation: Option<ProductionSetContinuationResult>,
}

/// UI-prefill summary from `read_production_continuation` -- see its doc
/// comment for the verification this represents. Mirrors
/// `packages/production-set`'s `ProductionContinuationSummary`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProductionContinuationSummary {
    prefix: String,
    digits: i64,
    next_number: i64,
    last_bates: String,
    created_at: String,
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
    let payload_dir = resource_dir.join("payload");
    let node = engine_sidecar_core::runtime::find_payload_tool(
        &payload_dir,
        engine_sidecar_core::runtime::PayloadTool::Node,
        engine_sidecar_core::runtime::RuntimePlatform::current(),
    );
    let entrypoint = resource_dir
        .join("payload")
        .join("mcp")
        .join("app")
        .join("index.mjs");
    node.is_some() && entrypoint.is_file()
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

/// Per-file allowance for jobs that can run OCR — matches the OCR toolchain's
/// own 30-minute-per-document ceiling so the deadline never undercuts a
/// legitimate run.
const OCR_PER_FILE_TIMEOUT: Duration = Duration::from_secs(1800);

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

// ---- Bates continuation ----
//
// `read_production_continuation` is a fast, synchronous (well, blocking-pool)
// prefill read for the UI form: given a directory grant for a prior
// production package, it parses that package's `raio-manifest/manifest.json`
// and `raio-manifest/production.json` with serde (tolerant -- only the
// fields below are declared, so extra fields in either file are ignored) and
// re-does the cheap verifications. It does NOT spawn the Node one-shot; the
// authoritative check still happens inside `buildProductionSet`
// (`packages/production-set`) at build time via `continueFrom`, which this
// command's caller is expected to also pass through.

const PACKAGE_MANIFEST_RELATIVE: &str = "raio-manifest/manifest.json";
const PRODUCTION_REPORT_RELATIVE: &str = "raio-manifest/production.json";
const PRODUCTION_REPORT_NAME: &str = "production.json";
const NOT_A_PACKAGE_MESSAGE: &str = "This folder doesn't look like a RaioPDF production package.";
const TAMPERED_MESSAGE: &str =
    "This production's Bates report doesn't match the package manifest -- the folder may have \
     changed since it was produced. Verify against the served copy before continuing.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestProvenanceForContinuation {
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestMachineReportEntry {
    name: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifestForContinuation {
    provenance: ManifestProvenanceForContinuation,
    machine_reports: Vec<ManifestMachineReportEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductionReportFile {
    bates_start: String,
    bates_end: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductionReport {
    prefix: String,
    digits: i64,
    first_number: i64,
    last_number: i64,
    next_number: i64,
    files: Vec<ProductionReportFile>,
}

#[tauri::command]
pub async fn read_production_continuation(
    directory_grant: String,
    directory_grants: tauri::State<'_, DirectoryGrants>,
) -> Result<ProductionContinuationSummary, String> {
    let root = directory_grants.resolve(&directory_grant)?;
    crate::on_command_blocking_pool(move || read_production_continuation_sync(&root)).await
}

fn read_production_continuation_sync(root: &Path) -> Result<ProductionContinuationSummary, String> {
    let metadata = fs::metadata(root).map_err(|_| NOT_A_PACKAGE_MESSAGE.to_string())?;
    if !metadata.is_dir() {
        return Err("Selected item is not a folder.".to_string());
    }

    let manifest_bytes = fs::read(root.join(PACKAGE_MANIFEST_RELATIVE))
        .map_err(|_| NOT_A_PACKAGE_MESSAGE.to_string())?;
    let manifest: PackageManifestForContinuation =
        serde_json::from_slice(&manifest_bytes).map_err(|_| NOT_A_PACKAGE_MESSAGE.to_string())?;

    let report_entry = manifest
        .machine_reports
        .iter()
        .find(|entry| entry.name == PRODUCTION_REPORT_NAME)
        .ok_or_else(|| {
            "This folder doesn't look like a RaioPDF production package -- it has no Bates \
             continuation report."
                .to_string()
        })?;

    let report_bytes = fs::read(root.join(PRODUCTION_REPORT_RELATIVE)).map_err(|_| {
        "This production's Bates report is missing, even though the package manifest lists it. \
         Verify against the served copy before continuing."
            .to_string()
    })?;

    if sha256_hex(&report_bytes) != report_entry.sha256 {
        return Err(TAMPERED_MESSAGE.to_string());
    }

    let report: ProductionReport = serde_json::from_slice(&report_bytes)
        .map_err(|_| "This production's Bates report could not be read.".to_string())?;

    verify_and_summarize_continuation(&report, manifest.provenance.created_at)
}

/// Re-does the numbering checks `packages/production-set`'s
/// `readProductionContinuation` performs: contiguous, non-overlapping file
/// ranges consistent with the report's own prefix/digit width, and
/// `lastNumber + 1 == nextNumber`.
fn verify_and_summarize_continuation(
    report: &ProductionReport,
    created_at: String,
) -> Result<ProductionContinuationSummary, String> {
    if report.digits < 1 {
        return Err("This production's Bates report has an invalid digit width.".to_string());
    }
    if report.first_number < 0 || report.next_number < 0 {
        return Err("This production's Bates report has an invalid numbering field.".to_string());
    }
    if report.last_number + 1 != report.next_number {
        return Err(
            "This production's Bates report numbering is inconsistent -- its last and next \
             numbers don't line up."
                .to_string(),
        );
    }

    let digits = usize::try_from(report.digits)
        .map_err(|_| "This production's Bates report has an invalid digit width.".to_string())?;
    let mut previous_end: Option<i64> = None;

    for (index, file) in report.files.iter().enumerate() {
        let start = parse_bates_number(&file.bates_start, &report.prefix, digits, index, "start")?;
        let end = parse_bates_number(&file.bates_end, &report.prefix, digits, index, "end")?;
        if end < start {
            return Err(format!(
                "This production's Bates report has an invalid range at file {}.",
                index + 1
            ));
        }

        match previous_end {
            None if start != report.first_number => {
                return Err(
                    "This production's Bates report's first file doesn't match its recorded first \
                     number."
                        .to_string(),
                );
            }
            Some(previous_end_value) if start != previous_end_value + 1 => {
                return Err(format!(
                    "This production's Bates report has a gap or overlap between files {index} and {}.",
                    index + 1
                ));
            }
            _ => {}
        }

        previous_end = Some(end);
    }

    match previous_end {
        None if report.last_number != report.first_number - 1 => {
            return Err("This production's Bates report numbering is inconsistent.".to_string());
        }
        Some(last_end) if last_end != report.last_number => {
            return Err(
                "This production's Bates report's last file doesn't match its recorded last number."
                    .to_string(),
            );
        }
        _ => {}
    }

    Ok(ProductionContinuationSummary {
        prefix: report.prefix.clone(),
        digits: report.digits,
        next_number: report.next_number,
        last_bates: format_bates(&report.prefix, report.last_number, digits),
        created_at,
        file_count: report.files.len(),
    })
}

/// Also doubles as the "digits/prefix consistent across rows" check: a row
/// whose Bates string doesn't start with the report's own prefix, or whose
/// numeric tail isn't exactly `digits` zero-padded digits, fails here.
fn parse_bates_number(
    value: &str,
    prefix: &str,
    digits: usize,
    index: usize,
    which: &str,
) -> Result<i64, String> {
    let Some(numeric) = value.strip_prefix(prefix) else {
        return Err(format!(
            "This production's Bates report has a {which} number at file {} that doesn't match its \
             prefix.",
            index + 1
        ));
    };
    if numeric.len() != digits || !numeric.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "This production's Bates report has a {which} number at file {} that doesn't match its \
             digit width.",
            index + 1
        ));
    }
    numeric.parse::<i64>().map_err(|_| {
        format!(
            "This production's Bates report has an invalid {which} number at file {}.",
            index + 1
        )
    })
}

fn format_bates(prefix: &str, value: i64, digits: usize) -> String {
    format!("{prefix}{value:0digits$}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    bates_placement: Option<ProductionSetStampPlacement>,
    designation_placement: Option<ProductionSetStampPlacement>,
    stamp_font_size_pt: Option<f64>,
    // Directory grant for a prior production package to continue the same
    // Bates series from -- never a raw path from the renderer, same
    // discipline as every source grant here. Resolved to a path below,
    // immediately before it's handed to the one-shot subprocess.
    continue_from: Option<String>,
    continuation_override_reason: Option<String>,
    file_grants: tauri::State<'_, FileGrants>,
    directory_grants: tauri::State<'_, DirectoryGrants>,
) -> Result<ProductionSetShellOutput, String> {
    let output_dir = resolve_output_dir(&output_dir)?;
    let sources = sources
        .into_iter()
        .map(|source| {
            Ok(ProductionSetSource {
                path: resolve_source_path(&file_grants, &source.grant)?,
                designation: source.designation,
                designation_pages: source.designation_pages,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let file_count = sources.len();
    let total_bytes = sources
        .iter()
        .map(|source| file_size_or_zero(&source.path))
        .sum();
    let continue_from = match continue_from {
        Some(grant) => Some(path_to_utf8_string(
            directory_grants.resolve(&grant)?,
            "Prior production folder",
        )?),
        None => None,
    };

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
        bates_placement,
        designation_placement,
        stamp_font_size_pt,
        continue_from,
        continuation_override: continuation_override_reason
            .map(|reason| ProductionSetContinuationOverride { reason }),
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
        continuation: output.continuation,
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
        OCR_PER_FILE_TIMEOUT
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
    // The make-searchable step runs OCR on every source, so it gets the
    // OCR-sized per-file budget; otherwise PDF/A conversion dominates.
    let per_file = if input
        .selected_step_ids
        .iter()
        .any(|id| id == "make-searchable")
    {
        OCR_PER_FILE_TIMEOUT
    } else {
        Duration::from_secs(120)
    };
    let timeout = package_one_shot_timeout(file_count, total_bytes, per_file);
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
    engine_sidecar_core::configure_child_process(&mut command);

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
fn kill_child_tree(child: &mut std::process::Child) {
    engine_sidecar_core::kill_process_tree(child);
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

#[cfg(test)]
mod tests {
    use super::{
        one_shot_node_options, package_one_shot_timeout, read_production_continuation_sync,
        resolve_output_dir, sanitize_one_shot_failure, sha256_hex, ProductionSetSource,
        ProductionSetSourceGrant, ProductionSetStampPlacement, NODE_SECURITY_FLAG,
    };
    use std::fs;
    use std::time::Duration;

    const GENERIC_FAILURE: &str = "RaioPDF couldn't complete that operation. Please try again.";

    /// Builds a well-formed production package fixture: `raio-manifest/production.json`
    /// plus a `manifest.json` whose `machineReports` entry hashes to match, so
    /// individual tests can mutate ONE side (the report content, or the recorded
    /// hash) and isolate which verification step fails.
    fn write_continuation_fixture(root: &std::path::Path, report_json: &str, created_at: &str) {
        let manifest_dir = root.join("raio-manifest");
        fs::create_dir_all(&manifest_dir).expect("create raio-manifest dir");
        let report_bytes = report_json.as_bytes();
        fs::write(manifest_dir.join("production.json"), report_bytes)
            .expect("write production.json");
        let sha256 = sha256_hex(report_bytes);
        let manifest_json = format!(
            r#"{{
  "manifestVersion": 1,
  "provenance": {{ "appVersion": "0.1.0", "createdAt": "{created_at}", "confirmCurrentRequirements": "x" }},
  "uploadFiles": [],
  "rootDocuments": [],
  "machineReports": [
    {{ "name": "production.json", "relativePath": "raio-manifest/production.json", "bytes": {}, "sha256": "{sha256}" }}
  ],
  "overrides": [],
  "checks": [],
  "details": {{}}
}}"#,
            report_bytes.len(),
        );
        fs::write(manifest_dir.join("manifest.json"), manifest_json).expect("write manifest.json");
    }

    const VALID_REPORT: &str = r#"{
  "prefix": "SMITH",
  "digits": 6,
  "firstNumber": 1,
  "lastNumber": 5,
  "nextNumber": 6,
  "files": [
    { "batesStart": "SMITH000001", "batesEnd": "SMITH000003" },
    { "batesStart": "SMITH000004", "batesEnd": "SMITH000005" }
  ]
}"#;

    #[test]
    fn reads_and_verifies_a_well_formed_continuation_report() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_continuation_fixture(dir.path(), VALID_REPORT, "2026-07-14T10:00:00.000Z");

        let summary = read_production_continuation_sync(dir.path()).expect("valid fixture reads");
        assert_eq!(summary.prefix, "SMITH");
        assert_eq!(summary.digits, 6);
        assert_eq!(summary.next_number, 6);
        assert_eq!(summary.last_bates, "SMITH000005");
        assert_eq!(summary.created_at, "2026-07-14T10:00:00.000Z");
        assert_eq!(summary.file_count, 2);
    }

    #[test]
    fn rejects_a_folder_with_no_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let error = read_production_continuation_sync(dir.path()).expect_err("no manifest");
        assert!(
            error.contains("doesn't look like a RaioPDF production package"),
            "{error}"
        );
    }

    #[test]
    fn rejects_a_grant_that_is_not_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file_path = dir.path().join("not-a-folder.txt");
        fs::write(&file_path, b"not a folder").expect("write file");

        let error = read_production_continuation_sync(&file_path).expect_err("not a directory");
        assert_eq!(error, "Selected item is not a folder.");
    }

    #[test]
    fn rejects_a_report_edited_after_the_manifest_recorded_its_hash() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_continuation_fixture(dir.path(), VALID_REPORT, "2026-07-14T10:00:00.000Z");
        // Edit the report bytes on disk WITHOUT touching the manifest's recorded
        // hash -- exactly what a hand-edited package looks like.
        fs::write(
            dir.path().join("raio-manifest").join("production.json"),
            VALID_REPORT.replace("\"nextNumber\": 6", "\"nextNumber\": 999"),
        )
        .expect("tamper with report");

        let error = read_production_continuation_sync(dir.path()).expect_err("tampered report");
        assert!(
            error.contains("doesn't match the package manifest"),
            "{error}"
        );
    }

    #[test]
    fn rejects_overlapping_bates_ranges() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = r#"{
  "prefix": "OVLP",
  "digits": 6,
  "firstNumber": 1,
  "lastNumber": 2,
  "nextNumber": 3,
  "files": [
    { "batesStart": "OVLP000001", "batesEnd": "OVLP000002" },
    { "batesStart": "OVLP000002", "batesEnd": "OVLP000003" }
  ]
}"#;
        write_continuation_fixture(dir.path(), report, "2026-07-14T10:00:00.000Z");

        let error = read_production_continuation_sync(dir.path()).expect_err("overlapping ranges");
        assert!(error.contains("gap or overlap"), "{error}");
    }

    #[test]
    fn rejects_a_last_number_next_number_mismatch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = VALID_REPORT.replace("\"nextNumber\": 6", "\"nextNumber\": 12");
        write_continuation_fixture(dir.path(), &report, "2026-07-14T10:00:00.000Z");

        let error = read_production_continuation_sync(dir.path())
            .expect_err("lastNumber/nextNumber mismatch");
        assert!(error.contains("don't line up"), "{error}");
    }

    #[test]
    fn rejects_a_prefix_that_does_not_match_a_bates_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = VALID_REPORT.replace(
            "\"batesStart\": \"SMITH000001\"",
            "\"batesStart\": \"JONES000001\"",
        );
        write_continuation_fixture(dir.path(), &report, "2026-07-14T10:00:00.000Z");

        let error =
            read_production_continuation_sync(dir.path()).expect_err("prefix drift in a row");
        assert!(error.contains("doesn't match its prefix"), "{error}");
    }

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

    #[test]
    fn production_set_source_grant_deserializes_designation_pages() {
        let json = r#"{"grant":"g1","designation":"Confidential","designationPages":"1-3,7"}"#;
        let source: ProductionSetSourceGrant = serde_json::from_str(json).expect("deserialize");
        assert_eq!(source.designation_pages.as_deref(), Some("1-3,7"));
    }

    #[test]
    fn production_set_source_grant_defaults_designation_pages_to_none_when_absent() {
        let json = r#"{"grant":"g1","designation":"Confidential"}"#;
        let source: ProductionSetSourceGrant = serde_json::from_str(json).expect("deserialize");
        assert_eq!(source.designation_pages, None);
    }

    #[test]
    fn production_set_source_serializes_designation_pages_camel_case_and_omits_when_none() {
        let with_range = ProductionSetSource {
            path: "/abs/a.pdf".to_string(),
            designation: Some("Confidential".to_string()),
            designation_pages: Some("1-3,7".to_string()),
        };
        let json = serde_json::to_string(&with_range).expect("serialize");
        assert!(json.contains(r#""designationPages":"1-3,7""#), "{json}");

        let without_range = ProductionSetSource {
            path: "/abs/a.pdf".to_string(),
            designation: None,
            designation_pages: None,
        };
        let json = serde_json::to_string(&without_range).expect("serialize");
        assert!(!json.contains("designationPages"), "{json}");
        assert!(!json.contains("designation"), "{json}");
    }

    #[test]
    fn production_set_stamp_placement_round_trips_camel_case_edge_and_align() {
        let placement = ProductionSetStampPlacement {
            edge: "header".to_string(),
            align: "left".to_string(),
        };
        let json = serde_json::to_string(&placement).expect("serialize");
        assert_eq!(json, r#"{"edge":"header","align":"left"}"#);

        let parsed: ProductionSetStampPlacement =
            serde_json::from_str(r#"{"edge":"footer","align":"right"}"#).expect("deserialize");
        assert_eq!(parsed.edge, "footer");
        assert_eq!(parsed.align, "right");
    }
}
