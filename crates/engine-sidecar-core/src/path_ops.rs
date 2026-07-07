//! PathOpsEngine — the path-based delegated-ops layer for large documents.
//!
//! Every op here is file→file: inputs arrive as absolute paths (the shell
//! resolves file grants before calling in), outputs are written to
//! caller-provided paths, and **document bytes never cross into the WebView**.
//! The ops shell out to the bundled toolchain (qpdf, Ghostscript, OCRmyPDF)
//! exactly like the sidecar's local handlers do — but with no HTTP hop and no
//! in-memory byte buffering, so a 283 MB filing costs disk I/O, not JS heap.
//!
//! This module lives in `engine-sidecar-core` (rather than the Tauri shell)
//! because the toolchain discovery, spawn flags, and payload layout knowledge
//! already live here, and because a plain library module is unit-testable with
//! `cargo test` against real binaries without a Tauri harness. The shell's
//! `path_ops.rs` provides the thin Tauri-command wrapper (grant resolution,
//! temp-dir management, output-grant issuance).

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fmt, fs, io,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use crate::{current_exe_dir, dev_payload_dir, find_payload_dir, payload_path_entries};

static TEXT_LAYER_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

pub const ERR_TOOLCHAIN_MISSING: &str = "TOOLCHAIN_MISSING";
pub const ERR_INVALID_INPUT: &str = "INVALID_INPUT";
pub const ERR_OP_FAILED: &str = "OP_FAILED";
pub const ERR_VERIFICATION_FAILED: &str = "VERIFICATION_FAILED";
pub const ERR_IO: &str = "IO_ERROR";

/// A typed, serializable path-op error. `code` is stable API for the UI;
/// `message` is a human-readable detail string.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOpError {
    pub code: &'static str,
    pub message: String,
}

impl PathOpError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn toolchain(tool: &str) -> Self {
        Self::new(
            ERR_TOOLCHAIN_MISSING,
            format!("{tool} binary not found in payload"),
        )
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(ERR_INVALID_INPUT, message)
    }

    fn failed(message: impl Into<String>) -> Self {
        Self::new(ERR_OP_FAILED, message)
    }

    fn io(context: &str, error: io::Error) -> Self {
        Self::new(ERR_IO, format!("{context}: {error}"))
    }
}

impl fmt::Display for PathOpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PathOpError {}

pub type OpResult<T> = Result<T, PathOpError>;

// ---------------------------------------------------------------------------
// Toolchain discovery
// ---------------------------------------------------------------------------

/// The external binaries the path ops delegate to. Mirrors the sidecar's own
/// discovery: explicit env overrides win, then the bundled payload layout.
#[derive(Clone, Debug, Default)]
pub struct PathOpsToolchain {
    pub qpdf: Option<PathBuf>,
    pub ghostscript: Option<PathBuf>,
    pub ocrmypdf: Option<PathBuf>,
    pub node_one_shot: bool,
    /// RaioPDF-owned OCRmyPDF API wrapper that emits bounded NDJSON progress.
    pub ocr_progress: Option<PathBuf>,
    /// Payload bin dirs prepended to PATH when spawning OCRmyPDF (it invokes
    /// `tesseract` and `gs` by name).
    pub path_entries: Vec<PathBuf>,
}

impl PathOpsToolchain {
    /// Discover the toolchain the same way the sidecar does: env overrides
    /// (`RAIOPDF_ENGINE_QPDF` / `RAIOPDF_ENGINE_GHOSTSCRIPT` /
    /// `RAIOPDF_ENGINE_OCRMYPDF`), then `RAIOPDF_ENGINE_PAYLOAD_DIR`, then the
    /// standard payload search (exe dir, Tauri resource dir, dev payload).
    pub fn discover(resource_dir: Option<&Path>) -> Self {
        let payload_dir = env::var_os("RAIOPDF_ENGINE_PAYLOAD_DIR")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(|| {
                find_payload_dir(
                    current_exe_dir().as_deref(),
                    resource_dir,
                    dev_payload_dir().as_deref(),
                )
            });

        let mut toolchain = payload_dir
            .as_deref()
            .map(Self::from_payload_dir)
            .unwrap_or_default();

        if let Some(path) = env_file("RAIOPDF_ENGINE_QPDF") {
            toolchain.qpdf = Some(path);
        }
        if let Some(path) = env_file("RAIOPDF_ENGINE_GHOSTSCRIPT") {
            toolchain.ghostscript = Some(path);
        }
        if let Some(path) = env_file("RAIOPDF_ENGINE_OCRMYPDF") {
            toolchain.ocrmypdf = Some(path);
            // A caller-provided OCRmyPDF binary is only known to speak the
            // plain CLI contract. Disable the bundled progress wrapper unless
            // the caller also explicitly points at a compatible wrapper.
            toolchain.ocr_progress = None;
        }
        if let Some(path) = env_file("RAIOPDF_ENGINE_OCR_PROGRESS") {
            toolchain.ocr_progress = Some(path);
        }

        toolchain
    }

    pub fn from_payload_dir(payload_dir: &Path) -> Self {
        Self {
            qpdf: find_binary(
                &payload_dir.join("ocr").join("qpdf").join("bin"),
                &["qpdf.exe", "qpdf"],
            ),
            ghostscript: find_binary(
                &payload_dir.join("ocr").join("gs").join("bin"),
                &["gs.exe", "gs"],
            ),
            ocrmypdf: {
                let candidate = payload_dir.join("ocr").join("ocrmypdf.cmd");
                candidate.is_file().then_some(candidate)
            },
            node_one_shot: {
                let node = payload_dir.join("mcp").join("node").join(if cfg!(windows) {
                    "node.exe"
                } else {
                    "node"
                });
                let entrypoint = payload_dir.join("mcp").join("app").join("index.mjs");
                node.is_file() && entrypoint.is_file()
            },
            ocr_progress: {
                let candidate = payload_dir.join("ocr").join("raiopdf-ocr-progress.cmd");
                candidate.is_file().then_some(candidate)
            },
            path_entries: payload_path_entries(payload_dir),
        }
    }

    fn require_qpdf(&self) -> OpResult<&Path> {
        self.qpdf
            .as_deref()
            .ok_or_else(|| PathOpError::toolchain("qpdf"))
    }

    fn require_ghostscript(&self) -> OpResult<&Path> {
        self.ghostscript
            .as_deref()
            .ok_or_else(|| PathOpError::toolchain("ghostscript"))
    }

    fn require_ocrmypdf(&self) -> OpResult<&Path> {
        self.ocrmypdf
            .as_deref()
            .ok_or_else(|| PathOpError::toolchain("ocrmypdf"))
    }
}

fn env_file(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

fn find_binary(bin_dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| bin_dir.join(name))
        .find(|candidate| candidate.is_file())
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Qpdf,
    Ghostscript,
    Ocrmypdf,
    Node,
}

impl Tool {
    pub const fn name(self) -> &'static str {
        match self {
            Tool::Qpdf => "qpdf",
            Tool::Ghostscript => "ghostscript",
            Tool::Ocrmypdf => "ocrmypdf",
            Tool::Node => "node",
        }
    }
}

/// Static description of one registered path op. The filing checklist's
/// closed-form rule ("a streamed prep step is enabled ⟺ a registered path op
/// implements it" — plan [R7-1]) reads `filing_step`: a `PrepPlanStepId` from
/// `packages/rules` when this op implements that step, `None` otherwise.
#[derive(Clone, Copy, Debug)]
pub struct OpDescriptor {
    pub name: &'static str,
    pub requires: &'static [Tool],
    pub filing_step: Option<&'static str>,
    pub max_input_bytes: Option<u64>,
}

/// The enumerable PathOpsEngine registry. Order is the plan's priority order.
pub const OP_DESCRIPTORS: &[OpDescriptor] = &[
    OpDescriptor {
        name: "page_count",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "document_facts",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "decrypt",
        requires: &[Tool::Qpdf],
        filing_step: Some("remove-encryption"),
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "extract_pages",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "merge",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "insert_pages",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "split_by_max_bytes",
        requires: &[Tool::Qpdf],
        filing_step: Some("split-by-size"),
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "normalize_to_letter_portrait",
        requires: &[Tool::Ghostscript],
        filing_step: Some("normalize-pages"),
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "scrub_metadata",
        requires: &[Tool::Qpdf],
        filing_step: Some("scrub-metadata"),
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "prepare_filing",
        requires: &[Tool::Qpdf, Tool::Ghostscript],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "ocr",
        requires: &[Tool::Ocrmypdf],
        filing_step: Some("make-searchable"),
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "repair",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "redact_areas",
        requires: &[Tool::Qpdf, Tool::Ghostscript],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "linearize",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "compress",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "sanitize",
        requires: &[Tool::Ghostscript],
        filing_step: Some("sanitize-content"),
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "bates_stamp",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "page_numbers",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "watermark",
        requires: &[Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "build_binder",
        requires: &[Tool::Node, Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
    OpDescriptor {
        name: "apply_edits",
        requires: &[Tool::Node, Tool::Qpdf],
        filing_step: None,
        max_input_bytes: None,
    },
];

/// Runtime availability of one registered op.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOpStatus {
    pub name: &'static str,
    pub available: bool,
    /// Tools this op needs that were not found. Empty when `available`.
    pub missing_tools: Vec<&'static str>,
    /// The `PrepPlanStepId` this op implements, if any.
    pub filing_step: Option<&'static str>,
    pub max_input_bytes: Option<u64>,
}

pub fn registry(toolchain: &PathOpsToolchain) -> Vec<PathOpStatus> {
    OP_DESCRIPTORS
        .iter()
        .map(|descriptor| {
            let missing_tools: Vec<&'static str> = descriptor
                .requires
                .iter()
                .filter(|tool| match tool {
                    Tool::Qpdf => toolchain.qpdf.is_none(),
                    Tool::Ghostscript => toolchain.ghostscript.is_none(),
                    Tool::Ocrmypdf => toolchain.ocrmypdf.is_none(),
                    Tool::Node => !toolchain.node_one_shot,
                })
                .map(|tool| tool.name())
                .collect();
            PathOpStatus {
                name: descriptor.name,
                available: missing_tools.is_empty(),
                missing_tools,
                filing_step: descriptor.filing_step,
                max_input_bytes: descriptor.max_input_bytes,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const OCR_PROGRESS_PREFIX: &str = "@@RAIOPDF_OCR_PROGRESS@@ ";
const COMMAND_DIAGNOSTIC_LIMIT: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrProgress {
    pub phase: String,
    pub description: Option<String>,
    pub completed: f64,
    pub total: Option<f64>,
    pub unit: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcrProgressWire {
    phase: Option<String>,
    description: Option<String>,
    completed: f64,
    total: Option<f64>,
    unit: Option<String>,
}

pub(crate) fn run_command(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    prepend_path: &[PathBuf],
) -> OpResult<Output> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    if !prepend_path.is_empty() {
        let mut entries = prepend_path.to_vec();
        if let Some(inherited) = env::var_os("PATH") {
            entries.extend(env::split_paths(&inherited));
        }
        if let Ok(joined) = env::join_paths(entries) {
            command.env("PATH", joined);
        }
    }
    crate::apply_platform_spawn_flags(&mut command);

    command.output().map_err(|error| {
        PathOpError::failed(format!("{} spawn failed: {error}", program.display()))
    })
}

#[cfg(windows)]
pub(crate) fn run_powershell(script: &str) -> OpResult<Output> {
    let arguments: Vec<OsString> = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]
    .iter()
    .map(OsString::from)
    .collect();
    let output = run_command(Path::new("powershell.exe"), &arguments, None, &[])?;
    expect_success("powershell", &output)?;
    Ok(output)
}

fn run_command_with_ocr_progress<F>(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    prepend_path: &[PathBuf],
    on_progress: F,
) -> OpResult<()>
where
    F: FnMut(OcrProgress) + Send + 'static,
{
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    if !prepend_path.is_empty() {
        let mut entries = prepend_path.to_vec();
        if let Some(inherited) = env::var_os("PATH") {
            entries.extend(env::split_paths(&inherited));
        }
        if let Ok(joined) = env::join_paths(entries) {
            command.env("PATH", joined);
        }
    }
    crate::apply_platform_spawn_flags(&mut command);

    let mut child = command.spawn().map_err(|error| {
        PathOpError::failed(format!("{} spawn failed: {error}", program.display()))
    })?;

    let diagnostics = Arc::new(Mutex::new(String::new()));
    let stdout_thread = child
        .stdout
        .take()
        .map(|stdout| drain_plain_output(stdout, Arc::clone(&diagnostics)));
    let stderr_thread = child
        .stderr
        .take()
        .map(|stderr| drain_ocr_progress_output(stderr, Arc::clone(&diagnostics), on_progress));

    let status = child.wait().map_err(|error| {
        PathOpError::failed(format!("{} wait failed: {error}", program.display()))
    })?;

    if let Some(handle) = stdout_thread {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }

    if status.success() {
        return Ok(());
    }

    let detail = diagnostics
        .lock()
        .map(|buffer| buffer.trim().to_string())
        .unwrap_or_default();
    let detail = if detail.is_empty() {
        "no diagnostics captured".to_string()
    } else {
        detail
    };
    Err(PathOpError::failed(format!(
        "ocrmypdf failed ({status}): {detail}"
    )))
}

fn drain_plain_output<R>(reader: R, diagnostics: Arc<Mutex<String>>) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => push_capped_diagnostic(&diagnostics, &line),
                Err(error) => {
                    push_capped_diagnostic(&diagnostics, &format!("output read failed: {error}\n"));
                    break;
                }
            }
        }
    })
}

fn drain_ocr_progress_output<R, F>(
    reader: R,
    diagnostics: Arc<Mutex<String>>,
    mut on_progress: F,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
    F: FnMut(OcrProgress) + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(progress) = parse_ocr_progress_line(line.trim_end()) {
                        on_progress(progress);
                    } else {
                        push_capped_diagnostic(&diagnostics, &line);
                    }
                }
                Err(error) => {
                    push_capped_diagnostic(
                        &diagnostics,
                        &format!("error output read failed: {error}\n"),
                    );
                    break;
                }
            }
        }
    })
}

fn parse_ocr_progress_line(line: &str) -> Option<OcrProgress> {
    let json = line.strip_prefix(OCR_PROGRESS_PREFIX)?;
    let wire: OcrProgressWire = serde_json::from_str(json).ok()?;
    if !wire.completed.is_finite() || wire.completed < 0.0 {
        return None;
    }
    let total = match wire.total {
        Some(total) if total.is_finite() && total > 0.0 => Some(total),
        Some(total) if total.is_finite() && total == 0.0 => None,
        Some(_) => return None,
        None => None,
    };
    Some(OcrProgress {
        phase: non_empty_or(wire.phase, "ocr"),
        description: wire.description.and_then(non_empty_string),
        completed: wire.completed,
        total,
        unit: non_empty_or(wire.unit, "unit"),
    })
}

