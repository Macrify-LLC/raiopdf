//! Tauri command surface for the native streaming print pipeline (Lane F).
//!
//! Printing follows the PathOpsEngine discipline: the WebView sends a file
//! GRANT plus print options; the shell resolves the path and drives
//! `engine_sidecar_core::print_ops` on the blocking pool. Document bytes
//! never enter the WebView — Ghostscript reads the file from disk and talks
//! to the Windows spooler directly (`mswinpr2`), so any-size PDFs print
//! without Chromium ever holding the document.
//!
//! Long-running: progress is emitted as `raiopdf-print-progress` events keyed
//! by a caller-generated `jobToken`; `print_cancel` flips a cooperative flag
//! checked between Ghostscript invocations and between fallback parts.

use engine_sidecar_core::path_ops::{page_count, OpResult, PathOpError};
use engine_sidecar_core::print_ops as core_print;
use engine_sidecar_core::print_ops::{PageSegmentRange, PrintSelection, PrinterInfo};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Emitter;

use crate::path_ops::{
    discover_toolchain, ensure_unchanged, on_blocking_pool, resolve_grant, snapshot, OpWorkDir,
};
use crate::FileGrants;

pub const PRINT_PROGRESS_EVENT: &str = "raiopdf-print-progress";

/// Cooperative cancel flags for in-flight print jobs, keyed by the
/// caller-generated job token (the UI needs the token before the command
/// resolves, so the client mints it).
#[derive(Default)]
pub struct PrintJobs {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl PrintJobs {
    fn register(&self, token: &str) -> Result<Arc<AtomicBool>, PathOpError> {
        let mut flags = self.flags.lock().map_err(|_| PathOpError {
            code: "IO_ERROR",
            message: "print job lock poisoned".to_string(),
        })?;
        if flags.contains_key(token) {
            return Err(PathOpError {
                code: "INVALID_INPUT",
                message: "a print job with this token is already running".to_string(),
            });
        }
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(token.to_string(), flag.clone());
        Ok(flag)
    }

