pub mod path_ops;
pub mod print_ops;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const DEFAULT_HEALTH_PATH: &str = "/api/v1/info/status";
pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Ceiling for the post-start probe that confirms the auth proxy actually serves a
/// request before the engine is reported ready. Reached only if the proxy never
/// answers; the probe normally succeeds within a poll interval or two.
pub const PROXY_READY_TIMEOUT: Duration = Duration::from_secs(10);
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
pub const CORS_ALLOW_HEADERS: &str = "Content-Type, X-RaioPDF-Auth, X-RaioPDF-Password-Hex, X-RaioPDF-PdfA-Level, X-RaioPDF-PdfA-Strict, X-RaioPDF-Redaction-Areas";
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
    alive: Arc<AtomicBool>,
}

impl ProxyHandle {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

struct ProxyLivenessGuard {
    alive: Arc<AtomicBool>,
}

impl ProxyLivenessGuard {
    fn new(alive: Arc<AtomicBool>) -> Self {
        alive.store(true, Ordering::Relaxed);
        Self { alive }
    }
}

impl Drop for ProxyLivenessGuard {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
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
                // `wait_until_ready` proved Stirling serves on the engine port, but the
                // UI talks to the auth proxy, whose accept loop was only just spawned and
                // may not be serving yet. Confirm the proxy answers an authed request
                // before signaling ready, so the first real request (e.g. the OCR that
                // lazily triggered this start) can't race a cold accept loop and fail with
                // an intermittent `Local engine request failed`.
                if !wait_until_proxy_ready(
                    proxy_port,
                    &self.auth_token,
                    &self.config.health_path,
                    PROXY_READY_TIMEOUT,
                ) {
                    stop_proxy(&self.proxy);
                    self.stop_child();
                    let message = "engine proxy did not accept requests after startup".to_string();
                    set_state(&self.state, EngineState::error(Some(proxy_port), &message));
                    return Err(StartAttemptError::Stopped(message));
                }
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
                .is_some_and(|proxy| Some(proxy.port) == state.port && proxy.is_alive());
            if !proxy_running {
                drop(state);
                self.stop_child();
                return Ok(None);
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
    let alive = Arc::new(AtomicBool::new(true));
    let shutdown_for_thread = Arc::clone(&shutdown);
    let alive_for_thread = Arc::clone(&alive);

    thread::spawn(move || {
        run_auth_proxy_inner(
            listener,
            engine_port,
            token,
            shutdown_for_thread,
            alive_for_thread,
            idle,
        );
    });

    Ok(ProxyHandle {
        port,
        shutdown,
        alive,
    })
}

pub fn run_auth_proxy(
    listener: TcpListener,
    engine_port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
) {
    run_auth_proxy_inner(
        listener,
        engine_port,
        token,
        shutdown,
        Arc::new(AtomicBool::new(true)),
        None,
    );
}

fn run_auth_proxy_inner(
    listener: TcpListener,
    engine_port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    idle: Option<Arc<(Mutex<IdleShutdownState>, Condvar)>>,
) {
    let _alive_guard = ProxyLivenessGuard::new(alive);

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
            Err(_) => {
                thread::sleep(Duration::from_millis(25));
            }
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
    // The listener is non-blocking so the accept loop can poll the shutdown
    // flag (see `start_auth_proxy_inner`). On Windows, a socket returned by
    // `accept()` INHERITS the listener's non-blocking flag, and std does not
    // reset it — so without this the accepted stream stays non-blocking, the
    // read timeouts below are ineffective (SO_RCVTIMEO only governs blocking
    // receives), and any `read_exact` whose bytes haven't fully arrived yet
    // returns WSAEWOULDBLOCK (os error 10035) immediately instead of waiting.
    // That surfaces as a spurious "read request body" failure on request
    // bodies split across TCP segments. Reset to blocking so the timeouts
    // apply as intended. No-op on Unix, where accepted sockets are always
    // blocking.
    client.set_nonblocking(false)?;
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    client.set_write_timeout(Some(Duration::from_secs(30)))?;

    let (request_head, buffered_body) = read_request_head(&mut client)?;

    if is_cors_preflight(&request_head) {
        write_cors_preflight_response(&mut client, &request_head)?;
        let _ = client.shutdown(Shutdown::Write);
        return Ok(());
    }

    if !request_has_valid_auth(&request_head, token) {
        client.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        )?;
        let _ = client.shutdown(Shutdown::Write);
        return Ok(());
    }

    client.set_read_timeout(None)?;
    client.set_write_timeout(None)?;
    let _active_request = idle.map(ActiveProxyRequest::new);

    // Local, engine-side handlers that must NOT proxy to Stirling. Decrypt runs
    // the bundled, lossless qpdf: Stirling's /remove-password strips /Encrypt but
    // drops the text layer (measured 1298 -> 0 words), so it must never be used.
    if request_method(&request_head) == Some("POST")
        && request_path(&request_head) == Some("/local/decrypt")
    {
        let result = handle_local_decrypt(&mut client, &request_head, &buffered_body);
        // Shutdown::Write (not Both): send the queued response + FIN and close the
        // write half gracefully. Shutdown::Both disables the receive half too, so
        // any inbound TCP segment that lands afterwards makes Windows answer with
        // an RST — surfacing as an intermittent ECONNRESET on the client.
        let _ = client.shutdown(Shutdown::Write);
        return result;
    }

    // PDF/A runs the bundled Ghostscript locally. Stirling 2.14.0 gates its
    // /api/v1/convert/pdf/pdfa endpoint behind the LibreOffice dependency group
    // (soffice), which RaioPDF does not bundle — so that endpoint is always
    // "disabled" in the payload. Ghostscript (already bundled for OCR) is the same
    // engine Stirling would use under the hood, so we convert here and keep the
    // whole path on-device.
    if request_method(&request_head) == Some("POST")
        && request_path(&request_head) == Some("/local/pdfa")
    {
        let result = handle_local_pdfa(&mut client, &request_head, &buffered_body);
        // Graceful close (see the decrypt branch above): Shutdown::Write, never Both.
        let _ = client.shutdown(Shutdown::Write);
        return result;
    }

    // Compression is a deterministic, local structural qpdf pass. Stirling's
    // compress endpoint depends on optional image tooling that is not part of
    // RaioPDF's payload, so route byte-mode UI calls through the same local
    // path operation used by streamed documents.
    if request_method(&request_head) == Some("POST")
        && request_path(&request_head) == Some("/local/compress")
    {
        let result = handle_local_compress(&mut client, &request_head, &buffered_body);
        let _ = client.shutdown(Shutdown::Write);
        return result;
    }

