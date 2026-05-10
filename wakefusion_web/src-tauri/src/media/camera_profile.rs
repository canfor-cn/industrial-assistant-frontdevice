//! Camera profile 抽象 — 与 nokhwa 解耦的 capability 描述
//! 选择策略：见 docs/wakefusion-media-device-architecture.md § 5.1
//!   预览：优先 MJPG / NV12 / H264（避开 raw YUY2 在 USB 2.0 下高分辨率被锁的问题）
//!   分析：默认从预览帧降采样，不直接走全分辨率

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PixelFormat {
    Mjpg,
    Nv12,
    Yuy2,
    H264,
    Rgb,
    Other,
}

impl PixelFormat {
    /// 高分辨率下不被 USB 2.0 raw 带宽锁死的格式（硬件压缩或半平面）
    pub fn is_bandwidth_friendly(&self) -> bool {
        matches!(self, PixelFormat::Mjpg | PixelFormat::Nv12 | PixelFormat::H264)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraProfile {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pixel_format: PixelFormat,
    pub preferred_for_preview: bool,
    pub preferred_for_analysis: bool,
}

impl CameraProfile {
    /// 给一组 profile 排个分，分越高越适合做主预览
    /// 评分：bandwidth-friendly +100、分辨率接近 720p +50、fps >= 30 +20
    pub fn preview_score(&self, target_w: u32, target_h: u32, target_fps: u32) -> i64 {
        let mut score: i64 = 0;
        if self.pixel_format.is_bandwidth_friendly() {
            score += 100;
        }
        // 分辨率匹配度（越接近 target 越高，超出也扣分）
        let w_diff = (self.width as i64 - target_w as i64).abs();
        let h_diff = (self.height as i64 - target_h as i64).abs();
        score -= (w_diff + h_diff) / 16;
        // fps
        if self.fps >= target_fps {
            score += 20;
        } else {
            score -= (target_fps as i64 - self.fps as i64) * 2;
        }
        score
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PreviewTarget {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Default for PreviewTarget {
    fn default() -> Self {
        // 默认 720p / 30fps（对应文档 § 5.3）
        Self { width: 1280, height: 720, fps: 30 }
    }
}

/// 从一组候选 profile 中选最适合做主预览的
pub fn pick_preview_profile<'a>(
    profiles: &'a [CameraProfile],
    target: PreviewTarget,
) -> Option<&'a CameraProfile> {
    profiles
        .iter()
        .max_by_key(|p| p.preview_score(target.width, target.height, target.fps))
}
