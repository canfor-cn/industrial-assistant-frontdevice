use crate::audio_handler;
use crate::events::*;
use crate::ws_protocol::{self, UpstreamMessage};
use base64::Engine;
use crossbeam_channel::Sender;
use std::net::TcpListener;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tungstenite::{accept, Message};

/// Device WS message received from the device module
#[derive(Debug, serde::Deserialize)]
struct DeviceMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "traceId")]
    trace_id: Option<String>,
    text: Option<String>,
    stage: Option<String>,
    #[serde(rename = "audioData")]
    audio_data: Option<String>,
    #[serde(rename = "audioMime")]
    audio_mime: Option<String>,
    #[serde(flatten)]
    extra: std::collections::HashMap<String, serde_json::Value>,
}

/// Tauri event for voice message with playable audio
#[derive(Debug, Clone, serde::Serialize)]
pub struct VoiceMessageEvent {
    #[serde(rename = "traceId")]
    pub trace_id: String,
    pub text: String,
    pub role: String,
    #[serde(rename = "audioId", skip_serializing_if = "Option::is_none")]
    pub audio_id: Option<String>,
    #[serde(rename = "audioData", skip_serializing_if = "Option::is_none")]
    pub audio_data: Option<String>,
    #[serde(rename = "audioMime", skip_serializing_if = "Option::is_none")]
    pub audio_mime: Option<String>,
}

/// Global channel for sending messages TO the device (Rust → Device)
static DEVICE_DOWN_TX: std::sync::LazyLock<std::sync::Mutex<Option<crossbeam_channel::Sender<String>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Global device connection state (for late-mount UI sync via host_status)
static DEVICE_CONNECTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static DEVICE_ADDR: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(String::new()));

/// Send a JSON message to the connected device
pub fn send_to_device(json: &str) {
    if let Some(tx) = DEVICE_DOWN_TX.lock().unwrap().as_ref() {
        let _ = tx.send(json.to_string());
    }
}

/// Snapshot of current device connection (used by host_status command)
pub fn device_snapshot() -> (bool, String) {
    let connected = DEVICE_CONNECTED.load(std::sync::atomic::Ordering::Relaxed);
    let addr = DEVICE_ADDR.lock().unwrap().clone();
    (connected, addr)
}