    // OCR is also handled locally. The Stirling endpoint requires a multipart
    // upload through this proxy; force-OCR on larger in-memory PDFs can back up
    // that upload path and leave Jetty with a truncated multipart body. Running
    // the same bundled OCRmyPDF command here keeps the request single-hop.
    if request_method(&request_head) == Some("POST")
        && request_path(&request_head) == Some("/local/ocr")
    {
        let result = handle_local_ocr(&mut client, &request_head, &buffered_body);
        let _ = client.shutdown(Shutdown::Write);
        return result;
    }

    // Area redaction must destroy underlying page text, not just draw black
    // rectangles. The local path op rasterizes affected pages and verifies the
    // output fail-closed before returning any PDF bytes.
    if request_method(&request_head) == Some("POST")
        && request_path(&request_head) == Some("/local/redact-areas")
    {
        let result = handle_local_redact_areas(&mut client, &request_head, &buffered_body);
        let _ = client.shutdown(Shutdown::Write);
        return result;
    }

    let upstream_addr = SocketAddr::from(([127, 0, 0, 1], engine_port));
    let mut upstream = TcpStream::connect_timeout(&upstream_addr, Duration::from_secs(5))?;
    upstream.set_write_timeout(Some(Duration::from_secs(30)))?;
    upstream.write_all(&request_head)?;
    forward_known_request_body(&mut client, &mut upstream, &request_head, &buffered_body)?;
    let _ = upstream.shutdown(Shutdown::Write);
    upstream.set_read_timeout(None)?;
    upstream.set_write_timeout(None)?;

