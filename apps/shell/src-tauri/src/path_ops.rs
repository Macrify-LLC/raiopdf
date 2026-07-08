//! Tauri command surface for the PathOpsEngine (large-document delegated ops).
//!
//! These commands are the shell-side wrapper around
//! `engine_sidecar_core::path_ops`: they resolve file grants to real paths,
//! run the file→file op on a blocking worker, and hand back a **fresh output
//! grant** plus metadata. Document bytes never enter the WebView — the only
//! things that cross IPC are grants, sizes, page counts, and op reports.
//!
//! Ops live here as shell commands (not sidecar HTTP endpoints) because every
//! implementation is a child-process invocation of the bundled toolchain
//! (qpdf / Ghostscript / OCRmyPDF) — there is no reason to pay a loopback HTTP
//! hop or to route bytes through the Stirling proxy for path-based work. The
//! OCR op invokes the same bundled `ocrmypdf.cmd` the sidecar's Stirling
//! config points at, directly by path.
//!
//! Temp outputs land in `<app-data>/path-ops/<uuid>/`; the whole per-op dir is
//! deleted on failure so no unverified or partial output can ever be granted.

use engine_sidecar_core::path_ops as core_ops;
use engine_sidecar_core::path_ops::{OpResult, PathOpError, PathOpsToolchain};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

use crate::FileGrants;

const NODE_LANE_MAX_BYTES_ENV: &str = "RAIOPDF_NODE_LANE_MAX_BYTES";
const DEFAULT_NODE_LANE_MAX_BYTES: u64 = 400 * 1024 * 1024;
const NODE_LANE_HEAP_MB: u64 = 8192;
const NODE_LANE_SECURITY_FLAG: &str = "--disallow-code-generation-from-strings";

/// The input file changed on disk while the op ran (typed like Phase 1's
/// range-read snapshot error so the UI can share the "reopen it" message).
pub const ERR_FILE_CHANGED: &str = "FILE_CHANGED";

/// Directory name under app data where every per-op temp dir lives.
pub const PATH_OPS_DIR: &str = "path-ops";

pub const OCR_PROGRESS_EVENT: &str = "raiopdf-ocr-progress";

/// Cooperative cancel flags for cancellable path ops, keyed by the
/// caller-generated job token. The UI mints the token before the command starts
/// so it can cancel while the Tauri invoke is still pending.
#[derive(Default)]
pub struct PathOpJobs {
    state: Mutex<PathOpJobState>,
}

#[derive(Default)]
struct PathOpJobState {
    active: HashMap<String, Arc<AtomicBool>>,
    pending_cancelled: HashMap<String, Instant>,
}

impl PathOpJobs {
    fn register(&self, token: &str) -> Result<Arc<AtomicBool>, PathOpError> {
        let mut state = self.state.lock().map_err(|_| PathOpError {
            code: core_ops::ERR_IO,
            message: "path-op job lock poisoned".to_string(),
        })?;
        prune_pending_cancelled(&mut state.pending_cancelled);
        if state.active.contains_key(token) {
            return Err(PathOpError {
                code: core_ops::ERR_INVALID_INPUT,
                message: "a path operation with this token is already running".to_string(),
            });
        }
        let flag = Arc::new(AtomicBool::new(false));
        if state.pending_cancelled.remove(token).is_some() {
            flag.store(true, Ordering::Relaxed);
        }
        state.active.insert(token.to_string(), flag.clone());
        Ok(flag)
    }

    fn cancel(&self, token: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        prune_pending_cancelled(&mut state.pending_cancelled);
        match state.active.get(token) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
            }
            None => {
                state
                    .pending_cancelled
                    .insert(token.to_string(), Instant::now());
            }
        }
        true
    }

    fn remove(&self, token: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(token);
            state.pending_cancelled.remove(token);
        }
    }
}

const PENDING_CANCEL_TTL: Duration = Duration::from_secs(60);

fn prune_pending_cancelled(pending: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    pending.retain(|_, cancelled_at| now.duration_since(*cancelled_at) <= PENDING_CANCEL_TTL);
}

