//! Rust-owned USB UVC capture runtime.
//!
//! This is the owner of the preview camera handle. Python must not open the
//! same USB camera for preview; it only consumes analysis metadata/frames in
//! later layers.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
};
use nokhwa::Camera;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::camera_device_manager::{list_uvc_cameras, CameraDevice};
use super::camera_profile::{pick_preview_profile, PixelFormat, PreviewTarget};

#[derive(Debug, Clone, Serialize)]
pub struct CameraRuntimeStatus {
    pub running: bool,
    pub camera_index: Option<u32>,
    pub camera_name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pixel_format: String,
    pub frames: u64,
    pub last_error: Option<String>,
}

struct CaptureHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct CaptureState {
    handle: Option<CaptureHandle>,
    status: CameraRuntimeStatus,
}

impl Default for CameraRuntimeStatus {
    fn default() -> Self {
        Self {
            running: false,
            camera_index: None,
            camera_name: None,
            width: 0,
            height: 0,
            fps: 0,
            pixel_format: String::new(),
            frames: 0,
            last_error: None,
        }
    }
}

static CAPTURE_STATE: LazyLock<Mutex<CaptureState>> =
    LazyLock::new(|| Mutex::new(CaptureState::default()));

pub fn list_cameras() -> Vec<CameraDevice> {
    list_uvc_cameras()
}

pub fn start_default_preview() -> Result<CameraRuntimeStatus, String> {
    start_default_preview_with_app(None)
}

pub fn start_default_preview_with_app(app: Option<AppHandle>) -> Result<CameraRuntimeStatus, String> {
    let cams = list_uvc_cameras();
    let first = cams
        .first()
        .ok_or_else(|| "no USB UVC camera found".to_string())?;
    let index = parse_camera_index(&first.id).unwrap_or(0);
    start_preview_with_app(index, app)
}

pub fn start_preview(index: u32) -> Result<CameraRuntimeStatus, String> {
    start_preview_with_app(index, None)
}

pub fn start_preview_with_app(index: u32, app: Option<AppHandle>) -> Result<CameraRuntimeStatus, String> {
    stop_preview();

    let cams = list_uvc_cameras();
    let cam_info = cams
        .iter()
        .find(|c| parse_camera_index(&c.id) == Some(index))
        .cloned()
        .or_else(|| cams.first().cloned())
        .ok_or_else(|| "no USB UVC camera found".to_string())?;
    let actual_index = parse_camera_index(&cam_info.id).unwrap_or(index);
    let profile = pick_preview_profile(&cam_info.profiles, PreviewTarget::default())
        .cloned()
        .ok_or_else(|| format!("camera {} has no usable profile", cam_info.display_name))?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let name = cam_info.display_name.clone();
    let status_name = name.clone();
    let pixel_format = profile.pixel_format;
    let width = profile.width;
    let height = profile.height;
    let fps = profile.fps;

    let join = std::thread::Builder::new()
        .name(format!("uvc-capture-{}", actual_index))
        .spawn(move || {
            run_capture_loop(
                actual_index,
                name,
                width,
                height,
                fps,
                pixel_format,
                thread_stop,
                app,
            );
        })
        .map_err(|e| format!("spawn capture thread failed: {e}"))?;

    let mut state = CAPTURE_STATE.lock().unwrap();
    state.handle = Some(CaptureHandle {
        stop,
        join: Some(join),
    });
    state.status = CameraRuntimeStatus {
        running: true,
        camera_index: Some(actual_index),
        camera_name: Some(status_name),
        width,
        height,
        fps,
        pixel_format: format!("{pixel_format:?}"),
        frames: 0,
        last_error: None,
    };
    tracing::info!(
        "[media] Rust USB preview started: index={} {}x{}@{} {:?}",
        actual_index,
        width,
        height,
        fps,
        pixel_format
    );
    Ok(state.status.clone())
}

pub fn stop_preview() {
    let handle = {
        let mut state = CAPTURE_STATE.lock().unwrap();
        state.status.running = false;
        state.handle.take()
    };

    if let Some(mut handle) = handle {
        handle.stop.store(true, Ordering::Release);
        if let Some(join) = handle.join.take() {
            let _ = join.join();
        }
        tracing::info!("[media] Rust USB preview stopped");
    }
}

pub fn status() -> CameraRuntimeStatus {
    CAPTURE_STATE.lock().unwrap().status.clone()
}

