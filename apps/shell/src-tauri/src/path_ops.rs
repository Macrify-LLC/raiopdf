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
//! Each per-op dir carries a `.raio-owner` marker naming the instance that
//! created it (see `crate::instance`), because several RaioPDF processes can
//! share this app-data root at once — the startup sweep only reclaims dirs
//! whose owning instance is no longer running.

use engine_sidecar_core::path_ops as core_ops;
use engine_sidecar_core::path_ops::{OpResult, PathOpError, PathOpsToolchain};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::range_read::large_doc_threshold_bytes;
use crate::FileGrants;

const NODE_LANE_MAX_BYTES_ENV: &str = "RAIOPDF_NODE_LANE_MAX_BYTES";
const DEFAULT_NODE_LANE_MAX_BYTES: u64 = 400 * 1024 * 1024;
const NODE_LANE_HEAP_MB: u64 = 8192;
const NODE_LANE_SECURITY_FLAG: &str = crate::mcp::NODE_SECURITY_FLAG;

/// The input file changed on disk while the op ran (typed like Phase 1's
/// range-read snapshot error so the UI can share the "reopen it" message).
pub const ERR_FILE_CHANGED: &str = "FILE_CHANGED";

/// Directory name under app data where every per-op temp dir lives.
pub const PATH_OPS_DIR: &str = "path-ops";

pub const OCR_PROGRESS_EVENT: &str = "raiopdf-ocr-progress";
pub const PROTECT_PROGRESS_EVENT: &str = "raiopdf-protect-progress";

/// Cooperative cancel flags for cancellable path ops, keyed by the
/// caller-generated job token. The UI mints the token before the command starts
/// so it can cancel while the Tauri invoke is still pending.
#[derive(Default)]
pub struct PathOpJobs {
    state: Mutex<PathOpJobState>,
}

#[derive(Default)]
pub struct ProtectedOutputTargets {
    targets: Mutex<HashMap<String, ProtectedOutputTarget>>,
}

struct ProtectedOutputTarget {
    path: PathBuf,
    baseline: OutputTargetBaseline,
    forbidden_sources: Vec<ForbiddenSource>,
    created_at: Instant,
}

struct ForbiddenSource {
    path: PathBuf,
    snapshot: InputSnapshot,
    sha256: [u8; 32],
}

