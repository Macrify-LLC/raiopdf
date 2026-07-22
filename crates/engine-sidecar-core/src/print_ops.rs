//! Native streaming print pipeline (large-pdf v1.1, Lane F).
//!
//! Any-size PDFs print without the WebView (or Chromium's print preview) ever
//! holding the document: the shell hands Ghostscript the file **path** and
//! Ghostscript drives the Windows printer directly (`mswinpr2` +
//! `%printer%<name>`), page range via `-dFirstPage`/`-dLastPage`, one
//! invocation per contiguous segment. If a Ghostscript print invocation fails
//! (driver quirk, missing gs), the pipeline falls back automatically to
//! divide-and-queue: qpdf-split the selection into ~150-page parts and hand
//! each part to the OS print pipeline sequentially (ShellExecute `printto`).
//!
//! Everything decision-shaped in here is pure and injectable so it is
//! unit-testable without a printer: argument construction, segment
//! normalization, fallback planning, queue sequencing, and cancellation are
//! all exercised with injected runners. Only the thin `#[cfg(windows)]`
//! shims actually talk to PowerShell / the spooler.

use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use crate::path_ops::{
    self, args, path_arg, run_ghostscript, OpResult, PathOpError, PathOpsToolchain,
    ERR_INVALID_INPUT,
};

// ---------------------------------------------------------------------------
// Error codes (extend the PathOpError vocabulary; same wire shape)
// ---------------------------------------------------------------------------

/// Printing is not supported on this platform (only Windows and macOS).
pub const ERR_PRINT_NOT_SUPPORTED: &str = "PRINT_NOT_SUPPORTED";
/// The user cancelled between segments/parts. Not a failure.
pub const ERR_PRINT_CANCELLED: &str = "PRINT_CANCELLED";
/// The divide-and-queue fallback would recurse into RaioPDF itself (RaioPDF
/// is the registered `printto` handler for .pdf) — refused, never recursed.
pub const ERR_PRINT_SELF_HANDLER: &str = "PRINT_FALLBACK_SELF_HANDLER";
/// A CUPS print job left the queue with its printer stopped (macOS): the queue
/// halted mid-job, so the document did not print completely. Reported instead
/// of a false "sent" once completion polling can see the failure.
pub const ERR_PRINT_FAILED: &str = "PRINT_FAILED";

/// CUPS localizes both `lp` acknowledgements and `lpstat` status lines; all
/// output parsed below must therefore use its documented C-locale wording.
#[cfg(unix)]
const CUPS_C_LOCALE: [(&str, &str); 1] = [("LC_ALL", "C")];

/// Reject an invalid copy count before it reaches a platform print backend.
/// Keeping this at the core boundary makes the command contract consistent
/// even when callers bypass the UI.
pub fn validate_copies(copies: u32) -> OpResult<()> {
    if !(1..=99).contains(&copies) {
        return Err(PathOpError {
            code: ERR_INVALID_INPUT,
            message: "copies must be between 1 and 99".to_string(),
        });
    }
    Ok(())
}

fn cancelled_error() -> PathOpError {
    PathOpError {
        code: ERR_PRINT_CANCELLED,
        message: "Printing was cancelled.".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Printer enumeration
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// Parse `Get-CimInstance Win32_Printer | Select-Object Name,Default |
/// ConvertTo-Json` output. PowerShell emits an array for many printers, a
/// bare object for exactly one, and nothing at all for zero.
pub fn parse_printer_list_json(json: &str) -> OpResult<Vec<PrinterInfo>> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|error| PathOpError {
        code: path_ops::ERR_OP_FAILED,
        message: format!("printer list parse error: {error}"),
    })?;

    let entries: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        object @ serde_json::Value::Object(_) => vec![object],
        _ => {
            return Err(PathOpError {
                code: path_ops::ERR_OP_FAILED,
                message: "printer list JSON is neither an object nor an array".to_string(),
            })
        }
    };

    let mut printers = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(name) = entry.get("Name").and_then(|value| value.as_str()) else {
            // A row without a name is unusable — skip it rather than failing
            // the whole enumeration.
            continue;
        };
        let is_default = entry
            .get("Default")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        printers.push(PrinterInfo {
            name: name.to_string(),
            is_default,
        });
    }
    Ok(printers)
}

/// Enumerate installed printers via PowerShell (`Win32_Printer` carries the
/// `Default` flag that `Get-Printer` does not expose). Zero new crate
/// dependencies; the JSON parsing above is fixture-tested.
#[cfg(windows)]
pub fn list_printers() -> OpResult<Vec<PrinterInfo>> {
    let output = path_ops::run_powershell(
        "Get-CimInstance -ClassName Win32_Printer | Select-Object Name,Default | ConvertTo-Json -Compress",
    )?;
    parse_printer_list_json(&String::from_utf8_lossy(&output.stdout))
}

// ---------------------------------------------------------------------------
// Unix (macOS / Linux): CUPS `lp` / `lpstat`
// ---------------------------------------------------------------------------
//
// macOS drives the OS print pipeline directly through CUPS, so no bundled
// toolchain (Ghostscript / qpdf) is needed: `lp` reads the file from disk and
// spools it at any size, and `lpstat` enumerates destinations. Argument
// construction and output parsing are pure (fixture-tested); the thin
// `#[cfg(unix)]` shims below run the binaries. Advertised support stays
// Windows + macOS (`platform_supported`) — the code compiles on Linux for CI
// coverage, but Linux is not a release target.

/// Parse `lpstat -e` output (one destination name per line) into printers,
/// flagging the one whose name matches `default` (from `lpstat -d`).
pub fn parse_lpstat_printers(names_output: &str, default: Option<&str>) -> Vec<PrinterInfo> {
    names_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|name| PrinterInfo {
            name: name.to_string(),
            is_default: default == Some(name),
        })
        .collect()
}

