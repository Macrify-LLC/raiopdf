use serde::Serialize;
use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, ExitStatus},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_HEALTH_PATH: &str = "/api/v1/info/status";
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SidecarConfig {
    jar_path: Option<PathBuf>,
    health_path: String,
    startup_timeout: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
}

impl SidecarConfig {
    pub fn from_env() -> Self {
        Self::from_env_vars(env::vars_os())
    }

    fn from_env_vars<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let mut jar_path = None;
        let mut health_path = DEFAULT_HEALTH_PATH.to_string();
        let mut startup_timeout = DEFAULT_STARTUP_TIMEOUT;
        let mut initial_backoff = DEFAULT_INITIAL_BACKOFF;
        let mut max_backoff = DEFAULT_MAX_BACKOFF;

        for (key, value) in vars {
            let key = key.into();
            let value = value.into();
            match key.to_string_lossy().as_ref() {
                "RAIOPDF_ENGINE_JAR" => {
                    let value = value.to_string_lossy().trim().to_string();
                    if !value.is_empty() {
                        jar_path = Some(PathBuf::from(value));
                    }
                }
                "RAIOPDF_ENGINE_HEALTH_PATH" => {
                    let value = normalize_health_path(&value.to_string_lossy());
                    if !value.is_empty() {
                        health_path = value;
                    }
                }
                "RAIOPDF_ENGINE_STARTUP_TIMEOUT_MS" => {
                    startup_timeout = parse_duration_ms(&value).unwrap_or(DEFAULT_STARTUP_TIMEOUT);
                }
                "RAIOPDF_ENGINE_INITIAL_BACKOFF_MS" => {
                    initial_backoff = parse_duration_ms(&value).unwrap_or(DEFAULT_INITIAL_BACKOFF);
                }
                "RAIOPDF_ENGINE_MAX_BACKOFF_MS" => {
                    max_backoff = parse_duration_ms(&value).unwrap_or(DEFAULT_MAX_BACKOFF);
                }
                _ => {}
            }
        }

        if max_backoff < initial_backoff {
            max_backoff = initial_backoff;
        }

