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
    """Windows DirectShow 列举（设备管理器同款名字）。
    pygrabber 没装就返回空 — 不再用 cv2 fallback，避免每次刷新都开 8 路 VideoCapture
    霸占真实摄像头、和 vision_service 抢资源。

    注意：DirectShow 是 COM 组件，调用线程必须先 CoInitialize。core_server 的 ws
    handler 线程里 Python 不会自动 init，所以这里显式调一次（已 init 过会返回 S_FALSE，
    无害）。multithreading 模式（COINIT_MULTITHREADED）适合后台线程。
    """
    try:
        from pygrabber.dshow_graph import FilterGraph
    except ImportError:
        print("[camera_enumerator] pygrabber 未安装，无法列举 DirectShow 设备名。"
              "请 `pip install pygrabber comtypes`。", flush=True)
        return []

    # 显式 CoInitialize，避免 "尚未调用 CoInitialize" (HRESULT 0x800401F0)
    try:
        from comtypes import CoInitializeEx, COINIT_MULTITHREADED
        try:
            CoInitializeEx(COINIT_MULTITHREADED)
        except OSError:
            # RPC_E_CHANGED_MODE: 同一线程之前已用其他模式 init 过 → 不致命
            pass
    except Exception:
        # 最后兜底：试 pythoncom（pywin32 自带）
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except Exception:
            pass

    try:
        graph = FilterGraph()
        devices = graph.get_input_devices()  # ["Integrated Camera", "EMEET ..."]
        return [
            {"index": i, "name": name, "backend": "usb"}
            for i, name in enumerate(devices)
        ]
    except Exception as e:
        print(f"[camera_enumerator] DirectShow enumerate failed: {e}", flush=True)
        return []


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
