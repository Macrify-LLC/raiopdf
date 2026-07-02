use serde::Serialize;
use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, ExitStatus},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_HEALTH_PATH: &str = "/api/v1/info/status";
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_IDLE_SHUTDOWN_MINUTES: u64 = 5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SidecarConfig {
    jar_path: Option<PathBuf>,
    health_path: String,
    startup_timeout: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    idle_shutdown: Option<Duration>,
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
        let mut idle_shutdown = idle_shutdown_from_minutes(DEFAULT_IDLE_SHUTDOWN_MINUTES);

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
                "RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES" => {
                    if let Some(minutes) = parse_u64(&value) {
                        idle_shutdown = idle_shutdown_from_minutes(minutes);
                    }
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
            idle_shutdown,
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
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineStartResponse {
    #[serde(skip_serializing_if = "is_false")]
    disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
}

impl EngineStartResponse {
    fn disabled() -> Self {
        Self {
            disabled: true,
            port: None,
        }
    }

    fn ready(port: u16) -> Self {
        Self {
            disabled: false,
            port: Some(port),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineStatusResponse {
    engine: EngineStatus,
    disabled: bool,
    port: Option<u16>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineStopResponse {
    stopped: bool,
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

    fn stopped() -> Self {
        Self {
            status: EngineStatus::Stopped,
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

#[derive(Debug)]
struct IdleShutdownTimer {
    last_touch: Instant,
    shutdown_after: Option<Duration>,
}

impl IdleShutdownTimer {
    fn new(now: Instant, shutdown_after: Option<Duration>) -> Self {
        Self {
            last_touch: now,
            shutdown_after,
        }
    }

    fn touch(&mut self, now: Instant) {
        self.last_touch = now;
    }

    fn remaining(&self, now: Instant) -> Option<Duration> {
        let shutdown_after = self.shutdown_after?;
        let elapsed = now.saturating_duration_since(self.last_touch);
        Some(shutdown_after.saturating_sub(elapsed))
    }

    fn expired(&self, now: Instant) -> bool {
        matches!(self.remaining(now), Some(remaining) if remaining.is_zero())
    }
}

#[derive(Debug)]
struct IdleShutdownState {
    timer: IdleShutdownTimer,
    stopped: bool,
}

pub struct SidecarManager {
    config: SidecarConfig,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
    lifecycle_lock: Arc<Mutex<()>>,
    idle: Arc<(Mutex<IdleShutdownState>, Condvar)>,
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
    pub fn new(config: SidecarConfig) -> Self {
        let state = Arc::new(Mutex::new(if config.disabled() {
            EngineState::disabled()
        } else {
            EngineState::stopped()
        }));
        let child = Arc::new(Mutex::new(None));
        let lifecycle_lock = Arc::new(Mutex::new(()));
        let idle = Arc::new((
            Mutex::new(IdleShutdownState {
                timer: IdleShutdownTimer::new(Instant::now(), config.idle_shutdown),
                stopped: false,
            }),
            Condvar::new(),
        ));

        start_idle_supervisor(
            Arc::clone(&idle),
            Arc::clone(&state),
            Arc::clone(&child),
            Arc::clone(&lifecycle_lock),
            config.disabled(),
        );

        Self {
            config,
            state,
            child,
            lifecycle_lock,
            idle,
        }
    }

    fn engine_start(&self) -> Result<EngineStartResponse, String> {
        self.touch_idle();

        if self.config.disabled() {
            set_state(&self.state, EngineState::disabled());
            return Ok(EngineStartResponse::disabled());
        }

        let _guard = self
            .lifecycle_lock
            .lock()
            .expect("sidecar lifecycle lock poisoned");

        if let Some(port) = self.reap_and_get_ready_port()? {
            return Ok(EngineStartResponse::ready(port));
        }

        let jar_path = self
            .config
            .jar_path
            .clone()
            .expect("jar path is present when sidecar is enabled");

        for attempt_index in 0..2 {
            match self.start_once(&jar_path) {
                Ok(port) => return Ok(EngineStartResponse::ready(port)),
                Err(StartAttemptError::TimedOut(_port)) if attempt_index == 0 => {
                    kill_child(&self.child);
                    set_state(&self.state, EngineState::stopped());
                    continue;
                }
                Err(StartAttemptError::TimedOut(port)) => {
                    kill_child(&self.child);
                    let message = "engine health check timed out".to_string();
                    set_state(&self.state, EngineState::error(Some(port), &message));
                    return Err(message);
                }
                Err(StartAttemptError::Stopped(message)) => return Err(message),
            }
        }

        let message = "engine failed to start".to_string();
        set_state(&self.state, EngineState::error(None, &message));
        Err(message)
    }

    fn engine_status(&self) -> Result<EngineStatusResponse, String> {
        self.touch_idle();
        let _guard = self
            .lifecycle_lock
            .lock()
            .expect("sidecar lifecycle lock poisoned");
        self.reap_child_if_exited()?;

        let state = self.state.lock().expect("sidecar state lock poisoned");
        Ok(EngineStatusResponse {
            engine: state.status.clone(),
            disabled: self.config.disabled(),
            port: state.port,
            error: state.error.clone(),
        })
    }

    fn engine_stop(&self) -> EngineStopResponse {
        self.touch_idle();
        let _guard = self
            .lifecycle_lock
            .lock()
            .expect("sidecar lifecycle lock poisoned");
        let stopped = self.stop_child();
        EngineStopResponse { stopped }
    }

    pub fn shutdown(&self) {
        self.stop_idle_supervisor();
        self.stop_child();
    }

    fn start_once(&self, jar_path: &PathBuf) -> Result<u16, StartAttemptError> {
        let reservation =
            pick_free_port().map_err(|error| StartAttemptError::Stopped(error.to_string()))?;
        let port = reservation
            .port()
            .map_err(|error| StartAttemptError::Stopped(error.to_string()))?;

        set_state(&self.state, EngineState::starting(port));
        // Holding the listener until immediately before spawning narrows the
        // TOCTOU window, but cannot eliminate it without server-side port-0
        // support that reports the bound port back to the shell.
        drop(reservation);

        match spawn_engine(jar_path, port) {
            Ok(spawned_child) => {
                *self.child.lock().expect("sidecar child lock poisoned") = Some(spawned_child);
            }
            Err(error) => {
                let message = format!("failed to spawn engine: {error}");
                set_state(&self.state, EngineState::error(Some(port), &message));
                return Err(StartAttemptError::Stopped(message));
            }
        }

        match wait_until_ready(&self.config, port, &self.state, &self.child) {
            StartupOutcome::Ready => {
                spawn_child_supervisor(port, Arc::clone(&self.state), Arc::clone(&self.child));
                Ok(port)
            }
            StartupOutcome::TimedOut => Err(StartAttemptError::TimedOut(port)),
            StartupOutcome::Stopped => {
                let message = current_error(&self.state)
                    .unwrap_or_else(|| "engine stopped before becoming ready".to_string());
                Err(StartAttemptError::Stopped(message))
            }
        }
    }

    fn reap_and_get_ready_port(&self) -> Result<Option<u16>, String> {
        self.reap_child_if_exited()?;
        let state = self.state.lock().expect("sidecar state lock poisoned");
        let child_running = self
            .child
            .lock()
            .expect("sidecar child lock poisoned")
            .is_some();

        if child_running && matches!(state.status, EngineStatus::Ready) {
            return Ok(state.port);
        }

        Ok(None)
    }

    fn reap_child_if_exited(&self) -> Result<(), String> {
        match take_child_exit_status(&self.child) {
            Ok(Some(exit_status)) => {
                let port = self.state.lock().expect("sidecar state lock poisoned").port;
                set_state(
                    &self.state,
                    EngineState::error(
                        port,
                        format!("engine exited after becoming ready: {exit_status}"),
                    ),
                );
            }
            Ok(None) => {}
            Err(error) => return Err(format!("failed to check engine process: {error}")),
        }

        Ok(())
    }

    fn stop_child(&self) -> bool {
        let stopped = kill_child(&self.child);
        set_state(
            &self.state,
            if self.config.disabled() {
                EngineState::disabled()
            } else {
                EngineState::stopped()
            },
        );
        stopped
    }

    fn touch_idle(&self) {
        let (idle, wake_idle) = &*self.idle;
        let mut idle = idle.lock().expect("sidecar idle lock poisoned");
        idle.timer.touch(Instant::now());
        wake_idle.notify_one();
    }

    fn stop_idle_supervisor(&self) {
        let (idle, wake_idle) = &*self.idle;
        let mut idle = idle.lock().expect("sidecar idle lock poisoned");
        idle.stopped = true;
        wake_idle.notify_one();
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

enum StartAttemptError {
    TimedOut(u16),
    Stopped(String),
}

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

fn spawn_child_supervisor(
    port: u16,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
) {
    thread::spawn(move || supervise_child(port, state, child));
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

fn start_idle_supervisor(
    idle: Arc<(Mutex<IdleShutdownState>, Condvar)>,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
    lifecycle_lock: Arc<Mutex<()>>,
    disabled: bool,
) {
    thread::spawn(move || loop {
        let (idle_lock, wake_idle) = &*idle;
        let mut idle_state = idle_lock.lock().expect("sidecar idle lock poisoned");

        loop {
            if idle_state.stopped {
                return;
            }

            let Some(remaining) = idle_state.timer.remaining(Instant::now()) else {
                idle_state = wake_idle
                    .wait(idle_state)
                    .expect("sidecar idle lock poisoned");
                continue;
            };

            if remaining.is_zero() {
                break;
            }

            let (next_idle_state, _) = wake_idle
                .wait_timeout(idle_state, remaining)
                .expect("sidecar idle lock poisoned");
            idle_state = next_idle_state;
        }

        drop(idle_state);

        let _guard = lifecycle_lock
            .lock()
            .expect("sidecar lifecycle lock poisoned");
        let mut idle_state = idle_lock.lock().expect("sidecar idle lock poisoned");

        if idle_state.stopped {
            return;
        }

        if !idle_state.timer.expired(Instant::now()) {
            continue;
        }

        drop(idle_state);

        if kill_child(&child) {
            set_state(
                &state,
                if disabled {
                    EngineState::disabled()
                } else {
                    EngineState::stopped()
                },
            );
        }

        idle_state = idle_lock.lock().expect("sidecar idle lock poisoned");
        idle_state.timer.touch(Instant::now());
    });
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

fn kill_child(child: &Arc<Mutex<Option<Child>>>) -> bool {
    let Some(mut child) = child.lock().expect("sidecar child lock poisoned").take() else {
        return false;
    };

    let _ = child.kill();
    let _ = child.wait();
    true
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
    parse_u64(value).map(Duration::from_millis)
}

fn parse_u64(value: &OsString) -> Option<u64> {
    value.to_string_lossy().trim().parse::<u64>().ok()
}

fn idle_shutdown_from_minutes(minutes: u64) -> Option<Duration> {
    if minutes == 0 {
        return None;
    }

    Some(Duration::from_secs(minutes.saturating_mul(60)))
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

fn current_error(state: &Arc<Mutex<EngineState>>) -> Option<String> {
    state
        .lock()
        .expect("sidecar state lock poisoned")
        .error
        .clone()
}

fn is_false(value: &bool) -> bool {
    !*value
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
        assert_eq!(
            config.idle_shutdown,
            idle_shutdown_from_minutes(DEFAULT_IDLE_SHUTDOWN_MINUTES)
        );
    }

    #[test]
    fn config_parses_engine_environment() {
        let config = SidecarConfig::from_env_vars(vec![
            ("RAIOPDF_ENGINE_JAR", "/opt/raiopdf/stirling.jar"),
            ("RAIOPDF_ENGINE_HEALTH_PATH", "healthz"),
            ("RAIOPDF_ENGINE_STARTUP_TIMEOUT_MS", "30000"),
            ("RAIOPDF_ENGINE_INITIAL_BACKOFF_MS", "25"),
            ("RAIOPDF_ENGINE_MAX_BACKOFF_MS", "250"),
            ("RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES", "2"),
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
        assert_eq!(config.idle_shutdown, Some(Duration::from_secs(120)));
    }

    #[test]
    fn config_ignores_blank_jar_and_bad_durations() {
        let config = SidecarConfig::from_env_vars(vec![
            ("RAIOPDF_ENGINE_JAR", "   "),
            ("RAIOPDF_ENGINE_STARTUP_TIMEOUT_MS", "nope"),
            ("RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES", "nope"),
        ]);

        assert!(config.disabled());
        assert_eq!(config.startup_timeout, DEFAULT_STARTUP_TIMEOUT);
        assert_eq!(
            config.idle_shutdown,
            idle_shutdown_from_minutes(DEFAULT_IDLE_SHUTDOWN_MINUTES)
        );
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

    #[test]
    fn idle_shutdown_can_be_disabled_with_zero_minutes() {
        let config =
            SidecarConfig::from_env_vars(vec![("RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES", "0")]);

        assert_eq!(config.idle_shutdown, None);
    }

    #[test]
    fn idle_timer_expires_only_after_configured_idle_window() {
        let now = Instant::now();
        let timer = IdleShutdownTimer::new(now, Some(Duration::from_secs(60)));

        assert_eq!(timer.remaining(now), Some(Duration::from_secs(60)));
        assert!(!timer.expired(now + Duration::from_secs(59)));
        assert!(timer.expired(now + Duration::from_secs(60)));
        assert!(timer.expired(now + Duration::from_secs(61)));
    }

    #[test]
    fn idle_timer_touch_resets_deadline() {
        let now = Instant::now();
        let mut timer = IdleShutdownTimer::new(now, Some(Duration::from_secs(60)));

        timer.touch(now + Duration::from_secs(50));

        assert!(!timer.expired(now + Duration::from_secs(109)));
        assert!(timer.expired(now + Duration::from_secs(110)));
    }

    #[test]
    fn disabled_idle_timer_never_expires() {
        let now = Instant::now();
        let timer = IdleShutdownTimer::new(now, None);

        assert_eq!(timer.remaining(now + Duration::from_secs(3600)), None);
        assert!(!timer.expired(now + Duration::from_secs(3600)));
    }
}