/// All `PrepPlanStepId`s from `packages/rules`, whether or not an op
/// implements them. The status response maps each one to its registered op
/// (or null), which is what makes the checklist rule closed-form [R7-1].
const ALL_FILING_STEPS: &[&str] = &[
    "remove-encryption",
    "normalize-pages",
    "sanitize-content",
    "scrub-metadata",
    "make-searchable",
    "flatten-forms",
    "convert-pdfa",
    "split-by-size",
];

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpReport {
    pub op: &'static str,
    pub tool: &'static str,
    pub duration_ms: u64,
    pub input_size_bytes: u64,
    pub output_size_bytes: u64,
    pub notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOpOutput {
    pub output_grant: String,
    pub name: String,
    pub size_bytes: u64,
    pub page_count: u32,
    pub op_report: OpReport,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrProgressPayload {
    job_token: String,
    phase: String,
    description: Option<String>,
    completed: f64,
    total: Option<f64>,
    unit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCountResponse {
    pub page_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPartDescriptor {
    pub output_grant: String,
    pub name: String,
    /// Zero-based source page indexes included in this part (contiguous).
    pub page_indexes: Vec<u32>,
    pub byte_length: u64,
    /// True when a single source page cannot fit within the byte cap.
    pub oversized: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResponse {
    pub parts: Vec<SplitPartDescriptor>,
    pub op_report: OpReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactResponse {
    pub output_grant: String,
    pub name: String,
    pub size_bytes: u64,
    pub page_count: u32,
    pub verification: core_ops::RedactionVerification,
    pub op_report: OpReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareFilingResponse {
    pub parts: Vec<SplitPartDescriptor>,
    pub facts_report: Vec<core_ops::PartPreflight>,
    pub steps: Vec<core_ops::FilingStepReport>,
    pub op_report: OpReport,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBinderExhibitPayload {
    pub bytes: Vec<u8>,
    pub label: String,
    pub description: Option<String>,
    pub source_file_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildBinderOneShotExhibit {
    path: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_file_name: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinderStampPlacement {
    edge: String,
    align: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinderIndexOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_source_file_name: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum BinderPageSelection {
    Name(String),
    Pages(Vec<u32>),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBinderOptions {
    slip_sheets: bool,
    #[serde(rename = "coverStyle", skip_serializing_if = "Option::is_none")]
    cover_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<BinderIndexOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placement: Option<BinderStampPlacement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stamp_pages: Option<BinderPageSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    font_size_pt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    margin_in: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildBinderOneShotInput {
    main_path: String,
    exhibits: Vec<BuildBinderOneShotExhibit>,
    options: BuildBinderOptions,
    output_path: String,
    max_input_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildBinderOneShotOutput {
    ok: bool,
    error: Option<BuildBinderOneShotError>,
    output: Option<String>,
}

#[derive(Deserialize)]
struct BuildBinderOneShotError {
    code: Option<String>,
    message: String,
    action: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditsOptions {
    markup_mode: Option<String>,
    print_markup_annotations: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyEditsOneShotInput {
    main_path: String,
    edits: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    apply_options: Option<ApplyEditsOptions>,
    output_path: String,
    max_input_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyEditsOneShotOutput {
    ok: bool,
    error: Option<BuildBinderOneShotError>,
    output: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditsPayload {
    pub edits: Vec<Value>,
    pub apply_options: Option<ApplyEditsOptions>,
    pub output_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    pub qpdf: bool,
    pub ghostscript: bool,
    pub ocrmypdf: bool,
    pub node: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOpsStatusResponse {
    pub ops: Vec<core_ops::PathOpStatus>,
    pub toolchain: ToolchainStatus,
    /// PrepPlanStepId → registered op name (null when no path op implements
    /// the step). The streamed filing checklist enables a step ⟺ this maps to
    /// an op AND that op is available.
    pub filing_steps: BTreeMap<&'static str, Option<&'static str>>,
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

pub(crate) fn discover_toolchain(app: &tauri::AppHandle) -> PathOpsToolchain {
    let resource_dir = app.path().resource_dir().ok();
    let mut toolchain = PathOpsToolchain::discover(resource_dir.as_deref());
    toolchain.node_one_shot = crate::mcp::mcp_one_shot_runtime_available(resource_dir.as_deref());
    toolchain
}

fn path_ops_root(app: &tauri::AppHandle) -> OpResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| PathOpError {
            code: "IO_ERROR",
            message: format!("app data dir unavailable: {error}"),
        })?
        .join(PATH_OPS_DIR))
}

/// Startup sweep (large-pdf-handling housekeeping): file grants live only in
/// memory, so on a fresh app start EVERY leftover `<app-data>/path-ops/<uuid>/`
/// dir is unreachable by construction — delete them all. Runs on a background
/// thread from `setup` so a multi-hundred-MB stale output never delays startup.
pub fn purge_stale_outputs(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

/// The per-op temp dir a released output grant should delete: the grant's
/// parent `<uuid>` dir, but ONLY when that dir sits directly under the
/// path-ops root. A grant pointing anywhere else (a user's own file) must
/// never trigger a directory delete.
fn releasable_output_dir(path: &Path, root: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    if parent.parent() == Some(root) {
        Some(parent.to_path_buf())
    } else {
        None
    }
}

/// Per-op working directory under app data. Kept on success (grants reference
/// files inside it), removed wholesale on failure.
pub(crate) struct OpWorkDir {
    dir: PathBuf,
    keep: bool,
}

impl OpWorkDir {
    pub(crate) fn create(app: &tauri::AppHandle) -> OpResult<Self> {
        let root = path_ops_root(app)?;
        let dir = root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).map_err(|error| PathOpError {
            code: "IO_ERROR",
            message: format!("failed to create path-ops temp dir: {error}"),
        })?;
        Ok(Self { dir, keep: false })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.dir
    }

    pub(crate) fn keep(mut self) -> PathBuf {
        self.keep = true;
        self.dir.clone()
    }
}

impl Drop for OpWorkDir {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) struct InputSnapshot {
    len: u64,
    modified: Option<SystemTime>,
}

fn node_lane_max_bytes() -> u64 {
    std::env::var(NODE_LANE_MAX_BYTES_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_NODE_LANE_MAX_BYTES)
}

fn node_lane_timeout(input_size_bytes: u64) -> Duration {
    let chunks = input_size_bytes.div_ceil(50 * 1024 * 1024);
    Duration::from_secs(60 + chunks * 15)
}

fn node_options_heap_arg() -> String {
    let heap = format!("--max-old-space-size={NODE_LANE_HEAP_MB}");
    let lane_options = format!("{heap} {NODE_LANE_SECURITY_FLAG}");
    match std::env::var("NODE_OPTIONS") {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing} {lane_options}"),
        _ => lane_options,
    }
}

fn path_to_utf8(path: PathBuf, label: &str) -> OpResult<String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: format!("{label} path is not valid UTF-8"),
        })
}

fn format_node_one_shot_error(op: &str, error: Option<BuildBinderOneShotError>) -> PathOpError {
    let Some(error) = error else {
        return PathOpError {
            code: core_ops::ERR_OP_FAILED,
            message: format!("{op} failed"),
        };
    };
    let message = match error.action {
        Some(action) => format!("{} {}", error.message, action),
        None => error.message,
    };
    let code = match error.code.as_deref() {
        Some("INVALID_ARGUMENT") => core_ops::ERR_INVALID_INPUT,
        Some("PATH_POLICY") => core_ops::ERR_INVALID_INPUT,
        _ => core_ops::ERR_OP_FAILED,
    };
    PathOpError { code, message }
}

pub(crate) fn snapshot(path: &Path) -> OpResult<InputSnapshot> {
    let metadata = fs::metadata(path).map_err(|error| PathOpError {
        code: "IO_ERROR",
        message: format!("cannot stat input {}: {error}", path.display()),
    })?;
    Ok(InputSnapshot {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

pub(crate) fn ensure_unchanged(path: &Path, before: InputSnapshot) -> OpResult<()> {
    let after = snapshot(path)?;
    if after != before {
        return Err(PathOpError {
            code: ERR_FILE_CHANGED,
            message: "This file changed on disk while the operation ran — reopen it.".to_string(),
        });
    }
    Ok(())
}

pub(crate) fn resolve_grant(
    grants: &tauri::State<'_, FileGrants>,
    grant: &str,
) -> OpResult<PathBuf> {
    grants.resolve(grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })
}

/// Verify that `current` — the snapshot the op is actually about to process —
/// matches the snapshot taken when the grant was issued (the moment the
/// document was opened). A memory-mode document routes engine ops through its
/// on-disk file via this grant; without this check an external edit to that
/// file between open and op would make the engine silently process bytes the
/// user never saw. Validating the op's OWN snapshot (rather than snapshotting
/// again inside the check) leaves no window between the check and the op. This
/// is the same open-time drift guard ranged reads and Save-As already use.
pub(crate) fn ensure_grant_snapshot_unchanged(
    grants: &tauri::State<'_, FileGrants>,
    grant: &str,
    current: &InputSnapshot,
) -> OpResult<()> {
    let entry = grants.resolve_entry(grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })?;
    let open = entry.snapshot.ok_or(PathOpError {
        code: ERR_FILE_CHANGED,
        message: "This file could not be verified against its open-time snapshot — reopen it."
            .to_string(),
    })?;
    // `InputSnapshot` and the grant's `FileSnapshot` carry the same {len, mtime}
    // drift baseline under different field names.
    if current.len != open.len || current.modified != open.mtime {
        return Err(PathOpError {
            code: ERR_FILE_CHANGED,
            message: "This file changed on disk — reopen it.".to_string(),
        });
    }
    Ok(())
}

fn issue_grant(grants: &tauri::State<'_, FileGrants>, path: &Path) -> OpResult<String> {
    grants
        .grant(path.to_path_buf())
        .map_err(|message| PathOpError {
            code: "IO_ERROR",
            message,
        })
}

fn output_name(input: &Path, suffix: &str) -> String {
    let stem = input
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("document");
    format!("{stem}-{suffix}.pdf")
}

fn file_size(path: &Path) -> OpResult<u64> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| PathOpError {
            code: "IO_ERROR",
            message: format!("cannot stat output {}: {error}", path.display()),
        })
}

pub(crate) async fn on_blocking_pool<T, F>(work: F) -> OpResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> OpResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| PathOpError {
            code: "OP_FAILED",
            message: format!("path op worker failed: {error}"),
        })?
}

/// Descriptive metadata for one single-output op run.
struct OpSpec {
    op_name: &'static str,
    tool: &'static str,
    suffix: &'static str,
    notes: Vec<String>,
}

impl OpSpec {
    fn new(op_name: &'static str, tool: &'static str, suffix: &'static str) -> Self {
        Self {
            op_name,
            tool,
            suffix,
            notes: Vec::new(),
        }
    }

    fn note(mut self, note: &str) -> Self {
        self.notes.push(note.to_string());
        self
    }
}

/// Shared driver for every single-output op: resolve grant → snapshot input →
/// run `op` file→file on the blocking pool → verify input unchanged → stat +
/// page-count the output → issue a fresh grant. On any failure the work dir
/// (and with it any partial output) is deleted before the error returns.
async fn run_single_output_op<F>(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    spec: OpSpec,
    op: F,
) -> Result<PathOpOutput, PathOpError>
where
    F: FnOnce(&PathOpsToolchain, &Path, &Path, &Path) -> OpResult<()> + Send + 'static,
{
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let name = output_name(&input, spec.suffix);
    let output_path = work_dir.path().join(&name);
    let before = snapshot(&input)?;
    // Refuse if the on-disk file drifted from its open-time snapshot: the op is
    // about to process `before`, so validating THAT snapshot leaves no window.
    ensure_grant_snapshot_unchanged(&grants, &grant, &before)?;
    let started = Instant::now();

    let (page_count, output_size) = {
        let input = input.clone();
        let output_path = output_path.clone();
        let work_path = work_dir.path().to_path_buf();
        let toolchain_for_work = toolchain.clone();
        on_blocking_pool(move || {
            op(&toolchain_for_work, &input, &output_path, &work_path)?;
            ensure_unchanged(&input, before)?;
            let page_count = core_ops::page_count(&toolchain_for_work, &output_path)?;
            let output_size = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: "IO_ERROR",
                    message: format!("cannot stat output: {error}"),
                })?;
            Ok((page_count, output_size))
        })
        .await?
    };

    let output_grant = issue_grant(&grants, &output_path)?;
    work_dir.keep();
    Ok(PathOpOutput {
        output_grant,
        name,
        size_bytes: output_size,
        page_count,
        op_report: OpReport {
            op: spec.op_name,
            tool: spec.tool,
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: before.len,
            output_size_bytes: output_size,
            notes: spec.notes,
        },
    })
}

fn split_descriptors(
    grants: &tauri::State<'_, FileGrants>,
    parts: Vec<core_ops::SplitPartFile>,
) -> OpResult<Vec<SplitPartDescriptor>> {
    parts
        .into_iter()
        .map(|part| {
            let name = part
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("part.pdf")
                .to_string();
            let output_grant = issue_grant(grants, &part.path)?;
            Ok(SplitPartDescriptor {
                output_grant,
                name,
                page_indexes: (part.first_page_index..=part.last_page_index).collect(),
                byte_length: part.byte_length,
                oversized: part.oversized,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Output lifecycle
// ---------------------------------------------------------------------------

/// Delete one path-op temp output eagerly (the page-range print flow reads
/// the extracted bytes and has no further use for the file). Only grants that
/// resolve inside `<app-data>/path-ops/<uuid>/` are releasable; the whole
/// per-op dir is removed and the grant is dropped.
#[tauri::command]
pub fn path_op_release_output(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<(), PathOpError> {
    let path = resolve_grant(&grants, &grant)?;
    let root = path_ops_root(&app)?;
    let Some(dir) = releasable_output_dir(&path, &root) else {
        return Err(PathOpError {
            code: "INVALID_INPUT",
            message: "grant does not reference a path-op output".to_string(),
        });
    };
    grants.remove(&grant);
    fs::remove_dir_all(&dir).map_err(|error| PathOpError {
        code: "IO_ERROR",
        message: format!("failed to delete path-op output: {error}"),
    })
}

// ---------------------------------------------------------------------------
// Registry / status
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn path_ops_status(app: tauri::AppHandle) -> PathOpsStatusResponse {
    let toolchain = discover_toolchain(&app);
    let max_input_bytes = node_lane_max_bytes();
    let ops = core_ops::registry(&toolchain)
        .into_iter()
        .map(|mut op| {
            if op.name == "build_binder" || op.name == "apply_edits" {
                op.max_input_bytes = Some(max_input_bytes);
            }
            op
        })
        .collect();

    let mut filing_steps: BTreeMap<&'static str, Option<&'static str>> = BTreeMap::new();
    for step in ALL_FILING_STEPS {
        let implementing_op = core_ops::OP_DESCRIPTORS
            .iter()
            .find(|descriptor| descriptor.filing_step == Some(step))
            .map(|descriptor| descriptor.name);
        filing_steps.insert(step, implementing_op);
    }

    PathOpsStatusResponse {
        toolchain: ToolchainStatus {
            qpdf: toolchain.qpdf.is_some(),
            ghostscript: toolchain.ghostscript.is_some(),
            ocrmypdf: toolchain.ocrmypdf.is_some(),
            node: toolchain.node_one_shot,
        },
        ops,
        filing_steps,
    }
}

#[tauri::command]
pub fn path_op_cancel(jobs: tauri::State<'_, PathOpJobs>, job_token: String) -> bool {
    jobs.cancel(&job_token)
}

// ---------------------------------------------------------------------------
// Read-only ops
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_page_count(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PageCountResponse, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    let page_count = on_blocking_pool(move || core_ops::page_count(&toolchain, &input)).await?;
    Ok(PageCountResponse { page_count })
}

#[tauri::command]
pub async fn path_op_document_facts(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<core_ops::DocumentFacts, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    on_blocking_pool(move || core_ops::document_facts(&toolchain, &input)).await
}

// ---------------------------------------------------------------------------
// Single-output ops
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_decrypt(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    password: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("decrypt", "qpdf", "decrypted"),
        move |toolchain, input, output, work_dir| {
            core_ops::decrypt(toolchain, input, &password, output, work_dir)
        },
    )
    .await
}

#[tauri::command]
pub async fn path_op_extract_pages(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    page_indexes: Vec<u32>,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("extract_pages", "qpdf", "extract"),
        move |toolchain, input, output, _work_dir| {
            core_ops::extract_pages(toolchain, input, &page_indexes, output)
        },
    )
    .await
}

#[tauri::command]
pub async fn path_op_ocr(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    jobs: tauri::State<'_, PathOpJobs>,
    grant: String,
    mode: Option<core_ops::OcrMode>,
    job_token: Option<String>,
    page_indexes: Option<Vec<u32>>,
) -> Result<PathOpOutput, PathOpError> {
    // Older callers omit the mode — default to the text-preserving pass.
    let mode = mode.unwrap_or_default();
    let options = core_ops::OcrOptions {
        mode,
        page_indexes: page_indexes.unwrap_or_default(),
        ..Default::default()
    };
    let force_ocr_note = if options.page_indexes.is_empty() {
        "text layer rebuilt from scratch (--force-ocr); every page is re-rendered"
    } else {
        "text layer rebuilt from scratch (--force-ocr); OCR-selected pages are re-rendered"
    };
    let spec = match mode {
        core_ops::OcrMode::SkipText => OpSpec::new("ocr", "ocrmypdf", "ocr")
            .note("existing text layers are kept (--skip-text)"),
        core_ops::OcrMode::ForceOcr => OpSpec::new("ocr", "ocrmypdf", "ocr").note(force_ocr_note),
    };
    let progress_app = app.clone();
    let cancel_flag = match job_token.as_deref() {
        Some(token) => Some(jobs.register(token)?),
        None => None,
    };
    let job_token_for_cleanup = job_token.clone();
    let result = run_single_output_op(
        app,
        grants,
        grant,
        spec,
        move |toolchain, input, output, _work_dir| {
            if let Some(job_token) = job_token {
                let app = progress_app.clone();
                core_ops::ocr_with_options_and_progress_cancelable(
                    toolchain,
                    input,
                    output,
                    &options,
                    move |progress| {
                        let _ = app.emit(
                            OCR_PROGRESS_EVENT,
                            OcrProgressPayload {
                                job_token: job_token.clone(),
                                phase: progress.phase,
                                description: progress.description,
                                completed: progress.completed,
                                total: progress.total,
                                unit: progress.unit,
                            },
                        );
                    },
                    cancel_flag,
                )
            } else {
                core_ops::ocr_with_options(toolchain, input, output, &options)
            }
        },
    )
    .await;
    if let Some(token) = job_token_for_cleanup {
        jobs.remove(&token);
    }
    result
}

// ---------------------------------------------------------------------------
// Stamping ops — overlay technique (bates_stamp / page_numbers / watermark)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_bates_stamp(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    options: core_ops::BatesStampOptions,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("bates_stamp", "qpdf", "bates")
            .note("stamped via a generated text overlay + one qpdf --overlay pass"),
        move |toolchain, input, output, work_dir| {
            core_ops::bates_stamp(toolchain, input, &options, output, work_dir)
        },
    )
    .await
}

#[tauri::command]
pub async fn path_op_page_numbers(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    options: core_ops::PageNumbersOptions,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("page_numbers", "qpdf", "numbered")
            .note("stamped via a generated text overlay + one qpdf --overlay pass"),
        move |toolchain, input, output, work_dir| {
            core_ops::page_numbers(toolchain, input, &options, output, work_dir)
        },
    )
    .await
}

#[tauri::command]
pub async fn path_op_watermark(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    options: core_ops::WatermarkOptions,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("watermark", "qpdf", "watermarked")
            .note("stamped via a generated text overlay + one qpdf --overlay pass"),
        move |toolchain, input, output, work_dir| {
            core_ops::watermark(toolchain, input, &options, output, work_dir)
        },
    )
    .await
}

#[tauri::command]
pub async fn path_op_repair(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("repair", "qpdf", "repaired"),
        |toolchain, input, output, _work_dir| core_ops::repair(toolchain, input, output),
    )
    .await
}

#[tauri::command]
pub async fn path_op_linearize(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("linearize", "qpdf", "linearized"),
        |toolchain, input, output, _work_dir| core_ops::linearize(toolchain, input, output),
    )
    .await
}

#[tauri::command]
pub async fn path_op_compress(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("compress", "qpdf", "compressed")
            .note("stream-level recompression; image downsampling is a later variant"),
        |toolchain, input, output, _work_dir| core_ops::compress(toolchain, input, output),
    )
    .await
}

#[tauri::command]
pub async fn path_op_sanitize(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("sanitize", "ghostscript", "sanitized").note(
            "pdfwrite rewrite: document JavaScript, embedded files, and launch actions do not survive",
        ),
        |toolchain, input, output, _work_dir| core_ops::sanitize(toolchain, input, output),
    )
    .await
}

#[tauri::command]
pub async fn path_op_normalize(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("normalize_to_letter_portrait", "ghostscript", "normalized"),
        |toolchain, input, output, _work_dir| {
            core_ops::normalize_to_letter_portrait(toolchain, input, output)
        },
    )
    .await
}

#[tauri::command]
pub async fn path_op_scrub_metadata(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("scrub_metadata", "qpdf", "scrubbed")
            .note("Info dictionary and XMP metadata removed (qpdf retains ModDate)"),
        |toolchain, input, output, _work_dir| core_ops::scrub_metadata(toolchain, input, output),
    )
    .await
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_merge(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    input_grants: Vec<String>,
) -> Result<PathOpOutput, PathOpError> {
    let inputs: Vec<PathBuf> = input_grants
        .iter()
        .map(|grant| resolve_grant(&grants, grant))
        .collect::<OpResult<_>>()?;
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let name = "merged.pdf".to_string();
    let output_path = work_dir.path().join(&name);
    // Snapshot every input up front and re-verify after qpdf finishes — a
    // multi-input op gets the same mid-operation drift guard as the
    // single-output ops, or a moving input could silently produce a stale or
    // mixed merged PDF (Codex review, PR #123).
    let snapshots: Vec<InputSnapshot> = inputs
        .iter()
        .map(|path| snapshot(path))
        .collect::<OpResult<_>>()?;
    let input_size: u64 = snapshots.iter().map(|snapshot| snapshot.len).sum();
    let started = Instant::now();

    let (page_count, output_size) = {
        let inputs = inputs.clone();
        let snapshots = snapshots.clone();
        let output_path = output_path.clone();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            core_ops::merge(&toolchain, &inputs, &output_path)?;
            for (input, before) in inputs.iter().zip(snapshots) {
                ensure_unchanged(input, before)?;
            }
            let page_count = core_ops::page_count(&toolchain, &output_path)?;
            let size = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: "IO_ERROR",
                    message: format!("cannot stat output: {error}"),
                })?;
            Ok((page_count, size))
        })
        .await?
    };

    let output_grant = issue_grant(&grants, &output_path)?;
    work_dir.keep();
    Ok(PathOpOutput {
        output_grant,
        name,
        size_bytes: output_size,
        page_count,
        op_report: OpReport {
            op: "merge",
            tool: "qpdf",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: input_size,
            output_size_bytes: output_size,
            notes: Vec::new(),
        },
    })
}

