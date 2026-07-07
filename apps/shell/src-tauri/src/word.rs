//! Tauri command surface for Microsoft Word capability detection.

use engine_sidecar_core::path_ops as core_ops;
use engine_sidecar_core::path_ops::PathOpError;
use engine_sidecar_core::word_ops::{self as core_word, MarkupMode, WordCapability};
use serde::Serialize;
use std::{fs, path::Path, sync::Mutex, time::Instant};

use crate::path_ops::{
    discover_toolchain, ensure_grant_snapshot_unchanged, ensure_unchanged, on_blocking_pool,
    snapshot, OpReport, OpWorkDir, PathOpOutput,
};
use crate::FileGrants;

#[derive(Default)]
pub struct WordCapabilityCache {
    authoritative: Mutex<Option<WordCapability>>,
}

impl WordCapabilityCache {
    fn get_unless_forced(&self, force: bool) -> Result<Option<WordCapability>, PathOpError> {
        if force {
            return Ok(None);
        }

        let capability = self.authoritative.lock().map_err(|_| PathOpError {
            code: "IO_ERROR",
            message: "Word capability cache lock poisoned".to_string(),
        })?;
        Ok(capability.clone())
    }

    fn set(&self, capability: WordCapability) -> Result<(), PathOpError> {
        let mut cached = self.authoritative.lock().map_err(|_| PathOpError {
            code: "IO_ERROR",
            message: "Word capability cache lock poisoned".to_string(),
        })?;
        *cached = Some(capability);
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextLayerResponse {
    has_text_layer: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordReflowOutput {
    output_grant: String,
    name: String,
    size_bytes: u64,
    op_report: OpReport,
}

#[tauri::command]
pub async fn word_capability(
    cache: tauri::State<'_, WordCapabilityCache>,
    force: Option<bool>,
) -> Result<WordCapability, PathOpError> {
    let force = force.unwrap_or(false);
    if let Some(cached) = cache.get_unless_forced(force)? {
        return Ok(cached);
    }

    let capability = on_blocking_pool(move || core_word::word_capability(force)).await?;

    if force {
        cache.set(capability.clone())?;
    }

    Ok(capability)
}

#[tauri::command]
pub async fn word_pdf_has_text_layer(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
) -> Result<PdfTextLayerResponse, PathOpError> {
    let input = grants.resolve(&grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })?;
    let toolchain = discover_toolchain(&app);
    let has_text_layer =
        on_blocking_pool(move || core_ops::pdf_has_text_layer(&toolchain, &input)).await?;
    Ok(PdfTextLayerResponse { has_text_layer })
}

#[tauri::command]
pub async fn word_convert_docx(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    markup: Option<MarkupMode>,
) -> Result<PathOpOutput, PathOpError> {
    let input = grants.resolve(&grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })?;
    let markup = markup.unwrap_or(MarkupMode::Final);
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let name = converted_pdf_name(&input);
    let output_path = work_dir.path().join(&name);
    let input_size = fs::metadata(&input)
        .map(|metadata| metadata.len())
        .map_err(|error| PathOpError {
            code: "IO_ERROR",
            message: format!("cannot stat DOCX input: {error}"),
        })?;
    let started = Instant::now();

    let (page_count, output_size) = {
        let input = input.clone();
        let output_path = output_path.clone();
        let toolchain_for_work = toolchain.clone();
        on_blocking_pool(move || {
            core_word::convert_docx_to_pdf_with_toolchain(
                &toolchain_for_work,
                &input,
                &output_path,
                markup,
            )?;
            let page_count =
                engine_sidecar_core::path_ops::page_count(&toolchain_for_work, &output_path)?;
            let output_size = fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: "IO_ERROR",
                    message: format!("cannot stat converted PDF: {error}"),
                })?;
            Ok((page_count, output_size))
        })
        .await?
    };

    let output_grant = grants
        .grant(output_path.clone())
        .map_err(|message| PathOpError {
            code: "IO_ERROR",
            message,
        })?;
    work_dir.keep();
    Ok(PathOpOutput {
        output_grant,
        name,
        size_bytes: output_size,
        page_count,
        op_report: OpReport {
            op: "word_convert_docx",
            tool: "word",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: input_size,
            output_size_bytes: output_size,
            notes: vec!["DOCX converted to PDF via Microsoft Word automation".to_string()],
        },
    })
}