enum OutputTargetBaseline {
    Absent,
    Existing {
        snapshot: InputSnapshot,
        sha256: [u8; 32],
        permissions: fs::Permissions,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedProtectedOutputTarget {
    pub target_token: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedCopySaved {
    pub file_grant: String,
    pub name: String,
    pub verification: core_ops::ProtectionVerification,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtectProgressPayload {
    job_token: String,
    phase: &'static str,
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

impl ProtectedOutputTargets {
    fn insert(&self, target: ProtectedOutputTarget) -> OpResult<String> {
        let token = Uuid::new_v4().to_string();
        let mut targets = self.targets.lock().map_err(|_| PathOpError {
            code: core_ops::ERR_IO,
            message: "protected-output target lock poisoned".to_string(),
        })?;
        prune_expired_protected_targets(&mut targets, Instant::now());
        targets.insert(token.clone(), target);
        Ok(token)
    }

    fn take(&self, token: &str) -> OpResult<ProtectedOutputTarget> {
        let mut targets = self.targets.lock().map_err(|_| PathOpError {
            code: core_ops::ERR_IO,
            message: "protected-output target lock poisoned".to_string(),
        })?;
        prune_expired_protected_targets(&mut targets, Instant::now());
        targets.remove(token).ok_or_else(|| PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "protected-output target token was not found".to_string(),
        })
    }

    fn release(&self, token: &str) -> OpResult<bool> {
        let mut targets = self.targets.lock().map_err(|_| PathOpError {
            code: core_ops::ERR_IO,
            message: "protected-output target lock poisoned".to_string(),
        })?;
        prune_expired_protected_targets(&mut targets, Instant::now());
        Ok(targets.remove(token).is_some())
    }
}

const PENDING_CANCEL_TTL: Duration = Duration::from_secs(60);
const PROTECTED_TARGET_TTL: Duration = Duration::from_secs(15 * 60);

fn prune_pending_cancelled(pending: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    pending.retain(|_, cancelled_at| now.duration_since(*cancelled_at) <= PENDING_CANCEL_TTL);
}

fn prune_expired_protected_targets(
    targets: &mut HashMap<String, ProtectedOutputTarget>,
    now: Instant,
) {
    targets.retain(|_, target| {
        now.checked_duration_since(target.created_at)
            .is_none_or(|age| age <= PROTECTED_TARGET_TTL)
    });
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BuildBinderExhibitPayload {
    Bytes {
        bytes: Vec<u8>,
        label: String,
        description: Option<String>,
        source_file_name: Option<String>,
    },
    Grant {
        grant: String,
        size_bytes: u64,
        page_count: Option<u32>,
        label: String,
        description: Option<String>,
        source_file_name: Option<String>,
    },
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
    flatten: bool,
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
    #[serde(default)]
    pub flatten: bool,
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
    pub resources: PathOpsResourceStatus,
    /// PrepPlanStepId → registered op name (null when no path op implements
    /// the step). The streamed filing checklist enables a step ⟺ this maps to
    /// an op AND that op is available.
    pub filing_steps: BTreeMap<&'static str, Option<&'static str>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOpsResourceStatus {
    pub large_doc_threshold_bytes: u64,
    pub node_lane_max_bytes: u64,
    pub temp_dir_available_bytes: Option<u64>,
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

fn protected_copy_platform_error() -> Option<PathOpError> {
    if cfg!(target_os = "windows") {
        None
    } else {
        Some(PathOpError {
            code: core_ops::ERR_TOOLCHAIN_MISSING,
            message: "Protected PDF creation is currently available only in the installed RaioPDF app for Windows."
                .to_string(),
        })
    }
}

fn require_protected_copy_platform() -> OpResult<()> {
    protected_copy_platform_error().map_or(Ok(()), Err)
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

fn temp_dir_available_bytes(app: &tauri::AppHandle) -> Option<u64> {
    let root = path_ops_root(app).ok()?;
    fs::create_dir_all(&root).ok()?;
    fs2::available_space(root).ok()
}

/// Name of the per-op-dir marker file recording the owning instance id.
pub const OWNER_MARKER_FILE_NAME: &str = ".raio-owner";

/// Marker content recording that the creating process had no instance
/// identity (its advisory lock file could not be created or locked). Such
/// dirs cannot be liveness-probed, so the sweep must NOT put them on the
/// short legacy grace path — a still-running identity-less instance would
/// have its live outputs deleted by any second instance started a minute
/// later. Real instance ids are UUIDs, so this sentinel can never collide.
const UNIDENTIFIED_OWNER_MARKER: &str = "unidentified";

/// How long an *unowned* dir (no readable owner marker) is left alone before
/// the sweep reclaims it. Covers the instant between `create_dir` and the
/// marker write in a concurrently-starting instance; genuinely stale legacy
/// dirs (pre-ownership versions, or an instance that died mid-create) age past
/// it and are swept on a later startup.
const UNOWNED_DIR_SWEEP_GRACE: Duration = Duration::from_secs(60);

/// How long an `unidentified`-marked dir survives before reclaim. With no
/// liveness to probe, err far on the side of keeping it: a week comfortably
/// outlives any realistic session, while dirs from crashed identity-less runs
/// are still eventually reclaimed instead of accumulating forever.
const UNIDENTIFIED_DIR_SWEEP_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Startup sweep (large-pdf-handling housekeeping): file grants live only in
/// memory, so a leftover `<app-data>/path-ops/<uuid>/` dir is unreachable once
/// the process that created it has exited. Several instances can run at once
/// ("Open in New Window", the `.pdf` file association), so the sweep is
/// ownership-aware: a dir is deleted only when its owner marker names a dead
/// instance (or it has no marker and is older than the grace window). Runs on
/// a background thread from `setup` so a multi-hundred-MB stale output never
/// delays startup.
pub fn purge_stale_outputs(app_data_dir: &Path) {
    let root = app_data_dir.join(PATH_OPS_DIR);
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if should_sweep_output_dir(
                    &path,
                    UNOWNED_DIR_SWEEP_GRACE,
                    UNIDENTIFIED_DIR_SWEEP_GRACE,
                    |owner_id| crate::instance::owner_liveness(app_data_dir, owner_id),
                ) {
                    let _ = fs::remove_dir_all(&path);
                }
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }
    // Lock files of instances that are gone have nothing left to protect.
    crate::instance::sweep_dead_instance_locks(app_data_dir);
}

/// How one per-op dir's `.raio-owner` marker classifies for the sweep.
enum DirOwnership {
    /// Marker names an instance id — liveness decides the dir's fate.
    Owned(String),
    /// Marker carries the identity-less sentinel: the creator had no lock to
    /// probe, so the dir is preserved on the long horizon instead.
    Unidentified,
    /// No readable/valid marker — a legacy or mid-create dir on short grace.
    Unowned,
}

/// The sweep decision for one per-op dir, with liveness injectable for tests:
/// an owned dir lives exactly as long as its owning instance might still hold
/// grants into it; an identity-less dir is never treated as stale while its
/// long grace runs (ownership is ambiguous — prefer keeping it); an unowned
/// dir is reclaimed once it is old enough that no concurrently-starting
/// instance can still be about to mark it.
fn should_sweep_output_dir(
    dir: &Path,
    unowned_grace: Duration,
    unidentified_grace: Duration,
    liveness_of: impl Fn(&str) -> crate::instance::Liveness,
) -> bool {
    match dir_ownership(dir) {
        DirOwnership::Owned(owner_id) => match liveness_of(&owner_id) {
            crate::instance::Liveness::Dead => true,
            // Unknown must not delete: a live instance may hold grants here.
            crate::instance::Liveness::Alive | crate::instance::Liveness::Unknown => false,
        },
        DirOwnership::Unidentified => dir_is_older_than(dir, unidentified_grace),
        DirOwnership::Unowned => dir_is_older_than(dir, unowned_grace),
    }
}

fn dir_ownership(dir: &Path) -> DirOwnership {
    let Ok(content) = fs::read_to_string(dir.join(OWNER_MARKER_FILE_NAME)) else {
        return DirOwnership::Unowned;
    };
    let id = content.trim();
    // Sentinel first: it would also pass the owner-id shape check, and must
    // never be liveness-probed (no lock file exists for it by definition).
    if id == UNIDENTIFIED_OWNER_MARKER {
        return DirOwnership::Unidentified;
    }
    if crate::instance::is_valid_owner_id(id) {
        return DirOwnership::Owned(id.to_string());
    }
    DirOwnership::Unowned
}

fn dir_is_older_than(dir: &Path, grace: Duration) -> bool {
    match fs::metadata(dir).and_then(|metadata| metadata.modified()) {
        Ok(modified) => match SystemTime::now().duration_since(modified) {
            Ok(age) => age >= grace,
            // Modified "in the future" (clock change) — keep; a later startup
            // will age it out.
            Err(_) => false,
        },
        // A dir we cannot even stat cannot be protected — reclaim it.
        Err(_) => true,
    }
}

/// Best-effort: record the calling instance as the owner of `dir`. A process
/// with no instance identity (its lock could not be acquired) writes the
/// `unidentified` sentinel instead, which parks the dir on the long-horizon
/// grace — a live identity-less run must never land on the 60-second legacy
/// path where a second instance's sweep would delete its in-use outputs.
/// Only if this write itself also fails does the dir fall back to unowned.
pub(crate) fn mark_dir_owned_by_current_instance(dir: &Path) {
    let owner = crate::instance::current()
        .map(|identity| identity.id())
        .unwrap_or(UNIDENTIFIED_OWNER_MARKER);
    let _ = fs::write(dir.join(OWNER_MARKER_FILE_NAME), format!("{owner}\n"));
}

/// Adopt ownership of the per-op output dir containing `path`, when `path` is
/// a path-ops output. Used when this instance is launched to open another
/// instance's converted output ("Open in New Window"): re-marking the dir with
/// our id keeps it alive after the spawning instance exits, instead of being
/// swept out from under the file we were started to display.
pub fn adopt_containing_output_dir(app_data_dir: &Path, path: &Path) {
    if let Some(dir) = containing_output_dir(app_data_dir, path) {
        mark_dir_owned_by_current_instance(&dir);
    }
}

/// The `<path-ops>/<uuid>/` dir containing `path`, if and only if `path`
/// really is a path-ops output. Canonicalizes both sides so a user file that
/// merely resembles the layout can never be classified as adoptable.
fn containing_output_dir(app_data_dir: &Path, path: &Path) -> Option<PathBuf> {
    let root = fs::canonicalize(app_data_dir.join(PATH_OPS_DIR)).ok()?;
    let path = fs::canonicalize(path).ok()?;
    releasable_output_dir(&path, &root)
}

/// True when an existing path, or the existing parent of a new path, resolves
/// inside the private path-ops root. The lexical check also fails closed while
/// the root is absent; canonicalization catches aliases through symlinks.
fn path_resolves_within_root(path: &Path, root: &Path) -> bool {
    if path.starts_with(root) {
        return true;
    }
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    let resolved = fs::canonicalize(path).or_else(|_| {
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("path has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| std::io::Error::other("path has no file name"))?;
        Ok::<PathBuf, std::io::Error>(fs::canonicalize(parent)?.join(name))
    });
    resolved.is_ok_and(|path| path.starts_with(root))
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
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent).map_err(|error| PathOpError {
                code: "IO_ERROR",
                message: format!("failed to create path-ops parent: {error}"),
            })?;
        }
        core_ops::ensure_private_dir(&root)?;
        let dir = root.join(Uuid::new_v4().to_string());
        core_ops::create_private_dir(&dir)?;
        // Owner marker keeps a concurrent instance's startup sweep from
        // deleting this dir while we are alive and may hold grants into it.
        mark_dir_owned_by_current_instance(&dir);
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
    // Only the lane-specific heap cap lives here; the security flag is owned
    // by the one-shot spawn choke point (`mcp::one_shot_node_options`), which
    // appends it to whatever this produces.
    let heap = format!("--max-old-space-size={NODE_LANE_HEAP_MB}");
    match std::env::var("NODE_OPTIONS") {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing} {heap}"),
        _ => heap,
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

/// The release core, without the Tauri handle so it can be exercised directly
/// in tests: resolve the grant, refuse anything that is not a per-op temp
/// output directly under `root` (a user's own file is never deleted), then
/// drop the grant and remove the whole per-op dir. Shared with
/// `path_op_release_output` so tests cover the real root/gate/delete path
/// rather than a reproduction of it.
pub(crate) fn release_output_grant(
    grants: &FileGrants,
    grant: &str,
    root: &Path,
) -> Result<(), PathOpError> {
    let path = grants.resolve(grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })?;
    let Some(dir) = releasable_output_dir(&path, root) else {
        return Err(PathOpError {
            code: "INVALID_INPUT",
            message: "grant does not reference a path-op output".to_string(),
        });
    };
    grants.remove(grant);
    fs::remove_dir_all(&dir).map_err(|error| PathOpError {
        code: "IO_ERROR",
        message: format!("failed to delete path-op output: {error}"),
    })
}

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
    let root = path_ops_root(&app)?;
    release_output_grant(grants.inner(), &grant, &root)
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
            if op.name == "create_protected_copy" && protected_copy_platform_error().is_some() {
                op.available = false;
                if !op.missing_tools.contains(&"Windows installed app") {
                    op.missing_tools.push("Windows installed app");
                }
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
        resources: PathOpsResourceStatus {
            large_doc_threshold_bytes: large_doc_threshold_bytes(),
            node_lane_max_bytes: max_input_bytes,
            temp_dir_available_bytes: temp_dir_available_bytes(&app),
        },
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

#[tauri::command]
pub async fn path_op_inspect_protection(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    password: String,
) -> Result<core_ops::ProtectionFacts, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    on_blocking_pool(move || core_ops::inspect_protection(&toolchain, &input, &password, None))
        .await
}

#[tauri::command]
pub fn reveal_file_grant(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<(), PathOpError> {
    let path = resolve_grant(&grants, &grant)?;
    if !path.is_file() {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "The saved PDF is no longer available.".to_string(),
        });
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| PathOpError {
            code: core_ops::ERR_IO,
            message: format!("Could not show the saved PDF: {error}"),
        })
}

/// Open a finished package-root folder in the system file manager. Package
/// roots are path-addressed end-to-end (the workflow commands take the typed
/// `output_dir` string and return `package_root` as a display path, never a
/// grant), so this takes the same path the completion card shows — and only
/// ever opens an existing directory.
#[tauri::command]
pub fn open_package_root(app: tauri::AppHandle, path: String) -> Result<(), PathOpError> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "The package folder is no longer available.".to_string(),
        });
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| PathOpError {
            code: core_ops::ERR_IO,
            message: format!("Could not open the package folder: {error}"),
        })
}

/// Choose and snapshot a protected-copy destination before receiving any
/// password. The native dialog owns overwrite confirmation; this command then
/// refuses the open source and returns only an opaque, one-use target token.
#[tauri::command]
pub async fn pick_protected_output_target(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    targets: tauri::State<'_, ProtectedOutputTargets>,
    suggested_name: String,
    source_grants: Option<Vec<String>>,
) -> Result<Option<PickedProtectedOutputTarget>, PathOpError> {
    require_protected_copy_platform()?;
    let private_root = path_ops_root(&app)?;
    let sources = source_grants
        .unwrap_or_default()
        .iter()
        .map(|grant| resolve_grant(&grants, grant))
        .collect::<OpResult<Vec<_>>>()?;
    let default_directory = sources
        .first()
        .and_then(|source| source.parent())
        .filter(|directory| !path_resolves_within_root(directory, &private_root))
        .map(Path::to_path_buf);
    let suggested_name = if suggested_name.to_ascii_lowercase().ends_with(".pdf") {
        suggested_name
    } else {
        format!("{suggested_name}.pdf")
    };
    let destination = on_blocking_pool(move || {
        let dialog = app
            .dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .set_file_name(suggested_name);
        let dialog = match default_directory {
            Some(directory) => dialog.set_directory(directory),
            None => dialog,
        };
        let Some(destination) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        destination
            .into_path()
            .map(Some)
            .map_err(|error| PathOpError {
                code: core_ops::ERR_INVALID_INPUT,
                message: error.to_string(),
            })
    })
    .await?;
    let Some(destination) = destination else {
        return Ok(None);
    };
    if path_resolves_within_root(&destination, &private_root) {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "Choose a permanent location outside RaioPDF's temporary working folders."
                .to_string(),
        });
    }
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "The protected copy must be saved as a PDF.".to_string(),
        });
    }
    if target_matches_any_source(&sources, &destination) {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "Choose a new file name. The open source PDF cannot be replaced.".to_string(),
        });
    }
    let baseline = capture_output_target_baseline(&destination)?;
    let forbidden_sources = sources
        .iter()
        .map(|path| {
            Ok(ForbiddenSource {
                path: path.clone(),
                snapshot: snapshot(path)?,
                sha256: sha256_file(path)?,
            })
        })
        .collect::<OpResult<Vec<_>>>()?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("protected.pdf")
        .to_string();
    let target_token = targets.insert(ProtectedOutputTarget {
        path: destination,
        baseline,
        forbidden_sources,
        created_at: Instant::now(),
    })?;
    Ok(Some(PickedProtectedOutputTarget { target_token, name }))
}