    fn cancel(&self, token: &str) -> bool {
        let Ok(flags) = self.flags.lock() else {
            return false;
        };
        match flags.get(token) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    fn remove(&self, token: &str) {
        if let Ok(mut flags) = self.flags.lock() {
            flags.remove(token);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintProgressPayload {
    job_token: String,
    phase: &'static str,
    current: u32,
    total: u32,
    /// 1-based page bounds for the current unit; 0/0 for a whole-document
    /// Ghostscript invocation (no page flags).
    first_page: u32,
    last_page: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintStatusResponse {
    /// Windows-first: false on macOS/Linux until those pipelines exist.
    pub platform_supported: bool,
    pub ghostscript: bool,
    /// The UI's single gate: platform + Ghostscript both present.
    pub available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResultResponse {
    /// "ghostscript" | "printto"
    pub method: &'static str,
    pub gs_invocations: u32,
    pub fallback_parts: u32,
    pub fallback_reason: Option<String>,
    /// The input changed on disk while printing ran — pages already went to
    /// the printer, so this is reported (not errored) for the UI to surface.
    pub input_changed: bool,
}

/// Print availability probe (registry/status entry for the UI gate).
#[tauri::command]
pub fn print_status(app: tauri::AppHandle) -> PrintStatusResponse {
    let toolchain = discover_toolchain(&app);
    let platform_supported = core_print::platform_supported();
    let ghostscript = toolchain.ghostscript.is_some();
    PrintStatusResponse {
        platform_supported,
        ghostscript,
        available: platform_supported && ghostscript,
    }
}

/// Enumerate installed printers (`[{ name, isDefault }]`).
#[tauri::command]
pub async fn print_list_printers() -> Result<Vec<PrinterInfo>, PathOpError> {
    on_blocking_pool(core_print::list_printers).await
}

/// Flip the cooperative cancel flag for a running job. Returns whether a
/// matching job existed; the job itself resolves with `PRINT_CANCELLED`.
#[tauri::command]
pub fn print_cancel(jobs: tauri::State<'_, PrintJobs>, job_token: String) -> bool {
    jobs.cancel(&job_token)
}

/// Print a granted file natively. `page_indexes` are zero-based (the UI's
/// `parsePageRanges` output); `None` prints the whole document. Copies are
/// sequential passes (1–99).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn print_pdf(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    jobs: tauri::State<'_, PrintJobs>,
    grant: String,
    job_token: String,
    printer: String,
    page_indexes: Option<Vec<u32>>,
    copies: Option<u32>,
) -> Result<PrintResultResponse, PathOpError> {
    if !core_print::platform_supported() {
        return Err(PathOpError {
            code: core_print::ERR_PRINT_NOT_SUPPORTED,
            message: "Native printing is not available on this platform yet.".to_string(),
        });
    }
    core_print::validate_printer_name(&printer)?;
    let copies = copies.unwrap_or(1);

    let selection = match &page_indexes {
        Some(indexes) => PrintSelection::Segments(core_print::contiguous_segments(indexes)?),
        None => PrintSelection::WholeDocument,
    };

    let input = resolve_grant(&grants, &grant)?;
    let toolchain = discover_toolchain(&app);
    // Fallback parts land in a path-ops style temp dir. Deleted when unused
    // (gs path / failure); KEPT when parts were handed to the OS pipeline —
    // the spooler may still be reading them — and swept on next startup.
    let work_dir = OpWorkDir::create(&app)?;

    let cancel_flag = jobs.register(&job_token)?;
    let result = {
        let app = app.clone();
        let input = input.clone();
        let job_token = job_token.clone();
        let work_path = work_dir.path().to_path_buf();
        let cancel_flag = cancel_flag.clone();
        on_blocking_pool(move || {
            run_print_job(
                &app,
                &toolchain,
                &input,
                &printer,
                &selection,
                copies,
                &job_token,
                &work_path,
                &cancel_flag,
            )
        })
        .await
    };
    jobs.remove(&job_token);

    match result {
        Ok(outcome) => {
            if outcome.method == "printto" && outcome.fallback_parts > 0 {
                // Parts may still be spooling in the OS handler — keep the
                // dir; the startup sweep reclaims it next launch.
                work_dir.keep();
            }
            Ok(outcome.into_response())
        }
        Err(error) => Err(error),
    }
}

struct JobOutcome {
    method: &'static str,
    gs_invocations: u32,
    fallback_parts: u32,
    fallback_reason: Option<String>,
    input_changed: bool,
}

impl JobOutcome {
    fn into_response(self) -> PrintResultResponse {
        PrintResultResponse {
            method: self.method,
            gs_invocations: self.gs_invocations,
            fallback_parts: self.fallback_parts,
            fallback_reason: self.fallback_reason,
            input_changed: self.input_changed,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_print_job(
    app: &tauri::AppHandle,
    toolchain: &engine_sidecar_core::path_ops::PathOpsToolchain,
    input: &std::path::Path,
    printer: &str,
    selection: &PrintSelection,
    copies: u32,
    job_token: &str,
    work_dir: &std::path::Path,
    cancel_flag: &AtomicBool,
) -> OpResult<JobOutcome> {
    // Printing is read-only, but a mid-print change on disk means the paper
    // may mix revisions — snapshot up front, report drift with the result.
    let before = snapshot(input)?;

    let mut gs_print = |segment: Option<PageSegmentRange>| -> OpResult<()> {
        core_print::gs_print_segment(toolchain, input, printer, segment)
    };
    let mut whole_doc_bounds = || -> OpResult<PageSegmentRange> {
        let total = page_count(toolchain, input)?;
        if total == 0 {
            return Err(PathOpError {
                code: "INVALID_INPUT",
                message: "document has no pages".to_string(),
            });
        }
        Ok(PageSegmentRange {
            first: 1,
            last: total,
        })
    };
    let mut fallback_allowed = core_print::ensure_printto_fallback_allowed;
    let mut split_part = |part: PageSegmentRange, index: u32| -> OpResult<PathBuf> {
        core_print::split_print_part(toolchain, input, part, index, work_dir)
    };
    let mut print_part = |part: &std::path::Path| -> OpResult<()> {
        core_print::print_part_via_printto(part, printer)
    };
    let mut progress = |event: core_print::PrintProgress| {
        let _ = app.emit(
            PRINT_PROGRESS_EVENT,
            PrintProgressPayload {
                job_token: job_token.to_string(),
                phase: event.phase,
                current: event.current,
                total: event.total,
                first_page: event.first_page,
                last_page: event.last_page,
            },
        );
    };
    let mut cancelled = || cancel_flag.load(Ordering::Relaxed);

    let outcome = core_print::execute_print_plan(
        selection,
        copies,
        &mut core_print::PrintRunners {
            gs_print: &mut gs_print,
            whole_doc_bounds: &mut whole_doc_bounds,
            fallback_allowed: &mut fallback_allowed,
            split_part: &mut split_part,
            print_part: &mut print_part,
            progress: &mut progress,
            cancelled: &mut cancelled,
        },
    )?;

    let input_changed = ensure_unchanged(input, before).is_err();
    Ok(JobOutcome {
        method: outcome.method,
        gs_invocations: outcome.gs_invocations,
        fallback_parts: outcome.fallback_parts,
        fallback_reason: outcome.fallback_reason,
        input_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_jobs_register_cancel_and_remove() {
        let jobs = PrintJobs::default();
        let flag = jobs.register("job-1").expect("register");
        assert!(!flag.load(Ordering::Relaxed));

        // Duplicate tokens are rejected while the job runs.
        assert!(jobs.register("job-1").is_err());

        assert!(jobs.cancel("job-1"));
        assert!(flag.load(Ordering::Relaxed));

        // Unknown tokens report no matching job.
        assert!(!jobs.cancel("job-2"));

        jobs.remove("job-1");
        assert!(!jobs.cancel("job-1"));
        // Token is reusable after removal.
        jobs.register("job-1").expect("re-register");
    }
}
