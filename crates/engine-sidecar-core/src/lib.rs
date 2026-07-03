use serde::Serialize;
use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const DEFAULT_HEALTH_PATH: &str = "/api/v1/info/status";
pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
pub const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_millis(100);
pub const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(1);
pub const DEFAULT_IDLE_SHUTDOWN_MINUTES: u64 = 15;
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;
pub const PAYLOAD_DIR_NAME: &str = "payload";
pub const ENGINE_LOG_FILE_NAME: &str = "engine.log";
pub const ENGINE_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const ENGINE_LOG_GENERATIONS: usize = 2;
pub const AUTH_HEADER_NAME: &str = "x-raiopdf-auth";
pub const CORS_ALLOW_HEADERS: &str = "Content-Type, X-RaioPDF-Auth";
pub const CORS_ALLOW_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
pub const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;
pub const ENGINE_JAR_RELATIVE: &[&str] = &["engine", "stirling.jar"];
pub const OCRMYPDF_RELATIVE: &[&str] = &["ocr", "ocrmypdf.cmd"];
pub const PYTHON_RELATIVE: &[&str] = &["ocr", "python", "python.exe"];
pub const TESSDATA_RELATIVE: &[&str] = &["ocr", "tesseract", "tessdata"];
pub const TESSERACT_RELATIVE: &[&str] = &["ocr", "tesseract", "tesseract.exe"];
pub const TESSDATA_ENG_RELATIVE: &[&str] = &["ocr", "tesseract", "tessdata", "eng.traineddata"];
pub const GHOSTSCRIPT_RELATIVE: &[&str] = &["ocr", "gs", "bin", "gs.exe"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SidecarConfig {
    jar_path: Option<PathBuf>,
    java_path: PathBuf,
    engine_log_path: PathBuf,
    stirling_base_path: Option<PathBuf>,
    ocrmypdf_path: Option<PathBuf>,
    python_path: Option<PathBuf>,
    ocr_python_required: bool,
    tessdata_dir: Option<PathBuf>,
    tesseract_path: Option<PathBuf>,
    tessdata_eng_path: Option<PathBuf>,
    ghostscript_path: Option<PathBuf>,
    path_entries: Vec<PathBuf>,
    path_env_key: OsString,
    inherited_path: Option<OsString>,
    health_path: String,
    startup_timeout: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    idle_shutdown: Option<Duration>,
}

impl SidecarConfig {
    pub fn from_env(app_data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Self {
        Self::from_env_vars_with_roots(
            env::vars_os(),
            app_data_dir,
            current_exe_dir(),
            resource_dir,
            dev_payload_dir(),
        )
    }

    pub fn from_env_vars<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        Self::from_env_vars_with_roots(vars, PathBuf::from("app-data"), None, None, None)
    }

    pub fn from_env_vars_with_roots<I, K, V>(
        vars: I,
        default_app_data_dir: PathBuf,
        exe_dir: Option<PathBuf>,
        resource_dir: Option<PathBuf>,
        dev_payload_dir: Option<PathBuf>,
    ) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let mut jar_path = None;
        let mut java_path = None;
        let mut payload_dir = None;
        let mut stirling_base_path = None;
        let mut ocrmypdf_path = None;
        let mut ocrmypdf_path_from_env = false;
        let mut python_path = None;
        let mut tessdata_dir = None;
        let mut tesseract_path = None;
        let mut tessdata_eng_path = None;
        let mut ghostscript_path = None;
        let mut health_path = DEFAULT_HEALTH_PATH.to_string();
        let mut startup_timeout = DEFAULT_STARTUP_TIMEOUT;
        let mut initial_backoff = DEFAULT_INITIAL_BACKOFF;
        let mut max_backoff = DEFAULT_MAX_BACKOFF;
        let mut idle_shutdown = idle_shutdown_from_minutes(DEFAULT_IDLE_SHUTDOWN_MINUTES);
        let mut path_env_key = OsString::from("PATH");
        let mut inherited_path = None;

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
                "RAIOPDF_ENGINE_JAVA" => {
                    let value = value.to_string_lossy().trim().to_string();
                    if !value.is_empty() {
                        java_path = Some(PathBuf::from(value));
                    }
                }
                "RAIOPDF_ENGINE_PAYLOAD_DIR" => {
                    let value = value.to_string_lossy().trim().to_string();
                    if !value.is_empty() {
                        payload_dir = Some(PathBuf::from(value));
                    }
                }
                "RAIOPDF_ENGINE_BASE_PATH" | "STIRLING_BASE_PATH" => {
                    let value = value.to_string_lossy().trim().to_string();
                    if !value.is_empty() {
                        stirling_base_path = Some(PathBuf::from(value));
                    }
                }
                "RAIOPDF_ENGINE_OCRMYPDF" => {
                    let value = value.to_string_lossy().trim().to_string();
                    if !value.is_empty() {
                        ocrmypdf_path = Some(PathBuf::from(value));
                        ocrmypdf_path_from_env = true;
                    }
                }
                "RAIOPDF_ENGINE_TESSDATA_DIR" => {
                    let value = value.to_string_lossy().trim().to_string();
                    if !value.is_empty() {
                        tessdata_dir = Some(PathBuf::from(value));
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
                _ if key.to_string_lossy().eq_ignore_ascii_case("PATH") => {
                    path_env_key = key;
                    inherited_path = Some(value);
                }
                _ => {}
            }
        }

        let payload_dir = payload_dir.or_else(|| {
            find_payload_dir(
                exe_dir.as_deref(),
                resource_dir.as_deref(),
                dev_payload_dir.as_deref(),
            )
        });

        let mut ocr_python_required = false;
        if let Some(payload_dir) = payload_dir.as_deref() {
            jar_path = jar_path.or_else(|| existing_join(payload_dir, ENGINE_JAR_RELATIVE));
            java_path = java_path.or_else(|| payload_java_path(payload_dir));
            ocrmypdf_path = ocrmypdf_path.or_else(|| existing_join(payload_dir, OCRMYPDF_RELATIVE));
            python_path = python_path.or_else(|| existing_join(payload_dir, PYTHON_RELATIVE));
            ocr_python_required = !ocrmypdf_path_from_env;
            tessdata_dir = tessdata_dir.or_else(|| existing_join(payload_dir, TESSDATA_RELATIVE));
            tesseract_path =
                tesseract_path.or_else(|| existing_join(payload_dir, TESSERACT_RELATIVE));
            tessdata_eng_path =
                tessdata_eng_path.or_else(|| existing_join(payload_dir, TESSDATA_ENG_RELATIVE));
            ghostscript_path =
                ghostscript_path.or_else(|| existing_join(payload_dir, GHOSTSCRIPT_RELATIVE));
        }

        let path_entries = payload_dir
            .as_deref()
            .map(payload_path_entries)
            .unwrap_or_default();
        let java_path = java_path.unwrap_or_else(|| PathBuf::from("java"));
        let engine_log_path = default_app_data_dir.join(ENGINE_LOG_FILE_NAME);
        let stirling_base_path = if jar_path.is_some() {
            Some(stirling_base_path.unwrap_or(default_app_data_dir))
        } else {
            None
        };

        if max_backoff < initial_backoff {
            max_backoff = initial_backoff;
        }

        Self {
            jar_path,
            java_path,
            engine_log_path,
            stirling_base_path,
            ocrmypdf_path,
            python_path,
            ocr_python_required,
            tessdata_dir,
            tesseract_path,
            tessdata_eng_path,
            ghostscript_path,
            path_entries,
            path_env_key,
            inherited_path,
            health_path,
            startup_timeout,
            initial_backoff,
            max_backoff,
            idle_shutdown,
        }
    }

    pub fn disabled(&self) -> bool {
        self.jar_path.is_none()
    }

    pub fn write_settings(&self) -> std::io::Result<()> {
        let Some(stirling_base_path) = self.stirling_base_path.as_ref() else {
            return Ok(());
        };
        let Some(ocrmypdf_path) = self.ocrmypdf_path.as_ref() else {
            return Ok(());
        };
        let Some(tessdata_dir) = self.tessdata_dir.as_ref() else {
            return Ok(());
        };

        let configs_dir = stirling_base_path.join("configs");
        fs::create_dir_all(&configs_dir)?;
        fs::write(
            configs_dir.join("custom_settings.yml"),
            stirling_settings_yaml(ocrmypdf_path, tessdata_dir),
        )
    }

    pub fn ocr_toolchain(&self) -> OcrToolchainStatus {
        let mut missing = Vec::new();

        if self.ocrmypdf_path.is_none() {
            missing.push("ocr/ocrmypdf.cmd".to_string());
        }
        if self.ocr_python_required && self.python_path.is_none() {
            missing.push("ocr/python/python.exe".to_string());
        }
        if self.tesseract_path.is_none() {
            missing.push("ocr/tesseract/tesseract.exe".to_string());
        }
        if self.tessdata_eng_path.is_none() {
            missing.push("ocr/tesseract/tessdata/eng.traineddata".to_string());
        }
        if self.ghostscript_path.is_none() {
            missing.push("ocr/gs/bin/gs.exe".to_string());
        }

        OcrToolchainStatus {
            available: missing.is_empty(),
            missing,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineStatus {
    Disabled,
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartResponse {
    #[serde(skip_serializing_if = "is_false")]
    disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    ocr_toolchain: OcrToolchainStatus,
}

impl EngineStartResponse {
    fn disabled_response(ocr_toolchain: OcrToolchainStatus) -> Self {
        Self {
            disabled: true,
            port: None,
            token: None,
            ocr_toolchain,
        }
    }

    fn ready(port: u16, token: &str, ocr_toolchain: OcrToolchainStatus) -> Self {
        Self {
            disabled: false,
            port: Some(port),
            token: Some(token.to_string()),
            ocr_toolchain,
        }
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn disabled(&self) -> bool {
        self.disabled
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrToolchainStatus {
    available: bool,
    missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatusResponse {
    engine: EngineStatus,
    disabled: bool,
    port: Option<u16>,
    error: Option<String>,
    ocr_toolchain: OcrToolchainStatus,
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineStopResponse {
    stopped: bool,
}

impl EngineStopResponse {
    pub fn stopped(&self) -> bool {
        self.stopped
    }
}

#[derive(Clone, Debug)]
pub struct EngineState {
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
pub struct IdleShutdownTimer {
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
pub struct IdleShutdownState {
    timer: IdleShutdownTimer,
    active_requests: usize,
    stopped: bool,
}

pub struct SidecarManager {
    config: SidecarConfig,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
    proxy: Arc<Mutex<Option<ProxyHandle>>>,
    lifecycle_lock: Arc<Mutex<()>>,
    idle: Arc<(Mutex<IdleShutdownState>, Condvar)>,
    auth_token: String,
}

pub struct PortReservation {
    listener: TcpListener,
}

pub enum StartupOutcome {
    Ready,
    TimedOut,
    Stopped,
}

#[derive(Clone, Debug)]
pub struct ProxyHandle {
    port: u16,
    shutdown: Arc<AtomicBool>,
}

impl PortReservation {
    pub fn port(&self) -> std::io::Result<u16> {
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
        let proxy = Arc::new(Mutex::new(None));
        let lifecycle_lock = Arc::new(Mutex::new(()));
        let idle = Arc::new((
            Mutex::new(IdleShutdownState {
                timer: IdleShutdownTimer::new(Instant::now(), config.idle_shutdown),
                active_requests: 0,
                stopped: false,
            }),
            Condvar::new(),
        ));

        start_idle_supervisor(
            Arc::clone(&idle),
            Arc::clone(&state),
            Arc::clone(&child),
            Arc::clone(&proxy),
            Arc::clone(&lifecycle_lock),
            config.disabled(),
        );

        Self {
            config,
            state,
            child,
            proxy,
            lifecycle_lock,
            idle,
            auth_token: generate_auth_token(),
        }
    }

    pub fn engine_start(&self) -> Result<EngineStartResponse, String> {
        self.touch_idle();

        if self.config.disabled() {
            set_state(&self.state, EngineState::disabled());
            return Ok(EngineStartResponse::disabled_response(
                self.config.ocr_toolchain(),
            ));
        }

        let _guard = self
            .lifecycle_lock
            .lock()
            .expect("sidecar lifecycle lock poisoned");

        if let Some(port) = self.reap_and_get_ready_port()? {
            return Ok(EngineStartResponse::ready(
                port,
                &self.auth_token,
                self.config.ocr_toolchain(),
            ));
        }

        for attempt_index in 0..2 {
            match self.start_once() {
                Ok(port) => {
                    return Ok(EngineStartResponse::ready(
                        port,
                        &self.auth_token,
                        self.config.ocr_toolchain(),
                    ))
                }
                Err(StartAttemptError::TimedOut(_port)) if attempt_index == 0 => {
                    kill_child(&self.child);
                    stop_proxy(&self.proxy);
                    set_state(&self.state, EngineState::stopped());
                    continue;
                }
                Err(StartAttemptError::TimedOut(port)) => {
                    kill_child(&self.child);
                    stop_proxy(&self.proxy);
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

    pub fn engine_status(&self) -> Result<EngineStatusResponse, String> {
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
            ocr_toolchain: self.config.ocr_toolchain(),
        })
    }

    pub fn engine_stop(&self) -> EngineStopResponse {
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

    pub fn start_once(&self) -> Result<u16, StartAttemptError> {
        let engine_reservation =
            pick_free_port().map_err(|error| StartAttemptError::Stopped(error.to_string()))?;
        let engine_port = engine_reservation
            .port()
            .map_err(|error| StartAttemptError::Stopped(error.to_string()))?;
        // The proxy binds a fresh loopback port per boot (port 0 = OS-assigned), which is
        // why the webview CSP connect-src can only scope to 127.0.0.1 and not a fixed port.
        // Tightening that to a single origin (or a custom protocol) is tracked post-v1.0.
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| StartAttemptError::Stopped(error.to_string()))?;
        let proxy_port = proxy_listener
            .local_addr()
            .map_err(|error| StartAttemptError::Stopped(error.to_string()))?
            .port();

        set_state(&self.state, EngineState::starting(proxy_port));
        // Holding the listener until immediately before spawning narrows the
        // TOCTOU window, but cannot eliminate it without server-side port-0
        // support that reports the bound port back to the shell.
        drop(engine_reservation);

        match spawn_engine(&self.config, engine_port) {
            Ok(spawned_child) => {
                *self.child.lock().expect("sidecar child lock poisoned") = Some(spawned_child);
            }
            Err(error) => {
                let message = format!("failed to spawn engine: {error}");
                set_state(&self.state, EngineState::error(Some(proxy_port), &message));
                return Err(StartAttemptError::Stopped(message));
            }
        }

        match wait_until_ready(
            &self.config,
            engine_port,
            proxy_port,
            &self.state,
            &self.child,
        ) {
            StartupOutcome::Ready => {
                let proxy = start_auth_proxy_with_idle(
                    proxy_listener,
                    engine_port,
                    self.auth_token.clone(),
                    Arc::clone(&self.idle),
                )
                .map_err(|error| {
                    let message = format!("failed to start authenticated engine proxy: {error}");
                    set_state(&self.state, EngineState::error(Some(proxy_port), &message));
                    StartAttemptError::Stopped(message)
                })?;
                *self.proxy.lock().expect("sidecar proxy lock poisoned") = Some(proxy);
                set_state(&self.state, EngineState::ready(proxy_port));
                spawn_child_supervisor(
                    proxy_port,
                    Arc::clone(&self.state),
                    Arc::clone(&self.child),
                    Arc::clone(&self.proxy),
                );
                Ok(proxy_port)
            }
            StartupOutcome::TimedOut => Err(StartAttemptError::TimedOut(proxy_port)),
            StartupOutcome::Stopped => {
                let message = current_error(&self.state)
                    .unwrap_or_else(|| "engine stopped before becoming ready".to_string());
                Err(StartAttemptError::Stopped(message))
            }
        }
    }

    pub fn reap_and_get_ready_port(&self) -> Result<Option<u16>, String> {
        self.reap_child_if_exited()?;
        let state = self.state.lock().expect("sidecar state lock poisoned");
        let child_running = self
            .child
            .lock()
            .expect("sidecar child lock poisoned")
            .is_some();

        if child_running && matches!(state.status, EngineStatus::Ready) {
            let proxy_running = self
                .proxy
                .lock()
                .expect("sidecar proxy lock poisoned")
                .as_ref()
                .is_some_and(|proxy| Some(proxy.port) == state.port);
            if !proxy_running {
                return Err("authenticated engine proxy is not running".to_string());
            }
            return Ok(state.port);
        }

        Ok(None)
    }

    pub fn reap_child_if_exited(&self) -> Result<(), String> {
        match take_child_exit_status(&self.child) {
            Ok(Some(exit_status)) => {
                let port = self.state.lock().expect("sidecar state lock poisoned").port;
                stop_proxy(&self.proxy);
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

    pub fn stop_child(&self) -> bool {
        let stopped = kill_child(&self.child);
        stop_proxy(&self.proxy);
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

    pub fn touch_idle(&self) {
        let (idle, wake_idle) = &*self.idle;
        let mut idle = idle.lock().expect("sidecar idle lock poisoned");
        idle.timer.touch(Instant::now());
        wake_idle.notify_one();
    }

    pub fn stop_idle_supervisor(&self) {
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

pub enum StartAttemptError {
    TimedOut(u16),
    Stopped(String),
}

pub fn pick_free_port() -> std::io::Result<PortReservation> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(PortReservation { listener })
}

#[derive(Debug, Eq, PartialEq)]
pub struct EngineSpawnSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    pub envs: Vec<(OsString, OsString)>,
    pub log_path: PathBuf,
}

pub fn spawn_engine(config: &SidecarConfig, port: u16) -> std::io::Result<Child> {
    let spec = engine_spawn_spec(config, port)?;
    let log_writer = Arc::new(Mutex::new(RotatingLogWriter::new(
        &spec.log_path,
        ENGINE_LOG_MAX_BYTES,
        ENGINE_LOG_GENERATIONS,
    )?));
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    if let Some(current_dir) = spec.current_dir {
        command.current_dir(current_dir);
    }
    for (key, value) in spec.envs {
        command.env(key, value);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    apply_platform_spawn_flags(&mut command);
    let mut child = command.spawn()?;

    if let Some(stdout) = child.stdout.take() {
        copy_pipe_to_log(stdout, Arc::clone(&log_writer));
    }
    if let Some(stderr) = child.stderr.take() {
        copy_pipe_to_log(stderr, log_writer);
    }

    Ok(child)
}

pub fn engine_spawn_spec(config: &SidecarConfig, port: u16) -> std::io::Result<EngineSpawnSpec> {
    config.write_settings()?;

    let jar_path = config
        .jar_path
        .clone()
        .expect("jar path is present when sidecar is enabled");
    let mut envs = Vec::new();

    if let Some(stirling_base_path) = config.stirling_base_path.as_ref() {
        envs.push((
            OsString::from("STIRLING_BASE_PATH"),
            stirling_base_path.as_os_str().to_os_string(),
        ));
    }

    if let Some(path) = child_path(config) {
        envs.push((config.path_env_key.clone(), path));
    }

    if let Some(tessdata_dir) = config.tessdata_dir.as_ref() {
        // OCRmyPDF invokes tesseract as a child process; this keeps that lookup on the bundled data.
        envs.push((
            OsString::from("TESSDATA_PREFIX"),
            tessdata_dir.as_os_str().to_os_string(),
        ));
    }

    Ok(EngineSpawnSpec {
        program: config.java_path.clone(),
        args: vec![
            OsString::from("-jar"),
            jar_path.as_os_str().to_os_string(),
            OsString::from("--server.address=127.0.0.1"),
            OsString::from(format!("--server.port={port}")),
        ],
        current_dir: jar_path.parent().map(Path::to_path_buf),
        envs,
        log_path: config.engine_log_path.clone(),
    })
}

fn open_rotated_engine_log(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    rotate_engine_log(path, ENGINE_LOG_GENERATIONS)?;
    open_truncated_engine_log(path)
}

fn open_truncated_engine_log(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
}

struct RotatingLogWriter {
    path: PathBuf,
    max_bytes: u64,
    generations: usize,
    bytes_written: u64,
    file: Option<File>,
}

impl RotatingLogWriter {
    fn new(path: &Path, max_bytes: u64, generations: usize) -> io::Result<Self> {
        let file = open_rotated_engine_log(path)?;

        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            generations,
            bytes_written: 0,
            file: Some(file),
        })
    }

    fn write_all(&mut self, mut buffer: &[u8]) -> io::Result<()> {
        while !buffer.is_empty() {
            if self.max_bytes > 0 && self.bytes_written >= self.max_bytes {
                self.rotate()?;
            }

            let bytes_available = if self.max_bytes == 0 {
                buffer.len()
            } else {
                self.max_bytes.saturating_sub(self.bytes_written) as usize
            };
            let write_len = bytes_available.min(buffer.len());

            if write_len == 0 {
                self.rotate()?;
                continue;
            }

            let file = self.file.as_mut().expect("log file is open");
            file.write_all(&buffer[..write_len])?;
            self.bytes_written += write_len as u64;
            buffer = &buffer[write_len..];
        }

        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }

        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
        }

        rotate_engine_log(&self.path, self.generations)?;
        self.file = Some(open_truncated_engine_log(&self.path)?);
        self.bytes_written = 0;

        Ok(())
    }
}

fn copy_pipe_to_log<R>(mut pipe: R, log_writer: Arc<Mutex<RotatingLogWriter>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0; 16 * 1024];

        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(bytes_read) => {
                    let Ok(mut writer) = log_writer.lock() else {
                        break;
                    };

                    if writer.write_all(&buffer[..bytes_read]).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    });
}

fn rotate_engine_log(path: &Path, generations: usize) -> io::Result<()> {
    for index in (1..=generations).rev() {
        let from = if index == 1 {
            path.to_path_buf()
        } else {
            rotated_log_path(path, index - 1)
        };
        let to = rotated_log_path(path, index);

        if !from.exists() {
            continue;
        }

        if to.exists() {
            fs::remove_file(&to)?;
        }
        fs::rename(from, to)?;
    }

    Ok(())
}

fn rotated_log_path(path: &Path, generation: usize) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(ENGINE_LOG_FILE_NAME);

    path.with_file_name(format!("{file_name}.{generation}"))
}

#[cfg(windows)]
fn apply_platform_spawn_flags(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_platform_spawn_flags(_command: &mut Command) {}

pub fn wait_until_ready(
    config: &SidecarConfig,
    engine_port: u16,
    proxy_port: u16,
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
                        Some(proxy_port),
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
                        Some(proxy_port),
                        format!("failed to check engine process: {error}"),
                    ),
                );
                return StartupOutcome::Stopped;
            }
        }
        if child.lock().expect("sidecar child lock poisoned").is_none() {
            return StartupOutcome::Stopped;
        }

        if health_check(engine_port, &config.health_path).unwrap_or(false) {
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
    proxy: Arc<Mutex<Option<ProxyHandle>>>,
) {
    thread::spawn(move || supervise_child(port, state, child, proxy));
}

fn supervise_child(
    port: u16,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
    proxy: Arc<Mutex<Option<ProxyHandle>>>,
) {
    loop {
        match take_child_exit_status(&child) {
            Ok(Some(exit_status)) => {
                stop_proxy(&proxy);
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
                stop_proxy(&proxy);
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

pub fn start_idle_supervisor(
    idle: Arc<(Mutex<IdleShutdownState>, Condvar)>,
    state: Arc<Mutex<EngineState>>,
    child: Arc<Mutex<Option<Child>>>,
    proxy: Arc<Mutex<Option<ProxyHandle>>>,
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

        if idle_state.active_requests > 0 {
            idle_state = wake_idle
                .wait(idle_state)
                .expect("sidecar idle lock poisoned");
            drop(idle_state);
            continue;
        }

        if !idle_state.timer.expired(Instant::now()) {
            continue;
        }

        drop(idle_state);

        if kill_child(&child) {
            stop_proxy(&proxy);
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

pub fn start_auth_proxy(
    listener: TcpListener,
    engine_port: u16,
    token: String,
) -> io::Result<ProxyHandle> {
    start_auth_proxy_inner(listener, engine_port, token, None)
}

fn start_auth_proxy_with_idle(
    listener: TcpListener,
    engine_port: u16,
    token: String,
    idle: Arc<(Mutex<IdleShutdownState>, Condvar)>,
) -> io::Result<ProxyHandle> {
    start_auth_proxy_inner(listener, engine_port, token, Some(idle))
}

fn start_auth_proxy_inner(
    listener: TcpListener,
    engine_port: u16,
    token: String,
    idle: Option<Arc<(Mutex<IdleShutdownState>, Condvar)>>,
) -> io::Result<ProxyHandle> {
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_for_thread = Arc::clone(&shutdown);

    thread::spawn(move || {
        run_auth_proxy_inner(listener, engine_port, token, shutdown_for_thread, idle);
    });

    Ok(ProxyHandle { port, shutdown })
}

pub fn run_auth_proxy(
    listener: TcpListener,
    engine_port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
) {
    run_auth_proxy_inner(listener, engine_port, token, shutdown, None);
}

fn run_auth_proxy_inner(
    listener: TcpListener,
    engine_port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    idle: Option<Arc<(Mutex<IdleShutdownState>, Condvar)>>,
) {
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((client, _)) => {
                let request_token = token.clone();
                let request_idle = idle.as_ref().map(Arc::clone);
                thread::spawn(move || {
                    let _ = proxy_client_with_activity(
                        client,
                        engine_port,
                        &request_token,
                        request_idle,
                    );
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return,
        }
    }
}

fn stop_proxy(proxy: &Arc<Mutex<Option<ProxyHandle>>>) {
    let Some(proxy) = proxy.lock().expect("sidecar proxy lock poisoned").take() else {
        return;
    };

    proxy.shutdown.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(("127.0.0.1", proxy.port));
}

pub fn proxy_client(client: TcpStream, engine_port: u16, token: &str) -> io::Result<()> {
    proxy_client_with_activity(client, engine_port, token, None)
}

fn proxy_client_with_activity(
    mut client: TcpStream,
    engine_port: u16,
    token: &str,
    idle: Option<Arc<(Mutex<IdleShutdownState>, Condvar)>>,
) -> io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    client.set_write_timeout(Some(Duration::from_secs(30)))?;

    let (request_head, buffered_body) = read_request_head(&mut client)?;

    if is_cors_preflight(&request_head) {
        write_cors_preflight_response(&mut client, &request_head)?;
        let _ = client.shutdown(Shutdown::Both);
        return Ok(());
    }

    if !request_has_valid_auth(&request_head, token) {
        client.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        )?;
        let _ = client.shutdown(Shutdown::Both);
        return Ok(());
    }

    client.set_read_timeout(None)?;
    client.set_write_timeout(None)?;
    let _active_request = idle.map(ActiveProxyRequest::new);

    let upstream_addr = SocketAddr::from(([127, 0, 0, 1], engine_port));
    let mut upstream = TcpStream::connect_timeout(&upstream_addr, Duration::from_secs(5))?;
    upstream.set_write_timeout(Some(Duration::from_secs(30)))?;
    upstream.write_all(&request_head)?;
    if !buffered_body.is_empty() {
        upstream.write_all(&buffered_body)?;
    }
    upstream.set_read_timeout(None)?;
    upstream.set_write_timeout(None)?;

    let mut upstream_writer = upstream.try_clone()?;
    let mut client_reader = client.try_clone()?;
    let copy_request = thread::spawn(move || {
        let _ = io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(Shutdown::Write);
    });

    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = copy_request.join();

    Ok(())
}

struct ActiveProxyRequest {
    idle: Arc<(Mutex<IdleShutdownState>, Condvar)>,
}

impl ActiveProxyRequest {
    fn new(idle: Arc<(Mutex<IdleShutdownState>, Condvar)>) -> Self {
        let (idle_lock, wake_idle) = &*idle;
        let mut idle_state = idle_lock.lock().expect("sidecar idle lock poisoned");
        idle_state.active_requests += 1;
        wake_idle.notify_one();
        drop(idle_state);

        Self { idle }
    }
}

impl Drop for ActiveProxyRequest {
    fn drop(&mut self) {
        let (idle_lock, wake_idle) = &*self.idle;
        let mut idle_state = idle_lock.lock().expect("sidecar idle lock poisoned");
        idle_state.active_requests = idle_state.active_requests.saturating_sub(1);
        idle_state.timer.touch(Instant::now());
        wake_idle.notify_one();
    }
}

pub fn read_request_head(stream: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0; 1024];

    loop {
        let bytes_read = stream.read(&mut chunk)?;
        if bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before request head",
            ));
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);

        if let Some(head_end) = request_head_end(&buffer) {
            let body = buffer.split_off(head_end);
            return Ok((buffer, body));
        }

        if buffer.len() > MAX_REQUEST_HEAD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head exceeds maximum size",
            ));
        }
    }
}

fn request_head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

pub fn request_has_valid_auth(request_head: &[u8], token: &str) -> bool {
    let Ok(request_head) = std::str::from_utf8(request_head) else {
        return false;
    };

    request_head.lines().skip(1).any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };

        name.trim().eq_ignore_ascii_case(AUTH_HEADER_NAME)
            && constant_time_eq(value.trim().as_bytes(), token.as_bytes())
    })
}

/// Constant-time byte comparison so auth-token checking doesn't leak length or
/// content through timing. The token is 32 OS-random bytes on loopback, so the
/// exposure is low, but the check should not be an early-exit `==`.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn is_cors_preflight(request_head: &[u8]) -> bool {
    request_method(request_head).is_some_and(|method| method.eq_ignore_ascii_case("OPTIONS"))
        && request_header(request_head, "origin").is_some()
        && request_header(request_head, "access-control-request-method").is_some()
}

fn write_cors_preflight_response(client: &mut TcpStream, request_head: &[u8]) -> io::Result<()> {
    let Some(origin) = request_header(request_head, "origin") else {
        client.write_all(
            b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        )?;
        return Ok(());
    };

    if !is_allowed_cors_origin(origin) {
        client.write_all(
            b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        )?;
        return Ok(());
    }

    write!(
        client,
        "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Headers: {CORS_ALLOW_HEADERS}\r\nAccess-Control-Allow-Methods: {CORS_ALLOW_METHODS}\r\nAccess-Control-Max-Age: 600\r\nVary: Origin\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
}

fn request_method(request_head: &[u8]) -> Option<&str> {
    let request_head = std::str::from_utf8(request_head).ok()?;
    request_head.lines().next()?.split_whitespace().next()
}

fn request_header<'a>(request_head: &'a [u8], header_name: &str) -> Option<&'a str> {
    let request_head = std::str::from_utf8(request_head).ok()?;

    request_head.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case(header_name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

fn is_allowed_cors_origin(origin: &str) -> bool {
    matches_origin_host(origin, "http", "tauri.localhost")
        || matches_origin_host(origin, "https", "tauri.localhost")
        || matches_origin_host(origin, "tauri", "localhost")
        || matches_origin_host(origin, "http", "localhost")
        || matches_origin_host(origin, "https", "localhost")
        || matches_origin_host(origin, "http", "127.0.0.1")
        || matches_origin_host(origin, "https", "127.0.0.1")
        || matches_origin_host(origin, "http", "[::1]")
        || matches_origin_host(origin, "https", "[::1]")
}

fn matches_origin_host(origin: &str, scheme: &str, host: &str) -> bool {
    let Some(host_and_port) = origin.trim().strip_prefix(&format!("{scheme}://")) else {
        return false;
    };

    host_and_port == host
        || host_and_port.strip_prefix(host).is_some_and(|port| {
            let digits = &port[1..];
            port.starts_with(':')
                && !digits.is_empty()
                && digits.chars().all(|char| char.is_ascii_digit())
        })
}

pub fn generate_auth_token() -> String {
    let mut token = [0; 32];
    getrandom::fill(&mut token).expect("OS random token generation should succeed");
    token.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn health_check(port: u16, path: &str) -> std::io::Result<bool> {
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

fn current_exe_dir() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn dev_payload_dir() -> Option<PathBuf> {
    option_env!("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .map(|manifest_dir| manifest_dir.join(PAYLOAD_DIR_NAME))
}

pub fn find_payload_dir(
    exe_dir: Option<&Path>,
    resource_dir: Option<&Path>,
    dev_payload_dir: Option<&Path>,
) -> Option<PathBuf> {
    [
        exe_dir.map(|dir| dir.join(PAYLOAD_DIR_NAME)),
        resource_dir.map(|dir| dir.join(PAYLOAD_DIR_NAME)),
        dev_payload_dir.map(Path::to_path_buf),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.is_dir())
}

fn existing_join(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    let path = join_parts(root, parts);
    path.exists().then_some(path)
}

fn join_parts(root: &Path, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn payload_java_path(payload_dir: &Path) -> Option<PathBuf> {
    [
        payload_dir.join("jre").join("bin").join("java.exe"),
        payload_dir.join("jre").join("bin").join("java"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn payload_path_entries(payload_dir: &Path) -> Vec<PathBuf> {
    [
        payload_dir.join("ocr"),
        payload_dir.join("ocr").join("python"),
        payload_dir.join("ocr").join("tesseract"),
        payload_dir.join("ocr").join("gs").join("bin"),
        payload_dir.join("ocr").join("qpdf").join("bin"),
    ]
    .into_iter()
    .filter(|path| path.is_dir())
    .collect()
}

fn child_path(config: &SidecarConfig) -> Option<OsString> {
    if config.path_entries.is_empty() {
        return None;
    }

    let mut paths = config.path_entries.clone();
    if let Some(inherited_path) = config.inherited_path.as_ref() {
        paths.extend(env::split_paths(inherited_path));
    }

    env::join_paths(paths).ok()
}

fn stirling_settings_yaml(ocrmypdf_path: &Path, tessdata_dir: &Path) -> String {
    format!(
        "\
system:
  customPaths:
    operations:
      ocrmypdf: {}
  tessdataDir: {}
processExecutor:
  sessionLimit:
    ocrMyPdfSessionLimit: 2
  timeoutMinutes:
    ocrMyPdfTimeoutMinutes: 30
endpoints:
  toRemove: []
  groupsToRemove: []
springdoc:
  api-docs:
    enabled: false
",
        yaml_single_quote(ocrmypdf_path),
        yaml_single_quote(tessdata_dir)
    )
}

fn yaml_single_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
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
    fn auth_proxy_requires_exact_token_header() {
        assert!(request_has_valid_auth(
            b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-RaioPDF-Auth: abc123\r\n\r\n",
            "abc123"
        ));
        assert!(!request_has_valid_auth(
            b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "abc123"
        ));
        assert!(!request_has_valid_auth(
            b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-RaioPDF-Auth: wrong\r\n\r\n",
            "abc123"
        ));
    }

    #[test]
    fn auth_proxy_returns_401_without_token() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let response = send_proxy_request(
            proxy_port,
            b"GET /api/v1/info/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.starts_with("HTTP/1.1 401 Unauthorized"));
        assert_eq!(stub.received_request(), None);
    }

    #[test]
    fn auth_proxy_tunnels_authorized_requests() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let response = send_proxy_request(
            proxy_port,
            b"POST /api/v1/analysis/basic-info HTTP/1.1\r\nHost: 127.0.0.1\r\nX-RaioPDF-Auth: secret\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"));
        assert!(stub
            .received_request()
            .expect("stub should receive authorized request")
            .starts_with("POST /api/v1/analysis/basic-info HTTP/1.1"));
    }

    #[test]
    fn auth_proxy_answers_cors_preflight_before_authorized_post() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let preflight = send_proxy_request(
            proxy_port,
            b"OPTIONS /api/v1/analysis/basic-info HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: X-RaioPDF-Auth, Content-Type\r\nConnection: close\r\n\r\n",
        );

        assert!(preflight.starts_with("HTTP/1.1 204 No Content"));
        assert!(preflight.contains("Access-Control-Allow-Origin: http://tauri.localhost"));
        assert!(preflight.contains("Access-Control-Allow-Headers: Content-Type, X-RaioPDF-Auth"));
        assert!(preflight
            .contains("Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS"));
        assert_eq!(stub.received_request(), None);

        let response = send_proxy_request(
            proxy_port,
            b"POST /api/v1/analysis/basic-info HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nX-RaioPDF-Auth: secret\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"));
        assert!(stub
            .received_request()
            .expect("stub should receive authorized request")
            .starts_with("POST /api/v1/analysis/basic-info HTTP/1.1"));
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
            ("RAIOPDF_ENGINE_JAVA", "/opt/raiopdf/jre/bin/java"),
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
        assert_eq!(config.java_path, PathBuf::from("/opt/raiopdf/jre/bin/java"));
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

    #[test]
    fn active_proxy_request_suppresses_idle_shutdown() {
        let idle = test_idle(Some(Duration::from_millis(20)));
        let state = Arc::new(Mutex::new(EngineState::ready(49152)));
        let child = Arc::new(Mutex::new(Some(spawn_sleep_child())));
        let proxy = Arc::new(Mutex::new(None));
        let lifecycle_lock = Arc::new(Mutex::new(()));
        let active_request = ActiveProxyRequest::new(Arc::clone(&idle));

        start_idle_supervisor(
            Arc::clone(&idle),
            state,
            Arc::clone(&child),
            proxy,
            lifecycle_lock,
            false,
        );

        thread::sleep(Duration::from_millis(100));
        assert!(
            child
                .lock()
                .expect("child lock")
                .as_mut()
                .expect("child should still be tracked")
                .try_wait()
                .expect("child status")
                .is_none(),
            "idle supervisor should not kill an in-flight proxied request"
        );

        drop(active_request);
        let deadline = Instant::now() + Duration::from_secs(2);
        while child.lock().expect("child lock").is_some() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }

        stop_idle(&idle);
        assert!(
            child.lock().expect("child lock").is_none(),
            "idle supervisor should kill after the proxied request completes"
        );
    }

    #[test]
    fn payload_resolution_builds_launch_spec_and_settings_without_spawning() {
        let root = test_temp_dir("payload-launch");
        let exe_dir = root.join("bin");
        let payload = exe_dir.join(PAYLOAD_DIR_NAME);
        let app_data = root.join("app-data");
        create_payload_tree(&payload);

        let config = SidecarConfig::from_env_vars_with_roots(
            vec![("PATH", "/usr/bin")],
            app_data.clone(),
            Some(exe_dir),
            None,
            None,
        );

        assert!(!config.disabled());
        assert_eq!(
            config.java_path,
            payload.join("jre").join("bin").join("java.exe")
        );
        assert_eq!(config.engine_log_path, app_data.join(ENGINE_LOG_FILE_NAME));
        assert_eq!(
            config.jar_path,
            Some(payload.join("engine").join("stirling.jar"))
        );
        assert_eq!(
            config.ocrmypdf_path,
            Some(payload.join("ocr").join("ocrmypdf.cmd"))
        );
        assert_eq!(
            config.python_path,
            Some(payload.join("ocr").join("python").join("python.exe"))
        );
        assert_eq!(
            config.tessdata_dir,
            Some(payload.join("ocr").join("tesseract").join("tessdata"))
        );
        assert_eq!(config.ocr_toolchain().missing, Vec::<String>::new());
        assert!(config.ocr_toolchain().available);

        let spec = engine_spawn_spec(&config, 49152).expect("spawn spec should build");
        assert_eq!(
            spec.program,
            payload.join("jre").join("bin").join("java.exe")
        );
        assert_eq!(spec.log_path, app_data.join(ENGINE_LOG_FILE_NAME));
        assert_eq!(
            spec.args,
            vec![
                OsString::from("-jar"),
                payload
                    .join("engine")
                    .join("stirling.jar")
                    .as_os_str()
                    .to_os_string(),
                OsString::from("--server.address=127.0.0.1"),
                OsString::from("--server.port=49152"),
            ]
        );
        assert_eq!(spec.current_dir, Some(payload.join("engine")));
        assert!(spec.envs.iter().any(|(key, value)| {
            key.to_string_lossy() == "STIRLING_BASE_PATH" && value == app_data.as_os_str()
        }));
        assert!(spec.envs.iter().any(|key_value| {
            key_value.0.to_string_lossy() == "PATH"
                && key_value
                    .1
                    .to_string_lossy()
                    .starts_with(&payload.join("ocr").to_string_lossy().to_string())
        }));
        assert!(spec.envs.iter().any(|key_value| {
            key_value.0.to_string_lossy() == "PATH"
                && env::split_paths(&key_value.1)
                    .any(|path| path == payload.join("ocr").join("gs").join("bin"))
        }));
        assert!(spec.envs.iter().any(|key_value| {
            key_value.0.to_string_lossy() == "PATH"
                && env::split_paths(&key_value.1)
                    .any(|path| path == payload.join("ocr").join("qpdf").join("bin"))
        }));

        assert!(!app_data.join("configs").join("settings.yml").exists());
        let settings = fs::read_to_string(app_data.join("configs").join("custom_settings.yml"))
            .expect("settings should be written");
        assert!(settings.contains("ocrmypdf: '"));
        assert!(settings.contains("ocrmypdf.cmd"));
        assert!(settings.contains("tessdataDir: '"));
        assert!(settings.contains("ocrMyPdfSessionLimit: 2"));
        assert!(settings.contains("enabled: false"));
        assert!(spec.envs.iter().any(|(key, value)| {
            key.to_string_lossy() == "TESSDATA_PREFIX"
                && value
                    == payload
                        .join("ocr")
                        .join("tesseract")
                        .join("tessdata")
                        .as_os_str()
        }));
    }

    #[test]
    fn environment_overrides_payload_defaults() {
        let root = test_temp_dir("payload-overrides");
        let payload = root.join("dev-payload");
        create_payload_tree(&payload);

        let config = SidecarConfig::from_env_vars_with_roots(
            vec![
                ("RAIOPDF_ENGINE_PAYLOAD_DIR", payload.to_str().unwrap()),
                ("RAIOPDF_ENGINE_JAR", "/override/stirling.jar"),
                ("RAIOPDF_ENGINE_JAVA", "/override/java"),
                ("RAIOPDF_ENGINE_BASE_PATH", "/override/base"),
                ("RAIOPDF_ENGINE_OCRMYPDF", "/override/ocrmypdf.cmd"),
                ("RAIOPDF_ENGINE_TESSDATA_DIR", "/override/tessdata"),
            ],
            root.join("app-data"),
            None,
            None,
            None,
        );

        assert_eq!(
            config.jar_path,
            Some(PathBuf::from("/override/stirling.jar"))
        );
        assert_eq!(config.java_path, PathBuf::from("/override/java"));
        assert_eq!(
            config.stirling_base_path,
            Some(PathBuf::from("/override/base"))
        );
        assert_eq!(
            config.ocrmypdf_path,
            Some(PathBuf::from("/override/ocrmypdf.cmd"))
        );
        assert_eq!(
            config.tessdata_dir,
            Some(PathBuf::from("/override/tessdata"))
        );
    }

    #[test]
    fn payload_resolution_reports_missing_ocr_toolchain_parts() {
        let root = test_temp_dir("payload-missing-ocr");
        let exe_dir = root.join("bin");
        let payload = exe_dir.join(PAYLOAD_DIR_NAME);
        touch(&payload.join("jre").join("bin").join("java.exe"));
        touch(&payload.join("engine").join("stirling.jar"));
        fs::create_dir_all(payload.join("ocr").join("tesseract").join("tessdata"))
            .expect("tessdata directory should be created");

        let config = SidecarConfig::from_env_vars_with_roots(
            Vec::<(OsString, OsString)>::new(),
            root.join("app-data"),
            Some(exe_dir),
            None,
            None,
        );

        assert!(!config.disabled());
        assert_eq!(
            config.ocr_toolchain(),
            OcrToolchainStatus {
                available: false,
                missing: vec![
                    "ocr/ocrmypdf.cmd".to_string(),
                    "ocr/python/python.exe".to_string(),
                    "ocr/tesseract/tesseract.exe".to_string(),
                    "ocr/tesseract/tessdata/eng.traineddata".to_string(),
                    "ocr/gs/bin/gs.exe".to_string(),
                ],
            }
        );
    }

    #[test]
    fn opening_engine_log_rotates_existing_logs() {
        let root = test_temp_dir("engine-log-rotation");
        let log = root.join("app-data").join(ENGINE_LOG_FILE_NAME);
        touch(&log);
        fs::write(&log, b"current").expect("current log should be writable");
        fs::write(rotated_log_path(&log, 1), b"previous").expect("previous log should be writable");

        let _file = open_rotated_engine_log(&log).expect("log should open");

        assert_eq!(
            fs::read_to_string(rotated_log_path(&log, 1)).expect("rotated current log"),
            "current"
        );
        assert_eq!(
            fs::read_to_string(rotated_log_path(&log, 2)).expect("rotated previous log"),
            "previous"
        );
        assert_eq!(
            fs::read_to_string(&log).expect("fresh log should exist"),
            ""
        );
    }

    #[test]
    fn rotating_log_writer_caps_active_log_during_writes() {
        let root = test_temp_dir("engine-log-size-cap");
        let log = root.join("app-data").join(ENGINE_LOG_FILE_NAME);
        let mut writer = RotatingLogWriter::new(&log, 10, 2).expect("log writer should open");

        writer
            .write_all(b"1234567890abc")
            .expect("first write should rotate");
        writer
            .write_all(b"defghijklmn")
            .expect("second write should rotate");
        writer
            .write_all(b"opqrstuvwxyz")
            .expect("third write should rotate");
        drop(writer);

        assert_eq!(
            fs::read_to_string(&log).expect("active log should exist"),
            "uvwxyz"
        );
        assert_eq!(
            fs::read_to_string(rotated_log_path(&log, 1)).expect("newer rotated log"),
            "klmnopqrst"
        );
        assert_eq!(
            fs::read_to_string(rotated_log_path(&log, 2)).expect("older rotated log"),
            "abcdefghij"
        );
        assert!(
            !rotated_log_path(&log, 3).exists(),
            "only configured generations should be kept"
        );
        assert!(
            fs::metadata(&log).expect("active log metadata").len() <= 10,
            "active log should stay within the size cap"
        );
    }

    fn test_temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let unique = format!("raiopdf-{name}-{}-{}", std::process::id(), nanos);
        let path = env::temp_dir().join(unique);
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    fn test_idle(shutdown_after: Option<Duration>) -> Arc<(Mutex<IdleShutdownState>, Condvar)> {
        Arc::new((
            Mutex::new(IdleShutdownState {
                timer: IdleShutdownTimer::new(Instant::now(), shutdown_after),
                active_requests: 0,
                stopped: false,
            }),
            Condvar::new(),
        ))
    }

    fn stop_idle(idle: &Arc<(Mutex<IdleShutdownState>, Condvar)>) {
        let (idle_lock, wake_idle) = &**idle;
        let mut idle_state = idle_lock.lock().expect("idle lock");
        idle_state.stopped = true;
        wake_idle.notify_one();
    }

    #[cfg(unix)]
    fn spawn_sleep_child() -> Child {
        Command::new("sh")
            .arg("-c")
            .arg("sleep 5")
            .spawn()
            .expect("sleep child should spawn")
    }

    #[cfg(windows)]
    fn spawn_sleep_child() -> Child {
        Command::new("cmd")
            .args(["/C", "ping -n 5 127.0.0.1 >NUL"])
            .spawn()
            .expect("sleep child should spawn")
    }

    fn create_payload_tree(payload: &Path) {
        touch(&payload.join("jre").join("bin").join("java.exe"));
        touch(&payload.join("engine").join("stirling.jar"));
        touch(&payload.join("ocr").join("ocrmypdf.cmd"));
        touch(&payload.join("ocr").join("python").join("python.exe"));
        touch(
            &payload
                .join("ocr")
                .join("tesseract")
                .join("tessdata")
                .join("eng.traineddata"),
        );
        touch(&payload.join("ocr").join("tesseract").join("tesseract.exe"));
        touch(&payload.join("ocr").join("gs").join("bin").join("gs.exe"));
        touch(
            &payload
                .join("ocr")
                .join("qpdf")
                .join("bin")
                .join("qpdf.exe"),
        );
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("test file should have parent"))
            .expect("parent should be created");
        fs::write(path, []).expect("test file should be written");
    }

    struct StubHttpServer {
        port: u16,
        received: Arc<Mutex<Option<String>>>,
    }

    impl StubHttpServer {
        fn received_request(&self) -> Option<String> {
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let request = self
                    .received
                    .lock()
                    .expect("stub request lock poisoned")
                    .clone();
                if request.is_some() || Instant::now() >= deadline {
                    return request;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    fn start_stub_http_server(response: &'static [u8]) -> StubHttpServer {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("stub should bind");
        let port = listener.local_addr().expect("stub addr").port();
        let received = Arc::new(Mutex::new(None));
        let received_for_thread = Arc::clone(&received);

        thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("stub read timeout");
            let (head, body) = read_request_head(&mut stream).expect("stub request head");
            let content_length = content_length(&head);
            let mut request = head;
            let mut remaining = content_length.saturating_sub(body.len());
            request.extend_from_slice(&body);

            while remaining > 0 {
                let mut buffer = vec![0; remaining.min(1024)];
                let bytes_read = stream.read(&mut buffer).expect("stub body read");
                if bytes_read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..bytes_read]);
                remaining -= bytes_read;
            }

            *received_for_thread
                .lock()
                .expect("stub request lock poisoned") =
                Some(String::from_utf8_lossy(&request).into_owned());
            stream.write_all(response).expect("stub response write");
        });

        StubHttpServer { port, received }
    }

    fn send_proxy_request(port: u16, request: &[u8]) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("proxy connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("proxy read timeout");
        stream.write_all(request).expect("proxy request write");
        let _ = stream.shutdown(Shutdown::Write);
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("proxy response read");
        response
    }

    fn content_length(head: &[u8]) -> usize {
        let Ok(head) = std::str::from_utf8(head) else {
            return 0;
        };

        head.lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }
}
