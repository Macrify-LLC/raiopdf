pub use engine_sidecar_core::{
    EngineStartResponse, EngineStatusResponse, EngineStopResponse, SidecarConfig, SidecarManager,
};

#[tauri::command]
pub fn engine_start(
    manager: tauri::State<'_, SidecarManager>,
) -> Result<EngineStartResponse, String> {
    manager.engine_start()
}

#[tauri::command]
pub fn engine_status(
    manager: tauri::State<'_, SidecarManager>,
) -> Result<EngineStatusResponse, String> {
    manager.engine_status()
}

#[tauri::command]
pub fn engine_stop(manager: tauri::State<'_, SidecarManager>) -> EngineStopResponse {
    manager.engine_stop()
}
