# Backend Protocol — Voice WebSocket

Tauri host (Rust) connects to backend over WebSocket. This doc is the contract between the device/frontend repo (this one) and any backend implementation (real Qwen Realtime, mock backend, your own LLM, etc.).

## Connection

```
ws://<backend-host>:<port>/api/voice/ws?deviceId=<id>&token=<shared-token>
```

| Param | Required | Purpose |
|---|---|---|
| `deviceId` | yes | Stable device identifier (e.g. `wakefusion-device-01`) |
| `token` | yes | Shared secret for basic auth |

The mock backend in `examples/mock-backend/` accepts `token=test-voice-token` by default.

## Message format

Every message is a JSON text frame with a `type` field. There is no binary frame protocol on this WS.

---

## Device → Backend

### `device_state`
Periodic heartbeat about the device's hardware/state.
```json
{
  "type": "device_state",
  "deviceId": "...",
  "state": "idle | listening | thinking | speaking",
  "hardware": { "mic_ready": true, "camera_ready": true },
  "vision": { "faces": 1, "distance_m": 1.05, "is_talking": false }
}
```

### `greeting`
Triggered when a visitor walks into camera range (visual wake) or KWS fires.
```json
{ "type": "greeting", "deviceId": "...", "traceId": "..." }
```
Backend should respond with a TTS audio stream (e.g. "Hello, I'm Xiaohui").

### `audio_stream_start` (phone-call mode begin)
```json
{
  "type": "audio_stream_start",
  "traceId": "uuid",
  "deviceId": "...",
  "mimeType": "audio/pcm",
  "codec": "pcm_s16le",
  "sampleRate": 16000,
  "channels": 1
}
```

### `audio_stream_chunk` (continuous PCM upstream)
~200 ms per chunk. Backend should feed these to Qwen Realtime / its own ASR.
```json
{
  "type": "audio_stream_chunk",
  "traceId": "...",
  "deviceId": "...",
  "data": "<base64 PCM s16le>",
  "seq": 42
}
```

### `audio_stream_stop` (phone-call mode end)
```json
{ "type": "audio_stream_stop", "traceId": "...", "deviceId": "...", "reason": "user_left" }
```

### `interrupt` / `barge_in`
User wants to interrupt current TTS playback.
```json
{ "type": "barge_in", "traceId": "...", "deviceId": "...", "reason": "user_speech" }
```

### `media_duck_request`
Device-side Silero VAD detected user speech → request backend to duck media volume.
```json
{ "type": "media_duck_request", "traceId": "...", "deviceId": "...", "reason": "user_speech_detected" }
```

### `face_embedding` / `voice_embedding`
Long-term visitor recognition (optional). 512-dim face / 256-dim voice vectors.
```json
{ "type": "face_embedding", "deviceId": "...", "embedding": [0.012, -0.034, ...] }
```

### `timeout_exit`
Visitor left or stayed silent past timeout.
```json
{ "type": "timeout_exit", "deviceId": "...", "reason": "face_lost | silence" }
```

### Frontend (UI) → Backend (camera config)

Frontend can request camera management via the device's WS too:

```json
{ "type": "camera_list_request" }
{ "type": "camera_select", "backend": "usb", "index": 1, "name": "EMEET ..." }
{ "type": "camera_preview_start" }
{ "type": "camera_preview_stop" }
```

---

## Backend → Device

### `audio_begin` (TTS start)
```json
{
  "type": "audio_begin",
  "traceId": "rt-uuid",
  "deviceId": "...",
  "playbackId": "...",
  "codec": "pcm_s16",        // 24kHz, 16-bit, little-endian
  "mimeType": "audio/pcm",
  "sampleRate": 24000,
  "channels": 1
}
```

### `audio_chunk` (TTS PCM stream)
```json
{
  "type": "audio_chunk",
  "traceId": "...",
  "deviceId": "...",
  "seq": 1,
  "codec": "pcm_s16",
  "sampleRate": 24000,
  "channels": 1,
  "data": "<base64 PCM s16le>"
}
```

### `audio_end` (TTS done)
```json
{ "type": "audio_end", "traceId": "...", "deviceId": "...", "playbackId": "..." }
```

### `stop_tts` (kill current playback)
Sent on user barge-in or tool call (to silence pre-tool-call leak).
```json
{ "type": "stop_tts", "traceId": "...", "deviceId": "...", "reason": "user_speech_started | interrupt | tool_call_silence" }
```

### `subtitle_user` (ASR transcript for UI)
```json
{ "type": "subtitle_user", "traceId": "...", "deviceId": "...", "text": "...", "stage": "partial | final" }
```

### `subtitle_ai_stream` (TTS transcript delta for UI)
```json
{ "type": "subtitle_ai_stream", "traceId": "...", "deviceId": "...", "text": "<delta>" }
```

### `subtitle_ai_commit` (TTS transcript done)
```json
{ "type": "subtitle_ai_commit", "traceId": "...", "deviceId": "..." }
```

### `media_ref` (display a media on stage)
Push a video/audio/image/wiki for the on-stage media player.
```json
{
  "type": "media_ref",
  "traceId": "...",
  "deviceId": "...",
  "assetId": "...",
  "assetType": "video | audio | image | wiki | document",
  "url": "https://...",
  "label": "Display name shown in UI",
  "inlineBody": "<markdown>"   // optional, only for assetType=wiki/document
}
```

### `media_control` (control on-stage media)
```json
{
  "type": "media_control",
  "deviceId": "...",
  "traceId": "...",
  "action": "stop | replay_last | enter_fullscreen | exit_fullscreen"
}
```

### `media_duck` (lower / restore on-stage media volume)
```json
{
  "type": "media_duck",
  "deviceId": "...",
  "action": "duck | restore",
  "level": 0.2,          // 0..1; for duck only
  "reason": "user_speech | tts_speaking"
}
```

### `error`
```json
{
  "type": "error",
  "traceId": "...",
  "code": "request_cancelled | invalid_request | ...",
  "message": "..."
}
```

### Camera management (replies to camera_list_request etc.)
```json
{
  "type": "camera_list",
  "cameras": [
    { "index": 0, "name": "Integrated Camera", "backend": "usb" },
    { "index": 1, "name": "EMEET SmartCam C60E", "backend": "usb" }
  ],
  "active": { "backend": "usb", "usb_index": 1 }
}
{
  "type": "camera_preview",
  "jpeg": "<base64 JPEG, 640px@10fps>",
  "width": 640, "height": 360,
  "faces": [{ "x": 0.3, "y": 0.2, "w": 0.15, "h": 0.25, "distance_m": 1.07, "frontal_percent": 65 }],
  "distance_m": 1.07,
  "is_talking": false
}
{ "type": "camera_selected", "backend": "usb", "index": 1, "name": "EMEET ..." }
```

---

## Tool calling (real backend only)

The real backend uses Qwen Realtime's function calling. The tool definitions are private (kept on backend), but here are the **tool names** that frontend code knows about (because tool result JSON shows up in `media_ref` / `media_control`):

| Tool | Purpose |
|---|---|
| `search_exhibition` | Lookup exhibition wiki / video by query |
| `search_web` | Web search (real-time info) |
| `control_media` | Stop / duck / replay media on stage |

Mock backend does NOT implement these. To test tool flows you need a real LLM backend.

---

## TLS / production

Production should use `wss://` (TLS). The Rust host's `useSsl` config flag controls this.

## Versioning

This protocol is currently un-versioned and may have breaking changes. Future versions will add a `protocolVersion` field to the connect handshake.
