//! Microsoft Word capability detection.
//!
//! This module only probes and reports capability. It does not convert Word
//! documents and does not change any PDF-only file gates.

use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

#[cfg(any(windows, target_os = "macos"))]
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicBool;

#[cfg(any(windows, target_os = "macos"))]
use std::sync::Mutex;

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

/// Current macOS Automation consent for RaioPDF -> Microsoft Word. The shell
/// obtains this natively from the RaioPDF process; core keeps it in the IPC
/// wire shape so the UI can distinguish a first-use prompt from a denial.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WordAutomationAuthorization {
    Authorized,
    Denied,
    Undetermined,
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
/// macOS Word cannot silently read the private conversion copy. This is
/// distinct from a user-selected source file permission: RaioPDF never hands
/// the original to Word, so asking the user to locate a private temp file is
/// neither safe nor actionable.
pub const ERR_WORD_STAGING_UNAVAILABLE: &str = "WORD_STAGING_UNAVAILABLE";
/// macOS denied this app permission to send Apple Events to Microsoft Word.
/// Retrying does not re-prompt; the user must change the Automation setting.
pub const ERR_WORD_AUTOMATION_DENIED: &str = "WORD_AUTOMATION_DENIED";

pub const DEFAULT_WORD_CONVERSION_TIMEOUT: Duration = Duration::from_secs(120);
/// Consent time is excluded before this timer starts. A representative
/// 120-page legal-code PDF completes with more than a 3x margin on maintainer
/// hardware; keep the blueprint's explicit two-minute conversion deadline.
#[cfg(target_os = "macos")]
pub const MACOS_WORD_CONVERSION_TIMEOUT: Duration = Duration::from_secs(120);
const PID_PREFIX: &str = "@@RAIOPDF_WORD_PID@@";
const RESULT_PREFIX: &str = "@@RAIOPDF_WORD_RESULT@@";
#[cfg(target_os = "macos")]
const MACOS_LAUNCHED_PREFIX: &str = "@@RAIOPDF_WORD_LAUNCHED@@";
#[cfg(any(windows, target_os = "macos"))]
static WORD_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(any(windows, target_os = "macos"))]
static WORD_AUTOMATION_MUTEX: Mutex<()> = Mutex::new(());
#[cfg(target_os = "macos")]
static MACOS_WORD_AUTOMATION_UNCERTAIN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
const MACOS_WORD_BUNDLE_ID: &str = "com.microsoft.Word";
#[cfg(target_os = "macos")]
const MACOS_WORD_APP_PATH: &str = "/Applications/Microsoft Word.app";
#[cfg(target_os = "macos")]
const MACOS_WORD_UNCERTAIN_MARKER: &str = ".raiopdf-word-automation-uncertain";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WordCapability {
    pub state: WordCapabilityState,
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_authorization: Option<WordAutomationAuthorization>,
}

impl WordCapability {
    fn new(state: WordCapabilityState) -> Self {
        Self {
            state,
            reason: None,
            automation_authorization: None,
        }
    }

    pub fn unavailable(reason: impl AsRef<str>) -> Self {
        Self {
            state: WordCapabilityState::Unavailable,
            reason: short_reason(reason.as_ref()),
            automation_authorization: None,
        }
    }

    pub fn with_automation_authorization(
        mut self,
        authorization: WordAutomationAuthorization,
    ) -> Self {
        self.automation_authorization = Some(authorization);
        self
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WordAutomationProbeWire {
    state: String,
    reason: Option<String>,
}

pub const fn platform_supported() -> bool {
    cfg!(any(windows, target_os = "macos"))
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

/// Check the selected Word bundle without launching it. This deliberately does
/// not send an Apple Event: the first conversion, rather than a settings probe,
/// owns the one-time Automation consent prompt.
#[cfg(target_os = "macos")]
pub fn word_capability(_force: bool) -> OpResult<WordCapability> {
    let target = match resolve_macos_word_target() {
        Ok(Some(target)) => target,
        Ok(None) => return Ok(WordCapability::new(WordCapabilityState::NotDetected)),
        Err(error) => return Ok(WordCapability::unavailable(error.message)),
    };

    match read_macos_word_version(&target.bundle_path) {
        Ok(version) if macos_word_version_supported(&version) => {
            // "available" means a conversion may be attempted. TCC and license
            // are intentionally checked by that conversion, without cold-launching
            // Word merely to populate this status.
            Ok(WordCapability::new(WordCapabilityState::Available))
        }
        Ok(version) => Ok(WordCapability::unavailable(format!(
            "Microsoft Word {version} is too old for this integration."
        ))),
        Err(error) => Ok(WordCapability::unavailable(format!(
            "Microsoft Word was found, but its version could not be read: {}",
            error.message
        ))),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        convert_pdf_to_docx_macos(input, output, MACOS_WORD_CONVERSION_TIMEOUT)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        convert_docx_to_pdf_macos(
            toolchain,
            input,
            output,
            markup,
            MACOS_WORD_CONVERSION_TIMEOUT,
        )
    }
    #[cfg(not(any(windows, target_os = "macos")))]
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

/// Batch conversion tells the JXA helper to leave Word running between private
/// document conversions. The enclosing `MacosWordConversionSession` owns the
/// one final quit decision.
#[cfg(target_os = "macos")]
fn build_macos_batch_word_conversion_input_json(
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
        keep_word_running: bool,
    }

    let input_path = path_to_utf8(input, "input")?;
    let output_path = path_to_utf8(output, "output")?;
    serde_json::to_string(&InputWire {
        input_path,
        output_path,
        markup: markup.as_script_value(),
        keep_word_running: true,
    })
    .map_err(|error| word_error(path_ops::ERR_OP_FAILED, format!("Word input JSON: {error}")))
}

/// macOS-only request data. JXA targets the bundle id, which LaunchServices
/// resolves to the same registered default selected for capability detection.
#[cfg(target_os = "macos")]
fn build_macos_word_conversion_input_json(
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

#[cfg(target_os = "macos")]
fn build_macos_word_reflow_input_json(input: &Path, output: &Path) -> OpResult<String> {
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
    /// Fallback for when the `@@RAIOPDF_WORD_PID@@` marker never arrived
    /// (Word hung at COM instance creation, before the script could print
    /// it): WINWORD pids that appeared during the conversion window and have
    /// no visible window. Empty whenever the marker pid is known.
    pub fallback_winword_pids: Vec<u32>,
}

/// One row of the WINWORD process table used for the marker-less timeout
/// fallback. `has_visible_window` distinguishes a user's own Word (which has
/// a titled top-level window) from a hidden DCOM-spawned automation instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WinwordProcess {
    pub pid: u32,
    pub has_visible_window: bool,
}

/// Decide what to kill after a Word-automation timeout.
///
/// The primary path is the pid marker the script prints as soon as it can
/// attribute the WINWORD it spawned — that pid is killed unconditionally.
/// When the marker is absent (Word wedged inside `New-Object -ComObject`,
/// before the marker line), the DCOM-spawned WINWORD is not a child of
/// PowerShell and would survive the PowerShell kill invisibly, holding the
/// input document locked. The fallback kills only pids that are BOTH:
///
/// 1. new — present in the post-timeout snapshot but not the pre-spawn one
///    (a pre-existing pid can only be an instance we didn't start), AND
/// 2. windowless — no visible window title, the signature of a hidden
///    automation instance (a Word the user launched has a titled window).
///
/// Residual risk, accepted: a *different* automation tool's hidden Word
/// instance started during our conversion window would match both filters
/// and be killed. The window is seconds long and hidden instances are
/// transient by nature, so this beats the alternative (an orphaned WINWORD
/// holding the user's document locked indefinitely).
pub fn plan_timeout_kills(
    stdout: &str,
    powershell_pid: u32,
    winword_pids_before: &[u32],
    winword_after: &[WinwordProcess],
) -> TimeoutKillPlan {
    let winword_pid = parse_winword_pid(stdout);
    let fallback_winword_pids = if winword_pid.is_some() {
        Vec::new()
    } else {
        winword_after
            .iter()
            .filter(|process| {
                !winword_pids_before.contains(&process.pid) && !process.has_visible_window
            })
            .map(|process| process.pid)
            .collect()
    };

    TimeoutKillPlan {
        powershell_pid,
        winword_pid,
        fallback_winword_pids,
    }
}

/// Parse `tasklist /v /fo csv /nh` output into WINWORD rows. The verbose CSV
/// row is: Image Name, PID, Session Name, Session#, Mem Usage, Status, User
/// Name, CPU Time, Window Title — quoted fields, and Mem Usage contains a
/// comma ("50,000 K"), so this walks quotes rather than splitting on commas.
/// A hidden automation instance reports the literal window title "N/A".
/// Non-CSV lines (e.g. tasklist's "INFO: No tasks..." message) are skipped.
pub fn parse_tasklist_verbose_csv(output: &str) -> Vec<WinwordProcess> {
    output
        .lines()
        .filter_map(|line| {
            let fields = parse_csv_line(line.trim())?;
            if fields.len() < 9 {
                return None;
            }
            let pid = fields[1].parse::<u32>().ok()?;
            let title = fields[8].trim();
            Some(WinwordProcess {
                pid,
                has_visible_window: !title.is_empty() && title != "N/A",
            })
        })
        .collect()
}

/// Minimal CSV field parser for tasklist output: fields are always quoted;
/// commas inside quotes are literal. Returns `None` for non-CSV lines.
fn parse_csv_line(line: &str) -> Option<Vec<String>> {
    if !line.starts_with('"') {
        return None;
    }
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in line.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => fields.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    fields.push(current);
    Some(fields)
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
    #[cfg(target_os = "macos")]
    {
        MACOS_WORD_CONVERSION_SCRIPT
    }
    #[cfg(not(target_os = "macos"))]
    {
        WORD_CONVERSION_SCRIPT
    }
}

pub fn build_word_reflow_script() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        MACOS_WORD_REFLOW_SCRIPT
    }
    #[cfg(not(target_os = "macos"))]
    {
        WORD_REFLOW_SCRIPT
    }
}

/// argv for JXA. User-controlled paths stay in an input JSON file and are never
/// interpolated into the script source or shell command line.
#[cfg(target_os = "macos")]
pub fn word_osascript_args(script_path: &Path, input_json_path: &Path) -> Vec<std::ffi::OsString> {
    [
        std::ffi::OsString::from("-l"),
        std::ffi::OsString::from("JavaScript"),
        script_path.as_os_str().to_os_string(),
        input_json_path.as_os_str().to_os_string(),
    ]
    .into_iter()
    .collect()
}

#[cfg(target_os = "macos")]
fn read_macos_word_version(bundle: &Path) -> OpResult<String> {
    use std::process::{Command, Stdio};

    let info_plist = bundle.join("Contents/Info.plist");
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
        .arg(&info_plist)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            word_error(
                path_ops::ERR_IO,
                format!("read Word bundle version: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(word_error(
            path_ops::ERR_OP_FAILED,
            "could not read Microsoft Word bundle version",
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return Err(word_error(
            path_ops::ERR_OP_FAILED,
            "Microsoft Word bundle has no version",
        ));
    }
    Ok(version)
}

/// The exact Word installation selected for this operation.
///
/// A running Word instance is authoritative because bundle-id Apple Events
/// attach to it. Otherwise LaunchServices' registered default is authoritative;
/// the conventional `/Applications` location is only a compatibility fallback.
#[cfg(target_os = "macos")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct MacosWordTarget {
    bundle_path: PathBuf,
    staging_root: PathBuf,
}

#[cfg(target_os = "macos")]
fn resolve_macos_word_target() -> OpResult<Option<MacosWordTarget>> {
    let bundle_path = macos_selected_word_bundle();
    let Some(bundle_path) = bundle_path else {
        return Ok(None);
    };
    if !bundle_path.is_dir() {
        return Ok(None);
    }
    let staging_root = macos_word_staging_root_for_bundle(&bundle_path)?;
    Ok(Some(MacosWordTarget {
        bundle_path,
        staging_root,
    }))
}

/// Return the exact LaunchServices-selected Word bundle without launching it.
/// Shell-level TCC preflight uses this only after a user starts conversion, to
/// bring a cold Word target online before asking the native Apple Events API.
#[cfg(target_os = "macos")]
pub fn macos_selected_word_bundle() -> Option<PathBuf> {
    select_macos_word_bundle(
        macos_word_bundle_from_running_application(),
        macos_word_bundle_from_launch_services(),
    )
}

/// Prefer the oldest running Word instance, matching bundle-id Apple Event
/// attachment. If Word is cold, use LaunchServices' registered default. The
/// explicit ordering makes multiple-install behavior deterministic.
#[cfg(target_os = "macos")]
fn select_macos_word_bundle(
    running_word: Option<PathBuf>,
    launch_services_default: Option<PathBuf>,
) -> Option<PathBuf> {
    running_word
        .filter(|path| path.is_dir())
        .or_else(|| launch_services_default.filter(|path| path.is_dir()))
        .filter(|path| path.is_dir())
        .or_else(|| {
            let fallback = PathBuf::from(MACOS_WORD_APP_PATH);
            fallback.is_dir().then_some(fallback)
        })
}

#[cfg(target_os = "macos")]
fn macos_word_bundle_from_running_application() -> Option<PathBuf> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;

