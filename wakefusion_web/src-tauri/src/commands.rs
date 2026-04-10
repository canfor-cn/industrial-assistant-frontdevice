use crate::audio_handler;
use crate::ws_protocol::{self, UpstreamMessage};
use serde::Serialize;
use tauri::State;

pub type WsSender = crossbeam_channel::Sender<UpstreamMessage>;

/// Holds the device_id that the Rust host registered with the backend WS
pub struct HostDeviceId(pub String);

/// Holds the backend host address (e.g. "192.168.0.97:7788")
pub struct BackendHost(pub String);

#[derive(Debug, Clone, Serialize)]
pub struct HostStatusResult {
    pub mode: String,
    pub connected: bool,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "backendHost")]
    pub backend_host: String,
}

#[tauri::command]
pub async fn send_text(
    ws_tx: State<'_, WsSender>,
    host_id: State<'_, HostDeviceId>,
    text: String,
    trace_id: String,
    device_id: String,
) -> Result<(), String> {
    let _ = device_id;
    let msg = UpstreamMessage::Asr {
        stage: "final".into(),
        text,
        trace_id,
        device_id: host_id.0.clone(),
        timestamp: ws_protocol::now_ts(),
        context: None,
    };
    ws_tx.send(msg).map_err(|e| format!("WS send failed: {e}"))
}

/// WebUI recording completed — unified audio handling
#[tauri::command]
pub async fn send_audio(
    app: tauri::AppHandle,
    ws_tx: State<'_, WsSender>,
    host_id: State<'_, HostDeviceId>,
    trace_id: String,
    audio_data: String,
    mime_type: String,
    _language: String,
) -> Result<(), String> {
    audio_handler::handle_incoming_audio(
        &app,
        &ws_tx,
        &host_id.0,
        trace_id,
        String::new(), // text empty — ASR will fill it
        audio_data,
        mime_type,
        "webui",
    );
    Ok(())
}

/// Play cached audio by audioId — returns base64 data + mime type
#[tauri::command]
pub async fn get_cached_audio(audio_id: String) -> Result<CachedAudioResult, String> {
    audio_handler::get_cached_audio(&audio_id)
        .map(|(data, mime)| CachedAudioResult { audio_data: data, audio_mime: mime })
        .ok_or_else(|| "Audio not found in cache".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct CachedAudioResult {
    #[serde(rename = "audioData")]
    pub audio_data: String,
    #[serde(rename = "audioMime")]
    pub audio_mime: String,
}

#[tauri::command]
pub async fn host_status(
    host_id: State<'_, HostDeviceId>,
    backend_host: State<'_, BackendHost>,
) -> Result<HostStatusResult, String> {
    Ok(HostStatusResult {
        mode: "tauri-rust".into(),
        connected: true,
        device_id: host_id.0.clone(),
        backend_host: backend_host.0.clone(),
    })
}