    let (response_head, response_buffered_body) = read_request_head(&mut upstream)?;
    let response_head = rewrite_proxy_response_cors(&response_head, &request_head);
    client.write_all(&response_head)?;
    if !response_buffered_body.is_empty() {
        client.write_all(&response_buffered_body)?;
    }
    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);

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

/// The request-target (path) from the request line: `METHOD target VERSION`.
fn request_target(request_head: &[u8]) -> Option<&str> {
    let request_head = std::str::from_utf8(request_head).ok()?;
    request_head.lines().next()?.split_whitespace().nth(1)
}

fn request_path(request_head: &[u8]) -> Option<&str> {
    request_target(request_head)
        .map(|target| target.split_once('?').map_or(target, |(path, _)| path))
}

/// Handle `POST /local/decrypt`: PDF bytes in the body, optionally base64
/// encoded when `body_encoding=base64`, and the password hex-encoded in the
/// loopback query string or legacy header. Responds with the decrypted PDF
/// (200) or a plain-text error (422).
fn handle_local_decrypt(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<()> {
    let body = match read_local_pdf_body(client, request_head, buffered_body) {
        Ok(body) => body,
        Err(message) => {
            return write_local_bytes_response(
                client,
                request_head,
                422,
                "Unprocessable Entity",
                "text/plain",
                message.as_bytes(),
            );
        }
    };

    let password = request_query_param(request_head, "password_hex")
        .or_else(|| request_header(request_head, "x-raiopdf-password-hex"))
        .map(decode_hex)
        .unwrap_or_default();

    match run_qpdf_decrypt(&body, &password) {
        Ok(decrypted) => write_local_bytes_response(
            client,
            request_head,
            200,
            "OK",
            "application/pdf",
            &decrypted,
        ),
        Err(message) => write_local_bytes_response(
            client,
            request_head,
            422,
            "Unprocessable Entity",
            "text/plain",
            message.as_bytes(),
        ),
    }
}

/// Handle `POST /local/pdfa`: PDF bytes in the body, optionally base64 encoded
/// when `body_encoding=base64`, and PDF/A options in the loopback query string
/// or legacy headers. Responds with the PDF/A (200) or a plain-text error
/// (422).
fn handle_local_pdfa(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<()> {
    let body = match read_local_pdf_body(client, request_head, buffered_body) {
        Ok(body) => body,
        Err(message) => {
            return write_local_bytes_response(
                client,
                request_head,
                422,
                "Unprocessable Entity",
                "text/plain",
                message.as_bytes(),
            );
        }
    };

    let level = request_query_param(request_head, "pdfa_level")
        .or_else(|| request_header(request_head, "x-raiopdf-pdfa-level"))
        .and_then(|value| value.trim().parse::<u8>().ok())
        .filter(|level| (1..=3).contains(level))
        .unwrap_or(2);
    let strict = request_query_param(request_head, "pdfa_strict")
        .or_else(|| request_header(request_head, "x-raiopdf-pdfa-strict"))
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    match run_gs_pdfa(&body, level, strict) {
        Ok(converted) => write_local_bytes_response(
            client,
            request_head,
            200,
            "OK",
            "application/pdf",
            &converted,
        ),
        Err(message) => write_local_bytes_response(
            client,
            request_head,
            422,
            "Unprocessable Entity",
            "text/plain",
            message.as_bytes(),
        ),
    }
}

/// Handle `POST /local/compress`: PDF bytes in the body, optionally base64
/// encoded when `body_encoding=base64`. Responds with the qpdf-normalized PDF
/// (200) or a plain-text error (422).
fn handle_local_compress(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<()> {
    let body = match read_local_pdf_body(client, request_head, buffered_body) {
        Ok(body) => body,
        Err(message) => {
            return write_local_bytes_response(
                client,
                request_head,
                422,
                "Unprocessable Entity",
                "text/plain",
                message.as_bytes(),
            );
        }
    };

    match run_path_op_compress(&body) {
        Ok(compressed) => write_local_bytes_response(
            client,
            request_head,
            200,
            "OK",
            "application/pdf",
            &compressed,
        ),
        Err(message) => write_local_bytes_response(
            client,
            request_head,
            422,
            "Unprocessable Entity",
            "text/plain",
            message.as_bytes(),
        ),
    }
}

/// Handle `POST /local/ocr`: PDF bytes in the body, optionally base64 encoded
/// when `body_encoding=base64`; `ocr_type=skip-text|force-ocr` controls the
/// text-layer strategy. Responds with the OCRmyPDF output (200) or plain-text
/// error (422).
fn handle_local_ocr(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<()> {
    let body = match read_local_pdf_body(client, request_head, buffered_body) {
        Ok(body) => body,
        Err(message) => {
            return write_local_bytes_response(
                client,
                request_head,
                422,
                "Unprocessable Entity",
                "text/plain",
                message.as_bytes(),
            );
        }
    };

    let options = match local_ocr_options(request_head) {
        Ok(options) => options,
        Err(message) => {
            return write_local_bytes_response(
                client,
                request_head,
                422,
                "Unprocessable Entity",
                "text/plain",
                message.as_bytes(),
            );
        }
    };

    match run_path_op_ocr(&body, &options) {
        Ok(ocr) => {
            write_local_bytes_response(client, request_head, 200, "OK", "application/pdf", &ocr)
        }
        Err(message) => write_local_bytes_response(
            client,
            request_head,
            422,
            "Unprocessable Entity",
            "text/plain",
            message.as_bytes(),
        ),
    }
}

/// Handle `POST /local/redact-areas`: raw PDF bytes in the body and
/// `X-RaioPDF-Redaction-Areas` as camelCase JSON. Responds with a verified
/// redacted PDF (200) or a plain-text error (422).
fn handle_local_redact_areas(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<()> {
    let body = read_request_body(client, request_head, buffered_body)?;
    let (pdf, areas) = match parse_local_redact_request(request_head, &body) {
        Ok(request) => request,
        Err(message) => {
            return write_local_bytes_response(
                client,
                request_head,
                422,
                "Unprocessable Entity",
                "text/plain",
                message.as_bytes(),
            );
        }
    };

    match run_path_op_redact_areas(&pdf, &areas) {
        Ok(redacted) => write_local_bytes_response(
            client,
            request_head,
            200,
            "OK",
            "application/pdf",
            &redacted,
        ),
        Err(message) => write_local_bytes_response(
            client,
            request_head,
            422,
            "Unprocessable Entity",
            "text/plain",
            message.as_bytes(),
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRedactArea {
    page_index: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRedactRequest {
    pdf_base64: String,
    areas: Vec<LocalRedactArea>,
}

impl From<LocalRedactArea> for path_ops::RedactArea {
    fn from(area: LocalRedactArea) -> Self {
        Self {
            page_index: area.page_index,
            x: area.x,
            y: area.y,
            w: area.w,
            h: area.h,
        }
    }
}

fn parse_local_redact_request(
    request_head: &[u8],
    body: &[u8],
) -> Result<(Vec<u8>, Vec<path_ops::RedactArea>), String> {
    if let Some(areas_json) = request_header(request_head, "x-raiopdf-redaction-areas") {
        let areas = serde_json::from_str::<Vec<LocalRedactArea>>(areas_json)
            .map_err(|error| format!("invalid redaction areas: {error}"))?
            .into_iter()
            .map(Into::into)
            .collect::<Vec<_>>();
        return Ok((body.to_vec(), areas));
    }

    let request = serde_json::from_slice::<LocalRedactRequest>(body)
        .map_err(|error| format!("invalid redaction request: {error}"))?;
    let pdf = BASE64_STANDARD
        .decode(request.pdf_base64)
        .map_err(|error| format!("invalid redaction PDF payload: {error}"))?;
    let areas = request
        .areas
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
    Ok((pdf, areas))
}

fn local_ocr_options(request_head: &[u8]) -> Result<path_ops::OcrOptions, String> {
    let page_indexes = local_ocr_page_indexes(request_head)?;
    Ok(path_ops::OcrOptions {
        mode: local_ocr_mode(request_head)?,
        languages: local_ocr_languages(request_head),
        deskew: local_ocr_deskew(request_head)?,
        page_indexes,
    })
}

fn local_ocr_mode(request_head: &[u8]) -> Result<path_ops::OcrMode, String> {
    let mode = request_query_param_decoded(request_head, "ocr_type")
        .or_else(|| request_query_param_decoded(request_head, "ocrType"))
        .unwrap_or_else(|| "skip-text".to_string());

    match mode.as_str() {
        "Normal" | "normal" => Ok(path_ops::OcrMode::SkipText),
        "skip-text" | "skip_text" | "skip" => Ok(path_ops::OcrMode::SkipText),
        "force-ocr" | "force_ocr" | "force" => Ok(path_ops::OcrMode::ForceOcr),
        other => Err(format!("unsupported OCR mode: {other}")),
    }
}

fn local_ocr_languages(request_head: &[u8]) -> Vec<String> {
    let raw = request_query_param_decoded(request_head, "languages")
        .or_else(|| request_query_param_decoded(request_head, "language"))
        .unwrap_or_else(|| "eng".to_string());
    let languages = raw
        .split(',')
        .map(str::trim)
        .filter(|language| !language.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if languages.is_empty() {
        vec!["eng".to_string()]
    } else {
        languages
    }
}

fn local_ocr_deskew(request_head: &[u8]) -> Result<bool, String> {
    let raw = request_query_param_decoded(request_head, "deskew")
        .unwrap_or_else(|| "false".to_string())
        .to_ascii_lowercase();
    match raw.as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        other => Err(format!("unsupported OCR deskew value: {other}")),
    }
}

fn local_ocr_page_indexes(request_head: &[u8]) -> Result<Vec<u32>, String> {
    let Some(raw) = request_query_param_decoded(request_head, "page_indexes")
        .or_else(|| request_query_param_decoded(request_head, "pageIndexes"))
    else {
        return Ok(Vec::new());
    };
    let page_indexes = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| format!("invalid OCR page index: {value}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    path_ops::one_based_range_string(&page_indexes)
        .map_err(|error| format!("invalid OCR page indexes: {}", error.message))?;
    Ok(page_indexes)
}

fn read_request_body(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<Vec<u8>> {
    if request_uses_chunked_transfer(request_head) {
        return read_chunked_request_body(client, buffered_body);
    }

    let content_length = request_content_length(request_head);
    let buffered_to_read = buffered_body.len().min(content_length);

    let mut body = buffered_body[..buffered_to_read].to_vec();
    if content_length > body.len() {
        client.set_read_timeout(Some(Duration::from_secs(60)))?;
        let mut remaining = vec![0u8; content_length - body.len()];
        client.read_exact(&mut remaining)?;
        body.extend_from_slice(&remaining);
    }
    Ok(body)
}

fn forward_known_request_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> io::Result<()> {
    let content_length = request_content_length(request_head);
    if content_length == 0 && request_uses_chunked_transfer(request_head) {
        return forward_chunked_request_body(client, upstream, buffered_body);
    }

    let buffered_to_forward = buffered_body.len().min(content_length);

    if buffered_to_forward > 0 {
        upstream.write_all(&buffered_body[..buffered_to_forward])?;
    }

    let mut remaining = content_length.saturating_sub(buffered_to_forward);
    if remaining == 0 {
        return Ok(());
    }

    client.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut chunk = [0u8; 64 * 1024];
    while remaining > 0 {
        let read_len = chunk.len().min(remaining);
        client.read_exact(&mut chunk[..read_len])?;
        upstream.write_all(&chunk[..read_len])?;
        remaining -= read_len;
    }

    Ok(())
}

fn forward_chunked_request_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    buffered_body: &[u8],
) -> io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut pending = buffered_body.to_vec();

    loop {
        let size_line = read_chunk_line(client, &mut pending)?;
        upstream.write_all(&size_line)?;

        let size = parse_chunk_size(&size_line)?;
        if size == 0 {
            loop {
                let trailer_line = read_chunk_line(client, &mut pending)?;
                let done = trailer_line == b"\r\n";
                upstream.write_all(&trailer_line)?;
                if done {
                    return Ok(());
                }
            }
        }

        forward_chunk_bytes(client, upstream, &mut pending, size + 2)?;
    }
}

fn read_chunk_line(client: &mut TcpStream, pending: &mut Vec<u8>) -> io::Result<Vec<u8>> {
    loop {
        if let Some(end) = pending.windows(2).position(|window| window == b"\r\n") {
            let line = pending.drain(..end + 2).collect::<Vec<_>>();
            return Ok(line);
        }

        let mut byte = [0u8; 1];
        client.read_exact(&mut byte)?;
        pending.push(byte[0]);
    }
}

fn forward_chunk_bytes(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    pending: &mut Vec<u8>,
    mut remaining: usize,
) -> io::Result<()> {
    if !pending.is_empty() {
        let pending_to_forward = pending.len().min(remaining);
        upstream.write_all(&pending[..pending_to_forward])?;
        pending.drain(..pending_to_forward);
        remaining -= pending_to_forward;
    }

    let mut chunk = [0u8; 64 * 1024];
    while remaining > 0 {
        let read_len = chunk.len().min(remaining);
        client.read_exact(&mut chunk[..read_len])?;
        upstream.write_all(&chunk[..read_len])?;
        remaining -= read_len;
    }

    Ok(())
}

fn read_chunked_request_body(client: &mut TcpStream, buffered_body: &[u8]) -> io::Result<Vec<u8>> {
    client.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut pending = buffered_body.to_vec();
    let mut body = Vec::new();

    loop {
        let size_line = read_chunk_line(client, &mut pending)?;
        let size = parse_chunk_size(&size_line)?;
        if size == 0 {
            loop {
                let trailer_line = read_chunk_line(client, &mut pending)?;
                if trailer_line == b"\r\n" {
                    return Ok(body);
                }
            }
        }

        read_chunk_payload(client, &mut pending, size, &mut body)?;
        let mut terminator = [0u8; 2];
        read_exact_from_pending(client, &mut pending, &mut terminator)?;
        if terminator != *b"\r\n" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk terminator",
            ));
        }
    }
}

fn read_chunk_payload(
    client: &mut TcpStream,
    pending: &mut Vec<u8>,
    mut remaining: usize,
    body: &mut Vec<u8>,
) -> io::Result<()> {
    if !pending.is_empty() {
        let pending_to_read = pending.len().min(remaining);
        body.extend_from_slice(&pending[..pending_to_read]);
        pending.drain(..pending_to_read);
        remaining -= pending_to_read;
    }

    let mut chunk = [0u8; 64 * 1024];
    while remaining > 0 {
        let read_len = chunk.len().min(remaining);
        client.read_exact(&mut chunk[..read_len])?;
        body.extend_from_slice(&chunk[..read_len]);
        remaining -= read_len;
    }

    Ok(())
}

fn read_exact_from_pending(
    client: &mut TcpStream,
    pending: &mut Vec<u8>,
    buffer: &mut [u8],
) -> io::Result<()> {
    let mut filled = 0;
    if !pending.is_empty() {
        let pending_to_read = pending.len().min(buffer.len());
        buffer[..pending_to_read].copy_from_slice(&pending[..pending_to_read]);
        pending.drain(..pending_to_read);
        filled = pending_to_read;
    }

    if filled < buffer.len() {
        client.read_exact(&mut buffer[filled..])?;
    }

    Ok(())
}

fn parse_chunk_size(line: &[u8]) -> io::Result<usize> {
    let line = std::str::from_utf8(line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let size = line
        .trim()
        .split_once(';')
        .map_or_else(|| line.trim(), |(size, _)| size.trim());
    usize::from_str_radix(size, 16).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid chunk size: {error}"),
        )
    })
}

fn request_content_length(request_head: &[u8]) -> usize {
    request_header(request_head, "content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

fn request_uses_chunked_transfer(request_head: &[u8]) -> bool {
    request_header(request_head, "transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
}

fn read_local_pdf_body(
    client: &mut TcpStream,
    request_head: &[u8],
    buffered_body: &[u8],
) -> Result<Vec<u8>, String> {
    let body = read_request_body(client, request_head, buffered_body)
        .map_err(|error| format!("read request body: {error}"))?;

    if request_query_param(request_head, "body_encoding") != Some("base64") {
        return Ok(body);
    }

    let encoded = std::str::from_utf8(&body)
        .map_err(|error| format!("invalid base64 request body: {error}"))?;
    BASE64_STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("invalid base64 PDF payload: {error}"))
}

/// Convert to PDF/A with the bundled Ghostscript. The stock `PDFA_def.ps` opens
/// its sRGB output-intent profile by the relative name `(srgb.icc)`, so both it
/// and the profile are copied into the work dir and Ghostscript runs with that
/// dir as its cwd. `-dPDFACompatibilityPolicy=2` (strict) makes Ghostscript
/// refuse to write a non-conformant file; policy `1` converts best-effort.
fn run_gs_pdfa(pdf: &[u8], level: u8, strict: bool) -> Result<Vec<u8>, String> {
    let ghostscript = resolve_ghostscript()
        .ok_or_else(|| "ghostscript binary not found in payload".to_string())?;
    let (icc_source, def_source) = resolve_pdfa_resources(&ghostscript)?;

    let work_dir = unique_temp_dir("raiopdf-pdfa");
    fs::create_dir_all(&work_dir).map_err(|error| format!("temp dir: {error}"))?;
    let _cleanup = TempDirGuard(work_dir.clone());

    let in_path = work_dir.join("in.pdf");
    let out_path = work_dir.join("out.pdf");
    fs::copy(&icc_source, work_dir.join("srgb.icc"))
        .map_err(|error| format!("copy sRGB profile: {error}"))?;
    fs::copy(&def_source, work_dir.join("PDFA_def.ps"))
        .map_err(|error| format!("copy PDF/A definition: {error}"))?;
    fs::write(&in_path, pdf).map_err(|error| format!("write input: {error}"))?;

    let policy = if strict { "2" } else { "1" };
    let mut command = Command::new(&ghostscript);
    command
        .current_dir(&work_dir)
        .arg(format!("-dPDFA={level}"))
        .arg("-dBATCH")
        .arg("-dNOPAUSE")
        // SAFER sandbox over the untrusted input. `PDFA_def.ps` and `in.pdf`
        // are command-line operands (auto-permitted read under SAFER) and
        // `out.pdf` comes from -sOutputFile (auto-permitted write) — their
        // explicit permits are belt-and-braces. `srgb.icc`, however, is opened
        // at run time BY `PDFA_def.ps` under its literal relative name, which
        // SAFER does not auto-permit: without that permit the output intent
        // fails to load and PDF/A processing aborts (verified against the
        // bundled gs 10.07.1). Relative permit names match because the process
        // cwd is the work dir.
        .arg("-dSAFER")
        .arg("--permit-file-read=srgb.icc")
        .arg("--permit-file-read=PDFA_def.ps")
        .arg("--permit-file-read=in.pdf")
        .arg("--permit-file-write=out.pdf")
        .arg("-sColorConversionStrategy=RGB")
        .arg("-sDEVICE=pdfwrite")
        .arg(format!("-dPDFACompatibilityPolicy={policy}"))
        .arg("-sOutputFile=out.pdf")
        .arg("PDFA_def.ps")
        .arg("in.pdf")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_platform_spawn_flags(&mut command);

    let output = command
        .output()
        .map_err(|error| format!("ghostscript spawn failed: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ghostscript PDF/A conversion failed ({}): {}",
            output.status,
            stderr.trim()
        ));
    }
    // Under strict policy Ghostscript exits 0 but withholds the file when the
    // document cannot be made conformant, so a missing output is a real failure.
    let converted = fs::read(&out_path)
        .map_err(|error| format!("ghostscript did not produce a PDF/A output file ({error})"))?;
    if converted.is_empty() {
        return Err("ghostscript produced an empty PDF/A output".to_string());
    }
    Ok(converted)
}

fn run_path_op_compress(pdf: &[u8]) -> Result<Vec<u8>, String> {
    let work_dir = unique_temp_dir("raiopdf-compress");
    fs::create_dir_all(&work_dir).map_err(|error| format!("temp dir: {error}"))?;
    let _cleanup = TempDirGuard(work_dir.clone());

    let in_path = work_dir.join("in.pdf");
    let out_path = work_dir.join("out.pdf");
    fs::write(&in_path, pdf).map_err(|error| format!("write input: {error}"))?;

    let toolchain = path_ops::PathOpsToolchain::discover(None);
    path_ops::compress(&toolchain, &in_path, &out_path).map_err(|error| error.to_string())?;

    let compressed =
        fs::read(&out_path).map_err(|error| format!("read compressed output: {error}"))?;
    if compressed.is_empty() {
        return Err("qpdf produced an empty compressed output".to_string());
    }
    Ok(compressed)
}

fn run_path_op_ocr(pdf: &[u8], options: &path_ops::OcrOptions) -> Result<Vec<u8>, String> {
    let work_dir = unique_temp_dir("raiopdf-ocr");
    fs::create_dir_all(&work_dir).map_err(|error| format!("temp dir: {error}"))?;
    let _cleanup = TempDirGuard(work_dir.clone());

    let in_path = work_dir.join("in.pdf");
    let out_path = work_dir.join("out.pdf");
    fs::write(&in_path, pdf).map_err(|error| format!("write input: {error}"))?;

    let toolchain = path_ops::PathOpsToolchain::discover(None);
    path_ops::ocr_with_options(&toolchain, &in_path, &out_path, options)
        .map_err(|error| error.to_string())?;

    let ocr = fs::read(&out_path).map_err(|error| format!("read OCR output: {error}"))?;
    if ocr.is_empty() {
        return Err("OCR produced an empty output".to_string());
    }
    Ok(ocr)
}

fn run_path_op_redact_areas(pdf: &[u8], areas: &[path_ops::RedactArea]) -> Result<Vec<u8>, String> {
    let work_dir = unique_temp_dir("raiopdf-redact");
    fs::create_dir_all(&work_dir).map_err(|error| format!("temp dir: {error}"))?;
    let _cleanup = TempDirGuard(work_dir.clone());

    let in_path = work_dir.join("in.pdf");
    let out_path = work_dir.join("out.pdf");
    fs::write(&in_path, pdf).map_err(|error| format!("write input: {error}"))?;

    let toolchain = path_ops::PathOpsToolchain::discover(None);
    path_ops::redact_areas(&toolchain, &in_path, areas, &out_path, &work_dir)
        .map_err(|error| error.to_string())?;

    let redacted = fs::read(&out_path).map_err(|error| format!("read redacted output: {error}"))?;
    if redacted.is_empty() {
        return Err("redaction produced an empty output".to_string());
    }
    Ok(redacted)
}

fn resolve_ghostscript() -> Option<PathBuf> {
    if let Some(path) = env::var_os("RAIOPDF_ENGINE_GHOSTSCRIPT") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let payload = env::var_os("RAIOPDF_ENGINE_PAYLOAD_DIR")?;
    let bin_dir = PathBuf::from(payload).join("ocr").join("gs").join("bin");
    ["gs.exe", "gs"]
        .into_iter()
        .map(|name| bin_dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn resolve_pdfa_resources(ghostscript: &Path) -> Result<(PathBuf, PathBuf), String> {
    let gs_root = ghostscript
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "could not resolve ghostscript root directory".to_string())?;
    let share_root = ghostscript_share_root(ghostscript);

    let mut icc_candidates = vec![gs_root.join("iccprofiles").join("srgb.icc")];
    let mut def_candidates = vec![gs_root.join("lib").join("PDFA_def.ps")];
    if let Some(root) = share_root {
        icc_candidates.push(root.join("iccprofiles").join("srgb.icc"));
        def_candidates.push(root.join("lib").join("PDFA_def.ps"));
    }
    icc_candidates.push(PathBuf::from("/usr/share/color/icc/ghostscript/srgb.icc"));

    let icc_source = icc_candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "ghostscript sRGB profile not found".to_string())?;
    let def_source = def_candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "ghostscript PDF/A definition not found".to_string())?;

    Ok((icc_source, def_source))
}

fn ghostscript_share_root(ghostscript: &Path) -> Option<PathBuf> {
    let output = Command::new(ghostscript).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some(PathBuf::from("/usr/share/ghostscript").join(version))
}

/// Losslessly strip encryption with the bundled qpdf. Input goes via a temp file
/// (qpdf can't read stdin); the password via a temp file (never a process arg);
/// output comes back on stdout, so no plaintext output temp file is left behind.
fn run_qpdf_decrypt(pdf: &[u8], password: &[u8]) -> Result<Vec<u8>, String> {
    let qpdf = resolve_qpdf().ok_or_else(|| "qpdf binary not found in payload".to_string())?;

    let work_dir = unique_temp_dir("raiopdf-decrypt");
    fs::create_dir_all(&work_dir).map_err(|error| format!("temp dir: {error}"))?;
    let _cleanup = TempDirGuard(work_dir.clone());

    let in_path = work_dir.join("in.pdf");
    let pw_path = work_dir.join("pw.txt");
    fs::write(&in_path, pdf).map_err(|error| format!("write input: {error}"))?;
    // qpdf --password-file reads the first line; an empty file == empty password.
    fs::write(&pw_path, password).map_err(|error| format!("write password: {error}"))?;

    let mut command = Command::new(&qpdf);
    command
        .arg("--decrypt")
        .arg(format!("--password-file={}", pw_path.display()))
        .arg("--warning-exit-0")
        .arg(&in_path)
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_platform_spawn_flags(&mut command);

    let output = command
        .output()
        .map_err(|error| format!("qpdf spawn failed: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "qpdf --decrypt failed ({}): {}",
            output.status,
            stderr.trim()
        ));
    }
    if output.stdout.is_empty() {
        return Err("qpdf produced no output".to_string());
    }
    Ok(output.stdout)
}

fn resolve_qpdf() -> Option<PathBuf> {
    if let Some(path) = env::var_os("RAIOPDF_ENGINE_QPDF") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let payload = env::var_os("RAIOPDF_ENGINE_PAYLOAD_DIR")?;
    let bin_dir = PathBuf::from(payload).join("ocr").join("qpdf").join("bin");
    ["qpdf.exe", "qpdf"]
        .into_iter()
        .map(|name| bin_dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    env::temp_dir().join(format!("{prefix}-{}-{}", std::process::id(), sequence))
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_local_bytes_response(
    client: &mut TcpStream,
    request_head: &[u8],
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let cors = request_header(request_head, "origin")
        .filter(|origin| is_allowed_cors_origin(origin))
        .map(|origin| {
            format!(
                "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Credentials: true\r\nVary: Origin\r\n"
            )
        })
        .unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n{cors}Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(body)?;
    Ok(())
}

fn decode_hex(value: &str) -> Vec<u8> {
    let bytes = value.trim().as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        match (hex_value(bytes[index]), hex_value(bytes[index + 1])) {
            (Some(high), Some(low)) => out.push((high << 4) | low),
            _ => break,
        }
        index += 2;
    }
    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
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

    if request_head.lines().skip(1).any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };

        name.trim().eq_ignore_ascii_case(AUTH_HEADER_NAME)
            && constant_time_eq(value.trim().as_bytes(), token.as_bytes())
    }) {
        return true;
    }

    request_head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .filter(|target| target.starts_with("/local/"))
        .and_then(|_target| request_query_param_from_head(request_head, "raiopdf_auth"))
        .is_some_and(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
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
        "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Headers: {CORS_ALLOW_HEADERS}\r\nAccess-Control-Allow-Methods: {CORS_ALLOW_METHODS}\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 0\r\nVary: Origin\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
}

fn rewrite_proxy_response_cors(response_head: &[u8], request_head: &[u8]) -> Vec<u8> {
    let Some(origin) =
        request_header(request_head, "origin").filter(|origin| is_allowed_cors_origin(origin))
    else {
        return response_head.to_vec();
    };

    let Ok(response) = std::str::from_utf8(response_head) else {
        return response_head.to_vec();
    };

    let mut lines = response.trim_end_matches("\r\n\r\n").split("\r\n");
    let Some(status_line) = lines.next() else {
        return response_head.to_vec();
    };

    let mut rewritten = String::new();
    rewritten.push_str(status_line);
    rewritten.push_str("\r\n");

    for line in lines {
        let Some((name, _value)) = line.split_once(':') else {
            continue;
        };
        if is_cors_response_header(name.trim()) {
            continue;
        }
        rewritten.push_str(line);
        rewritten.push_str("\r\n");
    }

    rewritten.push_str(&format!(
        "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Credentials: true\r\nAccess-Control-Allow-Headers: {CORS_ALLOW_HEADERS}\r\nAccess-Control-Allow-Methods: {CORS_ALLOW_METHODS}\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 0\r\nVary: Origin\r\n\r\n"
    ));
    rewritten.into_bytes()
}

fn is_cors_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "access-control-allow-origin"
            | "access-control-allow-credentials"
            | "access-control-allow-headers"
            | "access-control-allow-methods"
            | "access-control-allow-private-network"
            | "access-control-max-age"
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

fn request_query_param<'a>(request_head: &'a [u8], key: &str) -> Option<&'a str> {
    let request_head = std::str::from_utf8(request_head).ok()?;
    request_query_param_from_head(request_head, key)
}

fn request_query_param_decoded(request_head: &[u8], key: &str) -> Option<String> {
    request_query_param(request_head, key).map(percent_decode_query_value)
}

fn request_query_param_from_head<'a>(request_head: &'a str, key: &str) -> Option<&'a str> {
    let target = request_head.lines().next()?.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn percent_decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                if let (Some(high), Some(low)) =
                    (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
                {
                    decoded.push((high << 4) | low);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&decoded).into_owned()
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

/// Health-check the authenticated proxy the UI actually connects to, rather than
/// the raw engine port `health_check` probes. Sends one authed request through the
/// proxy and requires a `200`, proving the proxy accept loop is live and forwarding
/// — the readiness `wait_until_ready` (engine-port only) does not establish.
fn proxy_health_check(proxy_port: u16, token: &str, path: &str) -> std::io::Result<bool> {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy_port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{proxy_port}\r\n{AUTH_HEADER_NAME}: {token}\r\nConnection: close\r\n\r\n"
    );
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

/// Poll `proxy_health_check` until the proxy answers an authed request or the
/// deadline passes. The accept loop is normally serving within a poll interval or
/// two; the timeout is a generous safety bound so a genuinely stuck proxy fails the
/// start rather than blocking forever.
fn wait_until_proxy_ready(proxy_port: u16, token: &str, path: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(proxy_health_check(proxy_port, token, path), Ok(true)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
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
    fn wait_until_proxy_ready_polls_until_the_proxy_answers() {
        // The accept loop may not be serving the instant readiness is signaled, so
        // the readiness gate must retry a probe rather than trust the first hit.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("stub should bind");
        let port = listener.local_addr().expect("stub addr").port();
        let server = thread::spawn(move || {
            // First probe: accept, read, close without responding -> "not ready".
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                let mut buffer = [0u8; 256];
                let _ = stream.read(&mut buffer);
            }
            // Second probe: answer 200 -> "ready".
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 256];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });

        assert!(wait_until_proxy_ready(
            port,
            "token",
            "/api/v1/info/status",
            Duration::from_secs(5),
        ));
        server.join().expect("stub server thread");
    }

    #[test]
    fn proxy_health_check_rejects_non_200() {
        let stub = start_stub_http_server(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
        );
        assert!(!proxy_health_check(stub.port, "token", "/api/v1/info/status").unwrap());
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
        assert!(response.ends_with("OK"), "response was {response:?}");
        assert!(stub
            .received_request()
            .expect("stub should receive authorized request")
            .starts_with("POST /api/v1/analysis/basic-info HTTP/1.1"));
    }

    #[test]
    fn auth_proxy_does_not_forward_pipelined_local_request_to_upstream() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let response = send_proxy_request(
            proxy_port,
            b"POST /api/v1/misc/ocr-pdf HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:4180\r\nX-RaioPDF-Auth: secret\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\nbodyOPTIONS /local/compress?body_encoding=base64 HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:4180\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type,x-raiopdf-auth\r\n\r\n",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"), "response was {response:?}");
        let upstream_request = stub
            .received_request()
            .expect("stub should receive authorized request");
        assert!(upstream_request.starts_with("POST /api/v1/misc/ocr-pdf HTTP/1.1"));
        assert!(
            !upstream_request.contains("OPTIONS /local/compress"),
            "proxied request forwarding must stop at Content-Length, not drain the next client request"
        );
    }

    #[test]
    fn auth_proxy_forwards_chunked_body_without_draining_next_request() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let response = send_proxy_request(
            proxy_port,
            b"POST /api/v1/misc/ocr-pdf HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:4180\r\nX-RaioPDF-Auth: secret\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n4\r\nbody\r\n0\r\n\r\nOPTIONS /local/compress?body_encoding=base64 HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:4180\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type,x-raiopdf-auth\r\n\r\n",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"), "response was {response:?}");
        let upstream_request = stub
            .received_request()
            .expect("stub should receive authorized request");
        assert!(upstream_request.starts_with("POST /api/v1/misc/ocr-pdf HTTP/1.1"));
        assert!(upstream_request.contains("4\r\nbody\r\n0\r\n\r\n"));
        assert!(
            !upstream_request.contains("OPTIONS /local/compress"),
            "chunked forwarding must stop at the terminating chunk"
        );
    }

    #[test]
    fn read_request_body_truncates_buffered_non_chunked_local_body() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener should bind");
        let port = listener.local_addr().expect("listener addr").port();
        let writer = thread::spawn(move || {
            let _stream = TcpStream::connect(("127.0.0.1", port)).expect("client connect");
        });

        let (mut stream, _) = listener.accept().expect("server accept");
        let body = read_request_body(
            &mut stream,
            b"POST /local/ocr HTTP/1.1\r\nContent-Length: 4\r\n\r\n",
            b"bodyOPTIONS /local/compress HTTP/1.1\r\n\r\n",
        )
        .expect("non-chunked body should read");

        writer.join().expect("writer should join");
        assert_eq!(body, b"body");
    }

    #[test]
    fn read_request_body_decodes_chunked_local_body() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener should bind");
        let port = listener.local_addr().expect("listener addr").port();
        let writer = thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("client connect");
            stream
                .write_all(b"dy\r\n6\r\n bytes\r\n0\r\nX-Test: ok\r\n\r\n")
                .expect("client write");
        });

        let (mut stream, _) = listener.accept().expect("server accept");
        let body = read_request_body(
            &mut stream,
            b"POST /local/ocr HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
            b"4\r\nbo",
        )
        .expect("chunked body should decode");

        writer.join().expect("writer should join");
        assert_eq!(body, b"body bytes");
    }

    #[test]
    fn auth_proxy_handles_local_ocr_without_upstream_multipart() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let response = send_proxy_request(
            proxy_port,
            b"POST /local/ocr?body_encoding=base64&ocr_type=bogus HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nX-RaioPDF-Auth: secret\r\nContent-Length: 4\r\nConnection: close\r\n\r\nAQ==",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.starts_with("HTTP/1.1 422 Unprocessable Entity"));
        assert!(response.contains("unsupported OCR mode: bogus"));
        assert_eq!(stub.received_request(), None);
    }

    #[test]
    fn local_ocr_options_decode_normal_mode_languages_and_deskew() {
        let options = local_ocr_options(
            b"POST /local/ocr?ocr_type=Normal&languages=eng%2Cspa&deskew=true&page_indexes=0%2C2 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .expect("OCR options should parse");

        assert_eq!(options.mode, path_ops::OcrMode::SkipText);
        assert_eq!(
            options.languages,
            vec!["eng".to_string(), "spa".to_string()]
        );
        assert!(options.deskew);
        assert_eq!(options.page_indexes, vec![0, 2]);
    }

    #[test]
    fn local_ocr_options_reject_duplicate_page_indexes() {
        let error = local_ocr_options(
            b"POST /local/ocr?ocr_type=force-ocr&page_indexes=0%2C0 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .expect_err("duplicate page indexes should be rejected");

        assert_eq!(error, "invalid OCR page indexes: duplicate page indexes");
    }

    #[test]
    fn auth_proxy_rewrites_upstream_cors_headers() {
        let stub = start_stub_http_server(
            b"HTTP/1.1 400 Bad Request\r\nAccess-Control-Allow-Origin: http://localhost:4180\r\nAccess-Control-Allow-Headers: x-raiopdf-auth\r\nContent-Length: 3\r\n\r\nbad",
        );
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let response = send_proxy_request(
            proxy_port,
            b"POST /api/v1/analysis/basic-info HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:4180\r\nX-RaioPDF-Auth: secret\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(response.contains(
            "Access-Control-Allow-Headers: Content-Type, X-RaioPDF-Auth, X-RaioPDF-Password-Hex, X-RaioPDF-PdfA-Level, X-RaioPDF-PdfA-Strict, X-RaioPDF-Redaction-Areas"
        ));
        assert_eq!(response.matches("Access-Control-Allow-Headers:").count(), 1);
        assert!(response.ends_with("bad"));
    }

    #[test]
    fn auth_proxy_survives_aborted_connection_before_authorized_request() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let speculative = TcpStream::connect(("127.0.0.1", proxy_port))
            .expect("speculative proxy connection should connect");
        let _ = speculative.shutdown(Shutdown::Both);
        drop(speculative);
        thread::sleep(Duration::from_millis(50));

        assert!(
            proxy.is_alive(),
            "proxy accept loop should survive an aborted inbound connection"
        );

        let response = send_proxy_request(
            proxy_port,
            b"GET /api/v1/info/status HTTP/1.1\r\nHost: 127.0.0.1\r\nX-RaioPDF-Auth: secret\r\nConnection: close\r\n\r\n",
        );

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"));
        assert!(stub
            .received_request()
            .expect("stub should receive authorized request")
            .starts_with("GET /api/v1/info/status HTTP/1.1"));
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
    fn auth_proxy_forwards_large_authorized_post_after_cors_preflight() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let preflight = send_proxy_request(
            proxy_port,
            b"OPTIONS /api/v1/misc/ocr-pdf HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: X-RaioPDF-Auth, Content-Type\r\nConnection: close\r\n\r\n",
        );

        assert!(preflight.starts_with("HTTP/1.1 204 No Content"));

        let body = vec![b'A'; 1024 * 1024];
        let mut post = format!(
            "POST /api/v1/misc/ocr-pdf HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\nX-RaioPDF-Auth: secret\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        post.extend_from_slice(&body);

        let response = send_proxy_request(proxy_port, &post);

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"), "response was {response:?}");
        let upstream_request = stub
            .received_request()
            .expect("stub should receive authorized request");
        assert!(upstream_request.starts_with("POST /api/v1/misc/ocr-pdf HTTP/1.1"));
        assert_eq!(
            upstream_request.len(),
            post.len(),
            "proxy must forward the complete large upload"
        );
    }

    // Regression (os error 10035): on Windows an accepted socket inherits the
    // listener's non-blocking flag, so `read_exact` on a request body that
    // lands on a later TCP segment returned WSAEWOULDBLOCK instead of blocking.
    // Writing the head, pausing, then the body forces that split — the exact
    // window the bug fired in. Fails before the `client.set_nonblocking(false)`
    // reset in `proxy_client_with_activity`, passes after. Windows-only: Unix
    // accepted sockets are always blocking, so this would no-op elsewhere.
    #[cfg(windows)]
    #[test]
    fn auth_proxy_reads_segmented_body_over_nonblocking_listener() {
        let stub = start_stub_http_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy_port = proxy_listener.local_addr().expect("proxy addr").port();
        let proxy =
            start_auth_proxy(proxy_listener, stub.port, "secret".to_string()).expect("proxy");

        let body = vec![b'A'; 256 * 1024];
        let head = format!(
            "POST /api/v1/analysis/basic-info HTTP/1.1\r\nHost: 127.0.0.1\r\nX-RaioPDF-Auth: secret\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );

        let mut stream = TcpStream::connect(("127.0.0.1", proxy_port)).expect("proxy connect");
        stream.set_nodelay(true).expect("nodelay");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("proxy read timeout");
        stream.write_all(head.as_bytes()).expect("write head");
        stream.flush().expect("flush head");
        // Let the proxy read the head and reach the body read before any body
        // byte arrives — the window where the non-blocking read failed fast.
        thread::sleep(Duration::from_millis(100));
        stream.write_all(&body).expect("write body");
        let _ = stream.shutdown(Shutdown::Write);

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("proxy response read");

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        assert!(response.ends_with("OK"), "response was {response:?}");
        let upstream_request = stub
            .received_request()
            .expect("stub should receive authorized request");
        assert!(upstream_request.starts_with("POST /api/v1/analysis/basic-info HTTP/1.1"));
        assert_eq!(
            upstream_request.len(),
            head.len() + body.len(),
            "proxy must forward the complete segmented upload"
        );
    }

    #[test]
    fn proxy_handle_reports_not_alive_after_accept_loop_exits() {
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy should bind");
        let proxy =
            start_auth_proxy(proxy_listener, 1, "secret".to_string()).expect("proxy should start");
        let stopped_proxy = proxy.clone();

        assert!(proxy.is_alive());

        stop_proxy(&Arc::new(Mutex::new(Some(proxy))));
        wait_for_proxy_not_alive(&stopped_proxy);

        assert!(
            !stopped_proxy.is_alive(),
            "proxy handle should report not-alive after the accept loop exits"
        );
    }

    #[test]
    fn reap_ready_port_recovers_dead_proxy_without_returning_stale_port() {
        let manager = SidecarManager::new(enabled_test_config("dead-proxy-reap"));
        let proxy_port = pick_free_port()
            .expect("proxy port reservation")
            .port()
            .expect("proxy port");

        *manager.state.lock().expect("state lock") = EngineState::ready(proxy_port);
        *manager.child.lock().expect("child lock") = Some(spawn_sleep_child());
        *manager.proxy.lock().expect("proxy lock") = Some(ProxyHandle {
            port: proxy_port,
            shutdown: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(false)),
        });

        let ready_port = manager
            .reap_and_get_ready_port()
            .expect("dead proxy should recover without a hard error");

        assert_eq!(ready_port, None);
        assert!(
            manager.child.lock().expect("child lock").is_none(),
            "dead proxy recovery should stop the engine child"
        );
        assert!(
            manager.proxy.lock().expect("proxy lock").is_none(),
            "dead proxy recovery should clear the stale proxy handle"
        );
        let state = manager.state.lock().expect("state lock").clone();
        assert!(matches!(state.status, EngineStatus::Stopped));
        assert_eq!(state.port, None);

        manager.shutdown();
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

    fn enabled_test_config(name: &str) -> SidecarConfig {
        let root = test_temp_dir(name);
        let jar = root.join("stirling.jar");
        touch(&jar);
        SidecarConfig::from_env_vars_with_roots(
            vec![(
                OsString::from("RAIOPDF_ENGINE_JAR"),
                jar.as_os_str().to_os_string(),
            )],
            root.join("app-data"),
            None,
            None,
            None,
        )
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
            let is_chunked = request_uses_chunked_transfer(&head);
            let mut request = head;
            request.extend_from_slice(&body);

            if is_chunked {
                while !request
                    .windows(b"\r\n0\r\n\r\n".len())
                    .any(|window| window == b"\r\n0\r\n\r\n")
                {
                    let mut buffer = vec![0; 1024];
                    let bytes_read = stream.read(&mut buffer).expect("stub chunked body read");
                    if bytes_read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..bytes_read]);
                }
            } else {
                let mut remaining = content_length.saturating_sub(body.len());
                while remaining > 0 {
                    let mut buffer = vec![0; remaining.min(1024)];
                    let bytes_read = stream.read(&mut buffer).expect("stub body read");
                    if bytes_read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..bytes_read]);
                    remaining -= bytes_read;
                }
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

    fn wait_for_proxy_not_alive(proxy: &ProxyHandle) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while proxy.is_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
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