    autoreleasepool(|_| {
        let bundle_id = NSString::from_str(MACOS_WORD_BUNDLE_ID);
        let applications =
            NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id);
        (0..applications.count())
            .filter_map(|index| {
                let application = applications.objectAtIndex(index);
                let path = application.bundleURL()?.to_file_path()?;
                Some((application.processIdentifier(), path))
            })
            .min_by_key(|(pid, _)| *pid)
            .map(|(_, path)| path)
    })
}

#[cfg(target_os = "macos")]
fn macos_word_bundle_from_launch_services() -> Option<PathBuf> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    // NSWorkspace is the public LaunchServices façade. It does not launch the
    // app and merely returns the registered default URL for the bundle id.
    autoreleasepool(|_| {
        let bundle_id = NSString::from_str(MACOS_WORD_BUNDLE_ID);
        let url =
            NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&bundle_id)?;
        url.to_file_path()
    })
}

#[cfg(target_os = "macos")]
fn require_macos_word_target() -> OpResult<MacosWordTarget> {
    resolve_macos_word_target()?.ok_or_else(|| {
        word_error(
            ERR_WORD_NOT_SUPPORTED,
            "Microsoft Word was not found through LaunchServices or /Applications.",
        )
    })
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacosUncertainRecovery {
    Proceed,
    ClearAndProceed,
    RefuseWhileWordRuns,
}

#[cfg(target_os = "macos")]
fn plan_macos_uncertain_recovery(uncertain: bool, word_running: bool) -> MacosUncertainRecovery {
    match (uncertain, word_running) {
        (false, _) => MacosUncertainRecovery::Proceed,
        (true, false) => MacosUncertainRecovery::ClearAndProceed,
        (true, true) => MacosUncertainRecovery::RefuseWhileWordRuns,
    }
}

#[cfg(target_os = "macos")]
fn apply_macos_uncertain_recovery(
    marker: &Path,
    uncertain: bool,
    word_running: bool,
) -> OpResult<MacosUncertainRecovery> {
    let recovery = plan_macos_uncertain_recovery(uncertain, word_running);
    match recovery {
        MacosUncertainRecovery::Proceed => Ok(recovery),
        MacosUncertainRecovery::ClearAndProceed => {
            if marker.is_file() {
                fs::remove_file(marker).map_err(|error| {
                    word_error(
                        path_ops::ERR_IO,
                        format!("clear stale Word automation state: {error}"),
                    )
                })?;
            }
            Ok(recovery)
        }
        MacosUncertainRecovery::RefuseWhileWordRuns => Err(word_error(
            ERR_WORD_TIMEOUT,
            "Microsoft Word may still be finishing a previous timed-out conversion. Review any Word dialogs or documents, then quit Word yourself before retrying; RaioPDF will never close a shared Word process.",
        )),
    }
}

/// A timed-out Apple Event may still be executing inside Word after the sender
/// has returned. Persist that uncertainty so neither another request nor an app
/// restart can overlap the late conversion. The user remains in control of the
/// shared Word process; observing that Word has exited is the only automatic
/// recovery signal.
#[cfg(target_os = "macos")]
fn ensure_macos_word_automation_settled(word_target: &MacosWordTarget) -> OpResult<()> {
    let marker = word_target.staging_root.join(MACOS_WORD_UNCERTAIN_MARKER);
    let uncertain = MACOS_WORD_AUTOMATION_UNCERTAIN.load(Ordering::Acquire) || marker.is_file();
    let word_running = macos_word_bundle_from_running_application().is_some();
    match apply_macos_uncertain_recovery(&marker, uncertain, word_running)? {
        MacosUncertainRecovery::Proceed | MacosUncertainRecovery::RefuseWhileWordRuns => Ok(()),
        MacosUncertainRecovery::ClearAndProceed => {
            MACOS_WORD_AUTOMATION_UNCERTAIN.store(false, Ordering::Release);
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
fn mark_macos_word_automation_uncertain(word_target: &MacosWordTarget) {
    MACOS_WORD_AUTOMATION_UNCERTAIN.store(true, Ordering::Release);
    let marker = word_target.staging_root.join(MACOS_WORD_UNCERTAIN_MARKER);
    let _ = fs::write(
        marker,
        b"A Word Apple Event timed out; do not overlap conversions.\n",
    );
}

/// The feasibility spike still owns the final version/license matrix. Keep the
/// gate deliberately permissive for a current installed Word, while rejecting
/// malformed metadata and obviously obsolete major versions.
#[cfg(target_os = "macos")]
pub fn macos_word_version_supported(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 16)
}

/// Cleanup is intentionally document-scoped: macOS Word is a shared, visible
/// process, so a timeout must never kill it. We quit only a process our script
/// launched, and otherwise close just the temp document without saving.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MacosTimeoutCleanupPlan {
    pub close_temp_document: bool,
    pub quit_word: bool,
}

#[cfg(target_os = "macos")]
pub fn plan_macos_timeout_cleanup(word_was_launched: bool) -> MacosTimeoutCleanupPlan {
    MacosTimeoutCleanupPlan {
        close_temp_document: true,
        quit_word: word_was_launched,
    }
}

#[cfg(target_os = "macos")]
fn convert_docx_to_pdf_macos(
    toolchain: &PathOpsToolchain,
    input: &Path,
    output: &Path,
    markup: MarkupMode,
    timeout: Duration,
) -> OpResult<()> {
    require_docx_input(input)?;
    let word_target = require_macos_word_target()?;
    let temp_dir = WordTempDir::create_macos("raiopdf-word-convert", &word_target)?;
    let copied_input = temp_dir.path().join("input.docx");
    let staged_output = temp_dir.path().join("output.pdf");
    fs::copy(input, &copied_input)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("copy DOCX input: {error}")))?;

    run_macos_word_conversion(
        build_word_conversion_script(),
        &word_target,
        &copied_input,
        &staged_output,
        Some(markup),
        timeout,
    )?;
    require_nonempty_pdf(&staged_output)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("create output dir: {error}")))?;
    }
    let scrubbed = temp_dir.path().join("scrubbed.pdf");
    scrub_word_pdf(toolchain, &staged_output, &scrubbed)?;
    require_nonempty_pdf(&scrubbed)?;
    move_staged_output(&scrubbed, output)?;
    Ok(())
}

