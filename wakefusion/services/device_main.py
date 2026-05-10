# Fix Windows GBK encoding crash when spawned without terminal
import sys
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

"""
Device Main — Single process entry point for all device modules.
Runs audio_service + vision_service + core_server in one process.
vision and audio run as daemon threads; core_server runs in main thread.
Spawned by Rust host as one Python process.
"""

import queue
import threading
import time
import os


def run_audio_service(config_path):
    """Thread: audio capture + KWS + VAD"""
    try:
        from wakefusion.services.audio_service import main as audio_main
        sys.argv = ["audio_service"]
        if config_path:
            sys.argv += ["--config", config_path]
        audio_main()
    except Exception as e:
        print(f"[device_main] audio_service crashed: {e}", flush=True)
        import traceback
        traceback.print_exc()


def run_vision_service(vision_queue, lip_sync_event, config_path=None):
    """Python vision analysis worker.

    USB UVC preview/capture is owned by Rust/Tauri. In the normal flow this
    worker samples frames from Rust's MJPEG preview endpoint for analysis only;
    it must not open the physical USB camera unless explicitly overridden.
    """
    try:
        from wakefusion.services.vision_service import run_in_thread
        run_in_thread(
            output_queue=vision_queue,
            lip_sync_event=lip_sync_event,
            target_fps=int(os.environ.get("WAKEFUSION_VISION_ANALYSIS_FPS", "10")),
            camera_index=0,
            config_path=config_path,
        )
    except Exception as e:
        print(f"[device_main] vision_service crashed: {e}", flush=True)
        import traceback
        traceback.print_exc()