// ---------------------------------------------------------------------------
// insert_pages
// ---------------------------------------------------------------------------

/// Insert every page of `insert_grant` into `grant` after its first
/// `at_index` pages. Two inputs, so it carries the same multi-input
/// mid-operation drift guard as `path_op_merge`.
#[tauri::command]
pub async fn path_op_insert_pages(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    insert_grant: String,
    at_index: u32,
) -> Result<PathOpOutput, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let insert = resolve_grant(&grants, &insert_grant)?;
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let name = output_name(&input, "inserted");
    let output_path = work_dir.path().join(&name);
    let input_before = snapshot(&input)?;
    let insert_before = snapshot(&insert)?;
    let input_size = input_before.len + insert_before.len;
    let started = Instant::now();

    let (page_count, output_size) = {
        let input = input.clone();
        let insert = insert.clone();
        let output_path = output_path.clone();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            core_ops::insert_pages(&toolchain, &input, &insert, at_index, &output_path)?;
            ensure_unchanged(&input, input_before)?;
            ensure_unchanged(&insert, insert_before)?;
            let page_count = core_ops::page_count(&toolchain, &output_path)?;
            let size = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: "IO_ERROR",
                    message: format!("cannot stat output: {error}"),
                })?;
            Ok((page_count, size))
        })
        .await?
    };

    let output_grant = issue_grant(&grants, &output_path)?;
    work_dir.keep();
    Ok(PathOpOutput {
        output_grant,
        name,
        size_bytes: output_size,
        page_count,
        op_report: OpReport {
            op: "insert_pages",
            tool: "qpdf",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: input_size,
            output_size_bytes: output_size,
            notes: Vec::new(),
        },
    })
}