fn run_capture_loop(
    index: u32,
    name: String,
    width: u32,
    height: u32,
    fps: u32,
    pixel_format: PixelFormat,
    stop: Arc<AtomicBool>,
    app: Option<AppHandle>,
) {
    if let Err(e) = run_capture_loop_inner(index, &name, width, height, fps, pixel_format, &stop, app.as_ref()) {
        tracing::error!("[media] Rust USB capture stopped with error: {}", e);
        let mut state = CAPTURE_STATE.lock().unwrap();
        state.status.running = false;
        state.status.last_error = Some(e);
    }
}

fn run_capture_loop_inner(
    index: u32,
    name: &str,
    width: u32,
    height: u32,
    fps: u32,
    pixel_format: PixelFormat,
    stop: &AtomicBool,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let frame_format = to_nokhwa_format(pixel_format);
    let wanted_formats = [frame_format, FrameFormat::MJPEG, FrameFormat::NV12, FrameFormat::YUYV];
    let req = RequestedFormat::with_formats(
        RequestedFormatType::Exact(CameraFormat::new_from(width, height, frame_format, fps)),
        &wanted_formats,
    );
    let mut camera = Camera::with_backend(CameraIndex::Index(index), req, ApiBackend::MediaFoundation)
        .map_err(|e| format!("open nokhwa camera {index} failed: {e}"))?;
    camera
        .open_stream()
        .map_err(|e| format!("open camera stream failed: {e}"))?;

    let actual = camera.camera_format();
    tracing::info!(
        "[media] Rust capture stream open: index={} name={:?} actual={}x{}@{} {:?}",
        index,
        name,
        actual.width(),
        actual.height(),
        actual.frame_rate(),
        actual.format()
    );

    let mut frames: u64 = 0;
    let mut last_log = Instant::now();
    let mut frames_at_last_log = 0u64;

    while !stop.load(Ordering::Acquire) {
        let started = Instant::now();
        let frame = match camera.frame() {
            Ok(frame) => frame,
            Err(e) => {
                tracing::warn!("[media] camera.frame failed: {}", e);
                std::thread::sleep(Duration::from_millis(30));
                continue;
            }
        };
        let jpeg = encode_buffer_to_jpeg(&frame)?;
        crate::mjpeg_server::put_jpeg(jpeg);

        frames += 1;
        {
            let mut state = CAPTURE_STATE.lock().unwrap();
            state.status.running = true;
            state.status.frames = frames;
            state.status.width = frame.resolution().width();
            state.status.height = frame.resolution().height();
            state.status.last_error = None;
        }

        if last_log.elapsed() >= Duration::from_secs(3) {
            let elapsed = last_log.elapsed().as_secs_f64();
            let delta = frames - frames_at_last_log;
            let preview_fps = delta as f64 / elapsed;
            tracing::info!(
                "[media] Rust preview fps={:.1} frames={} frame_ms={}",
                preview_fps,
                frames,
                started.elapsed().as_millis()
            );
            if let Some(app) = app {
                let _ = app.emit("camera_preview_status", serde_json::json!({
                    "width": frame.resolution().width(),
                    "height": frame.resolution().height(),
                    "fps": preview_fps,
                    "frames": frames,
                    "source": "rust_uvc",
                }));
            }
            last_log = Instant::now();
            frames_at_last_log = frames;
        }
    }

    Ok(())
}

fn encode_buffer_to_jpeg(frame: &nokhwa::Buffer) -> Result<Vec<u8>, String> {
    if frame.source_frame_format() == FrameFormat::MJPEG {
        return Ok(frame.buffer().to_vec());
    }

    let rgb = decode_to_rgb(
        frame.source_frame_format(),
        frame.resolution().width(),
        frame.resolution().height(),
        frame.buffer(),
    )?;
    let rgb = image::RgbImage::from_raw(frame.resolution().width(), frame.resolution().height(), rgb)
        .ok_or_else(|| "failed to build RGB image buffer".to_string())?;
    let mut jpeg = Vec::with_capacity((rgb.width() * rgb.height() / 2) as usize);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("jpeg encode failed: {e}"))?;
    Ok(jpeg)
}

