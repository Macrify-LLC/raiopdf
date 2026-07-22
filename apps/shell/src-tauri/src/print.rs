//! Tauri command surface for the native print pipeline (Lane F).
//!
//! Printing follows the PathOpsEngine discipline: the WebView sends a file
//! GRANT plus print options; the shell resolves the path and drives
//! `engine_sidecar_core::print_ops` on the blocking pool. Document bytes never
//! enter the WebView — the pipeline reads the file from disk. On Windows,
//! Ghostscript talks to the spooler directly (`mswinpr2`), segment by segment
//! with a `printto` fallback; on macOS, a single CUPS `lp` spool prints the
//! file at any size. Either way, Chromium never holds the document.
//!
//! Long-running (Windows): progress is emitted as `raiopdf-print-progress`
//! events keyed by a caller-generated `jobToken`; `print_cancel` flips a
//! cooperative flag checked between Ghostscript invocations and fallback parts.
//! The macOS `lp` spool is atomic — one pass, no per-segment progress or
//! cancel.

#[cfg(windows)]
use engine_sidecar_core::path_ops::page_count;
use engine_sidecar_core::path_ops::{OpResult, PathOpError};
use engine_sidecar_core::print_ops as core_print;
#[cfg(windows)]
use engine_sidecar_core::print_ops::PageSegmentRange;
use engine_sidecar_core::print_ops::{PrintOptions, PrintSelection, PrinterInfo};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
#[cfg(any(windows, unix))]
use tauri::Emitter;

#[cfg(windows)]
use crate::path_ops::OpWorkDir;
use crate::path_ops::{
    discover_toolchain, ensure_unchanged, on_blocking_pool, resolve_grant, snapshot,
};
use crate::FileGrants;

#[cfg(any(windows, unix))]
pub const PRINT_PROGRESS_EVENT: &str = "raiopdf-print-progress";

/// Cooperative cancel flags for in-flight print jobs, keyed by the
/// caller-generated job token (the UI needs the token before the command
/// resolves, so the client mints it).
#[derive(Default)]
struct PrintJobsState {
    /// Cancel flags for registered, in-flight jobs.
    flags: HashMap<String, Arc<AtomicBool>>,
    /// Tokens cancelled before their job registered. A Cancel click can beat
    /// `print_pdf` to `register` (the dock renders as soon as the dialog
    /// closes), so the intent is parked here and honored at registration.
    pending_cancels: HashSet<String>,
}

#[derive(Default)]
pub struct PrintJobs {
    state: Mutex<PrintJobsState>,
}

impl PrintJobs {
    fn register(&self, token: &str) -> Result<Arc<AtomicBool>, PathOpError> {
        let mut state = self.state.lock().map_err(|_| PathOpError {
            code: "IO_ERROR",
            message: "print job lock poisoned".to_string(),
        })?;
        if state.flags.contains_key(token) {
            return Err(PathOpError {
                code: "INVALID_INPUT",
                message: "a print job with this token is already running".to_string(),
            });
        }
        // Honor a Cancel that arrived before this job registered — start it
        // already-cancelled so it stops on its first check instead of printing.
        let pre_cancelled = state.pending_cancels.remove(token);
        let flag = Arc::new(AtomicBool::new(pre_cancelled));
        state.flags.insert(token.to_string(), flag.clone());
        Ok(flag)
    }

    fn cancel(&self, token: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if let Some(flag) = state.flags.get(token) {
            flag.store(true, Ordering::Relaxed);
            return true;
        }
        // The job hasn't registered yet — park the intent for `register`.
        state.pending_cancels.insert(token.to_string());
        true
    }

    fn remove(&self, token: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.flags.remove(token);
            // A token that finished without ever registering leaves no pending
            // entry to honor; drop it so the set can't accumulate.
            state.pending_cancels.remove(token);
        }
    }
}