// ---------------------------------------------------------------------------
// build_binder — Node one-shot lane
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_build_binder(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    exhibits: Vec<BuildBinderExhibitPayload>,
    options: BuildBinderOptions,
    output_name: String,
) -> Result<PathOpOutput, PathOpError> {
    if exhibits.is_empty() {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "Add at least one exhibit before combining.".to_string(),
        });
    }

    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    if !toolchain.node_one_shot {
        return Err(PathOpError {
            code: core_ops::ERR_TOOLCHAIN_MISSING,
            message:
                "RaioPDF's built-in tools could not be started. Reinstall RaioPDF and try again."
                    .to_string(),
        });
    }
    if toolchain.qpdf.is_none() {
        return Err(PathOpError {
            code: core_ops::ERR_TOOLCHAIN_MISSING,
            message: "A built-in PDF tool is missing from your installation. Reinstall RaioPDF and try again.".to_string(),
        });
    }

    let work_dir = OpWorkDir::create(&app)?;
    let base_output_name = Path::new(&output_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("binder.pdf");
    let safe_output_name = if base_output_name.to_ascii_lowercase().ends_with(".pdf") {
        base_output_name.to_string()
    } else {
        format!("{base_output_name}.pdf")
    };
    let output_path = work_dir.path().join(safe_output_name);
    let before = snapshot(&input)?;
    let max_input_bytes = node_lane_max_bytes();
    if before.len > max_input_bytes {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: format!(
                "This PDF is too large for Combine with Exhibits (limit about {} MB). Try splitting it first.",
                max_input_bytes / (1024 * 1024)
            ),
        });
    }

    let started = Instant::now();
    let exhibit_inputs = exhibits
        .into_iter()
        .enumerate()
        .map(|(index, exhibit)| {
            let path = work_dir
                .path()
                .join(format!("exhibit-{:03}.pdf", index + 1));
            fs::write(&path, &exhibit.bytes).map_err(|error| PathOpError {
                code: core_ops::ERR_IO,
                message: format!("failed to write exhibit temp file: {error}"),
            })?;
            Ok(BuildBinderOneShotExhibit {
                path: path_to_utf8(path, "Exhibit temp")?,
                label: exhibit.label,
                description: exhibit.description,
                source_file_name: exhibit.source_file_name,
            })
        })
        .collect::<OpResult<Vec<_>>>()?;
    let exhibit_size: u64 = exhibit_inputs
        .iter()
        .filter_map(|exhibit| {
            fs::metadata(&exhibit.path)
                .ok()
                .map(|metadata| metadata.len())
        })
        .sum();

    let request = BuildBinderOneShotInput {
        main_path: path_to_utf8(input.clone(), "Main document")?,
        exhibits: exhibit_inputs,
        options,
        output_path: path_to_utf8(output_path.clone(), "Binder output")?,
        max_input_bytes,
    };
    let total_work_size = before.len.saturating_add(exhibit_size);
    let timeout = node_lane_timeout(total_work_size);
    let mcp_options = crate::mcp::McpOneShotOptions {
        timeout: Some(timeout),
        node_options: Some(node_options_heap_arg()),
    };

    let (page_count, output_size) = {
        let input = input.clone();
        let output_path = output_path.clone();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            let stdout =
                crate::mcp::run_mcp_one_shot_with_options("build_binder", &request, mcp_options)
                    .map_err(|message| PathOpError {
                        code: core_ops::ERR_OP_FAILED,
                        message,
                    })?;
            let output: BuildBinderOneShotOutput =
                serde_json::from_slice(&stdout).map_err(|_| PathOpError {
                    code: core_ops::ERR_OP_FAILED,
                    message: "RaioPDF couldn't finish building that package. Please try again."
                        .to_string(),
                })?;
            if !output.ok {
                return Err(format_node_one_shot_error("build_binder", output.error));
            }
            if output.output.as_deref() != Some(output_path.to_string_lossy().as_ref()) {
                return Err(PathOpError {
                    code: core_ops::ERR_OP_FAILED,
                    message: "RaioPDF couldn't finish building that package. Please try again."
                        .to_string(),
                });
            }
            ensure_unchanged(&input, before)?;
            let page_count = core_ops::page_count(&toolchain, &output_path)?;
            let output_size = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: core_ops::ERR_IO,
                    message: format!("cannot stat output: {error}"),
                })?;
            Ok((page_count, output_size))
        })
        .await?
    };

    let output_grant = issue_grant(&grants, &output_path)?;
    let name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("binder.pdf")
        .to_string();
    work_dir.keep();
    Ok(PathOpOutput {
        output_grant,
        name,
        size_bytes: output_size,
        page_count,
        op_report: OpReport {
            op: "build_binder",
            tool: "node",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: before.len + exhibit_size,
            output_size_bytes: output_size,
            notes: vec![
                format!("Node heap capped with --max-old-space-size={NODE_LANE_HEAP_MB}"),
                format!("Node flag: {NODE_LANE_SECURITY_FLAG}"),
                format!("timeout: {} seconds", timeout.as_secs()),
            ],
        },
    })
}

