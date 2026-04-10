use crate::events::{
    ConnectionStatusEvent, MediaRefEvent, RouteEvent, SentenceBoundaryEvent,
    SentencePackEvent as SentencePackEventStruct,
    SubtitleAiCommitEvent, SubtitleAiStreamEvent, SubtitleClearEvent,
    UserVoiceTextEvent,
};
use crate::ws_protocol::DownstreamMessage;
use crate::AudioCommand;
use base64::Engine;
use crossbeam_channel::Sender;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Routes downstream WS messages to WebView events and audio playback.
/// Maintains a global active session_id — stale messages from old sessions are discarded.
/// The sessionId is set by the backend's fast LLM decision (CONTINUE/NEW/INTERRUPT).
pub async fn run_message_router(
    app: AppHandle,
    mut downstream_rx: mpsc::UnboundedReceiver<DownstreamMessage>,
    audio_tx: Sender<AudioCommand>,
) {
    let mut current_sample_rate: u32 = 22050;
    let mut active_session_id: String = String::new();
    let mut token_count: u32 = 0;

    while let Some(msg) = downstream_rx.recv().await {
        let trace_id = msg.trace_id.clone().unwrap_or_default();
        let session_id = msg.session_id.clone().unwrap_or_default();
        let session_action = msg.session_action.clone().unwrap_or_default();

        match msg.msg_type.as_str() {
            // --- Session-establishing messages: update active session_id ---
            "meta" | "route" => {
                if msg.msg_type == "meta" && !session_id.is_empty() {
                    if active_session_id != session_id {
                        tracing::info!(
                            "Session change: {} -> {} (action={}, prev tokens={})",
                            active_session_id, session_id, session_action, token_count
                        );
                        token_count = 0;
                    }
                    // All session actions (continue/new/interrupt) clear current audio
                    // because the new response should play immediately
                    let _ = audio_tx.send(AudioCommand::Clear);
                    active_session_id = session_id.clone();

                    // Emit session info to WebView
                    let _ = app.emit("session_update", serde_json::json!({
                        "sessionId": session_id,
                        "sessionAction": session_action,
                        "traceId": trace_id,
                    }));
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

            // --- Data messages: check session_id matches active ---
            "token" => {
                // Use session_id if available, fall back to checking trace_id
                let msg_session = if !session_id.is_empty() { &session_id } else { &trace_id };
                if !msg_session.is_empty() && *msg_session != active_session_id && !active_session_id.is_empty() {
                    // For tokens, also allow matching by trace_id if session_id not set
                    if session_id.is_empty() {
                        // Legacy: no session_id in token, let it through
                    } else {
                        tracing::debug!("Stale token dropped: session={} (active={})", session_id, active_session_id);
                        continue;
                    }
                }
                if let Some(text) = &msg.text {
                    token_count += 1;
                    let _ = app.emit("subtitle_ai_stream", SubtitleAiStreamEvent {
                        trace_id,
                        text: text.clone(),
                    });
                }
            }

            "sentence_boundary" => {
                if let Some(text) = &msg.text {
                    let sentence_index = msg.extra.get("sentenceIndex")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    let _ = app.emit("sentence_boundary", SentenceBoundaryEvent {
                        trace_id,
                        sentence_index,
                        text: text.clone(),
                    });
                }
            }

            "asr" => {
                if let Some(text) = &msg.text {
                    let audio_id = msg.extra.get("audioId").and_then(|v| v.as_str()).map(String::from);
                    let _ = app.emit("subtitle_user", serde_json::json!({
                        "traceId": trace_id,
                        "text": text,
                        "stage": msg.stage.clone().unwrap_or_else(|| "final".into()),
                        "audioId": audio_id,
                    }));
                    // Emit user_voice_text for the new LiveSubtitlePanel
                    let _ = app.emit("user_voice_text", UserVoiceTextEvent {
                        audio_id: audio_id.clone(),
                        trace_id: trace_id.clone(),
                        text: text.clone(),
                    });
                }
            }

            "media_ref" => {
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
                let _ = app.emit("subtitle_ai_commit", SubtitleAiCommitEvent { trace_id });
            }

            // --- Sentence pack: text + audio bundled ---
            "sentence_pack" => {
                let audio = msg.extra.get("audio").and_then(|v| v.as_str()).map(String::from)
                    .or_else(|| msg.data.clone());
                if let (Some(text), Some(audio)) = (&msg.text, &audio) {
                    let sentence_index = msg.extra.get("sentenceIndex")
                        .and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let _ = app.emit("sentence_pack", SentencePackEventStruct {
                        trace_id: trace_id.clone(),
                        sentence_index,
                        text: text.clone(),
                        audio: audio.clone(),
                        mime_type: msg.mime_type.clone().unwrap_or_else(|| "audio/wav".into()),
                        sample_rate: msg.sample_rate.unwrap_or(22050),
                    });
                    // Notify device: TTS is playing
                    crate::device_ws_server::send_to_device(
                        &serde_json::json!({"type": "tts_playing", "traceId": trace_id}).to_string()
                    );
                }
            }

            "sentence_pack_done" => {
                let _ = app.emit("sentence_pack_done", serde_json::json!({
                    "traceId": trace_id,
                }));
                // Notify device: TTS finished, start idle countdown
                crate::device_ws_server::send_to_device(
                    &serde_json::json!({"type": "tts_idle", "traceId": trace_id}).to_string()
                );
            }

            // --- Audio messages: only play if session matches ---
            "audio_begin" => {
                tracing::info!("audio_begin: traceId={} active_session={}", trace_id, active_session_id);
                let _ = app.emit("tts_audio_begin", serde_json::json!({
                    "traceId": trace_id,
                    "mimeType": msg.mime_type.as_deref().unwrap_or("audio/wav"),
                    "sampleRate": msg.sample_rate.unwrap_or(22050),
                }));
            }

            "audio_chunk" => {
                if let Some(data_b64) = &msg.data {
                    let sentence_index = msg.extra.get("sentenceIndex")
                        .and_then(|v| v.as_u64());
                    let mut payload = serde_json::json!({
                        "traceId": trace_id,
                        "data": data_b64,
                        "seq": msg.seq.unwrap_or(0),
                        "mimeType": msg.mime_type.as_deref().unwrap_or("audio/wav"),
                    });
                    if let Some(si) = sentence_index {
                        payload["sentenceIndex"] = serde_json::json!(si);
                    }
                    let _ = app.emit("tts_audio_chunk", payload);
                }
            }

            "audio_end" => {
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

            "media_control" => {
                let action = msg.extra.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let message = msg.message.clone().unwrap_or_default();
                let _ = app.emit("media_control", serde_json::json!({
                    "traceId": trace_id,
                    "action": action,
                    "message": message,
                }));
            }

            "stop" => {
                tracing::warn!("Received stop: {}", msg.reason.as_deref().unwrap_or(""));
                let _ = app.emit("subtitle_clear", SubtitleClearEvent {});
                let _ = audio_tx.send(AudioCommand::Clear);
                active_session_id.clear();
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
