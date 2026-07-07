//! Tauri command surface for Microsoft Word capability detection.

use engine_sidecar_core::path_ops::PathOpError;
use engine_sidecar_core::word_ops::{self as core_word, WordCapability, WordCapabilityState};
use std::sync::Mutex;

use crate::path_ops::on_blocking_pool;

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
