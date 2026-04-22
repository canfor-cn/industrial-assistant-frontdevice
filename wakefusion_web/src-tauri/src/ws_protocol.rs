use serde::{Deserialize, Serialize};

/// Messages sent from Rust host to backend WS
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum UpstreamMessage {
    #[serde(rename = "asr")]
    Asr {
        stage: String,
        text: String,
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        timestamp: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<serde_json::Value>,
    },
    #[serde(rename = "device_state")]
    DeviceState {
        state: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        timestamp: f64,
    },
    #[serde(rename = "interrupt")]
    Interrupt {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        reason: String,
        timestamp: f64,
    },
    #[serde(rename = "audio_segment_begin")]
    AudioSegmentBegin {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        codec: String,
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
        channels: u32,
        timestamp: f64,
        #[serde(rename = "audioId", skip_serializing_if = "Option::is_none")]
        audio_id: Option<String>,
    },
    #[serde(rename = "audio_segment_chunk")]
    AudioSegmentChunk {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        seq: u32,
        data: String,
        timestamp: f64,
    },
    #[serde(rename = "audio_segment_end")]
    AudioSegmentEnd {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        reason: String,
        timestamp: f64,
    },
    #[serde(rename = "ping")]
    Ping {
        #[serde(rename = "deviceId")]
        device_id: String,
        timestamp: f64,
    },
    // Qwen-Omni-Realtime 流式协议（设备侧 realtime_mode=true 时使用）
    #[serde(rename = "audio_stream_start")]
    AudioStreamStart {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        codec: String,
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
        channels: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        timestamp: f64,
    },
    #[serde(rename = "audio_stream_chunk")]
    AudioStreamChunk {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        seq: u32,
        data: String,
        timestamp: f64,
    },
    #[serde(rename = "audio_stream_stop")]
    AudioStreamStop {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        reason: String,
        timestamp: f64,
    },
    #[serde(rename = "greeting")]
    Greeting {
        #[serde(rename = "deviceId")]
        device_id: String,
        timestamp: f64,
    },
    #[serde(rename = "timeout_exit")]
    TimeoutExit {
        #[serde(rename = "deviceId")]
        device_id: String,
        reason: String,
        timestamp: f64,
    },
    // Qwen Realtime manual 模式控制事件（设备侧 Silero 独裁时使用）
    #[serde(rename = "user_speech_end")]
    UserSpeechEnd {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        timestamp: f64,
    },
    #[serde(rename = "barge_in")]
    BargeIn {
        #[serde(rename = "traceId")]
        trace_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        timestamp: f64,
    },
}

/// Messages received from backend WS (parsed from JSON)
#[derive(Debug, Clone, Deserialize)]
pub struct DownstreamMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "traceId")]
    pub trace_id: Option<String>,
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    // Audio fields
    pub codec: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "sampleRate")]
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub data: Option<String>,
    pub seq: Option<u32>,
    // Session fields
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "sessionAction")]
    pub session_action: Option<String>,
    // Text fields
    pub text: Option<String>,
    pub stage: Option<String>,
    pub status: Option<String>,
    pub route: Option<String>,
    pub code: Option<String>,
    pub message: Option<String>,
    pub reason: Option<String>,
    // Media fields
    pub url: Option<String>,
    #[serde(rename = "assetId")]
    pub asset_id: Option<String>,
    #[serde(rename = "assetType")]
    pub asset_type: Option<String>,
    pub label: Option<String>,
    #[serde(rename = "startMs")]
    pub start_ms: Option<f64>,
    #[serde(rename = "endMs")]
    pub end_ms: Option<f64>,
    // Catch-all for other fields
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

pub fn now_ts() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
