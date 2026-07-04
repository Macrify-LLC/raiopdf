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
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};
use tauri::Manager;
use uuid::Uuid;

use crate::FileGrants;

/// The input file changed on disk while the op ran (typed like Phase 1's
/// range-read snapshot error so the UI can share the "reopen it" message).
pub const ERR_FILE_CHANGED: &str = "FILE_CHANGED";

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    pub qpdf: bool,
    pub ghostscript: bool,
    pub ocrmypdf: bool,
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

fn discover_toolchain(app: &tauri::AppHandle) -> PathOpsToolchain {
    let resource_dir = app.path().resource_dir().ok();
    PathOpsToolchain::discover(resource_dir.as_deref())
}

/// Per-op working directory under app data. Kept on success (grants reference
/// files inside it), removed wholesale on failure.
struct OpWorkDir {
    dir: PathBuf,
    keep: bool,
}

impl OpWorkDir {
    fn create(app: &tauri::AppHandle) -> OpResult<Self> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| PathOpError {
                code: "IO_ERROR",
                message: format!("app data dir unavailable: {error}"),
            })?
            .join("path-ops");
        let dir = root.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).map_err(|error| PathOpError {
            code: "IO_ERROR",
            message: format!("failed to create path-ops temp dir: {error}"),
        })?;
        Ok(Self { dir, keep: false })
    }

    fn path(&self) -> &Path {
        &self.dir
    }

    fn keep(mut self) -> PathBuf {
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
struct InputSnapshot {
    len: u64,
    modified: Option<SystemTime>,
}

fn snapshot(path: &Path) -> OpResult<InputSnapshot> {
    let metadata = fs::metadata(path).map_err(|error| PathOpError {
        code: "IO_ERROR",
        message: format!("cannot stat input {}: {error}", path.display()),
    })?;
    Ok(InputSnapshot {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn ensure_unchanged(path: &Path, before: InputSnapshot) -> OpResult<()> {
    let after = snapshot(path)?;
    if after != before {
        return Err(PathOpError {
            code: ERR_FILE_CHANGED,
            message: "This file changed on disk while the operation ran — reopen it.".to_string(),
        });
    }
    Ok(())
}

fn resolve_grant(grants: &tauri::State<'_, FileGrants>, grant: &str) -> OpResult<PathBuf> {
    grants.resolve(grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })
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

async fn on_blocking_pool<T, F>(work: F) -> OpResult<T>
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
// Registry / status
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn path_ops_status(app: tauri::AppHandle) -> PathOpsStatusResponse {
    let toolchain = discover_toolchain(&app);
    let ops = core_ops::registry(&toolchain);

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
        },
        ops,
        filing_steps,
    }
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
    grant: String,
) -> Result<PathOpOutput, PathOpError> {
    run_single_output_op(
        app,
        grants,
        grant,
        OpSpec::new("ocr", "ocrmypdf", "ocr").note("existing text layers are kept (--skip-text)"),
        |toolchain, input, output, _work_dir| core_ops::ocr(toolchain, input, output),
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
    let input_size: u64 = inputs
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|m| m.len())
        .sum();
    let started = Instant::now();

    let (page_count, output_size) = {
        let inputs = inputs.clone();
        let output_path = output_path.clone();
        let toolchain = toolchain.clone();
        on_blocking_pool(move || {
            core_ops::merge(&toolchain, &inputs, &output_path)?;
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
    grant: String,
    plan: core_ops::PrepareFilingPlan,
) -> Result<PrepareFilingResponse, PathOpError> {
    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    // Intermediates live in a work dir that is ALWAYS deleted; final parts
    // live in a separate output dir kept only on success.
    let stage_dir = OpWorkDir::create(&app)?;
    let out_dir = OpWorkDir::create(&app)?;
    let before = snapshot(&input)?;
    let started = Instant::now();

    let outcome = {
        let input = input.clone();
        let stage_path = stage_dir.path().to_path_buf();
        let out_path = out_dir.path().to_path_buf();
        let toolchain = toolchain.clone();
        let plan = plan.clone();
        on_blocking_pool(move || {
            let outcome =
                core_ops::prepare_filing(&toolchain, &input, &plan, &stage_path, &out_path)?;
            ensure_unchanged(&input, before)?;
            Ok(outcome)
        })
        .await?
    };

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
