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
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use crate::{current_exe_dir, dev_payload_dir, find_payload_dir, payload_path_entries};

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
}

impl Tool {
    pub const fn name(self) -> &'static str {
        match self {
            Tool::Qpdf => "qpdf",
            Tool::Ghostscript => "ghostscript",
            Tool::Ocrmypdf => "ocrmypdf",
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
}

/// The enumerable PathOpsEngine registry. Order is the plan's priority order.
pub const OP_DESCRIPTORS: &[OpDescriptor] = &[
    OpDescriptor {
        name: "page_count",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "document_facts",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "decrypt",
        requires: &[Tool::Qpdf],
        filing_step: Some("remove-encryption"),
    },
    OpDescriptor {
        name: "extract_pages",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "merge",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "split_by_max_bytes",
        requires: &[Tool::Qpdf],
        filing_step: Some("split-by-size"),
    },
    OpDescriptor {
        name: "normalize_to_letter_portrait",
        requires: &[Tool::Ghostscript],
        filing_step: Some("normalize-pages"),
    },
    OpDescriptor {
        name: "scrub_metadata",
        requires: &[Tool::Qpdf],
        filing_step: Some("scrub-metadata"),
    },
    OpDescriptor {
        name: "prepare_filing",
        requires: &[Tool::Qpdf, Tool::Ghostscript],
        filing_step: None,
    },
    OpDescriptor {
        name: "ocr",
        requires: &[Tool::Ocrmypdf],
        filing_step: Some("make-searchable"),
    },
    OpDescriptor {
        name: "repair",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "redact_areas",
        requires: &[Tool::Qpdf, Tool::Ghostscript],
        filing_step: None,
    },
    OpDescriptor {
        name: "linearize",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "compress",
        requires: &[Tool::Qpdf],
        filing_step: None,
    },
    OpDescriptor {
        name: "sanitize",
        requires: &[Tool::Ghostscript],
        filing_step: Some("sanitize-content"),
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
                })
                .map(|tool| tool.name())
                .collect();
            PathOpStatus {
                name: descriptor.name,
                available: missing_tools.is_empty(),
                missing_tools,
                filing_step: descriptor.filing_step,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

fn run_command(
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

fn expect_success(tool: &str, output: &Output) -> OpResult<()> {
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

fn args(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(OsString::from).collect()
}

fn run_qpdf(toolchain: &PathOpsToolchain, arguments: Vec<OsString>) -> OpResult<Output> {
    let qpdf = toolchain.require_qpdf()?;
    let output = run_command(qpdf, &arguments, None, &[])?;
    expect_success("qpdf", &output)?;
    Ok(output)
}

fn run_ghostscript(toolchain: &PathOpsToolchain, arguments: Vec<OsString>) -> OpResult<Output> {
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

fn require_input_file(input: &Path) -> OpResult<u64> {
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

fn path_arg(path: &Path) -> OsString {
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
pub struct DocumentFacts {
    pub page_count: u32,
    pub size_bytes: u64,
    pub encrypted: bool,
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
        pages: page_facts,
    })
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

fn build_page_range(
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

/// By-path OCRmyPDF run — skips the sidecar HTTP byte upload entirely. The
/// bundled `ocrmypdf.cmd` is self-contained for Python but resolves
/// `tesseract` and `gs` from PATH, so the payload bin dirs are prepended.
pub fn ocr(toolchain: &PathOpsToolchain, input: &Path, output_path: &Path) -> OpResult<()> {
    require_input_file(input)?;
    let ocrmypdf = toolchain.require_ocrmypdf()?;
    let mut arguments = args(&["--skip-text", "--output-type", "pdf"]);
    arguments.push(path_arg(input));
    arguments.push(path_arg(output_path));
    let output = run_command(ocrmypdf, &arguments, None, &toolchain.path_entries)?;
    expect_success("ocrmypdf", &output)?;
    require_output("ocrmypdf", output_path)?;
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

/// A page for the minimal PDF writer: raw MediaBox, black filled rectangles
/// (`[x, y, w, h]` user-space), and optional Helvetica text (test fixtures).
#[derive(Clone, Debug)]
pub(crate) struct MiniPdfPage {
    pub media_box: [f64; 4],
    pub rects: Vec<[f64; 4]>,
    pub text: Option<String>,
}

/// Hand-rolled, dependency-free PDF writer. Object layout: 1 Catalog, 2 Pages,
/// 3 Helvetica font, then (Page, Contents) pairs per page.
pub(crate) fn write_minimal_pdf(path: &Path, pages: &[MiniPdfPage]) -> io::Result<()> {
    let mut buffer: Vec<u8> = Vec::new();
    buffer.extend_from_slice(b"%PDF-1.4\n");

    let total_objects = 3 + pages.len() * 2;
    let mut offsets: Vec<usize> = vec![0; total_objects + 1];

    let kids: Vec<String> = (0..pages.len())
        .map(|index| format!("{} 0 R", 4 + index * 2))
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

    for (index, page) in pages.iter().enumerate() {
        let page_id = 4 + index * 2;
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
            let escaped = text
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)");
            content.push_str(&format!(
                "BT /F1 12 Tf {:.2} {:.2} Td ({escaped}) Tj ET\n",
                llx + 100.0,
                lly + 500.0
            ));
        }

        write_object(
            &mut buffer,
            &mut offsets,
            page_id,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [ {llx:.2} {lly:.2} {urx:.2} {ury:.2} ] \
                 /Resources << /Font << /F1 3 0 R >> >> /Contents {contents_id} 0 R >>"
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
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn letter_page(text: Option<&str>) -> MiniPdfPage {
        MiniPdfPage {
            media_box: [0.0, 0.0, 612.0, 792.0],
            rects: Vec::new(),
            text: text.map(str::to_string),
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
                },
                MiniPdfPage {
                    media_box: [0.0, 0.0, 612.0, 1008.0], // legal portrait
                    rects: Vec::new(),
                    text: Some("legal".to_string()),
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
            }],
        );
        // `qpdf --check` exits non-zero on structural errors.
        let mut arguments = args(&["--check"]);
        arguments.push(path_arg(&fixture));
        run_qpdf(&toolchain, arguments).unwrap();
    }

    /// Opt-in acceptance harness for the large-pdf-handling plan: point
    /// `RAIOPDF_LARGE_FIXTURE` at a multi-hundred-MB PDF (a real canary
    /// fixture, or the synthetic one from
    /// `apps/ui/smoke/generate-large-fixture.mjs`) and run:
    ///
    /// ```text
    /// RAIOPDF_ENGINE_PAYLOAD_DIR=<payload> RAIOPDF_LARGE_FIXTURE=<pdf>     ///   cargo test -p engine-sidecar-core -- --ignored large_fixture --nocapture
    /// ```
    ///
    /// Demonstrates: split-by-max-bytes producing qpdf-valid parts under the
    /// cap, and `prepare_filing` (scrub + split) with per-part facts
    /// preflight — the two path-op acceptance items that don't need a UI.
    #[test]
    #[ignore = "acceptance harness — needs RAIOPDF_LARGE_FIXTURE and the payload toolchain"]
    fn large_fixture_split_and_prepare_filing_acceptance() {
        let Some(toolchain) = test_toolchain() else {
            return;
        };
        let Some(fixture) = env::var_os("RAIOPDF_LARGE_FIXTURE") else {
            eprintln!("set RAIOPDF_LARGE_FIXTURE to a large PDF to run this acceptance test");
            return;
        };
        let fixture = PathBuf::from(fixture);
        let input_len = fs::metadata(&fixture).expect("fixture must exist").len();
        let total_pages = page_count(&toolchain, &fixture).unwrap();
        let dir = TestDir::new("large-acceptance");
        let cap: u64 = 50 * 1024 * 1024;

        // 1. split_by_max_bytes → contiguous, qpdf-valid parts under the cap.
        let split_dir = dir.path().join("split");
        fs::create_dir_all(&split_dir).unwrap();
        let started = std::time::Instant::now();
        let parts = split_by_max_bytes(&toolchain, &fixture, cap, &split_dir).unwrap();
        eprintln!(
            "[acceptance] split_by_max_bytes: {} bytes / {} pages -> {} parts in {:.1?}",
            input_len,
            total_pages,
            parts.len(),
            started.elapsed(),
        );
        assert!(parts.len() >= 2, "a multi-hundred-MB fixture must split");
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
            run_qpdf(&toolchain, arguments).expect("every split part must pass qpdf --check");
        }
        assert_eq!(
            covered_pages, total_pages,
            "split parts must cover every source page"
        );

        // 2. prepare_filing (scrub-metadata + split) with facts preflight.
        let stage_dir = dir.path().join("stage");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&stage_dir).unwrap();
        fs::create_dir_all(&out_dir).unwrap();
        let plan = PrepareFilingPlan {
            decrypt_password: None,
            sanitize: false,
            normalize: false,
            ocr: false,
            scrub: true,
            split_max_bytes: Some(cap),
        };
        let started = std::time::Instant::now();
        let outcome = prepare_filing(&toolchain, &fixture, &plan, &stage_dir, &out_dir).unwrap();
        eprintln!(
            "[acceptance] prepare_filing(scrub+split): {} parts, {} facts rows in {:.1?}",
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
            vec!["scrub-metadata", "split-by-size"],
        );
        assert_eq!(outcome.parts.len(), outcome.facts_report.len());
        for preflight in &outcome.facts_report {
            assert!(!preflight.encrypted);
            assert_eq!(preflight.within_byte_cap, Some(true));
        }
        for part in &outcome.parts {
            let mut arguments = args(&["--check"]);
            arguments.push(path_arg(&part.path));
            run_qpdf(&toolchain, arguments).expect("every filing part must pass qpdf --check");
        }
    }
}
