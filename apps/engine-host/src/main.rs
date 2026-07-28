use engine_sidecar_core::{SidecarConfig, SidecarManager, ENGINE_LOG_FILE_NAME};
use std::{
    env,
    ffi::OsStr,
    io::{self, Read, Write},
    path::{Path, PathBuf},
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
const ENGINE_HOST_LOG_LABEL: &str = "engine-host/engine.log";

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

/// CLI flag that prints a bounded, scrubbed diagnostics payload and exits.
///
/// This is how the MCP connector reads diagnostics: it already knows how to
/// locate and spawn this binary, and going through here means the redaction
/// policy applied is the same Rust one the desktop app uses, rather than a second
/// implementation in Node that could drift and become the weaker guarantee.
const DIAGNOSTICS_FLAG: &str = "--diagnostics";
/// Optional `--reference <id>` so a caller can name the failure it cares about.
const REFERENCE_FLAG: &str = "--reference";

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == DIAGNOSTICS_FLAG) {
        return print_diagnostics(&args);
    }

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

/// Print the diagnostics payload as one JSON line, then exit.
///
/// Deliberately takes NO path argument. The only readable location is RaioPDF's
/// own app-data directory, resolved internally -- accepting a caller-supplied
/// path would turn a diagnostics reader into an arbitrary-file reader.
fn print_diagnostics(args: &[String]) -> Result<(), String> {
    let reference = args
        .iter()
        .position(|arg| arg == REFERENCE_FLAG)
        .and_then(|index| args.get(index + 1))
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "));

    let payload = collect_engine_host_diagnostics(
        &shell_app_data_dir(),
        &app_data_dir(),
        env!("CARGO_PKG_VERSION"),
        reference,
    );
    let line = serde_json::to_string(&payload)
        .map_err(|error| format!("failed to encode diagnostics payload: {error}"))?;
    println!("{line}");
    io::stdout()
        .flush()
        .map_err(|error| format!("failed to flush diagnostics payload: {error}"))
}

/// Collect both desktop-shell diagnostics and this host's separate engine log.
///
/// The default host directory is nested below the shell directory. Reading only
/// the shell directory finds the desktop engine log but misses the MCP startup
/// failure that prompted the diagnostics request.
fn collect_engine_host_diagnostics(
    shell_app_data_dir: &Path,
    engine_host_app_data_dir: &Path,
    app_version: &str,
    reference: Option<String>,
) -> diagnostics_core::DiagnosticsPayload {
    let mut payload = diagnostics_core::collect_diagnostics_payload(
        shell_app_data_dir,
        app_version,
        reference,
        // Names come from the crates that WRITE these files, so a rename can't
        // leave the reader silently reporting "no log found".
        &[diagnostics_core::APP_LOG_FILE_NAME, ENGINE_LOG_FILE_NAME],
    );

    // An override may intentionally place the host and shell logs together. In
    // that case engine.log is already present and adding it again would only
    // duplicate the same scrubbed content under a different label.
    if engine_host_app_data_dir != shell_app_data_dir {
        let mut host_log = diagnostics_core::collect_diagnostics_log(
            engine_host_app_data_dir,
            ENGINE_LOG_FILE_NAME,
        );
        // A stable logical label distinguishes the two engine logs without
        // exposing either machine-specific directory.
        host_log.name = ENGINE_HOST_LOG_LABEL.to_string();
        payload.logs.push(host_log);
    }

    payload
}

/// The directory the DESKTOP SHELL writes its logs to.
///
/// Not the same as [`app_data_dir`]: this host keeps its own state in an
/// `engine-host` subdirectory, while the shell writes `app.log` one level up. A
/// diagnostics reader that used its own directory would silently return an empty
/// payload, so this walks up when the host default applies -- while still
/// honouring the same environment overrides, so a non-default install works too.
fn shell_app_data_dir() -> PathBuf {
    if let Some(path) = env_app_data_dir_override() {
        return shell_dir_for_override(&path);
    }

    platform_app_data_root().join(APP_DATA_DIR_NAME)
}

/// Resolve the shell's log directory from a host-directory override.
///
/// The override names THIS HOST's directory. When it points at the `engine-host`
/// subdirectory, the shell's logs are its parent -- without the walk-up the
/// override made both directories identical and the payload came back with no
/// app.log and nothing saying why.
fn shell_dir_for_override(path: &Path) -> PathBuf {
    if path.file_name() == Some(OsStr::new(ENGINE_HOST_DATA_DIR_NAME)) {
        if let Some(parent) = path.parent() {
            return parent.to_path_buf();
        }
    }
    path.to_path_buf()
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
    if let Some(path) = env_app_data_dir_override() {
        return path;
    }

    platform_app_data_root()
        .join(APP_DATA_DIR_NAME)
        .join(ENGINE_HOST_DATA_DIR_NAME)
}

