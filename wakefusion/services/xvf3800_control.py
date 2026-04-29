"""
XVF3800 USB control —— 把 reSpeaker 4-mic 阵列的 DSP 锁定到固定波束模式。

**为什么要这个**：XVF3800 默认是自适应波束（adaptive beam），DSP 自动追踪最强声源。
展厅场景下，侧面有人说话也会被追到，导致误唤醒/串扰。

**这个模块做什么**：通过 USB Vendor Control Transfer 给 XVF3800 firmware 发命令，
切换到 **fixed-beam 模式**，把两路 focused beam 都锁定到正前方（azimuth=0, elevation=0）。
之后 DSP 只增益正前方约 60° 锥角的语音，其他方向自然衰减。

**协议来源**：reSpeaker 官方 python_control / xvf_host.py
  https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY

**已知坑（Windows）**：默认 USB Audio Class 驱动**不允许** vendor control transfer。
如果 ctrl_transfer 报 [Errno 13] Access denied，需要装 Zadig 把 reSpeaker 的
"Control" interface（不是 Audio interface）替换为 WinUSB 驱动。Audio 不动。

模块设计成"调用失败不致命"——audio_service 仍能用自适应波束工作。
"""

from __future__ import annotations

import logging
import struct
import time
from typing import Optional

logger = logging.getLogger(__name__)

# ── reSpeaker XVF3800 USB Vendor / Product ID ─────────────────────────
XVF3800_VID = 0x2886
XVF3800_PID = 0x001A

# ── Control Resource / Command IDs（来自 reSpeaker xvf_host.py） ────────
RESID_AEC = 33

CMD_FIXEDBEAMS_ON_OFF       = 37   # int32, 0=adaptive, 1=fixed
CMD_FIXEDBEAMS_AZIMUTH      = 81   # 2 × float radians (beam0, beam1)
CMD_FIXEDBEAMS_ELEVATION    = 82   # 2 × float radians
CMD_FIXEDBEAMS_GATING       = 83   # uint8, 0=off, 1=on
CMD_AEC_AZIMUTH_VALUES      = 75   # ro, 4 × float radians

CTRL_TIMEOUT_MS = 100_000


def _import_usb():
    """延迟 import pyusb：保证此模块在没装 pyusb 的环境里也能 import。"""
    try:
        import usb.core
        import usb.util
        return usb.core, usb.util
    except ImportError as exc:
        raise RuntimeError(
            "pyusb not installed. Install via `pip install pyusb`."
        ) from exc


def _find_xvf3800():
    """
    查找 reSpeaker XVF3800 USB 设备。
    优先用 libusb-package（pip 包自带 libusb-1.0.dll，Windows 上免装系统 dll）；
    fallback 到 pyusb 默认 backend（需要系统 PATH 里有 libusb-1.0.dll）。
    """
    usb_core, _ = _import_usb()

    # 优先：libusb-package 自带 backend，Windows 零配置可用
    try:
        import libusb_package
        dev = libusb_package.find(idVendor=XVF3800_VID, idProduct=XVF3800_PID)
        if dev is not None:
            return dev
    except ImportError:
        pass

    # Fallback：pyusb 默认 backend（要求系统能找到 libusb-1.0.dll）
    try:
        dev = usb_core.find(idVendor=XVF3800_VID, idProduct=XVF3800_PID)
    except (usb_core.NoBackendError if hasattr(usb_core, "NoBackendError") else ValueError) as exc:
        raise RuntimeError(
            "USB backend not found. Install via `pip install libusb-package` "
            f"(or place libusb-1.0.dll in PATH). Inner error: {exc}"
        ) from exc

    if dev is None:
        raise RuntimeError(
            f"XVF3800 USB device not found (VID=0x{XVF3800_VID:04x}, PID=0x{XVF3800_PID:04x})"
        )
    return dev


def _ctrl_write(dev, resid: int, cmdid: int, payload: bytes) -> None:
    _, usb_util = _import_usb()
    bm_request_type = (
        usb_util.CTRL_OUT | usb_util.CTRL_TYPE_VENDOR | usb_util.CTRL_RECIPIENT_DEVICE
    )
    dev.ctrl_transfer(bm_request_type, 0, cmdid, resid, payload, CTRL_TIMEOUT_MS)


def _ctrl_read(dev, resid: int, cmdid: int, length_floats: int) -> bytes:
    """读取 length_floats × 4 字节（+ 1 字节 status）。"""
    _, usb_util = _import_usb()
    bm_request_type = (
        usb_util.CTRL_IN | usb_util.CTRL_TYPE_VENDOR | usb_util.CTRL_RECIPIENT_DEVICE
    )
    # bit 7 of cmdid = read flag
    wvalue = 0x80 | cmdid
    raw = bytes(dev.ctrl_transfer(
        bm_request_type, 0, wvalue, resid, length_floats * 4 + 1, CTRL_TIMEOUT_MS,
    ))
    # 第 0 字节是 status，rest 是 payload
    if len(raw) < 1:
        return b""
    return bytes(raw[1:])


