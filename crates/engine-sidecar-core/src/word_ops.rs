//! Microsoft Word capability detection.
//!
//! This module only probes and reports capability. It does not convert Word
//! documents and does not change any PDF-only file gates.

use serde::{Deserialize, Serialize};

use crate::path_ops::{self, OpResult, PathOpError};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WordCapabilityState {
    NotApplicable,
    NotDetected,
    Detected,
    Available,
    Unavailable,
}

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
}