/// The env overrides, in precedence order, in ONE place.
///
/// Both `app_data_dir` (this host's own state) and `shell_app_data_dir` (where the
/// desktop app writes its logs) honour the same overrides. With the chain written
/// twice, changing one would make the two disagree on a non-default install — and
/// that surfaces as an empty diagnostics payload, which is exactly the failure
/// mode the walk-up below exists to prevent.
fn env_app_data_dir_override() -> Option<PathBuf> {
    env::var_os(APP_DATA_DIR_ENV)
        .or_else(|| env::var_os(LEGACY_APP_DATA_DIR_ENV))
        .map(PathBuf::from)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("raiopdf-engine-host-{name}-{unique}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// The walk-up is the one piece of this that is easy to get silently wrong: a
    /// diagnostics reader pointed at its own directory returns an empty payload and
    /// says nothing about why. It had no test in either language.
    #[test]
    fn shell_dir_is_the_parent_of_the_hosts_own_dir_by_default() {
        let host = app_data_dir();
        let shell = shell_app_data_dir();

        assert_eq!(
            host.file_name(),
            Some(OsStr::new(ENGINE_HOST_DATA_DIR_NAME))
        );
        assert_eq!(host.parent(), Some(shell.as_path()));
    }

    #[test]
    fn an_override_naming_the_host_dir_still_resolves_the_shells_dir() {
        // The override names THIS host's directory. Treating it as the shell's made
        // both identical, so an overridden install reported no app.log at all.
        let root = PathBuf::from("/tmp/raiopdf-test-root").join(APP_DATA_DIR_NAME);
        let overridden = root.join(ENGINE_HOST_DATA_DIR_NAME);

        assert_eq!(shell_dir_for_override(&overridden), root);
    }

    #[test]
    fn an_override_naming_the_shell_dir_is_used_as_given() {
        let root = PathBuf::from("/tmp/raiopdf-test-root").join(APP_DATA_DIR_NAME);

        assert_eq!(shell_dir_for_override(&root), root);
    }

    #[test]
    fn diagnostics_include_the_nested_engine_host_log() {
        let shell_dir = temp_dir("nested-diagnostics");
        let host_dir = shell_dir.join(ENGINE_HOST_DATA_DIR_NAME);
        std::fs::create_dir_all(&host_dir).expect("create host dir");
        std::fs::write(
            shell_dir.join(diagnostics_core::APP_LOG_FILE_NAME),
            "unix:1770000000 ui shell event\n",
        )
        .expect("write app log");
        std::fs::write(
            shell_dir.join(ENGINE_LOG_FILE_NAME),
            "unix:1770000001 engine desktop engine event\n",
        )
        .expect("write desktop engine log");
        std::fs::write(
            host_dir.join(ENGINE_LOG_FILE_NAME),
            "unix:1770000002 engine MCP_STARTUP_FAILURE\n",
        )
        .expect("write host engine log");

        let payload = collect_engine_host_diagnostics(
            &shell_dir,
            &host_dir,
            "0.1.5",
            Some("d-1a2b3c4d".to_string()),
        );

        assert_eq!(
            payload
                .logs
                .iter()
                .map(|log| log.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                diagnostics_core::APP_LOG_FILE_NAME,
                ENGINE_LOG_FILE_NAME,
                ENGINE_HOST_LOG_LABEL,
            ]
        );
        let host_log = payload
            .logs
            .iter()
            .find(|log| log.name == ENGINE_HOST_LOG_LABEL)
            .expect("engine-host log");
        assert!(host_log.present);
        assert!(host_log.tail.contains("MCP_STARTUP_FAILURE"));
        assert_eq!(payload.reference.as_deref(), Some("d-1a2b3c4d"));

        std::fs::remove_dir_all(shell_dir).expect("remove temp dir");
    }

    #[test]
    fn diagnostics_do_not_duplicate_a_shared_engine_log_directory() {
        let shared_dir = temp_dir("shared-diagnostics");
        std::fs::write(
            shared_dir.join(ENGINE_LOG_FILE_NAME),
            "unix:1770000002 engine shared event\n",
        )
        .expect("write shared engine log");

        let payload = collect_engine_host_diagnostics(&shared_dir, &shared_dir, "0.1.5", None);

        assert_eq!(payload.logs.len(), 2);
        assert_eq!(
            payload
                .logs
                .iter()
                .filter(|log| log.name == ENGINE_LOG_FILE_NAME)
                .count(),
            1
        );

        std::fs::remove_dir_all(shared_dir).expect("remove temp dir");
    }
}
