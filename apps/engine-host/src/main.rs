use engine_sidecar_core::{SidecarConfig, SidecarManager};
use std::{
    env,
    io::{self, Read, Write},
    path::PathBuf,
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

const APP_DATA_DIR_NAME: &str = "me.macrify.raiopdf";
const ENGINE_HOST_DATA_DIR_NAME: &str = "engine-host";
const APP_DATA_DIR_ENV: &str = "RAIOPDF_APP_DATA_DIR";
const LEGACY_APP_DATA_DIR_ENV: &str = "RAIOPDF_ENGINE_HOST_APP_DATA_DIR";
const RESOURCE_DIR_ENV: &str = "RAIOPDF_ENGINE_RESOURCE_DIR";

static SHUTDOWN_SIGNAL_RECEIVED: AtomicBool = AtomicBool::new(false);

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let fallback = "{\"error\":\"engine host failed\"}".to_string();
            let line =
                serde_json::to_string(&serde_json::json!({ "error": error })).unwrap_or(fallback);
            eprintln!("{line}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let app_data_dir = app_data_dir();
    let resource_dir = env::var_os(RESOURCE_DIR_ENV).map(PathBuf::from);
    let config = SidecarConfig::from_env(app_data_dir, resource_dir);
    let manager = SidecarManager::new(config);
    let started = manager.engine_start()?;

    if started.disabled() {
        return Err(
            "RaioPDF engine payload is disabled or missing; set RAIOPDF_ENGINE_PAYLOAD_DIR"
                .to_string(),
        );
    }

    let port = started
        .port()
        .ok_or_else(|| "engine started without a proxy port".to_string())?;
    let token = started
        .token()
        .ok_or_else(|| "engine started without an auth token".to_string())?;
    let ready = serde_json::to_string(&serde_json::json!({ "port": port, "token": token }))
        .map_err(|error| format!("failed to encode engine-host ready line: {error}"))?;

    println!("{ready}");
    io::stdout()
        .flush()
        .map_err(|error| format!("failed to flush engine-host ready line: {error}"))?;

    wait_for_shutdown_signal()?;
    manager.shutdown();

    Ok(())
}

fn wait_for_shutdown_signal() -> Result<(), String> {
    install_signal_handlers()?;

    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buffer = [0_u8; 1024];

        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => {
                    let _ = shutdown_tx.send(());
                    return;
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => {
                    let _ = shutdown_tx.send(());
                    return;
                }
            }
        }
    });

    loop {
        if SHUTDOWN_SIGNAL_RECEIVED.load(Ordering::Relaxed) {
            return Ok(());
        }

        match shutdown_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(()) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => {
                return Err(format!(
                    "failed while waiting for engine-host shutdown: {error}"
                ));
            }
        }
    }
}

fn app_data_dir() -> PathBuf {
    if let Some(path) = env::var_os(APP_DATA_DIR_ENV).map(PathBuf::from) {
        return path;
    }
    if let Some(path) = env::var_os(LEGACY_APP_DATA_DIR_ENV).map(PathBuf::from) {
        return path;
    }

    platform_app_data_root()
        .join(APP_DATA_DIR_NAME)
        .join(ENGINE_HOST_DATA_DIR_NAME)
}

#[cfg(windows)]
fn platform_app_data_root() -> PathBuf {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
        })
        .unwrap_or_else(env::temp_dir)
}

#[cfg(target_os = "macos")]
fn platform_app_data_root() -> PathBuf {
    env::var_os("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
        })
        .unwrap_or_else(env::temp_dir)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_app_data_root() -> PathBuf {
    env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .unwrap_or_else(env::temp_dir)
}

#[cfg(unix)]
fn install_signal_handlers() -> Result<(), String> {
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;

    unsafe extern "C" {
        fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
    }

    extern "C" fn handle_signal(_signal: i32) {
        SHUTDOWN_SIGNAL_RECEIVED.store(true, Ordering::Relaxed);
    }

    unsafe {
        signal(SIGINT, handle_signal);
        signal(SIGTERM, handle_signal);
    }

    Ok(())
}

#[cfg(windows)]
fn install_signal_handlers() -> Result<(), String> {
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;
    const CTRL_CLOSE_EVENT: u32 = 2;

    unsafe extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    extern "system" fn handle_signal(event: u32) -> i32 {
        if matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT) {
            SHUTDOWN_SIGNAL_RECEIVED.store(true, Ordering::Relaxed);
            1
        } else {
            0
        }
    }

    let installed = unsafe { SetConsoleCtrlHandler(Some(handle_signal), 1) };
    if installed == 0 {
        return Err("failed to install engine-host signal handler".to_string());
    }

    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn install_signal_handlers() -> Result<(), String> {
    Ok(())
}
