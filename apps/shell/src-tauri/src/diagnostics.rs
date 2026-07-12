use crate::sidecar::SidecarManager;
use engine_sidecar_core::{ENGINE_LOG_FILE_NAME, ENGINE_LOG_GENERATIONS};
use regex::Regex;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    backtrace::Backtrace,
    fs::{self, OpenOptions},
    io::{self, Write},
    panic::PanicHookInfo,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri_plugin_dialog::DialogExt;

const APP_LOG_FILE_NAME: &str = "app.log";
const APP_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const APP_LOG_GENERATIONS: usize = 2;
const LOG_EXPORT_MAX_BYTES: u64 = 96 * 1024;
/// Legacy single-slot session marker (pre-multi-instance versions). Read and
/// removed once by the startup scan; never written anymore.
const LEGACY_SESSION_STATE_FILE_NAME: &str = "session.state";
/// Per-instance session markers live here as `session-<instance-id>.state`.
/// One marker per running process: with several RaioPDF processes sharing
/// this app-data dir ("Open in New Window", the .pdf file association), a
/// single shared marker made every second instance report a phantom crash and
/// let its clean exit mask a real crash of the first.
const SESSIONS_DIR_NAME: &str = "sessions";
const SESSION_MARKER_PREFIX: &str = "session-";
const SESSION_MARKER_SUFFIX: &str = ".state";
const CRASH_REPORT_OPTOUT_FILE_NAME: &str = "crash-report.optout";
const CRASH_REPORT_LOG_TAIL_BYTES: u64 = 3500;
const CRASH_REPORT_BODY_MAX_CHARS: usize = 4500;
const CRASH_REPORT_BACKTRACE_MAX_CHARS: usize = 1800;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct AppDiagnostics {
    app_data_dir: PathBuf,
    app_log_path: PathBuf,
    sessions_dir: PathBuf,
    /// This process's own session marker. `None` when no instance identity
    /// could be acquired — session tracking is then disabled for this run
    /// rather than risking false crash prompts from other instances.
    session_state_path: Option<PathBuf>,
    instance_id: Option<String>,
    crash_report_optout_path: PathBuf,
    pending_crash_report: Mutex<Option<CrashReportPayload>>,
    log_lock: Mutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    source: String,
    kind: String,
    message: String,
    details: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExport {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportPayload {
    title: String,
    body: String,
}

#[derive(Debug, Clone)]
struct PendingCrashCapture {
    signature: Option<String>,
    backtrace: Option<String>,
}

impl AppDiagnostics {
    pub fn new(app_data_dir: PathBuf, instance_id: Option<String>) -> Self {
        let sessions_dir = app_data_dir.join(SESSIONS_DIR_NAME);
        let session_state_path = instance_id
            .as_deref()
            .map(|id| session_marker_path(&sessions_dir, id));
        Self {
            app_log_path: app_data_dir.join(APP_LOG_FILE_NAME),
            sessions_dir,
            session_state_path,
            instance_id,
            crash_report_optout_path: app_data_dir.join(CRASH_REPORT_OPTOUT_FILE_NAME),
            app_data_dir,
            pending_crash_report: Mutex::new(None),
            log_lock: Mutex::new(()),
        }
    }

    pub fn install_panic_hook(&self) {
        let app_log_path = self.app_log_path.clone();
        let session_state_path = self.session_state_path.clone();
        let default_hook = std::panic::take_hook();

        std::panic::set_hook(Box::new(move |info| {
            let signature = scrub_diagnostic_text(&panic_summary(info));
            let backtrace = truncate_chars(
                &scrub_diagnostic_text(&Backtrace::force_capture().to_string()),
                CRASH_REPORT_BACKTRACE_MAX_CHARS,
            );
            if let Some(session_state_path) = &session_state_path {
                let _ = write_crash_pending_marker(session_state_path, &signature, &backtrace);
            }
            let _ = append_diagnostic_line(
                &app_log_path,
                APP_LOG_MAX_BYTES,
                APP_LOG_GENERATIONS,
                &format!("{} shell panic {}", timestamp(), panic_summary(info)),
            );
            default_hook(info);
        }));
    }

    pub fn capture_pending_crash_for_startup(&self) -> Result<bool, String> {
        let capture = self.take_dead_session_capture()?;

        if capture.is_none() || self.crash_report_opted_out() {
            self.clear_pending_crash_report()?;
            return Ok(false);
        }

        let payload = self.build_crash_report_payload(capture.as_ref().expect("checked"))?;
        let mut pending = self
            .pending_crash_report
            .lock()
            .map_err(|_| "crash report lock poisoned".to_string())?;
        *pending = Some(payload);
        Ok(true)
    }

    pub fn mark_session_running(&self) -> Result<(), String> {
        match &self.session_state_path {
            Some(path) => write_session_state(path, "running"),
            None => Ok(()),
        }
    }

    pub fn mark_session_clean(&self) -> Result<(), String> {
        let Some(path) = &self.session_state_path else {
            return Ok(());
        };
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            // Couldn't delete the marker — degrade to the overwrite form so
            // the next scan still reads this exit as clean.
            Err(_) => write_session_state(path, "clean"),
        }
    }

    fn take_pending_crash_report(&self) -> Result<Option<CrashReportPayload>, String> {
        if self.crash_report_opted_out() {
            self.clear_pending_crash_report()?;
            return Ok(None);
        }

        let mut pending = self
            .pending_crash_report
            .lock()
            .map_err(|_| "crash report lock poisoned".to_string())?;
        Ok(pending.take())
    }

    fn set_crash_report_opted_out(&self, value: bool) -> Result<(), String> {
        if !value {
            match fs::remove_file(&self.crash_report_optout_path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(format!("failed to save crash report preference: {error}"));
                }
            }
        }

        if let Some(parent) = self.crash_report_optout_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create app data directory: {error}"))?;
        }

        fs::write(&self.crash_report_optout_path, "never\n")
            .map_err(|error| format!("failed to save crash report preference: {error}"))?;
        self.clear_pending_crash_report()
    }

    fn clear_pending_crash_report(&self) -> Result<(), String> {
        let mut pending = self
            .pending_crash_report
            .lock()
            .map_err(|_| "crash report lock poisoned".to_string())?;
        *pending = None;
        Ok(())
    }

    fn crash_report_opted_out(&self) -> bool {
        self.crash_report_optout_path.exists()
    }

    /// Find the first genuine unclean exit among session markers whose owning
    /// instance is dead, consuming markers as it goes. Markers of live
    /// instances (a second window running right now) are ignored — with a
    /// single shared marker, a second instance used to read the first one's
    /// `running` state as a phantom crash. One crash is reported per startup;
    /// further dead markers wait for later startups.
    fn take_dead_session_capture(&self) -> Result<Option<PendingCrashCapture>, String> {
        // Legacy single-slot marker from pre-multi-instance versions: its
        // writer is by definition not this process; consume it once.
        let legacy_path = self.app_data_dir.join(LEGACY_SESSION_STATE_FILE_NAME);
        if legacy_path.exists() {
            let state = fs::read_to_string(&legacy_path)
                .map_err(|error| format!("failed to read crash marker: {error}"))?;
            let _ = fs::remove_file(&legacy_path);
            if let Some(capture) = parse_unclean_session_state(&state) {
                return Ok(Some(capture));
            }
        }

        let entries = match fs::read_dir(&self.sessions_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("failed to scan session markers: {error}")),
        };
        let mut marker_paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        marker_paths.sort();

        for path in marker_paths {
            let Some(owner_id) = session_marker_owner_id(&path) else {
                continue;
            };
            if Some(owner_id.as_str()) == self.instance_id.as_deref() {
                continue;
            }
            match crate::instance::owner_liveness(&self.app_data_dir, &owner_id) {
                crate::instance::Liveness::Alive | crate::instance::Liveness::Unknown => continue,
                crate::instance::Liveness::Dead => {}
            }
            let capture = fs::read_to_string(&path)
                .ok()
                .and_then(|state| parse_unclean_session_state(&state));
            // Dead marker: consumed either way (a clean one is just cleanup).
            let _ = fs::remove_file(&path);
            if capture.is_some() {
                return Ok(capture);
            }
        }

        Ok(None)
    }

    fn build_crash_report_payload(
        &self,
        capture: &PendingCrashCapture,
    ) -> Result<CrashReportPayload, String> {
        let signature = capture.signature.as_deref().unwrap_or(
            "Previous session ended without a panic signature. This can happen after a force quit, process kill, power loss, or operating-system crash.",
        );
        let backtrace = capture
            .backtrace
            .as_deref()
            .unwrap_or("No panic backtrace was captured for this exit.");
        let app_log_tail = if self.app_log_path.exists() {
            read_tail(&self.app_log_path, CRASH_REPORT_LOG_TAIL_BYTES)
                .map_err(|error| format!("failed to read application log: {error}"))?
        } else {
            "No application log was available.".to_string()
        };
        let app_log_tail = scrub_diagnostic_text(&app_log_tail);
        let signature = scrub_diagnostic_text(signature);
        let backtrace = scrub_diagnostic_text(backtrace);

        let mut body = String::new();
        body.push_str("RaioPDF crash report\n");
        body.push_str("====================\n\n");
        body.push_str("RaioPDF noticed the previous session did not exit cleanly. The app did not send this report anywhere; you can review and submit it yourself.\n\n");
        body.push_str(&format!("App version: {}\n", env!("CARGO_PKG_VERSION")));
        body.push_str(&format!("OS: {}\n", os_description()));
        body.push_str(&format!("Arch: {}\n\n", std::env::consts::ARCH));
        body.push_str("Crash\n");
        body.push_str("-----\n");
        body.push_str(&format!("Signature: {signature}\n\n"));
        body.push_str("Backtrace:\n");
        body.push_str(&backtrace);
        if !backtrace.ends_with('\n') {
            body.push('\n');
        }
        body.push('\n');
        body.push_str("Application log tail (scrubbed)\n");
        body.push_str("-------------------------------\n");
        body.push_str(&app_log_tail);
        if !app_log_tail.ends_with('\n') {
            body.push('\n');
        }

        let body = truncate_chars(&scrub_diagnostic_text(&body), CRASH_REPORT_BODY_MAX_CHARS);
        let short_signature = truncate_single_line(&signature, 72);
        let title = if short_signature.is_empty() {
            "Crash report: previous session ended uncleanly".to_string()
        } else {
            format!("Crash report: {short_signature}")
        };

        Ok(CrashReportPayload {
            title: scrub_diagnostic_text(&title),
            body,
        })
    }

    pub fn record_shell_event(&self, kind: &str, message: &str) -> Result<(), String> {
        self.record_line("shell", kind, message, None)
    }

    fn record_event(&self, event: DiagnosticEvent) -> Result<(), String> {
        self.record_line(
            &event.source,
            &event.kind,
            &event.message,
            event.details.as_deref(),
        )
    }

    fn record_line(
        &self,
        source: &str,
        kind: &str,
        message: &str,
        details: Option<&str>,
    ) -> Result<(), String> {
        let _guard = self
            .log_lock
            .lock()
            .map_err(|_| "diagnostic log lock poisoned".to_string())?;
        let mut line = format!(
            "{} {} {} {}",
            timestamp(),
            log_token(source),
            log_token(kind),
            compact_log_field(message)
        );

        if let Some(details) = details {
            line.push_str(" | ");
            line.push_str(&compact_log_field(details));
        }

        append_diagnostic_line(
            &self.app_log_path,
            APP_LOG_MAX_BYTES,
            APP_LOG_GENERATIONS,
            &line,
        )
        .map_err(|error| format!("failed to write diagnostic log: {error}"))
    }

    fn build_report(
        &self,
        engine_status: Result<serde_json::Value, String>,
    ) -> Result<String, String> {
        let mut report = String::new();
        report.push_str("RaioPDF diagnostics\n");
        report.push_str("===================\n\n");
        report.push_str(&format!("Generated: {}\n", timestamp()));
        report.push_str(&format!("App version: {}\n", env!("CARGO_PKG_VERSION")));
        report.push_str(&format!("Target OS: {}\n", std::env::consts::OS));
        report.push_str(&format!("Target arch: {}\n", std::env::consts::ARCH));
        report.push_str(&format!(
            "Rust debug assertions: {}\n",
            cfg!(debug_assertions)
        ));
        report.push_str("Release debug symbols: line-tables-only (profile.release.debug = 1)\n");
        report.push_str("Telemetry: none. This file was saved locally and not sent anywhere.\n");
        report.push_str("Crash reporting: reports are never sent automatically. After an unclean exit RaioPDF may ask once whether to report it; you review and submit each report yourself via GitHub, and can turn the prompt off.\n");
        report.push_str("Log policy: local logs are scrubbed and truncated in this export.\n\n");

        report.push_str("Engine status\n");
        report.push_str("-------------\n");
        match engine_status {
            Ok(status) => {
                report.push_str(
                    &serde_json::to_string_pretty(&status).unwrap_or_else(|_| {
                        "{\"error\":\"status serialization failed\"}".to_string()
                    }),
                );
                report.push('\n');
            }
            Err(error) => {
                report.push_str(&format!("Unavailable: {}\n", scrub_diagnostic_text(&error)));
            }
        }
        report.push('\n');

        append_log_section(
            &mut report,
            "Application log",
            &collect_log_paths(&self.app_log_path, APP_LOG_GENERATIONS),
        )?;
        append_log_section(
            &mut report,
            "Engine log",
            &collect_log_paths(
                &self.app_data_dir.join(ENGINE_LOG_FILE_NAME),
                ENGINE_LOG_GENERATIONS,
            ),
        )?;

        Ok(report)
    }
}

