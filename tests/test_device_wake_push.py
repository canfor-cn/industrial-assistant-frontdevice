"""
Device wake-up simulator — connects to the Tauri device WS server (port 8765)
and pushes audio to simulate hardware voice wake-up.

Usage:
    python wakefusion_wake_module/tests/test_device_wake_push.py [--audio output.wav] [--host 127.0.0.1] [--port 8765] [--repeat 1] [--interval 5]

The script sends a `subtitle_user` message with base64-encoded audio data.
The Rust gateway will generate an audioId, cache the audio, forward to backend
for ASR, and push results to the WebUI.
"""

import argparse
import base64
import json
import time
import sys
from pathlib import Path

try:
    import websocket
except ImportError:
    print("Missing dependency: pip install websocket-client")
    sys.exit(1)


def load_audio(audio_path: str) -> tuple[str, str]:
    """Load audio file and return (base64_data, mime_type)."""
    path = Path(audio_path)
    if not path.exists():
        print(f"Audio file not found: {audio_path}")
        sys.exit(1)

    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")

    suffix = path.suffix.lower()
    mime_map = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }
    mime = mime_map.get(suffix, "audio/wav")

    print(f"Loaded audio: {path.name} ({len(data)} bytes, {mime})")
    return b64, mime


def send_wake_audio(ws_url: str, audio_b64: str, audio_mime: str, index: int):
    """Connect to device WS and push audio as a wake-up event."""
    trace_id = f"device-wake-{int(time.time() * 1000)}-{index}"

    print(f"\n[{index}] Connecting to {ws_url} ...")
    ws = websocket.create_connection(ws_url, timeout=10)
    print(f"[{index}] Connected. Sending audio (traceId={trace_id}) ...")

    message = {
        "type": "subtitle_user",
        "traceId": trace_id,
        "text": "",
        "stage": "final",
        "audioData": audio_b64,
        "audioMime": audio_mime,
    }

    ws.send(json.dumps(message))
    print(f"[{index}] Audio sent. Waiting for response ...")

    # Wait a bit for any response (the device WS server doesn't send responses
    # back to the device, but we keep the connection open briefly)
    try:
        ws.settimeout(3)
        while True:
            try:
                resp = ws.recv()
                print(f"[{index}] Response: {resp[:200]}")
            except websocket.WebSocketTimeoutException:
                break
    except Exception:
        pass

    ws.close()
    print(f"[{index}] Done.")


def main():
    parser = argparse.ArgumentParser(description="Device wake-up audio push simulator")
    parser.add_argument("--audio", default="output.wav", help="Path to audio file (default: output.wav)")
    parser.add_argument("--host", default="127.0.0.1", help="Device WS server host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Device WS server port (default: 8765)")
    parser.add_argument("--repeat", type=int, default=1, help="Number of times to push audio (default: 1)")
    parser.add_argument("--interval", type=float, default=5.0, help="Seconds between pushes (default: 5)")
    args = parser.parse_args()

    # Resolve audio path relative to project root
    audio_path = Path(args.audio)
    if not audio_path.is_absolute():
        project_root = Path(__file__).resolve().parent.parent.parent
        audio_path = project_root / args.audio

    audio_b64, audio_mime = load_audio(str(audio_path))
    ws_url = f"ws://{args.host}:{args.port}"

    for i in range(1, args.repeat + 1):
        send_wake_audio(ws_url, audio_b64, audio_mime, i)
        if i < args.repeat:
            print(f"\nWaiting {args.interval}s before next push ...")
            time.sleep(args.interval)

    print("\nAll done.")


if __name__ == "__main__":
    main()
