"""
CoreServer 端到端音频测试

启动 CoreServer 的 WS 连接 + 音频播放线程，
发送一条文本 ASR final 给后端，验证 TTS 音频能否通过 XVF3800 播放。

用法:
  cd wakefusion_wake_module
  python -m tests.test_core_audio_e2e [--text "你好"]
"""
import argparse
import json
import sys
import time
import uuid
import os

# 确保项目根目录在 path 中
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wakefusion.config import get_config


def main():
    parser = argparse.ArgumentParser(description="CoreServer 端到端音频测试")
    parser.add_argument("--text", default="你好", help="发送的文本")
    parser.add_argument("--config", default=None, help="配置文件路径")
    args = parser.parse_args()

    # 找配置文件
    config_path = args.config
    if not config_path:
        for p in ["config/config.yaml", "../config/config.yaml", "wakefusion_wake_module/config/config.yaml"]:
            if os.path.exists(p):
                config_path = p
                break

    if not config_path:
        print("ERROR: config.yaml not found")
        sys.exit(1)

    print(f"[1] Loading config: {config_path}")
    from wakefusion.services.core_server import CoreServer
    server = CoreServer(config_path)

    # 等待 WS 连接建立
    print(f"[2] Waiting for WS connection to backend...")
    for i in range(15):
        if server._ws_connected:
            print(f"    Connected! (deviceId={server.llm_agent_config.device_id})")
            break
        time.sleep(1)
    else:
        print("    ERROR: WS connection timeout (15s)")
        sys.exit(1)

    # 再等一小会确保稳定
    time.sleep(0.5)

    # 发送 ASR final 文本
    trace_id = f"e2e-{uuid.uuid4().hex[:8]}"
    asr_msg = {
        "type": "asr",
        "stage": "final",
        "text": args.text,
        "traceId": trace_id,
        "deviceId": server.llm_agent_config.device_id,
        "timestamp": time.time(),
    }

    print(f"[3] Sending ASR final: text=\"{args.text}\", traceId={trace_id}")
    server._send_websocket_message(asr_msg)

    # 等待播放完成
    print(f"[4] Waiting for audio playback (watch for audio_begin/chunk/end in backend logs)...")
    print(f"    Press Ctrl+C to stop\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[5] Stopped.")


if __name__ == "__main__":
    main()
