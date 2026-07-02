mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let manager = sidecar::SidecarManager::new(sidecar::SidecarConfig::from_env());
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::engine_start,
            sidecar::engine_status,
            sidecar::engine_stop
        ])
        .build(tauri::generate_context!())
        .expect("failed to build RaioPDF shell")
        .run(|app_handle, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = event
            {
                if label == "main" {
                    app_handle.state::<sidecar::SidecarManager>().shutdown();
                }
            }
        });
}
