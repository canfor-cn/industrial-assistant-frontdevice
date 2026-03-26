use serde::Serialize;

/// Events emitted to the WebView via Tauri

#[derive(Debug, Clone, Serialize)]
pub struct SubtitleUserEvent {
    #[serde(rename = "traceId")]
    pub trace_id: String,
    pub text: String,
    pub stage: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubtitleAiStreamEvent {
    #[serde(rename = "traceId")]
    pub trace_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubtitleAiCommitEvent {
    #[serde(rename = "traceId")]
    pub trace_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubtitleClearEvent {}

#[derive(Debug, Clone, Serialize)]
pub struct MediaRefEvent {
    #[serde(rename = "traceId")]
    pub trace_id: String,
    #[serde(rename = "assetId")]
    pub asset_id: Option<String>,
    #[serde(rename = "assetType")]
    pub asset_type: Option<String>,
    pub url: Option<String>,
    pub label: Option<String>,
    #[serde(rename = "startMs")]
    pub start_ms: Option<f64>,
    #[serde(rename = "endMs")]
    pub end_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionStatusEvent {
    pub connected: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteEvent {
    #[serde(rename = "traceId")]
    pub trace_id: String,
    pub route: String,
}
