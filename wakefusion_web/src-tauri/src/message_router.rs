use crate::events::*;
use crate::ws_protocol::DownstreamMessage;
use crate::AudioCommand;
use base64::Engine;
use crossbeam_channel::Sender;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Routes downstream WS messages to WebView events and audio playback.
/// Maintains a global active trace_id — stale messages from old conversations are discarded.
pub async fn run_message_router(
    app: AppHandle,
    mut downstream_rx: mpsc::UnboundedReceiver<DownstreamMessage>,
    audio_tx: Sender<AudioCommand>,
) {
    let mut current_sample_rate: u32 = 22050;
    let mut active_trace_id: String = String::new();
    let mut token_count: u32 = 0;

    while let Some(msg) = downstream_rx.recv().await {
        let trace_id = msg.trace_id.clone().unwrap_or_default();

        match msg.msg_type.as_str() {
            // --- Session-establishing messages: update active trace_id ---
            "meta" | "route" => {
                if !trace_id.is_empty() {
                    if active_trace_id != trace_id {
                        tracing::info!("New conversation: {} -> {} (prev tokens={})", active_trace_id, trace_id, token_count);
                        token_count = 0;
                        // Clear audio from previous conversation
                        let _ = audio_tx.send(AudioCommand::Clear);
                    }
                    active_trace_id = trace_id.clone();
                }
                if msg.msg_type == "route" {
                    if let Some(route) = &msg.route {
                        let _ = app.emit("route", RouteEvent {
                            trace_id,
                            route: route.clone(),
                        });
                    }
                }
            }

            // --- Data messages: check trace_id matches active ---
            "token" => {
                if !trace_id.is_empty() && trace_id != active_trace_id {
                    tracing::debug!("Stale token dropped: {} (active={})", trace_id, active_trace_id);
                    continue;
                }
                if let Some(text) = &msg.text {
                    token_count += 1;
                    tracing::info!("token[{}]: '{}' trace={}", token_count, text, trace_id);
                    let _ = app.emit("subtitle_ai_stream", SubtitleAiStreamEvent {
                        trace_id,
                        text: text.clone(),
                    });
                }
            }

            "asr" => {
                // ASR result updates active trace_id (new user input)
                if !trace_id.is_empty() {
                    active_trace_id = trace_id.clone();
                }
                if let Some(text) = &msg.text {
                    let audio_id = msg.extra.get("audioId").and_then(|v| v.as_str()).map(String::from);
                    let _ = app.emit("subtitle_user", serde_json::json!({
                        "traceId": trace_id,
                        "text": text,
                        "stage": msg.stage.clone().unwrap_or_else(|| "final".into()),
                        "audioId": audio_id,
                    }));
                }
            }

            "media_ref" => {
                if !trace_id.is_empty() && trace_id != active_trace_id {
                    continue;
                }
                let _ = app.emit("media_ref", MediaRefEvent {
                    trace_id,
                    asset_id: msg.asset_id.clone(),
                    asset_type: msg.asset_type.clone(),
                    url: msg.url.clone(),
                    label: msg.label.clone(),
                    start_ms: msg.start_ms,
                    end_ms: msg.end_ms,
                });
            }

            "final" => {
                if !trace_id.is_empty() && trace_id != active_trace_id {
                    continue;
                }
                let _ = app.emit("subtitle_ai_commit", SubtitleAiCommitEvent { trace_id });
            }

            // --- Audio messages: only play if trace_id matches ---
            "audio_begin" => {
                tracing::info!("audio_begin: traceId={} active={} sampleRate={}", trace_id, active_trace_id, msg.sample_rate.unwrap_or(0));
                if !trace_id.is_empty() && trace_id != active_trace_id {
                    tracing::warn!("audio_begin DROPPED: {} != active {}", trace_id, active_trace_id);
                    continue;
                }
                // Forward to WebView for browser-based playback
                let _ = app.emit("tts_audio_begin", serde_json::json!({
                    "traceId": trace_id,
                    "mimeType": msg.mime_type.as_deref().unwrap_or("audio/wav"),
                    "sampleRate": msg.sample_rate.unwrap_or(22050),
                }));
            }

            "audio_chunk" => {
                if !trace_id.is_empty() && trace_id != active_trace_id {
                    continue;
                }
                // Forward raw base64 audio to WebView for playback
                if let Some(data_b64) = &msg.data {
                    let _ = app.emit("tts_audio_chunk", serde_json::json!({
                        "traceId": trace_id,
                        "data": data_b64,
                        "seq": msg.seq.unwrap_or(0),
                        "mimeType": msg.mime_type.as_deref().unwrap_or("audio/wav"),
                    }));
                }
            }

            "audio_end" => {
                if !trace_id.is_empty() && trace_id != active_trace_id {
                    continue;
                }
                tracing::info!("audio_end: traceId={}", trace_id);
                let _ = app.emit("tts_audio_end", serde_json::json!({
                    "traceId": trace_id,
                }));
            }

            // --- Control messages: always process ---
            "stop_tts" => {
                tracing::info!("stop_tts");
                let _ = audio_tx.send(AudioCommand::Clear);
            }

            "stop" => {
                tracing::warn!("Received stop: {}", msg.reason.as_deref().unwrap_or(""));
                let _ = app.emit("subtitle_clear", SubtitleClearEvent {});
                let _ = audio_tx.send(AudioCommand::Clear);
                active_trace_id.clear();
            }

            "error" => {
                let error_msg = msg.message.clone().unwrap_or_else(|| "unknown error".into());
                tracing::error!("Backend error: {}", error_msg);
                let _ = app.emit("connection_status", ConnectionStatusEvent {
                    connected: true,
                    message: error_msg,
                });
            }

            "warning" => {
                if let Some(warn_msg) = &msg.message {
                    tracing::warn!("Backend warning: {}", warn_msg);
                }
            }

            "pong" | "timing" => {}

            other => {
                tracing::debug!("Unhandled: {other}");
            }
        }
    }
}
