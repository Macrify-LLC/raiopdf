//! Microsoft Word capability detection.
//!
//! This module only probes and reports capability. It does not convert Word
//! documents and does not change any PDF-only file gates.

use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

#[cfg(windows)]
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use crate::path_ops::{self, OpResult, PathOpError, PathOpsToolchain};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WordCapabilityState {
    NotApplicable,
    NotDetected,
    Detected,
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MarkupMode {
    Final,
    ShowMarkup,
}

impl MarkupMode {
    fn as_script_value(self) -> &'static str {
        match self {
            MarkupMode::Final => "final",
            MarkupMode::ShowMarkup => "showMarkup",
        }
    }
}

pub const ERR_WORD_NOT_SUPPORTED: &str = "WORD_NOT_SUPPORTED";
pub const ERR_WORD_TIMEOUT: &str = "WORD_TIMEOUT";
pub const ERR_WORD_AUTOMATION_FAILED: &str = "WORD_AUTOMATION_FAILED";
pub const ERR_WORD_PROTECTED_VIEW: &str = "WORD_PROTECTED_VIEW";
pub const ERR_WORD_PASSWORD_PROTECTED: &str = "WORD_PASSWORD_PROTECTED";
pub const ERR_WORD_REPAIR_REQUIRED: &str = "WORD_REPAIR_REQUIRED";
pub const ERR_WORD_TRUST_CENTER_BLOCKED: &str = "WORD_TRUST_CENTER_BLOCKED";
pub const ERR_WORD_ENTERPRISE_BLOCKED: &str = "WORD_ENTERPRISE_BLOCKED";
pub const ERR_WORD_FILE_LOCKED: &str = "WORD_FILE_LOCKED";
pub const ERR_WORD_EXPORT_FAILED: &str = "WORD_EXPORT_FAILED";
pub const ERR_WORD_SAVE_FAILED: &str = "WORD_SAVE_FAILED";

pub const DEFAULT_WORD_CONVERSION_TIMEOUT: Duration = Duration::from_secs(120);
const PID_PREFIX: &str = "@@RAIOPDF_WORD_PID@@";
const RESULT_PREFIX: &str = "@@RAIOPDF_WORD_RESULT@@";
#[cfg(windows)]
static WORD_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
static WORD_AUTOMATION_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WordCapability {
    pub state: WordCapabilityState,
    pub reason: Option<String>,
}

impl WordCapability {
    fn new(state: WordCapabilityState) -> Self {
        Self {
            state,
            reason: None,
        }
    }