fn non_empty_or(value: Option<String>, fallback: &str) -> String {
    value
        .and_then(non_empty_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn push_capped_diagnostic(diagnostics: &Arc<Mutex<String>>, text: &str) {
    let Ok(mut buffer) = diagnostics.lock() else {
        return;
    };
    if buffer.len() >= COMMAND_DIAGNOSTIC_LIMIT {
        return;
    }
    let remaining = COMMAND_DIAGNOSTIC_LIMIT - buffer.len();
    if text.len() <= remaining {
        buffer.push_str(text);
        return;
    }
    let mut used = 0usize;
    for ch in text.chars() {
        let next = used + ch.len_utf8();
        if next > remaining {
            break;
        }
        buffer.push(ch);
        used = next;
    }
}

pub(crate) fn expect_success(tool: &str, output: &Output) -> OpResult<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    Err(PathOpError::failed(format!(
        "{tool} failed ({}): {detail}",
        output.status
    )))
}

pub(crate) fn args(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(OsString::from).collect()
}

fn run_qpdf(toolchain: &PathOpsToolchain, arguments: Vec<OsString>) -> OpResult<Output> {
    let qpdf = toolchain.require_qpdf()?;
    let output = run_command(qpdf, &arguments, None, &[])?;
    expect_success("qpdf", &output)?;
    Ok(output)
}

pub(crate) fn run_ghostscript(
    toolchain: &PathOpsToolchain,
    arguments: Vec<OsString>,
) -> OpResult<Output> {
    let ghostscript = toolchain.require_ghostscript()?;
    let output = run_command(ghostscript, &arguments, None, &[])?;
    expect_success("ghostscript", &output)?;
    Ok(output)
}

/// Ghostscript sandbox arguments: `-dSAFER` plus explicit permits scoped to
/// exactly the files this invocation touches. The bundled Ghostscript is 10.x,
/// where SAFER is already the default when neither flag is passed — passing it
/// explicitly with narrow permits is the belt-and-braces posture (and guards
/// against a future toolchain swap changing the default). Untrusted user PDFs
/// must never run with `-dNOSAFER`.
///
/// Command-line input operands and `-sOutputFile` are auto-permitted under
/// SAFER, so these explicit permits are redundant today — kept deliberately so
/// every call site states its exact file surface. Permit paths are emitted
/// with forward slashes: Ghostscript's permit matching accepts them against
/// backslash operands on Windows (verified empirically against gs 10.07.1),
/// and forward slashes behave more reliably across gs path handling.
fn gs_safer_args(read_paths: &[&Path], write_paths: &[&Path]) -> Vec<OsString> {
    let mut arguments = vec![OsString::from("-dSAFER")];
    for path in read_paths {
        arguments.push(OsString::from(format!(
            "--permit-file-read={}",
            gs_permit_path(path)
        )));
    }
    for path in write_paths {
        arguments.push(OsString::from(format!(
            "--permit-file-write={}",
            gs_permit_path(path)
        )));
    }
    arguments
}

/// Forward-slash-normalized path string for `--permit-file-*` values.
fn gs_permit_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

pub(crate) fn require_input_file(input: &Path) -> OpResult<u64> {
    let metadata = fs::metadata(input)
        .map_err(|error| PathOpError::io(&format!("input {}", input.display()), error))?;
    if !metadata.is_file() {
        return Err(PathOpError::invalid(format!(
            "input is not a file: {}",
            input.display()
        )));
    }
    Ok(metadata.len())
}

fn require_output(tool: &str, output_path: &Path) -> OpResult<u64> {
    let metadata = fs::metadata(output_path)
        .map_err(|error| PathOpError::failed(format!("{tool} produced no output file: {error}")))?;
    if metadata.len() == 0 {
        return Err(PathOpError::failed(format!(
            "{tool} produced an empty output"
        )));
    }
    Ok(metadata.len())
}

pub(crate) fn path_arg(path: &Path) -> OsString {
    path.as_os_str().to_os_string()
}

// ---------------------------------------------------------------------------
// Page-range helpers
// ---------------------------------------------------------------------------

/// Collapse zero-based page indexes into a compact ascending 1-based qpdf
/// range string ("1-5,9"). Rejects empty input and duplicates.
pub fn one_based_range_string(zero_based_pages: &[u32]) -> OpResult<String> {
    if zero_based_pages.is_empty() {
        return Err(PathOpError::invalid("no pages selected"));
    }
    let mut pages: Vec<u32> = zero_based_pages.to_vec();
    pages.sort_unstable();
    pages.dedup();
    if pages.len() != zero_based_pages.len() {
        return Err(PathOpError::invalid("duplicate page indexes"));
    }

    let mut ranges: Vec<String> = Vec::new();
    let mut run_start = pages[0];
    let mut run_end = pages[0];
    for &page in &pages[1..] {
        if page == run_end + 1 {
            run_end = page;
        } else {
            ranges.push(format_run(run_start, run_end));
            run_start = page;
            run_end = page;
        }
    }
    ranges.push(format_run(run_start, run_end));
    Ok(ranges.join(","))
}

fn format_run(start: u32, end: u32) -> String {
    if start == end {
        format!("{}", start + 1)
    } else {
        format!("{}-{}", start + 1, end + 1)
    }
}

// ---------------------------------------------------------------------------
// 1. page_count / document_facts
// ---------------------------------------------------------------------------

pub fn page_count(toolchain: &PathOpsToolchain, input: &Path) -> OpResult<u32> {
    require_input_file(input)?;
    let mut arguments = args(&["--warning-exit-0", "--show-npages"]);
    arguments.push(path_arg(input));
    let output = run_qpdf(toolchain, arguments)?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<u32>().map_err(|_| {
        PathOpError::failed(format!("unexpected --show-npages output: {}", text.trim()))
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFacts {
    /// Zero-based page index.
    pub index: u32,
    /// Raw MediaBox `[llx, lly, urx, ury]` in PDF points (pre-rotation).
    pub media_box: [f64; 4],
    /// Effective /Rotate, normalized to 0/90/180/270.
    pub rotate: i64,
    /// "portrait" | "landscape" after applying /Rotate.
    pub orientation: &'static str,
    /// True when the rotated extent is letter portrait (612x792 ± 1 pt).
    pub letter_portrait: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureDetectionFacts {
    pub standard_acro_form_signature_count: u32,
    pub has_byte_range_or_contents_markers: bool,
    pub has_certification_dictionary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFacts {
    pub page_count: u32,
    pub size_bytes: u64,
    pub encrypted: bool,
    pub signature_detection: SignatureDetectionFacts,
    pub pages: Vec<PageFacts>,
}

/// qpdf `--json` powered document facts: page count, per-page boxes and
/// orientations, encryption, and file size — the streamed-mode preflight input
/// (plan [R5-2]).
pub fn document_facts(toolchain: &PathOpsToolchain, input: &Path) -> OpResult<DocumentFacts> {
    let size_bytes = require_input_file(input)?;
    let mut arguments = args(&[
        "--warning-exit-0",
        "--json=latest",
        "--json-key=pages",
        "--json-key=qpdf",
        "--json-key=encrypt",
    ]);
    arguments.push(path_arg(input));
    let output = run_qpdf(toolchain, arguments)?;
    parse_document_facts(&output.stdout, size_bytes)
}

/// Probe whether a standalone PDF path has an extractable text layer.
///
/// This intentionally does not use `document_facts`, which is qpdf metadata
/// only. Ghostscript's `txtwrite` device extracts existing text; a non-empty
/// extraction means the PDF has searchable text for reflow preflight purposes.
pub fn pdf_has_text_layer(toolchain: &PathOpsToolchain, input: &Path) -> OpResult<bool> {
    require_input_file(input)?;
    let temp_dir = TextLayerTempDir::create()?;
    let output_txt = temp_dir.path().join("extracted.txt");
    run_ghostscript(toolchain, txt_extract_gs_args(input, &output_txt))?;
    let extracted =
        fs::read(&output_txt).map_err(|error| PathOpError::io("read extracted text", error))?;
    Ok(extracted_text_has_text_layer(&String::from_utf8_lossy(
        &extracted,
    )))
}

pub fn extracted_text_has_text_layer(extracted: &str) -> bool {
    !extracted.trim().is_empty()
}

struct TextLayerTempDir {
    path: PathBuf,
}

impl TextLayerTempDir {
    fn create() -> OpResult<Self> {
        let sequence = TEXT_LAYER_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = env::temp_dir().join(format!(
            "raiopdf-text-layer-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path)
            .map_err(|error| PathOpError::io("create text-layer temp dir", error))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TextLayerTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

const LETTER_WIDTH_PT: f64 = 612.0;
const LETTER_HEIGHT_PT: f64 = 792.0;
const LETTER_TOLERANCE_PT: f64 = 1.0;
const MAX_INHERITANCE_DEPTH: usize = 64;

pub(crate) fn parse_document_facts(json: &[u8], size_bytes: u64) -> OpResult<DocumentFacts> {
    let root: serde_json::Value = serde_json::from_slice(json)
        .map_err(|error| PathOpError::failed(format!("qpdf --json parse error: {error}")))?;

    let pages = root
        .get("pages")
        .and_then(|value| value.as_array())
        .ok_or_else(|| PathOpError::failed("qpdf --json output missing pages"))?;
    let objects = root
        .get("qpdf")
        .and_then(|value| value.as_array())
        .and_then(|entries| entries.get(1))
        .and_then(|value| value.as_object())
        .ok_or_else(|| PathOpError::failed("qpdf --json output missing object table"))?;
    let encrypted = root
        .get("encrypt")
        .and_then(|value| value.get("encrypted"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let signature_detection = read_signature_detection_facts(objects);

    let mut page_facts = Vec::with_capacity(pages.len());
    for (index, page) in pages.iter().enumerate() {
        let page_ref = page
            .get("object")
            .and_then(|value| value.as_str())
            .ok_or_else(|| PathOpError::failed(format!("page {index} missing object ref")))?;

        let media_box = inherited_attribute(objects, page_ref, "/MediaBox")?
            .ok_or_else(|| PathOpError::failed(format!("page {index} has no MediaBox")))?;
        let media_box = parse_rectangle(objects, &media_box)
            .ok_or_else(|| PathOpError::failed(format!("page {index} has malformed MediaBox")))?;

        let rotate = inherited_attribute(objects, page_ref, "/Rotate")?
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        let rotate = rotate.rem_euclid(360);

        let width = (media_box[2] - media_box[0]).abs();
        let height = (media_box[3] - media_box[1]).abs();
        let (effective_width, effective_height) = if rotate == 90 || rotate == 270 {
            (height, width)
        } else {
            (width, height)
        };
        let orientation = if effective_height + f64::EPSILON >= effective_width {
            "portrait"
        } else {
            "landscape"
        };
        let letter_portrait = (effective_width - LETTER_WIDTH_PT).abs() <= LETTER_TOLERANCE_PT
            && (effective_height - LETTER_HEIGHT_PT).abs() <= LETTER_TOLERANCE_PT;

        page_facts.push(PageFacts {
            index: index as u32,
            media_box,
            rotate,
            orientation,
            letter_portrait,
        });
    }

    Ok(DocumentFacts {
        page_count: page_facts.len() as u32,
        size_bytes,
        encrypted,
        signature_detection,
        pages: page_facts,
    })
}

fn read_signature_detection_facts(objects: &JsonObjectMap) -> SignatureDetectionFacts {
    let mut signature_field_refs = std::collections::BTreeSet::<String>::new();
    let mut has_byte_range_or_contents_markers = false;
    let mut has_certification_dictionary = false;

    for (object_ref, entry) in objects {
        let Some(value) = entry.get("value").and_then(|value| value.as_object()) else {
            continue;
        };

        if json_name(value.get("/FT")) == Some("Sig") {
            signature_field_refs.insert(object_ref.clone());
        }

        let type_name = json_name(value.get("/Type"));
        let sub_filter = json_name(value.get("/SubFilter"));
        let has_known_sub_filter = sub_filter.map(is_signature_sub_filter).unwrap_or(false);
        let has_byte_range = value.contains_key("/ByteRange");
        let has_contents = value.contains_key("/Contents");

        if has_byte_range || has_known_sub_filter || (has_contents && type_name == Some("Sig")) {
            has_byte_range_or_contents_markers = true;
        }

        if type_name == Some("Catalog")
            && value
                .get("/Perms")
                .map(|perms| dictionary_has_any_key(objects, perms, &["/DocMDP", "/UR", "/UR3"]))
                .unwrap_or(false)
        {
            has_certification_dictionary = true;
        }
    }

    SignatureDetectionFacts {
        standard_acro_form_signature_count: signature_field_refs.len() as u32,
        has_byte_range_or_contents_markers,
        has_certification_dictionary,
    }
}

fn json_name(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(|value| value.as_str())
        .and_then(|value| value.strip_prefix('/'))
}

fn is_signature_sub_filter(value: &str) -> bool {
    matches!(
        value,
        "adbe.pkcs7.detached"
            | "adbe.pkcs7.sha1"
            | "adbe.x509.rsa_sha1"
            | "ETSI.CAdES.detached"
            | "ETSI.RFC3161"
    )
}

fn dictionary_has_any_key(
    objects: &JsonObjectMap,
    value: &serde_json::Value,
    keys: &[&str],
) -> bool {
    let resolved = deref(objects, value);
    let Some(map) = resolved.as_object() else {
        return false;
    };

    keys.iter().any(|key| map.contains_key(*key))
}

type JsonObjectMap = serde_json::Map<String, serde_json::Value>;

fn object_value<'a>(objects: &'a JsonObjectMap, object_ref: &str) -> Option<&'a serde_json::Value> {
    objects
        .get(&format!("obj:{object_ref}"))
        .and_then(|entry| entry.get("value"))
}

fn deref<'a>(objects: &'a JsonObjectMap, value: &'a serde_json::Value) -> &'a serde_json::Value {
    if let Some(text) = value.as_str() {
        if is_object_ref(text) {
            if let Some(resolved) = object_value(objects, text) {
                return resolved;
            }
        }
    }
    value
}

fn is_object_ref(text: &str) -> bool {
    let mut parts = text.split(' ');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(object), Some(generation), Some("R"), None)
            if object.chars().all(|c| c.is_ascii_digit())
                && generation.chars().all(|c| c.is_ascii_digit())
    )
}

/// Resolve an inheritable page attribute (`/MediaBox`, `/Rotate`) by walking
/// `/Parent` links, with a depth cap to survive malformed cyclic trees.
fn inherited_attribute(
    objects: &JsonObjectMap,
    page_ref: &str,
    key: &str,
) -> OpResult<Option<serde_json::Value>> {
    let mut current = page_ref.to_string();
    for _ in 0..MAX_INHERITANCE_DEPTH {
        let Some(node) = object_value(objects, &current) else {
            return Ok(None);
        };
        if let Some(value) = node.get(key) {
            return Ok(Some(deref(objects, value).clone()));
        }
        match node.get("/Parent").and_then(|value| value.as_str()) {
            Some(parent_ref) if is_object_ref(parent_ref) => current = parent_ref.to_string(),
            _ => return Ok(None),
        }
    }
    Err(PathOpError::failed(
        "page tree exceeds maximum inheritance depth (cyclic /Parent chain?)",
    ))
}

fn parse_rectangle(objects: &JsonObjectMap, value: &serde_json::Value) -> Option<[f64; 4]> {
    let entries = value.as_array()?;
    if entries.len() != 4 {
        return None;
    }
    let mut rectangle = [0.0f64; 4];
    for (slot, entry) in rectangle.iter_mut().zip(entries.iter()) {
        *slot = deref(objects, entry).as_f64()?;
    }
    Some(rectangle)
}

// ---------------------------------------------------------------------------
// 2. decrypt
// ---------------------------------------------------------------------------

/// File-to-file qpdf `--decrypt`. The password travels via a temp file inside
/// `work_dir` (never a process argument), matching the sidecar's discipline.
pub fn decrypt(
    toolchain: &PathOpsToolchain,
    input: &Path,
    password: &str,
    output_path: &Path,
    work_dir: &Path,
) -> OpResult<()> {
    require_input_file(input)?;
    let password_path = work_dir.join("pw.txt");
    fs::write(&password_path, password.as_bytes())
        .map_err(|error| PathOpError::io("write password file", error))?;

    let mut arguments = args(&["--warning-exit-0", "--decrypt"]);
    arguments.push(OsString::from(format!(
        "--password-file={}",
        password_path.display()
    )));
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    let result = run_qpdf(toolchain, arguments);
    let _ = fs::remove_file(&password_path);
    result?;
    require_output("qpdf --decrypt", output_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 3. extract_pages / merge
// ---------------------------------------------------------------------------

/// qpdf `--pages` extraction of zero-based page indexes into a new file.
pub fn extract_pages(
    toolchain: &PathOpsToolchain,
    input: &Path,
    zero_based_pages: &[u32],
    output_path: &Path,
) -> OpResult<()> {
    let total = page_count(toolchain, input)?;
    if let Some(&max) = zero_based_pages.iter().max() {
        if max >= total {
            return Err(PathOpError::invalid(format!(
                "page index {max} out of range (document has {total} pages)"
            )));
        }
    }
    let range = one_based_range_string(zero_based_pages)?;
    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(input));
    arguments.extend(args(&["--pages", "."]));
    arguments.push(OsString::from(range));
    arguments.push(OsString::from("--"));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf --pages", output_path)?;
    Ok(())
}

/// qpdf `--pages` merge of whole input files, in order.
pub fn merge(toolchain: &PathOpsToolchain, inputs: &[PathBuf], output_path: &Path) -> OpResult<()> {
    if inputs.len() < 2 {
        return Err(PathOpError::invalid("merge requires at least two inputs"));
    }
    for input in inputs {
        require_input_file(input)?;
    }
    let mut arguments = args(&["--warning-exit-0", "--empty", "--pages"]);
    for input in inputs {
        arguments.push(path_arg(input));
        arguments.push(OsString::from("1-z"));
    }
    arguments.push(OsString::from("--"));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf merge", output_path)?;
    Ok(())
}

/// qpdf `--pages` composition that inserts every page of `insert` into
/// `input` after the first `at_index` pages (`at_index` = number of original
/// pages that precede the inserted run; `0` prepends, `page_count` appends).
/// Mirrors the byte engine's `insertPages(handle, insertAtPageIndex, doc)`
/// semantics, file→file — a one-liner range assembly like `assemble_redacted`.
pub fn insert_pages(
    toolchain: &PathOpsToolchain,
    input: &Path,
    insert: &Path,
    at_index: u32,
    output_path: &Path,
) -> OpResult<()> {
    require_input_file(input)?;
    require_input_file(insert)?;
    let total = page_count(toolchain, input)?;
    if at_index > total {
        return Err(PathOpError::invalid(format!(
            "insert index {at_index} out of range (document has {total} pages)"
        )));
    }

    let mut arguments = args(&["--warning-exit-0", "--empty", "--pages"]);
    if at_index > 0 {
        arguments.push(path_arg(input));
        arguments.push(OsString::from(format!("1-{at_index}")));
    }
    arguments.push(path_arg(insert));
    arguments.push(OsString::from("1-z"));
    if at_index < total {
        arguments.push(path_arg(input));
        arguments.push(OsString::from(format!("{}-z", at_index + 1)));
    }
    arguments.push(OsString::from("--"));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf insert", output_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 4. split_by_max_bytes
// ---------------------------------------------------------------------------

/// One planned part, 1-based inclusive page bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PlannedPart {
    pub start: u32,
    pub end: u32,
    pub size: u64,
    pub oversized: bool,
}

/// Two-pass sizing (plan [R1-10]): greedy probe of the whole remainder,
/// binary-searching the boundary only when the probe overshoots. `probe` builds
/// a candidate part `[start, end]` (1-based inclusive) and returns its byte
/// size. Pure logic — the qpdf executor and the tests inject different probes.
pub(crate) fn plan_split<F>(
    total_pages: u32,
    max_bytes: u64,
    probe: &mut F,
) -> OpResult<Vec<PlannedPart>>
where
    F: FnMut(u32, u32) -> OpResult<u64>,
{
    if total_pages == 0 {
        return Err(PathOpError::invalid("document has no pages"));
    }
    if max_bytes == 0 {
        return Err(PathOpError::invalid("byte cap must be positive"));
    }

    let mut parts = Vec::new();
    let mut cursor = 1u32;
    while cursor <= total_pages {
        // Greedy: does the whole remainder fit?
        let remainder_size = probe(cursor, total_pages)?;
        if remainder_size <= max_bytes {
            parts.push(PlannedPart {
                start: cursor,
                end: total_pages,
                size: remainder_size,
                oversized: false,
            });
            break;
        }
        // A single page that cannot fit becomes its own oversized part.
        let single_size = probe(cursor, cursor)?;
        if single_size > max_bytes {
            parts.push(PlannedPart {
                start: cursor,
                end: cursor,
                size: single_size,
                oversized: true,
            });
            cursor += 1;
            continue;
        }
        // Binary search the largest end page that still fits. Invariant:
        // [cursor, low] fits, [cursor, high] overshoots.
        let mut low = cursor;
        let mut low_size = single_size;
        let mut high = total_pages;
        while high - low > 1 {
            let middle = low + (high - low) / 2;
            let size = probe(cursor, middle)?;
            if size <= max_bytes {
                low = middle;
                low_size = size;
            } else {
                high = middle;
            }
        }
        parts.push(PlannedPart {
            start: cursor,
            end: low,
            size: low_size,
            oversized: false,
        });
        cursor = low + 1;
    }
    Ok(parts)
}

/// One finished split part on disk.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPartFile {
    #[serde(skip)]
    pub path: PathBuf,
    /// Zero-based inclusive source page bounds.
    pub first_page_index: u32,
    pub last_page_index: u32,
    pub byte_length: u64,
    pub oversized: bool,
}

/// Split `input` at page boundaries against `max_bytes`, writing each part
/// exactly once into `out_dir` (`part-001.pdf`, ...). Probes are written to a
/// single scratch file that is deleted afterwards.
pub fn split_by_max_bytes(
    toolchain: &PathOpsToolchain,
    input: &Path,
    max_bytes: u64,
    out_dir: &Path,
) -> OpResult<Vec<SplitPartFile>> {
    require_input_file(input)?;
    let total_pages = page_count(toolchain, input)?;
    let probe_path = out_dir.join("split-probe.pdf");

    let mut probe = |start: u32, end: u32| -> OpResult<u64> {
        build_page_range(toolchain, input, start, end, &probe_path)?;
        fs::metadata(&probe_path)
            .map(|metadata| metadata.len())
            .map_err(|error| PathOpError::io("stat split probe", error))
    };
    let plan = plan_split(total_pages, max_bytes, &mut probe);
    let _ = fs::remove_file(&probe_path);
    let plan = plan?;

    let mut parts = Vec::with_capacity(plan.len());
    for (index, planned) in plan.iter().enumerate() {
        let part_path = out_dir.join(format!("part-{:03}.pdf", index + 1));
        build_page_range(toolchain, input, planned.start, planned.end, &part_path)?;
        let byte_length = require_output("qpdf split", &part_path)?;
        parts.push(SplitPartFile {
            path: part_path,
            first_page_index: planned.start - 1,
            last_page_index: planned.end - 1,
            byte_length,
            oversized: planned.oversized,
        });
    }
    Ok(parts)
}

pub(crate) fn build_page_range(
    toolchain: &PathOpsToolchain,
    input: &Path,
    start: u32,
    end: u32,
    output_path: &Path,
) -> OpResult<()> {
    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(input));
    arguments.extend(args(&["--pages", "."]));
    arguments.push(OsString::from(format!("{start}-{end}")));
    arguments.push(OsString::from("--"));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Ghostscript rewrites: normalize / sanitize
// ---------------------------------------------------------------------------

/// Ghostscript pdfwrite rewrite that fits every page onto letter portrait
/// (612x792), preserving aspect ratio (letterboxed, never distorted).
pub fn normalize_to_letter_portrait(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output_path: &Path,
) -> OpResult<()> {
    require_input_file(input)?;
    run_ghostscript(toolchain, normalize_gs_args(input, output_path))?;
    require_output("ghostscript normalize", output_path)?;
    Ok(())
}

/// Pure arg builder for the normalize rewrite — split out so the SAFER posture
/// is unit-testable without a toolchain.
fn normalize_gs_args(input: &Path, output_path: &Path) -> Vec<OsString> {
    let mut arguments = args(&["-dBATCH", "-dNOPAUSE"]);
    arguments.extend(gs_safer_args(&[input], &[output_path]));
    arguments.extend(args(&[
        "-sDEVICE=pdfwrite",
        "-dFIXEDMEDIA",
        "-dPDFFitPage",
        "-dDEVICEWIDTHPOINTS=612",
        "-dDEVICEHEIGHTPOINTS=792",
        "-dAutoRotatePages=/None",
        "-dPassThroughJPEGImages=false",
    ]));
    arguments.push(OsString::from(format!(
        "-sOutputFile={}",
        output_path.display()
    )));
    arguments.push(path_arg(input));
    arguments
}

/// Ghostscript pdfwrite rewrite as content sanitizing: document-level
/// JavaScript, embedded files, and launch actions do not survive the rewrite.
pub fn sanitize(toolchain: &PathOpsToolchain, input: &Path, output_path: &Path) -> OpResult<()> {
    require_input_file(input)?;
    run_ghostscript(toolchain, sanitize_gs_args(input, output_path))?;
    require_output("ghostscript sanitize", output_path)?;
    Ok(())
}

fn sanitize_gs_args(input: &Path, output_path: &Path) -> Vec<OsString> {
    let mut arguments = args(&["-dBATCH", "-dNOPAUSE"]);
    arguments.extend(gs_safer_args(&[input], &[output_path]));
    arguments.extend(args(&["-sDEVICE=pdfwrite", "-dAutoRotatePages=/None"]));
    arguments.push(OsString::from(format!(
        "-sOutputFile={}",
        output_path.display()
    )));
    arguments.push(path_arg(input));
    arguments
}

/// Redaction step 2: rasterize the boxed pages (`pdfimage24`) so the
/// underlying text objects are destroyed.
fn rasterize_gs_args(input: &Path, output_path: &Path) -> Vec<OsString> {
    let mut arguments = args(&["-dBATCH", "-dNOPAUSE"]);
    arguments.extend(gs_safer_args(&[input], &[output_path]));
    arguments.extend(args(&["-sDEVICE=pdfimage24", "-r150"]));
    arguments.push(OsString::from(format!(
        "-sOutputFile={}",
        output_path.display()
    )));
    arguments.push(path_arg(input));
    arguments
}

/// Redaction step 4: re-extract text (`txtwrite`) from the redacted pages of
/// the output for the fail-closed verification pass.
fn txt_extract_gs_args(input: &Path, output_txt: &Path) -> Vec<OsString> {
    let mut arguments = args(&["-dBATCH", "-dNOPAUSE"]);
    arguments.extend(gs_safer_args(&[input], &[output_txt]));
    arguments.push(OsString::from("-sDEVICE=txtwrite"));
    arguments.push(OsString::from(format!(
        "-sOutputFile={}",
        output_txt.display()
    )));
    arguments.push(path_arg(input));
    arguments
}

// ---------------------------------------------------------------------------
// scrub_metadata / repair / linearize / compress
// ---------------------------------------------------------------------------

/// qpdf metadata scrub: removes XMP `/Metadata` and the Info dictionary
/// (qpdf retains ModDate — noted in the op report).
pub fn scrub_metadata(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output_path: &Path,
) -> OpResult<()> {
    require_input_file(input)?;
    let mut arguments = args(&["--warning-exit-0", "--remove-metadata", "--remove-info"]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf scrub", output_path)?;
    Ok(())
}

/// qpdf structural rewrite — reconstructs the xref and normalizes damage.
pub fn repair(toolchain: &PathOpsToolchain, input: &Path, output_path: &Path) -> OpResult<()> {
    require_input_file(input)?;
    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf repair", output_path)?;
    Ok(())
}

pub fn linearize(toolchain: &PathOpsToolchain, input: &Path, output_path: &Path) -> OpResult<()> {
    require_input_file(input)?;
    let mut arguments = args(&["--warning-exit-0", "--linearize"]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf linearize", output_path)?;
    Ok(())
}

/// qpdf stream-level recompression (object streams + flate recompress +
/// linearize). Ghostscript image downsampling is a later variant.
pub fn compress(toolchain: &PathOpsToolchain, input: &Path, output_path: &Path) -> OpResult<()> {
    require_input_file(input)?;
    let mut arguments = args(&[
        "--warning-exit-0",
        "--object-streams=generate",
        "--compress-streams=y",
        "--recompress-flate",
        "--linearize",
    ]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf compress", output_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 5. OCR
// ---------------------------------------------------------------------------

/// OCRmyPDF text-layer strategy. `SkipText` keeps any existing text layer
/// untouched; `ForceOcr` re-renders processed pages and rebuilds the text
/// layer from scratch (the garbled-text-layer recovery path).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OcrMode {
    #[default]
    SkipText,
    ForceOcr,
}

impl OcrMode {
    pub const fn flag(self) -> &'static str {
        match self {
            OcrMode::SkipText => "--skip-text",
            OcrMode::ForceOcr => "--force-ocr",
        }
    }

    pub const fn wrapper_mode(self) -> &'static str {
        match self {
            OcrMode::SkipText => "skip",
            OcrMode::ForceOcr => "force",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcrOptions {
    pub mode: OcrMode,
    pub languages: Vec<String>,
    pub deskew: bool,
    pub page_indexes: Vec<u32>,
}

impl OcrOptions {
    pub fn with_mode(mode: OcrMode) -> Self {
        Self {
            mode,
            ..Self::default()
        }
    }
}

impl Default for OcrOptions {
    fn default() -> Self {
        Self {
            mode: OcrMode::SkipText,
            languages: vec!["eng".to_string()],
            deskew: false,
            page_indexes: Vec::new(),
        }
    }
}

/// Pure argument construction for the OCR op (unit-testable without the
/// toolchain): mode flag first, then output format and OCR options.
fn ocr_arguments(options: &OcrOptions) -> OpResult<Vec<OsString>> {
    let mut arguments = args(&[options.mode.flag(), "--output-type", "pdf"]);
    append_ocr_option_arguments(&mut arguments, options)?;
    Ok(arguments)
}

fn ocr_progress_arguments(options: &OcrOptions) -> OpResult<Vec<OsString>> {
    let mut arguments = args(&[
        "--mode",
        options.mode.wrapper_mode(),
        "--output-type",
        "pdf",
    ]);
    append_ocr_option_arguments(&mut arguments, options)?;
    Ok(arguments)
}

fn append_ocr_option_arguments(
    arguments: &mut Vec<OsString>,
    options: &OcrOptions,
) -> OpResult<()> {
    for language in normalized_ocr_languages(&options.languages) {
        arguments.push(OsString::from("--language"));
        arguments.push(OsString::from(language));
    }
    if options.deskew {
        arguments.push(OsString::from("--deskew"));
    }
    if !options.page_indexes.is_empty() {
        arguments.push(OsString::from("--pages"));
        arguments.push(OsString::from(one_based_range_string(
            &options.page_indexes,
        )?));
    }
    Ok(())
}

fn normalized_ocr_languages(languages: &[String]) -> Vec<&str> {
    let normalized = languages
        .iter()
        .map(|language| language.trim())
        .filter(|language| !language.is_empty())
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        vec!["eng"]
    } else {
        normalized
    }
}

/// By-path OCRmyPDF run — skips the sidecar HTTP byte upload entirely. The
/// bundled `ocrmypdf.cmd` is self-contained for Python but resolves
/// `tesseract` and `gs` from PATH, so the payload bin dirs are prepended.
/// Keeps existing text layers (`--skip-text`) — the `prepare_filing`
/// make-searchable step and the default OCR workflow both want that.
pub fn ocr(toolchain: &PathOpsToolchain, input: &Path, output_path: &Path) -> OpResult<()> {
    ocr_with_mode(toolchain, input, output_path, OcrMode::SkipText)
}

/// `ocr` with an explicit text-layer mode (skip-text | force-ocr).
pub fn ocr_with_mode(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output_path: &Path,
    mode: OcrMode,
) -> OpResult<()> {
    ocr_with_options(toolchain, input, output_path, &OcrOptions::with_mode(mode))
}

/// `ocr` with explicit text-layer, language, and deskew options.
pub fn ocr_with_options(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output_path: &Path,
    options: &OcrOptions,
) -> OpResult<()> {
    require_input_file(input)?;
    let ocrmypdf = toolchain.require_ocrmypdf()?;
    let mut arguments = ocr_arguments(options)?;
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    let output = run_command(ocrmypdf, &arguments, None, &toolchain.path_entries)?;
    expect_success("ocrmypdf", &output)?;
    require_output("ocrmypdf", output_path)?;
    Ok(())
}

/// OCR through RaioPDF's bundled OCRmyPDF API wrapper. When the wrapper is not
/// available (for example an external `RAIOPDF_ENGINE_OCRMYPDF` override), the
/// operation falls back to the plain CLI path with no progress events.
pub fn ocr_with_mode_and_progress<F>(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output_path: &Path,
    mode: OcrMode,
    on_progress: F,
) -> OpResult<()>
where
    F: FnMut(OcrProgress) + Send + 'static,
{
    ocr_with_options_and_progress(
        toolchain,
        input,
        output_path,
        &OcrOptions::with_mode(mode),
        on_progress,
    )
}

/// OCR through RaioPDF's bundled OCRmyPDF API wrapper with explicit OCR options.
pub fn ocr_with_options_and_progress<F>(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output_path: &Path,
    options: &OcrOptions,
    on_progress: F,
) -> OpResult<()>
where
    F: FnMut(OcrProgress) + Send + 'static,
{
    require_input_file(input)?;
    let Some(progress_runner) = toolchain.ocr_progress.as_deref() else {
        return ocr_with_options(toolchain, input, output_path, options);
    };
    let mut arguments = ocr_progress_arguments(options)?;
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    run_command_with_ocr_progress(
        progress_runner,
        &arguments,
        None,
        &toolchain.path_entries,
        on_progress,
    )?;
    require_output("ocrmypdf", output_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 5b. Stamping ops (bates_stamp / page_numbers / watermark) — the overlay
// technique: generate an overlay PDF (one page per document page, text at the
// configured placement, MediaBoxes matched from document_facts), then a
// single qpdf `--overlay` pass. Option shapes mirror the byte engine's
// `PdfBatesStampOptions` / `PdfPageNumbersOptions` / `PdfWatermarkOptions`
// from `@raiopdf/engine-api`.
// ---------------------------------------------------------------------------

const POINTS_PER_INCH: f64 = 72.0;
const DEFAULT_STAMP_FONT_SIZE_PT: f64 = 11.0;
const DEFAULT_STAMP_MARGIN_IN: f64 = 0.5;
const DEFAULT_WATERMARK_FONT_SIZE_PT: f64 = 48.0;
const DEFAULT_WATERMARK_OPACITY: f64 = 0.18;
const WATERMARK_GRAY: f64 = 0.35;
/// Cap keeping `10^digits` comfortably inside u64 range.
const MAX_BATES_DIGITS: u32 = 15;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StampEdge {
    Header,
    Footer,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StampAlign {
    Left,
    Center,
    Right,
}

/// Mirrors `PdfStampPlacement` (`{ edge, align }`).
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampPlacement {
    pub edge: StampEdge,
    pub align: StampAlign,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PageSelectionKeyword {
    All,
    First,
}

/// Mirrors `PdfPageSelection` (`readonly number[] | "all" | "first"`).
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum PageSelection {
    Keyword(PageSelectionKeyword),
    Indexes(Vec<u32>),
}

impl PageSelection {
    /// Resolve to zero-based page indexes, deduplicated in first-seen order
    /// (mirrors the byte engine's `resolvePageSelection`). Rejects
    /// out-of-range indexes.
    fn resolve(&self, page_count: u32) -> OpResult<Vec<u32>> {
        match self {
            PageSelection::Keyword(PageSelectionKeyword::All) => Ok((0..page_count).collect()),
            PageSelection::Keyword(PageSelectionKeyword::First) => {
                Ok(if page_count == 0 { Vec::new() } else { vec![0] })
            }
            PageSelection::Indexes(indexes) => {
                let mut seen = Vec::with_capacity(indexes.len());
                for &index in indexes {
                    if index >= page_count {
                        return Err(PathOpError::invalid(format!(
                            "page index {index} out of range (document has {page_count} pages)"
                        )));
                    }
                    if !seen.contains(&index) {
                        seen.push(index);
                    }
                }
                if seen.is_empty() {
                    return Err(PathOpError::invalid("no pages selected"));
                }
                Ok(seen)
            }
        }
    }
}

/// Mirrors `PdfBatesStampOptions`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatesStampOptions {
    pub prefix: String,
    pub start: u32,
    pub digits: u32,
    pub placement: StampPlacement,
    #[serde(default)]
    pub font_size_pt: Option<f64>,
    #[serde(default)]
    pub margin_in: Option<f64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageNumberFormat {
    Number,
    PageOfTotal,
}

/// Mirrors `PdfPageNumbersOptions`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageNumbersOptions {
    pub start_at: u32,
    pub page_indexes: PageSelection,
    pub format: PageNumberFormat,
    pub placement: StampPlacement,
    #[serde(default)]
    pub font_size_pt: Option<f64>,
    #[serde(default)]
    pub margin_in: Option<f64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WatermarkOrientation {
    Diagonal,
    Horizontal,
}

/// Mirrors `PdfWatermarkOptions`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkOptions {
    pub text: String,
    pub page_indexes: PageSelection,
    pub orientation: WatermarkOrientation,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub font_size_pt: Option<f64>,
}

/// Bates-stamp every page: `prefix` + zero-padded `start + pageIndex` at the
/// configured placement. Fails when the last number would overflow the digit
/// width (mirrors the byte engine's `assertBatesFitsPageCount`).
pub fn bates_stamp(
    toolchain: &PathOpsToolchain,
    input: &Path,
    options: &BatesStampOptions,
    output_path: &Path,
    work_dir: &Path,
) -> OpResult<()> {
    let facts = document_facts(toolchain, input)?;
    let overlay_pages = plan_bates_overlay(&facts.pages, options)?;
    apply_text_overlay(toolchain, input, &overlay_pages, output_path, work_dir)
}

pub(crate) fn plan_bates_overlay(
    pages: &[PageFacts],
    options: &BatesStampOptions,
) -> OpResult<Vec<MiniPdfPage>> {
    if options.digits == 0 || options.digits > MAX_BATES_DIGITS {
        return Err(PathOpError::invalid(format!(
            "Bates digits must be between 1 and {MAX_BATES_DIGITS}."
        )));
    }
    let (font_size_pt, margin_in) = stamp_defaults(options.font_size_pt, options.margin_in)?;
    if pages.is_empty() {
        return Err(PathOpError::invalid("document has no pages"));
    }
    let last_number = u64::from(options.start) + pages.len() as u64 - 1;
    if last_number >= 10u64.pow(options.digits) {
        return Err(PathOpError::invalid(
            "Bates numbers exceed the configured digit width.",
        ));
    }

    pages
        .iter()
        .map(|page| {
            let number = u64::from(options.start) + u64::from(page.index);
            let text = format!(
                "{}{:0width$}",
                options.prefix,
                number,
                width = options.digits as usize
            );
            let stamp = plan_edge_stamp(page, &text, options.placement, font_size_pt, margin_in)?;
            Ok(overlay_page(page, vec![stamp]))
        })
        .collect()
}

/// Number the selected pages: `startAt + offset` in selection order, either
/// as a bare number or `Page N of M` (M = the document's page count, matching
/// the byte engine). Unselected pages get an empty overlay page.
pub fn page_numbers(
    toolchain: &PathOpsToolchain,
    input: &Path,
    options: &PageNumbersOptions,
    output_path: &Path,
    work_dir: &Path,
) -> OpResult<()> {
    let facts = document_facts(toolchain, input)?;
    let overlay_pages = plan_page_numbers_overlay(&facts.pages, options)?;
    apply_text_overlay(toolchain, input, &overlay_pages, output_path, work_dir)
}

pub(crate) fn plan_page_numbers_overlay(
    pages: &[PageFacts],
    options: &PageNumbersOptions,
) -> OpResult<Vec<MiniPdfPage>> {
    let (font_size_pt, margin_in) = stamp_defaults(options.font_size_pt, options.margin_in)?;
    let page_count = pages.len() as u32;
    let selected = options.page_indexes.resolve(page_count)?;

    let mut texts_by_page: BTreeMap<u32, MiniPdfText> = BTreeMap::new();
    for (offset, &page_index) in selected.iter().enumerate() {
        let page_number = u64::from(options.start_at) + offset as u64;
        let text = match options.format {
            PageNumberFormat::Number => page_number.to_string(),
            PageNumberFormat::PageOfTotal => format!("Page {page_number} of {page_count}"),
        };
        let stamp = plan_edge_stamp(
            &pages[page_index as usize],
            &text,
            options.placement,
            font_size_pt,
            margin_in,
        )?;
        texts_by_page.insert(page_index, stamp);
    }

    Ok(pages
        .iter()
        .map(|page| {
            overlay_page(
                page,
                texts_by_page.remove(&page.index).into_iter().collect(),
            )
        })
        .collect())
}

/// Watermark the selected pages: Helvetica-Bold gray text, centered, diagonal
/// (45°) or horizontal, fit-scaled so the rotated bounds stay on the page,
/// stamped with real transparency (ExtGState `/ca`).
pub fn watermark(
    toolchain: &PathOpsToolchain,
    input: &Path,
    options: &WatermarkOptions,
    output_path: &Path,
    work_dir: &Path,
) -> OpResult<()> {
    let facts = document_facts(toolchain, input)?;
    let overlay_pages = plan_watermark_overlay(&facts.pages, options)?;
    apply_text_overlay(toolchain, input, &overlay_pages, output_path, work_dir)
}

pub(crate) fn plan_watermark_overlay(
    pages: &[PageFacts],
    options: &WatermarkOptions,
) -> OpResult<Vec<MiniPdfPage>> {
    if options.text.is_empty() {
        return Err(PathOpError::invalid("Stamp text must not be empty."));
    }
    let font_size_pt = options
        .font_size_pt
        .unwrap_or(DEFAULT_WATERMARK_FONT_SIZE_PT);
    if !(font_size_pt.is_finite() && font_size_pt > 0.0) {
        return Err(PathOpError::invalid(
            "fontSizePt must be a positive number.",
        ));
    }
    let opacity = options.opacity.unwrap_or(DEFAULT_WATERMARK_OPACITY);
    if !(opacity.is_finite() && (0.0..=1.0).contains(&opacity)) {
        return Err(PathOpError::invalid(
            "Watermark opacity must be between 0 and 1.",
        ));
    }

    let page_count = pages.len() as u32;
    let selected = options.page_indexes.resolve(page_count)?;
    let selected: std::collections::BTreeSet<u32> = selected.into_iter().collect();

    pages
        .iter()
        .map(|page| {
            if !selected.contains(&page.index) {
                return Ok(overlay_page(page, Vec::new()));
            }

            let (page_width, page_height) = page_box_size(page);
            let rotation = page.rotate as f64;
            let sideways = is_sideways(page.rotate);
            let (visual_width, visual_height) = if sideways {
                (page_height, page_width)
            } else {
                (page_width, page_height)
            };
            let relative_rotation = match options.orientation {
                WatermarkOrientation::Diagonal => 45.0,
                WatermarkOrientation::Horizontal => 0.0,
            };
            let base_width = text_width_pt(&options.text, font_size_pt, true);
            let base_bounds = rotated_text_bounds(base_width, font_size_pt, relative_rotation);
            let fit_scale = (visual_width / base_bounds.width)
                .min(visual_height / base_bounds.height)
                .min(1.0);
            let fitted_size = font_size_pt * fit_scale;
            let text_width = text_width_pt(&options.text, fitted_size, true);
            let bounds = rotated_text_bounds(text_width, fitted_size, relative_rotation);
            let (x, y) = map_visual_point_to_page_point(
                (visual_width - bounds.width) / 2.0 - bounds.min_x,
                (visual_height - bounds.height) / 2.0 - bounds.min_y,
                page_width,
                page_height,
                page.rotate,
            );

            Ok(overlay_page(
                page,
                vec![MiniPdfText {
                    text: options.text.clone(),
                    x: x + page.media_box[0],
                    y: y + page.media_box[1],
                    size_pt: fitted_size,
                    rotate_deg: (rotation + relative_rotation).rem_euclid(360.0),
                    gray: WATERMARK_GRAY,
                    opacity: Some(opacity),
                    bold: true,
                }],
            ))
        })
        .collect()
}

fn stamp_defaults(font_size_pt: Option<f64>, margin_in: Option<f64>) -> OpResult<(f64, f64)> {
    let font_size_pt = font_size_pt.unwrap_or(DEFAULT_STAMP_FONT_SIZE_PT);
    if !(font_size_pt.is_finite() && font_size_pt > 0.0) {
        return Err(PathOpError::invalid(
            "fontSizePt must be a positive number.",
        ));
    }
    let margin_in = margin_in.unwrap_or(DEFAULT_STAMP_MARGIN_IN);
    if !(margin_in.is_finite() && margin_in > 0.0) {
        return Err(PathOpError::invalid("marginIn must be a positive number."));
    }
    Ok((font_size_pt, margin_in))
}

fn overlay_page(page: &PageFacts, texts: Vec<MiniPdfText>) -> MiniPdfPage {
    MiniPdfPage {
        media_box: page.media_box,
        rects: Vec::new(),
        text: None,
        texts,
    }
}

fn page_box_size(page: &PageFacts) -> (f64, f64) {
    (
        (page.media_box[2] - page.media_box[0]).abs(),
        (page.media_box[3] - page.media_box[1]).abs(),
    )
}

fn is_sideways(rotate: i64) -> bool {
    rotate == 90 || rotate == 270
}

/// One header/footer stamp on one page, rotation-aware: the placement is
/// computed in the upright "visual" space a viewer sees, then mapped back
/// into page user space and the text rotated with the page (mirrors the byte
/// engine's `computeStampPosition` + `mapVisualPointToPagePoint`).
pub(crate) fn plan_edge_stamp(
    page: &PageFacts,
    text: &str,
    placement: StampPlacement,
    font_size_pt: f64,
    margin_in: f64,
) -> OpResult<MiniPdfText> {
    let (page_width, page_height) = page_box_size(page);
    let sideways = is_sideways(page.rotate);
    let (visual_width, visual_height) = if sideways {
        (page_height, page_width)
    } else {
        (page_width, page_height)
    };
    let margin_pt = margin_in * POINTS_PER_INCH;
    let max_text_width = visual_width - 2.0 * margin_pt;
    if max_text_width <= 0.0 {
        return Err(PathOpError::invalid(
            "Stamp margin leaves no room for text.",
        ));
    }

    let natural_width = text_width_pt(text, font_size_pt, false);
    let fitted_size = if natural_width <= max_text_width {
        font_size_pt
    } else {
        font_size_pt * (max_text_width / natural_width)
    };
    let text_width = text_width_pt(text, fitted_size, false);

    let visual_x = match placement.align {
        StampAlign::Left => margin_pt,
        StampAlign::Center => (visual_width - text_width) / 2.0,
        StampAlign::Right => visual_width - margin_pt - text_width,
    };
    let visual_y = match placement.edge {
        StampEdge::Header => visual_height - margin_pt - fitted_size,
        StampEdge::Footer => margin_pt,
    };
    let (x, y) =
        map_visual_point_to_page_point(visual_x, visual_y, page_width, page_height, page.rotate);

    Ok(MiniPdfText {
        text: text.to_string(),
        x: x + page.media_box[0],
        y: y + page.media_box[1],
        size_pt: fitted_size,
        rotate_deg: page.rotate as f64,
        gray: 0.0,
        opacity: None,
        bold: false,
    })
}

fn map_visual_point_to_page_point(
    visual_x: f64,
    visual_y: f64,
    page_width: f64,
    page_height: f64,
    rotate: i64,
) -> (f64, f64) {
    match rotate {
        90 => (page_width - visual_y, visual_x),
        180 => (page_width - visual_x, page_height - visual_y),
        270 => (visual_y, page_height - visual_x),
        _ => (visual_x, visual_y),
    }
}

pub(crate) struct RotatedBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub width: f64,
    pub height: f64,
}

/// Axis-aligned bounding box of a text run of `text_width` × `font_size`
/// rotated by `rotation` degrees about its baseline origin.
pub(crate) fn rotated_text_bounds(text_width: f64, font_size: f64, rotation: f64) -> RotatedBounds {
    let radians = rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let points = [
        (0.0, 0.0),
        (text_width * cos, text_width * sin),
        (-font_size * sin, font_size * cos),
        (
            text_width * cos - font_size * sin,
            text_width * sin + font_size * cos,
        ),
    ];
    let min_x = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let max_y = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    RotatedBounds {
        min_x,
        min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    }
}

/// Approximate Helvetica advance width in points. Layout guidance only —
/// alignment and fit-to-width tolerate a few points of drift, so a compact
/// class-based approximation stands in for a full AFM table. Values are
/// slightly generous so right-aligned/fitted text never overflows the edge.
pub(crate) fn text_width_pt(text: &str, size_pt: f64, bold: bool) -> f64 {
    let em_total: f64 = text.chars().map(approx_helvetica_advance_em).sum();
    let bold_factor = if bold { 1.1 } else { 1.0 };
    em_total * bold_factor * size_pt
}

fn approx_helvetica_advance_em(ch: char) -> f64 {
    let thousandths: f64 = match ch {
        ' ' | '.' | ',' | ':' | ';' | '\'' => 300.0,
        'i' | 'j' | 'l' | 'I' | '!' | '|' => 260.0,
        'f' | 't' | 'r' | '-' | '(' | ')' | '[' | ']' | '/' => 350.0,
        'm' | 'M' | 'W' | '@' => 900.0,
        'w' => 730.0,
        'A'..='Z' | '&' | '%' => 700.0,
        '0'..='9' => 570.0,
        _ => 570.0,
    };
    thousandths / 1000.0
}

/// Shared tail for the stamping ops: write the overlay next to the output in
/// `work_dir`, then one qpdf `--overlay` pass (overlay page N onto document
/// page N — MediaBoxes match by construction, so qpdf stamps 1:1).
fn apply_text_overlay(
    toolchain: &PathOpsToolchain,
    input: &Path,
    overlay_pages: &[MiniPdfPage],
    output_path: &Path,
    work_dir: &Path,
) -> OpResult<()> {
    let overlay_path = work_dir.join("stamp-overlay.pdf");
    write_minimal_pdf(&overlay_path, overlay_pages)
        .map_err(|error| PathOpError::io("write stamp overlay", error))?;

    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    arguments.push(OsString::from("--overlay"));
    arguments.push(path_arg(&overlay_path));
    arguments.push(OsString::from("--to=1-z"));
    arguments.push(OsString::from("--from=1-z"));
    arguments.push(OsString::from("--"));
    let result = run_qpdf(toolchain, arguments);
    let _ = fs::remove_file(&overlay_path);
    result?;
    require_output("qpdf overlay", output_path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 6. redact_areas — with engine-side, fail-closed verification
// ---------------------------------------------------------------------------

/// One redaction rectangle in PDF user-space points (bottom-left origin),
/// matching `PdfRedactionArea` in `packages/engine-api`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactArea {
    pub page_index: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaVerification {
    pub page_index: u32,
    pub pass: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionVerification {
    /// Always true on success — verification failure is an op error, never a
    /// returned `verified: false` (fail-closed, plan [R3-1][R4-1]).
    pub verified: bool,
    pub method: &'static str,
    pub areas: Vec<AreaVerification>,
}

/// True area redaction, file→file, with engine-side verification:
///
/// 1. Black boxes are stamped over the areas (qpdf `--overlay` with a
///    generated overlay PDF whose pages share the target pages' MediaBoxes).
/// 2. Every affected page is rasterized (Ghostscript `pdfimage24`), so the
///    underlying text objects are destroyed, matching the sidecar redaction's
///    IMAGE_FINALIZE semantics.
/// 3. The output is reassembled from untouched original pages + rasterized
///    redacted pages, preserving page order and count.
/// 4. **Verification** re-extracts text from the redacted pages of the OUTPUT
///    file (Ghostscript `txtwrite`). Any recoverable text on a redacted page,
///    or any inability to verify, fails the op: the output is deleted and an
///    error is returned. No output grant can ever exist for an unverified
///    redaction.
pub fn redact_areas(
    toolchain: &PathOpsToolchain,
    input: &Path,
    areas: &[RedactArea],
    output_path: &Path,
    work_dir: &Path,
) -> OpResult<RedactionVerification> {
    redact_areas_impl(toolchain, input, areas, output_path, work_dir, true)
}

/// `rasterize: false` exists ONLY for tests: it leaves the boxed (overlay-only)
/// pages in place so the verification pass must detect the surviving text and
/// fail closed.
pub(crate) fn redact_areas_impl(
    toolchain: &PathOpsToolchain,
    input: &Path,
    areas: &[RedactArea],
    output_path: &Path,
    work_dir: &Path,
    rasterize: bool,
) -> OpResult<RedactionVerification> {
    require_input_file(input)?;
    // Both tools are required up front: without Ghostscript there is no
    // rasterization AND no verification, so the op must refuse to start.
    toolchain.require_qpdf()?;
    toolchain.require_ghostscript()?;
    if areas.is_empty() {
        return Err(PathOpError::invalid(
            "at least one redaction area is required",
        ));
    }
    for area in areas {
        if !(area.w > 0.0 && area.h > 0.0) {
            return Err(PathOpError::invalid(
                "redaction areas must have positive size",
            ));
        }
    }

    let facts = document_facts(toolchain, input)?;
    let mut by_page: BTreeMap<u32, Vec<RedactArea>> = BTreeMap::new();
    for area in areas {
        if area.page_index >= facts.page_count {
            return Err(PathOpError::invalid(format!(
                "redaction page index {} out of range (document has {} pages)",
                area.page_index, facts.page_count
            )));
        }
        by_page.entry(area.page_index).or_default().push(*area);
    }
    let affected_pages: Vec<u32> = by_page.keys().copied().collect();

    // 1. Overlay PDF: one page per affected page, MediaBox matched exactly so
    // qpdf stamps 1:1 with no scaling ambiguity.
    let overlay_path = work_dir.join("redact-overlay.pdf");
    let overlay_pages: Vec<MiniPdfPage> = affected_pages
        .iter()
        .map(|&page_index| MiniPdfPage {
            media_box: facts.pages[page_index as usize].media_box,
            rects: by_page[&page_index]
                .iter()
                .map(|area| [area.x, area.y, area.w, area.h])
                .collect(),
            text: None,
            texts: Vec::new(),
        })
        .collect();
    write_minimal_pdf(&overlay_path, &overlay_pages)
        .map_err(|error| PathOpError::io("write redaction overlay", error))?;

    let affected_range = one_based_range_string(&affected_pages)?;
    let boxed_path = work_dir.join("redact-boxed.pdf");
    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(&boxed_path));
    arguments.push(OsString::from("--overlay"));
    arguments.push(path_arg(&overlay_path));
    arguments.push(OsString::from(format!("--to={affected_range}")));
    arguments.push(OsString::from("--from=1-z"));
    arguments.push(OsString::from("--"));
    run_qpdf(toolchain, arguments)?;

    // 2. Extract the boxed affected pages and rasterize them.
    let affected_path = work_dir.join("redact-affected.pdf");
    extract_pages_one_based(toolchain, &boxed_path, &affected_range, &affected_path)?;
    let raster_path = if rasterize {
        let raster_path = work_dir.join("redact-raster.pdf");
        run_ghostscript(toolchain, rasterize_gs_args(&affected_path, &raster_path))?;
        require_output("ghostscript rasterize", &raster_path)?;
        raster_path
    } else {
        affected_path.clone()
    };

    // 3. Reassemble: original pages where untouched, rasterized pages where
    // redacted, in original order.
    assemble_redacted(
        toolchain,
        input,
        &raster_path,
        &affected_pages,
        facts.page_count,
        output_path,
    )?;

    // 4. Verify or die: page count must be preserved and the redacted pages of
    // the OUTPUT must yield no extractable text. Any failure deletes the
    // output before returning.
    match verify_redaction(
        toolchain,
        output_path,
        &affected_pages,
        facts.page_count,
        work_dir,
    ) {
        Ok(area_passes) => {
            let all_pass = area_passes.values().all(|&pass| pass);
            if !all_pass {
                let _ = fs::remove_file(output_path);
                return Err(PathOpError::new(
                    ERR_VERIFICATION_FAILED,
                    "redaction verification failed: text is still extractable from a redacted page",
                ));
            }
            let area_reports = areas
                .iter()
                .map(|area| AreaVerification {
                    page_index: area.page_index,
                    pass: area_passes.get(&area.page_index).copied().unwrap_or(false),
                })
                .collect();
            Ok(RedactionVerification {
                verified: true,
                method: "rasterize+re-extract",
                areas: area_reports,
            })
        }
        Err(error) => {
            let _ = fs::remove_file(output_path);
            Err(PathOpError::new(
                ERR_VERIFICATION_FAILED,
                format!("redaction verification unavailable: {}", error.message),
            ))
        }
    }
}

fn extract_pages_one_based(
    toolchain: &PathOpsToolchain,
    input: &Path,
    range: &str,
    output_path: &Path,
) -> OpResult<()> {
    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(input));
    arguments.extend(args(&["--pages", "."]));
    arguments.push(OsString::from(range));
    arguments.push(OsString::from("--"));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf --pages", output_path)?;
    Ok(())
}

/// Interleave original (untouched) and raster (redacted) pages back into one
/// document via a single qpdf `--pages` invocation.
fn assemble_redacted(
    toolchain: &PathOpsToolchain,
    original: &Path,
    raster: &Path,
    affected_pages: &[u32],
    total_pages: u32,
    output_path: &Path,
) -> OpResult<()> {
    let segments = interleave_segments(affected_pages, total_pages);
    let mut arguments = args(&["--warning-exit-0"]);
    arguments.push(path_arg(original));
    arguments.push(OsString::from("--pages"));
    for segment in &segments {
        match segment {
            PageSegment::Original { start, end } => {
                arguments.push(path_arg(original));
                arguments.push(OsString::from(format!("{}-{}", start + 1, end + 1)));
            }
            PageSegment::Raster { raster_index } => {
                arguments.push(path_arg(raster));
                arguments.push(OsString::from(format!("{}", raster_index + 1)));
            }
        }
    }
    arguments.push(OsString::from("--"));
    arguments.push(path_arg(output_path));
    run_qpdf(toolchain, arguments)?;
    require_output("qpdf reassemble", output_path)?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PageSegment {
    /// Zero-based inclusive range taken from the original document.
    Original { start: u32, end: u32 },
    /// Zero-based index into the rasterized affected-pages file.
    Raster { raster_index: u32 },
}

/// Walk 0..total_pages, emitting original runs and raster singletons in order.
/// `affected_pages` must be sorted ascending and unique.
pub(crate) fn interleave_segments(affected_pages: &[u32], total_pages: u32) -> Vec<PageSegment> {
    let mut segments = Vec::new();
    let mut cursor = 0u32;
    for (raster_index, &page) in affected_pages.iter().enumerate() {
        if page > cursor {
            segments.push(PageSegment::Original {
                start: cursor,
                end: page - 1,
            });
        }
        segments.push(PageSegment::Raster {
            raster_index: raster_index as u32,
        });
        cursor = page + 1;
    }
    if cursor < total_pages {
        segments.push(PageSegment::Original {
            start: cursor,
            end: total_pages - 1,
        });
    }
    segments
}

/// Re-extract text from the redacted pages of the output file. Returns
/// per-affected-page pass/fail. Errors (missing tool, gs failure, page-count
/// mismatch) propagate — the caller treats them as verification failure.
fn verify_redaction(
    toolchain: &PathOpsToolchain,
    output_path: &Path,
    affected_pages: &[u32],
    expected_pages: u32,
    work_dir: &Path,
) -> OpResult<BTreeMap<u32, bool>> {
    let actual_pages = page_count(toolchain, output_path)?;
    if actual_pages != expected_pages {
        return Err(PathOpError::failed(format!(
            "output page count {actual_pages} does not match input {expected_pages}"
        )));
    }

    let affected_range = one_based_range_string(affected_pages)?;
    let verify_pdf = work_dir.join("verify-affected.pdf");
    extract_pages_one_based(toolchain, output_path, &affected_range, &verify_pdf)?;

    let verify_txt = work_dir.join("verify-affected.txt");
    run_ghostscript(toolchain, txt_extract_gs_args(&verify_pdf, &verify_txt))?;

    let extracted = fs::read_to_string(&verify_txt)
        .map_err(|error| PathOpError::io("read verification text", error))?;

    // txtwrite separates pages with form feeds. If the segmentation doesn't
    // line up, fall back to the strictest reading: any text anywhere fails all.
    let page_texts: Vec<&str> = extracted.split('\u{c}').collect();
    let mut passes = BTreeMap::new();
    if page_texts.len() >= affected_pages.len() {
        for (slot, &page) in affected_pages.iter().enumerate() {
            passes.insert(page, page_texts[slot].trim().is_empty());
        }
    } else {
        let clean = extracted.trim().is_empty();
        for &page in affected_pages {
            passes.insert(page, clean);
        }
    }
    Ok(passes)
}

// ---------------------------------------------------------------------------
// 4b. prepare_filing — reduced, fully path-based filing pipeline
// ---------------------------------------------------------------------------

/// Which steps to run, mirroring the registered subset of `PrepPlanStepId`s
/// (plan [R6-1][R7-1]). Steps compose engine-side in one pass; the WebView
/// only sees the part descriptors.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareFilingPlan {
    /// remove-encryption: decrypt with this password (empty string = owner-
    /// restricted file with no user password).
    #[serde(default)]
    pub decrypt_password: Option<String>,
    /// sanitize-content (Ghostscript rewrite).
    #[serde(default)]
    pub sanitize: bool,
    /// normalize-pages to letter portrait (Ghostscript).
    #[serde(default)]
    pub normalize: bool,
    /// make-searchable (OCRmyPDF by-path).
    #[serde(default)]
    pub ocr: bool,
    /// scrub-metadata (qpdf).
    #[serde(default)]
    pub scrub: bool,
    /// split-by-size cap in bytes; `None` = single output part.
    #[serde(default)]
    pub split_max_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilingStepReport {
    pub step: &'static str,
    pub tool: &'static str,
    pub output_size_bytes: u64,
}

/// Output preflight for one part, recomputed from `document_facts` (plan
/// [R6-1]): the checks qpdf can compute; anything else is reported as not
/// evaluated by the caller, never silently passed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartPreflight {
    pub part_index: u32,
    pub page_count: u32,
    pub size_bytes: u64,
    pub encrypted: bool,
    pub all_letter_portrait: bool,
    /// `None` when no split cap was requested.
    pub within_byte_cap: Option<bool>,
}

#[derive(Debug)]
pub struct PrepareFilingOutcome {
    pub parts: Vec<SplitPartFile>,
    pub facts_report: Vec<PartPreflight>,
    pub steps: Vec<FilingStepReport>,
}

/// Compose the registered path ops into the reduced streamed-mode filing
/// pipeline: decrypt → sanitize → normalize → OCR → scrub → split, then a
/// facts-based preflight per part. All intermediates live in `work_dir`; final
/// parts land in `out_dir`.
pub fn prepare_filing(
    toolchain: &PathOpsToolchain,
    input: &Path,
    plan: &PrepareFilingPlan,
    work_dir: &Path,
    out_dir: &Path,
) -> OpResult<PrepareFilingOutcome> {
    require_input_file(input)?;
    let mut steps = Vec::new();
    let mut current: PathBuf = input.to_path_buf();
    let mut stage = 0u32;

    let next_stage_path = |label: &str, stage: &mut u32| {
        *stage += 1;
        work_dir.join(format!("stage-{:02}-{label}.pdf", *stage))
    };

    if let Some(password) = plan.decrypt_password.as_deref() {
        let output = next_stage_path("decrypt", &mut stage);
        decrypt(toolchain, &current, password, &output, work_dir)?;
        steps.push(FilingStepReport {
            step: "remove-encryption",
            tool: "qpdf",
            output_size_bytes: file_len(&output)?,
        });
        current = output;
    }
    if plan.sanitize {
        let output = next_stage_path("sanitize", &mut stage);
        sanitize(toolchain, &current, &output)?;
        steps.push(FilingStepReport {
            step: "sanitize-content",
            tool: "ghostscript",
            output_size_bytes: file_len(&output)?,
        });
        current = output;
    }
    if plan.normalize {
        let output = next_stage_path("normalize", &mut stage);
        normalize_to_letter_portrait(toolchain, &current, &output)?;
        steps.push(FilingStepReport {
            step: "normalize-pages",
            tool: "ghostscript",
            output_size_bytes: file_len(&output)?,
        });
        current = output;
    }
    if plan.ocr {
        let output = next_stage_path("ocr", &mut stage);
        ocr(toolchain, &current, &output)?;
        steps.push(FilingStepReport {
            step: "make-searchable",
            tool: "ocrmypdf",
            output_size_bytes: file_len(&output)?,
        });
        current = output;
    }
    if plan.scrub {
        let output = next_stage_path("scrub", &mut stage);
        scrub_metadata(toolchain, &current, &output)?;
        steps.push(FilingStepReport {
            step: "scrub-metadata",
            tool: "qpdf",
            output_size_bytes: file_len(&output)?,
        });
        current = output;
    }

    let parts = if let Some(max_bytes) = plan.split_max_bytes {
        let parts = split_by_max_bytes(toolchain, &current, max_bytes, out_dir)?;
        steps.push(FilingStepReport {
            step: "split-by-size",
            tool: "qpdf",
            output_size_bytes: parts.iter().map(|part| part.byte_length).sum(),
        });
        parts
    } else {
        // Single part: rewrite through qpdf so the output is always a fresh
        // file in out_dir (never the caller's input path).
        let part_path = out_dir.join("part-001.pdf");
        let total_pages = page_count(toolchain, &current)?;
        build_page_range(toolchain, &current, 1, total_pages, &part_path)?;
        let byte_length = require_output("qpdf part", &part_path)?;
        vec![SplitPartFile {
            path: part_path,
            first_page_index: 0,
            last_page_index: total_pages - 1,
            byte_length,
            oversized: false,
        }]
    };

    let mut facts_report = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        let facts = document_facts(toolchain, &part.path)?;
        facts_report.push(PartPreflight {
            part_index: index as u32,
            page_count: facts.page_count,
            size_bytes: facts.size_bytes,
            encrypted: facts.encrypted,
            all_letter_portrait: facts.pages.iter().all(|page| page.letter_portrait),
            // An oversized part is NOT within the cap — the flag must stay
            // honest so filing preflights can't green-light a part the court
            // portal will reject (Codex review, PR #123). `oversized` on the
            // part descriptor carries the "single page too big" explanation.
            within_byte_cap: plan
                .split_max_bytes
                .map(|max_bytes| part.byte_length <= max_bytes),
        });
    }

    Ok(PrepareFilingOutcome {
        parts,
        facts_report,
        steps,
    })
}

fn file_len(path: &Path) -> OpResult<u64> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| PathOpError::io("stat output", error))
}

// ---------------------------------------------------------------------------
// Minimal PDF writer (redaction overlays + test fixtures)
// ---------------------------------------------------------------------------

/// One placed text run for the minimal PDF writer: absolute user-space
/// baseline origin, font size, rotation about the origin, gray fill, optional
/// constant opacity (ExtGState), regular or bold Helvetica.
#[derive(Clone, Debug)]
pub(crate) struct MiniPdfText {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub size_pt: f64,
    pub rotate_deg: f64,
    /// 0.0 = black … 1.0 = white.
    pub gray: f64,
    pub opacity: Option<f64>,
    pub bold: bool,
}

/// A page for the minimal PDF writer: raw MediaBox, black filled rectangles
/// (`[x, y, w, h]` user-space), optional fixed-position Helvetica text (test
/// fixtures), and placed text runs (stamping overlays).
#[derive(Clone, Debug)]
pub(crate) struct MiniPdfPage {
    pub media_box: [f64; 4],
    pub rects: Vec<[f64; 4]>,
    pub text: Option<String>,
    pub texts: Vec<MiniPdfText>,
}

/// Hand-rolled, dependency-free PDF writer. Object layout: 1 Catalog, 2 Pages,
/// 3 Helvetica font, then (only when used) a Helvetica-Bold font and one
/// ExtGState per distinct opacity, then (Page, Contents) pairs per page.
pub(crate) fn write_minimal_pdf(path: &Path, pages: &[MiniPdfPage]) -> io::Result<()> {
    let mut buffer: Vec<u8> = Vec::new();
    buffer.extend_from_slice(b"%PDF-1.4\n");

    let uses_bold = pages
        .iter()
        .any(|page| page.texts.iter().any(|text| text.bold));
    // Distinct opacities in first-seen order, keyed bit-exact.
    let mut opacity_bits: Vec<u64> = Vec::new();
    for page in pages {
        for text in &page.texts {
            if let Some(opacity) = text.opacity {
                if !opacity_bits.contains(&opacity.to_bits()) {
                    opacity_bits.push(opacity.to_bits());
                }
            }
        }
    }

    let mut next_id = 4usize;
    let bold_font_id = uses_bold.then(|| {
        let id = next_id;
        next_id += 1;
        id
    });
    let gs_first_id = next_id;
    next_id += opacity_bits.len();
    let first_page_id = next_id;
    let gs_name_for = |opacity: f64| -> usize {
        opacity_bits
            .iter()
            .position(|&bits| bits == opacity.to_bits())
            .expect("opacity registered above")
            + 1
    };

    let total_objects = first_page_id - 1 + pages.len() * 2;
    let mut offsets: Vec<usize> = vec![0; total_objects + 1];

    let kids: Vec<String> = (0..pages.len())
        .map(|index| format!("{} 0 R", first_page_id + index * 2))
        .collect();

    let write_object = |buffer: &mut Vec<u8>, offsets: &mut Vec<usize>, id: usize, body: &[u8]| {
        offsets[id] = buffer.len();
        buffer.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        buffer.extend_from_slice(body);
        buffer.extend_from_slice(b"\nendobj\n");
    };

    write_object(
        &mut buffer,
        &mut offsets,
        1,
        b"<< /Type /Catalog /Pages 2 0 R >>",
    );
    write_object(
        &mut buffer,
        &mut offsets,
        2,
        format!(
            "<< /Type /Pages /Count {} /Kids [ {} ] >>",
            pages.len(),
            kids.join(" ")
        )
        .as_bytes(),
    );
    write_object(
        &mut buffer,
        &mut offsets,
        3,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    if let Some(bold_id) = bold_font_id {
        write_object(
            &mut buffer,
            &mut offsets,
            bold_id,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        );
    }
    for (slot, bits) in opacity_bits.iter().enumerate() {
        let opacity = f64::from_bits(*bits);
        write_object(
            &mut buffer,
            &mut offsets,
            gs_first_id + slot,
            format!("<< /Type /ExtGState /ca {opacity:.4} /CA {opacity:.4} >>").as_bytes(),
        );
    }

    // Shared resources dict: every page references every font/gs the doc
    // uses (simple, and harmless for pages that don't).
    let mut resources = String::from("/Resources << /Font << /F1 3 0 R");
    if let Some(bold_id) = bold_font_id {
        resources.push_str(&format!(" /F2 {bold_id} 0 R"));
    }
    resources.push_str(" >>");
    if !opacity_bits.is_empty() {
        resources.push_str(" /ExtGState <<");
        for slot in 0..opacity_bits.len() {
            resources.push_str(&format!(" /GS{} {} 0 R", slot + 1, gs_first_id + slot));
        }
        resources.push_str(" >>");
    }
    resources.push_str(" >>");

    for (index, page) in pages.iter().enumerate() {
        let page_id = first_page_id + index * 2;
        let contents_id = page_id + 1;
        let [llx, lly, urx, ury] = page.media_box;

        let mut content = String::new();
        for rect in &page.rects {
            content.push_str(&format!(
                "q 0 0 0 rg {:.2} {:.2} {:.2} {:.2} re f Q\n",
                rect[0], rect[1], rect[2], rect[3]
            ));
        }
        if let Some(text) = &page.text {
            content.push_str(&format!(
                "BT /F1 12 Tf {:.2} {:.2} Td ({}) Tj ET\n",
                llx + 100.0,
                lly + 500.0,
                escape_pdf_string(text),
            ));
        }
        for placed in &page.texts {
            let (sin, cos) = placed.rotate_deg.to_radians().sin_cos();
            content.push_str("q ");
            if let Some(opacity) = placed.opacity {
                content.push_str(&format!("/GS{} gs ", gs_name_for(opacity)));
            }
            content.push_str(&format!(
                "BT /{} {:.4} Tf {:.3} g {:.6} {:.6} {:.6} {:.6} {:.4} {:.4} Tm ({}) Tj ET Q\n",
                if placed.bold { "F2" } else { "F1" },
                placed.size_pt,
                placed.gray,
                cos,
                sin,
                -sin,
                cos,
                placed.x,
                placed.y,
                escape_pdf_string(&placed.text),
            ));
        }

        write_object(
            &mut buffer,
            &mut offsets,
            page_id,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [ {llx:.2} {lly:.2} {urx:.2} {ury:.2} ] \
                 {resources} /Contents {contents_id} 0 R >>"
            )
            .as_bytes(),
        );
        write_object(
            &mut buffer,
            &mut offsets,
            contents_id,
            format!(
                "<< /Length {} >>\nstream\n{content}endstream",
                content.len()
            )
            .as_bytes(),
        );
    }

    let xref_offset = buffer.len();
    buffer.extend_from_slice(format!("xref\n0 {}\n", total_objects + 1).as_bytes());
    buffer.extend_from_slice(b"0000000000 65535 f \n");
    let xref_entries: String = offsets[1..=total_objects]
        .iter()
        .map(|offset| format!("{offset:010} 00000 n \n"))
        .collect();
    buffer.extend_from_slice(xref_entries.as_bytes());
    buffer.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            total_objects + 1
        )
        .as_bytes(),
    );

    let mut file = fs::File::create(path)?;
    file.write_all(&buffer)?;
    Ok(())
}

fn escape_pdf_string(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- pure-logic tests (no toolchain required) ----

    #[test]
    fn gs_arg_builders_run_safer_with_scoped_permits() {
        let input = Path::new(r"C:\work\input docs\brief.pdf");
        let output = Path::new(r"C:\work\out\normalized.pdf");

        // Representative op: the normalize rewrite.
        let arguments = normalize_gs_args(input, output);
        let rendered: Vec<String> = arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();

        assert!(rendered.contains(&"-dSAFER".to_string()));
        assert!(rendered.contains(&"-dPassThroughJPEGImages=false".to_string()));
        assert!(
            !rendered.iter().any(|argument| argument == "-dNOSAFER"),
            "normalize must not disable the Ghostscript sandbox"
        );
        // Permit paths are forward-slash normalized and scoped to exactly the
        // input (read) and output (write) of this invocation.
        assert!(rendered.contains(&"--permit-file-read=C:/work/input docs/brief.pdf".to_string()));
        assert!(rendered.contains(&"--permit-file-write=C:/work/out/normalized.pdf".to_string()));
        // Permits precede the input operand (Ghostscript applies switches in
        // argument order).
        let permit_index = rendered
            .iter()
            .position(|argument| argument.starts_with("--permit-file-read="))
            .unwrap();
        let operand_index = rendered
            .iter()
            .position(|argument| argument.ends_with("brief.pdf") && !argument.starts_with("--"))
            .unwrap();
        assert!(permit_index < operand_index);

        // Every gs-backed op builder rides the same SAFER posture.
        for arguments in [
            sanitize_gs_args(input, output),
            rasterize_gs_args(input, output),
            txt_extract_gs_args(input, Path::new(r"C:\work\out\verify.txt")),
        ] {
            assert!(arguments.iter().any(|argument| argument == "-dSAFER"));
            assert!(!arguments.iter().any(|argument| argument == "-dNOSAFER"));
            assert!(arguments.iter().any(|argument| argument
                .to_string_lossy()
                .starts_with("--permit-file-read=")));
            assert!(arguments.iter().any(|argument| argument
                .to_string_lossy()
                .starts_with("--permit-file-write=")));
        }
    }

    #[test]
    fn extracted_text_decision_treats_any_non_whitespace_as_text_layer() {
        assert!(!extracted_text_has_text_layer(""));
        assert!(!extracted_text_has_text_layer(" \r\n\t\u{c} "));
        assert!(extracted_text_has_text_layer("RaioPDF searchable text"));
    }

    #[test]
    fn range_string_collapses_runs() {
        assert_eq!(one_based_range_string(&[0, 1, 2, 3, 4]).unwrap(), "1-5");
        assert_eq!(one_based_range_string(&[0, 2, 3, 8]).unwrap(), "1,3-4,9");
        assert_eq!(one_based_range_string(&[7]).unwrap(), "8");
        assert!(one_based_range_string(&[]).is_err());
        assert!(one_based_range_string(&[1, 1]).is_err());
    }

    #[test]
    fn plan_split_single_part_when_everything_fits() {
        let mut probe = |start: u32, end: u32| Ok(u64::from(end - start + 1) * 10);
        let parts = plan_split(10, 1000, &mut probe).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(
            (parts[0].start, parts[0].end, parts[0].oversized),
            (1, 10, false)
        );
    }

    #[test]
    fn plan_split_finds_greedy_boundaries() {
        // 10 pages, 100 bytes each (plus a constant 5-byte overhead per part),
        // cap 350 → parts of 3 pages each, then the remainder.
        let mut probe = |start: u32, end: u32| Ok(u64::from(end - start + 1) * 100 + 5);
        let parts = plan_split(10, 350, &mut probe).unwrap();
        let bounds: Vec<(u32, u32, bool)> = parts
            .iter()
            .map(|p| (p.start, p.end, p.oversized))
            .collect();
        assert_eq!(
            bounds,
            vec![(1, 3, false), (4, 6, false), (7, 9, false), (10, 10, false)]
        );
        // Every planned part actually fits the cap.
        assert!(parts.iter().all(|p| p.size <= 350));
        // Parts tile the page range exactly.
        assert_eq!(parts.first().unwrap().start, 1);
        assert_eq!(parts.last().unwrap().end, 10);
        for window in parts.windows(2) {
            assert_eq!(window[0].end + 1, window[1].start);
        }
    }

    #[test]
    fn plan_split_marks_oversized_single_pages() {
        // Page 3 alone is 900 bytes against a 500 cap.
        let mut probe = |start: u32, end: u32| {
            let mut size = 0u64;
            for page in start..=end {
                size += if page == 3 { 900 } else { 100 };
            }
            Ok(size)
        };
        let parts = plan_split(5, 500, &mut probe).unwrap();
        let bounds: Vec<(u32, u32, bool)> = parts
            .iter()
            .map(|p| (p.start, p.end, p.oversized))
            .collect();
        assert_eq!(bounds, vec![(1, 2, false), (3, 3, true), (4, 5, false)]);
    }

    #[test]
    fn plan_split_rejects_zero_cap_and_empty_docs() {
        let mut probe = |_: u32, _: u32| Ok(1u64);
        assert!(plan_split(0, 100, &mut probe).is_err());
        assert!(plan_split(5, 0, &mut probe).is_err());
    }

    #[test]
    fn interleave_covers_all_pages_in_order() {
        assert_eq!(
            interleave_segments(&[0], 3),
            vec![
                PageSegment::Raster { raster_index: 0 },
                PageSegment::Original { start: 1, end: 2 },
            ]
        );
        assert_eq!(
            interleave_segments(&[1, 3], 5),
            vec![
                PageSegment::Original { start: 0, end: 0 },
                PageSegment::Raster { raster_index: 0 },
                PageSegment::Original { start: 2, end: 2 },
                PageSegment::Raster { raster_index: 1 },
                PageSegment::Original { start: 4, end: 4 },
            ]
        );
        assert_eq!(
            interleave_segments(&[4], 5),
            vec![
                PageSegment::Original { start: 0, end: 3 },
                PageSegment::Raster { raster_index: 0 },
            ]
        );
    }

    #[test]
    fn parses_document_facts_json() {
        let json = br#"{
          "version": 2,
          "pages": [
            { "object": "5 0 R" },
            { "object": "7 0 R" }
          ],
          "encrypt": { "encrypted": true },
          "qpdf": [
            { "jsonversion": 2 },
            {
              "obj:1 0 R": { "value": { "/Type": "/Pages", "/MediaBox": [0, 0, 612, 792], "/Kids": ["5 0 R", "7 0 R"] } },
              "obj:5 0 R": { "value": { "/Type": "/Page", "/Parent": "1 0 R" } },
              "obj:7 0 R": { "value": { "/Type": "/Page", "/Parent": "1 0 R", "/MediaBox": [0, 0, 792, 612], "/Rotate": 90 } }
            }
          ]
        }"#;
        let facts = parse_document_facts(json, 1234).unwrap();
        assert_eq!(facts.page_count, 2);
        assert_eq!(facts.size_bytes, 1234);
        assert!(facts.encrypted);
        assert_eq!(
            facts.signature_detection.standard_acro_form_signature_count,
            0
        );
        assert!(!facts.signature_detection.has_byte_range_or_contents_markers);
        assert!(!facts.signature_detection.has_certification_dictionary);
        // Page 0 inherits the Pages-node MediaBox: letter portrait.
        assert_eq!(facts.pages[0].media_box, [0.0, 0.0, 612.0, 792.0]);
        assert_eq!(facts.pages[0].orientation, "portrait");
        assert!(facts.pages[0].letter_portrait);
        // Page 1 is 792x612 rotated 90 → effectively 612x792 portrait.
        assert_eq!(facts.pages[1].rotate, 90);
        assert_eq!(facts.pages[1].orientation, "portrait");
        assert!(facts.pages[1].letter_portrait);
    }

    #[test]
    fn parses_signature_facts_from_document_json() {
        let json = br#"{
          "version": 2,
          "pages": [
            { "object": "5 0 R" }
          ],
          "encrypt": { "encrypted": false },
          "qpdf": [
            { "jsonversion": 2 },
            {
              "obj:1 0 R": { "value": { "/Type": "/Catalog", "/Pages": "2 0 R", "/Perms": "9 0 R" } },
              "obj:2 0 R": { "value": { "/Type": "/Pages", "/MediaBox": [0, 0, 612, 792], "/Kids": ["5 0 R"] } },
              "obj:5 0 R": { "value": { "/Type": "/Page", "/Parent": "2 0 R" } },
              "obj:7 0 R": { "value": { "/FT": "/Sig", "/T": "Signature1" } },
              "obj:8 0 R": { "value": { "/Type": "/Sig", "/SubFilter": "/adbe.pkcs7.detached", "/ByteRange": [0, 10, 20, 30], "/Contents": "signed" } },
              "obj:9 0 R": { "value": { "/DocMDP": "8 0 R" } }
            }
          ]
        }"#;

        let facts = parse_document_facts(json, 1234).unwrap();

        assert_eq!(
            facts.signature_detection.standard_acro_form_signature_count,
            1
        );
        assert!(facts.signature_detection.has_byte_range_or_contents_markers);
        assert!(facts.signature_detection.has_certification_dictionary);
    }

    #[test]
    fn document_facts_rejects_missing_media_box() {
        let json = br#"{
          "pages": [ { "object": "5 0 R" } ],
          "qpdf": [ {}, { "obj:5 0 R": { "value": { "/Type": "/Page" } } } ]
        }"#;
        let error = parse_document_facts(json, 0).unwrap_err();
        assert_eq!(error.code, ERR_OP_FAILED);
        assert!(error.message.contains("MediaBox"));
    }

    #[test]
    fn document_facts_survives_cyclic_parent_chains() {
        let json = br#"{
          "pages": [ { "object": "5 0 R" } ],
          "qpdf": [ {}, {
            "obj:5 0 R": { "value": { "/Type": "/Page", "/Parent": "6 0 R" } },
            "obj:6 0 R": { "value": { "/Type": "/Pages", "/Parent": "5 0 R" } }
          } ]
        }"#;
        let error = parse_document_facts(json, 0).unwrap_err();
        assert!(error.message.contains("inheritance depth"));
    }

    #[test]
    fn registry_reflects_toolchain_availability() {
        let empty = PathOpsToolchain::default();
        let statuses = registry(&empty);
        assert_eq!(statuses.len(), OP_DESCRIPTORS.len());
        assert!(statuses.iter().all(|status| !status.available));

        let qpdf_only = PathOpsToolchain {
            qpdf: Some(PathBuf::from("qpdf")),
            ..Default::default()
        };
        let statuses = registry(&qpdf_only);
        let by_name = |name: &str| statuses.iter().find(|s| s.name == name).unwrap();
        assert!(by_name("page_count").available);
        assert!(by_name("split_by_max_bytes").available);
        assert!(!by_name("normalize_to_letter_portrait").available);
        assert!(!by_name("redact_areas").available);
        assert_eq!(by_name("redact_areas").missing_tools, vec!["ghostscript"]);
        assert!(!by_name("ocr").available);

        // The closed-form filing rule inputs: each registered filing step maps
        // to exactly one op.
        let filing_steps: Vec<&str> = OP_DESCRIPTORS
            .iter()
            .filter_map(|d| d.filing_step)
            .collect();
        let mut deduped = filing_steps.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(
            deduped.len(),
            filing_steps.len(),
            "filing steps must be unique"
        );
        for step in [
            "remove-encryption",
            "normalize-pages",
            "sanitize-content",
            "scrub-metadata",
            "make-searchable",
            "split-by-size",
        ] {
            assert!(filing_steps.contains(&step), "missing filing step {step}");
        }
    }

    // ---- toolchain-backed tests (skipped when the payload is absent) ----
    //
    // Run with the bundled toolchain:
    //   RAIOPDF_ENGINE_PAYLOAD_DIR=<repo>/apps/shell/src-tauri/payload cargo test

    fn test_toolchain() -> Option<PathOpsToolchain> {
        let toolchain = PathOpsToolchain::discover(None);
        if toolchain.qpdf.is_some() && toolchain.ghostscript.is_some() {
            Some(toolchain)
        } else {
            eprintln!("skipping toolchain-backed path-op test: qpdf/ghostscript not found");
            None
        }
    }

    #[test]
    fn pdf_text_layer_probe_distinguishes_text_and_image_only_fixtures() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        assert!(pdf_has_text_layer(&toolchain, &root.join("text-layer.pdf")).unwrap());
        assert!(!pdf_has_text_layer(&toolchain, &root.join("image-only.pdf")).unwrap());
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(label: &str) -> Self {
            let dir = env::temp_dir().join(format!(
                "raiopdf-pathops-test-{label}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            if env::var_os("RAIOPDF_KEEP_TEST_OUTPUT").is_some() {
                eprintln!("[testdir] kept {}", self.0.display());
                return;
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn letter_page(text: Option<&str>) -> MiniPdfPage {
        MiniPdfPage {
            media_box: [0.0, 0.0, 612.0, 792.0],
            rects: Vec::new(),
            text: text.map(str::to_string),
            texts: Vec::new(),
        }
    }

    fn write_fixture(dir: &Path, name: &str, pages: &[MiniPdfPage]) -> PathBuf {
        let path = dir.join(name);
        write_minimal_pdf(&path, pages).unwrap();
        path
    }

    #[test]
    fn page_count_and_facts_on_real_fixture() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("facts");
        let fixture = write_fixture(
            dir.path(),
            "three.pdf",
            &[
                letter_page(Some("page one")),
                MiniPdfPage {
                    media_box: [0.0, 0.0, 792.0, 612.0],
                    rects: Vec::new(),
                    text: Some("landscape page".to_string()),
                    texts: Vec::new(),
                },
                letter_page(Some("page three")),
            ],
        );

        assert_eq!(page_count(&toolchain, &fixture).unwrap(), 3);
        let facts = document_facts(&toolchain, &fixture).unwrap();
        assert_eq!(facts.page_count, 3);
        assert!(!facts.encrypted);
        assert!(facts.size_bytes > 0);
        assert_eq!(facts.pages[0].orientation, "portrait");
        assert!(facts.pages[0].letter_portrait);
        assert_eq!(facts.pages[1].orientation, "landscape");
        assert!(!facts.pages[1].letter_portrait);
    }

    #[test]
    fn extract_merge_roundtrip() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("extract-merge");
        let fixture = write_fixture(
            dir.path(),
            "five.pdf",
            &(0..5)
                .map(|i| letter_page(Some(&format!("page {i}"))))
                .collect::<Vec<_>>(),
        );

        let first = dir.path().join("first.pdf");
        extract_pages(&toolchain, &fixture, &[0, 1], &first).unwrap();
        assert_eq!(page_count(&toolchain, &first).unwrap(), 2);

        let rest = dir.path().join("rest.pdf");
        extract_pages(&toolchain, &fixture, &[2, 3, 4], &rest).unwrap();
        assert_eq!(page_count(&toolchain, &rest).unwrap(), 3);

        let merged = dir.path().join("merged.pdf");
        merge(&toolchain, &[first, rest], &merged).unwrap();
        assert_eq!(page_count(&toolchain, &merged).unwrap(), 5);

        // Out-of-range extraction is rejected.
        let error =
            extract_pages(&toolchain, &fixture, &[9], &dir.path().join("nope.pdf")).unwrap_err();
        assert_eq!(error.code, ERR_INVALID_INPUT);
    }

    #[test]
    fn split_by_max_bytes_respects_cap_and_tiles_pages() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("split");
        let fixture = write_fixture(
            dir.path(),
            "eight.pdf",
            &(0..8)
                .map(|i| letter_page(Some(&format!("split fixture page {i} with some text"))))
                .collect::<Vec<_>>(),
        );
        let total_size = fs::metadata(&fixture).unwrap().len();
        // Cap around half the doc → at least 2 parts.
        let cap = total_size / 2 + 200;

        let out_dir = TestDir::new("split-out");
        let parts = split_by_max_bytes(&toolchain, &fixture, cap, out_dir.path()).unwrap();
        assert!(
            parts.len() >= 2,
            "expected multiple parts, got {}",
            parts.len()
        );
        assert_eq!(parts[0].first_page_index, 0);
        assert_eq!(parts.last().unwrap().last_page_index, 7);
        for window in parts.windows(2) {
            assert_eq!(window[0].last_page_index + 1, window[1].first_page_index);
        }
        for part in &parts {
            assert!(part.path.is_file());
            assert_eq!(fs::metadata(&part.path).unwrap().len(), part.byte_length);
            if !part.oversized {
                assert!(part.byte_length <= cap);
            }
            let pages_in_part = part.last_page_index - part.first_page_index + 1;
            assert_eq!(page_count(&toolchain, &part.path).unwrap(), pages_in_part);
        }
    }

    #[test]
    fn decrypt_by_path_strips_encryption() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("decrypt");
        let fixture = write_fixture(dir.path(), "plain.pdf", &[letter_page(Some("secret"))]);

        // Encrypt with qpdf, then decrypt through the op under test.
        let encrypted = dir.path().join("encrypted.pdf");
        let mut arguments = args(&["--encrypt", "hunter2", "hunter2", "256", "--"]);
        arguments.push(path_arg(&fixture));
        arguments.push(path_arg(&encrypted));
        run_qpdf(&toolchain, arguments).unwrap();
        // Without the password the object dump is unreadable — facts error
        // rather than pretend; the shell surfaces this as "decrypt first".
        assert!(document_facts(&toolchain, &encrypted).is_err());

        let decrypted = dir.path().join("decrypted.pdf");
        decrypt(&toolchain, &encrypted, "hunter2", &decrypted, dir.path()).unwrap();
        let facts = document_facts(&toolchain, &decrypted).unwrap();
        assert!(!facts.encrypted);
        assert_eq!(facts.page_count, 1);
        // The password temp file must not linger.
        assert!(!dir.path().join("pw.txt").exists());
    }

    #[test]
    fn scrub_repair_linearize_compress_produce_valid_outputs() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("qpdf-rewrites");
        let fixture = write_fixture(dir.path(), "in.pdf", &[letter_page(Some("hello"))]);

        for (label, op) in [
            (
                "scrub",
                scrub_metadata as fn(&PathOpsToolchain, &Path, &Path) -> OpResult<()>,
            ),
            ("repair", repair),
            ("linearize", linearize),
            ("compress", compress),
        ] {
            let output = dir.path().join(format!("{label}.pdf"));
            op(&toolchain, &fixture, &output).unwrap();
            assert_eq!(page_count(&toolchain, &output).unwrap(), 1, "{label}");
        }
    }

    #[test]
    fn normalize_produces_letter_portrait_pages() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("normalize");
        let fixture = write_fixture(
            dir.path(),
            "mixed.pdf",
            &[
                MiniPdfPage {
                    media_box: [0.0, 0.0, 792.0, 612.0], // letter landscape
                    rects: Vec::new(),
                    text: Some("landscape".to_string()),
                    texts: Vec::new(),
                },
                MiniPdfPage {
                    media_box: [0.0, 0.0, 612.0, 1008.0], // legal portrait
                    rects: Vec::new(),
                    text: Some("legal".to_string()),
                    texts: Vec::new(),
                },
            ],
        );
        let output = dir.path().join("normalized.pdf");
        normalize_to_letter_portrait(&toolchain, &fixture, &output).unwrap();
        let facts = document_facts(&toolchain, &output).unwrap();
        assert_eq!(facts.page_count, 2);
        assert!(
            facts.pages.iter().all(|page| page.letter_portrait),
            "pages: {:?}",
            facts.pages
        );
    }

    #[test]
    fn redaction_verifies_and_output_page_text_is_gone() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("redact");
        let fixture = write_fixture(
            dir.path(),
            "sensitive.pdf",
            &[
                letter_page(Some("public cover page")),
                letter_page(Some("SSN 123-45-6789 lives here")),
                letter_page(Some("public closing page")),
            ],
        );
        let output = dir.path().join("redacted.pdf");
        let areas = [RedactArea {
            page_index: 1,
            x: 90.0,
            y: 480.0,
            w: 350.0,
            h: 60.0,
        }];
        let verification = redact_areas(&toolchain, &fixture, &areas, &output, dir.path()).unwrap();
        assert!(verification.verified);
        assert_eq!(verification.method, "rasterize+re-extract");
        assert_eq!(verification.areas.len(), 1);
        assert!(verification.areas[0].pass);
        assert_eq!(page_count(&toolchain, &output).unwrap(), 3);
    }

    #[test]
    fn redaction_fails_closed_when_verification_finds_text() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("redact-failclosed");
        let fixture = write_fixture(
            dir.path(),
            "sensitive.pdf",
            &[letter_page(Some("SSN 123-45-6789 lives here"))],
        );
        let output = dir.path().join("redacted.pdf");
        let areas = [RedactArea {
            page_index: 0,
            x: 90.0,
            y: 480.0,
            w: 350.0,
            h: 60.0,
        }];
        // rasterize=false leaves overlay-only pages: text survives underneath,
        // so verification MUST fail and the output MUST be deleted.
        let error = redact_areas_impl(&toolchain, &fixture, &areas, &output, dir.path(), false)
            .unwrap_err();
        assert_eq!(error.code, ERR_VERIFICATION_FAILED);
        assert!(!output.exists(), "fail-closed: output file must be deleted");
    }

    #[test]
    fn redaction_refuses_without_ghostscript() {
        let Some(mut toolchain) = test_toolchain() else {
            return;
        };
        toolchain.ghostscript = None;
        let dir = TestDir::new("redact-no-gs");
        let fixture = write_fixture(dir.path(), "in.pdf", &[letter_page(Some("text"))]);
        let output = dir.path().join("out.pdf");
        let areas = [RedactArea {
            page_index: 0,
            x: 10.0,
            y: 10.0,
            w: 50.0,
            h: 20.0,
        }];
        let error = redact_areas(&toolchain, &fixture, &areas, &output, dir.path()).unwrap_err();
        assert_eq!(error.code, ERR_TOOLCHAIN_MISSING);
        assert!(!output.exists());
    }

    #[test]
    fn prepare_filing_composes_normalize_scrub_split() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("prepare-filing");
        let fixture = write_fixture(
            dir.path(),
            "filing.pdf",
            &(0..6)
                .map(|i| MiniPdfPage {
                    media_box: if i % 2 == 0 {
                        [0.0, 0.0, 612.0, 792.0]
                    } else {
                        [0.0, 0.0, 792.0, 612.0]
                    },
                    rects: Vec::new(),
                    text: Some(format!("filing page {i}")),
                    texts: Vec::new(),
                })
                .collect::<Vec<_>>(),
        );

        let work = TestDir::new("prepare-filing-work");
        let out = TestDir::new("prepare-filing-out");
        // First run without a split cap to learn the normalized size.
        let single = prepare_filing(
            &toolchain,
            &fixture,
            &PrepareFilingPlan {
                normalize: true,
                scrub: true,
                ..Default::default()
            },
            work.path(),
            out.path(),
        )
        .unwrap();
        assert_eq!(single.parts.len(), 1);
        assert_eq!(single.facts_report.len(), 1);
        assert!(single.facts_report[0].all_letter_portrait);
        assert!(!single.facts_report[0].encrypted);
        assert_eq!(single.facts_report[0].page_count, 6);
        assert_eq!(single.facts_report[0].within_byte_cap, None);
        assert_eq!(
            single.steps.iter().map(|s| s.step).collect::<Vec<_>>(),
            vec!["normalize-pages", "scrub-metadata"]
        );

        // Now with a cap that forces a split.
        let cap = single.parts[0].byte_length / 2 + 100;
        let work2 = TestDir::new("prepare-filing-work2");
        let out2 = TestDir::new("prepare-filing-out2");
        let split = prepare_filing(
            &toolchain,
            &fixture,
            &PrepareFilingPlan {
                normalize: true,
                scrub: true,
                split_max_bytes: Some(cap),
                ..Default::default()
            },
            work2.path(),
            out2.path(),
        )
        .unwrap();
        assert!(split.parts.len() >= 2);
        let total_pages: u32 = split
            .facts_report
            .iter()
            .map(|preflight| preflight.page_count)
            .sum();
        assert_eq!(total_pages, 6);
        for preflight in &split.facts_report {
            assert!(preflight.all_letter_portrait);
            assert_eq!(preflight.within_byte_cap, Some(true));
        }
    }

    #[test]
    fn minimal_pdf_writer_output_is_qpdf_clean() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("writer");
        let fixture = write_fixture(
            dir.path(),
            "writer.pdf",
            &[MiniPdfPage {
                media_box: [0.0, 0.0, 612.0, 792.0],
                rects: vec![[100.0, 100.0, 200.0, 50.0]],
                text: Some("with (parens) and \\ backslash".to_string()),
                texts: Vec::new(),
            }],
        );
        // `qpdf --check` exits non-zero on structural errors.
        let mut arguments = args(&["--check"]);
        arguments.push(path_arg(&fixture));
        run_qpdf(&toolchain, arguments).unwrap();
    }

    // ---- OCR mode (pure) ----

    #[test]
    fn ocr_arguments_reflect_mode() {
        let skip = ocr_arguments(&OcrOptions::with_mode(OcrMode::SkipText)).unwrap();
        assert_eq!(skip[0], OsString::from("--skip-text"));
        let force = ocr_arguments(&OcrOptions::with_mode(OcrMode::ForceOcr)).unwrap();
        assert_eq!(force[0], OsString::from("--force-ocr"));
        for arguments in [&skip, &force] {
            assert_eq!(arguments[1], OsString::from("--output-type"));
            assert_eq!(arguments[2], OsString::from("pdf"));
            assert_eq!(arguments[3], OsString::from("--language"));
            assert_eq!(arguments[4], OsString::from("eng"));
        }
    }

    #[test]
    fn ocr_arguments_include_languages_and_deskew() {
        let arguments = ocr_arguments(&OcrOptions {
            mode: OcrMode::ForceOcr,
            languages: vec!["eng".to_string(), "spa".to_string()],
            deskew: true,
            page_indexes: Vec::new(),
        })
        .unwrap();

        assert_eq!(
            arguments,
            args(&[
                "--force-ocr",
                "--output-type",
                "pdf",
                "--language",
                "eng",
                "--language",
                "spa",
                "--deskew",
            ])
        );
    }

    #[test]
    fn ocr_arguments_include_compact_page_selection() {
        let arguments = ocr_arguments(&OcrOptions {
            mode: OcrMode::ForceOcr,
            languages: vec!["eng".to_string()],
            deskew: false,
            page_indexes: vec![0, 2, 3, 8],
        })
        .unwrap();

        assert_eq!(
            arguments,
            args(&[
                "--force-ocr",
                "--output-type",
                "pdf",
                "--language",
                "eng",
                "--pages",
                "1,3-4,9",
            ])
        );
    }

    #[test]
    fn ocr_progress_arguments_reflect_mode() {
        let skip = ocr_progress_arguments(&OcrOptions::with_mode(OcrMode::SkipText)).unwrap();
        assert_eq!(skip[0], OsString::from("--mode"));
        assert_eq!(skip[1], OsString::from("skip"));
        let force = ocr_progress_arguments(&OcrOptions::with_mode(OcrMode::ForceOcr)).unwrap();
        assert_eq!(force[0], OsString::from("--mode"));
        assert_eq!(force[1], OsString::from("force"));
        for arguments in [&skip, &force] {
            assert_eq!(arguments[2], OsString::from("--output-type"));
            assert_eq!(arguments[3], OsString::from("pdf"));
            assert_eq!(arguments[4], OsString::from("--language"));
            assert_eq!(arguments[5], OsString::from("eng"));
        }
    }

    #[test]
    fn ocr_progress_arguments_include_compact_page_selection() {
        let arguments = ocr_progress_arguments(&OcrOptions {
            mode: OcrMode::ForceOcr,
            languages: vec!["eng".to_string()],
            deskew: false,
            page_indexes: vec![1, 2, 4],
        })
        .unwrap();

        assert_eq!(
            arguments,
            args(&[
                "--mode",
                "force",
                "--output-type",
                "pdf",
                "--language",
                "eng",
                "--pages",
                "2-3,5",
            ])
        );
    }

    #[test]
    fn parse_ocr_progress_line_accepts_only_prefixed_ndjson() {
        let progress = parse_ocr_progress_line(
            r#"@@RAIOPDF_OCR_PROGRESS@@ {"phase":"ocr","description":"OCR","completed":2.5,"total":5,"unit":"page"}"#,
        )
        .unwrap();
        assert_eq!(
            progress,
            OcrProgress {
                phase: "ocr".to_string(),
                description: Some("OCR".to_string()),
                completed: 2.5,
                total: Some(5.0),
                unit: "page".to_string(),
            }
        );

        assert!(parse_ocr_progress_line("    1 Rasterizing page 1").is_none());
        assert!(parse_ocr_progress_line("@@RAIOPDF_OCR_PROGRESS@@ not-json").is_none());
        let indeterminate = parse_ocr_progress_line(
            r#"@@RAIOPDF_OCR_PROGRESS@@ {"phase":"postprocess","description":"Recompressing","completed":0,"total":0,"unit":"image"}"#,
        )
        .unwrap();
        assert_eq!(indeterminate.total, None);
        assert!(parse_ocr_progress_line(
            r#"@@RAIOPDF_OCR_PROGRESS@@ {"phase":"ocr","completed":0,"total":-1}"#
        )
        .is_none());
    }

    #[test]
    fn ocr_mode_deserializes_the_ui_strings() {
        let skip: OcrMode = serde_json::from_str("\"skip-text\"").unwrap();
        assert_eq!(skip, OcrMode::SkipText);
        let force: OcrMode = serde_json::from_str("\"force-ocr\"").unwrap();
        assert_eq!(force, OcrMode::ForceOcr);
        assert!(serde_json::from_str::<OcrMode>("\"rebuild\"").is_err());
    }

    // ---- Stamping option mapping (pure) ----

    fn letter_facts(count: u32) -> Vec<PageFacts> {
        (0..count)
            .map(|index| PageFacts {
                index,
                media_box: [0.0, 0.0, 612.0, 792.0],
                rotate: 0,
                orientation: "portrait",
                letter_portrait: true,
            })
            .collect()
    }

    #[test]
    fn stamp_options_deserialize_the_engine_api_shapes() {
        let bates: BatesStampOptions = serde_json::from_str(
            r#"{ "prefix": "ABC", "start": 1, "digits": 6,
                 "placement": { "edge": "footer", "align": "right" },
                 "fontSizePt": 10, "marginIn": 0.5 }"#,
        )
        .unwrap();
        assert_eq!(bates.prefix, "ABC");
        assert_eq!(bates.placement.edge, StampEdge::Footer);
        assert_eq!(bates.placement.align, StampAlign::Right);
        assert_eq!(bates.font_size_pt, Some(10.0));

        let numbers: PageNumbersOptions = serde_json::from_str(
            r#"{ "startAt": 1, "pageIndexes": [0, 2], "format": "page-of-total",
                 "placement": { "edge": "header", "align": "center" } }"#,
        )
        .unwrap();
        assert_eq!(numbers.format, PageNumberFormat::PageOfTotal);
        assert!(
            matches!(numbers.page_indexes, PageSelection::Indexes(ref pages) if pages == &[0, 2])
        );
        assert_eq!(numbers.font_size_pt, None);

        let watermark: WatermarkOptions = serde_json::from_str(
            r#"{ "text": "DRAFT", "pageIndexes": "all", "orientation": "diagonal", "opacity": 0.25 }"#,
        )
        .unwrap();
        assert!(matches!(
            watermark.page_indexes,
            PageSelection::Keyword(PageSelectionKeyword::All)
        ));
        assert_eq!(watermark.opacity, Some(0.25));

        let first: PageSelection = serde_json::from_str("\"first\"").unwrap();
        assert!(matches!(
            first,
            PageSelection::Keyword(PageSelectionKeyword::First)
        ));
    }

    #[test]
    fn page_selection_resolves_and_rejects_out_of_range() {
        assert_eq!(
            PageSelection::Keyword(PageSelectionKeyword::All)
                .resolve(3)
                .unwrap(),
            vec![0, 1, 2]
        );
        assert_eq!(
            PageSelection::Keyword(PageSelectionKeyword::First)
                .resolve(3)
                .unwrap(),
            vec![0]
        );
        assert_eq!(
            PageSelection::Indexes(vec![2, 0, 2]).resolve(3).unwrap(),
            vec![2, 0],
            "dedupes in first-seen order"
        );
        let error = PageSelection::Indexes(vec![3]).resolve(3).unwrap_err();
        assert_eq!(error.code, ERR_INVALID_INPUT);
        assert!(PageSelection::Indexes(Vec::new()).resolve(3).is_err());
    }

    #[test]
    fn plan_bates_overlay_stamps_every_page_and_matches_dims() {
        let mut pages = letter_facts(3);
        pages[1].media_box = [0.0, 0.0, 792.0, 612.0];
        let options = BatesStampOptions {
            prefix: "ABC".to_string(),
            start: 9,
            digits: 6,
            placement: StampPlacement {
                edge: StampEdge::Footer,
                align: StampAlign::Right,
            },
            font_size_pt: None,
            margin_in: None,
        };

        let overlay = plan_bates_overlay(&pages, &options).unwrap();
        assert_eq!(overlay.len(), pages.len());
        for (page, facts) in overlay.iter().zip(&pages) {
            assert_eq!(
                page.media_box, facts.media_box,
                "overlay MediaBox must match the page"
            );
            assert_eq!(page.texts.len(), 1);
        }
        assert_eq!(overlay[0].texts[0].text, "ABC000009");
        assert_eq!(overlay[2].texts[0].text, "ABC000011");
        // Footer-right lands inside the page box.
        let stamp = &overlay[0].texts[0];
        assert!(stamp.y > 0.0 && stamp.y < 100.0);
        assert!(stamp.x > 0.0 && stamp.x < 612.0);
    }

    #[test]
    fn plan_bates_overlay_rejects_digit_overflow() {
        let pages = letter_facts(3);
        let options = BatesStampOptions {
            prefix: String::new(),
            start: 99,
            digits: 2,
            placement: StampPlacement {
                edge: StampEdge::Footer,
                align: StampAlign::Left,
            },
            font_size_pt: None,
            margin_in: None,
        };
        let error = plan_bates_overlay(&pages, &options).unwrap_err();
        assert_eq!(error.code, ERR_INVALID_INPUT);
        assert!(error.message.contains("digit width"));
    }

    #[test]
    fn plan_page_numbers_overlay_numbers_only_selected_pages() {
        let pages = letter_facts(3);
        let options = PageNumbersOptions {
            start_at: 7,
            page_indexes: PageSelection::Indexes(vec![1, 2]),
            format: PageNumberFormat::PageOfTotal,
            placement: StampPlacement {
                edge: StampEdge::Footer,
                align: StampAlign::Center,
            },
            font_size_pt: None,
            margin_in: None,
        };

        let overlay = plan_page_numbers_overlay(&pages, &options).unwrap();
        assert_eq!(overlay.len(), 3);
        assert!(
            overlay[0].texts.is_empty(),
            "unselected page gets an empty overlay page"
        );
        assert_eq!(overlay[1].texts[0].text, "Page 7 of 3");
        assert_eq!(overlay[2].texts[0].text, "Page 8 of 3");

        let out_of_range = PageNumbersOptions {
            page_indexes: PageSelection::Indexes(vec![9]),
            ..options
        };
        assert!(plan_page_numbers_overlay(&pages, &out_of_range).is_err());
    }

    #[test]
    fn plan_watermark_overlay_rotates_fits_and_defaults_opacity() {
        let pages = letter_facts(2);
        let options = WatermarkOptions {
            text: "CONFIDENTIAL".to_string(),
            page_indexes: PageSelection::Indexes(vec![1]),
            orientation: WatermarkOrientation::Diagonal,
            opacity: None,
            font_size_pt: None,
        };

        let overlay = plan_watermark_overlay(&pages, &options).unwrap();
        assert!(overlay[0].texts.is_empty());
        let stamp = &overlay[1].texts[0];
        assert_eq!(stamp.rotate_deg, 45.0);
        assert_eq!(stamp.opacity, Some(DEFAULT_WATERMARK_OPACITY));
        assert!(stamp.bold);
        // Fit-scaled bounds stay on the page.
        let bounds = rotated_text_bounds(
            text_width_pt(&options.text, stamp.size_pt, true),
            stamp.size_pt,
            45.0,
        );
        assert!(bounds.width <= 612.0 + 1e-6);
        assert!(bounds.height <= 792.0 + 1e-6);

        let bad_opacity = WatermarkOptions {
            opacity: Some(1.5),
            ..options.clone()
        };
        assert!(plan_watermark_overlay(&pages, &bad_opacity).is_err());
        let empty_text = WatermarkOptions {
            text: String::new(),
            ..options
        };
        assert!(plan_watermark_overlay(&pages, &empty_text).is_err());
    }

    #[test]
    fn plan_edge_stamp_is_rotation_aware_and_rejects_oversized_margins() {
        let page = PageFacts {
            index: 0,
            media_box: [0.0, 0.0, 612.0, 792.0],
            rotate: 90,
            orientation: "portrait",
            letter_portrait: false,
        };
        let placement = StampPlacement {
            edge: StampEdge::Footer,
            align: StampAlign::Left,
        };
        let stamp = plan_edge_stamp(&page, "X1", placement, 11.0, 0.5).unwrap();
        // Visual footer-left on a 90 degree page maps to page coords
        // (pageWidth - marginPt, marginPt) and the text rotates with the page.
        assert!((stamp.x - (612.0 - 36.0)).abs() < 1e-6);
        assert!((stamp.y - 36.0).abs() < 1e-6);
        assert_eq!(stamp.rotate_deg, 90.0);

        let unrotated = PageFacts { rotate: 0, ..page };
        let centered = plan_edge_stamp(
            &unrotated,
            "X1",
            StampPlacement {
                edge: StampEdge::Header,
                align: StampAlign::Center,
            },
            11.0,
            0.5,
        )
        .unwrap();
        assert!((centered.y - (792.0 - 36.0 - 11.0)).abs() < 1e-6);
        assert!(centered.x > 0.0 && centered.x < 612.0);

        let error = plan_edge_stamp(&unrotated, "X1", placement, 11.0, 5.0).unwrap_err();
        assert!(error.message.contains("no room"));
    }

    // ---- Toolchain-backed stamping + insert tests ----

    /// Ghostscript txtwrite over the whole file (test helper): the extracted
    /// text is the spot-check that a stamp landed as real text.
    fn extract_all_text(toolchain: &PathOpsToolchain, pdf: &Path, work_dir: &Path) -> String {
        let text_path = work_dir.join("extracted.txt");
        let mut arguments = args(&["-dBATCH", "-dNOPAUSE", "-dNOSAFER", "-sDEVICE=txtwrite"]);
        arguments.push(OsString::from(format!(
            "-sOutputFile={}",
            text_path.display()
        )));
        arguments.push(path_arg(pdf));
        run_ghostscript(toolchain, arguments).unwrap();
        fs::read_to_string(&text_path).unwrap()
    }

    #[test]
    fn bates_stamp_by_path_stamps_every_page() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("bates");
        let fixture = write_fixture(
            dir.path(),
            "in.pdf",
            &(0..3)
                .map(|i| letter_page(Some(&format!("body {i}"))))
                .collect::<Vec<_>>(),
        );
        let output = dir.path().join("bates.pdf");
        let options = BatesStampOptions {
            prefix: "ABC".to_string(),
            start: 1,
            digits: 6,
            placement: StampPlacement {
                edge: StampEdge::Footer,
                align: StampAlign::Right,
            },
            font_size_pt: None,
            margin_in: None,
        };

        bates_stamp(&toolchain, &fixture, &options, &output, dir.path()).unwrap();

        let facts = document_facts(&toolchain, &output).unwrap();
        assert_eq!(facts.page_count, 3);
        assert!(
            facts.pages.iter().all(|page| page.letter_portrait),
            "dims preserved"
        );
        let text = extract_all_text(&toolchain, &output, dir.path());
        for expected in ["ABC000001", "ABC000002", "ABC000003", "body 0", "body 2"] {
            assert!(text.contains(expected), "missing {expected} in: {text}");
        }
    }

    #[test]
    fn page_numbers_by_path_stamps_selected_pages() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("pagenumbers");
        let fixture = write_fixture(
            dir.path(),
            "in.pdf",
            &(0..3)
                .map(|i| letter_page(Some(&format!("body {i}"))))
                .collect::<Vec<_>>(),
        );
        let output = dir.path().join("numbered.pdf");
        let options = PageNumbersOptions {
            start_at: 7,
            page_indexes: PageSelection::Indexes(vec![1]),
            format: PageNumberFormat::PageOfTotal,
            placement: StampPlacement {
                edge: StampEdge::Footer,
                align: StampAlign::Center,
            },
            font_size_pt: None,
            margin_in: None,
        };

        page_numbers(&toolchain, &fixture, &options, &output, dir.path()).unwrap();

        assert_eq!(page_count(&toolchain, &output).unwrap(), 3);
        let text = extract_all_text(&toolchain, &output, dir.path());
        assert!(text.contains("Page 7 of 3"), "missing stamp in: {text}");
        assert!(
            !text.contains("Page 8"),
            "only the selected page is numbered"
        );
    }

    #[test]
    fn watermark_by_path_keeps_dims_and_adds_text() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("watermark");
        let fixture = write_fixture(
            dir.path(),
            "in.pdf",
            &[
                letter_page(Some("body page")),
                letter_page(Some("second page")),
            ],
        );
        let output = dir.path().join("watermarked.pdf");
        let options = WatermarkOptions {
            text: "DRAFT".to_string(),
            page_indexes: PageSelection::Keyword(PageSelectionKeyword::All),
            orientation: WatermarkOrientation::Diagonal,
            opacity: None,
            font_size_pt: None,
        };

        watermark(&toolchain, &fixture, &options, &output, dir.path()).unwrap();

        let facts = document_facts(&toolchain, &output).unwrap();
        assert_eq!(facts.page_count, 2);
        assert!(
            facts.pages.iter().all(|page| page.letter_portrait),
            "dims preserved"
        );
        let text = extract_all_text(&toolchain, &output, dir.path());
        // txtwrite may space rotated glyphs apart -- strip whitespace before
        // the spot-check.
        let squeezed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(squeezed.contains("DRAFT"), "missing watermark in: {text}");
        assert!(text.contains("body page"), "original text preserved");
    }

    #[test]
    fn insert_pages_composes_at_start_middle_and_end() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("insert-pages");
        let target = write_fixture(
            dir.path(),
            "target.pdf",
            &(0..3)
                .map(|i| letter_page(Some(&format!("target {i}"))))
                .collect::<Vec<_>>(),
        );
        let insert = write_fixture(
            dir.path(),
            "insert.pdf",
            &(0..2)
                .map(|i| letter_page(Some(&format!("insert {i}"))))
                .collect::<Vec<_>>(),
        );

        for (at_index, expected_order) in [
            (
                0u32,
                vec!["insert 0", "insert 1", "target 0", "target 1", "target 2"],
            ),
            (
                2u32,
                vec!["target 0", "target 1", "insert 0", "insert 1", "target 2"],
            ),
            (
                3u32,
                vec!["target 0", "target 1", "target 2", "insert 0", "insert 1"],
            ),
        ] {
            let output = dir.path().join(format!("out-{at_index}.pdf"));
            insert_pages(&toolchain, &target, &insert, at_index, &output).unwrap();
            assert_eq!(page_count(&toolchain, &output).unwrap(), 5);

            let text = extract_all_text(&toolchain, &output, dir.path());
            let mut positions = Vec::new();
            for marker in &expected_order {
                let position = text
                    .find(marker)
                    .unwrap_or_else(|| panic!("missing {marker} in insert at {at_index}"));
                positions.push(position);
            }
            let mut sorted = positions.clone();
            sorted.sort_unstable();
            assert_eq!(
                positions, sorted,
                "page order wrong for at_index {at_index}"
            );
        }

        let error = insert_pages(
            &toolchain,
            &target,
            &insert,
            4,
            &dir.path().join("nope.pdf"),
        )
        .unwrap_err();
        assert_eq!(error.code, ERR_INVALID_INPUT);
    }

    #[test]
    fn minimal_pdf_writer_with_placed_texts_is_qpdf_clean() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let dir = TestDir::new("writer-placed");
        let fixture = write_fixture(
            dir.path(),
            "placed.pdf",
            &[MiniPdfPage {
                media_box: [0.0, 0.0, 612.0, 792.0],
                rects: Vec::new(),
                text: None,
                texts: vec![
                    MiniPdfText {
                        text: "ABC000001".to_string(),
                        x: 400.0,
                        y: 36.0,
                        size_pt: 11.0,
                        rotate_deg: 0.0,
                        gray: 0.0,
                        opacity: None,
                        bold: false,
                    },
                    MiniPdfText {
                        text: "DRAFT (rotated)".to_string(),
                        x: 150.0,
                        y: 300.0,
                        size_pt: 48.0,
                        rotate_deg: 45.0,
                        gray: 0.35,
                        opacity: Some(0.18),
                        bold: true,
                    },
                ],
            }],
        );
        let mut arguments = args(&["--check"]);
        arguments.push(path_arg(&fixture));
        run_qpdf(&toolchain, arguments).unwrap();
    }

    /// Opt-in acceptance harness for the large-pdf-handling plan: point
    /// `RAIOPDF_LARGE_FIXTURE` at one multi-hundred-MB PDF, or
    /// `RAIOPDF_LARGE_FIXTURES_DIR` at a folder of real release canary PDFs,
    /// and run:
    ///
    /// ```text
    /// RAIOPDF_ENGINE_PAYLOAD_DIR=<payload> RAIOPDF_LARGE_FIXTURES_DIR=<dir> \
    ///   cargo test -p engine-sidecar-core -- --ignored large_fixture --nocapture
    /// ```
    ///
    /// Demonstrates: split-by-max-bytes producing qpdf-valid parts under the
    /// cap, and `prepare_filing` (normalize + split) with per-part facts
    /// preflight — the release-blocking large-file page-normalization path.
    #[test]
    #[ignore = "acceptance harness — needs RAIOPDF_LARGE_FIXTURE and the payload toolchain"]
    fn large_fixture_split_and_prepare_filing_acceptance() {
        let fixture_env_set = env::var_os("RAIOPDF_LARGE_FIXTURE").is_some()
            || env::var_os("RAIOPDF_LARGE_FIXTURES_DIR").is_some();
        let fixtures = large_acceptance_fixtures();
        if fixtures.is_empty() {
            if fixture_env_set {
                panic!(
                    "RAIOPDF_LARGE_FIXTURE/RAIOPDF_LARGE_FIXTURES_DIR was set but no PDFs met the large-fixture filter"
                );
            }
            eprintln!(
                "set RAIOPDF_LARGE_FIXTURE or RAIOPDF_LARGE_FIXTURES_DIR to run this acceptance test"
            );
            return;
        };

        let toolchain = test_toolchain().unwrap_or_else(|| {
            panic!(
                "RAIOPDF_LARGE_FIXTURE/RAIOPDF_LARGE_FIXTURES_DIR was set but qpdf/ghostscript were not available"
            )
        });

        let cap: u64 = 50 * 1024 * 1024;

        for fixture in fixtures {
            let input_len = fs::metadata(&fixture).expect("fixture must exist").len();
            let total_pages = page_count(&toolchain, &fixture)
                .unwrap_or_else(|error| panic!("{} page_count failed: {error}", fixture.display()));
            let dir = TestDir::new("large-acceptance");

            // 1. split_by_max_bytes -> contiguous, qpdf-valid parts under the cap.
            let split_dir = dir.path().join("split");
            fs::create_dir_all(&split_dir).unwrap();
            let started = std::time::Instant::now();
            let parts = split_by_max_bytes(&toolchain, &fixture, cap, &split_dir)
                .unwrap_or_else(|error| panic!("{} split failed: {error}", fixture.display()));
            eprintln!(
                "[acceptance] split_by_max_bytes {}: {} bytes / {} pages -> {} parts in {:.1?}",
                fixture.display(),
                input_len,
                total_pages,
                parts.len(),
                started.elapsed(),
            );
            if input_len > cap {
                assert!(
                    parts.len() >= 2,
                    "over-cap large fixture must split: {}",
                    fixture.display()
                );
            } else {
                assert_eq!(
                    parts.len(),
                    1,
                    "under-cap large fixture should remain one part before normalization: {}",
                    fixture.display()
                );
            }
            let mut covered_pages = 0u32;
            for part in &parts {
                assert!(
                    part.oversized || part.byte_length <= cap,
                    "part {} is {} bytes over a {} cap without an oversized flag",
                    part.path.display(),
                    part.byte_length,
                    cap,
                );
                covered_pages += part.last_page_index - part.first_page_index + 1;
                let mut arguments = args(&["--check"]);
                arguments.push(path_arg(&part.path));
                run_qpdf(&toolchain, arguments).unwrap_or_else(|error| {
                    panic!("{} did not pass qpdf --check: {error}", part.path.display())
                });
            }
            assert_eq!(
                covered_pages,
                total_pages,
                "split parts must cover every source page for {}",
                fixture.display()
            );

            // 2. prepare_filing (normalize + split) with facts preflight.
            let stage_dir = dir.path().join("stage");
            let out_dir = dir.path().join("out");
            fs::create_dir_all(&stage_dir).unwrap();
            fs::create_dir_all(&out_dir).unwrap();
            let plan = PrepareFilingPlan {
                decrypt_password: None,
                sanitize: false,
                normalize: true,
                ocr: false,
                scrub: false,
                split_max_bytes: Some(cap),
            };
            let started = std::time::Instant::now();
            let outcome = prepare_filing(&toolchain, &fixture, &plan, &stage_dir, &out_dir)
                .unwrap_or_else(|error| {
                    panic!("{} prepare_filing failed: {error}", fixture.display())
                });
            eprintln!(
                "[acceptance] prepare_filing(normalize+split) {}: {} parts, {} facts rows in {:.1?}",
                fixture.display(),
                outcome.parts.len(),
                outcome.facts_report.len(),
                started.elapsed(),
            );
            assert_eq!(
                outcome
                    .steps
                    .iter()
                    .map(|step| step.step)
                    .collect::<Vec<_>>(),
                vec!["normalize-pages", "split-by-size"],
            );
            assert_eq!(outcome.parts.len(), outcome.facts_report.len());
            for preflight in &outcome.facts_report {
                assert!(
                    preflight.all_letter_portrait,
                    "part {} from {} is not all letter portrait",
                    preflight.part_index + 1,
                    fixture.display()
                );
                assert!(!preflight.encrypted);
                assert_eq!(
                    preflight.within_byte_cap,
                    Some(true),
                    "part {} from {} exceeded the byte cap",
                    preflight.part_index + 1,
                    fixture.display()
                );
            }
            for part in &outcome.parts {
                let mut arguments = args(&["--check"]);
                arguments.push(path_arg(&part.path));
                run_qpdf(&toolchain, arguments).unwrap_or_else(|error| {
                    panic!("{} did not pass qpdf --check: {error}", part.path.display())
                });
            }
        }
    }

    fn large_acceptance_fixtures() -> Vec<PathBuf> {
        let min_bytes = env::var("RAIOPDF_LARGE_FIXTURE_MIN_BYTES")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(40 * 1024 * 1024);

        let mut fixtures = Vec::new();
        if let Some(list) = env::var_os("RAIOPDF_LARGE_FIXTURE") {
            fixtures.extend(env::split_paths(&list));
        }
        if let Some(dir) = env::var_os("RAIOPDF_LARGE_FIXTURES_DIR") {
            collect_large_pdfs(&PathBuf::from(dir), min_bytes, &mut fixtures);
        }

        fixtures.retain(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
                && fs::metadata(path)
                    .map(|metadata| metadata.len() >= min_bytes)
                    .unwrap_or(false)
        });
        fixtures.sort();
        fixtures.dedup();
        fixtures
    }

    fn collect_large_pdfs(dir: &Path, min_bytes: u64, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_large_pdfs(&path, min_bytes, out);
                continue;
            }
            if path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
                && fs::metadata(&path)
                    .map(|metadata| metadata.len() >= min_bytes)
                    .unwrap_or(false)
            {
                out.push(path);
            }
        }
    }
}
