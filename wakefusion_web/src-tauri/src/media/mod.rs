//! Media device runtime — Rust/Tauri 端 USB UVC 摄像头与音频设备的统一采集 / 预览 / 分析采样
//! 模块树：
//!   camera_device_manager      — 枚举 USB UVC、profile 协商、热插拔
//!   camera_capture_runtime     — nokhwa 原生取帧 + latest-frame buffer
//!   camera_profile             — Profile 选择策略 (优先 MJPG/NV12)
//!   preview_stream_server      — HTTP MJPEG :7892（前端 <img> 直接拉）
//!   analysis_sampler           — 从 latest frame 降采样 + 限帧 + 自适应
//!   analysis_transport         — Rust → Python ws binary :7894（独立端口）
//!   audio_device_manager       — cpal 枚举输入/输出声卡
//!   device_config_store        — media_devices.* yaml 持久化 + 旧字段迁移
//!   media_events               — Tauri event 类型（device_list/preview_status/health）

pub mod camera_device_manager;
pub mod camera_capture_runtime;
pub mod camera_profile;
// pub mod preview_stream_server;
// pub mod analysis_sampler;
// pub mod analysis_transport;
// pub mod audio_device_manager;
// pub mod device_config_store;
// pub mod media_events;
