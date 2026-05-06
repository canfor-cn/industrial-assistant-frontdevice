mod audio_handler;
mod audio_playback;
mod commands;
mod config;
mod device_ws_server;
mod events;
mod message_router;
mod unity_ws_server;
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
    // ── Bypass WebView2 autoplay policy ──────────────────────────────
    // 展厅场景：用户站在数字人前面对话，永远不会去点 Unity canvas，
    // 默认 user-gesture-required 的 autoplay policy 会让 AudioContext
    // 永远 suspended → Unity 收到 audio_chunk 也播不出声。
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 必须在 WebView 创建之前设置。
    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--autoplay-policy=no-user-gesture-required --disable-features=AutoplayIgnoreWebAudio",
        );
    }

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
    if pc.enabled {
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
    } else {
        tracing::info!("Audio playback disabled (audio_playback.enabled=false), Unity WebGL handles audio");
        std::thread::spawn(move || {
            while audio_rx.recv().is_ok() {}
        });
    }

    let upstream_tx_for_commands = upstream_tx.clone();
    let device_id = Arc::new(llm_config.device_id.clone());

    tauri::Builder::default()
        .manage(upstream_tx_for_commands)
        .manage(commands::HostDeviceId(llm_config.device_id.clone()))
        .manage(commands::BackendHost(llm_config.host.clone()))
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Backend WS client thread (emits backend_ws_status events to WebView)
            ws_client::spawn_ws_thread(
                app_handle.clone(),
                llm_config.clone(),
                downstream_tx.clone(),
                upstream_rx,
            );

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

            // Unity (3D digital human) downstream broadcast WS — Unity / Three.js / live2d
            // 自己连 ws://127.0.0.1:9876 接 audio_begin/chunk/end/stop_tts 协议（解耦渲染层）
            let unity_app = app.handle().clone();
            unity_ws_server::spawn_unity_ws_server(unity_app, 9876);

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
                    // ── Auto-install Python dependencies ──────────────────────
                    let req_file = cwd.join("requirements-device.txt");
                    let pip_log = cwd.join("pip-install.log");

                    // 把日志/事件 closures 提到外层，让 critical_deps 兜底块也能复用
                    let emit_setup = |phase: &str, message: &str, done: bool, error: bool| {
                        let _ = spawn_app.emit("setup_progress", serde_json::json!({
                            "phase": phase,
                            "message": message,
                            "done": done,
                            "error": error,
                            "timestamp": ws_protocol::now_ts(),
                        }));
                    };

                    let write_pip_log = |phase: &str, success: bool, stdout: &[u8], stderr: &[u8]| {
                        let content = format!(
                            "=== {} [{}] ===\ntime: {}\n\n--- stdout ---\n{}\n--- stderr ---\n{}\n",
                            phase,
                            if success { "OK" } else { "FAILED" },
                            humanize_now(),
                            String::from_utf8_lossy(stdout),
                            String::from_utf8_lossy(stderr),
                        );
                        use std::io::Write;
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true).append(true).open(&pip_log)
                        {
                            let _ = f.write_all(content.as_bytes());
                        }
                    };

                    if req_file.exists() {
                        let whl_dir = cwd.join("whl-cache");
                        let req_path = req_file.to_string_lossy().to_string();
                        let mut installed = false;

                        emit_setup("deps_install", "正在检查并安装设备依赖...", false, false);

                        // Try 1: offline install from whl-cache (fast, no network)
                        if whl_dir.exists() {
                            emit_setup("deps_install", "正在从本地缓存安装依赖...", false, false);
                            tracing::info!("Installing Python deps (offline from whl-cache)");
                            if let Ok(out) = std::process::Command::new(&python)
                                .args(["-m", "pip", "install",
                                       "-r", &req_path,
                                       "--no-index", "--find-links",
                                       &whl_dir.to_string_lossy()])
                                .current_dir(&cwd)
                                .creation_flags(CREATE_NO_WINDOW)
                                .output()
                            {
                                let ok = out.status.success();
                                write_pip_log("offline install", ok, &out.stdout, &out.stderr);
                                if ok {
                                    tracing::info!("Python deps installed (offline)");
                                    emit_setup("deps_install", "依赖安装完成", true, false);
                                    installed = true;
                                } else {
                                    tracing::warn!("Offline install failed, will try online");
                                    emit_setup("deps_install", "本地安装失败，正在尝试在线安装...", false, false);
                                }
                            }
                        }

                        // Try 2: online install (if offline failed or whl-cache missing)
                        if !installed {
                            emit_setup("deps_install", "正在在线安装设备依赖（首次启动需要网络）...", false, false);
                            tracing::info!("Installing Python deps (online via pip)");
                            match std::process::Command::new(&python)
                                .args(["-m", "pip", "install", "-r", &req_path])
                                .current_dir(&cwd)
                                .creation_flags(CREATE_NO_WINDOW)
                                .output()
                            {
                                Ok(out) => {
                                    let ok = out.status.success();
                                    write_pip_log("online install", ok, &out.stdout, &out.stderr);
                                    if ok {
                                        tracing::info!("Python deps installed (online)");
                                        emit_setup("deps_install", "依赖安装完成", true, false);
                                    } else {
                                        let stderr = String::from_utf8_lossy(&out.stderr);
                                        let msg = format!("依赖安装失败：{}", stderr.chars().take(200).collect::<String>());
                                        tracing::error!("pip install failed: {}", &msg);
                                        emit_setup("deps_install", &msg, true, true);
                                    }
                                }
                                Err(e) => {
                                    let msg = format!("无法运行 pip，请检查 Python 是否已安装：{}", e);
                                    tracing::error!("{}", &msg);
                                    write_pip_log("online install", false, b"", e.to_string().as_bytes());
                                    emit_setup("deps_install", &msg, true, true);
                                }
                            }
                        }
                    }

                    // ── Post-install: download openwakeword models if missing ──
                    if req_file.exists() {
                        let oww_check = std::process::Command::new(&python)
                            .args(["-c", "from openwakeword.utils import download_models; download_models()"])
                            .current_dir(&cwd)
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                        match oww_check {
                            Ok(out) if out.status.success() => tracing::info!("OpenWakeWord models ready"),
                            Ok(out) => tracing::warn!("OpenWakeWord model download issue: {}", String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()),
                            Err(_) => {} // openwakeword not installed, skip
                        }

                        // ── Post-install: verify critical deps & force-install missing ones ──
                        // 防御未来 commit 新增依赖、但远程设备拿到的 requirements-device.txt 是旧版的场景。
                        // 用 (import_path, pip_name) 列出"必装"包，import 失败就单独 pip install。
                        // 注意：必须在 if req_file.exists() 块内访问 emit_setup / write_pip_log 这两个局部 closure。
                        let critical_deps: &[(&str, &str)] = &[
                            ("usb.core", "pyusb"),
                            ("libusb_package", "libusb-package"),
                        ];
                        for (import_path, pip_name) in critical_deps {
                            let probe = std::process::Command::new(&python)
                                .args(["-c", &format!("import {}", import_path)])
                                .current_dir(&cwd)
                                .creation_flags(CREATE_NO_WINDOW)
                                .output();
                            let missing = match probe {
                                Ok(o) => !o.status.success(),
                                Err(_) => true,
                            };
                            if missing {
                                tracing::warn!("critical dep '{}' missing, force-installing '{}'", import_path, pip_name);
                                emit_setup("deps_install", &format!("正在补装关键依赖：{}…", pip_name), false, false);
                                let install = std::process::Command::new(&python)
                                    .args(["-m", "pip", "install", pip_name])
                                    .current_dir(&cwd)
                                    .creation_flags(CREATE_NO_WINDOW)
                                    .output();
                                match install {
                                    Ok(out) => {
                                        let ok = out.status.success();
                                        write_pip_log(&format!("post-install {}", pip_name), ok, &out.stdout, &out.stderr);
                                        if ok {
                                            tracing::info!("force-installed {}", pip_name);
                                        } else {
                                            let stderr = String::from_utf8_lossy(&out.stderr);
                                            tracing::error!("failed to force-install {}: {}", pip_name, stderr.chars().take(200).collect::<String>());
                                        }
                                    }
                                    Err(e) => {
                                        tracing::error!("pip not runnable for force-install: {}", e);
                                    }
                                }
                            } else {
                                tracing::info!("critical dep '{}' present", import_path);
                            }
                        }
                    }

                    tracing::info!(
                        python = %python,
                        module = %module,
                        config = %config_file.display(),
                        "Spawning unified device process"
                    );

                    let device_log = std::fs::OpenOptions::new()
                        .create(true).write(true).truncate(true)
                        .open(&log_file).ok();

                    // 同一个日志文件收集 stdout + stderr（Python logger.info 默认写 stderr）
                    #[cfg(target_os = "windows")]
                    let child_result = std::process::Command::new(&python)
                        .args(["-m", &module, "--config", &config_file.to_string_lossy()])
                        .env("PYTHONIOENCODING", "utf-8")
                        .env("PYTHONUNBUFFERED", "1")
                        .current_dir(&cwd)
                        .stdout(device_log.as_ref().map_or(
                            std::process::Stdio::null(),
                            |f| std::process::Stdio::from(f.try_clone().unwrap())
                        ))
                        .stderr(device_log.as_ref().map_or(
                            std::process::Stdio::null(),
                            |f| std::process::Stdio::from(f.try_clone().unwrap())
                        ))
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();

                    #[cfg(not(target_os = "windows"))]
                    let child_result = std::process::Command::new(&python)
                        .args(["-m", &module, "--config", &config_file.to_string_lossy()])
                        .env("PYTHONIOENCODING", "utf-8")
                        .env("PYTHONUNBUFFERED", "1")
                        .current_dir(&cwd)
                        .stdout(device_log.as_ref().map_or(
                            std::process::Stdio::null(),
                            |f| std::process::Stdio::from(f.try_clone().unwrap())
                        ))
                        .stderr(device_log.as_ref().map_or(
                            std::process::Stdio::null(),
                            |f| std::process::Stdio::from(f.try_clone().unwrap())
                        ))
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
            commands::get_backend_ws_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_device_process();
            }
        });
}

fn humanize_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    format!("{:02}:{:02}:{:02} UTC (epoch {})", h, m, s, secs)
}
