//! Tauri command surface for Microsoft Word capability detection.

use engine_sidecar_core::path_ops::PathOpError;
use engine_sidecar_core::word_ops::{
    self as core_word, MarkupMode, WordCapability, WordCapabilityState,
};
use std::{fs, path::Path, sync::Mutex, time::Instant};

use crate::path_ops::{discover_toolchain, on_blocking_pool, OpReport, OpWorkDir, PathOpOutput};
use crate::FileGrants;

#[derive(Default)]
pub struct WordCapabilityCache {
    authoritative: Mutex<Option<WordCapability>>,
}

impl WordCapabilityCache {
    fn get(&self) -> Result<Option<WordCapability>, PathOpError> {
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

#[tauri::command]
pub async fn word_capability(
    cache: tauri::State<'_, WordCapabilityCache>,
    force: Option<bool>,
) -> Result<WordCapability, PathOpError> {
    if let Some(cached) = cache.get()? {
        return Ok(cached);
    }

    let force = force.unwrap_or(false);
    let capability = on_blocking_pool(move || core_word::word_capability(force)).await?;

    if force
        && matches!(
            capability.state,
            WordCapabilityState::Available | WordCapabilityState::Unavailable
        )
    {
        cache.set(capability.clone())?;
    }

    Ok(capability)
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
