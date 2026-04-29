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


def run_vision_service(vision_queue, lip_sync_event):
    """Thread: camera + face detection (OpenCV VideoCapture, no pyorbbecsdk)"""
    try:
        from wakefusion.services.vision_service import run_in_thread
        run_in_thread(
            output_queue=vision_queue,
            lip_sync_event=lip_sync_event,
            target_fps=15,
            camera_index=0,
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

    # Start vision_service as daemon THREAD (no longer subprocess)
    def vision_thread_wrapper(vq, lse):
        try:
            run_vision_service(vq, lse)
        finally:
            hardware_status["camera_ready"] = False
            print("[device_main] ⚠️ vision_service 线程退出，camera_ready=False", flush=True)

    vision_thread = threading.Thread(
        target=vision_thread_wrapper,
        args=(vision_queue, lip_sync_event),
        name="vision_service",
        daemon=True,
    )
    vision_thread.start()
    print("[device_main] vision_service thread started", flush=True)

    # Wait for camera init
    time.sleep(3)

    if not vision_thread.is_alive():
        hardware_status["camera_ready"] = False
        print("[device_main] ⚠️ vision_service 启动失败（线程已退出），camera_ready=False", flush=True)

    # ── Audio service with auto-retry ──────────────────────────────────
    AUDIO_RETRY_INTERVAL = 5  # 秒：audio 线程退出后多久重试

    def audio_thread_wrapper(cfg):
        try:
            run_audio_service(cfg)
        finally:
            hardware_status["mic_ready"] = False
            print("[device_main] ⚠️ audio_service 线程退出，mic_ready=False", flush=True)

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

    # 后台监控线程：audio/vision 线程退出后定期重试，实现"热插拔"
    def hardware_watchdog():
        nonlocal audio_thread, vision_thread
        while True:
            time.sleep(AUDIO_RETRY_INTERVAL)

            # ── Audio watchdog ──
            if not audio_thread.is_alive():
                print(f"[device_main] 🔄 audio_service 已退出，尝试重启...", flush=True)
                hardware_status["mic_ready"] = False
                audio_thread = threading.Thread(
                    target=audio_thread_wrapper,
                    args=(config_path,),
                    name="audio_service",
                    daemon=True,
                )
                audio_thread.start()
                time.sleep(3)
                if audio_thread.is_alive():
                    hardware_status["mic_ready"] = True
                    print("[device_main] ✅ audio_service 热重载成功，mic_ready=True", flush=True)
                else:
                    print("[device_main] ❌ audio_service 重启失败，下次继续尝试...", flush=True)

            # ── Vision watchdog ──
            if not vision_thread.is_alive():
                print(f"[device_main] 🔄 vision_service 已退出，尝试重启...", flush=True)
                hardware_status["camera_ready"] = False
                vision_thread = threading.Thread(
                    target=vision_thread_wrapper,
                    args=(vision_queue, lip_sync_event),
                    name="vision_service",
                    daemon=True,
                )
                vision_thread.start()
                time.sleep(3)
                if vision_thread.is_alive():
                    hardware_status["camera_ready"] = True
                    print("[device_main] ✅ vision_service 热重载成功，camera_ready=True", flush=True)
                else:
                    print("[device_main] ❌ vision_service 重启失败，下次继续尝试...", flush=True)

    watchdog_thread = threading.Thread(target=hardware_watchdog, name="hardware_watchdog", daemon=True)
    watchdog_thread.start()

    # Run core_server in main thread, passing vision queue, lip sync event, and hardware status
    print("[device_main] Starting core_server in main thread", flush=True)
    run_core_server(config_path, vision_queue, lip_sync_event, hardware_status)


if __name__ == "__main__":
    main()