/// Spawn the device WS server on a dedicated thread.
pub fn spawn_device_ws_server(
    app: AppHandle,
    port: u16,
    ws_tx: Sender<UpstreamMessage>,
    device_id: Arc<String>,
) {
    std::thread::Builder::new()
        .name("device-ws-server".into())
        .spawn(move || {
            let addr = format!("0.0.0.0:{}", port);
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!("Device WS server bind failed on {}: {}", addr, e);
                    return;
                }
            };
            tracing::info!("Device WS server listening on ws://{}", addr);

            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("Device WS accept error: {}", e);
                        continue;
                    }
                };

                let app_clone = app.clone();
                let ws_tx_clone = ws_tx.clone();
                let device_id_clone = device_id.clone();
                std::thread::spawn(move || {
                    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                    tracing::info!("Device connected: {}", peer);

                    let mut ws = match accept(stream) {
                        Ok(ws) => ws,
                        Err(e) => {
                            tracing::warn!("Device WS handshake failed: {}", e);
                            return;
                        }
                    };

                    // Update global state + notify WebView: device connected
                    DEVICE_CONNECTED.store(true, std::sync::atomic::Ordering::Relaxed);
                    *DEVICE_ADDR.lock().unwrap() = peer.clone();
                    let _ = app_clone.emit("device_status", serde_json::json!({
                        "connected": true,
                        "deviceAddr": &peer,
                        "timestamp": crate::ws_protocol::now_ts(),
                    }));

                    // Set up downstream channel for Rust → Device messages
                    let (down_tx, down_rx) = crossbeam_channel::unbounded::<String>();
                    *DEVICE_DOWN_TX.lock().unwrap() = Some(down_tx);

                    // Non-blocking for interleaved read/write
                    let _ = ws.get_mut().set_nonblocking(true);

                    loop {
                        // Send downstream messages to device
                        while let Ok(json) = down_rx.try_recv() {
                            let _ = ws.get_mut().set_nonblocking(false);
                            if let Err(e) = ws.send(Message::Text(json.into())) {
                                tracing::warn!("Device WS downstream send failed: {e}");
                                break;
                            }
                            let _ = ws.get_mut().set_nonblocking(true);
                        }

                        // Read upstream messages from device
                        match ws.read() {
                            Ok(Message::Text(text)) => {
                                if let Ok(msg) = serde_json::from_str::<DeviceMessage>(&text) {
                                    handle_device_message(
                                        &app_clone,
                                        &ws_tx_clone,
                                        &device_id_clone,
                                        msg,
                                    );
                                }
                            }
                            Ok(Message::Close(_)) => {
                                tracing::info!("Device disconnected: {}", peer);
                                break;
                            }
                            Err(tungstenite::Error::Io(ref e))
                                if e.kind() == std::io::ErrorKind::WouldBlock =>
                            {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(e) => {
                                tracing::debug!("Device WS read error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }

                    // Clear downstream channel on disconnect
                    *DEVICE_DOWN_TX.lock().unwrap() = None;

                    // Update global state + notify WebView: device disconnected
                    DEVICE_CONNECTED.store(false, std::sync::atomic::Ordering::Relaxed);
                    DEVICE_ADDR.lock().unwrap().clear();
                    let _ = app_clone.emit("device_status", serde_json::json!({
                        "connected": false,
                        "deviceAddr": &peer,
                        "timestamp": crate::ws_protocol::now_ts(),
                    }));
                });
            }
        })
        .expect("failed to spawn device-ws-server thread");
}

fn handle_device_message(
    app: &AppHandle,
    ws_tx: &Sender<UpstreamMessage>,
    device_id: &str,
    msg: DeviceMessage,
) {
    let trace_id = msg
        .trace_id
        .unwrap_or_else(|| format!("device-{}", uuid::Uuid::new_v4()));

    tracing::info!(msg_type = %msg.msg_type, trace_id = %trace_id, "Device message received");

    match msg.msg_type.as_str() {
        // User speech with audio — unified handling (display + forward to ASR)
        "subtitle_user" | "asr" => {
            let text = msg.text.unwrap_or_default();
            if msg.audio_data.is_some() {
                // Has audio — go through unified handler
                audio_handler::handle_incoming_audio(
                    app,
                    ws_tx,
                    device_id,
                    trace_id,
                    text,
                    msg.audio_data.unwrap_or_default(),
                    msg.audio_mime.unwrap_or_else(|| "audio/wav".into()),
                    "device",
                );
            } else {
                // Text only — display + forward to backend
                if !text.is_empty() {
                    let stage = msg.stage.unwrap_or_else(|| "final".into());
                    let _ = app.emit(
                        "voice_message",
                        VoiceMessageEvent {
                            trace_id: trace_id.clone(),
                            text: text.clone(),
                            role: "user".into(),
                            audio_id: None,
                            audio_data: None,
                            audio_mime: None,
                        },
                    );
                    let _ = app.emit(
                        "subtitle_user",
                        SubtitleUserEvent {
                            trace_id: trace_id.clone(),
                            text: text.clone(),
                            stage: stage.clone(),
                        },
                    );
                    // Forward text to backend voice gateway as ASR message
                    let _ = ws_tx.send(UpstreamMessage::Asr {
                        stage,
                        text,
                        trace_id: trace_id,
                        device_id: device_id.to_string(),
                        timestamp: crate::ws_protocol::now_ts(),
                        context: None,
                    });
                }
            }
        }

        "subtitle_ai_stream" | "token" => {
            if let Some(text) = msg.text {
                let _ = app.emit(
                    "subtitle_ai_stream",
                    SubtitleAiStreamEvent { trace_id, text },
                );
            }
        }

        "subtitle_ai_commit" | "final" => {
            let _ = app.emit("subtitle_ai_commit", SubtitleAiCommitEvent { trace_id });
        }

        "subtitle_clear" => {
            let _ = app.emit("subtitle_clear", SubtitleClearEvent {});
        }

        "media_ref" => {
            let _ = app.emit(
                "media_ref",
                MediaRefEvent {
                    trace_id,
                    asset_id: msg.extra.get("assetId").and_then(|v| v.as_str()).map(String::from),
                    asset_type: msg.extra.get("assetType").and_then(|v| v.as_str()).map(String::from),
                    url: msg.extra.get("url").and_then(|v| v.as_str()).map(String::from),
                    label: msg.extra.get("label").and_then(|v| v.as_str()).map(String::from),
                    start_ms: msg.extra.get("startMs").and_then(|v| v.as_f64()),
                    end_ms: msg.extra.get("endMs").and_then(|v| v.as_f64()),
                },
            );
        }

        "media_duck" => {
            let _ = app.emit("media_duck", msg.extra);
        }

        // ─── 摄像头管理（前端配置面板用） ───
        "camera_list" | "camera_selected" => {
            let _ = app.emit(&msg.msg_type, msg.extra);
        }
        // 预览帧不再接收 Python JPEG。USB UVC 主预览由 Rust camera_capture_runtime
        // 写入 MJPEG server；这里最多转发 legacy metadata，避免旧链路重新成为 preview owner。
        "camera_preview" => {
            let mut extra = msg.extra.clone();
            extra.remove("jpeg");
            let _ = app.emit("camera_preview", extra);
        }

        // Audio segment protocol — device sends audio in chunks, collect and forward
        "audio_segment_begin" => {
            tracing::info!(trace_id = %trace_id, "Device audio_segment_begin");
            // Store segment metadata in thread-local or ignore (begin is informational)
            // The actual audio comes in audio_segment_chunk
        }

        "audio_segment_chunk" => {
            let data = msg.extra.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let seq = msg.extra.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
            tracing::info!(trace_id = %trace_id, seq = seq, data_len = data.len(), "Device audio_segment_chunk");
            // Buffer chunks — for simplicity, send each chunk through audio_handler immediately
            // (audio_handler will forward to backend)
            if !data.is_empty() {
                // Accumulate in a simple approach: treat each chunk as a complete segment
                // This works because audio_handler sends begin+chunk+end atomically
                PENDING_AUDIO.lock().unwrap()
                    .entry(trace_id.clone())
                    .or_insert_with(Vec::new)
                    .push(data.to_string());
            }
        }

        "audio_segment_end" => {
            let reason = msg.extra.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
            tracing::info!(trace_id = %trace_id, reason = reason, "Device audio_segment_end");

            // Collect all buffered chunks, merge, and send through audio_handler
            let chunks = PENDING_AUDIO.lock().unwrap().remove(&trace_id);
            if let Some(chunks) = chunks {
                if !chunks.is_empty() {
                    // Merge base64 chunks — decode, concat, re-encode
                    let mut merged = Vec::new();
                    for chunk_b64 in &chunks {
                        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(chunk_b64) {
                            merged.extend_from_slice(&decoded);
                        }
                    }
                    let merged_b64 = base64::engine::general_purpose::STANDARD.encode(&merged);
                    let mime = msg.extra.get("mimeType").and_then(|v| v.as_str()).unwrap_or("audio/wav");
                    tracing::info!(trace_id = %trace_id, chunks = chunks.len(), total_bytes = merged.len(), "Device audio merged, forwarding to backend");
                    audio_handler::handle_incoming_audio(
                        app,
                        ws_tx,
                        device_id,
                        trace_id,
                        String::new(),
                        merged_b64,
                        mime.to_string(),
                        "device",
                    );
                }
            }
        }

        "device_state" => {
            // Forward device state to WebView for status panel
            let _ = app.emit("device_state", &msg.extra);
        }

        // Qwen-Omni-Realtime 流式协议：直接透传到后端（不累积、不聚合）
        "audio_stream_start" => {
            let mime = msg.extra.get("mimeType").and_then(|v| v.as_str()).unwrap_or("audio/pcm").to_string();
            let codec = msg.extra.get("codec").and_then(|v| v.as_str()).unwrap_or("pcm_s16le").to_string();
            let sample_rate = msg.extra.get("sampleRate").and_then(|v| v.as_u64()).unwrap_or(16000) as u32;
            let channels = msg.extra.get("channels").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let language = msg.extra.get("language").and_then(|v| v.as_str()).map(String::from);
            tracing::info!(trace_id = %trace_id, "Device audio_stream_start → backend");
            let _ = ws_tx.send(UpstreamMessage::AudioStreamStart {
                trace_id,
                device_id: device_id.to_string(),
                mime_type: mime,
                codec,
                sample_rate,
                channels,
                language,
                timestamp: ws_protocol::now_ts(),
            });
        }

        "audio_stream_chunk" => {
            let data = msg.extra.get("data").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let seq = msg.extra.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if data.is_empty() { return; }
            let _ = ws_tx.send(UpstreamMessage::AudioStreamChunk {
                trace_id,
                device_id: device_id.to_string(),
                seq,
                data,
                timestamp: ws_protocol::now_ts(),
            });
        }

        "audio_stream_stop" => {
            let reason = msg.extra.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            tracing::info!(trace_id = %trace_id, reason = %reason, "Device audio_stream_stop → backend");
            let _ = ws_tx.send(UpstreamMessage::AudioStreamStop {
                trace_id,
                device_id: device_id.to_string(),
                reason,
                timestamp: ws_protocol::now_ts(),
            });
        }

        "greeting" => {
            tracing::info!("Device greeting → backend");
            let _ = ws_tx.send(UpstreamMessage::Greeting {
                device_id: device_id.to_string(),
                timestamp: ws_protocol::now_ts(),
            });
        }

        "timeout_exit" => {
            let reason = msg.extra.get("reason").and_then(|v| v.as_str()).unwrap_or("exit").to_string();
            let _ = ws_tx.send(UpstreamMessage::TimeoutExit {
                device_id: device_id.to_string(),
                reason,
                timestamp: ws_protocol::now_ts(),
            });
        }

        "user_speech_end" => {
            tracing::info!(trace_id = %trace_id, "Device user_speech_end → backend");
            let _ = ws_tx.send(UpstreamMessage::UserSpeechEnd {
                trace_id,
                device_id: device_id.to_string(),
                timestamp: ws_protocol::now_ts(),
            });
        }

        "barge_in" => {
            tracing::info!(trace_id = %trace_id, "Device barge_in → backend (cancel response)");
            let _ = ws_tx.send(UpstreamMessage::BargeIn {
                trace_id,
                device_id: device_id.to_string(),
                timestamp: ws_protocol::now_ts(),
            });
        }

        "media_duck_request" => {
            let reason = msg.extra.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();
            tracing::info!(trace_id = %trace_id, reason = %reason, "Device media_duck_request → backend (auto duck)");
            let _ = ws_tx.send(UpstreamMessage::MediaDuckRequest {
                trace_id,
                device_id: device_id.to_string(),
                reason,
                timestamp: ws_protocol::now_ts(),
            });
        }

        "ping" => {
            // Ignore device keepalive pings
        }

        other => {
            tracing::info!("Device WS: unhandled message type: {}", other);
        }
    }
}

// Buffer for accumulating audio_segment_chunks per traceId
static PENDING_AUDIO: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
