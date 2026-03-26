use crate::audio_handler;
use crate::events::*;
use crate::ws_protocol::UpstreamMessage;
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

                    loop {
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
                            Err(e) => {
                                tracing::debug!("Device WS read error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
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
                // Text only — just display
                if !text.is_empty() {
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
                            trace_id,
                            text,
                            stage: msg.stage.unwrap_or_else(|| "final".into()),
                        },
                    );
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

        other => {
            tracing::debug!("Device WS: unhandled message type: {}", other);
        }
    }
}
