mod audio_handler;
mod audio_playback;
mod commands;
mod config;
mod device_ws_server;
mod events;
mod message_router;
mod ws_client;
mod ws_protocol;

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
    tracing_subscriber::fmt()
        .with_env_filter("wakefusion_terminal_host_lib=info")
        .init();

    let cfg = config::load_config();
    let llm_config = cfg.llm_agent.clone();
    let playback_config = cfg.audio_playback.clone();

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_text,
            commands::send_audio,
            commands::get_cached_audio,
            commands::host_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