    fn unavailable(reason: impl AsRef<str>) -> Self {
        Self {
            state: WordCapabilityState::Unavailable,
            reason: short_reason(reason.as_ref()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WordAutomationProbeWire {
    state: String,
    reason: Option<String>,
}

pub const fn platform_supported() -> bool {
    cfg!(windows)
}

pub fn parse_word_type_probe_output(stdout: &str) -> OpResult<bool> {
    Ok(!stdout.trim().is_empty())
}

pub fn parse_word_automation_probe_output(stdout: &str) -> OpResult<WordCapability> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(PathOpError {
            code: path_ops::ERR_OP_FAILED,
            message: "Word automation probe returned no output".to_string(),
        });
    }

    let wire: WordAutomationProbeWire =
        serde_json::from_str(trimmed).map_err(|error| PathOpError {
            code: path_ops::ERR_OP_FAILED,
            message: format!("Word automation probe parse error: {error}"),
        })?;

    match wire.state.as_str() {
        "available" => Ok(WordCapability::new(WordCapabilityState::Available)),
        "unavailable" => Ok(WordCapability::unavailable(
            wire.reason
                .as_deref()
                .unwrap_or("Word automation is unavailable."),
        )),
        other => Err(PathOpError {
            code: path_ops::ERR_OP_FAILED,
            message: format!("unexpected Word automation probe state: {other}"),
        }),
    }
}

#[cfg(windows)]
pub fn word_capability(force: bool) -> OpResult<WordCapability> {
    let type_output = path_ops::run_powershell(
        "[Type]::GetTypeFromProgID('Word.Application') | ForEach-Object { $_.FullName }",
    )?;
    if !parse_word_type_probe_output(&String::from_utf8_lossy(&type_output.stdout))? {
        return Ok(WordCapability::new(WordCapabilityState::NotDetected));
    }

    if !force {
        return Ok(WordCapability::new(WordCapabilityState::Detected));
    }

    let automation_output = path_ops::run_powershell(WORD_AUTOMATION_PROBE_SCRIPT)?;
    parse_word_automation_probe_output(&String::from_utf8_lossy(&automation_output.stdout))
}

#[cfg(not(windows))]
pub fn word_capability(_force: bool) -> OpResult<WordCapability> {
    Ok(WordCapability::new(WordCapabilityState::NotApplicable))
}

pub fn convert_docx_to_pdf(input: &Path, output: &Path, markup: MarkupMode) -> OpResult<()> {
    let toolchain = PathOpsToolchain::discover(None);
    convert_docx_to_pdf_with_toolchain(&toolchain, input, output, markup)
}

pub fn convert_pdf_to_docx(input: &Path, output: &Path) -> OpResult<()> {
    #[cfg(windows)]
    {
        convert_pdf_to_docx_windows(input, output, DEFAULT_WORD_CONVERSION_TIMEOUT)
    }
    #[cfg(not(windows))]
    {
        let _ = (input, output);
        Err(word_error(
            ERR_WORD_NOT_SUPPORTED,
            "Word PDF reflow is only available on Windows.",
        ))
    }
}

pub fn convert_docx_to_pdf_with_toolchain(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output: &Path,
    markup: MarkupMode,
) -> OpResult<()> {
    #[cfg(windows)]
    {
        convert_docx_to_pdf_windows(
            toolchain,
            input,
            output,
            markup,
            DEFAULT_WORD_CONVERSION_TIMEOUT,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (toolchain, input, output, markup);
        Err(word_error(
            ERR_WORD_NOT_SUPPORTED,
            "Word DOCX conversion is only available on Windows.",
        ))
    }
}

pub fn build_word_conversion_input_json(
    input: &Path,
    output: &Path,
    markup: MarkupMode,
) -> OpResult<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InputWire<'a> {
        input_path: &'a str,
        output_path: &'a str,
        markup: &'a str,
    }

    let input_path = path_to_utf8(input, "input")?;
    let output_path = path_to_utf8(output, "output")?;
    serde_json::to_string(&InputWire {
        input_path,
        output_path,
        markup: markup.as_script_value(),
    })
    .map_err(|error| word_error(path_ops::ERR_OP_FAILED, format!("Word input JSON: {error}")))
}

pub fn build_word_reflow_input_json(input: &Path, output: &Path) -> OpResult<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InputWire<'a> {
        input_path: &'a str,
        output_path: &'a str,
    }

    let input_path = path_to_utf8(input, "input")?;
    let output_path = path_to_utf8(output, "output")?;
    serde_json::to_string(&InputWire {
        input_path,
        output_path,
    })
    .map_err(|error| word_error(path_ops::ERR_OP_FAILED, format!("Word input JSON: {error}")))
}