// ---------------------------------------------------------------------------
// apply_edits — Node one-shot lane
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_apply_edits(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    payload: ApplyEditsPayload,
) -> Result<PathOpOutput, PathOpError> {
    if payload.edits.is_empty() {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "There are no edits to apply.".to_string(),
        });
    }

    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    if !toolchain.node_one_shot {
        return Err(PathOpError {
            code: core_ops::ERR_TOOLCHAIN_MISSING,
            message:
                "RaioPDF's built-in tools could not be started. Reinstall RaioPDF and try again."
                    .to_string(),
        });
    }
    if toolchain.qpdf.is_none() {
        return Err(PathOpError {
            code: core_ops::ERR_TOOLCHAIN_MISSING,
            message: "A built-in PDF tool is missing from your installation. Reinstall RaioPDF and try again.".to_string(),
        });
    }

    let work_dir = OpWorkDir::create(&app)?;
    let base_output_name = Path::new(&payload.output_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("edited.pdf");
    let safe_output_name = if base_output_name.to_ascii_lowercase().ends_with(".pdf") {
        base_output_name.to_string()
    } else {
        format!("{base_output_name}.pdf")
    };
    let output_path = work_dir.path().join(safe_output_name);
    let before = snapshot(&input)?;
    let max_input_bytes = node_lane_max_bytes();
    if before.len > max_input_bytes {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: format!(
                "This PDF is too large to edit (limit about {} MB). Try splitting it first.",
                max_input_bytes / (1024 * 1024)
            ),
        });
    }

    let started = Instant::now();
    let mut edits = payload.edits;
    let edit_temp_size = materialize_apply_edit_temp_files(work_dir.path(), &mut edits)?;

    let request = ApplyEditsOneShotInput {
        main_path: path_to_utf8(input.clone(), "Main document")?,
        edits,
        apply_options: payload.apply_options,
        output_path: path_to_utf8(output_path.clone(), "Edited output")?,
        max_input_bytes,
    };
    let timeout = node_lane_timeout(before.len);
    let mcp_options = crate::mcp::McpOneShotOptions {
        timeout: Some(timeout),
        node_options: Some(node_options_heap_arg()),
    };

    let (page_count, output_size) = {
        let input = input.clone();
        let output_path = output_path.clone();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            let stdout =
                crate::mcp::run_mcp_one_shot_with_options("apply_edits", &request, mcp_options)
                    .map_err(|message| PathOpError {
                        code: core_ops::ERR_OP_FAILED,
                        message,
                    })?;
            let output: ApplyEditsOneShotOutput =
                serde_json::from_slice(&stdout).map_err(|_| PathOpError {
                    code: core_ops::ERR_OP_FAILED,
                    message: "RaioPDF couldn't finish applying your edits. Please try again."
                        .to_string(),
                })?;
            if !output.ok {
                return Err(format_node_one_shot_error("apply_edits", output.error));
            }
            if output.output.as_deref() != Some(output_path.to_string_lossy().as_ref()) {
                return Err(PathOpError {
                    code: core_ops::ERR_OP_FAILED,
                    message: "RaioPDF couldn't finish applying your edits. Please try again."
                        .to_string(),
                });
            }
            ensure_unchanged(&input, before)?;
            let page_count = core_ops::page_count(&toolchain, &output_path)?;
            let output_size = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: core_ops::ERR_IO,
                    message: format!("cannot stat output: {error}"),
                })?;
            Ok((page_count, output_size))
        })
        .await?
    };

    let output_grant = issue_grant(&grants, &output_path)?;
    let name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("edited.pdf")
        .to_string();
    work_dir.keep();
    Ok(PathOpOutput {
        output_grant,
        name,
        size_bytes: output_size,
        page_count,
        op_report: OpReport {
            op: "apply_edits",
            tool: "node",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: before.len + edit_temp_size,
            output_size_bytes: output_size,
            notes: vec![
                format!("Node heap capped with --max-old-space-size={NODE_LANE_HEAP_MB}"),
                format!("Node flag: {NODE_LANE_SECURITY_FLAG}"),
                format!("timeout: {} seconds", timeout.as_secs()),
            ],
        },
    })
}

