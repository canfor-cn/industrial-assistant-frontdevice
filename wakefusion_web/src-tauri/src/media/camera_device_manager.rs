//! USB UVC 摄像头枚举（用 nokhwa Media Foundation 后端）
//! 阶段 A：仅枚举功能，验证 nokhwa 在 Windows 能拿到 NV12/MJPG profile

use serde::{Deserialize, Serialize};

use super::camera_profile::{CameraProfile, PixelFormat};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDevice {
    pub id: String,
    pub display_name: String,
    pub backend: String,        // "uvc-mediafoundation" | "uvc-directshow" | "rtsp"
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub profiles: Vec<CameraProfile>,
    pub active_profile_id: Option<String>,
    pub available: bool,
}

/// 枚举系统所有 USB UVC 摄像头 + 它们的 profiles
pub fn list_uvc_cameras() -> Vec<CameraDevice> {
    use nokhwa::query;
    use nokhwa::utils::ApiBackend;

    let mut out = Vec::new();
    let infos = match query(ApiBackend::MediaFoundation) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("nokhwa query MediaFoundation failed: {}", e);
            return out;
        }
    };

    for info in infos {
        let cam_id = format!("uvc-mf:{}", info.index());
        let display_name = info.human_name();
        // 获取该设备支持的所有 frame format（profile 列表）
        let profiles = enumerate_profiles_for(&info);
        out.push(CameraDevice {
            id: cam_id,
            display_name,
            backend: "uvc-mediafoundation".to_string(),
            vendor_id: None,
            product_id: None,
            profiles,
            active_profile_id: None,
            available: true,
        });
    }
    out
}

/// 列举单个设备的所有支持 profile（分辨率 × fps × pixel format）
fn enumerate_profiles_for(info: &nokhwa::utils::CameraInfo) -> Vec<CameraProfile> {
    use nokhwa::utils::{CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType};
    use nokhwa::Camera;

    let mut profiles = Vec::new();
    let idx = info.index().clone();

    // 临时打开摄像头查 capability（query_compatible_resolutions / query_supported_frame_formats）
    // 然后立刻 close。注意：不是每个驱动都允许频繁 open/close，下面 nokhwa 有 cache。
    let cam_idx = match idx {
        CameraIndex::Index(i) => CameraIndex::Index(i),
        CameraIndex::String(s) => CameraIndex::String(s),
    };

    let req = RequestedFormat::new::<nokhwa::pixel_format::RgbFormat>(
        RequestedFormatType::AbsoluteHighestFrameRate,
    );
    let mut cam = match Camera::new(cam_idx, req) {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!("nokhwa probe Camera::new failed for {}: {}", info.human_name(), e);
            return profiles;
        }
    };

    let mut supported_formats = std::collections::BTreeSet::new();
    for fmt in [
        FrameFormat::MJPEG,
        FrameFormat::YUYV,
        FrameFormat::NV12,
        FrameFormat::GRAY,
    ] {
        if let Ok(map) = cam.compatible_list_by_resolution(fmt) {
            for (res, fps_list) in map {
                for fps in fps_list {
                    supported_formats.insert((res.width(), res.height(), fps, fmt));
                }
            }
        }
    }

    for (w, h, fps, fmt) in supported_formats {
        let pf = match fmt {
            FrameFormat::MJPEG => PixelFormat::Mjpg,
            FrameFormat::NV12 => PixelFormat::Nv12,
            FrameFormat::YUYV => PixelFormat::Yuy2,
            FrameFormat::GRAY => PixelFormat::Other,
            _ => PixelFormat::Other,
        };
        let id = format!("{}x{}@{}-{:?}", w, h, fps, fmt);
        profiles.push(CameraProfile {
            id,
            width: w,
            height: h,
            fps,
            pixel_format: pf,
            preferred_for_preview: pf.is_bandwidth_friendly(),
            preferred_for_analysis: false,
        });
    }
    profiles
}
