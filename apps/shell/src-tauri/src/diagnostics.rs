use crate::sidecar::SidecarManager;
use engine_sidecar_core::{ENGINE_LOG_FILE_NAME, ENGINE_LOG_GENERATIONS};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
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

pub struct AppDiagnostics {
    app_data_dir: PathBuf,
    app_log_path: PathBuf,
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

impl AppDiagnostics {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            app_log_path: app_data_dir.join(APP_LOG_FILE_NAME),
            app_data_dir,
            log_lock: Mutex::new(()),
        }
    }

    pub fn install_panic_hook(&self) {
        let app_log_path = self.app_log_path.clone();
        let default_hook = std::panic::take_hook();

        std::panic::set_hook(Box::new(move |info| {
            let _ = append_diagnostic_line(
                &app_log_path,
                APP_LOG_MAX_BYTES,
                APP_LOG_GENERATIONS,
                &format!("{} shell panic {}", timestamp(), panic_summary(info)),
            );
            default_hook(info);
        }));
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
        report.push_str("Crash reporting: not configured in this phase.\n");
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
        let root = env::temp_dir().join(format!(
            "raiopdf-diagnostics-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("temp dir");
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
}
