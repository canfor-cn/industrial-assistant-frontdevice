use crate::device_ws_server::VoiceMessageEvent;
use crate::events::UserVoiceStartEvent;
use crate::ws_protocol::{self, UpstreamMessage};
use crossbeam_channel::Sender;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Global audio cache: audioId → (base64 data, mime type)
static AUDIO_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (String, String)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Current audioId — only the latest is valid
static CURRENT_AUDIO_ID: std::sync::LazyLock<Mutex<String>> =
    std::sync::LazyLock::new(|| Mutex::new(String::new()));

fn generate_audio_id() -> String {
    format!("audio-{}", uuid::Uuid::new_v4())
}

/// Retrieve cached audio by audioId. Returns None if not found or not current.
pub fn get_cached_audio(audio_id: &str) -> Option<(String, String)> {
    let cache = AUDIO_CACHE.lock().unwrap();
    cache.get(audio_id).cloned()
}

/// Get the current audioId.
pub fn get_current_audio_id() -> String {
    CURRENT_AUDIO_ID.lock().unwrap().clone()
}

/// Unified audio handler: any incoming audio (WebUI recording or device push)
/// goes through this single function.
///
/// It does three things:
/// 1. Generate audioId and cache the audio data
/// 2. Emit `voice_message` event to WebView (with audioId, without audio data)
/// 3. Forward audio to backend WS via audio_segment_begin/chunk/end (for ASR, with audioId)
pub fn handle_incoming_audio(
    app: &AppHandle,
    ws_tx: &Sender<UpstreamMessage>,
    device_id: &str,
    trace_id: String,
    text: String,
    audio_data: String, // base64
    audio_mime: String,
    source: &str, // "webui" or "device"
) {
    let audio_id = generate_audio_id();

    tracing::info!(
        trace_id = %trace_id,
        audio_id = %audio_id,
        source = source,
        audio_bytes = audio_data.len(),
        "handle_incoming_audio"
    );

    // 1. Cache audio and update current audioId
    {
        let mut cache = AUDIO_CACHE.lock().unwrap();
        // Clear old entries to avoid unbounded growth (keep only the latest)
        cache.clear();
        cache.insert(audio_id.clone(), (audio_data.clone(), audio_mime.clone()));
    }
    {
        let mut current = CURRENT_AUDIO_ID.lock().unwrap();
        *current = audio_id.clone();
    }

    // 2a. Immediate voice indicator — UI shows 🔊 icon right away
    let _ = app.emit("user_voice_start", UserVoiceStartEvent {
        audio_id: audio_id.clone(),
    });

    // 2b. Full voice_message for backward compat
    let _ = app.emit(
        "voice_message",
        VoiceMessageEvent {
            trace_id: trace_id.clone(),
            text: if text.is_empty() {
                "语音识别中…".into()
            } else {
                text
            },
            role: "user".into(),
            audio_id: Some(audio_id.clone()),
            audio_data: None,
            audio_mime: Some(audio_mime.clone()),
        },
    );

    // 3. Forward to backend WS — ASR will process and respond
    let ts = ws_protocol::now_ts;
    let did = device_id.to_string();
    let audio_len = audio_data.len();

    let r1 = ws_tx.send(UpstreamMessage::AudioSegmentBegin {
        trace_id: trace_id.clone(),
        device_id: did.clone(),
        mime_type: audio_mime.clone(),
        codec: audio_mime.clone(),
        sample_rate: 16000,
        channels: 1,
        timestamp: ts(),
        audio_id: Some(audio_id.clone()),
    });

    let r2 = ws_tx.send(UpstreamMessage::AudioSegmentChunk {
        trace_id: trace_id.clone(),
        device_id: did.clone(),
        seq: 0,
        data: audio_data,
        timestamp: ts(),
    });

    let r3 = ws_tx.send(UpstreamMessage::AudioSegmentEnd {
        trace_id: trace_id.clone(),
        device_id: did,
        reason: format!("{}_recording_complete", source),
        timestamp: ts(),
    });

    tracing::info!(
        trace_id = %trace_id,
        audio_id = %audio_id,
        audio_bytes = audio_len,
        begin_ok = r1.is_ok(),
        chunk_ok = r2.is_ok(),
        end_ok = r3.is_ok(),
        "audio forwarded to backend WS"
    );
}