fn materialize_apply_edit_temp_files(work_dir: &Path, edits: &mut [Value]) -> OpResult<u64> {
    let mut temp_size = 0_u64;

    for (index, edit) in edits.iter_mut().enumerate() {
        let object = edit.as_object_mut().ok_or_else(|| PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "apply_edits edit entries must be objects".to_string(),
        })?;
        let edit_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| PathOpError {
                code: core_ops::ERR_INVALID_INPUT,
                message: "apply_edits edit entries must include a type".to_string(),
            })?
            .to_string();

        if edit_type == "formValues" {
            return Err(PathOpError {
                code: core_ops::ERR_INVALID_INPUT,
                message: "Form filling is not available for streamed documents yet.".to_string(),
            });
        }

        if edit_type != "image" && edit_type != "signature" {
            continue;
        }

        let bytes_value = object.remove("bytes").ok_or_else(|| PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: format!("{edit_type} edits must include bytes"),
        })?;
        let bytes: Vec<u8> = serde_json::from_value(bytes_value).map_err(|error| PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: format!("{edit_type} edit bytes must be a byte array: {error}"),
        })?;
        let extension = object
            .get("format")
            .and_then(Value::as_str)
            .filter(|format| *format == "jpeg" || *format == "png")
            .unwrap_or("bin");
        let temp_path = work_dir.join(format!("edit-{:03}.{extension}", index + 1));
        fs::write(&temp_path, &bytes).map_err(|error| PathOpError {
            code: core_ops::ERR_IO,
            message: format!("failed to write {edit_type} temp file: {error}"),
        })?;
        temp_size += bytes.len() as u64;
        object.insert(
            "bytes".to_string(),
            serde_json::json!({ "tempPath": path_to_utf8(temp_path, "Edit temp")? }),
        );
    }

    Ok(temp_size)
}