# ── 高层 API ──────────────────────────────────────────────────────────

def lock_to_front_beam(
    azimuth_rad: float = 0.0,
    elevation_rad: float = 0.0,
    gating: bool = False,
) -> None:
    """
    把 XVF3800 切到 fixed-beam，两路 beam 都锁定到指定方向。

    Args:
        azimuth_rad:   水平方位角，0=正前方（弧度）。±π/2 = ±90° 侧面。
        elevation_rad: 仰角，0=水平面（弧度）。
        gating:        True=只在能量强的 beam 上出声，弱的静音；False=两路都给 mixer。
                       展厅锁定单方向时建议 False（两 beam 重合在前方，反正都是同一方向）。
    """
    dev = _find_xvf3800()

    # 1) 切到 fixed-beam 模式
    _ctrl_write(dev, RESID_AEC, CMD_FIXEDBEAMS_ON_OFF, struct.pack("<i", 1))
    time.sleep(0.05)

    # 2) 两路 fixed beam 都指向同一方位（azimuth_rad）
    _ctrl_write(
        dev, RESID_AEC, CMD_FIXEDBEAMS_AZIMUTH,
        struct.pack("<ff", azimuth_rad, azimuth_rad),
    )
    time.sleep(0.05)

    # 3) Elevation 同方向
    _ctrl_write(
        dev, RESID_AEC, CMD_FIXEDBEAMS_ELEVATION,
        struct.pack("<ff", elevation_rad, elevation_rad),
    )
    time.sleep(0.05)

    # 4) Gating
    _ctrl_write(
        dev, RESID_AEC, CMD_FIXEDBEAMS_GATING,
        bytes([1 if gating else 0]),
    )
    time.sleep(0.05)

    msg = (
        f"✅ XVF3800 fixed-beam locked: azimuth={azimuth_rad:.3f} rad "
        f"({_rad2deg(azimuth_rad):.1f}°), elevation={elevation_rad:.3f} rad "
        f"({_rad2deg(elevation_rad):.1f}°), gating={gating}"
    )
    # 同时 print 和 logger.info：device_main 早期阶段 root logger 还没配 INFO 级别，
    # print 保证启动期一定能在 stdout / device.log 里看到。
    print(f"[xvf3800] {msg}", flush=True)
    logger.info(msg)


def restore_adaptive_beam() -> None:
    """关闭 fixed-beam，恢复自适应波束。"""
    dev = _find_xvf3800()
    _ctrl_write(dev, RESID_AEC, CMD_FIXEDBEAMS_ON_OFF, struct.pack("<i", 0))
    msg = "✅ XVF3800 reverted to adaptive beam (4 LEDs should now track sound source)"
    print(f"[xvf3800] {msg}", flush=True)
    logger.info(msg)


def read_current_azimuths_deg() -> Optional[list[float]]:
    """读取当前 4 个 beam 的实际方位角（°）。
    异常会被抛出 —— 让调用方决定 log 级别（polling 线程会做限频，避免刷屏）。
    """
    dev = _find_xvf3800()
    raw = _ctrl_read(dev, RESID_AEC, CMD_AEC_AZIMUTH_VALUES, 4)
    if len(raw) < 16:
        return None
    rads = list(struct.unpack("<ffff", raw[:16]))
    return [_rad2deg(r) for r in rads]


def _rad2deg(r: float) -> float:
    import math
    return r * 180.0 / math.pi


# ── 启动期一次性配置（device_main 启动时调用） ─────────────────────────

def configure_at_startup(
    enabled: bool = True,
    azimuth_deg: float = 0.0,
    elevation_deg: float = 0.0,
    gating: bool = False,
) -> bool:
    """
    设备启动时调用一次。失败不抛异常，只 warn。
    返回 True 表示成功配置，False 表示失败（自动回退到自适应模式）。
    """
    if not enabled:
        # 关键：上次启动如果开了 fixed-beam，写入 XVF3800 RAM 后会**残留**（USB 设备没断电）。
        # config 改成 disable 后必须主动发 restore 命令把状态改回 adaptive，否则
        # XVF3800 仍然锁着上一次的 beam 角度，麦克风灵敏度被衰减、4 个 LED 灯锁死。
        try:
            restore_adaptive_beam()
            print("[xvf3800] fixed-beam disabled by config → restored to adaptive beam", flush=True)
        except Exception as exc:
            print(f"[xvf3800] restore_adaptive_beam failed (non-fatal, 物理插拔 USB 也可恢复): {exc}", flush=True)
        return False

    import math
    az_rad = azimuth_deg * math.pi / 180.0
    el_rad = elevation_deg * math.pi / 180.0

    try:
        lock_to_front_beam(az_rad, el_rad, gating)
        return True
    except Exception as exc:
        msg = (
            f"❌ XVF3800 fixed-beam configure failed: {exc}. "
            "Continuing with adaptive beam (default). "
            "Windows 用户可能需要 Zadig 把 reSpeaker Control interface 替换为 WinUSB 驱动。"
        )
        print(f"[xvf3800] {msg}", flush=True)
        logger.warning(msg)
        return False