def run_core_server(config_path, vision_queue, lip_sync_event, hardware_status=None):
    """Main thread: ZMQ SUB (audio) + Queue (vision) + WS client to Rust host"""
    try:
        from wakefusion.services.core_server import CoreServer
        server = CoreServer(
            config_path=config_path,
            vision_queue=vision_queue,
            lip_sync_event=lip_sync_event,
        )
        if hardware_status is not None:
            server._hardware_status = hardware_status
        server.run()
    except Exception as e:
        print(f"[device_main] core_server crashed: {e}", flush=True)
        import traceback
        traceback.print_exc()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="WakeFusion Device (unified)")
    parser.add_argument("--config", type=str, default=None, help="Config file path")
    args = parser.parse_args()

    config_path = args.config
    print(f"[device_main] Starting unified device process (PID {os.getpid()})", flush=True)
    if config_path:
        print(f"[device_main] Config: {config_path}", flush=True)

    # ── 先初始化全局 config 单例 ────────────────────────────────────────
    # 必须在启动 vision_service / audio_service 任何线程之前。
    # 否则那些线程内部 get_config(None) 会拿到全默认 AppConfig（vision.camera.backend="orbbec"），
    # 即使我们在 yaml 里写了 backend=usb 也读不到。
    if config_path and os.path.exists(config_path):
        try:
            from wakefusion.config import get_config as _gc
            _cfg = _gc(config_path)
            _cam_b = getattr(getattr(_cfg.vision, "camera", None), "backend", "?")
            _cam_i = getattr(getattr(_cfg.vision, "camera", None), "usb_index", "?")
            print(f"[device_main] global config loaded · vision.camera={_cam_b}:{_cam_i}", flush=True)
        except Exception as _e:
            print(f"[device_main] global config init failed: {_e}", flush=True)

    # ── XVF3800 fixed-beam 配置（在 audio_service 抢占设备前先发 control transfer）──
    # 目的：把麦克风波束锁定到正前方 ±约 30° 范围，过滤侧面声源。
    # 失败不致命：自动 fallback 到自适应模式（默认行为，跟改造前等价）。
    try:
        import yaml as _yaml
        xvf_cfg = {}
        if config_path and os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as _f:
                _all = _yaml.safe_load(_f) or {}
            xvf_cfg = (_all.get("xvf3800") or {}).get("fixed_beam") or {}
        # **总是**调一次 configure_at_startup，让 enabled 状态显式同步到 XVF3800：
        # - enabled=true  → 发 lock 命令把 beam 锁到指定方向
        # - enabled=false → 发 restore 命令显式关闭 fixed-beam（清掉上次启动的残留）
        # 不调的话 XVF3800 firmware RAM 里上次启动的 fixed-beam 状态会留着，
        # 麦克风灵敏度被锁死，4 个 LED 灯永远只亮一个。
        from wakefusion.services.xvf3800_control import configure_at_startup
        configure_at_startup(
            enabled=bool(xvf_cfg.get("enabled", False)),
            azimuth_deg=float(xvf_cfg.get("azimuth_deg", 0.0)),
            elevation_deg=float(xvf_cfg.get("elevation_deg", 0.0)),
            gating=bool(xvf_cfg.get("gating", False)),
        )
    except Exception as _e:
        print(f"[device_main] XVF3800 fixed-beam configure failed (non-fatal): {_e}", flush=True)

    # Shared communication objects (vision <-> core_server)
    vision_queue = queue.Queue(maxsize=2)
    lip_sync_event = threading.Event()
    # 硬件就绪标记：audio/vision 线程崩溃时设为 False，core_server 读取后上报前端
    hardware_status = {"mic_ready": True, "camera_ready": True}

    # USB UVC capture/preview is Rust-owned. Python vision_service may run only
    # as an analysis sampler over Rust MJPEG, not as a physical camera owner.
    def vision_thread_wrapper(vq, lse):
        try:
            run_vision_service(vq, lse, config_path=config_path)
        finally:
            hardware_status["camera_ready"] = False
            print("[device_main] ⚠️ vision_service 线程退出，camera_ready=False", flush=True)

    # vision_thread 引用放在闭包外（watchdog 可重新指向新线程）
    vision_thread_ref = {"thread": None}

    def start_vision_thread():
        t = threading.Thread(
            target=vision_thread_wrapper,
            args=(vision_queue, lip_sync_event),
            name="vision_service",
            daemon=True,
        )
        t.start()
        vision_thread_ref["thread"] = t
        return t

    python_usb_vision_enabled = os.environ.get("WAKEFUSION_ENABLE_PYTHON_USB_VISION", "0") == "1"
    if python_usb_vision_enabled:
        start_vision_thread()
        print("[device_main] legacy vision_service thread started by explicit env override", flush=True)
        time.sleep(3)
        if not vision_thread_ref["thread"].is_alive():
            hardware_status["camera_ready"] = False
            print("[device_main] ⚠️ legacy vision_service 启动失败（线程已退出），camera_ready=False", flush=True)
    else:
        os.environ.setdefault("WAKEFUSION_VISION_SOURCE", "rust_mjpeg")
        os.environ.setdefault("WAKEFUSION_VISION_MJPEG_URL", "http://127.0.0.1:7892/preview.mjpg")
        start_vision_thread()
        print(
            "[device_main] Rust owns USB camera preview; Python vision_service samples Rust MJPEG for analysis",
            flush=True,
        )
        time.sleep(3)
        if not vision_thread_ref["thread"].is_alive():
            hardware_status["camera_ready"] = False
            print("[device_main] ⚠️ MJPEG analysis vision_service 启动失败（线程已退出），camera_ready=False", flush=True)
        else:
            hardware_status["camera_ready"] = True

    # ── Vision watchdog：监控热重启请求 ──
    # 当 core_server 收到 camera_select 时调 request_vision_restart()
    # → 这里检测到旧线程退出 → 用新 config 重新启动 vision_service。
    def vision_restart_watchdog():
        try:
            from wakefusion.services import vision_service as _vs
        except Exception as e:
            print(f"[device_main] vision_service import failed in watchdog: {e}", flush=True)
            return
        while True:
            time.sleep(1.0)
            if not python_usb_vision_enabled and os.environ.get("WAKEFUSION_VISION_SOURCE") != "rust_mjpeg":
                continue
            t = vision_thread_ref["thread"]
            # 仅在显式 request_restart 触发时重启（避免误把崩溃的线程也重启）
            if _vs.is_restart_requested() and t is not None and not t.is_alive():
                print("[device_main] vision restart watchdog: rebuilding thread with new config", flush=True)
                _vs.clear_restart()
                hardware_status["camera_ready"] = True
                try:
                    start_vision_thread()
                    print("[device_main] vision_service thread restarted", flush=True)
                except Exception as e:
                    print(f"[device_main] vision restart failed: {e}", flush=True)
                    hardware_status["camera_ready"] = False

    threading.Thread(target=vision_restart_watchdog, name="vision_watchdog", daemon=True).start()

    # ── Audio service with auto-retry ──────────────────────────────────
    AUDIO_RETRY_INTERVAL = 5  # 秒：audio 线程退出后多久重试

    def audio_thread_wrapper(cfg):
        try:
            run_audio_service(cfg)
        finally:
            hardware_status["mic_ready"] = False
            print("[device_main] ⚠️ audio_service 线程退出，mic_ready=False", flush=True)

    # 启动前 probe：检查目标 mic 设备（XVF3800）是否存在。不存在直接跳过 audio_service
    # 启动 — 避免 audio 反复 crash → reload ONNX 模型 (KWS/VAD/VoiceEmbedder) → 100% CPU
    # 把 vision 三个线程瞬间打断每隔 5-30s 一次，造成间歇性"卡顿"现象。
    audio_device_match = "XVF3800"
    try:
        import yaml as _yaml_probe
        if config_path and os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as _f:
                _cfg = _yaml_probe.safe_load(_f) or {}
            audio_device_match = (_cfg.get("audio") or {}).get("device_match", "XVF3800")
    except Exception:
        pass

    mic_available = False
    try:
        import sounddevice as _sd
        _devs = _sd.query_devices()
        for _d in _devs:
            if _d.get("max_input_channels", 0) > 0 and audio_device_match.lower() in str(_d.get("name", "")).lower():
                mic_available = True
                break
    except Exception as _e:
        print(f"[device_main] sounddevice probe failed (continue anyway): {_e}", flush=True)
        mic_available = True  # probe 失败时仍尝试启动 audio（保守）

    if not mic_available:
        print(
            f"[device_main] ⛔ 目标麦克风 '{audio_device_match}' 未找到，"
            "完全跳过 audio_service 启动 — 不再加载 KWS/VAD/VoiceEmbedder ONNX 模型 "
            "→ vision 享受全部 CPU。如要恢复请插入 mic 后重启 EXE。",
            flush=True,
        )
        hardware_status["mic_ready"] = False
        # 创建一个伪 audio_thread 引用（已死状态）让后面的 hardware_watchdog 不报错
        audio_thread = threading.Thread(target=lambda: None, name="audio_disabled", daemon=True)
        audio_thread.start()
    else:
        audio_thread = threading.Thread(
            target=audio_thread_wrapper,
            args=(config_path,),
            name="audio_service",
            daemon=True,
        )
        audio_thread.start()
        print("[device_main] audio_service thread started", flush=True)

        # Wait for audio ZMQ to bind
        time.sleep(2)

        # 检查 audio 是否存活（可能在初始化时崩溃了）
        if not audio_thread.is_alive():
            hardware_status["mic_ready"] = False
            print("[device_main] ⚠️ audio_service 启动失败（线程已退出），mic_ready=False", flush=True)

    # 后台监控线程：audio 线程退出后**指数退避**重试。
    # 关键：连续失败 3 次后永久放弃（直到 EXE 重启），避免没接 mic 的机器陷入
    # crash-loop 反复加载 ONNX 模型（KWS / VAD / VoiceEmbedder）→ 100% CPU →
    # vision 三个线程全部饿死从 18fps 雪崩到 1-4fps。
    # （vision 由上方 vision_restart_watchdog 单独管理，不在这里。）
    AUDIO_MAX_RESTART = 3      # 失败超过这个数就永久放弃
    AUDIO_BACKOFF_BASE = 8     # 指数退避基础秒数（8/16/32...）

    def hardware_watchdog():
        nonlocal audio_thread
        # mic probe 已确认无设备 → watchdog 直接永久放弃，永不重启
        if not mic_available:
            print("[device_main] hardware_watchdog: mic 不可用 → audio 永久禁用", flush=True)
            return
        failure_count = 0
        give_up_logged = False
        while True:
            # 指数退避：失败越多次等越久（5/8/16/32s，最长 5 分钟）
            wait = min(AUDIO_BACKOFF_BASE * (2 ** failure_count), 300) if failure_count > 0 else AUDIO_RETRY_INTERVAL
            time.sleep(wait)

            # 永久放弃后只看是否还在死循环空转
            if failure_count >= AUDIO_MAX_RESTART:
                if not give_up_logged:
                    print(
                        f"[device_main] ⛔ audio_service 已连续失败 {failure_count} 次，"
                        "永久放弃（直到 EXE 重启）。mic 不可用，vision/UI 仍正常工作。",
                        flush=True,
                    )
                    give_up_logged = True
                hardware_status["mic_ready"] = False
                time.sleep(300)  # 长睡，不再尝试
                continue

            # ── Audio watchdog ──
            if audio_thread.is_alive():
                # 健康跑着 — 不动（不重置 failure_count，避免被加载模型期间的"假活"骗）
                continue

            # 死了 → failure_count 立刻 +1（不再因短暂"活"复位）
            failure_count += 1
            print(
                f"[device_main] 🔄 audio_service 已退出，尝试重启 "
                f"(第 {failure_count}/{AUDIO_MAX_RESTART} 次)...",
                flush=True,
            )
            hardware_status["mic_ready"] = False
            audio_thread = threading.Thread(
                target=audio_thread_wrapper,
                args=(config_path,),
                name="audio_service",
                daemon=True,
            )
            audio_thread.start()

    watchdog_thread = threading.Thread(target=hardware_watchdog, name="hardware_watchdog", daemon=True)
    watchdog_thread.start()

    # Run core_server in main thread, passing vision queue, lip sync event, and hardware status
    print("[device_main] Starting core_server in main thread", flush=True)
    run_core_server(config_path, vision_queue, lip_sync_event, hardware_status)


if __name__ == "__main__":
    main()
