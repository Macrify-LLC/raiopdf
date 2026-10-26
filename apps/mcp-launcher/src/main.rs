#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const ENGINE_HOST_BIN_ENV: &str = "RAIOPDF_ENGINE_HOST_BIN";
const ENGINE_RESOURCE_DIR_ENV: &str = "RAIOPDF_ENGINE_RESOURCE_DIR";
const PDFJS_ASSET_DIR_ENV: &str = "RAIOPDF_PDFJS_ASSET_DIR";
const RESOURCE_DIR_ENV: &str = "RAIOPDF_RESOURCE_DIR";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<i32, String> {
    let exe_dir = env::current_exe()
        .map_err(|error| format!("failed to locate raiopdf-mcp executable: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to locate raiopdf-mcp executable directory".to_string())?;
    let resource_dir = resolve_resource_dir(&exe_dir)?;
    let payload_dir = resource_dir.join("payload");
    let mcp_dir = payload_dir.join("mcp");
    let node_modules_dir = mcp_dir.join("node_modules");
    let node = resolve_node(&mcp_dir)
        .ok_or_else(|| format!("missing bundled Node runtime below {}", mcp_dir.display()))?;
    let entrypoint = mcp_dir.join("app").join("index.mjs");
    let pdfjs_asset_dir = mcp_dir.join("pdfjs");

    require_file(&node, "bundled Node runtime")?;
    require_file(&entrypoint, "bundled MCP entrypoint")?;
    require_dir(&pdfjs_asset_dir, "bundled pdf.js assets")?;

    let mut command = Command::new(&node);
    command
        .arg(&entrypoint)
        .args(env::args_os().skip(1))
        .current_dir(mcp_dir.join("app"))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    set_default_env(&mut command, ENGINE_RESOURCE_DIR_ENV, &resource_dir);
    set_default_env(&mut command, PDFJS_ASSET_DIR_ENV, &pdfjs_asset_dir);
    set_node_path(&mut command, &node_modules_dir);
    if env::var_os(ENGINE_HOST_BIN_ENV).is_none() {
        if let Some(engine_host) = resolve_engine_host(&exe_dir) {
            command.env(ENGINE_HOST_BIN_ENV, engine_host);
        }
    }
    apply_platform_spawn_flags(&mut command);

    run_node(command)
}

/// On Unix the launcher becomes Node (exec), so an AI client that kills the
/// launcher kills the connector itself -- there is no middle process to orphan.
#[cfg(unix)]
fn run_node(mut command: Command) -> Result<i32, String> {
    use std::os::unix::process::CommandExt;

    let error = command.exec();
    Err(format!("failed to launch bundled Node runtime: {error}"))
}

/// Windows has no exec, and killing a parent leaves its children running. Put
/// Node in a kill-on-close job held only by this launcher: if the launcher dies
/// for any reason, Windows closes the job and takes Node, the engine host and
/// its JVM down with it instead of leaving them running until reboot.
#[cfg(windows)]
fn run_node(mut command: Command) -> Result<i32, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to launch bundled Node runtime: {error}"))?;
    // Best effort: the connector also exits when its stdin closes, so a failed
    // job only loses the hard-kill guarantee, never the connector itself.
    let _job = kill_on_close_job(&child)
        .map_err(|error| eprintln!("raiopdf-mcp: {error}; continuing without child-process job"))
        .ok();
    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for bundled Node runtime: {error}"))?;

    Ok(status.code().unwrap_or(1))
}

/// Same job setup as `new_kill_on_close_job` in engine-sidecar-core (kept local so
/// this launcher stays dependency-free) -- change both together.
#[cfg(windows)]
fn kill_on_close_job(
    child: &std::process::Child,
) -> Result<std::os::windows::io::OwnedHandle, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err("could not create child-process job".to_string());
    }
    // SAFETY: a fresh, valid handle we exclusively own; OwnedHandle closes it.
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err("could not configure child-process job".to_string());
    }
    if unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0 {
        return Err("could not assign Node to child-process job".to_string());
    }
    Ok(job)
}

fn resolve_resource_dir(exe_dir: &Path) -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os(RESOURCE_DIR_ENV).map(PathBuf::from) {
        if explicit.join("payload").is_dir() {
            return Ok(explicit);
        }
        return Err(format!(
            "{RESOURCE_DIR_ENV} does not contain a payload directory: {}",
            explicit.display()
        ));
    }

    for candidate in resource_candidates(exe_dir) {
        if candidate.join("payload").is_dir() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "failed to locate RaioPDF resources near {}",
        exe_dir.display()
    ))
}

fn resource_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    vec![
        exe_dir.to_path_buf(),
        exe_dir.join("resources"),
        exe_dir.join("resource"),
        exe_dir.join("Resources"),
        exe_dir.join("_up_"),
        exe_dir.join("_up_").join("resources"),
        exe_dir
            .parent()
            .map(|parent| parent.join("Resources"))
            .unwrap_or_else(|| exe_dir.join("..").join("Resources")),
    ]
}

fn resolve_node(mcp_dir: &Path) -> Option<PathBuf> {
    let node_root = mcp_dir.join("node");
    let candidates = if cfg!(windows) {
        vec![node_root.join("node.exe")]
    } else {
        vec![node_root.join("bin").join("node"), node_root.join("node")]
    };
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn resolve_engine_host(exe_dir: &Path) -> Option<PathBuf> {
    let name = executable("raiopdf-engine-host");
    [
        exe_dir.join(&name),
        exe_dir.join("resources").join(&name),
        exe_dir.join("binaries").join(&name),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn set_default_env(command: &mut Command, key: &str, value: &Path) {
    if env::var_os(key).is_none() {
        command.env(key, value);
    }
}

fn set_node_path(command: &mut Command, node_modules_dir: &Path) {
    let mut paths: Vec<PathBuf> = vec![node_modules_dir.to_path_buf()];
    if let Some(existing) = env::var_os("NODE_PATH") {
        paths.extend(env::split_paths(&existing));
    }
    if let Ok(value) = env::join_paths(paths) {
        command.env("NODE_PATH", value);
    }
}

#[cfg(windows)]
fn apply_platform_spawn_flags(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_platform_spawn_flags(_command: &mut Command) {}

fn require_file(path: &Path, label: &str) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    Err(format!("missing {label}: {}", path.display()))
}

fn require_dir(path: &Path, label: &str) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    Err(format!("missing {label}: {}", path.display()))
}

fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}
