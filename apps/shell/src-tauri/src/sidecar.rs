use crate::diagnostics::AppDiagnostics;

pub use engine_sidecar_core::{
    EngineStartResponse, EngineStatusResponse, EngineStopResponse, SidecarConfig, SidecarManager,
};

#[tauri::command]
pub fn engine_start(
    manager: tauri::State<'_, SidecarManager>,
    diagnostics: tauri::State<'_, AppDiagnostics>,
) -> Result<EngineStartResponse, String> {
    match manager.engine_start() {
        Ok(response) => {
            if response.disabled() {
                let _ = diagnostics.record_shell_event("engine_start", "engine disabled");
            } else if let Some(port) = response.port() {
                let _ = diagnostics
                    .record_shell_event("engine_start", &format!("engine ready on port {port}"));
            }
            Ok(response)
        }
        Err(error) => {
            let _ = diagnostics.record_shell_event("engine_start_error", &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn engine_status(
    manager: tauri::State<'_, SidecarManager>,
    diagnostics: tauri::State<'_, AppDiagnostics>,
) -> Result<EngineStatusResponse, String> {
    match manager.engine_status() {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = diagnostics.record_shell_event("engine_status_error", &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn engine_stop(
    manager: tauri::State<'_, SidecarManager>,
    diagnostics: tauri::State<'_, AppDiagnostics>,
) -> EngineStopResponse {
    let response = manager.engine_stop();
    if response.stopped() {
        let _ = diagnostics.record_shell_event("engine_stop", "engine stopped");
    }
    response
}
