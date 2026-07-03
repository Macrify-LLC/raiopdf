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
    let node = mcp_dir.join("node").join(executable("node"));
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

    let status = command
        .status()
        .map_err(|error| format!("failed to launch bundled Node runtime: {error}"))?;

    Ok(status.code().unwrap_or(1))
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