fn decode_to_rgb(format: FrameFormat, width: u32, height: u32, data: &[u8]) -> Result<Vec<u8>, String> {
    match format {
        FrameFormat::NV12 => nv12_to_rgb(width, height, data),
        FrameFormat::YUYV => yuyv_to_rgb(width, height, data),
        FrameFormat::RAWRGB => {
            let expected = (width * height * 3) as usize;
            if data.len() < expected {
                return Err(format!("RAWRGB frame too small: {} < {}", data.len(), expected));
            }
            Ok(data[..expected].to_vec())
        }
        FrameFormat::RAWBGR => {
            let expected = (width * height * 3) as usize;
            if data.len() < expected {
                return Err(format!("RAWBGR frame too small: {} < {}", data.len(), expected));
            }
            let mut rgb = Vec::with_capacity(expected);
            for px in data[..expected].chunks_exact(3) {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            }
            Ok(rgb)
        }
        FrameFormat::GRAY => {
            let expected = (width * height) as usize;
            if data.len() < expected {
                return Err(format!("GRAY frame too small: {} < {}", data.len(), expected));
            }
            let mut rgb = Vec::with_capacity(expected * 3);
            for &y in &data[..expected] {
                rgb.extend_from_slice(&[y, y, y]);
            }
            Ok(rgb)
        }
        other => Err(format!("unsupported frame format for preview encode: {:?}", other)),
    }
}

fn nv12_to_rgb(width: u32, height: u32, data: &[u8]) -> Result<Vec<u8>, String> {
    let w = width as usize;
    let h = height as usize;
    let y_len = w * h;
    let uv_len = y_len / 2;
    if data.len() < y_len + uv_len {
        return Err(format!("NV12 frame too small: {} < {}", data.len(), y_len + uv_len));
    }
    let y_plane = &data[..y_len];
    let uv_plane = &data[y_len..y_len + uv_len];
    let mut rgb = vec![0u8; y_len * 3];

    for row in 0..h {
        for col in 0..w {
            let y = y_plane[row * w + col] as i32;
            let uv_row = row / 2;
            let uv_col = (col / 2) * 2;
            let uv_idx = uv_row * w + uv_col;
            let u = uv_plane.get(uv_idx).copied().unwrap_or(128) as i32;
            let v = uv_plane.get(uv_idx + 1).copied().unwrap_or(128) as i32;
            write_rgb(&mut rgb, row * w + col, y, u, v);
        }
    }
    Ok(rgb)
}

fn yuyv_to_rgb(width: u32, height: u32, data: &[u8]) -> Result<Vec<u8>, String> {
    let pixels = (width * height) as usize;
    let expected = pixels * 2;
    if data.len() < expected {
        return Err(format!("YUYV frame too small: {} < {}", data.len(), expected));
    }
    let mut rgb = vec![0u8; pixels * 3];
    let mut px = 0usize;
    for chunk in data[..expected].chunks_exact(4) {
        let y0 = chunk[0] as i32;
        let u = chunk[1] as i32;
        let y1 = chunk[2] as i32;
        let v = chunk[3] as i32;
        write_rgb(&mut rgb, px, y0, u, v);
        if px + 1 < pixels {
            write_rgb(&mut rgb, px + 1, y1, u, v);
        }
        px += 2;
    }
    Ok(rgb)
}

fn write_rgb(dst: &mut [u8], pixel_index: usize, y: i32, u: i32, v: i32) {
    let c = (y - 16).max(0);
    let d = u - 128;
    let e = v - 128;
    let r = (298 * c + 409 * e + 128) >> 8;
    let g = (298 * c - 100 * d - 208 * e + 128) >> 8;
    let b = (298 * c + 516 * d + 128) >> 8;
    let off = pixel_index * 3;
    if off + 2 < dst.len() {
        dst[off] = clamp_u8(r);
        dst[off + 1] = clamp_u8(g);
        dst[off + 2] = clamp_u8(b);
    }
}

fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

fn to_nokhwa_format(pixel_format: PixelFormat) -> FrameFormat {
    match pixel_format {
        PixelFormat::Mjpg => FrameFormat::MJPEG,
        PixelFormat::Nv12 => FrameFormat::NV12,
        PixelFormat::Yuy2 => FrameFormat::YUYV,
        PixelFormat::Rgb => FrameFormat::RAWRGB,
        PixelFormat::H264 | PixelFormat::Other => FrameFormat::MJPEG,
    }
}

fn parse_camera_index(id: &str) -> Option<u32> {
    id.strip_prefix("uvc-mf:")
        .and_then(|s| s.parse::<u32>().ok())
}