/// A single-flight macOS Word session for a DOCX import batch.
///
/// Word for Mac exposes one shared visible application instance. Holding the
/// automation lock across the batch prevents another RaioPDF conversion from
/// joining halfway through, while each document still gets its own private
/// copy, output validation, and error result. The session never kills Word;
/// it only asks Word to quit at the end when the first batch conversion launched
/// it.
#[cfg(target_os = "macos")]
pub struct MacosWordConversionSession {
    _automation_guard: std::sync::MutexGuard<'static, ()>,
    word_target: MacosWordTarget,
    launched_by_raio: bool,
    finished: bool,
}

#[cfg(target_os = "macos")]
impl MacosWordConversionSession {
    pub fn begin() -> OpResult<Self> {
        let automation_guard = WORD_AUTOMATION_MUTEX
            .lock()
            .map_err(|_| word_error(path_ops::ERR_IO, "Word automation mutex poisoned"))?;
        let word_target = require_macos_word_target()?;
        ensure_macos_word_automation_settled(&word_target)?;
        Ok(Self {
            _automation_guard: automation_guard,
            word_target,
            launched_by_raio: false,
            finished: false,
        })
    }

    /// Convert one DOCX while retaining the session's Word instance for the
    /// next item in the batch. A failed item leaves the session usable so the
    /// caller can report that item and continue with later files.
    pub fn convert_docx_to_pdf_with_toolchain(
        &mut self,
        toolchain: &PathOpsToolchain,
        input: &Path,
        output: &Path,
        markup: MarkupMode,
    ) -> OpResult<()> {
        require_docx_input(input)?;
        let temp_dir = WordTempDir::create_macos("raiopdf-word-convert", &self.word_target)?;
        let copied_input = temp_dir.path().join("input.docx");
        let staged_output = temp_dir.path().join("output.pdf");
        fs::copy(input, &copied_input)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("copy DOCX input: {error}")))?;

        run_macos_word_conversion_unlocked(MacosWordConversionRun {
            script: build_word_conversion_script(),
            word_target: &self.word_target,
            input: &copied_input,
            output: &staged_output,
            markup: Some(markup),
            timeout: MACOS_WORD_CONVERSION_TIMEOUT,
            keep_word_running: true,
            quit_on_timeout: false,
            launched_by_raio: Some(&mut self.launched_by_raio),
        })?;

        require_nonempty_pdf(&staged_output)?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                word_error(path_ops::ERR_IO, format!("create output dir: {error}"))
            })?;
        }
        let scrubbed = temp_dir.path().join("scrubbed.pdf");
        scrub_word_pdf(toolchain, &staged_output, &scrubbed)?;
        require_nonempty_pdf(&scrubbed)?;
        move_staged_output(&scrubbed, output)
    }

    /// End the batch. This is deliberately best-effort: output results have
    /// already been recorded per file, so a cleanup failure cannot rewrite a
    /// successful per-file result.
    pub fn finish(mut self) {
        self.finish_best_effort();
    }

    fn finish_best_effort(&mut self) {
        if self.finished {
            return;
        }
        if !self.launched_by_raio || request_macos_word_quit().is_ok() {
            self.finished = true;
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacosWordConversionSession {
    fn drop(&mut self) {
        self.finish_best_effort();
    }
}

#[cfg(target_os = "macos")]
fn convert_pdf_to_docx_macos(input: &Path, output: &Path, timeout: Duration) -> OpResult<()> {
    require_pdf_input(input)?;
    require_docx_output(output)?;
    let word_target = require_macos_word_target()?;
    let temp_dir = WordTempDir::create_macos("raiopdf-word-reflow", &word_target)?;
    let copied_input = temp_dir.path().join("input.pdf");
    let staged_output = temp_dir.path().join("output.docx");
    fs::copy(input, &copied_input)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("copy PDF input: {error}")))?;

    run_macos_word_conversion(
        build_word_reflow_script(),
        &word_target,
        &copied_input,
        &staged_output,
        None,
        timeout,
    )?;
    require_nonempty_docx(&staged_output)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("create output dir: {error}")))?;
    }
    move_staged_output(&staged_output, output)
}

#[cfg(target_os = "macos")]
fn run_macos_word_conversion(
    script: &str,
    word_target: &MacosWordTarget,
    input: &Path,
    output: &Path,
    markup: Option<MarkupMode>,
    timeout: Duration,
) -> OpResult<()> {
    let _automation_guard = WORD_AUTOMATION_MUTEX
        .lock()
        .map_err(|_| word_error(path_ops::ERR_IO, "Word automation mutex poisoned"))?;
    run_macos_word_conversion_unlocked(MacosWordConversionRun {
        script,
        word_target,
        input,
        output,
        markup,
        timeout,
        keep_word_running: false,
        quit_on_timeout: true,
        launched_by_raio: None,
    })
}

#[cfg(target_os = "macos")]
/// Execute one JXA conversion while the caller owns WORD_AUTOMATION_MUTEX.
/// `keep_word_running` is only used by the batch session; ordinary conversion
/// retains its existing launch-and-quit behavior.
struct MacosWordConversionRun<'a> {
    script: &'a str,
    word_target: &'a MacosWordTarget,
    input: &'a Path,
    output: &'a Path,
    markup: Option<MarkupMode>,
    timeout: Duration,
    keep_word_running: bool,
    quit_on_timeout: bool,
    launched_by_raio: Option<&'a mut bool>,
}