// ---------------------------------------------------------------------------
// split_by_max_bytes
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_split_by_max_bytes(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    max_bytes: u64,
) -> Result<SplitResponse, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let before = snapshot(&input)?;
    let started = Instant::now();

    let parts = {
        let input = input.clone();
        let out_dir = work_dir.path().to_path_buf();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            let parts = core_ops::split_by_max_bytes(&toolchain, &input, max_bytes, &out_dir)?;
            ensure_unchanged(&input, before)?;
            Ok(parts)
        })
        .await?
    };

    let total_output: u64 = parts.iter().map(|part| part.byte_length).sum();
    let descriptors = split_descriptors(&grants, parts)?;
    work_dir.keep();
    Ok(SplitResponse {
        parts: descriptors,
        op_report: OpReport {
            op: "split_by_max_bytes",
            tool: "qpdf",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: before.len,
            output_size_bytes: total_output,
            notes: Vec::new(),
        },
    })
}

// ---------------------------------------------------------------------------
// prepare_filing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_prepare_filing(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    jobs: tauri::State<'_, PathOpJobs>,
    grant: String,
    plan: core_ops::PrepareFilingPlan,
    job_token: Option<String>,
) -> Result<PrepareFilingResponse, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    // Intermediates live in a work dir that is ALWAYS deleted; final parts
    // live in a separate output dir kept only on success.
    let stage_dir = OpWorkDir::create(&app)?;
    let out_dir = OpWorkDir::create(&app)?;
    let before = snapshot(&input)?;
    let started = Instant::now();
    let progress_app = app.clone();
    let cancel_flag = match job_token.as_deref() {
        Some(token) => Some(jobs.register(token)?),
        None => None,
    };
    let job_token_for_cleanup = job_token.clone();

    let outcome_result = {
        let input = input.clone();
        let stage_path = stage_dir.path().to_path_buf();
        let out_path = out_dir.path().to_path_buf();
        let toolchain = toolchain.clone();
        let plan = plan.clone();
        let cancel_flag = cancel_flag.clone();
        on_blocking_pool(move || {
            // Forward per-page OCR progress to the webview only when the caller
            // passed a job token (mirrors `path_op_ocr`); otherwise a no-op.
            // The OCR step is the only sub-step of this otherwise-opaque
            // pipeline that can report itself on a very large scan.
            let on_ocr_progress: Box<dyn FnMut(core_ops::OcrProgress) + Send> = match job_token {
                Some(token) => {
                    let app = progress_app;
                    Box::new(move |progress: core_ops::OcrProgress| {
                        let _ = app.emit(
                            OCR_PROGRESS_EVENT,
                            OcrProgressPayload {
                                job_token: token.clone(),
                                phase: progress.phase,
                                description: progress.description,
                                completed: progress.completed,
                                total: progress.total,
                                unit: progress.unit,
                            },
                        );
                    })
                }
                None => Box::new(|_progress| {}),
            };
            let outcome = core_ops::prepare_filing_cancelable(
                &toolchain,
                &input,
                &plan,
                &stage_path,
                &out_path,
                on_ocr_progress,
                cancel_flag,
            )?;
            ensure_unchanged(&input, before)?;
            Ok(outcome)
        })
        .await
    };
    if let Some(token) = job_token_for_cleanup {
        jobs.remove(&token);
    }
    let outcome = outcome_result?;

    let total_output: u64 = outcome.parts.iter().map(|part| part.byte_length).sum();
    let descriptors = split_descriptors(&grants, outcome.parts)?;
    out_dir.keep();
    Ok(PrepareFilingResponse {
        parts: descriptors,
        facts_report: outcome.facts_report,
        steps: outcome.steps,
        op_report: OpReport {
            op: "prepare_filing",
            tool: "qpdf+ghostscript",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: before.len,
            output_size_bytes: total_output,
            notes: vec![
                "output preflight recomputed from document_facts per part; checks qpdf cannot compute are not evaluated for very large files".to_string(),
            ],
        },
    })
}