pub fn word_powershell_args(script_path: &Path, input_json_path: &Path) -> Vec<std::ffi::OsString> {
    [
        std::ffi::OsString::from("-NoProfile"),
        std::ffi::OsString::from("-NonInteractive"),
        std::ffi::OsString::from("-ExecutionPolicy"),
        std::ffi::OsString::from("Bypass"),
        std::ffi::OsString::from("-File"),
        script_path.as_os_str().to_os_string(),
        input_json_path.as_os_str().to_os_string(),
    ]
    .into_iter()
    .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordScriptOutcome {
    pub winword_pid: Option<u32>,
    pub result: WordScriptResult,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WordScriptResult {
    Ok,
    Err { code: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeoutKillPlan {
    pub powershell_pid: u32,
    pub winword_pid: Option<u32>,
}

pub fn plan_timeout_kills(stdout: &str, powershell_pid: u32) -> TimeoutKillPlan {
    TimeoutKillPlan {
        powershell_pid,
        winword_pid: parse_winword_pid(stdout),
    }
}

pub fn parse_word_script_stdout(stdout: &str) -> OpResult<WordScriptOutcome> {
    let winword_pid = parse_winword_pid(stdout);
    let result_line = stdout
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix(RESULT_PREFIX).map(str::trim))
        .ok_or_else(|| {
            word_error(
                path_ops::ERR_OP_FAILED,
                "Word script returned no result JSON",
            )
        })?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ResultWire {
        ok: bool,
        code: Option<String>,
        message: Option<String>,
    }

    let result: ResultWire = serde_json::from_str(result_line).map_err(|error| {
        word_error(
            path_ops::ERR_OP_FAILED,
            format!("Word result JSON: {error}"),
        )
    })?;

    let result = if result.ok {
        WordScriptResult::Ok
    } else {
        WordScriptResult::Err {
            code: result
                .code
                .unwrap_or_else(|| ERR_WORD_AUTOMATION_FAILED.to_string()),
            message: result
                .message
                .unwrap_or_else(|| "Word conversion failed.".to_string()),
        }
    };

    Ok(WordScriptOutcome {
        winword_pid,
        result,
    })
}

pub fn build_word_conversion_script() -> &'static str {
    WORD_CONVERSION_SCRIPT
}

pub fn build_word_reflow_script() -> &'static str {
    WORD_REFLOW_SCRIPT
}

#[cfg(windows)]
fn convert_docx_to_pdf_windows(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output: &Path,
    markup: MarkupMode,
    timeout: Duration,
) -> OpResult<()> {
    require_docx_input(input)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("create output dir: {error}")))?;
    }

    let _automation_guard = WORD_AUTOMATION_MUTEX
        .lock()
        .map_err(|_| word_error(path_ops::ERR_IO, "Word automation mutex poisoned"))?;

    let temp_dir = WordTempDir::create("raiopdf-word-convert")?;
    let script_path = temp_dir.path().join("convert-docx.ps1");
    let input_json_path = temp_dir.path().join("input.json");
    let export_path = output.with_extension("word-export.tmp.pdf");

    fs::write(&script_path, build_word_conversion_script())
        .map_err(|error| word_error(path_ops::ERR_IO, format!("write Word script: {error}")))?;
    fs::write(
        &input_json_path,
        build_word_conversion_input_json(input, &export_path, markup)?,
    )
    .map_err(|error| word_error(path_ops::ERR_IO, format!("write Word input JSON: {error}")))?;

    let args = word_powershell_args(&script_path, &input_json_path);
    let run = match run_word_powershell(&args, timeout) {
        Ok(run) => run,
        Err(error) => {
            let _ = fs::remove_file(&export_path);
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    if run.timed_out {
        let _ = fs::remove_file(&export_path);
        let _ = fs::remove_file(output);
        return Err(word_error(
            ERR_WORD_TIMEOUT,
            format!(
                "Word conversion timed out after {} seconds.",
                timeout.as_secs()
            ),
        ));
    }
    if !run.status_success {
        let _ = fs::remove_file(&export_path);
        let _ = fs::remove_file(output);
        return Err(word_error(
            path_ops::ERR_OP_FAILED,
            format!("PowerShell exited unsuccessfully: {}", run.stderr.trim()),
        ));
    }
    let outcome = match parse_word_script_stdout(&run.stdout) {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = fs::remove_file(&export_path);
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    if let WordScriptResult::Err { code, message } = outcome.result {
        let _ = fs::remove_file(&export_path);
        let _ = fs::remove_file(output);
        return Err(word_error(word_error_code(&code), message));
    }

    if let Err(error) = scrub_word_pdf(toolchain, &export_path, output) {
        let _ = fs::remove_file(output);
        return Err(error);
    }
    let _ = fs::remove_file(&export_path);
    require_nonempty_pdf(output)?;
    Ok(())
}

#[cfg(windows)]
fn convert_pdf_to_docx_windows(input: &Path, output: &Path, timeout: Duration) -> OpResult<()> {
    require_pdf_input(input)?;
    require_docx_output(output)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("create output dir: {error}")))?;
    }

    let _automation_guard = WORD_AUTOMATION_MUTEX
        .lock()
        .map_err(|_| word_error(path_ops::ERR_IO, "Word automation mutex poisoned"))?;

    let temp_dir = WordTempDir::create("raiopdf-word-reflow")?;
    let script_path = temp_dir.path().join("reflow-pdf.ps1");
    let input_json_path = temp_dir.path().join("input.json");

    fs::write(&script_path, build_word_reflow_script())
        .map_err(|error| word_error(path_ops::ERR_IO, format!("write Word script: {error}")))?;
    fs::write(
        &input_json_path,
        build_word_reflow_input_json(input, output)?,
    )
    .map_err(|error| word_error(path_ops::ERR_IO, format!("write Word input JSON: {error}")))?;

    let args = word_powershell_args(&script_path, &input_json_path);
    let run = match run_word_powershell(&args, timeout) {
        Ok(run) => run,
        Err(error) => {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    if run.timed_out {
        let _ = fs::remove_file(output);
        return Err(word_error(
            ERR_WORD_TIMEOUT,
            format!(
                "Word PDF reflow timed out after {} seconds.",
                timeout.as_secs()
            ),
        ));
    }
    if !run.status_success {
        let _ = fs::remove_file(output);
        return Err(word_error(
            path_ops::ERR_OP_FAILED,
            format!("PowerShell exited unsuccessfully: {}", run.stderr.trim()),
        ));
    }
    let outcome = match parse_word_script_stdout(&run.stdout) {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    if let WordScriptResult::Err { code, message } = outcome.result {
        let _ = fs::remove_file(output);
        return Err(word_error(word_error_code(&code), message));
    }

    require_nonempty_docx(output)?;
    Ok(())
}

fn short_reason(reason: &str) -> Option<String> {
    let compact = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    Some(compact.chars().take(180).collect())
}

#[cfg(windows)]
const WORD_AUTOMATION_PROBE_SCRIPT: &str = r#"
$word = $null
$result = $null
try {
  $word = New-Object -ComObject Word.Application -ErrorAction Stop
  if ($null -eq $word) {
    $result = @{ state = 'unavailable'; reason = 'Word did not start.' }
  } else {
    $null = $word.Application.Name
    $result = @{ state = 'available' }
  }
} catch {
  $reason = $_.Exception.Message
  if ([string]::IsNullOrWhiteSpace($reason)) {
    $reason = 'Word automation failed.'
  }
  $result = @{ state = 'unavailable'; reason = $reason }
} finally {
  if ($null -ne $word) {
    try { $word.Quit() | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null } catch {}
  }
}
$result | ConvertTo-Json -Compress
"#;

fn parse_winword_pid(stdout: &str) -> Option<u32> {
    stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix(PID_PREFIX)
            .and_then(|value| value.trim().parse::<u32>().ok())
    })
}

