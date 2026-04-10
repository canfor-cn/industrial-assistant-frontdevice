"""
设备侧音频播放端到端测试

模拟 WakeFusion 设备连接后端 WS，发送文本 ASR，接收 TTS 音频并播放。
用途：验证 unified output pipeline 的 audio 路由是否正确。

用法:
  python wakefusion_wake_module/tests/test_device_audio_playback.py [--text "你好"] [--no-play]
"""
import asyncio
import argparse
import base64
import json
import sys
import time
import uuid
import numpy as np

try:
    import websockets
except ImportError:
    print("ERROR: pip install websockets")
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────────────────────────────
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 7788
DEVICE_ID = "test-device-01"
TOKEN = "test-voice-token"
WS_URL = f"ws://{BACKEND_HOST}:{BACKEND_PORT}/api/voice/ws?deviceId={DEVICE_ID}&token={TOKEN}"


async def run_test(text: str, play_audio: bool):
    print(f"[1] 连接后端 WS: {WS_URL}")
    try:
        ws = await asyncio.wait_for(websockets.connect(WS_URL), timeout=5)
    except Exception as e:
        print(f"    连接失败: {e}")
        return

    print(f"    已连接 (deviceId={DEVICE_ID})")

    # 发送设备状态
    await ws.send(json.dumps({"type": "device_state", "state": "idle", "deviceId": DEVICE_ID}))

    # 构造 ASR final 消息
    trace_id = f"test-{uuid.uuid4().hex[:8]}"
    asr_msg = {
        "type": "asr",
        "stage": "final",
        "text": text,
        "traceId": trace_id,
        "deviceId": DEVICE_ID,
        "timestamp": time.time(),
    }

    print(f"[2] 发送 ASR final: text=\"{text}\", traceId={trace_id}")
    await ws.send(json.dumps(asr_msg))

    # 收集响应
    audio_chunks = []
    audio_meta = {}
    tokens = []
    got_final = False
    got_audio_begin = False
    got_audio_end = False
    start_time = time.time()
    timeout = 90  # 最长等待 90 秒（TTS fallback 可能较慢）

    print(f"[3] 等待响应 (最长 {timeout}s)...")
    try:
        while time.time() - start_time < timeout:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                if got_final and got_audio_end:
                    break
                if got_final and not got_audio_begin:
                    # final 已到但没有 audio_begin，说明没有 TTS
                    break
                continue

            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "token":
                t = data.get("text", "")
                tokens.append(t)
                sys.stdout.write(t)
                sys.stdout.flush()

            elif msg_type == "audio_begin":
                got_audio_begin = True
                audio_meta = {
                    "codec": data.get("codec"),
                    "mimeType": data.get("mimeType"),
                    "sampleRate": data.get("sampleRate"),
                    "channels": data.get("channels"),
                }
                print(f"\n    audio_begin: {audio_meta}")

            elif msg_type == "audio_chunk":
                b64 = data.get("data", "")
                if b64:
                    chunk = base64.b64decode(b64)
                    audio_chunks.append(chunk)
                    seq = data.get("seq", "?")
                    print(f"    audio_chunk seq={seq}, {len(chunk)} bytes")

            elif msg_type == "audio_end":
                got_audio_end = True
                print(f"    audio_end")

            elif msg_type == "audio_error":
                print(f"    audio_error: {data.get('message')}")

            elif msg_type == "final":
                got_final = True
                print(f"\n    final: status={data.get('status')}, route={data.get('route')}")

            elif msg_type == "error":
                print(f"    error: {data.get('code')} - {data.get('message')}")

            elif msg_type == "meta":
                pass  # 静默

            elif msg_type == "route":
                print(f"    route: {data.get('route')}")

            elif msg_type == "timing":
                pass  # 静默

            elif msg_type == "pong":
                pass

            else:
                print(f"    [{msg_type}]: {json.dumps(data, ensure_ascii=False)[:120]}")

            if got_final and got_audio_end:
                break

    except websockets.exceptions.ConnectionClosed as e:
        print(f"    WS 连接关闭: {e}")
    finally:
        await ws.close()

    # ── 汇总 ──────────────────────────────────────────────────────────────────
    elapsed = time.time() - start_time
    total_text = "".join(tokens)
    total_audio_bytes = sum(len(c) for c in audio_chunks)

    print(f"\n{'='*60}")
    print(f"[结果]")
    print(f"  文本: {total_text[:200]}")
    print(f"  Token 数: {len(tokens)}")
    print(f"  Audio chunks: {len(audio_chunks)}, 总字节: {total_audio_bytes}")
    print(f"  audio_begin: {got_audio_begin}, audio_end: {got_audio_end}")
    print(f"  耗时: {elapsed:.1f}s")

    if not audio_chunks:
        print(f"  ⚠️  没有收到音频数据！")
        return

    # ── 播放音频 ──────────────────────────────────────────────────────────────
    if not play_audio:
        print(f"  (跳过播放，使用 --play 启用)")
        return

    try:
        import sounddevice as sd
    except ImportError:
        print(f"  ⚠️  sounddevice 未安装，无法播放 (pip install sounddevice)")
        return

    sample_rate = audio_meta.get("sampleRate", 24000)
    channels = audio_meta.get("channels", 1)
    codec = audio_meta.get("codec", "pcm_s16le")

    pcm_data = b"".join(audio_chunks)

    # WAV 格式: 跳过 44 字节头部提取 PCM
    if codec == "wav" or audio_meta.get("mimeType") == "audio/wav":
        # 每个 chunk 可能是独立的 WAV, 需要逐个解析
        import io
        import wave
        raw_samples = []
        for chunk_bytes in audio_chunks:
            try:
                with wave.open(io.BytesIO(chunk_bytes), "rb") as wf:
                    sample_rate = wf.getframerate()
                    channels = wf.getnchannels()
                    frames = wf.readframes(wf.getnframes())
                    raw_samples.append(frames)
            except Exception:
                # 可能是裸 PCM，直接追加
                raw_samples.append(chunk_bytes)
        pcm_data = b"".join(raw_samples)
    elif codec != "pcm_s16le":
        print(f"  [WARN] unknown codec: {codec}, trying as pcm_s16le")

    audio_array = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0

    if channels > 1:
        audio_array = audio_array.reshape(-1, channels)

    duration = len(audio_array) / sample_rate
    print(f"\n[4] playing: {sample_rate}Hz, {channels}ch, {duration:.2f}s")

    # 查找 XVF3800 输出设备
    output_device = None
    try:
        devices = sd.query_devices()
        for i, dev in enumerate(devices):
            name = str(dev.get("name", ""))
            if "xvf3800" in name.lower() and dev["max_output_channels"] > 0:
                output_device = i
                print(f"    found XVF3800 output: {name} (ID={i})")
                break
        if output_device is None:
            print(f"    XVF3800 not found, using default output device")
    except Exception:
        pass

    try:
        sd.play(audio_array, samplerate=sample_rate, device=output_device)
        sd.wait()
        print(f"    done")
    except Exception as e:
        print(f"    playback failed: {e}")


def main():
    parser = argparse.ArgumentParser(description="设备侧音频播放端到端测试")
    parser.add_argument("--text", default="你好，请简短介绍一下你自己", help="发送的文本")
    parser.add_argument("--play", action="store_true", default=False, help="播放收到的音频")
    parser.add_argument("--no-play", action="store_true", help="(已废弃，默认不播放)")
    args = parser.parse_args()

    asyncio.run(run_test(args.text, args.play))


if __name__ == "__main__":
    main()
