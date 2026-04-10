use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct WakeFusionConfig {
    #[serde(default)]
    pub llm_agent: LlmAgentConfig,
    #[serde(default)]
    pub audio_playback: AudioPlaybackConfig,
    #[serde(default)]
    pub audio_threshold: AudioThresholdConfig,
    #[serde(default)]
    pub zmq: ZmqConfig,
    #[serde(default)]
    pub device: DeviceProcessConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceProcessConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_python")]
    pub python: String,
    #[serde(default = "default_device_module")]
    pub module: String,
}

impl Default for DeviceProcessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            python: default_python(),
            module: default_device_module(),
        }
    }
}

fn default_python() -> String { "python".into() }
fn default_device_module() -> String { "wakefusion.services.device_main".into() }

#[derive(Debug, Clone, Deserialize)]
pub struct LlmAgentConfig {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_device_id")]
    pub device_id: String,
    #[serde(default = "default_token")]
    pub token: String,
    #[serde(default)]
    pub use_ssl: bool,
    #[serde(default = "default_reconnect")]
    pub reconnect_interval_sec: f64,
    #[serde(default = "default_ping")]
    pub ping_interval_sec: f64,
}

impl Default for LlmAgentConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            device_id: default_device_id(),
            token: default_token(),
            use_ssl: false,
            reconnect_interval_sec: default_reconnect(),
            ping_interval_sec: default_ping(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AudioPlaybackConfig {
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
    #[serde(default = "default_channels")]
    pub channels: u16,
    #[serde(default = "default_prebuffer_ms")]
    pub prebuffer_ms: u32,
    #[serde(default = "default_output_device_match")]
    pub output_device_match: String,
    #[serde(default)]
    pub strict_output_device: bool,
}

impl Default for AudioPlaybackConfig {
    fn default() -> Self {
        Self {
            sample_rate: default_sample_rate(),
            channels: default_channels(),
            prebuffer_ms: default_prebuffer_ms(),
            output_device_match: default_output_device_match(),
            strict_output_device: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AudioThresholdConfig {
    #[serde(default = "default_threshold")]
    pub default: f64,
    #[serde(default = "default_visual_wake")]
    pub visual_wake: f64,
}

impl Default for AudioThresholdConfig {
    fn default() -> Self {
        Self {
            default: default_threshold(),
            visual_wake: default_visual_wake(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ZmqConfig {
    #[serde(default = "default_audio_pub_port")]
    pub audio_pub_port: u16,
    #[serde(default = "default_vision_pub_port")]
    pub vision_pub_port: u16,
    #[serde(default = "default_audio_ctrl_port")]
    pub audio_ctrl_port: u16,
    #[serde(default = "default_vision_ctrl_port")]
    pub vision_ctrl_pub_port: u16,
}

impl Default for ZmqConfig {
    fn default() -> Self {
        Self {
            audio_pub_port: default_audio_pub_port(),
            vision_pub_port: default_vision_pub_port(),
            audio_ctrl_port: default_audio_ctrl_port(),
            vision_ctrl_pub_port: default_vision_ctrl_port(),
        }
    }
}

fn default_host() -> String { "127.0.0.1:7788".into() }
fn default_device_id() -> String { "wakefusion-device-01".into() }
fn default_token() -> String { "test-voice-token".into() }
fn default_reconnect() -> f64 { 5.0 }
fn default_ping() -> f64 { 30.0 }
fn default_sample_rate() -> u32 { 22050 }
fn default_channels() -> u16 { 1 }
fn default_prebuffer_ms() -> u32 { 100 }
fn default_output_device_match() -> String { "XVF3800".into() }
fn default_threshold() -> f64 { 0.5 }
fn default_visual_wake() -> f64 { 0.6 }
fn default_audio_pub_port() -> u16 { 5556 }
fn default_vision_pub_port() -> u16 { 5555 }
fn default_audio_ctrl_port() -> u16 { 5557 }
fn default_vision_ctrl_port() -> u16 { 5564 }

/// Resolve the directory where the executable lives.
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

pub fn load_config() -> (WakeFusionConfig, Option<PathBuf>) {
    // Look for config.yaml next to the executable, then in cwd
    let candidates: Vec<PathBuf> = [
        exe_dir().map(|d| d.join("config.yaml")),
        Some(PathBuf::from("config.yaml")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for path in &candidates {
        if path.exists() {
            if let Ok(text) = std::fs::read_to_string(path) {
                match serde_yaml::from_str::<WakeFusionConfig>(&text) {
                    Ok(config) => {
                        tracing::info!("Loaded config from {}", path.display());
                        return (config, Some(path.clone()));
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse {}: {e}", path.display());
                    }
                }
            }
        }
    }

    tracing::warn!("No config.yaml found, using defaults");
    (WakeFusionConfig {
        llm_agent: LlmAgentConfig::default(),
        audio_playback: AudioPlaybackConfig::default(),
        audio_threshold: AudioThresholdConfig::default(),
        zmq: ZmqConfig::default(),
        device: DeviceProcessConfig::default(),
    }, None)
}