/// Explicitly discard an unused one-use target token. Callers use this in a
/// `finally` path when the panel closes or the protect request never starts.
#[tauri::command]
pub fn release_protected_output_target(
    targets: tauri::State<'_, ProtectedOutputTargets>,
    target_token: String,
) -> Result<bool, PathOpError> {
    targets.release(&target_token)
}

/// Encrypt into a fresh private sibling candidate, verify, recheck both the
/// source hash and target snapshot, then atomically publish by no-clobber hard
/// publication (with rollback when replacing a previously confirmed target).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes command parameters as the IPC contract.
pub async fn protect_to_target(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    targets: tauri::State<'_, ProtectedOutputTargets>,
    jobs: tauri::State<'_, PathOpJobs>,
    input_grant: String,
    target_token: String,
    open_password: String,
    allow_printing: bool,
    allow_copying: bool,
    job_token: Option<String>,
) -> Result<ProtectedCopySaved, PathOpError> {
    require_protected_copy_platform()?;
    let input = resolve_grant(&grants, &input_grant)?;
    let input_before = snapshot(&input)?;
    ensure_grant_snapshot_unchanged(&grants, &input_grant, &input_before)?;
    let target = targets.take(&target_token)?;
    if same_existing_file(&input, &target.path)
        || target
            .forbidden_sources
            .iter()
            .any(|source| same_existing_file(&source.path, &target.path))
    {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: "The protected copy cannot replace the open source PDF.".to_string(),
        });
    }
    ensure_output_target_unchanged(&target.path, &target.baseline)?;
    ensure_forbidden_sources_unchanged(&target.forbidden_sources)?;
    let cancel_flag = match job_token.as_deref() {
        Some(token) => Some(jobs.register(token)?),
        None => None,
    };
    let cleanup_token = job_token.clone();
    if let Some(job_token) = job_token.as_ref() {
        let _ = app.emit(
            PROTECT_PROGRESS_EVENT,
            ProtectProgressPayload {
                job_token: job_token.clone(),
                phase: "encrypting",
            },
        );
    }
    let progress_app = app.clone();
    let progress_job_token = job_token.clone();
    let toolchain = discover_toolchain(&app);
    let destination = target.path.clone();
    let result = on_blocking_pool(move || {
        let source_sha256 = sha256_file(&input)?;
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        let candidate_dir = SiblingCandidateDir::create(parent)?;
        let candidate = candidate_dir.path().join("protected.pdf");
        let verification = core_ops::protect_with_verification_callback(
            &toolchain,
            &input,
            &open_password,
            &core_ops::ProtectionOptions {
                allow_printing,
                allow_copying,
            },
            &candidate,
            cancel_flag.clone(),
            move || {
                if let Some(job_token) = progress_job_token {
                    let _ = progress_app.emit(
                        PROTECT_PROGRESS_EVENT,
                        ProtectProgressPayload {
                            job_token,
                            phase: "verifying",
                        },
                    );
                }
            },
        )?;
        ensure_unchanged(&input, input_before)?;
        if sha256_file(&input)? != source_sha256 {
            return Err(PathOpError {
                code: ERR_FILE_CHANGED,
                message: "This file changed on disk — reopen it.".to_string(),
            });
        }
        ensure_output_target_unchanged(&destination, &target.baseline)?;
        ensure_forbidden_sources_unchanged(&target.forbidden_sources)?;
        ensure_not_cancelled(cancel_flag.as_ref())?;
        commit_verified_candidate(&candidate, &destination, &target.baseline)?;
        Ok((destination, verification))
    })
    .await;
    if let Some(token) = cleanup_token {
        jobs.remove(&token);
    }
    let (destination, verification) = result?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("protected.pdf")
        .to_string();
    let file_grant = issue_grant(&grants, &destination)?;
    Ok(ProtectedCopySaved {
        file_grant,
        name,
        verification,
    })
}