#[tauri::command]
pub async fn word_reflow_pdf_to_docx(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FileGrants>,
    grant: String,
    ocr_first: Option<bool>,
) -> Result<WordReflowOutput, PathOpError> {
    let input = grants.resolve(&grant).map_err(|message| PathOpError {
        code: "INVALID_INPUT",
        message,
    })?;
    let toolchain = discover_toolchain(&app);
    let work_dir = OpWorkDir::create(&app)?;
    let name = converted_docx_name(&input);
    let output_path = work_dir.path().join(&name);
    let before = snapshot(&input)?;
    ensure_grant_snapshot_unchanged(&grants, &grant, &before)?;
    let input_size = fs::metadata(&input)
        .map(|metadata| metadata.len())
        .map_err(|error| PathOpError {
            code: "IO_ERROR",
            message: format!("cannot stat PDF input: {error}"),
        })?;
    let started = Instant::now();
    let ocr_first = ocr_first.unwrap_or(false);

    let output_size = {
        let input = input.clone();
        let output_path = output_path.clone();
        let work_path = work_dir.path().to_path_buf();
        let toolchain_for_work = toolchain.clone();
        on_blocking_pool(move || {
            reflow_pdf_to_docx_with_optional_ocr(
                &toolchain_for_work,
                &input,
                &output_path,
                &work_path,
                ocr_first,
            )?;
            ensure_unchanged(&input, before)?;
            fs::metadata(&output_path)
                .map(|metadata| metadata.len())
                .map_err(|error| PathOpError {
                    code: "IO_ERROR",
                    message: format!("cannot stat converted DOCX: {error}"),
                })
        })
        .await?
    };

    let output_grant = grants
        .grant(output_path.clone())
        .map_err(|message| PathOpError {
            code: "IO_ERROR",
            message,
        })?;
    work_dir.keep();
    Ok(WordReflowOutput {
        output_grant,
        name,
        size_bytes: output_size,
        op_report: OpReport {
            op: "word_reflow_pdf_to_docx",
            tool: "word",
            duration_ms: started.elapsed().as_millis() as u64,
            input_size_bytes: input_size,
            output_size_bytes: output_size,
            notes: reflow_notes(ocr_first),
        },
    })
}

fn converted_pdf_name(input: &Path) -> String {
    let stem = input
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("converted");
    let sanitized = stem
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    format!("{sanitized}.pdf")
}

fn converted_docx_name(input: &Path) -> String {
    let stem = input
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("converted");
    let sanitized = sanitize_file_stem(stem);
    format!("{sanitized}.docx")
}

fn sanitize_file_stem(stem: &str) -> String {
    stem.chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect()
}

fn reflow_notes(ocr_first: bool) -> Vec<String> {
    if ocr_first {
        vec![
            "PDF OCR completed with OCRmyPDF before Microsoft Word PDF reflow".to_string(),
            "final output is a DOCX path only; no PDF page count, header check, or metadata scrub"
                .to_string(),
        ]
    } else {
        vec![
            "PDF reflowed to DOCX via Microsoft Word automation".to_string(),
            "final output is a DOCX path only; no PDF page count, header check, or metadata scrub"
                .to_string(),
        ]
    }
}

fn reflow_pdf_to_docx_with_optional_ocr(
    toolchain: &core_ops::PathOpsToolchain,
    input: &Path,
    output_path: &Path,
    work_dir: &Path,
    ocr_first: bool,
) -> Result<(), PathOpError> {
    if !ocr_first {
        return core_word::convert_pdf_to_docx(input, output_path);
    }

    let ocr_pdf = work_dir.join("reflow-ocr.pdf");
    let result = (|| {
        core_ops::ocr_with_mode(toolchain, input, &ocr_pdf, core_ops::OcrMode::SkipText)?;
        core_word::convert_pdf_to_docx(&ocr_pdf, output_path)
    })();

    if let Err(error) = fs::remove_file(&ocr_pdf) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("failed to delete Word reflow OCR temp PDF: {error}");
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_sidecar_core::word_ops::WordCapabilityState;

    #[test]
    fn forced_word_capability_bypasses_cached_authoritative_result() {
        let cache = WordCapabilityCache::default();
        let cached = WordCapability {
            state: WordCapabilityState::Unavailable,
            reason: Some("transient failure".to_string()),
        };
        cache.set(cached.clone()).expect("cache stores result");

        assert_eq!(
            cache.get_unless_forced(false).expect("cache reads"),
            Some(cached)
        );
        assert_eq!(
            cache
                .get_unless_forced(true)
                .expect("forced read bypasses cache"),
            None
        );
    }
}
