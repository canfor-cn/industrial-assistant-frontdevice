mod audio_handler;
mod audio_playback;
mod commands;
mod config;
mod device_ws_server;
mod events;
mod message_router;
mod ws_client;
mod ws_protocol;

use tauri::Emitter;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windows: CREATE_NO_WINDOW flag
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// PID of the spawned device Python process (0 = not running)
static DEVICE_CHILD_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Kill the device child process if running
fn kill_device_process() {
    let pid = DEVICE_CHILD_PID.load(std::sync::atomic::Ordering::SeqCst);
    if pid != 0 {
        tracing::info!("Killing device process (PID {})", pid);
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
        }
        DEVICE_CHILD_PID.store(0, std::sync::atomic::Ordering::SeqCst);
    }
}

use std::sync::Arc;
use tokio::sync::mpsc;

/// Audio commands sent from message_router to the audio thread
pub enum AudioCommand {
    Push(Vec<i16>),
    Clear,
    SetSampleRate(u32),
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Log to file (exe directory) + stderr
    let log_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("wakefusion.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("wakefusion.log"));
    // Truncate log on each startup — avoid unbounded growth
    let maybe_log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path);
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    match maybe_log_file {
        Ok(log_file) => {
            let file_layer = tracing_subscriber::fmt::layer()
                .with_writer(std::sync::Mutex::new(log_file))
                .with_ansi(false);
            let stderr_layer = tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr);
            tracing_subscriber::registry()
                .with(tracing_subscriber::EnvFilter::new("wakefusion_terminal_host_lib=info"))
                .with(file_layer)
                .with(stderr_layer)
                .init();
            tracing::info!("Log file: {}", log_path.display());
        }
        Err(e) => {
            // Fallback: stderr only
            tracing_subscriber::fmt()
                .with_env_filter("wakefusion_terminal_host_lib=info")
                .init();
            tracing::warn!("Cannot open log file {}: {e}, logging to stderr only", log_path.display());
        }
    }

    let (cfg, config_path) = config::load_config();
    let llm_config = cfg.llm_agent.clone();
    let playback_config = cfg.audio_playback.clone();
    let device_config = cfg.device.clone();

    // Downstream: backend WS -> message_router
    let (downstream_tx, downstream_rx) =
        mpsc::unbounded_channel::<ws_protocol::DownstreamMessage>();

    // Upstream: commands -> backend WS thread
    let (upstream_tx, upstream_rx) =
        crossbeam_channel::unbounded::<ws_protocol::UpstreamMessage>();

    // Audio command channel
    let (audio_tx, audio_rx) = crossbeam_channel::unbounded::<AudioCommand>();

    // Audio player thread (lazy init on first SetSampleRate)
    let pc = playback_config.clone();
    std::thread::spawn(move || {
        let mut player: Option<audio_playback::AudioPlayer> = None;
        loop {
            match audio_rx.recv() {
                Ok(AudioCommand::Push(samples)) => {
                    if let Some(p) = &player {
                        p.push(samples);
                    }
                }
                Ok(AudioCommand::Clear) => {}
                Ok(AudioCommand::SetSampleRate(sr)) => {
                    if player.as_ref().map(|p| p.sample_rate) != Some(sr) {
                        tracing::info!("Creating/rebuilding audio player: {}Hz", sr);
                        player = audio_playback::AudioPlayer::new(
                            &pc.output_device_match,
                            sr,
                            pc.channels,
                            false,
                        );
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Backend WS client thread
    ws_client::spawn_ws_thread(llm_config.clone(), downstream_tx.clone(), upstream_rx);

    let upstream_tx_for_commands = upstream_tx.clone();
    let device_id = Arc::new(llm_config.device_id.clone());

    tauri::Builder::default()
        .manage(upstream_tx_for_commands)
        .manage(commands::HostDeviceId(llm_config.device_id.clone()))
        .manage(commands::BackendHost(llm_config.host.clone()))
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Message router (backend WS -> WebView events)
            let router_audio_tx = audio_tx.clone();
            tauri::async_runtime::spawn(async move {
                message_router::run_message_router(app_handle, downstream_rx, router_audio_tx)
                    .await;
            });

            // Device WS server (device module -> unified audio handler -> WebView + backend)
            let device_app = app.handle().clone();
            let device_ws_tx = upstream_tx.clone();
            let device_id_clone = device_id.clone();
            device_ws_server::spawn_device_ws_server(device_app, 8765, device_ws_tx, device_id_clone);

            tracing::info!("WakeFusion Rust host started");
            tracing::info!("  Backend WS: ws://{}/?deviceId={}", llm_config.host, llm_config.device_id);
            tracing::info!("  Device WS Server: ws://0.0.0.0:8765");

            // Optionally spawn device-side Python process
            if device_config.enabled {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let config_file = config_path
                    .clone()
                    .unwrap_or_else(|| exe_dir.join("config.yaml"));
                let python = device_config.python.clone();
                let module = device_config.module.clone();
                let cwd = exe_dir.clone();
                let spawn_app = app.handle().clone();

                // Kill any stale Python device processes before spawning
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", &format!(
                            "for /f \"tokens=2\" %i in ('wmic process where \"commandline like '%{}%' and name='python.exe'\" get processid 2^>nul ^| findstr /r \"[0-9]\"') do taskkill /f /pid %i",
                            module
                        )])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    tracing::info!("Killed stale device processes (if any)");
                }

                // Spawn unified device process (audio + vision + core_server in one)
                let log_file = cwd.join("wakefusion_device.log");
                std::thread::spawn(move || {
                    tracing::info!(
                        python = %python,
                        module = %module,
                        config = %config_file.display(),
                        "Spawning unified device process"
                    );

                    let device_log = std::fs::OpenOptions::new()
                        .create(true).write(true).truncate(true)
                        .open(&log_file).ok();

                    #[cfg(target_os = "windows")]
                    let child_result = std::process::Command::new(&python)
                        .args(["-m", &module, "--config", &config_file.to_string_lossy()])
                        .env("PYTHONIOENCODING", "utf-8")
                        .current_dir(&cwd)
                        .stdout(device_log.as_ref().map_or(
                            std::process::Stdio::null(),
                            |f| std::process::Stdio::from(f.try_clone().unwrap())
                        ))
                        .stderr(std::process::Stdio::null())
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();

                    #[cfg(not(target_os = "windows"))]
                    let child_result = std::process::Command::new(&python)
                        .args(["-m", &module, "--config", &config_file.to_string_lossy()])
                        .env("PYTHONIOENCODING", "utf-8")
                        .current_dir(&cwd)
                        .stdout(device_log.as_ref().map_or(
                            std::process::Stdio::null(),
                            |f| std::process::Stdio::from(f.try_clone().unwrap())
                        ))
                        .stderr(std::process::Stdio::null())
                        .spawn();

                    match child_result {
                        Ok(mut child) => {
                            let pid = child.id();
                            tracing::info!("Device process started (PID {})", pid);
                            let _ = spawn_app.emit("device_status", serde_json::json!({
                                "connected": true,
                                "deviceAddr": format!("local (PID {})", pid),
                                "timestamp": ws_protocol::now_ts(),
                            }));

                            // Store child PID for cleanup on app exit
                            DEVICE_CHILD_PID.store(pid, std::sync::atomic::Ordering::SeqCst);

                            let _ = child.wait();
                            tracing::warn!("Device process exited");
                            DEVICE_CHILD_PID.store(0, std::sync::atomic::Ordering::SeqCst);
                            let _ = spawn_app.emit("device_status", serde_json::json!({
                                "connected": false,
                                "deviceAddr": "",
                                "timestamp": ws_protocol::now_ts(),
                            }));
                        }
                        Err(e) => {
                            tracing::error!("Failed to spawn device process: {e}");
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_text,
            commands::send_audio,
            commands::get_cached_audio,
            commands::host_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_device_process();
            }
        });
}