struct SiblingCandidateDir(PathBuf);

impl SiblingCandidateDir {
    fn create(parent: &Path) -> OpResult<Self> {
        for _ in 0..16 {
            let path = parent.join(format!(".raiopdf-protect-{}", Uuid::new_v4()));
            match core_ops::create_private_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(_error) if path.exists() => continue,
                Err(error) => return Err(error),
            }
        }
        Err(PathOpError {
            code: core_ops::ERR_IO,
            message: "could not create protected-copy candidate directory".to_string(),
        })
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for SiblingCandidateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn capture_output_target_baseline(path: &Path) -> OpResult<OutputTargetBaseline> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(PathOpError {
                    code: core_ops::ERR_INVALID_INPUT,
                    message: "The protected-copy destination must be a regular file.".to_string(),
                });
            }
            Ok(OutputTargetBaseline::Existing {
                snapshot: snapshot(path)?,
                sha256: sha256_file(path)?,
                permissions: metadata.permissions(),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(OutputTargetBaseline::Absent)
        }
        Err(error) => Err(PathOpError {
            code: core_ops::ERR_IO,
            message: format!("could not inspect protected-copy destination: {error}"),
        }),
    }
}

fn ensure_output_target_unchanged(path: &Path, baseline: &OutputTargetBaseline) -> OpResult<()> {
    match baseline {
        OutputTargetBaseline::Absent => match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(PathOpError {
                code: ERR_FILE_CHANGED,
                message: "The selected output file changed. Choose it again.".to_string(),
            }),
        },
        OutputTargetBaseline::Existing {
            snapshot: before,
            sha256,
            ..
        } => {
            let metadata = fs::symlink_metadata(path).map_err(|_| PathOpError {
                code: ERR_FILE_CHANGED,
                message: "The selected output file changed. Choose it again.".to_string(),
            })?;
            if metadata.file_type().is_symlink()
                || snapshot(path)? != *before
                || sha256_file(path)? != *sha256
            {
                return Err(PathOpError {
                    code: ERR_FILE_CHANGED,
                    message: "The selected output file changed. Choose it again.".to_string(),
                });
            }
            Ok(())
        }
    }
}

fn commit_verified_candidate(
    candidate: &Path,
    destination: &Path,
    baseline: &OutputTargetBaseline,
) -> OpResult<()> {
    commit_verified_candidate_with_sync(candidate, destination, baseline, sync_committed_file)
}

#[cfg(not(target_os = "windows"))]
fn sync_committed_file(path: &Path) -> std::io::Result<()> {
    fs::File::open(path).and_then(|file| file.sync_all())
}