fn path_to_utf8<'a>(path: &'a Path, label: &str) -> OpResult<&'a str> {
    path.to_str().ok_or_else(|| {
        word_error(
            path_ops::ERR_INVALID_INPUT,
            format!("Word {label} path is not valid UTF-8"),
        )
    })
}

fn word_error(code: &'static str, message: impl Into<String>) -> PathOpError {
    PathOpError {
        code,
        message: message.into(),
    }
}

#[cfg(windows)]
fn word_error_code(code: &str) -> &'static str {
    match code {
        ERR_WORD_PROTECTED_VIEW => ERR_WORD_PROTECTED_VIEW,
        ERR_WORD_PASSWORD_PROTECTED => ERR_WORD_PASSWORD_PROTECTED,
        ERR_WORD_REPAIR_REQUIRED => ERR_WORD_REPAIR_REQUIRED,
        ERR_WORD_TRUST_CENTER_BLOCKED => ERR_WORD_TRUST_CENTER_BLOCKED,
        ERR_WORD_ENTERPRISE_BLOCKED => ERR_WORD_ENTERPRISE_BLOCKED,
        ERR_WORD_FILE_LOCKED => ERR_WORD_FILE_LOCKED,
        ERR_WORD_EXPORT_FAILED => ERR_WORD_EXPORT_FAILED,
        ERR_WORD_SAVE_FAILED => ERR_WORD_SAVE_FAILED,
        ERR_WORD_AUTOMATION_FAILED => ERR_WORD_AUTOMATION_FAILED,
        ERR_WORD_TIMEOUT => ERR_WORD_TIMEOUT,
        _ => ERR_WORD_AUTOMATION_FAILED,
    }
}

#[cfg(windows)]
fn require_docx_input(input: &Path) -> OpResult<()> {
    let metadata = fs::metadata(input)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("stat DOCX input: {error}")))?;
    if !metadata.is_file() {
        return Err(word_error(
            path_ops::ERR_INVALID_INPUT,
            "DOCX input is not a file.",
        ));
    }
    if input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("docx"))
        .unwrap_or(true)
    {
        return Err(word_error(
            path_ops::ERR_INVALID_INPUT,
            "Word conversion requires a .docx input.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn require_pdf_input(input: &Path) -> OpResult<()> {
    let metadata = fs::metadata(input)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("stat PDF input: {error}")))?;
    if !metadata.is_file() {
        return Err(word_error(
            path_ops::ERR_INVALID_INPUT,
            "PDF input is not a file.",
        ));
    }
    if input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("pdf"))
        .unwrap_or(true)
    {
        return Err(word_error(
            path_ops::ERR_INVALID_INPUT,
            "Word reflow requires a .pdf input.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn require_docx_output(output: &Path) -> OpResult<()> {
    if output
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("docx"))
        .unwrap_or(true)
    {
        return Err(word_error(
            path_ops::ERR_INVALID_INPUT,
            "Word reflow requires a .docx output.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn scrub_word_pdf(toolchain: &PathOpsToolchain, input: &Path, output: &Path) -> OpResult<()> {
    path_ops::scrub_metadata(toolchain, input, output)
}

#[cfg(windows)]
fn require_nonempty_pdf(path: &Path) -> OpResult<()> {
    let bytes = fs::read(path)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("read converted PDF: {error}")))?;
    if bytes.len() < 5 || !bytes.starts_with(b"%PDF") {
        return Err(word_error(
            path_ops::ERR_OP_FAILED,
            "Word conversion did not produce a valid PDF.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn require_nonempty_docx(path: &Path) -> OpResult<()> {
    let metadata = fs::metadata(path)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("stat converted DOCX: {error}")))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(word_error(
            path_ops::ERR_OP_FAILED,
            "Word reflow did not produce a non-empty DOCX.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Debug)]
struct WordRunOutput {
    status_success: bool,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

#[cfg(windows)]
fn run_word_powershell(args: &[std::ffi::OsString], timeout: Duration) -> OpResult<WordRunOutput> {
    use std::{
        process::{Command, Stdio},
        sync::{Arc, Mutex},
        thread,
        time::Instant,
    };

    let mut command = Command::new("powershell.exe");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::apply_platform_spawn_flags(&mut command);

    let mut child = command.spawn().map_err(|error| {
        word_error(
            path_ops::ERR_OP_FAILED,
            format!("PowerShell spawn: {error}"),
        )
    })?;
    let powershell_pid = child.id();

    let stdout = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stdout_thread = child
        .stdout
        .take()
        .map(|reader| drain_child_output(reader, Arc::clone(&stdout)));
    let stderr_thread = child
        .stderr
        .take()
        .map(|reader| drain_child_output(reader, Arc::clone(&stderr)));

    let started = Instant::now();
    let (status_success, timed_out) = loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            word_error(path_ops::ERR_OP_FAILED, format!("PowerShell wait: {error}"))
        })? {
            break (status.success(), false);
        }
        if started.elapsed() >= timeout {
            let stdout_so_far = locked_output_string(&stdout);
            let kill_plan = plan_timeout_kills(&stdout_so_far, powershell_pid);
            if let Some(winword_pid) = kill_plan.winword_pid {
                kill_pid(winword_pid);
            }
            let _ = child.kill();
            let _ = child.wait();
            break (false, true);
        }
        thread::sleep(Duration::from_millis(50));
    };

    if let Some(thread) = stdout_thread {
        let _ = thread.join();
    }
    if let Some(thread) = stderr_thread {
        let _ = thread.join();
    }

    Ok(WordRunOutput {
        status_success,
        stdout: locked_output_string(&stdout),
        stderr: locked_output_string(&stderr),
        timed_out,
    })
}

#[cfg(windows)]
fn drain_child_output<R: std::io::Read + Send + 'static>(
    mut reader: R,
    sink: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if let Ok(mut output) = sink.lock() {
                        output.extend_from_slice(&buffer[..count]);
                    }
                }
            }
        }
    })
}