// ---------------------------------------------------------------------------
// redact_areas — fail-closed verification
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn path_op_redact_areas(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    areas: Vec<core_ops::RedactArea>,
) -> Result<RedactResponse, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let name = output_name(&input, "redacted");
    let output_path = work_dir.path().join(&name);
    let before = snapshot(&input)?;
    // Refuse if the on-disk file drifted from its open-time snapshot (same
    // single-snapshot validation as run_single_output_op).
    ensure_grant_snapshot_unchanged(&grants, &grant, &before)?;
    let started = Instant::now();

    let (verification, page_count) = {
        let input = input.clone();
        let output_path = output_path.clone();
        let work_path = work_dir.path().to_path_buf();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            let verification =
                core_ops::redact_areas(&toolchain, &input, &areas, &output_path, &work_path)?;
            ensure_unchanged(&input, before)?;
            let page_count = core_ops::page_count(&toolchain, &output_path)?;
            Ok((verification, page_count))
        })
        .await?
    };

    // The grant is issued only after verification succeeded — a failed or
    // unverifiable redaction has already deleted the output and errored.
    let size_bytes = file_size(&output_path)?;
    let output_grant = issue_grant(&grants, &output_path)?;
    work_dir.keep();
    Ok(RedactResponse {
        output_grant,
        name,
        size_bytes,
        page_count,
        verification,
        op_report: OpReport {
            op: "redact_areas",
            tool: "qpdf+ghostscript",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: before.len,
            output_size_bytes: size_bytes,
            notes: vec![
                "redacted pages are rasterized; run OCR afterwards to restore searchable text on those pages".to_string(),
            ],
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purge_deletes_every_stale_output_entry() {
        let root = tempfile::tempdir().expect("temp dir");
        let stale_a = root.path().join("uuid-a");
        let stale_b = root.path().join("uuid-b");
        fs::create_dir_all(&stale_a).expect("create a");
        fs::create_dir_all(&stale_b).expect("create b");
        fs::write(stale_a.join("out.pdf"), b"pdf").expect("write a");
        fs::write(root.path().join("loose.tmp"), b"tmp").expect("write loose");

        purge_stale_outputs(root.path());

        assert!(!stale_a.exists());
        assert!(!stale_b.exists());
        assert!(!root.path().join("loose.tmp").exists());
        // The root itself survives for the next op.
        assert!(root.path().exists());
    }

    #[test]
    fn purge_tolerates_a_missing_root() {
        purge_stale_outputs(Path::new("/definitely/not/present/path-ops"));
    }

    #[test]
    fn releasable_output_dir_only_matches_dirs_directly_under_the_root() {
        let root = Path::new("/data/path-ops");

        assert_eq!(
            releasable_output_dir(Path::new("/data/path-ops/uuid-1/out.pdf"), root),
            Some(PathBuf::from("/data/path-ops/uuid-1")),
        );
        // A user file elsewhere must never be deletable through release.
        assert_eq!(
            releasable_output_dir(Path::new("/home/user/case.pdf"), root),
            None,
        );
        // A file directly in the root has no per-op dir to delete.
        assert_eq!(
            releasable_output_dir(Path::new("/data/path-ops/out.pdf"), root),
            None
        );
        // Nested deeper than one uuid dir is not the op layout either.
        assert_eq!(
            releasable_output_dir(Path::new("/data/path-ops/uuid-1/nested/out.pdf"), root),
            None,
        );
    }

    #[test]
    fn build_binder_one_shot_payload_omits_unset_optional_options() {
        let request = BuildBinderOneShotInput {
            main_path: "/tmp/main.pdf".to_string(),
            exhibits: vec![BuildBinderOneShotExhibit {
                path: "/tmp/exhibit.pdf".to_string(),
                label: "Exhibit A".to_string(),
                description: None,
                source_file_name: None,
            }],
            options: BuildBinderOptions {
                slip_sheets: false,
                cover_style: None,
                index: Some(BinderIndexOptions {
                    enabled: None,
                    include_source_file_name: None,
                }),
                placement: None,
                stamp_pages: None,
                font_size_pt: None,
                margin_in: None,
            },
            output_path: "/tmp/binder.pdf".to_string(),
            max_input_bytes: 10_000_000,
        };

        let payload = serde_json::to_value(request).expect("serialize request");
        let options = payload
            .get("options")
            .and_then(serde_json::Value::as_object)
            .expect("options object");
        let index = options
            .get("index")
            .and_then(serde_json::Value::as_object)
            .expect("index object");

        assert_eq!(options.get("slipSheets"), Some(&serde_json::json!(false)));
        assert!(!options.contains_key("coverStyle"));
        assert!(!options.contains_key("placement"));
        assert!(!options.contains_key("stampPages"));
        assert!(!options.contains_key("fontSizePt"));
        assert!(!options.contains_key("marginIn"));
        assert!(!index.contains_key("enabled"));
        assert!(!index.contains_key("includeSourceFileName"));
    }

    #[test]
    fn build_binder_one_shot_payload_preserves_cover_style() {
        let request = BuildBinderOneShotInput {
            main_path: "/tmp/main.pdf".to_string(),
            exhibits: vec![BuildBinderOneShotExhibit {
                path: "/tmp/exhibit.pdf".to_string(),
                label: "Exhibit A".to_string(),
                description: None,
                source_file_name: None,
            }],
            options: BuildBinderOptions {
                slip_sheets: true,
                cover_style: Some("bordered".to_string()),
                index: None,
                placement: None,
                stamp_pages: None,
                font_size_pt: None,
                margin_in: None,
            },
            output_path: "/tmp/binder.pdf".to_string(),
            max_input_bytes: 10_000_000,
        };

        let payload = serde_json::to_value(request).expect("serialize request");
        let options = payload
            .get("options")
            .and_then(serde_json::Value::as_object)
            .expect("options object");

        assert_eq!(
            options.get("coverStyle"),
            Some(&serde_json::json!("bordered"))
        );
    }
}