        Self {
            jar_path,
            health_path,
            startup_timeout,
            initial_backoff,
            max_backoff,
        }
    }

    fn disabled(&self) -> bool {
        self.jar_path.is_none()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum EngineStatus {
    Disabled,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct EnginePortResponse {
    engine: EngineStatus,
    port: Option<u16>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct EngineState {
    status: EngineStatus,
    port: Option<u16>,
    error: Option<String>,
}

impl EngineState {
    fn disabled() -> Self {
        Self {
            status: EngineStatus::Disabled,
            port: None,
            error: None,
        }
    }

    fn starting(port: u16) -> Self {
        Self {
            status: EngineStatus::Starting,
            port: Some(port),
            error: None,
        }
    }

    fn ready(port: u16) -> Self {
        Self {
            status: EngineStatus::Ready,
            port: Some(port),
            error: None,
        }
    }

    fn error(port: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status: EngineStatus::Error,
            port,
            error: Some(message.into()),
        }
    }
}

pub struct SidecarManager {
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
}

pub struct PortReservation {
    listener: TcpListener,
}

enum StartupOutcome {
    Ready,
    TimedOut,
    Stopped,
}

impl PortReservation {
    fn port(&self) -> std::io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }
}

impl SidecarManager {
    pub fn start(config: SidecarConfig) -> Self {
        let state = Arc::new(Mutex::new(EngineState::disabled()));
        let child = Arc::new(Mutex::new(None));
        let manager = Self {
            state: Arc::clone(&state),
            child: Arc::clone(&child),
        };

        if config.disabled() {
            return manager;
        }

        let reservation = match pick_free_port() {
            Ok(reservation) => reservation,
            Err(error) => {
                set_state(&state, EngineState::error(None, error.to_string()));
                return manager;
            }
        };
        let port = match reservation.port() {
            Ok(port) => port,
            Err(error) => {
                set_state(&state, EngineState::error(None, error.to_string()));
                return manager;
            }
        };

        set_state(&state, EngineState::starting(port));

        let jar_path = config
            .jar_path
            .clone()
            .expect("jar path is present when sidecar is enabled");
        // Holding the listener until immediately before spawning narrows the
        // TOCTOU window, but cannot eliminate it without server-side port-0
        // support that reports the bound port back to the shell.
        drop(reservation);
        match spawn_engine(&jar_path, port) {
            Ok(spawned_child) => {
                *child.lock().expect("sidecar child lock poisoned") = Some(spawned_child);
                poll_until_ready(config, jar_path, port, state, child, true);
            }
            Err(error) => {
                set_state(
                    &manager.state,
                    EngineState::error(Some(port), format!("failed to spawn engine: {error}")),
                );
            }
        }

        manager
    }

    fn get_engine_port(&self) -> EnginePortResponse {
        let state = self.state.lock().expect("sidecar state lock poisoned");
        EnginePortResponse {
            engine: state.status.clone(),
            port: state.port,
            error: state.error.clone(),
        }
    }

    pub fn shutdown(&self) {
        kill_child(&self.child);
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn get_engine_port(manager: tauri::State<'_, SidecarManager>) -> EnginePortResponse {
    manager.get_engine_port()
}

pub fn pick_free_port() -> std::io::Result<PortReservation> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(PortReservation { listener })
}

fn spawn_engine(jar_path: &PathBuf, port: u16) -> std::io::Result<Child> {
    let mut command = Command::new("java");
    command
        .arg("-jar")
        .arg(jar_path)
        .arg("--server.address=127.0.0.1")
        .arg(format!("--server.port={port}"));

    if let Some(parent) = jar_path.parent() {
        command.current_dir(parent);
    }

    command.spawn()
}

fn poll_until_ready(
    config: SidecarConfig,
    jar_path: PathBuf,
    port: u16,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
    retry_on_timeout: bool,
) {
    thread::spawn(
        move || match wait_until_ready(&config, port, &state, &child) {
            StartupOutcome::Ready => {
                supervise_child(port, state, child);
            }
            StartupOutcome::TimedOut => {
                kill_child(&child);

                if retry_on_timeout {
                    retry_startup(config, jar_path, state, child);
                    return;
                }

                set_state(
                    &state,
                    EngineState::error(Some(port), "engine health check timed out"),
                );
            }
            StartupOutcome::Stopped => {}
        },
    );
}

fn wait_until_ready(
    config: &SidecarConfig,
    port: u16,
    state: &Arc<Mutex<EngineState>>,
    child: &Arc<Mutex<Option<Child>>>,
) -> StartupOutcome {
    let deadline = Instant::now() + config.startup_timeout;
    let mut backoff = config.initial_backoff;

    loop {
        match take_child_exit_status(child) {
            Ok(Some(exit_status)) => {
                set_state(
                    state,
                    EngineState::error(
                        Some(port),
                        format!("engine exited before becoming ready: {exit_status}"),
                    ),
                );
                return StartupOutcome::Stopped;
            }
            Ok(None) => {}
            Err(error) => {
                set_state(
                    state,
                    EngineState::error(
                        Some(port),
                        format!("failed to check engine process: {error}"),
                    ),
                );
                return StartupOutcome::Stopped;
            }
        }
        if child.lock().expect("sidecar child lock poisoned").is_none() {
            return StartupOutcome::Stopped;
        }

        if health_check(port, &config.health_path).unwrap_or(false) {
            set_state(state, EngineState::ready(port));
            return StartupOutcome::Ready;
        }

        if Instant::now() >= deadline {
            return StartupOutcome::TimedOut;
        }

        thread::sleep(backoff);
        backoff = (backoff * 2).min(config.max_backoff);
    }
}

fn retry_startup(
    config: SidecarConfig,
    jar_path: PathBuf,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
) {
    let reservation = match pick_free_port() {
        Ok(reservation) => reservation,
        Err(error) => {
            set_state(&state, EngineState::error(None, error.to_string()));
            return;
        }
    };
    let port = match reservation.port() {
        Ok(port) => port,
        Err(error) => {
            set_state(&state, EngineState::error(None, error.to_string()));
            return;
        }
    };

    set_state(&state, EngineState::starting(port));
    // See the matching comment in SidecarManager::start: this keeps the race
    // window as small as the current engine contract permits.
    drop(reservation);

    match spawn_engine(&jar_path, port) {
        Ok(spawned_child) => {
            *child.lock().expect("sidecar child lock poisoned") = Some(spawned_child);
            match wait_until_ready(&config, port, &state, &child) {
                StartupOutcome::Ready => {
                    supervise_child(port, state, child);
                }
                StartupOutcome::TimedOut => {
                    kill_child(&child);
                    set_state(
                        &state,
                        EngineState::error(Some(port), "engine health check timed out"),
                    );
                }
                StartupOutcome::Stopped => {}
            }
        }
        Err(error) => {
            set_state(
                &state,
                EngineState::error(Some(port), format!("failed to spawn engine: {error}")),
            );
        }
    }
}

fn supervise_child(port: u16, state: Arc<Mutex<EngineState>>, child: Arc<Mutex<Option<Child>>>) {
    loop {
        match take_child_exit_status(&child) {
            Ok(Some(exit_status)) => {
                set_state(
                    &state,
                    EngineState::error(
                        Some(port),
                        format!("engine exited after becoming ready: {exit_status}"),
                    ),
                );
                return;
            }
            Ok(None) => {}
            Err(error) => {
                set_state(
                    &state,
                    EngineState::error(
                        Some(port),
                        format!("failed to check engine process: {error}"),
                    ),
                );
                return;
            }
        }

        if child.lock().expect("sidecar child lock poisoned").is_none() {
            return;
        }

        thread::sleep(Duration::from_secs(1));
    }
}

fn take_child_exit_status(
    child: &Arc<Mutex<Option<Child>>>,
) -> std::io::Result<Option<ExitStatus>> {
    let mut child = child.lock().expect("sidecar child lock poisoned");
    let Some(spawned_child) = child.as_mut() else {
        return Ok(None);
    };

    match spawned_child.try_wait()? {
        Some(exit_status) => {
            child.take();
            Ok(Some(exit_status))
        }
        None => Ok(None),
    }
}

fn kill_child(child: &Arc<Mutex<Option<Child>>>) {
    let Some(mut child) = child.lock().expect("sidecar child lock poisoned").take() else {
        return;
    };

    let _ = child.kill();
    let _ = child.wait();
}

fn health_check(port: u16, path: &str) -> std::io::Result<bool> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;

    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes())?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let Some(status_line) = response.lines().next() else {
        return Ok(false);
    };

    let mut parts = status_line.split_whitespace();
    Ok(matches!(
        (parts.next(), parts.next()),
        (Some("HTTP/1.0") | Some("HTTP/1.1"), Some("200"))
    ))
}