#[cfg(windows)]
fn locked_output_string(output: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>) -> String {
    output
        .lock()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::process::{Command, Stdio};

    let mut command = Command::new("taskkill.exe");
    command
        .args(["/PID", &pid.to_string(), "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::apply_platform_spawn_flags(&mut command);
    let _ = command.status();
}

#[cfg(windows)]
struct WordTempDir {
    path: PathBuf,
}

#[cfg(windows)]
impl WordTempDir {
    fn create(prefix: &str) -> OpResult<Self> {
        let sequence = WORD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("create temp dir: {error}")))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(windows)]
impl Drop for WordTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

const WORD_CONVERSION_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputJsonPath = $args[0]

function Convert-RaioWordErrorCode([string] $message) {
  $lower = $message.ToLowerInvariant()
  if ($lower.Contains('protected view')) { return 'WORD_PROTECTED_VIEW' }
  if ($lower.Contains('password') -or $lower.Contains('encrypted')) { return 'WORD_PASSWORD_PROTECTED' }
  if ($lower.Contains('repair') -or $lower.Contains('corrupt') -or $lower.Contains('damaged')) { return 'WORD_REPAIR_REQUIRED' }
  if ($lower.Contains('trust center') -or $lower.Contains('file block')) { return 'WORD_TRUST_CENTER_BLOCKED' }
  if ($lower.Contains('policy') -or $lower.Contains('administrator') -or $lower.Contains('blocked')) { return 'WORD_ENTERPRISE_BLOCKED' }
  if ($lower.Contains('locked') -or $lower.Contains('permission') -or $lower.Contains('in use')) { return 'WORD_FILE_LOCKED' }
  if ($lower.Contains('export') -or $lower.Contains('fixedformat')) { return 'WORD_EXPORT_FAILED' }
  return 'WORD_AUTOMATION_FAILED'
}

function Write-RaioResult([bool] $ok, [string] $code, [string] $message, $winwordPid) {
  $result = @{
    ok = $ok
    code = $code
    message = $message
    winwordPid = $winwordPid
  }
  Write-Output ('@@RAIOPDF_WORD_RESULT@@ ' + ($result | ConvertTo-Json -Compress))
}

$word = $null
$doc = $null
$winwordPid = $null
$ok = $false
$code = $null
$message = $null

try {
  $input = Get-Content -LiteralPath $inputJsonPath -Raw | ConvertFrom-Json
  $inputPath = [string] $input.inputPath
  $outputPath = [string] $input.outputPath
  $markup = [string] $input.markup

  $before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $word = New-Object -ComObject Word.Application -ErrorAction Stop
  $after = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $newPid = $after | Where-Object { $before -notcontains $_ } | Select-Object -First 1
  if ($null -ne $newPid) {
    $winwordPid = [int] $newPid
    Write-Output ('@@RAIOPDF_WORD_PID@@ ' + $winwordPid)
  }

  $word.AutomationSecurity = 3
  $word.Visible = $false
  $word.DisplayAlerts = 0

  $doc = $word.Documents.Open($inputPath, $false, $true, $false)
  if ($markup -eq 'showMarkup') {
    $doc.ShowRevisions = $true
    try { $word.ActiveWindow.View.ShowRevisionsAndComments = $true } catch {}
    try { $word.ActiveWindow.View.ShowComments = $true } catch {}
    $exportItem = 7
  } else {
    $doc.ShowRevisions = $false
    try { $word.ActiveWindow.View.ShowRevisionsAndComments = $false } catch {}
    try { $word.ActiveWindow.View.ShowComments = $false } catch {}
    $exportItem = 0
  }

  $doc.ExportAsFixedFormat($outputPath, 17, $false, 0, 0, 1, 1, $exportItem, $true, $true, 1, $true, $true, $false)
  $ok = $true
} catch {
  $message = $_.Exception.Message
  if ([string]::IsNullOrWhiteSpace($message)) {
    $message = 'Word conversion failed.'
  }
  $code = Convert-RaioWordErrorCode $message
} finally {
  if ($null -ne $doc) {
    try { $doc.Close($false) | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) | Out-Null } catch {}
  }
  if ($null -ne $word) {
    try { $word.Quit() | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  Write-RaioResult $ok $code $message $winwordPid
}
"#;

const WORD_REFLOW_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputJsonPath = $args[0]

function Convert-RaioWordErrorCode([string] $message) {
  $lower = $message.ToLowerInvariant()
  if ($lower.Contains('protected view')) { return 'WORD_PROTECTED_VIEW' }
  if ($lower.Contains('password') -or $lower.Contains('encrypted')) { return 'WORD_PASSWORD_PROTECTED' }
  if ($lower.Contains('repair') -or $lower.Contains('corrupt') -or $lower.Contains('damaged')) { return 'WORD_REPAIR_REQUIRED' }
  if ($lower.Contains('trust center') -or $lower.Contains('file block')) { return 'WORD_TRUST_CENTER_BLOCKED' }
  if ($lower.Contains('policy') -or $lower.Contains('administrator') -or $lower.Contains('blocked')) { return 'WORD_ENTERPRISE_BLOCKED' }
  if ($lower.Contains('locked') -or $lower.Contains('permission') -or $lower.Contains('in use')) { return 'WORD_FILE_LOCKED' }
  if ($lower.Contains('save') -or $lower.Contains('saveas')) { return 'WORD_SAVE_FAILED' }
  return 'WORD_AUTOMATION_FAILED'
}

function Write-RaioResult([bool] $ok, [string] $code, [string] $message, $winwordPid) {
  $result = @{
    ok = $ok
    code = $code
    message = $message
    winwordPid = $winwordPid
  }
  Write-Output ('@@RAIOPDF_WORD_RESULT@@ ' + ($result | ConvertTo-Json -Compress))
}

$word = $null
$doc = $null
$winwordPid = $null
$ok = $false
$code = $null
$message = $null

try {
  $input = Get-Content -LiteralPath $inputJsonPath -Raw | ConvertFrom-Json
  $inputPath = [string] $input.inputPath
  $outputPath = [string] $input.outputPath

  $before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $word = New-Object -ComObject Word.Application -ErrorAction Stop
  $after = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $newPid = $after | Where-Object { $before -notcontains $_ } | Select-Object -First 1
  if ($null -ne $newPid) {
    $winwordPid = [int] $newPid
    Write-Output ('@@RAIOPDF_WORD_PID@@ ' + $winwordPid)
  }

  $word.AutomationSecurity = 3
  $word.Visible = $false
  $word.DisplayAlerts = 0

  $doc = $word.Documents.Open($inputPath, $false, $true, $false)
  $doc.SaveAs2($outputPath, 16)
  $ok = $true
} catch {
  $message = $_.Exception.Message
  if ([string]::IsNullOrWhiteSpace($message)) {
    $message = 'Word PDF reflow failed.'
  }
  $code = Convert-RaioWordErrorCode $message
} finally {
  if ($null -ne $doc) {
    try { $doc.Close($false) | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) | Out-Null } catch {}
  }
  if ($null -ne $word) {
    try { $word.Quit() | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  Write-RaioResult $ok $code $message $winwordPid
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_type_probe_as_absent() {
        assert!(!parse_word_type_probe_output("").unwrap());
        assert!(!parse_word_type_probe_output(" \r\n").unwrap());
    }

    #[test]
    fn parses_non_empty_type_probe_as_registered() {
        assert!(parse_word_type_probe_output("System.__ComObject\r\n").unwrap());
        assert!(
            parse_word_type_probe_output("Microsoft.Office.Interop.Word.ApplicationClass").unwrap()
        );
    }

    #[test]
    fn parses_available_automation_probe() {
        let capability = parse_word_automation_probe_output(r#"{"state":"available"}"#).unwrap();
        assert_eq!(
            capability,
            WordCapability::new(WordCapabilityState::Available)
        );
    }

    #[test]
    fn parses_unavailable_automation_probe_with_short_reason() {
        let capability = parse_word_automation_probe_output(
            r#"{"state":"unavailable","reason":"  COM registration exists, but Word could not start.  "}"#,
        )
        .unwrap();
        assert_eq!(capability.state, WordCapabilityState::Unavailable);
        assert_eq!(
            capability.reason.as_deref(),
            Some("COM registration exists, but Word could not start.")
        );
    }

    #[test]
    fn malformed_automation_probe_is_typed_error() {
        assert!(parse_word_automation_probe_output("").is_err());
        assert!(parse_word_automation_probe_output("not json").is_err());
        assert!(parse_word_automation_probe_output(r#"{"state":"maybe"}"#).is_err());
    }

    #[test]
    fn builds_json_input_without_shell_quoting_paths() {
        let json = build_word_conversion_input_json(
            Path::new(r"C:\cases\input doc.docx"),
            Path::new(r"C:\cases\out doc.pdf"),
            MarkupMode::ShowMarkup,
        )
        .unwrap();
        assert_eq!(
            json,
            r#"{"inputPath":"C:\\cases\\input doc.docx","outputPath":"C:\\cases\\out doc.pdf","markup":"showMarkup"}"#
        );
    }

    #[test]
    fn builds_reflow_json_input_without_shell_quoting_paths() {
        let json = build_word_reflow_input_json(
            Path::new(r"C:\cases\input scan.pdf"),
            Path::new(r"C:\cases\out editable.docx"),
        )
        .unwrap();
        assert_eq!(
            json,
            r#"{"inputPath":"C:\\cases\\input scan.pdf","outputPath":"C:\\cases\\out editable.docx"}"#
        );
    }

    #[test]
    fn powershell_args_use_file_and_json_argument() {
        let args = word_powershell_args(
            Path::new(r"C:\temp\convert.ps1"),
            Path::new(r"C:\temp\input.json"),
        );
        let rendered: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            rendered,
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                r"C:\temp\convert.ps1",
                r"C:\temp\input.json",
            ]
        );
        assert!(!rendered.iter().any(|arg| arg == "-Command"));
    }

    #[test]
    fn parses_pid_and_success_result_from_script_stdout() {
        let stdout = concat!(
            "@@RAIOPDF_WORD_PID@@ 4242\r\n",
            "@@RAIOPDF_WORD_RESULT@@ {\"ok\":true,\"code\":null,\"message\":null}\r\n"
        );
        assert_eq!(
            parse_word_script_stdout(stdout).unwrap(),
            WordScriptOutcome {
                winword_pid: Some(4242),
                result: WordScriptResult::Ok,
            }
        );
    }

    #[test]
    fn parses_structured_word_error_from_script_stdout() {
        let stdout = concat!(
            "@@RAIOPDF_WORD_PID@@ 100\r\n",
            "@@RAIOPDF_WORD_RESULT@@ {\"ok\":false,\"code\":\"WORD_PASSWORD_PROTECTED\",\"message\":\"Password required.\"}\r\n"
        );
        assert_eq!(
            parse_word_script_stdout(stdout).unwrap().result,
            WordScriptResult::Err {
                code: ERR_WORD_PASSWORD_PROTECTED.to_string(),
                message: "Password required.".to_string(),
            }
        );
    }

    #[test]
    fn malformed_script_stdout_is_typed_error() {
        assert!(parse_word_script_stdout("").is_err());
        assert!(parse_word_script_stdout("@@RAIOPDF_WORD_RESULT@@ nope").is_err());
    }

    #[test]
    fn timeout_kill_plan_uses_only_attributable_pid() {
        let plan = plan_timeout_kills("@@RAIOPDF_WORD_PID@@ 5150\nnoise", 2400);
        assert_eq!(
            plan,
            TimeoutKillPlan {
                powershell_pid: 2400,
                winword_pid: Some(5150),
            }
        );

        let plan = plan_timeout_kills("no pid yet", 2400);
        assert_eq!(
            plan,
            TimeoutKillPlan {
                powershell_pid: 2400,
                winword_pid: None,
            }
        );
    }

    #[test]
    fn conversion_script_contains_required_safety_contract() {
        let script = build_word_conversion_script();
        assert!(script.contains("$word.AutomationSecurity = 3"));
        assert!(script.contains("$word.Visible = $false"));
        assert!(script.contains("$word.DisplayAlerts = 0"));
        assert!(script.contains("$doc.Close($false)"));
        assert!(script.contains("$word.Quit()"));
        assert!(script.contains("@@RAIOPDF_WORD_PID@@"));
        assert!(script.contains("@@RAIOPDF_WORD_RESULT@@"));
    }

    #[test]
    fn reflow_script_contains_required_safety_contract() {
        let script = build_word_reflow_script();
        assert!(script.contains("$word.AutomationSecurity = 3"));
        assert!(script.contains("$word.Visible = $false"));
        assert!(script.contains("$word.DisplayAlerts = 0"));
        assert!(script.contains("$word.Documents.Open($inputPath, $false, $true, $false)"));
        assert!(script.contains("$doc.SaveAs2($outputPath, 16)"));
        assert!(!script.contains("ExportAsFixedFormat"));
        assert!(!script.contains("SaveAs2($outputPath, 17)"));
        assert!(script.contains("$doc.Close($false)"));
        assert!(script.contains("$word.Quit()"));
        assert!(script.contains("@@RAIOPDF_WORD_PID@@"));
        assert!(script.contains("@@RAIOPDF_WORD_RESULT@@"));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_probe_is_not_applicable() {
        assert!(!platform_supported());
        assert_eq!(
            word_capability(false).unwrap(),
            WordCapability::new(WordCapabilityState::NotApplicable)
        );
        assert_eq!(
            word_capability(true).unwrap(),
            WordCapability::new(WordCapabilityState::NotApplicable)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_conversion_is_unsupported() {
        let error = convert_docx_to_pdf(
            Path::new("input.docx"),
            Path::new("output.pdf"),
            MarkupMode::Final,
        )
        .unwrap_err();
        assert_eq!(error.code, ERR_WORD_NOT_SUPPORTED);

        let error =
            convert_pdf_to_docx(Path::new("input.pdf"), Path::new("output.docx")).unwrap_err();
        assert_eq!(error.code, ERR_WORD_NOT_SUPPORTED);
    }

    #[cfg(windows)]
    #[test]
    fn word_conversion_canary_self_gates_on_word_capability() {
        use std::fs;

        let capability = word_capability(true).expect("Word capability probe should run");
        if capability.state != WordCapabilityState::Available {
            eprintln!(
                "skipping Word conversion canary: {:?} {:?}",
                capability.state, capability.reason
            );
            return;
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        let temp = std::env::temp_dir().join(format!("raiopdf-word-canary-{}", std::process::id()));
        fs::create_dir_all(&temp).expect("canary temp dir");
        let clean_pdf = temp.join("clean.pdf");
        convert_docx_to_pdf(&root.join("clean.docx"), &clean_pdf, MarkupMode::Final)
            .expect("clean DOCX converts");
        let clean_bytes = fs::read(&clean_pdf).expect("read clean pdf");
        assert!(clean_bytes.len() > 5);
        assert!(clean_bytes.starts_with(b"%PDF"));

        let final_pdf = temp.join("tracked-final.pdf");
        let markup_pdf = temp.join("tracked-markup.pdf");
        convert_docx_to_pdf(
            &root.join("tracked-changes.docx"),
            &final_pdf,
            MarkupMode::Final,
        )
        .expect("tracked final converts");
        convert_docx_to_pdf(
            &root.join("tracked-changes.docx"),
            &markup_pdf,
            MarkupMode::ShowMarkup,
        )
        .expect("tracked markup converts");
        assert_ne!(
            fs::read(final_pdf).expect("read final pdf"),
            fs::read(markup_pdf).expect("read markup pdf")
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(windows)]
    #[test]
    fn word_pdf_reflow_canary_self_gates_on_word_capability() {
        let capability = word_capability(true).expect("Word capability probe should run");
        if capability.state != WordCapabilityState::Available {
            eprintln!(
                "skipping Word PDF reflow canary: {:?} {:?}",
                capability.state, capability.reason
            );
            return;
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        let temp =
            std::env::temp_dir().join(format!("raiopdf-word-reflow-canary-{}", std::process::id()));
        fs::create_dir_all(&temp).expect("canary temp dir");
        let output = temp.join("text-layer.docx");
        convert_pdf_to_docx(&root.join("text-layer.pdf"), &output).expect("PDF reflows to DOCX");

        let bytes = fs::metadata(&output).expect("stat reflow docx").len();
        assert!(bytes > 0);
        let file = fs::File::open(&output).expect("open reflow docx");
        let mut archive = zip::ZipArchive::new(file).expect("reflow output is a zip");
        archive
            .by_name("word/document.xml")
            .expect("reflow output contains word/document.xml");
        let _ = fs::remove_dir_all(temp);
    }
}