#[tauri::command]
pub fn diagnostics_record_event(
    diagnostics: tauri::State<'_, AppDiagnostics>,
    event: DiagnosticEvent,
) -> Result<(), String> {
    diagnostics.record_event(event)
}

#[tauri::command]
pub fn diagnostics_export_dialog(
    app: tauri::AppHandle,
    diagnostics: tauri::State<'_, AppDiagnostics>,
    manager: tauri::State<'_, SidecarManager>,
) -> Result<Option<DiagnosticExport>, String> {
    diagnostics.record_shell_event("diagnostics_export", "export requested")?;

    let default_name = format!("raiopdf-diagnostics-{}.txt", timestamp_file_part());
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Text", &["txt"])
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        diagnostics.record_shell_event("diagnostics_export", "export canceled")?;
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    let engine_status = manager
        .engine_status()
        .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()));
    let report = diagnostics.build_report(engine_status)?;

    fs::write(&path, report)
        .map_err(|error| format!("failed to write diagnostics export: {error}"))?;
    diagnostics.record_shell_event(
        "diagnostics_export",
        &format!("export saved to {}", path.to_string_lossy()),
    )?;

    Ok(Some(DiagnosticExport {
        path: path.to_string_lossy().into_owned(),
    }))
}

#[tauri::command]
pub fn crash_report_take_pending(
    diagnostics: tauri::State<'_, AppDiagnostics>,
) -> Result<Option<CrashReportPayload>, String> {
    diagnostics.take_pending_crash_report()
}

