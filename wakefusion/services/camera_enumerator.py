"""
Camera enumeration — 列举系统当前可用的摄像头给前端配置面板选择。

Windows: 用 pygrabber.dshow_graph.FilterGraph 拿 DirectShow 设备名（即设备管理器
里看到的那些名字，如 "EMEET SmartCam C60E 4K Dual"）。
Linux: 列 /dev/video* + 读 sysfs name。
Orbbec: 用 pyorbbecsdk 单独列出，不混入 USB 列表（backend 不一样）。

返回结构：
[
  { "index": 0, "name": "Integrated Camera", "backend": "usb" },
  { "index": 1, "name": "EMEET SmartCam C60E 4K Dual", "backend": "usb" },
  { "index": 0, "name": "Orbbec Gemini 335", "backend": "orbbec" },  # orbbec 单独
]

调用方按 backend 分组渲染。索引在 backend 内部唯一（usb_index / orbbec_index）。
"""

import os
import sys
import platform
from typing import List, Dict, Any


def list_usb_cameras() -> List[Dict[str, Any]]:
    """列举系统所有 UVC USB 摄像头。Windows 走 DirectShow，Linux 走 /dev/video*。"""
    if platform.system() == "Windows":
        return _list_usb_cameras_windows()
    elif platform.system() == "Linux":
        return _list_usb_cameras_linux()
    else:
        return []


def _list_usb_cameras_windows() -> List[Dict[str, Any]]:
    """Windows DirectShow 列举（设备管理器同款名字）。"""
    try:
        from pygrabber.dshow_graph import FilterGraph
        graph = FilterGraph()
        devices = graph.get_input_devices()  # ["Integrated Camera", "EMEET ..."]
        return [
            {"index": i, "name": name, "backend": "usb"}
            for i, name in enumerate(devices)
        ]
    except ImportError:
        # pygrabber 没装：fallback 用 cv2 探测前 8 个 index 是否能打开
        return _list_usb_cameras_cv2_probe()
    except Exception as e:
        print(f"[camera_enumerator] DirectShow enumerate failed: {e}", flush=True)
        return _list_usb_cameras_cv2_probe()


def _list_usb_cameras_cv2_probe() -> List[Dict[str, Any]]:
    """Fallback：尝试打开 0~7 看哪些能打开。拿不到名字，用 'USB Camera N' 占位。"""
    try:
        import cv2
    except ImportError:
        return []

    found: List[Dict[str, Any]] = []
    for idx in range(8):
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_ANY)
        if cap.isOpened():
            found.append({"index": idx, "name": f"USB Camera {idx}", "backend": "usb"})
            cap.release()
    return found


def _list_usb_cameras_linux() -> List[Dict[str, Any]]:
    """Linux: 列 /dev/video* + 读 /sys/class/video4linux/videoN/name。"""
    found: List[Dict[str, Any]] = []
    try:
        v4l_dir = "/sys/class/video4linux"
        if not os.path.isdir(v4l_dir):
            return []
        for entry in sorted(os.listdir(v4l_dir)):
            if not entry.startswith("video"):
                continue
            try:
                idx = int(entry[5:])
            except ValueError:
                continue
            name_path = os.path.join(v4l_dir, entry, "name")
            name = entry
            if os.path.exists(name_path):
                try:
                    with open(name_path, "r", encoding="utf-8") as f:
                        name = f.read().strip() or entry
                except Exception:
                    pass
            found.append({"index": idx, "name": name, "backend": "usb"})
    except Exception as e:
        print(f"[camera_enumerator] Linux enumerate failed: {e}", flush=True)
    return found


def list_orbbec_cameras() -> List[Dict[str, Any]]:
    """列举系统接的 Orbbec 设备（pyorbbecsdk）。无设备 / SDK 缺失返回空。"""
    try:
        import pyorbbecsdk as ob
    except ImportError:
        return []
    except Exception:
        return []

    out: List[Dict[str, Any]] = []
    try:
        ctx = ob.Context()
        device_list = ctx.query_devices()
        count = device_list.get_count() if hasattr(device_list, "get_count") else len(device_list)
        for i in range(count):
            try:
                dev = device_list[i] if hasattr(device_list, "__getitem__") else device_list.get_device(i)
                info = dev.get_device_info()
                name = info.get_name() if hasattr(info, "get_name") else f"Orbbec {i}"
                out.append({"index": i, "name": name, "backend": "orbbec"})
            except Exception as e:
                print(f"[camera_enumerator] Orbbec device {i} read failed: {e}", flush=True)
    except Exception as e:
        print(f"[camera_enumerator] Orbbec query failed: {e}", flush=True)
    return out


def list_all_cameras() -> List[Dict[str, Any]]:
    """聚合所有 backend 的摄像头。前端可分组显示或扁平展开。"""
    out: List[Dict[str, Any]] = []
    out.extend(list_usb_cameras())
    out.extend(list_orbbec_cameras())
    return out


if __name__ == "__main__":
    import json
    print(json.dumps(list_all_cameras(), ensure_ascii=False, indent=2))