# ── 后台 DOA 轮询（软件门控用） ─────────────────────────────────────

import threading as _threading

_doa_state_lock = _threading.Lock()
_latest_doa_deg: Optional[float] = None      # 最新声源 DOA（free-running beam，deg）
_latest_doa_ts: float = 0.0
_polling_thread: Optional[_threading.Thread] = None
_polling_stop = _threading.Event()


def get_latest_source_doa_deg(stale_ms: int = 500) -> Optional[float]:
    """
    返回最近一次 free-running beam 的方位角（deg），即声源真实方向。
    如果数据超过 stale_ms 没更新，返回 None（表示状态未知）。
    fixed beam 模式下 free-running beam 仍在跟踪声源，正好用作 DOA 门控判据。
    """
    with _doa_state_lock:
        if _latest_doa_deg is None:
            return None
        if (time.time() - _latest_doa_ts) * 1000.0 > stale_ms:
            return None
        return _latest_doa_deg


def _polling_loop(period_ms: int) -> None:
    global _latest_doa_deg, _latest_doa_ts
    period_s = period_ms / 1000.0
    fail_count = 0
    GIVE_UP_AFTER = 30  # 连续 30 次（~1.5 秒）失败就放弃，避免刷日志 + 浪费 CPU
    while not _polling_stop.is_set():
        try:
            azs = read_current_azimuths_deg()
            if azs and len(azs) >= 3:
                # AEC_AZIMUTH_VALUES: [focused0, focused1, free_running, auto_select]
                # free_running beam (index 2) 始终跟随最强声源，最适合做 DOA 门控
                source_deg = float(azs[2])
                with _doa_state_lock:
                    _latest_doa_deg = source_deg
                    _latest_doa_ts = time.time()
                fail_count = 0
            else:
                fail_count += 1
        except Exception as exc:
            fail_count += 1
            if fail_count == 1:
                logger.warning(
                    "XVF3800 DOA poll failed: %s. Will retry %d more times before giving up.",
                    exc, GIVE_UP_AFTER - 1,
                )
            if fail_count >= GIVE_UP_AFTER:
                logger.warning(
                    "XVF3800 DOA poll giving up after %d failures. "
                    "DOA software gating will be effectively disabled. "
                    "Common cause: pyusb 'No backend available' (Windows 缺 libusb-1.0.dll，"
                    "推荐 `pip install libusb-package`) 或 USB Audio Class 驱动不允许 vendor "
                    "control transfer（用 Zadig 替换 reSpeaker Control interface 为 WinUSB）。",
                    fail_count,
                )
                return
        _polling_stop.wait(period_s)


def start_doa_polling(period_ms: int = 50) -> None:
    """启动后台 DOA 轮询线程（默认 20Hz）。重复调用幂等。"""
    global _polling_thread
    if _polling_thread is not None and _polling_thread.is_alive():
        return
    _polling_stop.clear()
    _polling_thread = _threading.Thread(
        target=_polling_loop, args=(period_ms,),
        name="xvf3800-doa-poll", daemon=True,
    )
    _polling_thread.start()
    logger.info("XVF3800 DOA polling started (%dHz)", 1000 // max(1, period_ms))


def stop_doa_polling() -> None:
    _polling_stop.set()


if __name__ == "__main__":
    # 命令行调试：python -m wakefusion.services.xvf3800_control
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print("Configuring XVF3800 fixed-beam to azimuth=0° (front)…")
    ok = configure_at_startup(enabled=True, azimuth_deg=0.0, elevation_deg=0.0, gating=False)
    if ok:
        print("Done. Reading back current azimuth values…")
        time.sleep(0.5)
        azs = read_current_azimuths_deg()
        if azs is not None:
            print("Current beam azimuths (deg):", [f"{a:.1f}" for a in azs])
        print("Starting 5s DOA polling demo…")
        start_doa_polling(period_ms=100)
        for _ in range(50):
            time.sleep(0.1)
            d = get_latest_source_doa_deg()
            if d is not None:
                print(f"  source DOA = {d:+.1f}°")
        stop_doa_polling()
