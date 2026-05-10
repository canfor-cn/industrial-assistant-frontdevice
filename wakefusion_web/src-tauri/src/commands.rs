use crate::audio_handler;
use crate::ws_protocol::{self, UpstreamMessage};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
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
    /// Whether the Python device module is currently connected to the Rust host
    #[serde(rename = "deviceConnected")]
    pub device_connected: bool,
    /// Device peer address (e.g. "127.0.0.1:53591") or empty if disconnected
    #[serde(rename = "deviceAddr")]
    pub device_addr: String,
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
    let (device_connected, device_addr) = crate::device_ws_server::device_snapshot();
    Ok(HostStatusResult {
        mode: "tauri-rust".into(),
        connected: true,
        device_id: host_id.0.clone(),
        backend_host: backend_host.0.clone(),
        device_connected,
        device_addr,
    })
}

/// Pull the last-known backend WS status. Used by the WebView at mount time
/// to recover from missed `backend_ws_status` events (Rust connect typically
/// happens before React useEffect runs and subscribes).
#[tauri::command]
pub async fn get_backend_ws_status() -> Result<crate::ws_client::BackendWsStatus, String> {
    Ok(crate::ws_client::current_status())
}

// ─── 摄像头管理（前端配置面板用） ───
// USB UVC 摄像头由 Rust/Tauri 直接枚举、选择和预览。Python 不再作为 USB
// 预览 owner，也不再参与高频取帧。

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CameraInfoForUi {
    index: u32,
    name: String,
    backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CameraListForUi {
    cameras: Vec<CameraInfoForUi>,
    active: CameraActiveForUi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CameraActiveForUi {
    backend: String,
    usb_index: Option<u32>,
    last_selected_name: Option<String>,
}

#[tauri::command]
pub async fn request_camera_list(app: tauri::AppHandle) -> Result<(), String> {
    let cameras = crate::media::camera_capture_runtime::list_cameras()
        .into_iter()
        .filter_map(|cam| {
            let index = cam.id.strip_prefix("uvc-mf:")?.parse::<u32>().ok()?;
            Some(CameraInfoForUi {
                index,
                name: cam.display_name,
                backend: "uvc".to_string(),
            })
        })
        .collect::<Vec<_>>();
    let status = crate::media::camera_capture_runtime::status();
    let payload = CameraListForUi {
        cameras,
        active: CameraActiveForUi {
            backend: "uvc".to_string(),
            usb_index: status.camera_index,
            last_selected_name: status.camera_name,
        },
    };
    let _ = app.emit("camera_list", payload);
    Ok(())
}

#[tauri::command]
pub async fn select_camera(
    app: tauri::AppHandle,
    backend: String,
    index: i64,
    name: String,
) -> Result<(), String> {
    if backend != "uvc" && backend != "usb" && backend != "uvc-mediafoundation" {
        return Err(format!("unsupported camera backend for Rust preview: {backend}"));
    }
    let idx = u32::try_from(index).map_err(|_| format!("invalid camera index: {index}"))?;
    let status = crate::media::camera_capture_runtime::start_preview_with_app(idx, Some(app.clone()))?;
    let _ = app.emit("camera_selected", serde_json::json!({
        "backend": "uvc",
        "index": status.camera_index.unwrap_or(idx),
        "name": status.camera_name.unwrap_or(name),
    }));
    let _ = request_camera_list(app).await;
    Ok(())
}

#[tauri::command]
pub async fn start_camera_preview(app: tauri::AppHandle) -> Result<(), String> {
    let status = crate::media::camera_capture_runtime::status();
    if !status.running {
        let _ = crate::media::camera_capture_runtime::start_default_preview_with_app(Some(app.clone()))?;
    }
    let _ = app.emit("camera_preview_status", crate::media::camera_capture_runtime::status());
    Ok(())
}

#[tauri::command]
pub async fn stop_camera_preview(app: tauri::AppHandle) -> Result<(), String> {
    crate::media::camera_capture_runtime::stop_preview();
    let _ = app.emit("camera_preview_status", crate::media::camera_capture_runtime::status());
    Ok(())
}