#[cfg(target_os = "macos")]
fn run_macos_word_conversion_unlocked(run_options: MacosWordConversionRun<'_>) -> OpResult<()> {
    let MacosWordConversionRun {
        script,
        word_target,
        input,
        output,
        markup,
        timeout,
        keep_word_running,
        quit_on_timeout,
        launched_by_raio,
    } = run_options;
    ensure_macos_word_automation_settled(word_target)?;
    let work_dir = WordTempDir::create_macos("raiopdf-word-script", word_target)?;
    let script_path = work_dir.path().join("word-convert.js");
    let input_json_path = work_dir.path().join("input.json");
    fs::write(&script_path, script)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("write Word script: {error}")))?;
    let input_json = match markup {
        Some(markup) if keep_word_running => {
            build_macos_batch_word_conversion_input_json(input, output, markup)?
        }
        Some(markup) => build_macos_word_conversion_input_json(input, output, markup)?,
        None => build_macos_word_reflow_input_json(input, output)?,
    };
    fs::write(&input_json_path, input_json)
        .map_err(|error| word_error(path_ops::ERR_IO, format!("write Word input JSON: {error}")))?;

    let args = word_osascript_args(&script_path, &input_json_path);
    let run = run_word_osascript(&args, timeout, quit_on_timeout)?;
    if let Some(launched_by_raio) = launched_by_raio {
        *launched_by_raio |= parse_macos_word_launched(&run.stdout);
    }
    if run.timed_out {
        mark_macos_word_automation_uncertain(word_target);
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
        let _ = fs::remove_file(output);
        let message = if run.stderr.trim().is_empty() {
            "osascript exited unsuccessfully".to_string()
        } else {
            run.stderr.trim().to_string()
        };
        return Err(word_error(macos_word_error_code(&message), message));
    }
    let outcome = parse_word_script_stdout(&run.stdout)?;
    if let WordScriptResult::Err { code, message } = outcome.result {
        if macos_word_error_code(&code) == ERR_WORD_TIMEOUT {
            mark_macos_word_automation_uncertain(word_target);
        }
        let _ = fs::remove_file(output);
        return Err(word_error(macos_word_error_code(&code), message));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct MacosWordRunOutput {
    status_success: bool,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

#[cfg(target_os = "macos")]
fn run_word_osascript(
    args: &[std::ffi::OsString],
    timeout: Duration,
    quit_on_timeout: bool,
) -> OpResult<MacosWordRunOutput> {
    use std::{
        process::{Command, Stdio},
        sync::Arc,
        thread,
        time::Instant,
    };

    let mut child = Command::new("/usr/bin/osascript")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            word_error(path_ops::ERR_OP_FAILED, format!("osascript spawn: {error}"))
        })?;
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
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            word_error(path_ops::ERR_OP_FAILED, format!("osascript wait: {error}"))
        })? {
            join_word_output_threads(stdout_thread, stderr_thread);
            return Ok(MacosWordRunOutput {
                status_success: status.success(),
                stdout: locked_output_string(&stdout),
                stderr: locked_output_string(&stderr),
                timed_out: false,
            });
        }
        if started.elapsed() >= timeout {
            // This terminates only the helper. It intentionally never kills the
            // shared Microsoft Word process; the JXA finally block handles the
            // normal close/quit policy before this runner deadline.
            let _ = child.kill();
            let _ = child.wait();
            join_word_output_threads(stdout_thread, stderr_thread);
            let stdout = locked_output_string(&stdout);
            let launched_by_us = parse_macos_word_launched(&stdout);
            let _ = run_macos_timeout_cleanup(
                args.last().map(Path::new),
                launched_by_us && quit_on_timeout,
            );
            return Ok(MacosWordRunOutput {
                status_success: false,
                stdout,
                stderr: locked_output_string(&stderr),
                timed_out: true,
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(target_os = "macos")]
fn join_word_output_threads(
    stdout_thread: Option<std::thread::JoinHandle<()>>,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
) {
    if let Some(thread) = stdout_thread {
        let _ = thread.join();
    }
    if let Some(thread) = stderr_thread {
        let _ = thread.join();
    }
}

#[cfg(target_os = "macos")]
fn parse_macos_word_launched(stdout: &str) -> bool {
    stdout.lines().any(|line| {
        line.trim()
            .strip_prefix(MACOS_LAUNCHED_PREFIX)
            .is_some_and(|value| value.trim() == "true")
    })
}

/// Best-effort cleanup after the helper was stopped. It only addresses the
/// private copied document, and it never sends a process kill to Word.
#[cfg(target_os = "macos")]
fn run_macos_timeout_cleanup(input_json_path: Option<&Path>, launched_by_us: bool) -> OpResult<()> {
    use std::{
        process::{Command, Stdio},
        thread,
        time::Instant,
    };

    let Some(input_json_path) = input_json_path else {
        return Ok(());
    };
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", MACOS_WORD_TIMEOUT_CLEANUP_SCRIPT])
        .arg(input_json_path)
        .arg(if launched_by_us { "true" } else { "false" })
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            word_error(
                path_ops::ERR_OP_FAILED,
                format!("osascript cleanup spawn: {error}"),
            )
        })?;
    let started = Instant::now();
    while child
        .try_wait()
        .map_err(|error| {
            word_error(
                path_ops::ERR_OP_FAILED,
                format!("osascript cleanup wait: {error}"),
            )
        })?
        .is_none()
    {
        if started.elapsed() >= Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// Best-effort session cleanup. This sends Word a normal quit Apple Event; it
/// never terminates the Word process. Callers only reach this when the batch's
/// first conversion established that RaioPDF launched Word.
#[cfg(target_os = "macos")]
fn request_macos_word_quit() -> OpResult<()> {
    use std::{
        process::{Command, Stdio},
        thread,
        time::Instant,
    };

    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", MACOS_WORD_QUIT_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            word_error(
                path_ops::ERR_OP_FAILED,
                format!("osascript Word quit spawn: {error}"),
            )
        })?;
    let started = Instant::now();
    while child
        .try_wait()
        .map_err(|error| {
            word_error(
                path_ops::ERR_OP_FAILED,
                format!("osascript Word quit wait: {error}"),
            )
        })?
        .is_none()
    {
        if started.elapsed() >= Duration::from_secs(5) {
            // The helper is disposable. Do not send a signal to Word itself.
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn move_staged_output(source: &Path, destination: &Path) -> OpResult<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(source, destination).map_err(|copy_error| {
                word_error(
                    path_ops::ERR_IO,
                    format!(
                        "move Word staged output ({rename_error}); copy fallback: {copy_error}"
                    ),
                )
            })?;
            fs::remove_file(source).map_err(|error| {
                word_error(
                    path_ops::ERR_IO,
                    format!("remove moved staged output: {error}"),
                )
            })
        }
    }
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

/// Classify the stable Apple Event error numbers before matching the more
/// variable localized text emitted by Word/JXA. `-1712` is an Apple Event
/// reply timeout (inside the script), whereas a runner deadline uses the same
/// public timeout code with its own explicit message.
#[cfg(target_os = "macos")]
pub fn macos_word_error_code(message: &str) -> &'static str {
    match message {
        ERR_WORD_AUTOMATION_DENIED => return ERR_WORD_AUTOMATION_DENIED,
        ERR_WORD_TIMEOUT => return ERR_WORD_TIMEOUT,
        ERR_WORD_PASSWORD_PROTECTED => return ERR_WORD_PASSWORD_PROTECTED,
        ERR_WORD_REPAIR_REQUIRED => return ERR_WORD_REPAIR_REQUIRED,
        ERR_WORD_FILE_LOCKED => return ERR_WORD_FILE_LOCKED,
        ERR_WORD_SAVE_FAILED => return ERR_WORD_SAVE_FAILED,
        ERR_WORD_AUTOMATION_FAILED => return ERR_WORD_AUTOMATION_FAILED,
        _ => {}
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("-1743") || lower.contains("not authorized to send apple events") {
        return ERR_WORD_AUTOMATION_DENIED;
    }
    if lower.contains("-1712") || lower.contains("apple event timed out") {
        return ERR_WORD_TIMEOUT;
    }
    if lower.contains("password") || lower.contains("encrypted") {
        return ERR_WORD_PASSWORD_PROTECTED;
    }
    if lower.contains("repair") || lower.contains("corrupt") || lower.contains("damaged") {
        return ERR_WORD_REPAIR_REQUIRED;
    }
    if lower.contains("license")
        || lower.contains("activation")
        || lower.contains("subscription")
        || lower.contains("read-only")
    {
        return ERR_WORD_SAVE_FAILED;
    }
    if lower.contains("sandbox")
        || lower.contains("not permitted")
        || lower.contains("permission denied")
        || lower.contains("operation not permitted")
        || lower.contains("file is locked")
    {
        return ERR_WORD_FILE_LOCKED;
    }
    if lower.contains("save") || lower.contains("export") || lower.contains("write") {
        return ERR_WORD_SAVE_FAILED;
    }
    ERR_WORD_AUTOMATION_FAILED
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
        ERR_WORD_AUTOMATION_DENIED => ERR_WORD_AUTOMATION_DENIED,
        ERR_WORD_AUTOMATION_FAILED => ERR_WORD_AUTOMATION_FAILED,
        ERR_WORD_TIMEOUT => ERR_WORD_TIMEOUT,
        _ => ERR_WORD_AUTOMATION_FAILED,
    }
}

