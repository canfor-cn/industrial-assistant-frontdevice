//! MJPEG HTTP 服务（监控行业事实标准）。
//!
//! 协议：HTTP/1.1 + multipart/x-mixed-replace —— 浏览器 `<img>` 原生支持，
//! 一行 `<img src="http://127.0.0.1:7892/preview.mjpg">` 就能持续显示。
//!
//! 数据流：
//!   Python vision_service jpeg_b64
//!     → device WS 上行
//!     → device_ws_server::handle_device_message 解 base64
//!     → put_jpeg(bytes) 写入全局 latest 槽
//!     → 这里的 HTTP handler 检测到版本号变化推到长连接
//!     → 浏览器 <img> 自动渲染下一帧
//!
//! 实现说明：
//!   - 不引入新 crate（避开 axum/warp/hyper 编译时间），手撸 TCP + 简单 HTTP/1.1
//!   - 单一连接 = 单一线程；并发量极小（前端面板最多 1-2 个 viewer）
//!   - 通过 AtomicUsize 版本号触发推送，避免轮询整段 mutex 拷贝

use std::io::Write;
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use std::time::Duration;

static LATEST_JPEG: std::sync::LazyLock<Mutex<Vec<u8>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));
static FRAME_VERSION: AtomicUsize = AtomicUsize::new(0);

/// 写入最新一帧 jpeg bytes。device_ws_server 收到 camera_preview 时调用。
pub fn put_jpeg(bytes: Vec<u8>) {
    {
        let mut slot = LATEST_JPEG.lock().unwrap();
        *slot = bytes;
    }
    FRAME_VERSION.fetch_add(1, Ordering::Release);
}

/// 启动 MJPEG HTTP server 在指定端口（独立后台线程）。
pub fn spawn_mjpeg_server(port: u16) {
    let _ = std::thread::Builder::new()
        .name(format!("mjpeg-http-{}", port))
        .spawn(move || run_server(port));
}

fn run_server(port: u16) {
    let addr = format!("127.0.0.1:{}", port);
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("MJPEG server bind {} failed: {}", addr, e);
            return;
        }
    };
    tracing::info!("MJPEG server listening on http://{}/preview.mjpg", addr);

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        std::thread::spawn(move || {
            if let Err(e) = handle_client(stream) {
                tracing::debug!("MJPEG client closed: {}", e);
            }
        });
    }
}

fn handle_client(mut stream: std::net::TcpStream) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader};

    // 读 request line + headers（简单丢弃）
    let read_clone = stream.try_clone()?;
    let mut reader = BufReader::new(read_clone);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }

    // 路由
    let path_ok = request_line.contains("/preview.mjpg");
    let is_options = request_line.starts_with("OPTIONS");

    if is_options {
        stream.write_all(
            b"HTTP/1.1 204 No Content\r\n\
              Access-Control-Allow-Origin: *\r\n\
              Access-Control-Allow-Methods: GET, OPTIONS\r\n\
              Content-Length: 0\r\n\r\n",
        )?;
        return Ok(());
    }

    if !path_ok {
        stream.write_all(
            b"HTTP/1.1 404 Not Found\r\n\
              Content-Length: 0\r\n\
              Connection: close\r\n\r\n",
        )?;
        return Ok(());
    }

    // MJPEG response — multipart/x-mixed-replace
    let boundary = "wfmjpegboundary";
    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: multipart/x-mixed-replace; boundary={}\r\n\
         Cache-Control: no-cache, no-store, must-revalidate\r\n\
         Pragma: no-cache\r\n\
         Connection: close\r\n\
         Access-Control-Allow-Origin: *\r\n\
         \r\n",
        boundary
    );
    stream.write_all(header.as_bytes())?;
    stream.flush()?;

    // 推送循环：版本号变化 → 推一帧；客户端关连接时 write 失败退出。
    let mut last_version = 0usize;
    let mut idle_loops = 0u32;
    loop {
        let cur_version = FRAME_VERSION.load(Ordering::Acquire);
        if cur_version != last_version {
            let bytes = { LATEST_JPEG.lock().unwrap().clone() };
            if !bytes.is_empty() {
                let part_header = format!(
                    "--{}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                    boundary,
                    bytes.len()
                );
                stream.write_all(part_header.as_bytes())?;
                stream.write_all(&bytes)?;
                stream.write_all(b"\r\n")?;
                stream.flush()?;
                last_version = cur_version;
                idle_loops = 0;
            }
        } else {
            idle_loops += 1;
            // 60s 没新帧（vision 卡死/前端面板没人开）→ 关闭连接，让浏览器自动重连
            if idle_loops > 4000 {
                tracing::debug!("MJPEG stream idle 60s, closing");
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}