#[tauri::command]
pub fn crash_report_never_ask(diagnostics: tauri::State<'_, AppDiagnostics>) -> Result<(), String> {
    diagnostics.set_crash_report_opted_out(true)
}

#[tauri::command]
pub fn crash_report_is_opted_out(diagnostics: tauri::State<'_, AppDiagnostics>) -> bool {
    diagnostics.crash_report_opted_out()
}

#[tauri::command]
pub fn crash_report_set_opted_out(
    diagnostics: tauri::State<'_, AppDiagnostics>,
    value: bool,
) -> Result<(), String> {
    diagnostics.set_crash_report_opted_out(value)
}

fn append_log_section(report: &mut String, title: &str, paths: &[PathBuf]) -> Result<(), String> {
    report.push_str(title);
    report.push('\n');
    report.push_str(&"-".repeat(title.len()));
    report.push('\n');

    let mut found = false;
    for path in paths {
        if !path.exists() {
            continue;
        }

        found = true;
        let label = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("log");
        report.push_str(&format!("### {label}\n"));
        let text = read_tail(path, LOG_EXPORT_MAX_BYTES)
            .map_err(|error| format!("failed to read {}: {error}", path.to_string_lossy()))?;
        report.push_str(&scrub_diagnostic_text(&text));
        if !text.ends_with('\n') {
            report.push('\n');
        }
        report.push('\n');
    }

    if !found {
        report.push_str("No log file exists yet.\n\n");
    }

    Ok(())
}