#[cfg(any(windows, target_os = "macos"))]
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

#[cfg(any(windows, target_os = "macos"))]
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

#[cfg(any(windows, target_os = "macos"))]
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

#[cfg(any(windows, target_os = "macos"))]
fn scrub_word_pdf(toolchain: &PathOpsToolchain, input: &Path, output: &Path) -> OpResult<()> {
    path_ops::scrub_metadata(toolchain, input, output)
}

#[cfg(any(windows, target_os = "macos"))]
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

#[cfg(any(windows, target_os = "macos"))]
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

    // Pre-spawn WINWORD snapshot for the marker-less timeout fallback (see
    // `plan_timeout_kills`). Taken before the spawn so any pid that shows up
    // later is attributable to the conversion window.
    let winword_pids_before: Option<Vec<u32>> = query_winword_processes()
        .map(|processes| processes.iter().map(|process| process.pid).collect());

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
            // Only re-enumerate when the fallback can actually be used: the
            // marker is missing AND the pre-spawn snapshot succeeded. With no
            // before-set, a fallback kill could hit the user's own Word.
            let winword_after = match (&winword_pids_before, parse_winword_pid(&stdout_so_far)) {
                (Some(_), None) => query_winword_processes().unwrap_or_default(),
                _ => Vec::new(),
            };
            let kill_plan = plan_timeout_kills(
                &stdout_so_far,
                powershell_pid,
                winword_pids_before.as_deref().unwrap_or(&[]),
                &winword_after,
            );
            if let Some(winword_pid) = kill_plan.winword_pid {
                kill_pid(winword_pid);
            }
            for winword_pid in &kill_plan.fallback_winword_pids {
                kill_pid(*winword_pid);
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

#[cfg(any(windows, target_os = "macos"))]
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

#[cfg(any(windows, target_os = "macos"))]
fn locked_output_string(output: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>) -> String {
    output
        .lock()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// Snapshot the running WINWORD.EXE processes via `tasklist /v` (window
/// titles included). `None` when tasklist itself fails — callers must treat
/// that as "no snapshot" and skip the fallback kill entirely, never as an
/// empty before-set (which would make every running Word look new).
#[cfg(windows)]
fn query_winword_processes() -> Option<Vec<WinwordProcess>> {
    use std::process::{Command, Stdio};

    let mut command = Command::new("tasklist.exe");
    command
        .args(["/v", "/fo", "csv", "/nh", "/fi", "IMAGENAME eq WINWORD.EXE"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::apply_platform_spawn_flags(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_tasklist_verbose_csv(&String::from_utf8_lossy(
        &output.stdout,
    )))
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

#[cfg(any(windows, target_os = "macos"))]
struct WordTempDir {
    path: PathBuf,
}

#[cfg(any(windows, target_os = "macos"))]
impl WordTempDir {
    #[cfg(windows)]
    fn create(prefix: &str) -> OpResult<Self> {
        let sequence = WORD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir();
        let path = base.join(format!("{prefix}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path)
            .map_err(|error| word_error(path_ops::ERR_IO, format!("create temp dir: {error}")))?;
        Ok(Self { path })
    }

    /// Create a conversion-private directory in the silently writable root
    /// selected for this exact Word bundle. App Store Word uses its Office
    /// application group; non-sandboxed direct-download Word uses a private
    /// ordinary temp root. Sandboxed builds without the group are rejected
    /// rather than causing a picker for an invisible private source file.
    #[cfg(target_os = "macos")]
    fn create_macos(prefix: &str, word_target: &MacosWordTarget) -> OpResult<Self> {
        let sequence = WORD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = word_target
            .staging_root
            .join(format!("{prefix}-{}-{sequence}", std::process::id()));
        path_ops::create_private_dir(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(target_os = "macos")]
fn macos_word_staging_root_for_bundle(bundle: &Path) -> OpResult<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| {
        word_error(
            path_ops::ERR_IO,
            "cannot locate the user home directory for Microsoft Word staging",
        )
    })?;
    let office_container = PathBuf::from(home).join("Library/Group Containers/UBF8T346G9.Office");
    if office_container.is_dir() {
        // The Mac App Store edition of Word is sandboxed. Files in the normal
        // process temp directory trigger an interactive file-access picker,
        // which cannot be completed for an intentionally private temp path.
        // Word's signed application-group entitlement grants it silent access
        // to this Microsoft Office container; RaioPDF itself is not sandboxed.
        let raio_root = office_container.join("RaioPDF");
        path_ops::ensure_private_dir(&raio_root)?;
        let root = raio_root.join("Word Automation");
        path_ops::ensure_private_dir(&root)?;
        return Ok(root);
    }

    if !macos_word_bundle_is_sandboxed(bundle)? {
        let root = std::env::temp_dir().join("RaioPDF Word Automation");
        path_ops::ensure_private_dir(&root)?;
        return Ok(root);
    }

    Err(word_error(
        ERR_WORD_STAGING_UNAVAILABLE,
        "Microsoft Word is sandboxed but its Office group container is unavailable. Reinstall or launch Word once, then retry; RaioPDF will not expose your original document to a file-access prompt.",
    ))
}

#[cfg(target_os = "macos")]
fn macos_word_bundle_is_sandboxed(bundle: &Path) -> OpResult<bool> {
    use std::process::{Command, Stdio};

    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "--entitlements", ":-"])
        .arg(bundle)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            word_error(
                ERR_WORD_STAGING_UNAVAILABLE,
                format!("inspect Microsoft Word sandbox entitlements: {error}"),
            )
        })?;
    // codesign has historically emitted the entitlement plist on either
    // stdout or stderr depending on the OS release. Combine both streams.
    let mut entitlement_text = String::from_utf8_lossy(&output.stdout).into_owned();
    entitlement_text.push_str(&String::from_utf8_lossy(&output.stderr));
    if !output.status.success() && entitlement_text.trim().is_empty() {
        return Err(word_error(
            ERR_WORD_STAGING_UNAVAILABLE,
            "could not inspect Microsoft Word sandbox entitlements",
        ));
    }
    let sandbox_key = "<key>com.apple.security.app-sandbox</key>";
    let Some(index) = entitlement_text.find(sandbox_key) else {
        return Ok(false);
    };
    Ok(entitlement_text[index + sandbox_key.len()..]
        .trim_start()
        .starts_with("<true/>"))
}

#[cfg(any(windows, target_os = "macos"))]
impl Drop for WordTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// JXA is used instead of interpolated AppleScript so JSON and POSIX paths stay
// data all the way into Word. Protocol markers use an explicit stdout file
// handle; JXA `console.log` and AppleScript `log` both write to stderr.
//
// The exact PDF-open/reflow behavior is intentionally validated by the Track A
// spike before this code is enabled in a release. Word enum arguments use the
// literal names published by its installed scripting dictionary; unlike some
// JXA applications, Word does not expose them through `word.constants`.
#[cfg(target_os = "macos")]
const MACOS_WORD_CONVERSION_SCRIPT: &str = r#"
ObjC.import('Foundation');
const RESULT_PREFIX = '@@RAIOPDF_WORD_RESULT@@ ';
const LAUNCHED_PREFIX = '@@RAIOPDF_WORD_LAUNCHED@@ ';
const APP_ID = 'com.microsoft.Word';

function input() {
  const path = ObjC.unwrap($.NSProcessInfo.processInfo.arguments.lastObject);
  const data = $.NSData.dataWithContentsOfFile($(path));
  return JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
}
// `console.log` is written to stderr by osascript's JXA runtime. The Rust
// runner reserves stdout for these protocol markers, so write it explicitly.
function stdout(line) {
  const data = $(String(line) + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
function emit(value) { stdout(RESULT_PREFIX + JSON.stringify(value)); }
function documentAtPath(word, path) {
  let seen = [];
  // PDF reflow can return from `open` while Word is still constructing a
  // 100+ page document. The Rust runner owns the two-minute wall clock; keep
  // polling here so a legitimate asynchronous open is not misreported after
  // five seconds.
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    seen = [];
    for (let index = 0; index < word.documents.length; index += 1) {
      const candidate = word.documents[index];
      try {
        const candidatePath = String(candidate.posixFullName());
        seen.push(candidatePath);
        if (candidatePath === path) return candidate;
      } catch (_) {}
    }
    $.NSThread.sleepForTimeInterval(0.05);
  }
  throw new Error('Word opened the file but did not expose its document object; requested=' + path + '; seen=' + seen.join(','));
}
function errorCode(error) {
  const message = String(error);
  if (message.indexOf('-1743') !== -1) return 'WORD_AUTOMATION_DENIED';
  if (message.indexOf('-1712') !== -1) return 'WORD_TIMEOUT';
  if (/password|encrypt/i.test(message)) return 'WORD_PASSWORD_PROTECTED';
  if (/repair|corrupt|damaged/i.test(message)) return 'WORD_REPAIR_REQUIRED';
  if (/license|activation|subscription|read-only/i.test(message)) return 'WORD_SAVE_FAILED';
  if (/sandbox|not permitted|permission denied|locked/i.test(message)) return 'WORD_FILE_LOCKED';
  if (/save|export|write/i.test(message)) return 'WORD_SAVE_FAILED';
  return 'WORD_AUTOMATION_FAILED';
}

let word = null;
let document = null;
let launchedByUs = false;
let keepWordRunning = false;
let stage = 'initializing';
try {
  const request = input();
  keepWordRunning = request.keepWordRunning === true;
  // Apple Events target the registered default for this bundle id, which is
  // the same LaunchServices selection Rust used for version/staging checks.
  // Passing an app-bundle path here stalls Word 16.111's JXA bridge.
  word = Application(APP_ID);
  word.includeStandardAdditions = true;
  launchedByUs = !word.running();
  if (launchedByUs) word.launch();
  stdout(LAUNCHED_PREFIX + launchedByUs);
  stage = 'suppressing Word alerts';
  word.displayAlerts = 'alerts none';
  // Word for Mac has a shared visible instance. Opening the private copy is
  // deliberate; never pass a user-selected source path to Word.
  stage = 'opening the private DOCX copy';
  word.open(Path(request.inputPath), {
    confirmConversions: false,
    readOnly: true,
    addToRecentFiles: false
  });
  // Word 16.111 opens the file successfully but returns `undefined` from its
  // JXA `open` command despite declaring a document result in the sdef.
  // Resolve the exact private copy from the indexed collection instead.
  stage = 'resolving the opened DOCX';
  document = documentAtPath(word, request.inputPath);
  stage = 'applying revision display mode';
  if (request.markup === 'showMarkup') {
    try { document.showRevisions = true; } catch (_) {}
  } else {
    try { document.showRevisions = false; } catch (_) {}
  }
  // The sdef names this `format PDF`; this spelling is verified by the Track A
  // spike against the installed Word dictionary before release enablement.
  stage = 'saving the PDF';
  word.saveAs(document, { fileName: request.outputPath, fileFormat: 'format PDF' });
  emit({ ok: true, launchedByUs: launchedByUs });
} catch (error) {
  emit({ ok: false, code: errorCode(error), message: stage + ': ' + String(error), launchedByUs: launchedByUs });
} finally {
  if (document) { try { document.close({ saving: 'no' }); } catch (_) {} }
  if (word && launchedByUs && !keepWordRunning) { try { word.quit(); } catch (_) {} }
}
"#;

#[cfg(target_os = "macos")]
const MACOS_WORD_REFLOW_SCRIPT: &str = r#"
ObjC.import('Foundation');
const RESULT_PREFIX = '@@RAIOPDF_WORD_RESULT@@ ';
const LAUNCHED_PREFIX = '@@RAIOPDF_WORD_LAUNCHED@@ ';
const APP_ID = 'com.microsoft.Word';

function input() {
  const path = ObjC.unwrap($.NSProcessInfo.processInfo.arguments.lastObject);
  const data = $.NSData.dataWithContentsOfFile($(path));
  return JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
}
// `console.log` is written to stderr by osascript's JXA runtime. The Rust
// runner reserves stdout for these protocol markers, so write it explicitly.
function stdout(line) {
  const data = $(String(line) + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
function emit(value) { stdout(RESULT_PREFIX + JSON.stringify(value)); }
function documentAtPath(word, path) {
  let seen = [];
  // Large PDF reflow is asynchronous on Word 16.111: `open` may return before
  // the document enters the collection. The outer Rust runner remains the
  // authoritative two-minute bound.
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    seen = [];
    for (let index = 0; index < word.documents.length; index += 1) {
      const candidate = word.documents[index];
      try {
        const candidatePath = String(candidate.posixFullName());
        seen.push(candidatePath);
        if (candidatePath === path) return candidate;
      } catch (_) {}
    }
    $.NSThread.sleepForTimeInterval(0.05);
  }
  throw new Error('Word opened the file but did not expose its document object; requested=' + path + '; seen=' + seen.join(','));
}
function errorCode(error) {
  const message = String(error);
  if (message.indexOf('-1743') !== -1) return 'WORD_AUTOMATION_DENIED';
  if (message.indexOf('-1712') !== -1) return 'WORD_TIMEOUT';
  if (/password|encrypt/i.test(message)) return 'WORD_PASSWORD_PROTECTED';
  if (/repair|corrupt|damaged/i.test(message)) return 'WORD_REPAIR_REQUIRED';
  if (/license|activation|subscription|read-only/i.test(message)) return 'WORD_SAVE_FAILED';
  if (/sandbox|not permitted|permission denied|locked/i.test(message)) return 'WORD_FILE_LOCKED';
  if (/save|export|write/i.test(message)) return 'WORD_SAVE_FAILED';
  return 'WORD_AUTOMATION_FAILED';
}

let word = null;
let document = null;
let launchedByUs = false;
let stage = 'initializing';
try {
  const request = input();
  word = Application(APP_ID);
  word.includeStandardAdditions = true;
  launchedByUs = !word.running();
  if (launchedByUs) word.launch();
  stdout(LAUNCHED_PREFIX + launchedByUs);
  stage = 'suppressing Word alerts';
  word.displayAlerts = 'alerts none';
  stage = 'opening the private PDF copy';
  word.open(Path(request.inputPath), {
    confirmConversions: false,
    readOnly: true,
    addToRecentFiles: false
  });
  stage = 'resolving the opened PDF';
  document = documentAtPath(word, request.inputPath);
  // The dictionary's `format document` is a DOCX save target. PDF opening and
  // this save path are the feasibility gate; do not claim support until Track A.
  stage = 'saving the DOCX';
  word.saveAs(document, { fileName: request.outputPath, fileFormat: 'format document' });
  emit({ ok: true, launchedByUs: launchedByUs });
} catch (error) {
  emit({ ok: false, code: errorCode(error), message: stage + ': ' + String(error), launchedByUs: launchedByUs });
} finally {
  if (document) { try { document.close({ saving: 'no' }); } catch (_) {} }
  if (word && launchedByUs) { try { word.quit(); } catch (_) {} }
}
"#;

#[cfg(target_os = "macos")]
const MACOS_WORD_TIMEOUT_CLEANUP_SCRIPT: &str = r#"
ObjC.import('Foundation');
const args = $.NSProcessInfo.processInfo.arguments;
const launchedByUs = ObjC.unwrap(args.lastObject) === 'true';
const jsonPath = ObjC.unwrap(args.objectAtIndex(args.count - 2));
const data = $.NSData.dataWithContentsOfFile($(jsonPath));
const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
const word = Application('com.microsoft.Word');
if (word.running()) {
  for (let index = 0; index < word.documents.length; index += 1) {
    const document = word.documents[index];
    try {
      if (String(document.posixFullName()) === request.inputPath) document.close({ saving: 'no' });
    } catch (_) {}
  }
  if (launchedByUs) { try { word.quit(); } catch (_) {} }
}
"#;

#[cfg(target_os = "macos")]
const MACOS_WORD_QUIT_SCRIPT: &str = r#"
const word = Application('com.microsoft.Word');
if (word.running()) word.quit();
"#;

#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
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
        let plan = plan_timeout_kills("@@RAIOPDF_WORD_PID@@ 5150\nnoise", 2400, &[], &[]);
        assert_eq!(
            plan,
            TimeoutKillPlan {
                powershell_pid: 2400,
                winword_pid: Some(5150),
                fallback_winword_pids: Vec::new(),
            }
        );

        let plan = plan_timeout_kills("no pid yet", 2400, &[], &[]);
        assert_eq!(
            plan,
            TimeoutKillPlan {
                powershell_pid: 2400,
                winword_pid: None,
                fallback_winword_pids: Vec::new(),
            }
        );
    }

    #[test]
    fn timeout_kill_plan_marker_present_never_uses_the_fallback() {
        // Even with new windowless pids in the after-snapshot, a known marker
        // pid means the fallback stays empty — only the attributed instance
        // is killed.
        let after = vec![
            WinwordProcess {
                pid: 5150,
                has_visible_window: false,
            },
            WinwordProcess {
                pid: 7777,
                has_visible_window: false,
            },
        ];
        let plan = plan_timeout_kills("@@RAIOPDF_WORD_PID@@ 5150", 2400, &[], &after);
        assert_eq!(plan.winword_pid, Some(5150));
        assert!(plan.fallback_winword_pids.is_empty());
    }

    #[test]
    fn timeout_kill_plan_without_marker_kills_only_new_windowless_winword() {
        let before = vec![1111, 2222];
        let after = vec![
            // Pre-existing hidden instance: spared (we cannot attribute it).
            WinwordProcess {
                pid: 1111,
                has_visible_window: false,
            },
            // Pre-existing visible instance (user's Word): spared.
            WinwordProcess {
                pid: 2222,
                has_visible_window: true,
            },
            // New but visible: the user launched Word mid-conversion — spared.
            WinwordProcess {
                pid: 3333,
                has_visible_window: true,
            },
            // New and windowless: the hidden DCOM instance our conversion
            // spawned before Word wedged — killed.
            WinwordProcess {
                pid: 4444,
                has_visible_window: false,
            },
        ];
        let plan = plan_timeout_kills("no marker", 2400, &before, &after);
        assert_eq!(plan.winword_pid, None);
        assert_eq!(plan.fallback_winword_pids, vec![4444]);
    }

    #[test]
    fn parses_tasklist_verbose_csv_rows() {
        let output = concat!(
            "\"WINWORD.EXE\",\"4242\",\"Console\",\"1\",\"150,204 K\",\"Running\",",
            "\"DESKTOP\\jacob\",\"0:00:03\",\"Brief - Word\"\r\n",
            "\"WINWORD.EXE\",\"5150\",\"Console\",\"1\",\"88,004 K\",\"Unknown\",",
            "\"DESKTOP\\jacob\",\"0:00:00\",\"N/A\"\r\n",
            "INFO: No tasks are running which match the specified criteria.\r\n",
        );
        assert_eq!(
            parse_tasklist_verbose_csv(output),
            vec![
                WinwordProcess {
                    pid: 4242,
                    has_visible_window: true,
                },
                WinwordProcess {
                    pid: 5150,
                    has_visible_window: false,
                },
            ]
        );
        assert!(parse_tasklist_verbose_csv("").is_empty());
    }

    #[cfg(windows)]
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

    #[cfg(windows)]
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

    #[cfg(not(any(windows, target_os = "macos")))]
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

    #[cfg(not(any(windows, target_os = "macos")))]
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_word_version_gate_accepts_current_word_and_rejects_old_or_malformed_versions() {
        assert!(macos_word_version_supported("16.111.1"));
        assert!(macos_word_version_supported("16"));
        assert!(!macos_word_version_supported("15.99"));
        assert!(!macos_word_version_supported("Word 16"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_word_bundle_selection_prefers_running_then_launch_services_then_fallback() {
        let temp = std::env::temp_dir().join(format!(
            "raiopdf-word-selection-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir(&temp).unwrap();
        let launch_services = temp.join("Microsoft Word Preview.app");
        let running = temp.join("Microsoft Word Running.app");
        fs::create_dir(&launch_services).unwrap();
        fs::create_dir(&running).unwrap();
        assert_eq!(
            select_macos_word_bundle(Some(running.clone()), Some(launch_services.clone())),
            Some(running)
        );
        assert_eq!(
            select_macos_word_bundle(None, Some(launch_services.clone())),
            Some(launch_services)
        );

        // A missing registration must not be used merely because it is named
        // like Word. The standard /Applications fallback remains the only
        // deterministic alternative (and is absent in an isolated CI root).
        assert_eq!(
            select_macos_word_bundle(
                Some(temp.join("missing-running.app")),
                Some(temp.join("missing-registered.app")),
            ),
            Path::new(MACOS_WORD_APP_PATH)
                .is_dir()
                .then(|| PathBuf::from(MACOS_WORD_APP_PATH))
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_osascript_args_keep_script_and_json_as_argv() {
        let args = word_osascript_args(
            Path::new("/tmp/word conversion.js"),
            Path::new("/tmp/input with spaces.json"),
        );
        let rendered: Vec<String> = args
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            rendered,
            vec![
                "-l",
                "JavaScript",
                "/tmp/word conversion.js",
                "/tmp/input with spaces.json",
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_error_mapping_preserves_apple_event_and_word_failures() {
        assert_eq!(
            macos_word_error_code("Application isn't allowed to send Apple events. (-1743)"),
            ERR_WORD_AUTOMATION_DENIED
        );
        assert_eq!(
            macos_word_error_code("Apple event timed out. (-1712)"),
            ERR_WORD_TIMEOUT
        );
        assert_eq!(
            macos_word_error_code("sandbox: operation not permitted"),
            ERR_WORD_FILE_LOCKED
        );
        assert_eq!(
            macos_word_error_code("A Microsoft 365 subscription is required"),
            ERR_WORD_SAVE_FAILED
        );
        assert_eq!(
            macos_word_error_code("This document is password protected"),
            ERR_WORD_PASSWORD_PROTECTED
        );
        assert_eq!(
            macos_word_error_code(ERR_WORD_AUTOMATION_DENIED),
            ERR_WORD_AUTOMATION_DENIED
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_timeout_cleanup_never_kills_shared_word() {
        assert_eq!(
            plan_macos_timeout_cleanup(false),
            MacosTimeoutCleanupPlan {
                close_temp_document: true,
                quit_word: false,
            }
        );
        assert_eq!(
            plan_macos_timeout_cleanup(true),
            MacosTimeoutCleanupPlan {
                close_temp_document: true,
                quit_word: true,
            }
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uncertain_conversion_blocks_overlap_until_word_exits() {
        assert_eq!(
            plan_macos_uncertain_recovery(false, true),
            MacosUncertainRecovery::Proceed
        );
        assert_eq!(
            plan_macos_uncertain_recovery(true, true),
            MacosUncertainRecovery::RefuseWhileWordRuns
        );
        assert_eq!(
            plan_macos_uncertain_recovery(true, false),
            MacosUncertainRecovery::ClearAndProceed
        );
    }

    /// CI-safe integration canary for the incident where Word continued a late
    /// PDF reflow after `osascript` timed out. This exercises the persistent
    /// marker on disk without launching or scripting Word.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_word_timeout_overlap_marker_canary() {
        let root = std::env::temp_dir().join(format!(
            "raiopdf-word-overlap-canary-{}-{}",
            std::process::id(),
            WORD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).expect("create overlap canary root");
        let marker = root.join(MACOS_WORD_UNCERTAIN_MARKER);
        fs::write(&marker, b"timed out\n").expect("write overlap marker");

        let error = apply_macos_uncertain_recovery(&marker, true, true)
            .expect_err("a running Word instance must keep the guard closed");
        assert_eq!(error.code, ERR_WORD_TIMEOUT);
        assert!(marker.is_file(), "refusal must persist across app restarts");

        assert_eq!(
            apply_macos_uncertain_recovery(&marker, true, false)
                .expect("Word exit should clear uncertainty"),
            MacosUncertainRecovery::ClearAndProceed
        );
        assert!(
            !marker.exists(),
            "Word exit must clear the persistent guard"
        );
        fs::remove_dir_all(root).expect("remove overlap canary root");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_jxa_scripts_keep_the_safety_contract_and_stdout_result_marker() {
        for script in [build_word_conversion_script(), build_word_reflow_script()] {
            assert!(script.contains("const APP_ID = 'com.microsoft.Word'"));
            assert!(script.contains("confirmConversions: false"));
            assert!(script.contains("readOnly: true"));
            assert!(script.contains("document.close({ saving: 'no' })"));
            assert!(script.contains("NSFileHandle.fileHandleWithStandardOutput.writeData(data)"));
            assert!(script.contains("stdout(RESULT_PREFIX + JSON.stringify(value))"));
            assert!(script.contains("stdout(LAUNCHED_PREFIX + launchedByUs)"));
            assert!(!script.contains("console.log("));
            assert!(script.contains("arguments.lastObject"));
            assert!(!script.contains("doShellScript"));
        }
        assert!(build_word_conversion_script().contains("let keepWordRunning = false"));
        assert!(build_word_conversion_script()
            .contains("if (word && launchedByUs && !keepWordRunning) { try { word.quit(); }"));
        assert!(
            build_word_reflow_script().contains("if (word && launchedByUs) { try { word.quit(); }")
        );
        assert!(build_word_conversion_script().contains("fileFormat: 'format PDF'"));
        assert!(build_word_reflow_script().contains("fileFormat: 'format document'"));
        assert!(!build_word_conversion_script().contains("word.constants"));
        assert!(!build_word_reflow_script().contains("word.constants"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_timeout_launch_marker_is_parsed_without_word() {
        assert!(parse_macos_word_launched(
            "noise\n@@RAIOPDF_WORD_LAUNCHED@@ true\n"
        ));
        assert!(!parse_macos_word_launched(
            "@@RAIOPDF_WORD_LAUNCHED@@ false\n"
        ));
        assert!(!parse_macos_word_launched(""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_batch_input_requests_one_word_session_without_shell_quoting() {
        let json = build_macos_batch_word_conversion_input_json(
            Path::new("/tmp/input doc.docx"),
            Path::new("/tmp/output doc.pdf"),
            MarkupMode::ShowMarkup,
        )
        .unwrap();
        assert_eq!(
            json,
            r#"{"inputPath":"/tmp/input doc.docx","outputPath":"/tmp/output doc.pdf","markup":"showMarkup","keepWordRunning":true}"#
        );
        assert!(build_word_conversion_script().contains("request.keepWordRunning === true"));
    }

    #[cfg(any(windows, target_os = "macos"))]
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

    #[cfg(any(windows, target_os = "macos"))]
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

    /// Maintainer-hardware timing gate for the representative 100+ page legal
    /// PDF. Kept ignored because CI has neither licensed Word nor this external
    /// non-confidential fixture. Run with `RAIOPDF_WORD_LARGE_PDF=/path/file.pdf`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires licensed Word and RAIOPDF_WORD_LARGE_PDF"]
    fn macos_word_large_pdf_timing_canary() {
        use std::time::Instant;

        let input = std::env::var_os("RAIOPDF_WORD_LARGE_PDF")
            .map(PathBuf::from)
            .expect("RAIOPDF_WORD_LARGE_PDF must point to the representative legal PDF");
        let toolchain = PathOpsToolchain::discover(None);
        let pages = path_ops::page_count(&toolchain, &input).expect("count large-PDF pages");
        assert!(pages >= 100, "timing fixture must have at least 100 pages");

        let temp = std::env::temp_dir().join(format!(
            "raiopdf-word-large-reflow-canary-{}",
            std::process::id()
        ));
        fs::create_dir_all(&temp).expect("large reflow canary temp dir");
        let output = temp.join("large-reflow.docx");
        let started = Instant::now();
        convert_pdf_to_docx(&input, &output).expect("100+ page PDF reflows to DOCX");
        let elapsed = started.elapsed();
        let bytes = fs::metadata(&output).expect("stat large DOCX").len();
        assert!(bytes > 0, "large reflow DOCX must not be empty");
        eprintln!(
            "RAIOPDF_WORD_LARGE_CANARY pages={pages} input_bytes={} output_bytes={bytes} elapsed_ms={}",
            fs::metadata(&input).expect("stat large PDF").len(),
            elapsed.as_millis()
        );
        let _ = fs::remove_dir_all(temp);
    }

    /// End-to-end round-trip of both Word features a user can invoke: import a
    /// `.docx` (DOCX -> PDF, the Import Word Document path) and then export it
    /// back to editable Word (PDF -> DOCX, the reflow path). Self-gates on Word
    /// like the other canaries, so it runs locally where Word is installed and
    /// skips cleanly where it isn't (e.g. CI).
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn word_export_import_roundtrip_canary_self_gates_on_word_capability() {
        let capability = word_capability(true).expect("Word capability probe should run");
        if capability.state != WordCapabilityState::Available {
            eprintln!(
                "skipping Word export/import round-trip canary: {:?} {:?}",
                capability.state, capability.reason
            );
            return;
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        let temp = std::env::temp_dir().join(format!(
            "raiopdf-word-roundtrip-canary-{}",
            std::process::id()
        ));
        fs::create_dir_all(&temp).expect("canary temp dir");

        // Import: DOCX -> PDF (what "Import Word Document" runs).
        let imported_pdf = temp.join("roundtrip.pdf");
        convert_docx_to_pdf(&root.join("clean.docx"), &imported_pdf, MarkupMode::Final)
            .expect("clean DOCX imports to PDF");
        let pdf_bytes = fs::read(&imported_pdf).expect("read imported pdf");
        assert!(pdf_bytes.starts_with(b"%PDF"));

        // Export: PDF -> DOCX (what "Export Editable Word" runs).
        let exported_docx = temp.join("roundtrip.docx");
        convert_pdf_to_docx(&imported_pdf, &exported_docx)
            .expect("imported PDF exports back to DOCX");
        let docx_file = fs::File::open(&exported_docx).expect("open round-trip docx");
        let mut archive = zip::ZipArchive::new(docx_file).expect("round-trip output is a zip");
        archive
            .by_name("word/document.xml")
            .expect("round-trip output contains word/document.xml");

        let _ = fs::remove_dir_all(temp);
    }

    /// Exercises the macOS batch contract with two documents under one held
    /// automation session. This is intentionally a maintainer-hardware canary:
    /// CI cannot grant Word Automation consent or provide a licensed Word app.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_word_batch_canary_self_gates_on_word_capability() {
        let capability = word_capability(true).expect("Word capability probe should run");
        if capability.state != WordCapabilityState::Available {
            eprintln!(
                "skipping macOS Word batch canary: {:?} {:?}",
                capability.state, capability.reason
            );
            return;
        }

        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        let temp =
            std::env::temp_dir().join(format!("raiopdf-word-batch-canary-{}", std::process::id()));
        fs::create_dir_all(&temp).expect("batch canary temp dir");
        let toolchain = PathOpsToolchain::discover(None);
        let mut session = MacosWordConversionSession::begin().expect("begin Word batch session");

        for (input_name, output_name, markup) in [
            ("clean.docx", "clean.pdf", MarkupMode::Final),
            (
                "tracked-changes.docx",
                "tracked-markup.pdf",
                MarkupMode::ShowMarkup,
            ),
        ] {
            let output = temp.join(output_name);
            session
                .convert_docx_to_pdf_with_toolchain(
                    &toolchain,
                    &fixtures.join(input_name),
                    &output,
                    markup,
                )
                .expect("batch item converts");
            let bytes = fs::read(&output).expect("read batch PDF");
            assert!(bytes.starts_with(b"%PDF"));
        }

        session.finish();
        let _ = fs::remove_dir_all(temp);
    }
}
