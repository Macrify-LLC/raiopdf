mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let manager = sidecar::SidecarManager::start(sidecar::SidecarConfig::from_env());
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar::get_engine_port])
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