fn collect_log_paths(path: &Path, generations: usize) -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(generations + 1);
    paths.push(path.to_path_buf());
    for generation in 1..=generations {
        paths.push(rotated_log_path(path, generation));
    }
    paths
}

fn append_diagnostic_line(
    path: &Path,
    max_bytes: u64,
    generations: usize,
    line: &str,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let bytes_to_write = line.len() as u64 + 1;
    if path.exists() {
        let current_len = fs::metadata(path)?.len();
        if current_len.saturating_add(bytes_to_write) > max_bytes {
            rotate_log(path, generations)?;
        }
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn rotate_log(path: &Path, generations: usize) -> io::Result<()> {
    for index in (1..=generations).rev() {
        let from = if index == 1 {
            path.to_path_buf()
        } else {
            rotated_log_path(path, index - 1)
        };
        let to = rotated_log_path(path, index);

        if !from.exists() {
            continue;
        }

        if to.exists() {
            fs::remove_file(&to)?;
        }
        fs::rename(from, to)?;
    }

    Ok(())
}

fn rotated_log_path(path: &Path, generation: usize) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(APP_LOG_FILE_NAME);

    path.with_file_name(format!("{file_name}.{generation}"))
}

fn read_tail(path: &Path, max_bytes: u64) -> io::Result<String> {
    let bytes = fs::read(path)?;
    let start = bytes.len().saturating_sub(max_bytes as usize);
    let mut text = String::from_utf8_lossy(&bytes[start..]).into_owned();

    if start > 0 {
        if let Some(index) = text.find('\n') {
            text.replace_range(..=index, "[truncated]\n");
        } else {
            text = "[truncated]\n".to_string();
        }
    }

    Ok(text)
}

fn session_marker_path(sessions_dir: &Path, instance_id: &str) -> PathBuf {
    sessions_dir.join(format!(
        "{SESSION_MARKER_PREFIX}{instance_id}{SESSION_MARKER_SUFFIX}"
    ))
}

fn session_marker_owner_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name
        .strip_prefix(SESSION_MARKER_PREFIX)?
        .strip_suffix(SESSION_MARKER_SUFFIX)?;
    crate::instance::is_valid_owner_id(id).then(|| id.to_string())
}

