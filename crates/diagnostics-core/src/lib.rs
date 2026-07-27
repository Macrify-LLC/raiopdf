//! Diagnostics policy shared by every RaioPDF process.
//!
//! Redaction lives here, in ONE place, because more than one process has to
//! apply it: the desktop shell writes and exports diagnostics, and the standalone
//! engine-host serves them to the MCP connector. Two implementations of a
//! confidentiality rule would mean the weaker one silently becomes the
//! guarantee, so there is exactly one.

use regex::Regex;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// The desktop shell's application log. Canonical HERE rather than in the shell,
/// because both the writer (shell) and the readers (export, MCP payload) must
/// agree on it — and a reader that restates the writer's truth silently returns
/// nothing the day the writer changes.
pub const APP_LOG_FILE_NAME: &str = "app.log";

/// How many rotated generations exist beside a live log. One number for the
/// writer and every reader, for the same reason.
pub const LOG_GENERATIONS: usize = 2;

/// One marker, so every surface names a truncation identically.
pub const TRUNCATION_MARKER: &str = "[older lines truncated]";
const TRUNCATION_MARKER_LINE: &str = "[older lines truncated]\n";

pub fn scrub_diagnostic_text(text: &str) -> String {
    static UNC_PATH: OnceLock<Regex> = OnceLock::new();
    static WINDOWS_PATH: OnceLock<Regex> = OnceLock::new();
    static UNIX_PATH: OnceLock<Regex> = OnceLock::new();
    static EMAIL: OnceLock<Regex> = OnceLock::new();
    static FILE_NAME: OnceLock<Regex> = OnceLock::new();
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    static LONG_QUOTED: OnceLock<Regex> = OnceLock::new();

    // UNC / network shares FIRST, before the drive-letter form.
    //
    // This is the shape a firm on a file server actually uses, and it has no drive
    // letter, so the drive-letter pattern never matched it. Left alone, only the
    // basename was removed and `\\FILESRV\Clients\Smith v Acme\` survived intact --
    // the directory is the client and the matter, so this leaked the most sensitive
    // component and kept it. Covers `\\server\share\...`, the `\\?\UNC\...` form
    // `fs::canonicalize` produces on Windows, and the forward-slash spelling.
    let text = UNC_PATH
        .get_or_init(|| {
            Regex::new(r#"(?i)(?:\\\\\?\\UNC\\|\\\\|//)(?:[^\\/\r\n"<>|]+[\\/]+)*(?:[^\\/\r\n"<>|]*?\.(?:pdf|docx?|png|jpe?g|tiff?|txt|hocr|log|tmp|exe|jar|cmd|ya?ml)\b|[^\s\\/\r\n"<>|]*)"#)
                .expect("valid regex")
        })
        .replace_all(text, "[path]");
    // Drive-letter paths. `[\\/]*` (not `+`) also catches the drive-relative form
    // `C:Clients\Smith v Acme\...`, which has no separator after the colon.
    let text = WINDOWS_PATH
        .get_or_init(|| {
            Regex::new(r#"(?i)\b[a-z]:[\\/]*(?:[^\\/\r\n"<>|]+[\\/]+)*(?:[^\\/\r\n"<>|]*?\.(?:pdf|docx?|png|jpe?g|tiff?|txt|hocr|log|tmp|exe|jar|cmd|ya?ml)\b|[^\s\\/\r\n"<>|]*)"#)
                .expect("valid regex")
        })
        .replace_all(&text, "[path]");
    // POSIX roots. Deliberately an allow-list rather than "any absolute path":
    // removing every `/usr/bin/...` and `/Applications/...` would gut the log's
    // diagnostic value while protecting nobody. The roots below are the ones that
    // hold user documents, including network mounts (`/net`, `/srv`, `/media`).
    let text = UNIX_PATH
        .get_or_init(|| {
            Regex::new(r#"(?i)(?:/Users|/home|/tmp|/var/folders|/private/var|/mnt/[a-z]|/Volumes|/net|/srv|/media|~|\$HOME|%USERPROFILE%)/+(?:[^/\r\n"<>|]+/+)*(?:[^/\r\n"<>|]*?\.(?:pdf|docx?|png|jpe?g|tiff?|txt|hocr|log|tmp|exe|jar|cmd|ya?ml)\b|[^\s/\r\n"<>|]*)"#)
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
            Regex::new(r#"(?i)\b[^\s"'<>|\\/]+(?:\s+[^\s"'<>|\\/]+){0,8}\.(?:pdf|docx?|png|jpe?g|tiff?|txt|hocr|log|tmp)\b"#)
                .expect("valid regex")
        })
        .replace_all(&text, "[file]");
    // Long digit runs, plus the dashed shapes a matter file actually contains
    // (SSNs and phone numbers) -- the product ships a Fla. R. Jud. Admin. 2.425
    // scanner for exactly those, so leaving them in a diagnostic was inconsistent.
    //
    // `unix:<seconds>` is exempt. Log timestamps are 10 digits, so redacting them
    // left an assistant unable to order events, tell today's failure from last
    // month's, or separate live lines from rotated ones -- which is most of what
    // makes a log tail diagnosable at all.
    let text = NUMBER
        .get_or_init(|| {
            Regex::new(r#"(?i)unix:\d+|\b\d{3}-\d{2}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b|\b\d{8,}\b"#)
                .expect("valid regex")
        })
        .replace_all(&text, |captures: &regex::Captures<'_>| {
            let matched = &captures[0];
            if matched.starts_with("unix:") || matched.starts_with("UNIX:") {
                matched.to_string()
            } else {
                "[number]".to_string()
            }
        });
    let text = LONG_QUOTED
        .get_or_init(|| Regex::new(r#""[^"\r\n]{80,}""#).expect("valid regex"))
        .replace_all(&text, "\"[text]\"");

    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The redaction contract.
    ///
    /// This is the fixture that makes a diagnostics payload safe to hand to an
    /// outside reader. Every case is a realistic way a client or matter name
    /// reaches a log line on an attorney's machine. A regression here is a
    /// confidentiality failure, not a failing unit test -- treat it as a release
    /// gate.
    ///
    /// Note what each case asserts: that the DIRECTORY components are gone. An
    /// earlier version only checked that some redaction marker appeared, which
    /// every one of these cases satisfied while still leaking the client and
    /// matter folders -- the file-name rule always fires on the basename, so a
    /// partially-redacted line was indistinguishable from a clean one.
    #[test]
    fn redaction_contract_removes_client_and_matter_identifiers() {
        let cases: [(&str, &str, &[&str]); 16] = [
            (
                "UNC network share (the shape a firm on a file server uses)",
                r"unix:1770000000 shell path_op_ocr io: input \\FILESRV01\Clients\Smith v Acme\2024 Complaint.pdf: not found",
                &["FILESRV01", "Clients", "Smith", "Acme", "Complaint"],
            ),
            (
                "canonicalized UNC (\\\\?\\UNC form)",
                r"input \\?\UNC\FILESRV01\Clients\Smith v Acme\complaint.pdf",
                &["FILESRV01", "Clients", "Smith", "Acme"],
            ),
            (
                "UNC with forward slashes",
                r"input //FILESRV01/Clients/Smith v Acme/complaint.pdf",
                &["FILESRV01", "Smith", "Acme"],
            ),
            (
                "UNC directory with no file name at all",
                r"outdir \\FILESRV01\Clients\Smith v Acme\Production",
                &["FILESRV01", "Clients", "Smith", "Acme", "Production"],
            ),
            (
                "JSON-escaped UNC",
                r#"{"file":"\\\\FILESRV\\Clients\\Smith v Acme\\complaint.pdf"}"#,
                &["FILESRV", "Clients", "Smith", "Acme"],
            ),
            (
                "windows drive-relative path (no separator after the colon)",
                r"input C:Clients\Smith v Acme\complaint.pdf",
                &["Clients", "Smith", "Acme"],
            ),
            (
                "autofs / network mount outside /Volumes",
                r"input /net/fileserver/Clients/Smith v Acme/complaint.pdf",
                &["fileserver", "Clients", "Smith", "Acme"],
            ),
            (
                "posix path after an = label",
                r"input=/Users/Jane Doe/Matters/Smith v. Acme/Complaint.pdf",
                &["Jane Doe", "Matters", "Smith", "Acme", "Complaint"],
            ),
            (
                "posix path after a uri scheme",
                r"file:/Volumes/Firm Files/Client A/Privilege Log.pdf",
                &["Firm Files", "Client A", "Privilege Log"],
            ),
            (
                "home-relative path",
                r"~/Library/CloudStorage/OneDrive-Firm/Acme Merger/closing.pdf",
                &["OneDrive-Firm", "Acme Merger", "closing"],
            ),
            (
                "$HOME-relative path",
                r"$HOME/Documents/Smith v Acme/motion.pdf",
                &["Smith", "Acme", "motion"],
            ),
            (
                "uri-encoded path",
                r"file:///Users/jane/Smith%20v%20Acme/complaint.pdf",
                &["Smith", "Acme", "complaint"],
            ),
            (
                "path with no file extension",
                r"/Users/jane/Smith v Acme/PrivilegeLog",
                &["Smith", "Acme", "PrivilegeLog"],
            ),
            (
                "windows path with spaces",
                r"C:\Users\Jane Doe\Smith v Acme\complaint.pdf",
                &["Jane Doe", "Smith", "Acme", "complaint"],
            ),
            (
                "firm email address",
                r"user jane.doe@smithlaw.com opened it",
                &["jane.doe", "smithlaw"],
            ),
            (
                "SSN and phone number in a scanned document's log line",
                r"scanner found 123-45-6789 and contact 305-555-0134",
                &["123-45-6789", "305-555-0134"],
            ),
        ];

        for (label, raw, must_not_survive) in cases {
            let scrubbed = scrub_diagnostic_text(raw);
            for needle in must_not_survive {
                assert!(
                    !scrubbed.contains(needle),
                    "[{label}] leaked {needle:?}: {scrubbed}"
                );
            }
        }
    }

    /// A log tail without timestamps is barely diagnosable, so the redaction of
    /// long digit runs must not eat them.
    #[test]
    fn log_timestamps_survive_redaction() {
        let scrubbed = scrub_diagnostic_text("unix:1770000000 shell engine_start engine ready");

        assert!(scrubbed.contains("unix:1770000000"), "{scrubbed}");
    }

    /// Documents a limitation honestly rather than pretending it is covered.
    ///
    /// A bare matter name carries no path and no file extension, so nothing
    /// distinguishes it from ordinary prose -- a regex broad enough to catch it
    /// would gut the log. The mitigation is upstream: diagnostics must not put
    /// such a string in a log line at all, which is why the document-open path
    /// records an extension and byte count and never a file name.
    #[test]
    fn a_bare_matter_name_is_a_known_gap_kept_out_of_diagnostics_upstream() {
        let scrubbed = scrub_diagnostic_text("title=Smith v. Acme Privilege Log");

        assert!(scrubbed.contains("Smith v. Acme"));
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
}

// ---------------------------------------------------------------------------
// Bounded, scrubbed diagnostics payload
// ---------------------------------------------------------------------------

/// Hard ceiling on log text per log in one payload, across the live file and
/// every rotation combined.
///
/// A cap is not polish. Without one the payload is unbounded, and an unbounded
/// payload handed to an outside reader is both a cost and a disclosure surface --
/// the more log that ships, the more chances a residual identifier rides along.
pub const PAYLOAD_LOG_TAIL_MAX_BYTES: u64 = 48 * 1024;

/// One log's contribution to a payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsLog {
    /// File name only, never a full path -- the path itself is machine-identifying.
    pub name: String,
    pub present: bool,
    /// Scrubbed tail, oldest-truncation marked inline.
    pub tail: String,
}

/// A bounded, scrubbed, provenance-stamped diagnostics payload.
///
/// Everything here has been through [`scrub_diagnostic_text`]. `sanitized` and
/// `residualRiskNote` are part of the contract rather than decoration: a reader
/// has to know the text was filtered AND that filtering is imperfect, or they
/// will treat it as safe to forward anywhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsPayload {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// Correlation id the caller asked about, echoed back so a reader can grep
    /// the tails below for the matching `id=` line.
    pub reference: Option<String>,
    pub logs: Vec<DiagnosticsLog>,
    pub sanitized: bool,
    pub residual_risk_note: String,
    pub telemetry_note: String,
}

/// Assemble the payload from a RaioPDF app-data directory.
///
/// Read-only, and it takes the directory rather than a file path on purpose: the
/// caller never chooses what gets read, so this can't be turned into a
/// general-purpose file reader by a crafted argument.
pub fn collect_diagnostics_payload(
    app_data_dir: &Path,
    app_version: &str,
    reference: Option<String>,
    log_file_names: &[&str],
) -> DiagnosticsPayload {
    let logs = log_file_names
        .iter()
        .map(|name| collect_log(app_data_dir, name))
        .collect();

    DiagnosticsPayload {
        app_version: app_version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        reference: reference.map(|value| scrub_diagnostic_text(&value)),
        logs,
        sanitized: true,
        residual_risk_note:
            "Removed: Windows, UNC/network-share and POSIX file paths, file names, email \
             addresses, SSN- and phone-shaped digits, long digit runs, and long quoted strings. \
             Log timestamps are kept deliberately so events can be ordered. Redaction is \
             best-effort, NOT a guarantee -- it recognises shapes, so a client or matter name \
             that appears without a path or a file extension (a bare caption, a matter number \
             shorter than eight digits) can survive. Read this before sending it anywhere."
                .to_string(),
        telemetry_note:
            "RaioPDF collects no telemetry. This payload was assembled on request and sent \
             nowhere."
                .to_string(),
    }
}

fn collect_log(app_data_dir: &Path, name: &str) -> DiagnosticsLog {
    let live = app_data_dir.join(name);
    let mut sections: Vec<String> = Vec::new();
    let mut present = false;

    // Chronological: oldest rotation first, live log last.
    //
    // This ordering is what makes the cap correct. "Newest" is the END of any one
    // file but the FIRST file across rotations, so neither a plain head nor a plain
    // tail of a newest-first join keeps the right lines -- a tail kept the oldest
    // rotation and dropped the current failure; a head kept the live log's oldest
    // lines and dropped its newest. Laid out chronologically, "keep the newest"
    // is simply "keep the tail", on both axes at once. It also matches how a
    // person reads a log.
    for generation in (0..=LOG_GENERATIONS).rev() {
        let path = if generation == 0 {
            live.clone()
        } else {
            rotated_log_path(&live, generation)
        };
        let Ok(text) = read_tail(&path, PAYLOAD_LOG_TAIL_MAX_BYTES) else {
            continue;
        };
        present = true;
        if generation > 0 {
            sections.push(format!("--- rotated generation {generation} ---"));
        }
        sections.push(text);
    }

    // Cap the JOINED text, not each file: the ceiling is per log, and applying it
    // per generation returned up to (generations + 1) times the documented bound.
    let joined = sections.join("\n");
    let tail = if joined.len() as u64 > PAYLOAD_LOG_TAIL_MAX_BYTES {
        let mut start = joined.len() - PAYLOAD_LOG_TAIL_MAX_BYTES as usize;
        // A byte offset can land inside a multibyte character, and slicing off a
        // char boundary panics -- which would take the whole tool down instead of
        // returning a payload. Non-ASCII is ordinary in names and messages.
        while start < joined.len() && !joined.is_char_boundary(start) {
            start += 1;
        }
        // Prefer a line boundary so the first retained line isn't half a line.
        let cut = joined[start..]
            .find('\n')
            .map(|index| start + index + 1)
            .unwrap_or(start);
        format!("{TRUNCATION_MARKER}\n{}", &joined[cut..])
    } else {
        joined
    };

    DiagnosticsLog {
        name: name.to_string(),
        present,
        tail: scrub_diagnostic_text(&tail),
    }
}

pub fn rotated_log_path(path: &Path, generation: usize) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(APP_LOG_FILE_NAME);
    path.with_file_name(format!("{file_name}.{generation}"))
}

/// Read at most `max_bytes` from the END of a file, marking that older lines
/// were dropped. Shared so the desktop export and the MCP payload describe the
/// same truncation the same way — they had already drifted to two different
/// markers when each owned a copy.
pub fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    let start = bytes.len().saturating_sub(max_bytes as usize);
    let mut text = String::from_utf8_lossy(&bytes[start..]).into_owned();

    if start > 0 {
        match text.find('\n') {
            Some(index) => text.replace_range(..=index, TRUNCATION_MARKER_LINE),
            // No newline in the window means one line is longer than the whole
            // window. Keep the bytes and mark them: dropping them entirely
            // reported `present: true` with empty content, which is
            // indistinguishable from an empty log and loses precisely the long
            // stack trace a reader is looking for.
            None => text.insert_str(0, TRUNCATION_MARKER_LINE),
        }
    }

    Ok(text)
}

#[cfg(test)]
mod payload_tests {
    use super::*;

    /// The two logs a real caller passes.
    const LOGS: [&str; 2] = [APP_LOG_FILE_NAME, "engine.log"];
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "raiopdf-diag-payload-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn scrubs_every_log_tail_it_returns() {
        let dir = temp_dir("scrubbed");
        fs::write(
            dir.join("app.log"),
            "unix:1 ui ocr.failed id=d-1a2b3c4d opening /Users/Jane Doe/Smith v Acme/complaint.pdf\n",
        )
        .expect("write log");

        let payload =
            collect_diagnostics_payload(&dir, "0.1.5", Some("d-1a2b3c4d".to_string()), &LOGS);
        let app_log = payload
            .logs
            .iter()
            .find(|log| log.name == "app.log")
            .expect("app.log");

        assert!(app_log.present);
        assert!(!app_log.tail.contains("Jane Doe"), "{}", app_log.tail);
        assert!(!app_log.tail.contains("Smith"), "{}", app_log.tail);
        assert!(!app_log.tail.contains("complaint"), "{}", app_log.tail);
        // The correlation id must survive scrubbing, or a reader can't find the
        // failure they were asked about.
        assert!(app_log.tail.contains("id=d-1a2b3c4d"), "{}", app_log.tail);
        assert_eq!(payload.reference.as_deref(), Some("d-1a2b3c4d"));
    }

    #[test]
    fn caps_the_tail_and_marks_the_truncation() {
        let dir = temp_dir("capped");
        let line = "unix:1 ui filler this line exists purely to exceed the cap\n";
        let bulk = line.repeat(4000);
        assert!(bulk.len() as u64 > PAYLOAD_LOG_TAIL_MAX_BYTES);
        fs::write(dir.join("app.log"), &bulk).expect("write log");

        let payload = collect_diagnostics_payload(&dir, "0.1.5", None, &LOGS);
        let app_log = payload
            .logs
            .iter()
            .find(|log| log.name == "app.log")
            .expect("app.log");

        assert!(app_log.tail.len() as u64 <= PAYLOAD_LOG_TAIL_MAX_BYTES + 64);
        assert!(app_log.tail.contains("[older lines truncated]"));
    }

    #[test]
    fn the_cap_is_per_log_not_per_rotation() {
        // Regression: the ceiling was applied to each generation file, so one log
        // could return (generations + 1) times the documented bound -- the number
        // the doc comment sells as the disclosure-surface limit.
        let dir = temp_dir("per-log-cap");
        let bulk = "unix:1 ui filler padding to exceed the per-log ceiling\n".repeat(4000);
        for name in ["app.log", "app.log.1", "app.log.2"] {
            fs::write(dir.join(name), &bulk).expect("write log");
        }

        let payload = collect_diagnostics_payload(&dir, "0.1.5", None, &LOGS);
        let app_log = payload
            .logs
            .iter()
            .find(|log| log.name == APP_LOG_FILE_NAME)
            .expect("app.log");

        assert!(
            app_log.tail.len() as u64 <= PAYLOAD_LOG_TAIL_MAX_BYTES + 64,
            "tail was {} bytes, cap is {}",
            app_log.tail.len(),
            PAYLOAD_LOG_TAIL_MAX_BYTES
        );
        assert!(app_log.tail.contains(TRUNCATION_MARKER));
    }

    #[test]
    fn the_cap_keeps_the_live_log_and_drops_the_oldest_rotation() {
        // Regression: the cap sliced the END of a newest-first join, so it retained
        // the oldest rotation and threw away the live log -- the current failure.
        let dir = temp_dir("cap-keeps-newest");
        let filler = "unix:1770000000 ui filler padding to exceed the per-log ceiling\n";
        fs::write(
            dir.join(APP_LOG_FILE_NAME),
            format!(
                "{}unix:1770000009 ui LIVE_MARKER the current failure\n",
                filler.repeat(2000)
            ),
        )
        .expect("write live");
        fs::write(
            dir.join(format!("{APP_LOG_FILE_NAME}.1")),
            format!(
                "{}unix:1770000001 ui OLDEST_MARKER ancient\n",
                filler.repeat(2000)
            ),
        )
        .expect("write rotation");

        let payload = collect_diagnostics_payload(&dir, "0.1.5", None, &LOGS);
        let tail = &payload
            .logs
            .iter()
            .find(|log| log.name == APP_LOG_FILE_NAME)
            .expect("app.log")
            .tail;

        assert!(tail.contains("LIVE_MARKER"), "live log was dropped");
        assert!(
            !tail.contains("OLDEST_MARKER"),
            "oldest rotation was retained"
        );
        assert!(tail.contains(TRUNCATION_MARKER));
    }

    #[test]
    fn a_multibyte_character_at_the_cap_boundary_does_not_panic() {
        // Slicing off a UTF-8 boundary panics, which would take the whole tool down
        // rather than return a payload. Accented client names make this ordinary.
        let dir = temp_dir("multibyte-cap");
        // "é" is two bytes, so the cap offset lands mid-character for some lengths.
        let line = format!("unix:1770000000 ui opened {}\n", "é".repeat(40));
        fs::write(dir.join(APP_LOG_FILE_NAME), line.repeat(3000)).expect("write log");

        let payload = collect_diagnostics_payload(&dir, "0.1.5", None, &LOGS);
        let app_log = payload
            .logs
            .iter()
            .find(|log| log.name == APP_LOG_FILE_NAME)
            .expect("app.log");

        assert!(app_log.present);
        assert!(app_log.tail.len() as u64 <= PAYLOAD_LOG_TAIL_MAX_BYTES + 64);
    }

    #[test]
    fn a_single_line_longer_than_the_window_is_kept_not_discarded() {
        // Regression: with no newline in the window the whole tail was replaced by
        // the marker, so the payload reported `present: true` with no content --
        // indistinguishable from an empty log, and it happened on exactly the
        // content a reader wants most (one huge stack trace or dumped response).
        let dir = temp_dir("one-long-line");
        let giant = format!("unix:1770000000 engine {}", "x".repeat(200_000));
        fs::write(dir.join(APP_LOG_FILE_NAME), &giant).expect("write log");

        let payload = collect_diagnostics_payload(&dir, "0.1.5", None, &LOGS);
        let app_log = payload
            .logs
            .iter()
            .find(|log| log.name == APP_LOG_FILE_NAME)
            .expect("app.log");

        assert!(app_log.present);
        assert!(app_log.tail.contains(TRUNCATION_MARKER));
        assert!(
            app_log.tail.len() > TRUNCATION_MARKER.len() + 1000,
            "tail was only {} bytes",
            app_log.tail.len()
        );
    }

    #[test]
    fn reports_a_missing_log_rather_than_failing() {
        let payload = collect_diagnostics_payload(&temp_dir("empty"), "0.1.5", None, &LOGS);

        for log in &payload.logs {
            assert!(!log.present, "{} should be absent", log.name);
            assert_eq!(log.tail, "");
        }
    }

    #[test]
    fn includes_rotated_generations_in_chronological_order() {
        let dir = temp_dir("rotations");
        fs::write(dir.join("app.log"), "live line\n").expect("write live");
        fs::write(dir.join("app.log.1"), "rotated one\n").expect("write rot1");

        let payload = collect_diagnostics_payload(&dir, "0.1.5", None, &LOGS);
        let tail = &payload
            .logs
            .iter()
            .find(|log| log.name == "app.log")
            .expect("app.log")
            .tail;

        let live_at = tail.find("live line").expect("live present");
        let rotated_at = tail.find("rotated one").expect("rotation present");
        // Oldest first, live log last -- so "keep the newest" is "keep the tail".
        assert!(
            rotated_at < live_at,
            "rotation must come before the live log: {tail}"
        );
        assert!(tail.contains("rotated generation 1"));
    }

    #[test]
    fn always_declares_that_it_was_sanitized_and_still_carries_residual_risk() {
        let payload = collect_diagnostics_payload(&temp_dir("provenance"), "0.1.5", None, &LOGS);

        // A reader who doesn't know the text was filtered will over-trust it; one
        // who thinks filtering is perfect will forward it anywhere.
        assert!(payload.sanitized);
        assert!(payload.residual_risk_note.contains("best-effort"));
        assert!(payload.telemetry_note.contains("no telemetry"));
        assert_eq!(payload.app_version, "0.1.5");
    }

    #[test]
    fn scrubs_a_hostile_reference_rather_than_echoing_it() {
        // The reference arrives from outside the process, so it is untrusted.
        let payload = collect_diagnostics_payload(
            &temp_dir("hostile-ref"),
            "0.1.5",
            Some("/Users/Jane Doe/Smith v Acme/complaint.pdf".to_string()),
            &LOGS,
        );

        let reference = payload.reference.expect("reference echoed");
        assert!(!reference.contains("Jane Doe"), "{reference}");
        assert!(!reference.contains("complaint"), "{reference}");
    }
}
