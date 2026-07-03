use serde::Serialize;
use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_HEALTH_PATH: &str = "/api/v1/info/status";
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_IDLE_SHUTDOWN_MINUTES: u64 = 5;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const PAYLOAD_DIR_NAME: &str = "payload";
const ENGINE_LOG_FILE_NAME: &str = "engine.log";
const ENGINE_JAR_RELATIVE: &[&str] = &["engine", "stirling.jar"];
const OCRMYPDF_RELATIVE: &[&str] = &["ocr", "ocrmypdf.cmd"];
const TESSDATA_RELATIVE: &[&str] = &["ocr", "tesseract", "tessdata"];
const TESSERACT_RELATIVE: &[&str] = &["ocr", "tesseract", "tesseract.exe"];
const TESSDATA_ENG_RELATIVE: &[&str] = &["ocr", "tesseract", "tessdata", "eng.traineddata"];
const GHOSTSCRIPT_RELATIVE: &[&str] = &["ocr", "gs", "bin", "gswin64c.exe"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SidecarConfig {
    jar_path: Option<PathBuf>,
    java_path: PathBuf,
    engine_log_path: PathBuf,
    stirling_base_path: Option<PathBuf>,
    ocrmypdf_path: Option<PathBuf>,
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

    #[cfg(test)]
    fn from_env_vars<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        Self::from_env_vars_with_roots(vars, PathBuf::from("app-data"), None, None, None)
    }

    fn from_env_vars_with_roots<I, K, V>(
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

        if let Some(payload_dir) = payload_dir.as_deref() {
            jar_path = jar_path.or_else(|| existing_join(payload_dir, ENGINE_JAR_RELATIVE));
            java_path = java_path.or_else(|| payload_java_path(payload_dir));
            ocrmypdf_path = ocrmypdf_path.or_else(|| existing_join(payload_dir, OCRMYPDF_RELATIVE));
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

    fn disabled(&self) -> bool {
        self.jar_path.is_none()
    }

    fn write_settings(&self) -> std::io::Result<()> {
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

    fn ocr_toolchain(&self) -> OcrToolchainStatus {
        let mut missing = Vec::new();

        if self.ocrmypdf_path.is_none() {
            missing.push("ocr/ocrmypdf.cmd".to_string());
        }
        if self.tesseract_path.is_none() {
            missing.push("ocr/tesseract/tesseract.exe".to_string());
        }
        if self.tessdata_eng_path.is_none() {
            missing.push("ocr/tesseract/tessdata/eng.traineddata".to_string());
        }
        if self.ghostscript_path.is_none() {
            missing.push("ocr/gs/bin/gswin64c.exe".to_string());
        }

        OcrToolchainStatus {
            available: missing.is_empty(),
            missing,
        }
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
#[serde(rename_all = "camelCase")]
pub struct EngineStartResponse {
    #[serde(skip_serializing_if = "is_false")]
    disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    ocr_toolchain: OcrToolchainStatus,
}

impl EngineStartResponse {
    fn disabled(ocr_toolchain: OcrToolchainStatus) -> Self {
        Self {
            disabled: true,
            port: None,
            ocr_toolchain,
        }
    }

    fn ready(port: u16, ocr_toolchain: OcrToolchainStatus) -> Self {
        Self {
            disabled: false,
            port: Some(port),
            ocr_toolchain,
        }
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
            return Ok(EngineStartResponse::disabled(self.config.ocr_toolchain()));
        }

        let _guard = self
            .lifecycle_lock
            .lock()
            .expect("sidecar lifecycle lock poisoned");

        if let Some(port) = self.reap_and_get_ready_port()? {
            return Ok(EngineStartResponse::ready(
                port,
                self.config.ocr_toolchain(),
            ));
        }

        for attempt_index in 0..2 {
            match self.start_once() {
                Ok(port) => {
                    return Ok(EngineStartResponse::ready(
                        port,
                        self.config.ocr_toolchain(),
                    ))
                }
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
            ocr_toolchain: self.config.ocr_toolchain(),
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

    fn start_once(&self) -> Result<u16, StartAttemptError> {
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

        match spawn_engine(&self.config, port) {
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

#[derive(Debug, Eq, PartialEq)]
struct EngineSpawnSpec {
    program: PathBuf,
    args: Vec<OsString>,
    current_dir: Option<PathBuf>,
    envs: Vec<(OsString, OsString)>,
    log_path: PathBuf,
}

fn spawn_engine(config: &SidecarConfig, port: u16) -> std::io::Result<Child> {
    let spec = engine_spawn_spec(config, port)?;
    let log_file = open_rotated_engine_log(&spec.log_path)?;
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    if let Some(current_dir) = spec.current_dir {
        command.current_dir(current_dir);
    }
    for (key, value) in spec.envs {
        command.env(key, value);
    }
    command.stdout(Stdio::from(log_file.try_clone()?));
    command.stderr(Stdio::from(log_file));
    apply_platform_spawn_flags(&mut command);
    command.spawn()
}

fn engine_spawn_spec(config: &SidecarConfig, port: u16) -> std::io::Result<EngineSpawnSpec> {
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

fn open_rotated_engine_log(path: &Path) -> std::io::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    rotate_engine_log(path, 3)?;
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
}

fn rotate_engine_log(path: &Path, generations: usize) -> std::io::Result<()> {
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

fn find_payload_dir(
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
                    "ocr/tesseract/tesseract.exe".to_string(),
                    "ocr/tesseract/tessdata/eng.traineddata".to_string(),
                    "ocr/gs/bin/gswin64c.exe".to_string(),
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

    fn create_payload_tree(payload: &Path) {
        touch(&payload.join("jre").join("bin").join("java.exe"));
        touch(&payload.join("engine").join("stirling.jar"));
        touch(&payload.join("ocr").join("ocrmypdf.cmd"));
        touch(
            &payload
                .join("ocr")
                .join("tesseract")
                .join("tessdata")
                .join("eng.traineddata"),
        );
        touch(&payload.join("ocr").join("tesseract").join("tesseract.exe"));
        touch(
            &payload
                .join("ocr")
                .join("gs")
                .join("bin")
                .join("gswin64c.exe"),
        );
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("test file should have parent"))
            .expect("parent should be created");
        fs::write(path, []).expect("test file should be written");
    }
}