#[cfg(any(windows, unix))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintProgressPayload {
    job_token: String,
    phase: &'static str,
    current: u32,
    total: u32,
    /// 1-based page bounds for the current unit; 0/0 for a whole-document
    /// Ghostscript invocation or a CUPS spool (no per-page granularity).
    first_page: u32,
    last_page: u32,
}

/// CUPS progress phases (macOS/Linux), emitted on `PRINT_PROGRESS_EVENT` so the
/// docked loader can track the job without the print dialog staying open.
#[cfg(unix)]
const PHASE_CUPS_QUEUED: &str = "cups-queued";
#[cfg(unix)]
const PHASE_CUPS_PRINTING: &str = "cups-printing";

/// Emit one CUPS progress phase for `job_token` (no per-page numbers — CUPS
/// spools whole; the UI shows an indeterminate meter keyed off the phase).
#[cfg(unix)]
fn emit_cups_phase(app: &tauri::AppHandle, job_token: &str, phase: &'static str) {
    let _ = app.emit(
        PRINT_PROGRESS_EVENT,
        PrintProgressPayload {
            job_token: job_token.to_string(),
            phase,
            current: 0,
            total: 0,
            first_page: 0,
            last_page: 0,
        },
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintStatusResponse {
    /// True on Windows and macOS; false on unsupported targets.
    pub platform_supported: bool,
    /// Whether the bundled Ghostscript toolchain is present (the Windows print
    /// driver). Not required on macOS, which prints through CUPS `lp`.
    pub ghostscript: bool,
    /// The UI's single gate. Windows needs platform + Ghostscript; macOS needs
    /// only the platform (CUPS ships with the OS).
    pub available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResultResponse {
    /// "ghostscript" | "printto" (Windows) | "cups" (macOS/Linux)
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
    let ghostscript = toolchain.ghostscript.is_some();
    PrintStatusResponse {
        platform_supported: core_print::platform_supported(),
        ghostscript,
        available: core_print::print_available(ghostscript),
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
    options: Option<PrintOptions>,
) -> Result<PrintResultResponse, PathOpError> {
    if !core_print::platform_supported() {
        return Err(PathOpError {
            code: core_print::ERR_PRINT_NOT_SUPPORTED,
            message: "Native printing is not available on this platform yet.".to_string(),
        });
    }
    core_print::validate_printer_name(&printer)?;
    let copies = normalize_copies(copies)?;
    let options = options.unwrap_or_default();
    core_print::validate_print_options(&options)?;

    let selection = match &page_indexes {
        Some(indexes) => PrintSelection::Segments(core_print::contiguous_segments(indexes)?),
        None => PrintSelection::WholeDocument,
    };

    let input = resolve_grant(&grants, &grant)?;
    let cancel_flag = jobs.register(&job_token)?;

    let result = execute_native_print(
        &app,
        input,
        printer,
        selection,
        copies,
        options,
        job_token.clone(),
        cancel_flag,
    )
    .await;
    jobs.remove(&job_token);

    result.map(JobOutcome::into_response)
}

/// Apply the command default and enforce the print contract before any
/// platform-specific work starts.
fn normalize_copies(copies: Option<u32>) -> OpResult<u32> {
    let copies = copies.unwrap_or(1);
    core_print::validate_copies(copies)?;
    Ok(copies)
}

/// Windows: drive the printer through Ghostscript segment-by-segment, with the
/// divide-and-queue `printto` fallback. Fallback parts land in a path-ops
/// style temp dir — deleted when unused (gs path / failure); KEPT when parts
/// were handed to the OS pipeline (the spooler may still be reading them) and
/// reclaimed by a later instance's startup sweep once this instance has
/// exited (the dir carries this instance's owner marker, so a concurrently-
/// running instance's sweep won't pull parts out from under the spooler).
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
async fn execute_native_print(
    app: &tauri::AppHandle,
    input: PathBuf,
    printer: String,
    selection: PrintSelection,
    copies: u32,
    // Paper size / duplex / orientation are a CUPS-path feature; the Windows
    // Ghostscript path doesn't consume them yet.
    _options: PrintOptions,
    job_token: String,
    cancel_flag: Arc<AtomicBool>,
) -> OpResult<JobOutcome> {
    let toolchain = discover_toolchain(app);
    let work_dir = OpWorkDir::create(app)?;
    let fallback_part_queued = Arc::new(AtomicBool::new(false));
    let result = {
        let app = app.clone();
        let work_path = work_dir.path().to_path_buf();
        let fallback_part_queued = fallback_part_queued.clone();
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
                &fallback_part_queued,
            )
        })
        .await
    };
    if should_keep_print_work_dir(&result, fallback_part_queued.load(Ordering::Relaxed)) {
        work_dir.keep();
    }
    result
}

/// macOS / Linux: spool the file straight to CUPS via `lp` — any size, page
/// range in a single pass, no bundled toolchain. `lp` is fast and atomic, so
/// there is no per-segment progress or mid-spool cancellation to thread
/// through; the job token is still registered upstream so the UI's cancel
/// wiring stays uniform across platforms.
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
async fn execute_native_print(
    app: &tauri::AppHandle,
    input: PathBuf,
    printer: String,
    selection: PrintSelection,
    copies: u32,
    options: PrintOptions,
    job_token: String,
    cancel_flag: Arc<AtomicBool>,
) -> OpResult<JobOutcome> {
    let app = app.clone();
    on_blocking_pool(move || {
        run_cups_print_job(
            &app,
            &input,
            &printer,
            &selection,
            copies,
            &options,
            &job_token,
            &cancel_flag,
        )
    })
    .await
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

#[cfg(windows)]
fn should_keep_print_work_dir(result: &OpResult<JobOutcome>, fallback_part_queued: bool) -> bool {
    fallback_part_queued
        || matches!(
            result,
            Ok(outcome) if outcome.method == "printto" && outcome.fallback_parts > 0
        )
}

/// macOS / Linux: snapshot the input, spool it via CUPS `lp`, then poll until
/// CUPS no longer reports the job active. This keeps the caller attached to
/// the queue instead of resolving as soon as CUPS accepts the spool.
///
/// While polling: emit progress phases so the docked loader can show a live
/// "printing" status without the print dialog staying open, and honor
/// cancellation by cancelling the CUPS job for real (the old fire-and-forget
/// `lp` spool had no cancel and no failure signal on macOS).
///
/// Completion vs. failure: CUPS' CLI cannot distinguish every clean finish
/// from every silent abort, so a job that leaves the active queue is treated
/// as done unless its printer went stopped/disabled, which is reported as a
/// failure.
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn run_cups_print_job(
    app: &tauri::AppHandle,
    input: &std::path::Path,
    printer: &str,
    selection: &PrintSelection,
    copies: u32,
    options: &PrintOptions,
    job_token: &str,
    cancel_flag: &AtomicBool,
) -> OpResult<JobOutcome> {
    use std::{thread::sleep, time::Duration};

    // Poll cadence and a safety cap (~2h of real printing) so a wedged queue
    // can never spin this loop forever.
    const POLL_INTERVAL: Duration = Duration::from_millis(750);
    const MAX_POLLS: u32 = 9_600;

    let before = snapshot(input)?;
    // A cancel can arrive before this job registered — `register` honors it by
    // pre-setting the flag. Check it before spooling so a pre-cancelled job is
    // never submitted to CUPS (otherwise a short job could finish printing
    // before the polling loop's first cancel check).
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(PathOpError {
            code: core_print::ERR_PRINT_CANCELLED,
            message: "Printing was cancelled.".to_string(),
        });
    }
    let job_id = core_print::lp_print(input, printer, selection, copies, options)?;
    emit_cups_phase(app, job_token, PHASE_CUPS_QUEUED);

    // The "printing" phase is emitted once, on the queued→printing edge —
    // the payload never changes after that, so re-emitting every tick would
    // just churn a re-render on the JS side for no visible change.
    let mut printing_emitted = false;
    let mut completed = false;
    for _ in 0..MAX_POLLS {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = core_print::cancel_cups_job(&job_id);
            return Err(PathOpError {
                code: core_print::ERR_PRINT_CANCELLED,
                message: "Printing was cancelled.".to_string(),
            });
        }
        if !core_print::cups_job_active(&job_id)? {
            if core_print::cups_printer_stopped(printer).unwrap_or(false) {
                return Err(PathOpError {
                    code: core_print::ERR_PRINT_FAILED,
                    message: format!(
                        "The print job stopped before finishing — {printer} halted. \
                         Check the printer and print again."
                    ),
                });
            }
            completed = true;
            break;
        }
        if !printing_emitted {
            emit_cups_phase(app, job_token, PHASE_CUPS_PRINTING);
            printing_emitted = true;
        }
        sleep(POLL_INTERVAL);
    }

    if !completed {
        // The job outlived the poll cap (a job printing for hours, or a
        // wedged queue). Leave it in the queue rather than cancel it — it
        // may yet finish — but report a failure so the UI never claims a
        // print completed that we simply stopped tracking.
        return Err(PathOpError {
            code: core_print::ERR_PRINT_FAILED,
            message: format!(
                "Printing is still going after a long wait — RaioPDF stopped tracking \
                 the job on {printer}. Check the printer; it may still finish."
            ),
        });
    }

    let input_changed = ensure_unchanged(input, before).is_err();
    Ok(JobOutcome {
        method: "cups",
        gs_invocations: 0,
        fallback_parts: 0,
        fallback_reason: None,
        input_changed,
    })
}