fn parse_duration_ms(value: &OsString) -> Option<Duration> {
    value
        .to_string_lossy()
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_millis)
}

fn normalize_health_path(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }

    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

fn set_state(state: &Arc<Mutex<EngineState>>, next: EngineState) {
    *state.lock().expect("sidecar state lock poisoned") = next;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_port_returns_bindable_loopback_port() {
        let reservation = pick_free_port().expect("port should be available");
        let port = reservation.port().expect("port should be readable");
        assert!(port > 0);
        drop(reservation);
        TcpListener::bind(("127.0.0.1", port)).expect("picked port should be bindable");
    }

    #[test]
    fn config_is_disabled_without_jar_path() {
        let config = SidecarConfig::from_env_vars(Vec::<(OsString, OsString)>::new());

        assert!(config.disabled());
        assert_eq!(config.jar_path, None);
        assert_eq!(config.health_path, DEFAULT_HEALTH_PATH);
        assert_eq!(config.startup_timeout, DEFAULT_STARTUP_TIMEOUT);
    }

    #[test]
    fn config_parses_engine_environment() {
        let config = SidecarConfig::from_env_vars(vec![
            ("RAIOPDF_ENGINE_JAR", "/opt/raiopdf/stirling.jar"),
            ("RAIOPDF_ENGINE_HEALTH_PATH", "healthz"),
            ("RAIOPDF_ENGINE_STARTUP_TIMEOUT_MS", "30000"),
            ("RAIOPDF_ENGINE_INITIAL_BACKOFF_MS", "25"),
            ("RAIOPDF_ENGINE_MAX_BACKOFF_MS", "250"),
        ]);

        assert!(!config.disabled());
        assert_eq!(
            config.jar_path,
            Some(PathBuf::from("/opt/raiopdf/stirling.jar"))
        );
        assert_eq!(config.health_path, "/healthz");
        assert_eq!(config.startup_timeout, Duration::from_secs(30));
        assert_eq!(config.initial_backoff, Duration::from_millis(25));
        assert_eq!(config.max_backoff, Duration::from_millis(250));
    }

    #[test]
    fn config_ignores_blank_jar_and_bad_durations() {
        let config = SidecarConfig::from_env_vars(vec![
            ("RAIOPDF_ENGINE_JAR", "   "),
            ("RAIOPDF_ENGINE_STARTUP_TIMEOUT_MS", "nope"),
        ]);

        assert!(config.disabled());
        assert_eq!(config.startup_timeout, DEFAULT_STARTUP_TIMEOUT);
    }

    #[test]
    fn config_keeps_max_backoff_at_least_initial_backoff() {
        let config = SidecarConfig::from_env_vars(vec![
            ("RAIOPDF_ENGINE_INITIAL_BACKOFF_MS", "500"),
            ("RAIOPDF_ENGINE_MAX_BACKOFF_MS", "100"),
        ]);

        assert_eq!(config.initial_backoff, Duration::from_millis(500));
        assert_eq!(config.max_backoff, Duration::from_millis(500));
    }
}
