use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostConfig {
    #[serde(rename = "relayUrl")]
    relay_url: String,
    #[serde(rename = "stackCommands")]
    stack_commands: Option<StackCommands>,
    services: Vec<ServiceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServiceConfig {
    id: String,
    label: String,
    #[serde(rename = "healthUrl")]
    health_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StackCommands {
    start: Option<String>,
    stop: Option<String>,
    restart: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct HostStatus {
    mode: String,
    #[serde(rename = "relayUrl")]
    relay_url: String,
    services: Vec<ServiceStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct ServiceStatus {
    id: String,
    label: String,
    state: String,
    healthy: bool,
    detail: Option<String>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn host_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("host-config.json"));
    if let Some(path) = bundled {
        if path.exists() {
            return Ok(path);
        }
    }
    let dev_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("host-config.json");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Err("host-config.json not found".into())
}

fn load_config(app: &tauri::AppHandle) -> Result<HostConfig, String> {
    let path = host_config_path(app)?;
    let text = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read host config {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("failed to parse host config: {err}"))
}

fn run_host_script(relative_script: &str, cwd: &Path) -> Result<(), String> {
    let script_path = cwd.join(relative_script);
    if !script_path.exists() {
        return Err(format!("host script not found: {}", script_path.display()));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell");
        command
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script_path.as_os_str());
        command
    };

    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut command = Command::new("bash");
        command.arg(script_path.as_os_str());
        command
    };

    command
        .current_dir(cwd)
        .status()
        .map_err(|err| format!("failed to run host script {}: {err}", script_path.display()))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("host script {} exited with status {status}", script_path.display()))
            }
        })
}

fn check_health(url: &str) -> bool {
    Command::new("bash")
        .arg("-lc")
        .arg(format!("curl -fsS --max-time 2 '{}' >/dev/null", url))
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn current_status(app: &tauri::AppHandle) -> Result<HostStatus, String> {
    let config = load_config(app)?;
    let services = config
        .services
        .iter()
        .map(|service| {
            let healthy = service
                .health_url
                .as_ref()
                .map(|url| check_health(url))
                .unwrap_or(false);
            ServiceStatus {
                id: service.id.clone(),
                label: service.label.clone(),
                state: if healthy { "running".into() } else { "stopped".into() },
                healthy,
                detail: service.health_url.clone(),
            }
        })
        .collect::<Vec<_>>();

    Ok(HostStatus {
        mode: "tauri".into(),
        relay_url: config.relay_url,
        services,
    })
}

#[tauri::command]
fn host_status(app: tauri::AppHandle) -> Result<HostStatus, String> {
    current_status(&app)
}

#[tauri::command]
fn start_stack(app: tauri::AppHandle) -> Result<HostStatus, String> {
    let config = load_config(&app)?;
    let cwd = repo_root();
    if let Some(commands) = config.stack_commands.as_ref() {
        if let Some(start) = commands.start.as_ref() {
            run_host_script(start, &cwd)?;
        }
    }
    current_status(&app)
}

#[tauri::command]
fn stop_stack(app: tauri::AppHandle) -> Result<HostStatus, String> {
    let config = load_config(&app)?;
    let cwd = repo_root();
    if let Some(commands) = config.stack_commands.as_ref() {
        if let Some(stop) = commands.stop.as_ref() {
            let _ = run_host_script(stop, &cwd);
        }
    }
    current_status(&app)
}

#[tauri::command]
fn restart_stack(app: tauri::AppHandle) -> Result<HostStatus, String> {
    let config = load_config(&app)?;
    let cwd = repo_root();
    if let Some(commands) = config.stack_commands.as_ref() {
        if let Some(restart) = commands.restart.as_ref() {
            run_host_script(restart, &cwd)?;
            return current_status(&app);
        }
    }
    let _ = stop_stack(app.clone())?;
    start_stack(app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![host_status, start_stack, stop_stack, restart_stack])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