#[cfg(target_os = "windows")]
fn sync_committed_file(_path: &Path) -> std::io::Result<()> {
    // The candidate is flushed before publication and ReplaceFileW uses
    // REPLACEFILE_WRITE_THROUGH. Opening the committed file read-only and
    // calling FlushFileBuffers fails with ERROR_ACCESS_DENIED on Windows.
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn sync_candidate_file(path: &Path) -> std::io::Result<()> {
    fs::File::open(path).and_then(|file| file.sync_all())
}

#[cfg(target_os = "windows")]
fn sync_candidate_file(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
}

fn commit_verified_candidate_with_sync<F>(
    candidate: &Path,
    destination: &Path,
    baseline: &OutputTargetBaseline,
    sync_destination: F,
) -> OpResult<()>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    sync_candidate_file(candidate).map_err(|error| PathOpError {
        code: core_ops::ERR_IO,
        message: format!("could not sync protected-copy candidate: {error}"),
    })?;
    if let OutputTargetBaseline::Existing { permissions, .. } = baseline {
        fs::set_permissions(candidate, permissions.clone()).map_err(|error| PathOpError {
            code: core_ops::ERR_IO,
            message: format!("could not preserve output permissions: {error}"),
        })?;
    }

    ensure_output_target_unchanged(destination, baseline)?;
    let backup = parent.join(format!(".raiopdf-protect-backup-{}", Uuid::new_v4()));
    let replaced_existing = matches!(baseline, OutputTargetBaseline::Existing { .. });
    if replaced_existing {
        atomic_replace_existing(candidate, destination, &backup, baseline)?;
    } else if let Err(error) = atomic_publish_absent(candidate, destination) {
        return Err(PathOpError {
            code: core_ops::ERR_IO,
            message: format!("could not commit the protected copy without clobbering: {error}"),
        });
    }

    if let Err(error) = sync_destination(destination) {
        if replaced_existing {
            return rollback_publication_failure(
                destination,
                &backup,
                format!("could not sync the protected copy: {error}"),
            );
        }
        let cleanup = fs::remove_file(destination);
        return Err(PathOpError {
            code: core_ops::ERR_IO,
            message: match cleanup {
                Ok(()) => format!("could not sync the protected copy: {error}"),
                Err(cleanup_error) => format!(
                    "could not sync the protected copy: {error}; removing the unpublished output also failed: {cleanup_error}"
                ),
            },
        });
    }

    if let Err(error) = sync_parent_directory(parent) {
        if replaced_existing {
            return rollback_publication_failure(
                destination,
                &backup,
                format!("could not sync the protected-copy directory: {error}"),
            );
        }
        let cleanup = fs::remove_file(destination);
        return Err(PathOpError {
            code: core_ops::ERR_IO,
            message: match cleanup {
                Ok(()) => format!("could not sync the protected-copy directory: {error}"),
                Err(cleanup_error) => format!(
                    "could not sync the protected-copy directory: {error}; removing the unpublished output also failed: {cleanup_error}"
                ),
            },
        });
    }

    if replaced_existing {
        fs::remove_file(&backup).map_err(|error| PathOpError {
            code: core_ops::ERR_IO,
            message: format!(
                "The protected copy was saved, but its private rollback backup could not be removed: {error}"
            ),
        })?;
    } else {
        // Unix publication retains the private hard-link candidate; Windows
        // MoveFileExW consumes it. The RAII directory guard is a second cleanup
        // attempt if the Unix unlink is interrupted.
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| PathOpError {
                code: core_ops::ERR_IO,
                message: format!("The protected copy was saved, but its private candidate could not be removed: {error}"),
            })?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn atomic_publish_absent(candidate: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(candidate, destination)
}

#[cfg(target_os = "windows")]
fn atomic_publish_absent(candidate: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let candidate = wide(candidate);
    let destination = wide(destination);
    let moved = unsafe {
        MoveFileExW(
            candidate.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_existing(
    candidate: &Path,
    destination: &Path,
    backup: &Path,
    baseline: &OutputTargetBaseline,
) -> OpResult<()> {
    fs::hard_link(destination, backup).map_err(|error| PathOpError {
        code: ERR_FILE_CHANGED,
        message: format!("The selected output file could not be snapshotted: {error}"),
    })?;
    if let Err(error) = ensure_output_target_unchanged(backup, baseline) {
        return match fs::remove_file(backup) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(PathOpError {
                code: error.code,
                message: format!(
                    "{} Removing the private rollback backup also failed: {cleanup_error}",
                    error.message
                ),
            }),
        };
    }
    if let Err(error) = fs::rename(candidate, destination) {
        return match fs::remove_file(backup) {
            Ok(()) => Err(PathOpError {
                code: core_ops::ERR_IO,
                message: format!("could not atomically replace the protected copy: {error}"),
            }),
            Err(cleanup_error) => Err(PathOpError {
                code: core_ops::ERR_IO,
                message: format!(
                    "could not atomically replace the protected copy: {error}; removing the private rollback backup also failed: {cleanup_error}"
                ),
            }),
        };
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn atomic_replace_existing(
    candidate: &Path,
    destination: &Path,
    backup: &Path,
    baseline: &OutputTargetBaseline,
) -> OpResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination_wide = wide(destination);
    let candidate_wide = wide(candidate);
    let backup_wide = wide(backup);
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            candidate_wide.as_ptr(),
            backup_wide.as_ptr(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        let replace_error = std::io::Error::last_os_error();
        if backup.exists() {
            let rollback = if destination.exists() {
                atomic_restore_backup(destination, backup)
            } else {
                fs::rename(backup, destination)
            };
            return Err(PathOpError {
                code: ERR_FILE_CHANGED,
                message: match rollback {
                    Ok(()) => format!(
                        "The selected output file could not be atomically replaced: {replace_error}; the original destination was restored."
                    ),
                    Err(rollback_error) => format!(
                        "The selected output file could not be atomically replaced: {replace_error}; restoring the original destination also failed: {rollback_error}."
                    ),
                },
            });
        }
        return Err(PathOpError {
            code: ERR_FILE_CHANGED,
            message: format!(
                "The selected output file could not be atomically replaced: {}",
                replace_error
            ),
        });
    }
    verify_displaced_destination(destination, backup, baseline)
}

#[cfg(not(target_os = "windows"))]
fn atomic_restore_backup(destination: &Path, backup: &Path) -> std::io::Result<()> {
    fs::rename(backup, destination)
}

#[cfg(target_os = "windows")]
fn atomic_restore_backup(destination: &Path, backup: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination = wide(destination);
    let backup = wide(backup);
    let restored = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            backup.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if restored == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// `ReplaceFileW` atomically moves the destination it actually replaced into
/// `backup`. Verify that displaced file against the picker-time baseline so a
/// change in the final precheck→replace gap is restored instead of clobbered.
#[cfg(any(target_os = "windows", test))]
fn verify_displaced_destination(
    destination: &Path,
    backup: &Path,
    baseline: &OutputTargetBaseline,
) -> OpResult<()> {
    let Err(drift) = ensure_output_target_unchanged(backup, baseline) else {
        return Ok(());
    };
    match atomic_restore_backup(destination, backup) {
        Ok(()) => Err(PathOpError {
            code: ERR_FILE_CHANGED,
            message: format!(
                "{} The changed destination was restored.",
                drift.message
            ),
        }),
        Err(rollback_error) => Err(PathOpError {
            code: ERR_FILE_CHANGED,
            message: format!(
                "{} Restoring the changed destination also failed: {rollback_error}. A private rollback backup was retained beside the selected output.",
                drift.message
            ),
        }),
    }
}

fn rollback_publication_failure(
    destination: &Path,
    backup: &Path,
    failure: String,
) -> OpResult<()> {
    match atomic_restore_backup(destination, backup) {
        Ok(()) => Err(PathOpError {
            code: core_ops::ERR_IO,
            message: format!("{failure}; the original destination was restored."),
        }),
        Err(rollback_error) => Err(PathOpError {
            code: core_ops::ERR_IO,
            message: format!(
                "{failure}; restoring the original destination also failed: {rollback_error}. A private rollback backup was retained beside the selected output."
            ),
        }),
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent).and_then(|directory| directory.sync_all())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

fn same_existing_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn target_matches_any_source(sources: &[PathBuf], target: &Path) -> bool {
    sources
        .iter()
        .any(|source| same_existing_file(source, target))
}

fn sha256_file(path: &Path) -> OpResult<[u8; 32]> {
    let mut file = fs::File::open(path).map_err(|error| PathOpError {
        code: core_ops::ERR_IO,
        message: format!("could not read file for verification: {error}"),
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| PathOpError {
            code: core_ops::ERR_IO,
            message: format!("could not hash file for verification: {error}"),
        })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

fn ensure_forbidden_sources_unchanged(sources: &[ForbiddenSource]) -> OpResult<()> {
    for source in sources {
        if snapshot(&source.path)? != source.snapshot || sha256_file(&source.path)? != source.sha256
        {
            return Err(PathOpError {
                code: ERR_FILE_CHANGED,
                message: "An original source PDF changed on disk. Reopen it and try again."
                    .to_string(),
            });
        }
    }
    Ok(())
}

fn ensure_not_cancelled(cancel_flag: Option<&Arc<AtomicBool>>) -> OpResult<()> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(PathOpError {
            code: core_ops::ERR_CANCELLED,
            message: "Operation was cancelled.".to_string(),
        });
    }
    Ok(())
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
    let log_app = app.clone();
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
    // The UI collapses a failed op into one generic sentence, so the ocrmypdf /
    // tesseract diagnostics this error carries are otherwise lost the moment it
    // crosses the IPC boundary — leaving a failed OCR with no trace anywhere.
    if let Err(error) = &result {
        if let Some(diagnostics) = log_app.try_state::<crate::diagnostics::AppDiagnostics>() {
            let _ = diagnostics
                .record_shell_event("path_op_ocr", &format!("{}: {}", error.code, error.message));
        }
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
    ensure_grant_snapshot_unchanged(&grants, &grant, &before)?;
    let max_input_bytes = node_lane_max_bytes();

    let started = Instant::now();
    let mut total_input_bytes = before.len;
    let mut watched_inputs = vec![(input.clone(), before)];
    let mut exhibit_inputs = Vec::with_capacity(exhibits.len());

    for (index, exhibit) in exhibits.into_iter().enumerate() {
        match exhibit {
            BuildBinderExhibitPayload::Bytes {
                bytes,
                label,
                description,
                source_file_name,
            } => {
                total_input_bytes = total_input_bytes.saturating_add(bytes.len() as u64);
                let path = work_dir
                    .path()
                    .join(format!("exhibit-{:03}.pdf", index + 1));
                fs::write(&path, &bytes).map_err(|error| PathOpError {
                    code: core_ops::ERR_IO,
                    message: format!("failed to write exhibit temp file: {error}"),
                })?;
                exhibit_inputs.push(BuildBinderOneShotExhibit {
                    path: path_to_utf8(path, "Exhibit temp")?,
                    label,
                    description,
                    source_file_name,
                });
            }
            BuildBinderExhibitPayload::Grant {
                grant: exhibit_grant,
                size_bytes,
                page_count,
                label,
                description,
                source_file_name,
            } => {
                let path = resolve_grant(&grants, &exhibit_grant)?;
                let exhibit_before = snapshot(&path)?;
                ensure_grant_snapshot_unchanged(&grants, &exhibit_grant, &exhibit_before)?;
                total_input_bytes =
                    total_input_bytes.saturating_add(if size_bytes == exhibit_before.len {
                        size_bytes
                    } else {
                        exhibit_before.len
                    });
                let _ = page_count;
                watched_inputs.push((path.clone(), exhibit_before));
                exhibit_inputs.push(BuildBinderOneShotExhibit {
                    path: path_to_utf8(path, "Exhibit")?,
                    label,
                    description,
                    source_file_name,
                });
            }
        }
    }

    if total_input_bytes > max_input_bytes {
        return Err(PathOpError {
            code: core_ops::ERR_INVALID_INPUT,
            message: format!(
                "This binder is too large for Combine with Exhibits (combined input limit about {} MB). Try fewer exhibits or split the PDFs first.",
                max_input_bytes / (1024 * 1024)
            ),
        });
    }

    let request = BuildBinderOneShotInput {
        main_path: path_to_utf8(input.clone(), "Main document")?,
        exhibits: exhibit_inputs,
        options,
        output_path: path_to_utf8(output_path.clone(), "Binder output")?,
        max_input_bytes,
    };
    let timeout = node_lane_timeout(total_input_bytes);
    let mcp_options = crate::mcp::McpOneShotOptions {
        timeout: Some(timeout),
        node_options: Some(node_options_heap_arg()),
    };

    let (page_count, output_size) = {
        let output_path = output_path.clone();
        let toolchain = toolchain.clone();
        let watched_inputs = watched_inputs;
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
            for (path, before) in watched_inputs {
                ensure_unchanged(&path, before)?;
            }
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
            input_size_bytes: total_input_bytes,
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
        flatten: payload.flatten,
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

    use crate::instance::{InstanceIdentity, Liveness};

    fn make_output_dir(root: &Path, name: &str, owner_id: Option<&str>) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("create output dir");
        fs::write(dir.join("out.pdf"), b"pdf").expect("write output");
        if let Some(owner_id) = owner_id {
            fs::write(dir.join(OWNER_MARKER_FILE_NAME), format!("{owner_id}\n"))
                .expect("write owner marker");
        }
        dir
    }

    #[test]
    fn sweep_decision_removes_dead_owner_dir_and_keeps_live_or_unknown() {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = make_output_dir(root.path(), "uuid-a", Some("owner-1"));

        assert!(should_sweep_output_dir(
            &dir,
            Duration::ZERO,
            Duration::ZERO,
            |_| Liveness::Dead
        ));
        assert!(!should_sweep_output_dir(
            &dir,
            Duration::ZERO,
            Duration::ZERO,
            |_| Liveness::Alive
        ));
        // Undecidable liveness must never delete.
        assert!(!should_sweep_output_dir(
            &dir,
            Duration::ZERO,
            Duration::ZERO,
            |_| Liveness::Unknown
        ));
    }

    #[test]
    fn sweep_decision_removes_legacy_dir_after_grace_but_keeps_fresh_one() {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = make_output_dir(root.path(), "uuid-legacy", None);
        let never_called = |_: &str| -> Liveness { panic!("legacy dirs consult no liveness") };

        // A fresh markerless dir may belong to an instance that is mid-create.
        assert!(!should_sweep_output_dir(
            &dir,
            Duration::from_secs(3600),
            Duration::ZERO,
            never_called
        ));
        // Once past the grace window it is reclaimed like before.
        assert!(should_sweep_output_dir(
            &dir,
            Duration::ZERO,
            Duration::from_secs(3600),
            never_called
        ));
    }

    #[test]
    fn sweep_decision_treats_garbage_owner_marker_as_unowned() {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = make_output_dir(root.path(), "uuid-garbage", Some("../not a valid id"));

        assert!(should_sweep_output_dir(
            &dir,
            Duration::ZERO,
            Duration::from_secs(3600),
            |_| panic!("invalid ids consult no liveness")
        ));
    }

    #[test]
    fn identity_less_marked_dir_rides_the_long_horizon_not_the_legacy_grace() {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = root.path().join("uuid-unidentified");
        fs::create_dir_all(&dir).expect("create dir");
        // Tests never call `instance::init_current`, so `current()` is None —
        // exactly the identity-less mode this covers (Codex review, PR #237).
        mark_dir_owned_by_current_instance(&dir);
        assert_eq!(
            fs::read_to_string(dir.join(OWNER_MARKER_FILE_NAME)).expect("read marker"),
            format!("{UNIDENTIFIED_OWNER_MARKER}\n"),
        );
        let never_called = |_: &str| -> Liveness { panic!("sentinel consults no liveness") };

        // A second instance's sweep (past the 60s legacy grace, modeled here
        // as ZERO) must NOT reclaim a possibly-live identity-less dir…
        assert!(!should_sweep_output_dir(
            &dir,
            Duration::ZERO,
            Duration::from_secs(3600),
            never_called
        ));
        // …but a genuinely ancient one (long horizon elapsed) still goes.
        assert!(should_sweep_output_dir(
            &dir,
            Duration::from_secs(3600),
            Duration::ZERO,
            never_called
        ));
    }

    #[test]
    fn purge_sweeps_dead_owner_dirs_and_preserves_live_ones() {
        // The tempdir stands in for the whole app-data dir; path-ops/ and
        // instances/ live under it exactly like in production.
        let app_data = tempfile::tempdir().expect("temp dir");
        let root = app_data.path().join(PATH_OPS_DIR);
        let live = InstanceIdentity::acquire(app_data.path()).expect("acquire live");
        let dead = InstanceIdentity::acquire(app_data.path()).expect("acquire dead");
        let dead_id = dead.id().to_string();
        drop(dead);

        let live_dir = make_output_dir(&root, "uuid-live", Some(live.id()));
        let dead_dir = make_output_dir(&root, "uuid-dead", Some(&dead_id));
        // No lock file was ever created for this owner — dead by definition.
        let orphan_dir = make_output_dir(&root, "uuid-orphan", Some("00000000-no-such-owner"));
        // Fresh legacy dir: inside the grace window, so preserved this pass.
        let legacy_dir = make_output_dir(&root, "uuid-legacy", None);
        // Identity-less creator: preserved for the whole long horizon.
        let unidentified_dir =
            make_output_dir(&root, "uuid-unidentified", Some(UNIDENTIFIED_OWNER_MARKER));
        fs::write(root.join("loose.tmp"), b"tmp").expect("write loose");

        purge_stale_outputs(app_data.path());

        assert!(live_dir.exists());
        assert!(!dead_dir.exists());
        assert!(!orphan_dir.exists());
        assert!(legacy_dir.exists());
        assert!(unidentified_dir.exists());
        assert!(!root.join("loose.tmp").exists());
        // The root itself survives for the next op.
        assert!(root.exists());
    }

    #[test]
    fn purge_tolerates_a_missing_root() {
        purge_stale_outputs(Path::new("/definitely/not/present/app-data"));
    }

    #[test]
    fn containing_output_dir_classifies_only_path_op_outputs() {
        let app_data = tempfile::tempdir().expect("temp dir");
        let root = app_data.path().join(PATH_OPS_DIR);
        let output_dir = make_output_dir(&root, "uuid-adopt", Some("previous-owner"));
        let elsewhere = app_data.path().join("case.pdf");
        fs::write(&elsewhere, b"pdf").expect("write user file");

        assert_eq!(
            containing_output_dir(app_data.path(), &output_dir.join("out.pdf")),
            Some(fs::canonicalize(&output_dir).expect("canonical output dir")),
        );
        // A user's own file must never be classified as an adoptable output.
        assert_eq!(containing_output_dir(app_data.path(), &elsewhere), None);
        // Nested deeper than the one-uuid-dir layout is not an output either.
        let nested = output_dir.join("nested");
        fs::create_dir_all(&nested).expect("create nested");
        fs::write(nested.join("deep.pdf"), b"pdf").expect("write nested");
        assert_eq!(
            containing_output_dir(app_data.path(), &nested.join("deep.pdf")),
            None
        );
    }

    #[test]
    fn protected_outputs_cannot_resolve_inside_the_path_ops_root() {
        let app_data = tempfile::tempdir().expect("temp dir");
        let root = app_data.path().join(PATH_OPS_DIR);
        let output_dir = make_output_dir(&root, "uuid-source", Some("owner"));
        let outside = app_data.path().join("saved-protected.pdf");

        assert!(path_resolves_within_root(
            &output_dir.join("new-protected.pdf"),
            &root
        ));
        assert!(!path_resolves_within_root(&outside, &root));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&output_dir, app_data.path().join("output-alias"))
                .expect("symlink output dir");
            assert!(path_resolves_within_root(
                &app_data.path().join("output-alias/aliased-protected.pdf"),
                &root
            ));
        }
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
    fn protected_output_refuses_current_and_original_protected_source_identities() {
        let dir = tempfile::tempdir().expect("temp dir");
        let current = dir.path().join("current-unlocked.pdf");
        let original = dir.path().join("original-protected.pdf");
        let allowed = dir.path().join("new-protected.pdf");
        fs::write(&current, b"current").expect("write current");
        fs::write(&original, b"original").expect("write original");
        let sources = vec![current.clone(), original.clone()];

        assert!(target_matches_any_source(&sources, &current));
        assert!(target_matches_any_source(&sources, &original));
        assert!(!target_matches_any_source(&sources, &allowed));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn protected_copy_shell_boundary_is_windows_only() {
        let error = require_protected_copy_platform().unwrap_err();
        assert_eq!(error.code, core_ops::ERR_TOOLCHAIN_MISSING);
        assert!(error.message.contains("Windows"));
    }

    #[test]
    fn protected_output_commits_to_an_absent_target_without_residue() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("protected.pdf");
        let candidate_dir = SiblingCandidateDir::create(dir.path()).expect("candidate dir");
        let candidate_root = candidate_dir.path().to_path_buf();
        let candidate = candidate_root.join("protected.pdf");
        core_ops::write_private_file(&candidate, b"verified protected bytes").expect("candidate");

        commit_verified_candidate(&candidate, &destination, &OutputTargetBaseline::Absent)
            .expect("commit");
        drop(candidate_dir);

        assert_eq!(
            fs::read(&destination).expect("destination"),
            b"verified protected bytes"
        );
        assert!(!candidate_root.exists());
    }

    #[test]
    fn protected_output_absent_publish_never_clobbers_a_racing_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let candidate = dir.path().join("candidate.pdf");
        let destination = dir.path().join("protected.pdf");
        fs::write(&candidate, b"new verified bytes").expect("candidate");
        fs::write(&destination, b"racing destination").expect("destination");

        atomic_publish_absent(&candidate, &destination).unwrap_err();

        assert_eq!(
            fs::read(&destination).expect("destination"),
            b"racing destination"
        );
        assert_eq!(
            fs::read(&candidate).expect("candidate"),
            b"new verified bytes"
        );
    }

    #[test]
    fn protected_output_atomically_replaces_unchanged_existing_target_and_cleans_backup() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("protected.pdf");
        fs::write(&destination, b"old bytes").expect("old destination");
        let baseline = capture_output_target_baseline(&destination).expect("baseline");
        let candidate_dir = SiblingCandidateDir::create(dir.path()).expect("candidate dir");
        let candidate = candidate_dir.path().join("protected.pdf");
        core_ops::write_private_file(&candidate, b"new verified bytes").expect("candidate");

        commit_verified_candidate(&candidate, &destination, &baseline).expect("replace");

        assert_eq!(
            fs::read(&destination).expect("destination"),
            b"new verified bytes"
        );
        assert!(fs::read_dir(dir.path())
            .expect("list")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".raiopdf-protect-backup-")));
    }

    #[test]
    fn protected_output_restores_existing_target_when_post_replace_sync_fails() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("protected.pdf");
        fs::write(&destination, b"original bytes").expect("old destination");
        let baseline = capture_output_target_baseline(&destination).expect("baseline");
        let candidate_dir = SiblingCandidateDir::create(dir.path()).expect("candidate dir");
        let candidate = candidate_dir.path().join("protected.pdf");
        core_ops::write_private_file(&candidate, b"new verified bytes").expect("candidate");

        let error =
            commit_verified_candidate_with_sync(&candidate, &destination, &baseline, |_| {
                Err(std::io::Error::other("injected sync failure"))
            })
            .unwrap_err();

        assert_eq!(error.code, core_ops::ERR_IO);
        assert!(error.message.contains("original destination was restored"));
        assert_eq!(
            fs::read(&destination).expect("restored destination"),
            b"original bytes"
        );
        assert!(fs::read_dir(dir.path())
            .expect("list")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".raiopdf-protect-backup-")));
    }

    #[test]
    fn protected_output_restores_a_destination_that_changed_during_replace() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("protected.pdf");
        let backup = dir.path().join("private-backup");
        fs::write(&destination, b"original bytes").expect("original destination");
        let baseline = capture_output_target_baseline(&destination).expect("baseline");

        // Model the atomic post-ReplaceFileW state: our verified candidate is
        // published, while the destination it actually displaced is in backup.
        fs::write(&destination, b"verified protected bytes").expect("published candidate");
        fs::write(&backup, b"racing destination").expect("displaced destination");

        let error = verify_displaced_destination(&destination, &backup, &baseline).unwrap_err();

        assert_eq!(error.code, ERR_FILE_CHANGED);
        assert!(error.message.contains("changed destination was restored"));
        assert_eq!(
            fs::read(&destination).expect("restored destination"),
            b"racing destination"
        );
        assert!(!backup.exists());
    }

    #[test]
    fn protected_output_refuses_post_picker_target_drift() {
        let dir = tempfile::tempdir().expect("temp dir");
        let destination = dir.path().join("protected.pdf");
        fs::write(&destination, b"before").expect("before");
        let baseline = capture_output_target_baseline(&destination).expect("baseline");
        fs::write(&destination, b"after!").expect("drift");

        let error = ensure_output_target_unchanged(&destination, &baseline).unwrap_err();
        assert_eq!(error.code, ERR_FILE_CHANGED);
        assert_eq!(fs::read(&destination).expect("destination"), b"after!");
    }

    #[test]
    fn source_hash_detects_same_length_drift() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.pdf");
        fs::write(&source, b"aaaaaa").expect("source");
        let before = sha256_file(&source).expect("hash before");
        fs::write(&source, b"bbbbbb").expect("source drift");
        assert_ne!(sha256_file(&source).expect("hash after"), before);
    }

    #[test]
    fn protected_output_rechecks_every_bound_original_source_before_commit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let current = dir.path().join("current.pdf");
        let original = dir.path().join("original-protected.pdf");
        fs::write(&current, b"current").expect("current");
        fs::write(&original, b"original").expect("original");
        let sources = [&current, &original]
            .into_iter()
            .map(|path| ForbiddenSource {
                path: path.clone(),
                snapshot: snapshot(path).expect("snapshot"),
                sha256: sha256_file(path).expect("hash"),
            })
            .collect::<Vec<_>>();
        fs::write(&original, b"changed!").expect("drift original");

        let error = ensure_forbidden_sources_unchanged(&sources).unwrap_err();
        assert_eq!(error.code, ERR_FILE_CHANGED);
    }

    #[test]
    fn cancellation_is_refused_before_protected_output_commit() {
        let flag = Arc::new(AtomicBool::new(true));
        let error = ensure_not_cancelled(Some(&flag)).unwrap_err();
        assert_eq!(error.code, core_ops::ERR_CANCELLED);
    }

    #[test]
    fn unused_protected_target_tokens_release_and_expire() {
        let targets = ProtectedOutputTargets::default();
        let make_target = |created_at| ProtectedOutputTarget {
            path: PathBuf::from("unused.pdf"),
            baseline: OutputTargetBaseline::Absent,
            forbidden_sources: Vec::new(),
            created_at,
        };
        let released = targets.insert(make_target(Instant::now())).expect("token");
        assert!(targets.release(&released).expect("release"));
        assert!(!targets.release(&released).expect("one use"));

        let expired = targets
            .insert(make_target(
                Instant::now() - PROTECTED_TARGET_TTL - Duration::from_secs(1),
            ))
            .expect("expired token");
        let error = targets
            .take(&expired)
            .err()
            .expect("expired target rejected");
        assert_eq!(error.code, core_ops::ERR_INVALID_INPUT);
    }

    #[test]
    fn build_binder_exhibit_payload_accepts_camel_case_variant_fields() {
        let grant: BuildBinderExhibitPayload = serde_json::from_value(serde_json::json!({
            "kind": "grant",
            "grant": "grant-exhibit",
            "sizeBytes": 123456,
            "pageCount": 7,
            "label": "Exhibit A",
            "description": "Large exhibit",
            "sourceFileName": "large.pdf"
        }))
        .expect("deserialize grant exhibit");
        match grant {
            BuildBinderExhibitPayload::Grant {
                grant,
                size_bytes,
                page_count,
                source_file_name,
                ..
            } => {
                assert_eq!(grant, "grant-exhibit");
                assert_eq!(size_bytes, 123456);
                assert_eq!(page_count, Some(7));
                assert_eq!(source_file_name.as_deref(), Some("large.pdf"));
            }
            BuildBinderExhibitPayload::Bytes { .. } => panic!("expected grant exhibit"),
        }

        let bytes: BuildBinderExhibitPayload = serde_json::from_value(serde_json::json!({
            "kind": "bytes",
            "bytes": [1, 2, 3],
            "label": "Exhibit B",
            "sourceFileName": "small.pdf"
        }))
        .expect("deserialize byte exhibit");
        match bytes {
            BuildBinderExhibitPayload::Bytes {
                bytes,
                source_file_name,
                ..
            } => {
                assert_eq!(bytes, vec![1, 2, 3]);
                assert_eq!(source_file_name.as_deref(), Some("small.pdf"));
            }
            BuildBinderExhibitPayload::Grant { .. } => panic!("expected byte exhibit"),
        }
    }

    #[test]
    fn apply_edits_payload_allows_form_values_and_defaults_flatten_off() {
        let payload: ApplyEditsPayload = serde_json::from_value(serde_json::json!({
            "edits": [{
                "type": "formValues",
                "values": { "client.name": "Ada Lovelace", "approved": true }
            }],
            "outputName": "filled.pdf"
        }))
        .expect("deserialize apply payload");
        assert!(!payload.flatten);

        let dir = tempfile::tempdir().expect("temp dir");
        let mut edits = payload.edits;
        assert_eq!(
            materialize_apply_edit_temp_files(dir.path(), &mut edits).expect("materialize"),
            0
        );
        assert_eq!(edits[0]["type"], "formValues");
        assert_eq!(edits[0]["values"]["client.name"], "Ada Lovelace");

        let request = ApplyEditsOneShotInput {
            main_path: "/tmp/fillable.pdf".to_string(),
            edits,
            apply_options: None,
            flatten: true,
            output_path: "/tmp/filled.pdf".to_string(),
            max_input_bytes: 10_000_000,
        };
        assert_eq!(
            serde_json::to_value(request).expect("serialize")["flatten"],
            true
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