#[cfg(windows)]
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
    fallback_part_queued: &AtomicBool,
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
        let result = core_print::print_part_via_printto(part, printer);
        if result.is_ok() {
            fallback_part_queued.store(true, Ordering::Relaxed);
        }
        result
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

        jobs.remove("job-1");
        // Token is reusable after removal, and starts uncancelled.
        let flag = jobs.register("job-1").expect("re-register");
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[test]
    fn cancel_before_register_is_honored_at_registration() {
        let jobs = PrintJobs::default();
        // A Cancel click can land before the job registers its token; the
        // cancel is still accepted (returns true) with nothing registered yet.
        assert!(jobs.cancel("job-early"));
        // Registration then starts that job already-cancelled.
        let flag = jobs.register("job-early").expect("register");
        assert!(flag.load(Ordering::Relaxed));

        // The parked intent is one-shot — an unrelated token is unaffected.
        let fresh = jobs.register("job-fresh").expect("register");
        assert!(!fresh.load(Ordering::Relaxed));
    }

    #[test]
    fn normalize_copies_enforces_the_command_contract() {
        assert_eq!(normalize_copies(None).unwrap(), 1);
        assert_eq!(normalize_copies(Some(1)).unwrap(), 1);
        assert_eq!(normalize_copies(Some(99)).unwrap(), 99);
        for copies in [0, 100] {
            assert_eq!(
                normalize_copies(Some(copies)).unwrap_err().code,
                "INVALID_INPUT"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn print_work_dir_is_kept_after_fallback_part_was_queued() {
        let result = Err(PathOpError {
            code: core_print::ERR_PRINT_CANCELLED,
            message: "Printing was cancelled.".to_string(),
        });

        assert!(should_keep_print_work_dir(&result, true));
    }

    #[cfg(windows)]
    #[test]
    fn print_work_dir_is_kept_after_successful_fallback() {
        let result = Ok(JobOutcome {
            method: "printto",
            gs_invocations: 1,
            fallback_parts: 2,
            fallback_reason: Some("driver quirk".to_string()),
            input_changed: false,
        });

        assert!(should_keep_print_work_dir(&result, false));
    }

    #[cfg(windows)]
    #[test]
    fn print_work_dir_is_removed_before_fallback_parts_are_queued() {
        let result = Err(PathOpError {
            code: core_print::ERR_PRINT_NOT_SUPPORTED,
            message: "Native printing is not available on this platform yet.".to_string(),
        });

        assert!(!should_keep_print_work_dir(&result, false));
    }
}