fn write_session_state(path: &Path, state: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app data directory: {error}"))?;
    }

    fs::write(path, format!("{state}\n"))
        .map_err(|error| format!("failed to write crash marker: {error}"))
}

fn write_crash_pending_marker(path: &Path, signature: &str, backtrace: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app data directory: {error}"))?;
    }

    let mut marker = String::new();
    marker.push_str("crash-pending\n");
    marker.push_str("signature: ");
    marker.push_str(&single_line(signature));
    marker.push('\n');
    marker.push_str("backtrace:\n");
    marker.push_str(backtrace);
    if !backtrace.ends_with('\n') {
        marker.push('\n');
    }

    fs::write(path, marker).map_err(|error| format!("failed to write crash marker: {error}"))
}

fn parse_unclean_session_state(state: &str) -> Option<PendingCrashCapture> {
    let trimmed = state.trim();

    if trimmed.is_empty() || trimmed == "clean" {
        return None;
    }

    if !trimmed.starts_with("crash-pending") {
        return Some(PendingCrashCapture {
            signature: None,
            backtrace: None,
        });
    }

    let signature = state
        .lines()
        .find_map(|line| line.strip_prefix("signature: "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned);
    let backtrace = state
        .split_once("backtrace:\n")
        .map(|(_, backtrace)| backtrace.trim().to_string())
        .filter(|backtrace| !backtrace.is_empty());

    Some(PendingCrashCapture {
        signature,
        backtrace,
    })
}

fn scrub_diagnostic_text(text: &str) -> String {
    static WINDOWS_PATH: OnceLock<Regex> = OnceLock::new();
    static UNIX_PATH: OnceLock<Regex> = OnceLock::new();
    static EMAIL: OnceLock<Regex> = OnceLock::new();
    static FILE_NAME: OnceLock<Regex> = OnceLock::new();
    static LONG_NUMBER: OnceLock<Regex> = OnceLock::new();
    static LONG_QUOTED: OnceLock<Regex> = OnceLock::new();

    let text = WINDOWS_PATH
        .get_or_init(|| {
            Regex::new(r#"(?i)\b[a-z]:[\\/](?:[^\\/\r\n"<>|]+[\\/])*[^\\/\r\n"<>|]*?(?:\.(?:pdf|png|jpe?g|tiff?|txt|hocr|log|tmp|exe|jar|cmd|ya?ml)\b|\s|$)"#)
                .expect("valid regex")
        })
        .replace_all(text, "[path]");
    let text = UNIX_PATH
        .get_or_init(|| {
            Regex::new(r#"(?i)(?:/Users|/home|/tmp|/var/folders|/private/var|/mnt/[a-z]|/Volumes)/(?:[^/\r\n"<>|]+/)*[^/\r\n"<>|]*?(?:\.(?:pdf|png|jpe?g|tiff?|txt|hocr|log|tmp|exe|jar|cmd|ya?ml)\b|\s|$)"#)
                .expect("valid regex")
        })
        .replace_all(&text, "[path]");
    let text = EMAIL
        .get_or_init(|| {
            Regex::new(r#"(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}"#).expect("valid regex")
        })
        .replace_all(&text, "[email]");
    let text = FILE_NAME
        .get_or_init(|| {
            Regex::new(r#"(?i)\b[^\s"'<>|\\/]+(?:\s+[^\s"'<>|\\/]+){0,8}\.(?:pdf|png|jpe?g|tiff?|txt|hocr|log|tmp)\b"#)
                .expect("valid regex")
        })
        .replace_all(&text, "[file]");
    let text = LONG_NUMBER
        .get_or_init(|| Regex::new(r#"\b\d{8,}\b"#).expect("valid regex"))
        .replace_all(&text, "[number]");
    let text = LONG_QUOTED
        .get_or_init(|| Regex::new(r#""[^"\r\n]{80,}""#).expect("valid regex"))
        .replace_all(&text, "\"[text]\"");

    text.into_owned()
}

fn compact_log_field(value: &str) -> String {
    value
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn log_token(value: &str) -> String {
    value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '_' | '-' | '.') {
                char
            } else {
                '_'
            }
        })
        .collect()
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    format!("unix:{seconds}")
}

fn timestamp_file_part() -> String {
    timestamp().replace(':', "-")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n[truncated]\n");
    truncated
}

fn single_line(value: &str) -> String {
    value
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_single_line(value: &str, max_chars: usize) -> String {
    let value = single_line(value);

    if value.chars().count() <= max_chars {
        return value;
    }

    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

fn os_description() -> String {
    format!("{} {}", std::env::consts::OS, os_version())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "linux")]
fn os_version() -> String {
    fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|contents| {
            contents.lines().find_map(|line| {
                line.strip_prefix("PRETTY_NAME=")
                    .map(|value| value.trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| "version unavailable".to_string())
}

#[cfg(target_os = "macos")]
fn os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "version unavailable".to_string())
}

#[cfg(target_os = "windows")]
fn os_version() -> String {
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", "ver"]);
    apply_platform_spawn_flags(&mut command);

    command
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "version unavailable".to_string())
}

// Windows-only on purpose: the sole caller is the Windows os_version(), so a
// non-Windows stub would be dead code and fail the deny-warnings lint.
#[cfg(windows)]
fn apply_platform_spawn_flags(command: &mut std::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn os_version() -> String {
    "version unavailable".to_string()
}

fn panic_summary(info: &PanicHookInfo<'_>) -> String {
    let payload = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("panic");
    let location = info
        .location()
        .map(|location| format!("{}:{}", location.file(), location.line()))
        .unwrap_or_else(|| "unknown location".to_string());

    format!("{} at {}", compact_log_field(payload), location)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "raiopdf-diagnostics-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("temp dir");
        root
    }

    /// A diagnostics handle standing in for the freshly-started instance that
    /// runs the startup scan. Dead-instance markers in tests use other ids
    /// with no lock file, which `owner_liveness` reports as dead.
    fn diagnostics_for(root: &Path, instance_id: &str) -> AppDiagnostics {
        AppDiagnostics::new(root.to_path_buf(), Some(instance_id.to_string()))
    }

    fn marker_path(root: &Path, instance_id: &str) -> PathBuf {
        session_marker_path(&root.join(SESSIONS_DIR_NAME), instance_id)
    }

    fn write_marker(root: &Path, instance_id: &str, content: &str) {
        let path = marker_path(root, instance_id);
        fs::create_dir_all(path.parent().expect("sessions dir")).expect("create sessions dir");
        fs::write(path, content).expect("write session marker");
    }

    #[test]
    fn exported_logs_scrub_paths_file_names_email_and_long_values() {
        let raw = r#"OCRmyPDF C:\Users\Jacob Schumer\AppData\Local\Temp\Smith v Jones Motion.pdf /tmp/raio/out.hocr jane@example.com 123456789012 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa""#;

        let scrubbed = scrub_diagnostic_text(raw);

        assert!(!scrubbed.contains("Jacob"));
        assert!(!scrubbed.contains("Smith v Jones"));
        assert!(!scrubbed.contains("jane@example.com"));
        assert!(!scrubbed.contains("123456789012"));
        assert!(scrubbed.contains("[path]"));
        assert!(scrubbed.contains("[email]"));
        assert!(scrubbed.contains("[number]"));
        assert!(scrubbed.contains("\"[text]\""));
    }

    #[test]
    fn app_log_rotation_keeps_bounded_generations() {
        let root = temp_root("rotation");
        let log = root.join(APP_LOG_FILE_NAME);

        append_diagnostic_line(&log, 10, 2, "1234567890abc").expect("write one");
        append_diagnostic_line(&log, 10, 2, "defghijklmn").expect("write two");
        append_diagnostic_line(&log, 10, 2, "opqrstuvwxyz").expect("write three");

        assert!(log.exists());
        assert!(rotated_log_path(&log, 1).exists());
        assert!(rotated_log_path(&log, 2).exists());
        assert!(!rotated_log_path(&log, 3).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_marker_writes_running_and_removes_on_clean_exit() {
        let root = temp_root("marker");
        let diagnostics = diagnostics_for(&root, "self-a");

        diagnostics.mark_session_running().expect("mark running");
        assert_eq!(
            fs::read_to_string(marker_path(&root, "self-a")).expect("read running"),
            "running\n"
        );

        diagnostics.mark_session_clean().expect("mark clean");
        assert!(!marker_path(&root, "self-a").exists());
        // Marking clean twice stays fine (marker already gone).
        diagnostics.mark_session_clean().expect("mark clean again");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_marks_are_noops_without_an_instance_identity() {
        let root = temp_root("no-identity");
        let diagnostics = AppDiagnostics::new(root.clone(), None);

        diagnostics.mark_session_running().expect("mark running");
        diagnostics.mark_session_clean().expect("mark clean");
        assert!(!root.join(SESSIONS_DIR_NAME).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dead_instances_running_marker_becomes_one_time_pending_crash() {
        let root = temp_root("running-pending");
        // "dead-1" has no lock file under instances/ — its owner is dead.
        write_marker(&root, "dead-1", "running\n");
        fs::write(root.join(APP_LOG_FILE_NAME), "startup before hard kill\n").expect("log");
        let diagnostics = diagnostics_for(&root, "live-self");

        assert!(diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        let payload = diagnostics
            .take_pending_crash_report()
            .expect("take")
            .expect("payload");
        assert!(payload.body.contains("without a panic signature"));
        assert!(payload.body.contains("No panic backtrace was captured"));
        assert!(diagnostics
            .take_pending_crash_report()
            .expect("second take")
            .is_none());
        // The marker was consumed — a restart does not re-report the crash.
        assert!(!marker_path(&root, "dead-1").exists());
        let next = diagnostics_for(&root, "live-self-2");
        assert!(!next.capture_pending_crash_for_startup().expect("recapture"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn live_instances_running_marker_is_not_a_crash() {
        let root = temp_root("live-ignored");
        let other = crate::instance::InstanceIdentity::acquire(&root).expect("acquire other");
        write_marker(&root, other.id(), "running\n");
        let diagnostics = diagnostics_for(&root, "live-self");

        // A second window's running session must not prompt a phantom crash…
        assert!(!diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        // …and its marker must be left alone.
        assert!(marker_path(&root, other.id()).exists());

        // Once that instance dies uncleanly (lock released, marker left), the
        // same marker becomes a genuine crash for the next scan.
        let other_id = other.id().to_string();
        drop(other);
        let next = diagnostics_for(&root, "live-self-2");
        assert!(next.capture_pending_crash_for_startup().expect("capture"));
        assert!(!marker_path(&root, &other_id).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn own_marker_and_clean_dead_markers_are_skipped_and_cleaned() {
        let root = temp_root("own-and-clean");
        write_marker(&root, "live-self", "running\n");
        write_marker(&root, "dead-clean", "clean\n");
        let diagnostics = diagnostics_for(&root, "live-self");

        assert!(!diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        // Our own marker survives; the dead instance's clean marker is
        // housekept away without a prompt.
        assert!(marker_path(&root, "live-self").exists());
        assert!(!marker_path(&root, "dead-clean").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_single_slot_marker_is_migrated_once() {
        let root = temp_root("legacy-migrate");
        fs::write(root.join(LEGACY_SESSION_STATE_FILE_NAME), "running\n").expect("legacy state");
        let diagnostics = diagnostics_for(&root, "live-self");

        assert!(diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        assert!(!root.join(LEGACY_SESSION_STATE_FILE_NAME).exists());
        let next = diagnostics_for(&root, "live-self-2");
        assert!(!next.capture_pending_crash_for_startup().expect("recapture"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crash_pending_marker_keeps_signature_and_backtrace() {
        let root = temp_root("crash-pending");
        write_crash_pending_marker(
            &marker_path(&root, "dead-2"),
            "panic while rendering",
            "frame one\nframe two",
        )
        .expect("state");
        let diagnostics = diagnostics_for(&root, "live-self");

        assert!(diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        let payload = diagnostics
            .take_pending_crash_report()
            .expect("take")
            .expect("payload");

        assert!(payload.title.contains("panic while rendering"));
        assert!(payload.body.contains("Signature: panic while rendering"));
        assert!(payload.body.contains("frame one"));
        assert!(payload.body.contains("frame two"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crash_report_payload_scrubs_log_tail_and_bounds_body() {
        let root = temp_root("scrub-payload");
        write_marker(&root, "dead-3", "running\n");
        fs::write(
            root.join(APP_LOG_FILE_NAME),
            r#"failed /home/jacob/cases/Smith v Jones Motion.pdf jane@example.com "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" 123456789012"#,
        )
        .expect("log");
        let diagnostics = diagnostics_for(&root, "live-self");

        assert!(diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        let payload = diagnostics
            .take_pending_crash_report()
            .expect("take")
            .expect("payload");

        assert!(!payload.body.contains("Smith v Jones"));
        assert!(!payload.body.contains("jane@example.com"));
        assert!(!payload.body.contains("123456789012"));
        assert!(payload.body.contains("[file]") || payload.body.contains("[path]"));
        assert!(payload.body.contains("[email]"));
        assert!(payload.body.len() <= CRASH_REPORT_BODY_MAX_CHARS + "[truncated]\n".len() + 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn never_ask_persists_and_suppresses_future_pending_crashes() {
        let root = temp_root("optout");
        write_marker(&root, "dead-4", "running\n");
        let diagnostics = diagnostics_for(&root, "live-self");

        assert!(diagnostics
            .capture_pending_crash_for_startup()
            .expect("capture"));
        diagnostics
            .set_crash_report_opted_out(true)
            .expect("save optout");
        assert!(root.join(CRASH_REPORT_OPTOUT_FILE_NAME).exists());
        assert!(diagnostics
            .take_pending_crash_report()
            .expect("take")
            .is_none());

        // Another unclean exit after opting out never prompts again.
        write_marker(&root, "dead-5", "running\n");
        let next_diagnostics = diagnostics_for(&root, "live-self-2");
        assert!(!next_diagnostics
            .capture_pending_crash_for_startup()
            .expect("recapture"));
        assert!(next_diagnostics
            .take_pending_crash_report()
            .expect("take after optout")
            .is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn set_crash_report_opted_out_false_removes_optout_file() {
        let root = temp_root("optout-toggle");
        let diagnostics = diagnostics_for(&root, "live-self");

        diagnostics
            .set_crash_report_opted_out(true)
            .expect("save optout");
        assert!(diagnostics.crash_report_opted_out());
        assert!(root.join(CRASH_REPORT_OPTOUT_FILE_NAME).exists());

        diagnostics
            .set_crash_report_opted_out(false)
            .expect("remove optout");

        assert!(!diagnostics.crash_report_opted_out());
        assert!(!root.join(CRASH_REPORT_OPTOUT_FILE_NAME).exists());

        let _ = fs::remove_dir_all(root);
    }
}