/// Extract the default destination from `lpstat -d` output, which is either
/// `system default destination: NAME` or `no system default destination`.
pub fn parse_lpstat_default(output: &str) -> Option<String> {
    let line = output
        .lines()
        .find(|line| line.contains("system default destination"))?;
    if line.contains("no system default") {
        return None;
    }
    let name = line.rsplit(':').next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Render a `Segments` selection into a CUPS `page-ranges` value ("1-3,5").
/// CUPS emits pages in ascending document order regardless of listed order.
pub fn cups_page_ranges(segments: &[PageSegmentRange]) -> String {
    segments
        .iter()
        .map(|segment| {
            if segment.first == segment.last {
                segment.first.to_string()
            } else {
                format!("{}-{}", segment.first, segment.last)
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Media (paper size) values the picker offers. Fixed allowlist — the values
/// are spliced into a `-o media=` option, so anything outside this set is
/// rejected rather than passed to `lp`.
pub const ALLOWED_MEDIA: &[&str] = &["Letter", "Legal", "A4"];
/// Duplex values, as CUPS `sides` keywords.
pub const ALLOWED_SIDES: &[&str] = &["one-sided", "two-sided-long-edge", "two-sided-short-edge"];
/// Orientation choices, as semantic keywords mapped to `orientation-requested`.
pub const ALLOWED_ORIENTATION: &[&str] = &["portrait", "landscape"];

/// User-selected print options for the CUPS (`lp`) path: paper size, duplex,
/// and orientation. Each is optional — `None` leaves the printer/PPD default
/// in place. Values are validated against the allowlists above before they
/// reach `lp`, so a caller can't inject arbitrary `-o` options.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrintOptions {
    /// CUPS `media` name (`Letter` / `Legal` / `A4`).
    pub media: Option<String>,
    /// CUPS `sides` keyword (`one-sided` / `two-sided-long-edge` / …).
    pub sides: Option<String>,
    /// Semantic orientation (`portrait` / `landscape`).
    pub orientation: Option<String>,
}

/// Reject any option value outside its allowlist. The UI only ever sends fixed
/// dropdown values; this is defense-in-depth against a malformed request
/// smuggling an extra `-o` payload through the option string.
pub fn validate_print_options(options: &PrintOptions) -> OpResult<()> {
    fn check(value: &Option<String>, allowed: &[&str], field: &str) -> OpResult<()> {
        if let Some(value) = value {
            if !allowed.contains(&value.as_str()) {
                return Err(PathOpError {
                    code: ERR_INVALID_INPUT,
                    message: format!("unsupported {field} option: {value}"),
                });
            }
        }
        Ok(())
    }
    check(&options.media, ALLOWED_MEDIA, "paper size")?;
    check(&options.sides, ALLOWED_SIDES, "duplex")?;
    check(&options.orientation, ALLOWED_ORIENTATION, "orientation")?;
    Ok(())
}

/// Map a validated semantic orientation to its IPP `orientation-requested`
/// value (`3` portrait, `4` landscape). Portrait is emitted explicitly rather
/// than omitted so a landscape default gets overridden.
pub fn orientation_requested(orientation: Option<&str>) -> Option<&'static str> {
    match orientation {
        Some("portrait") => Some("3"),
        Some("landscape") => Some("4"),
        _ => None,
    }
}

/// Build the `lp` argument vector: `-d <printer> [-n <copies>]
/// [-o media=…] [-o sides=…] [-o orientation-requested=…]
/// [-o page-ranges=…] <input>`. A single copy omits `-n`; unset options and a
/// whole-document selection omit their `-o` flags. Grant-resolved input paths
/// are absolute, so no `--` option terminator is needed. Callers must
/// `validate_print_options` first — arg-building assumes clean values.
pub fn lp_print_args(
    printer: &str,
    selection: &PrintSelection,
    copies: u32,
    options: &PrintOptions,
    input: &Path,
) -> Vec<OsString> {
    let mut arguments = args(&["-d", printer]);
    if copies > 1 {
        arguments.push(OsString::from("-n"));
        arguments.push(OsString::from(copies.to_string()));
    }
    let mut push_option = |key: &str, value: &str| {
        arguments.push(OsString::from("-o"));
        arguments.push(OsString::from(format!("{key}={value}")));
    };
    if let Some(media) = &options.media {
        push_option("media", media);
    }
    if let Some(sides) = &options.sides {
        push_option("sides", sides);
    }
    if let Some(orientation) = orientation_requested(options.orientation.as_deref()) {
        push_option("orientation-requested", orientation);
    }
    if let PrintSelection::Segments(segments) = selection {
        push_option("page-ranges", &cups_page_ranges(segments));
    }
    arguments.push(input.as_os_str().to_os_string());
    arguments
}

/// Parse the CUPS job id from `lp` stdout, which is exactly
/// `request id is <printer>-<n> (N file(s))`. The id is what `lpstat` and
/// `cancel` take — completion polling and real cancellation both need it.
/// `None` when the line shape is unexpected.
pub fn parse_lp_job_id(stdout: &str) -> Option<String> {
    const MARKER: &str = "request id is ";
    let start = stdout.find(MARKER)? + MARKER.len();
    let id = stdout[start..].split_whitespace().next()?;
    let (destination, sequence) = id.rsplit_once('-')?;
    if destination.is_empty() {
        return None;
    }
    sequence.parse::<u64>().ok()?;
    Some(id.to_string())
}

/// Whether `lpstat -o` output still lists `job_id` (job id is the first
/// whitespace token on each job line). Used to poll a job's liveness.
pub fn lpstat_lists_job(output: &str, job_id: &str) -> bool {
    output
        .lines()
        .any(|line| line.split_whitespace().next() == Some(job_id))
}

/// Whether `lpstat -p <printer>` reports the queue stopped/disabled — the
/// signal that a job left the queue because the printer halted (a failure)
/// rather than because it finished. CUPS phrases this as
/// "printer X disabled since …".
pub fn printer_is_stopped(lpstat_p_output: &str) -> bool {
    let text = lpstat_p_output.to_ascii_lowercase();
    text.contains("disabled") || text.contains("stopped")
}

/// Run a CUPS binary in the C locale and capture stdout, delegating spawn-flag
/// handling and error shaping to the shared `path_ops` runner.
#[cfg(unix)]
fn run_capture(program: &str, arguments: &[&str]) -> OpResult<String> {
    let output = path_ops::run_command_with_env(
        Path::new(program),
        &args(arguments),
        None,
        &[],
        &CUPS_C_LOCALE,
    )?;
    path_ops::expect_success(program, &output)?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Enumerate CUPS destinations (`lpstat -e`), flagging the default
/// (`lpstat -d`). A missing default is not an error — the list is still
/// returned.
#[cfg(unix)]
pub fn list_printers() -> OpResult<Vec<PrinterInfo>> {
    let names = run_capture("lpstat", &["-e"])?;
    let default_raw = run_capture("lpstat", &["-d"]).unwrap_or_default();
    Ok(parse_lpstat_printers(
        &names,
        parse_lpstat_default(&default_raw).as_deref(),
    ))
}

/// Spool one print job to CUPS via `lp` and return its job id for completion
/// polling and cancellation. CUPS output is forced to the C locale before
/// parsing its documented English response. If it still cannot provide a
/// trackable id, fail rather than falsely report completion. Callers must
/// `validate_print_options(options)` first.
#[cfg(unix)]
pub fn lp_print(
    input: &Path,
    printer: &str,
    selection: &PrintSelection,
    copies: u32,
    options: &PrintOptions,
) -> OpResult<String> {
    validate_copies(copies)?;
    let output = path_ops::run_command_with_env(
        Path::new("lp"),
        &lp_print_args(printer, selection, copies, options, input),
        None,
        &[],
        &CUPS_C_LOCALE,
    )?;
    path_ops::expect_success("lp", &output)?;
    parse_lp_job_id(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| PathOpError {
        code: ERR_PRINT_FAILED,
        message: "CUPS accepted the print job but did not return a trackable job id; the job may still print.".to_string(),
    })
}

/// Whether a CUPS job is still in the active queue (`lpstat -o`). A job that
/// has left the queue either finished or was stopped — the caller checks the
/// printer state to tell those apart.
#[cfg(unix)]
pub fn cups_job_active(job_id: &str) -> OpResult<bool> {
    let output = run_capture("lpstat", &["-o"])?;
    Ok(lpstat_lists_job(&output, job_id))
}

/// Whether the destination queue is stopped/disabled (`lpstat -p <printer>`) —
/// the failure signal when a tracked job leaves the queue.
#[cfg(unix)]
pub fn cups_printer_stopped(printer: &str) -> OpResult<bool> {
    let output = run_capture("lpstat", &["-p", printer])?;
    Ok(printer_is_stopped(&output))
}

/// Cancel a queued/printing CUPS job by id (`cancel <job_id>`). Best-effort —
/// cancelling a job that already left the queue is a harmless no-op.
#[cfg(unix)]
pub fn cancel_cups_job(job_id: &str) -> OpResult<()> {
    let output = path_ops::run_command(Path::new("cancel"), &args(&[job_id]), None, &[])?;
    path_ops::expect_success("cancel", &output)
}

/// Targets that are neither Windows nor Unix have no native print pipeline.
#[cfg(not(any(windows, unix)))]
pub fn list_printers() -> OpResult<Vec<PrinterInfo>> {
    Ok(Vec::new())
}

/// Whether the native print pipeline exists on this platform at all. Windows
/// drives it through Ghostscript; macOS through CUPS `lp`.
pub const fn platform_supported() -> bool {
    cfg!(windows) || cfg!(target_os = "macos")
}

/// Whether native printing is actually usable, given whether the bundled
/// Ghostscript driver was found. Windows needs Ghostscript; macOS prints
/// through the OS's CUPS `lp` and needs no bundled toolchain. Keeps all
/// "what makes printing available where" knowledge in this module rather than
/// the Tauri command layer.
pub fn print_available(ghostscript_present: bool) -> bool {
    if cfg!(target_os = "macos") {
        platform_supported()
    } else {
        platform_supported() && ghostscript_present
    }
}

// ---------------------------------------------------------------------------
// Selection → contiguous segments
// ---------------------------------------------------------------------------

/// One contiguous 1-based inclusive page run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageSegmentRange {
    pub first: u32,
    pub last: u32,
}

impl PageSegmentRange {
    pub fn page_count(&self) -> u32 {
        self.last - self.first + 1
    }
}

/// What to print.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrintSelection {
    /// The entire document — Ghostscript needs no page flags and no page
    /// count, so a whole-doc print works even when qpdf is unavailable.
    WholeDocument,
    /// Explicit segments in user order (a range like "5-7,1-2" prints the
    /// later pages first, matching the extraction semantics of #127).
    Segments(Vec<PageSegmentRange>),
}

/// Normalize zero-based page indexes (the UI's `parsePageRanges` output) into
/// contiguous ascending runs, **preserving the listed order** across runs.
/// Rejects empty input and duplicates, mirroring `one_based_range_string`.
pub fn contiguous_segments(zero_based_pages: &[u32]) -> OpResult<Vec<PageSegmentRange>> {
    if zero_based_pages.is_empty() {
        return Err(PathOpError {
            code: ERR_INVALID_INPUT,
            message: "no pages selected".to_string(),
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for &page in zero_based_pages {
        if !seen.insert(page) {
            return Err(PathOpError {
                code: ERR_INVALID_INPUT,
                message: "duplicate page indexes".to_string(),
            });
        }
    }

    let mut segments = Vec::new();
    let mut run_start = zero_based_pages[0];
    let mut run_end = zero_based_pages[0];
    for &page in &zero_based_pages[1..] {
        if page == run_end + 1 {
            run_end = page;
        } else {
            segments.push(PageSegmentRange {
                first: run_start + 1,
                last: run_end + 1,
            });
            run_start = page;
            run_end = page;
        }
    }
    segments.push(PageSegmentRange {
        first: run_start + 1,
        last: run_end + 1,
    });
    Ok(segments)
}

// ---------------------------------------------------------------------------
// Ghostscript direct print — argument construction (pure, fully tested)
// ---------------------------------------------------------------------------

/// Windows printer names may contain spaces and even backslashes (UNC
/// shares), but `%` would be interpreted by Ghostscript's `OutputFile`
/// formatting and quotes would break the `printto` fallback's PowerShell
/// quoting. Control characters are never legitimate.
pub fn validate_printer_name(name: &str) -> OpResult<()> {
    if name.trim().is_empty() {
        return Err(PathOpError {
            code: ERR_INVALID_INPUT,
            message: "printer name is empty".to_string(),
        });
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(PathOpError {
            code: ERR_INVALID_INPUT,
            message: "printer name contains control characters".to_string(),
        });
    }
    if name.contains('%') || name.contains('"') || name.contains('\'') {
        return Err(PathOpError {
            code: ERR_INVALID_INPUT,
            message: "printer name contains unsupported characters (%, quotes)".to_string(),
        });
    }
    Ok(())
}

/// One Ghostscript print invocation: the whole document, or one contiguous
/// segment of it, to one printer.
#[derive(Clone, Debug)]
pub struct GsPrintJob<'a> {
    pub input: &'a Path,
    pub printer: &'a str,
    /// `None` = whole document (no page flags).
    pub segment: Option<PageSegmentRange>,
}

/// Build the Ghostscript argument vector for one print invocation.
///
/// SAFER posture (Lane D alignment): `-dSAFER` with an explicit
/// `--permit-file-read` on the input. Printer output goes to the spooler via
/// the `mswinpr2` device — no file **write** permit is needed or granted.
/// `-dNoCancel` suppresses the driver's modal progress/cancel dialog; RaioPDF
/// owns cancellation between segments.
pub fn gs_print_args(job: &GsPrintJob<'_>) -> Vec<OsString> {
    let mut arguments = args(&["-dBATCH", "-dNOPAUSE", "-dSAFER"]);
    let mut permit = OsString::from("--permit-file-read=");
    permit.push(job.input.as_os_str());
    arguments.push(permit);
    arguments.push(OsString::from("-dNoCancel"));
    arguments.push(OsString::from("-sDEVICE=mswinpr2"));
    if let Some(segment) = job.segment {
        arguments.push(OsString::from(format!("-dFirstPage={}", segment.first)));
        arguments.push(OsString::from(format!("-dLastPage={}", segment.last)));
    }
    arguments.push(OsString::from(format!(
        "-sOutputFile=%printer%{}",
        job.printer
    )));
    arguments.push(path_arg(job.input));
    arguments
}

/// Run one Ghostscript print invocation for real.
pub fn gs_print_segment(
    toolchain: &PathOpsToolchain,
    input: &Path,
    printer: &str,
    segment: Option<PageSegmentRange>,
) -> OpResult<()> {
    let job = GsPrintJob {
        input,
        printer,
        segment,
    };
    run_ghostscript(toolchain, gs_print_args(&job))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Divide-and-queue fallback — planning (pure)
// ---------------------------------------------------------------------------

/// Part size for the fallback queue. ~150 pages keeps each handed-off file
/// small enough for any consumer while keeping part counts sane.
pub const FALLBACK_PART_MAX_PAGES: u32 = 150;

/// Split segments into ≤ `max_pages` parts, preserving segment order.
pub fn plan_fallback_parts(segments: &[PageSegmentRange], max_pages: u32) -> Vec<PageSegmentRange> {
    let max_pages = max_pages.max(1);
    let mut parts = Vec::new();
    for segment in segments {
        let mut first = segment.first;
        while first <= segment.last {
            let last = segment.last.min(first.saturating_add(max_pages - 1));
            parts.push(PageSegmentRange { first, last });
            if last == segment.last {
                break;
            }
            first = last + 1;
        }
    }
    parts
}

/// True when the registered `printto`/open handler for .pdf is RaioPDF
/// itself — handing parts to the OS would recurse into us.
pub fn printto_handler_is_self(prog_id: &str) -> bool {
    prog_id.to_ascii_lowercase().contains("raio")
}

/// The exact PowerShell command used to hand one part to the OS print
/// pipeline (`ShellExecuteEx` with the `printto` verb, printer as the verb
/// parameter). Pure so quoting is testable; printer names with quotes are
/// rejected upstream by `validate_printer_name`, and single quotes in paths
/// are doubled per PowerShell literal-string rules.
pub fn printto_powershell_command(part: &Path, printer: &str) -> String {
    let part_literal = part.display().to_string().replace('\'', "''");
    format!(
        "$ErrorActionPreference='Stop'; try {{ Start-Process -FilePath '{part_literal}' -Verb PrintTo -ArgumentList '\"{printer}\"' }} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}"
    )
}

/// Registered ProgId for `.pdf` (per-user file association). `None` when no
/// explicit user choice exists.
#[cfg(windows)]
pub fn default_pdf_handler_prog_id() -> OpResult<Option<String>> {
    let output = path_ops::run_powershell(
        "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -ErrorAction SilentlyContinue).ProgId",
    )?;
    let prog_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if prog_id.is_empty() {
        None
    } else {
        Some(prog_id)
    })
}

/// Gate the fallback: refuse (never recurse) when RaioPDF is the .pdf
/// handler; refuse on non-Windows.
#[cfg(windows)]
pub fn ensure_printto_fallback_allowed() -> OpResult<()> {
    if let Some(prog_id) = default_pdf_handler_prog_id()? {
        if printto_handler_is_self(&prog_id) {
            return Err(PathOpError {
                code: ERR_PRINT_SELF_HANDLER,
                message: "The system PDF print handler is RaioPDF itself — the OS print fallback \
                          would loop. Set a different default PDF app or print a smaller range."
                    .to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn ensure_printto_fallback_allowed() -> OpResult<()> {
    Err(PathOpError {
        code: ERR_PRINT_NOT_SUPPORTED,
        message: "Native printing is not available on this platform yet.".to_string(),
    })
}

/// Hand one split part to the OS print pipeline.
#[cfg(windows)]
pub fn print_part_via_printto(part: &Path, printer: &str) -> OpResult<()> {
    path_ops::run_powershell(&printto_powershell_command(part, printer))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn print_part_via_printto(_part: &Path, _printer: &str) -> OpResult<()> {
    Err(PathOpError {
        code: ERR_PRINT_NOT_SUPPORTED,
        message: "Native printing is not available on this platform yet.".to_string(),
    })
}

/// qpdf-extract one fallback part into `out_dir` (part files are what the OS
/// pipeline receives; the original never leaves its place on disk).
pub fn split_print_part(
    toolchain: &PathOpsToolchain,
    input: &Path,
    part: PageSegmentRange,
    part_index: u32,
    out_dir: &Path,
) -> OpResult<PathBuf> {
    let part_path = out_dir.join(format!("print-part-{:03}.pdf", part_index + 1));
    path_ops::build_page_range(toolchain, input, part.first, part.last, &part_path)?;
    path_ops::require_input_file(&part_path)?;
    Ok(part_path)
}

// ---------------------------------------------------------------------------
// Orchestration (pure sequencing, injectable runners)
// ---------------------------------------------------------------------------

/// Progress phases emitted while a print job runs.
pub const PHASE_GS_SEGMENT: &str = "gs-segment";
pub const PHASE_FALLBACK_SPLIT: &str = "fallback-split";
pub const PHASE_FALLBACK_PART: &str = "fallback-part";

#[derive(Clone, Copy, Debug)]
pub struct PrintProgress {
    pub phase: &'static str,
    /// 1-based position within `total`.
    pub current: u32,
    pub total: u32,
    pub first_page: u32,
    pub last_page: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrintOutcome {
    /// "ghostscript" when the direct path carried the whole job; "printto"
    /// when the divide-and-queue fallback finished it.
    pub method: &'static str,
    pub gs_invocations: u32,
    pub fallback_parts: u32,
    /// Why the fallback engaged (gs error message), when it did.
    pub fallback_reason: Option<String>,
}

/// Injectable seams for `execute_print_plan` — production wires these to
/// Ghostscript / qpdf / PowerShell; tests inject closures.
pub struct PrintRunners<'a> {
    /// Run one gs print invocation (whole doc when segment is None).
    pub gs_print: &'a mut dyn FnMut(Option<PageSegmentRange>) -> OpResult<()>,
    /// Resolve the whole document's bounds (only called if the fallback needs
    /// to split a whole-document job — requires qpdf).
    pub whole_doc_bounds: &'a mut dyn FnMut() -> OpResult<PageSegmentRange>,
    /// Self-handler / platform gate, checked once before any fallback part.
    pub fallback_allowed: &'a mut dyn FnMut() -> OpResult<()>,
    /// qpdf-split one part; returns the part file path.
    pub split_part: &'a mut dyn FnMut(PageSegmentRange, u32) -> OpResult<PathBuf>,
    /// Hand one part file to the OS print pipeline.
    pub print_part: &'a mut dyn FnMut(&Path) -> OpResult<()>,
    /// Progress sink (shell emits Tauri events from this).
    pub progress: &'a mut dyn FnMut(PrintProgress),
    /// Cooperative cancel, polled between invocations and parts.
    pub cancelled: &'a mut dyn FnMut() -> bool,
}

/// Drive a full print job: gs segment-by-segment (copies as sequential
/// passes), falling back to divide-and-queue **from the failure point
/// onward** — pages already spooled by gs are not re-printed by the fallback.
///
/// Copies note: `-dNumCopies` delegation to `mswinpr2` is unverified on real
/// drivers, so copies are sequential whole passes (N invocations). Slower for
/// multi-copy jobs, but deterministically correct on every driver.
pub fn execute_print_plan(
    selection: &PrintSelection,
    copies: u32,
    runners: &mut PrintRunners<'_>,
) -> OpResult<PrintOutcome> {
    validate_copies(copies)?;
    let segments: Vec<Option<PageSegmentRange>> = match selection {
        PrintSelection::WholeDocument => vec![None],
        PrintSelection::Segments(segments) => {
            if segments.is_empty() {
                return Err(PathOpError {
                    code: ERR_INVALID_INPUT,
                    message: "no pages selected".to_string(),
                });
            }
            for segment in segments {
                if segment.first == 0 || segment.last < segment.first {
                    return Err(PathOpError {
                        code: ERR_INVALID_INPUT,
                        message: "invalid page segment".to_string(),
                    });
                }
            }
            segments.iter().copied().map(Some).collect()
        }
    };

    let total_invocations = (segments.len() as u32) * copies;
    let mut gs_invocations = 0u32;
    let mut failure: Option<(u32, usize, PathOpError)> = None; // (copy, segment index, error)

    'copies: for copy in 0..copies {
        for (index, segment) in segments.iter().enumerate() {
            if (runners.cancelled)() {
                return Err(cancelled_error());
            }
            let (first_page, last_page) = segment.map(|s| (s.first, s.last)).unwrap_or((0, 0));
            (runners.progress)(PrintProgress {
                phase: PHASE_GS_SEGMENT,
                current: copy * segments.len() as u32 + index as u32 + 1,
                total: total_invocations,
                first_page,
                last_page,
            });
            match (runners.gs_print)(*segment) {
                Ok(()) => gs_invocations += 1,
                Err(error) => {
                    failure = Some((copy, index, error));
                    break 'copies;
                }
            }
        }
    }

    let Some((failed_copy, failed_index, gs_error)) = failure else {
        return Ok(PrintOutcome {
            method: "ghostscript",
            gs_invocations,
            fallback_parts: 0,
            fallback_reason: None,
        });
    };

    // ---- divide-and-queue fallback, resuming at the failed invocation ----
    (runners.fallback_allowed)()?;

    // Materialize concrete bounds (whole-doc jobs need qpdf from here on).
    let concrete: Vec<PageSegmentRange> = {
        let mut concrete = Vec::with_capacity(segments.len());
        for segment in &segments {
            concrete.push(match segment {
                Some(segment) => *segment,
                None => (runners.whole_doc_bounds)()?,
            });
        }
        concrete
    };

    // Remaining work: the failed segment to the end of its copy, then every
    // later copy in full.
    let mut remaining: Vec<PageSegmentRange> = Vec::new();
    remaining.extend_from_slice(&concrete[failed_index..]);
    for _ in (failed_copy + 1)..copies {
        remaining.extend_from_slice(&concrete);
    }

    let parts = plan_fallback_parts(&remaining, FALLBACK_PART_MAX_PAGES);
    let total_parts = parts.len() as u32;

    // Split each distinct part once (identical page runs across copies reuse
    // the same file).
    let mut part_files: Vec<(PageSegmentRange, PathBuf)> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if (runners.cancelled)() {
            return Err(cancelled_error());
        }
        let existing = part_files
            .iter()
            .find(|(range, _)| range == part)
            .map(|(_, path)| path.clone());
        let path = match existing {
            Some(path) => path,
            None => {
                (runners.progress)(PrintProgress {
                    phase: PHASE_FALLBACK_SPLIT,
                    current: index as u32 + 1,
                    total: total_parts,
                    first_page: part.first,
                    last_page: part.last,
                });
                let path = (runners.split_part)(*part, index as u32)?;
                part_files.push((*part, path.clone()));
                path
            }
        };
        // Queue immediately after split so cancel points sit between parts.
        if (runners.cancelled)() {
            return Err(cancelled_error());
        }
        (runners.progress)(PrintProgress {
            phase: PHASE_FALLBACK_PART,
            current: index as u32 + 1,
            total: total_parts,
            first_page: part.first,
            last_page: part.last,
        });
        (runners.print_part)(&path)?;
    }

    Ok(PrintOutcome {
        method: "printto",
        gs_invocations,
        fallback_parts: total_parts,
        fallback_reason: Some(gs_error.message),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- printer list parsing ----

    #[test]
    fn parses_printer_array_json() {
        let json = r#"[
            {"Name":"Microsoft Print to PDF","Default":true},
            {"Name":"Canon G3070 series","Default":false},
            {"Name":"\\\\server\\Shared HP","Default":false}
        ]"#;
        let printers = parse_printer_list_json(json).unwrap();
        assert_eq!(printers.len(), 3);
        assert_eq!(printers[0].name, "Microsoft Print to PDF");
        assert!(printers[0].is_default);
        assert_eq!(printers[2].name, "\\\\server\\Shared HP");
        assert!(!printers[2].is_default);
    }

    #[test]
    fn parses_single_printer_object_json() {
        let json = r#"{"Name":"Only Printer","Default":false}"#;
        let printers = parse_printer_list_json(json).unwrap();
        assert_eq!(
            printers,
            vec![PrinterInfo {
                name: "Only Printer".to_string(),
                is_default: false,
            }]
        );
    }

    #[test]
    fn empty_printer_output_means_no_printers() {
        assert_eq!(parse_printer_list_json("").unwrap(), Vec::new());
        assert_eq!(parse_printer_list_json("  \r\n").unwrap(), Vec::new());
    }

    #[test]
    fn printer_rows_without_names_are_skipped_and_null_default_is_false() {
        let json = r#"[{"Default":true},{"Name":"Real","Default":null}]"#;
        let printers = parse_printer_list_json(json).unwrap();
        assert_eq!(printers.len(), 1);
        assert_eq!(printers[0].name, "Real");
        assert!(!printers[0].is_default);
    }

    #[test]
    fn malformed_printer_json_is_a_typed_error() {
        assert!(parse_printer_list_json("not json").is_err());
        assert!(parse_printer_list_json("42").is_err());
    }

    // ---- segments ----

    #[test]
    fn contiguous_segments_collapse_runs_preserving_order() {
        // "5-7,1-2" → later pages first, two segments.
        let segments = contiguous_segments(&[4, 5, 6, 0, 1]).unwrap();
        assert_eq!(
            segments,
            vec![
                PageSegmentRange { first: 5, last: 7 },
                PageSegmentRange { first: 1, last: 2 },
            ]
        );
    }

    #[test]
    fn contiguous_segments_single_pages_and_rejections() {
        assert_eq!(
            contiguous_segments(&[7]).unwrap(),
            vec![PageSegmentRange { first: 8, last: 8 }]
        );
        assert!(contiguous_segments(&[]).is_err());
        assert!(contiguous_segments(&[1, 1]).is_err());
    }

    // ---- printer name validation ----

    #[test]
    fn printer_names_with_spaces_and_unc_paths_pass() {
        validate_printer_name("Microsoft Print to PDF").unwrap();
        validate_printer_name("\\\\server\\Shared HP").unwrap();
    }

    #[test]
    fn printer_names_with_format_or_quote_chars_are_rejected() {
        assert!(validate_printer_name("").is_err());
        assert!(validate_printer_name("   ").is_err());
        assert!(validate_printer_name("100% Printer").is_err());
        assert!(validate_printer_name("evil\"name").is_err());
        assert!(validate_printer_name("o'brien").is_err());
        assert!(validate_printer_name("line\nbreak").is_err());
    }

    // ---- gs argument construction ----

    fn os(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn gs_print_args_for_a_segment() {
        let job = GsPrintJob {
            input: Path::new("C:/docs/big filing.pdf"),
            printer: "Microsoft Print to PDF",
            segment: Some(PageSegmentRange {
                first: 151,
                last: 300,
            }),
        };
        assert_eq!(
            gs_print_args(&job),
            os(&[
                "-dBATCH",
                "-dNOPAUSE",
                "-dSAFER",
                "--permit-file-read=C:/docs/big filing.pdf",
                "-dNoCancel",
                "-sDEVICE=mswinpr2",
                "-dFirstPage=151",
                "-dLastPage=300",
                "-sOutputFile=%printer%Microsoft Print to PDF",
                "C:/docs/big filing.pdf",
            ])
        );
    }

    #[test]
    fn gs_print_args_whole_document_has_no_page_flags() {
        let job = GsPrintJob {
            input: Path::new("in.pdf"),
            printer: "P",
            segment: None,
        };
        let rendered = gs_print_args(&job);
        assert!(!rendered
            .iter()
            .any(|arg| arg.to_string_lossy().starts_with("-dFirstPage")));
        assert!(!rendered
            .iter()
            .any(|arg| arg.to_string_lossy().starts_with("-dLastPage")));
        // SAFER posture is always present.
        assert!(rendered.iter().any(|arg| arg == "-dSAFER"));
        assert!(rendered
            .iter()
            .any(|arg| arg.to_string_lossy() == "--permit-file-read=in.pdf"));
        // And no file-write permit exists — printer output needs none.
        assert!(!rendered
            .iter()
            .any(|arg| arg.to_string_lossy().contains("permit-file-write")));
    }

    // ---- fallback planning ----

    #[test]
    fn fallback_parts_split_at_the_page_cap() {
        let segments = [PageSegmentRange {
            first: 1,
            last: 400,
        }];
        let parts = plan_fallback_parts(&segments, 150);
        assert_eq!(
            parts,
            vec![
                PageSegmentRange {
                    first: 1,
                    last: 150
                },
                PageSegmentRange {
                    first: 151,
                    last: 300
                },
                PageSegmentRange {
                    first: 301,
                    last: 400
                },
            ]
        );
    }

    #[test]
    fn fallback_parts_keep_small_segments_intact_and_ordered() {
        let segments = [
            PageSegmentRange {
                first: 200,
                last: 210,
            },
            PageSegmentRange { first: 1, last: 2 },
        ];
        assert_eq!(plan_fallback_parts(&segments, 150), segments.to_vec());
    }

    #[test]
    fn printto_self_handler_detection() {
        assert!(printto_handler_is_self("RaioPDF.Document"));
        assert!(printto_handler_is_self("raiopdf.pdf.1"));
        assert!(!printto_handler_is_self("Acrobat.Document.DC"));
        assert!(!printto_handler_is_self("MSEdgePDF"));
    }

    #[test]
    fn printto_command_quotes_paths_and_printer() {
        let command = printto_powershell_command(
            Path::new("C:\\temp\\o'brien part.pdf"),
            "Microsoft Print to PDF",
        );
        assert!(command.contains("-FilePath 'C:\\temp\\o''brien part.pdf'"));
        assert!(command.contains("-Verb PrintTo"));
        assert!(command.contains("-ArgumentList '\"Microsoft Print to PDF\"'"));
    }

    // ---- orchestration ----

    struct Harness {
        gs_results: Vec<OpResult<()>>,
        gs_calls: Vec<Option<PageSegmentRange>>,
        split_calls: Vec<PageSegmentRange>,
        printed_parts: Vec<PathBuf>,
        progress: Vec<(&'static str, u32, u32)>,
        cancel_after_parts: Option<usize>,
        fallback_allowed: OpResult<()>,
        whole_doc: PageSegmentRange,
    }

    impl Harness {
        fn new(gs_results: Vec<OpResult<()>>) -> Self {
            Self {
                gs_results,
                gs_calls: Vec::new(),
                split_calls: Vec::new(),
                printed_parts: Vec::new(),
                progress: Vec::new(),
                cancel_after_parts: None,
                fallback_allowed: Ok(()),
                whole_doc: PageSegmentRange {
                    first: 1,
                    last: 500,
                },
            }
        }

        fn run(&mut self, selection: &PrintSelection, copies: u32) -> OpResult<PrintOutcome> {
            let mut gs_results = std::mem::take(&mut self.gs_results).into_iter();
            let mut gs_calls: Vec<Option<PageSegmentRange>> = Vec::new();
            let mut split_calls: Vec<PageSegmentRange> = Vec::new();
            let mut printed: Vec<PathBuf> = Vec::new();
            let mut progress: Vec<(&'static str, u32, u32)> = Vec::new();
            let cancel_after = self.cancel_after_parts;
            let fallback_allowed = self.fallback_allowed.clone();
            let whole_doc = self.whole_doc;

            let printed_count = std::cell::Cell::new(0usize);
            let mut gs_print = |segment: Option<PageSegmentRange>| {
                gs_calls.push(segment);
                gs_results.next().unwrap_or(Ok(()))
            };
            let mut whole_doc_bounds = || Ok(whole_doc);
            let mut fallback_gate = || fallback_allowed.clone();
            let mut split_part = |part: PageSegmentRange, index: u32| {
                split_calls.push(part);
                Ok(PathBuf::from(format!("part-{index}.pdf")))
            };
            let mut print_part = |path: &Path| {
                printed.push(path.to_path_buf());
                printed_count.set(printed_count.get() + 1);
                Ok(())
            };
            let mut record_progress = |event: PrintProgress| {
                progress.push((event.phase, event.current, event.total));
            };
            let mut cancelled = || cancel_after.is_some_and(|limit| printed_count.get() >= limit);

            let outcome = execute_print_plan(
                selection,
                copies,
                &mut PrintRunners {
                    gs_print: &mut gs_print,
                    whole_doc_bounds: &mut whole_doc_bounds,
                    fallback_allowed: &mut fallback_gate,
                    split_part: &mut split_part,
                    print_part: &mut print_part,
                    progress: &mut record_progress,
                    cancelled: &mut cancelled,
                },
            );

            self.gs_calls = gs_calls;
            self.split_calls = split_calls;
            self.printed_parts = printed;
            self.progress = progress;
            outcome
        }
    }

    fn gs_failure() -> PathOpError {
        PathOpError {
            code: path_ops::ERR_OP_FAILED,
            message: "ghostscript failed (exit code: 1): driver quirk".to_string(),
        }
    }

    #[test]
    fn gs_path_prints_every_segment_per_copy_in_order() {
        let mut harness = Harness::new(vec![]);
        let selection = PrintSelection::Segments(vec![
            PageSegmentRange { first: 1, last: 3 },
            PageSegmentRange { first: 9, last: 9 },
        ]);
        let outcome = harness.run(&selection, 2).unwrap();
        assert_eq!(outcome.method, "ghostscript");
        assert_eq!(outcome.gs_invocations, 4);
        assert_eq!(outcome.fallback_parts, 0);
        assert_eq!(harness.gs_calls.len(), 4);
        assert_eq!(
            harness.gs_calls[0],
            Some(PageSegmentRange { first: 1, last: 3 })
        );
        assert_eq!(
            harness.gs_calls[1],
            Some(PageSegmentRange { first: 9, last: 9 })
        );
        assert_eq!(harness.gs_calls[2], harness.gs_calls[0]);
        // Progress covered every invocation with a running index.
        let currents: Vec<u32> = harness.progress.iter().map(|(_, c, _)| *c).collect();
        assert_eq!(currents, vec![1, 2, 3, 4]);
        assert!(harness.progress.iter().all(|(_, _, t)| *t == 4));
    }

    #[test]
    fn whole_document_uses_a_single_flagless_invocation() {
        let mut harness = Harness::new(vec![]);
        let outcome = harness.run(&PrintSelection::WholeDocument, 1).unwrap();
        assert_eq!(outcome.method, "ghostscript");
        assert_eq!(harness.gs_calls, vec![None]);
    }

    #[test]
    fn gs_failure_triggers_fallback_from_the_failure_point() {
        // Two segments, two copies. gs succeeds for copy 1 segment 1, fails
        // on copy 1 segment 2 → fallback must cover segment 2 (copy 1) and
        // both segments of copy 2 — never re-printing copy 1 segment 1.
        let mut harness = Harness::new(vec![Ok(()), Err(gs_failure())]);
        let selection = PrintSelection::Segments(vec![
            PageSegmentRange {
                first: 1,
                last: 100,
            },
            PageSegmentRange {
                first: 201,
                last: 220,
            },
        ]);
        let outcome = harness.run(&selection, 2).unwrap();
        assert_eq!(outcome.method, "printto");
        assert_eq!(outcome.gs_invocations, 1);
        assert_eq!(outcome.fallback_parts, 3);
        assert!(outcome
            .fallback_reason
            .as_deref()
            .unwrap()
            .contains("driver quirk"));
        assert_eq!(
            harness.split_calls,
            vec![
                PageSegmentRange {
                    first: 201,
                    last: 220
                },
                PageSegmentRange {
                    first: 1,
                    last: 100
                },
            ]
        );
        // Three parts queued; the repeated {201-220} run reuses its file.
        assert_eq!(harness.printed_parts.len(), 3);
        assert_eq!(harness.printed_parts[0], harness.printed_parts[2]);
    }

    #[test]
    fn fallback_splits_oversized_selections_into_capped_parts() {
        let mut harness = Harness::new(vec![Err(gs_failure())]);
        let selection = PrintSelection::Segments(vec![PageSegmentRange {
            first: 1,
            last: 400,
        }]);
        let outcome = harness.run(&selection, 1).unwrap();
        assert_eq!(outcome.method, "printto");
        assert_eq!(outcome.fallback_parts, 3);
        assert_eq!(
            harness.split_calls,
            vec![
                PageSegmentRange {
                    first: 1,
                    last: 150
                },
                PageSegmentRange {
                    first: 151,
                    last: 300
                },
                PageSegmentRange {
                    first: 301,
                    last: 400
                },
            ]
        );
        // Ordered part-progress events, "Printing part n of 3" shaped.
        let part_events: Vec<(u32, u32)> = harness
            .progress
            .iter()
            .filter(|(phase, _, _)| *phase == PHASE_FALLBACK_PART)
            .map(|(_, current, total)| (*current, *total))
            .collect();
        assert_eq!(part_events, vec![(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn whole_document_fallback_resolves_bounds_then_splits() {
        let mut harness = Harness::new(vec![Err(gs_failure())]);
        harness.whole_doc = PageSegmentRange {
            first: 1,
            last: 320,
        };
        let outcome = harness.run(&PrintSelection::WholeDocument, 1).unwrap();
        assert_eq!(outcome.fallback_parts, 3);
        assert_eq!(
            harness.split_calls[0],
            PageSegmentRange {
                first: 1,
                last: 150
            }
        );
    }

    #[test]
    fn fallback_refused_when_raiopdf_is_the_pdf_handler() {
        let mut harness = Harness::new(vec![Err(gs_failure())]);
        harness.fallback_allowed = Err(PathOpError {
            code: ERR_PRINT_SELF_HANDLER,
            message: "self handler".to_string(),
        });
        let selection = PrintSelection::Segments(vec![PageSegmentRange { first: 1, last: 10 }]);
        let error = harness.run(&selection, 1).unwrap_err();
        assert_eq!(error.code, ERR_PRINT_SELF_HANDLER);
        assert!(harness.printed_parts.is_empty());
    }

    #[test]
    fn cancel_between_parts_stops_the_queue() {
        let mut harness = Harness::new(vec![Err(gs_failure())]);
        harness.cancel_after_parts = Some(1);
        let selection = PrintSelection::Segments(vec![PageSegmentRange {
            first: 1,
            last: 400,
        }]);
        let error = harness.run(&selection, 1).unwrap_err();
        assert_eq!(error.code, ERR_PRINT_CANCELLED);
        assert_eq!(harness.printed_parts.len(), 1);
    }

    #[test]
    fn invalid_plans_are_rejected() {
        let mut harness = Harness::new(vec![]);
        assert_eq!(
            harness
                .run(&PrintSelection::Segments(vec![]), 1)
                .unwrap_err()
                .code,
            ERR_INVALID_INPUT
        );
        assert_eq!(
            harness
                .run(&PrintSelection::WholeDocument, 0)
                .unwrap_err()
                .code,
            ERR_INVALID_INPUT
        );
        assert_eq!(
            harness
                .run(&PrintSelection::WholeDocument, 100)
                .unwrap_err()
                .code,
            ERR_INVALID_INPUT
        );
        assert_eq!(
            harness
                .run(
                    &PrintSelection::Segments(vec![PageSegmentRange { first: 5, last: 2 }]),
                    1
                )
                .unwrap_err()
                .code,
            ERR_INVALID_INPUT
        );
    }

    // ---- CUPS (macOS / Linux) argument + parsing ----

    #[test]
    fn platform_support_covers_windows_and_macos() {
        assert_eq!(
            platform_supported(),
            cfg!(windows) || cfg!(target_os = "macos")
        );
    }

    #[test]
    fn copies_must_be_between_one_and_ninety_nine() {
        assert!(validate_copies(1).is_ok());
        assert!(validate_copies(99).is_ok());
        for copies in [0, 100] {
            assert_eq!(validate_copies(copies).unwrap_err().code, ERR_INVALID_INPUT);
        }
    }

    #[test]
    fn cups_page_ranges_render_segments_and_single_pages() {
        assert_eq!(
            cups_page_ranges(&[
                PageSegmentRange { first: 1, last: 3 },
                PageSegmentRange { first: 5, last: 5 },
            ]),
            "1-3,5"
        );
        assert_eq!(
            cups_page_ranges(&[PageSegmentRange { first: 8, last: 8 }]),
            "8"
        );
    }

    #[test]
    fn lp_args_whole_document_omit_pages_and_single_copy() {
        assert_eq!(
            lp_print_args(
                "Office_HP",
                &PrintSelection::WholeDocument,
                1,
                &PrintOptions::default(),
                Path::new("/tmp/a b.pdf"),
            ),
            os(&["-d", "Office_HP", "/tmp/a b.pdf"])
        );
    }

    #[test]
    fn lp_args_include_copies_and_page_ranges() {
        let selection = PrintSelection::Segments(vec![
            PageSegmentRange { first: 2, last: 4 },
            PageSegmentRange { first: 9, last: 9 },
        ]);
        assert_eq!(
            lp_print_args(
                "PDF",
                &selection,
                3,
                &PrintOptions::default(),
                Path::new("/docs/f.pdf"),
            ),
            os(&[
                "-d",
                "PDF",
                "-n",
                "3",
                "-o",
                "page-ranges=2-4,9",
                "/docs/f.pdf",
            ])
        );
    }

    #[test]
    fn lp_args_render_media_sides_and_orientation_before_pages() {
        let options = PrintOptions {
            media: Some("Legal".to_string()),
            sides: Some("two-sided-long-edge".to_string()),
            orientation: Some("landscape".to_string()),
        };
        let selection = PrintSelection::Segments(vec![PageSegmentRange { first: 1, last: 2 }]);
        assert_eq!(
            lp_print_args("HP", &selection, 1, &options, Path::new("/d/f.pdf")),
            os(&[
                "-d",
                "HP",
                "-o",
                "media=Legal",
                "-o",
                "sides=two-sided-long-edge",
                "-o",
                "orientation-requested=4",
                "-o",
                "page-ranges=1-2",
                "/d/f.pdf",
            ])
        );
    }

    #[test]
    fn portrait_orientation_is_emitted_explicitly_and_defaults_omit() {
        assert_eq!(orientation_requested(Some("portrait")), Some("3"));
        assert_eq!(orientation_requested(Some("landscape")), Some("4"));
        assert_eq!(orientation_requested(None), None);
        assert_eq!(orientation_requested(Some("sideways")), None);
    }

    #[test]
    fn print_options_validate_against_allowlists() {
        assert!(validate_print_options(&PrintOptions::default()).is_ok());
        assert!(validate_print_options(&PrintOptions {
            media: Some("Letter".to_string()),
            sides: Some("one-sided".to_string()),
            orientation: Some("portrait".to_string()),
        })
        .is_ok());
        assert_eq!(
            validate_print_options(&PrintOptions {
                media: Some("Letter media=evil".to_string()),
                ..PrintOptions::default()
            })
            .unwrap_err()
            .code,
            ERR_INVALID_INPUT
        );
        assert!(validate_print_options(&PrintOptions {
            sides: Some("three-sided".to_string()),
            ..PrintOptions::default()
        })
        .is_err());
    }

    #[test]
    fn parse_lp_job_id_reads_the_request_line() {
        assert_eq!(
            parse_lp_job_id("request id is Canon_G3070_series-4 (1 file(s))").as_deref(),
            Some("Canon_G3070_series-4")
        );
        assert_eq!(
            parse_lp_job_id("noise\nrequest id is Office_HP-12 (1 file(s))\n").as_deref(),
            Some("Office_HP-12")
        );
        assert_eq!(parse_lp_job_id("no id here"), None);
        assert_eq!(parse_lp_job_id("request id is "), None);
        assert_eq!(parse_lp_job_id("request id is -12 (1 file(s))"), None);
        assert_eq!(
            parse_lp_job_id("request id is Office_HP-next (1 file(s))"),
            None
        );
    }

    #[test]
    fn lpstat_lists_job_matches_the_first_token() {
        let output = "Canon_G3070_series-4    jacobschumer   4405248   Tue Jul 21 22:34:21 2026\n\
                      Office_HP-5             jacobschumer   1000      Tue Jul 21 22:35:00 2026\n";
        assert!(lpstat_lists_job(output, "Canon_G3070_series-4"));
        assert!(lpstat_lists_job(output, "Office_HP-5"));
        assert!(!lpstat_lists_job(output, "Canon_G3070_series-3"));
        assert!(!lpstat_lists_job("", "Canon_G3070_series-4"));
    }

    #[test]
    fn printer_stopped_detects_disabled_or_stopped() {
        assert!(printer_is_stopped(
            "printer Canon_G3070_series disabled since Tue Jul 21 22:40:00 2026 -"
        ));
        assert!(printer_is_stopped("printer HP is stopped"));
        assert!(!printer_is_stopped(
            "printer Canon_G3070_series now printing Canon_G3070_series-4."
        ));
        assert!(!printer_is_stopped("printer HP is idle."));
    }

    #[test]
    fn lpstat_printers_flag_the_default_and_skip_blanks() {
        let printers = parse_lpstat_printers("Office_HP\n\nBrother_QL\n", Some("Brother_QL"));
        assert_eq!(
            printers,
            vec![
                PrinterInfo {
                    name: "Office_HP".to_string(),
                    is_default: false,
                },
                PrinterInfo {
                    name: "Brother_QL".to_string(),
                    is_default: true,
                },
            ]
        );
        assert_eq!(parse_lpstat_printers("\n  \n", None), Vec::new());
    }

    #[test]
    fn lpstat_default_parsing() {
        assert_eq!(
            parse_lpstat_default("system default destination: Brother_QL").as_deref(),
            Some("Brother_QL")
        );
        assert_eq!(parse_lpstat_default("no system default destination"), None);
        assert_eq!(parse_lpstat_default(""), None);
    }
}
