"""
Preview MJPEG HTTP server — vision_service 进程内自己起 HTTP，浏览器 <img> 直连。

监控行业事实标准（海康/大华/树莓派）：摄像头进程自带 HTTP MJPEG endpoint，
浏览器原生 multipart 解码，**完全绕过中间 IPC**（ws 推 base64 经常被 80KB
JSON 阻塞 → vision 主循环卡死 → 看着 1fps）。

数据流：
    vision_service.run() 每帧 cv2.imencode → put_jpeg(bytes)
                                          ↓
                            Mutex slot + version counter
                                          ↓
            HTTP handler 长连接监控 version → 推一帧 multipart part
                                          ↓
            <img src="http://127.0.0.1:7893/preview.mjpg"> 浏览器原生解码

性能：
    640×480 jpeg ≈ 25KB / 30fps = 750 KB/s 本地 HTTP，CPU < 1%
    1280×720 jpeg ≈ 60KB / 30fps = 1.8 MB/s 本地，依然轻松
"""

from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional


_LOCK = threading.Lock()
_LATEST_JPEG: bytes = b""
_VERSION: int = 0
_SERVER: Optional[ThreadingHTTPServer] = None


def put_jpeg(jpeg_bytes: bytes) -> None:
    """vision_service 主循环每帧调一次，写入最新 jpeg 给 HTTP handler 推送。"""
    global _LATEST_JPEG, _VERSION
    with _LOCK:
        _LATEST_JPEG = jpeg_bytes
        _VERSION += 1


def _snapshot() -> tuple[bytes, int]:
    with _LOCK:
        return _LATEST_JPEG, _VERSION


class _MjpegHandler(BaseHTTPRequestHandler):
    # 关掉 stdout 的 access log 噪音（避免每帧都打印一行）
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if not self.path.startswith("/preview.mjpg"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        boundary = "wfmjpegboundary"
        try:
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={boundary}")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
        except Exception:
            return

        last_version = 0
        idle_loops = 0
        try:
            while True:
                bytes_, version = _snapshot()
                if version != last_version and bytes_:
                    try:
                        self.wfile.write(f"--{boundary}\r\n".encode())
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(bytes_)}\r\n\r\n".encode())
                        self.wfile.write(bytes_)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        return  # 浏览器关连接，正常退出
                    except Exception:
                        return
                    last_version = version
                    idle_loops = 0
                else:
                    idle_loops += 1
                    # 60 秒没新帧（vision 卡死 / 没人开面板）→ 关连接让浏览器重连
                    if idle_loops > 4000:
                        return
                time.sleep(0.015)  # ~66Hz 轮询，足够喂 30fps 视频
        except Exception:
            return


def start_server(port: int = 7893) -> None:
    """启动 HTTP server 在后台线程。重复调用是幂等的（已启动则忽略）。"""
    global _SERVER
    if _SERVER is not None:
        return
    try:
        _SERVER = ThreadingHTTPServer(("127.0.0.1", port), _MjpegHandler)
    except OSError as e:
        print(f"[preview_http] bind 127.0.0.1:{port} failed: {e}", flush=True)
        _SERVER = None
        return

    def _run():
        print(f"[preview_http] MJPEG server listening on http://127.0.0.1:{port}/preview.mjpg",
              flush=True)
        try:
            assert _SERVER is not None
            _SERVER.serve_forever(poll_interval=0.5)
        except Exception as e:
            print(f"[preview_http] server stopped: {e}", flush=True)

    threading.Thread(target=_run, name="preview-http-server", daemon=True).start()
