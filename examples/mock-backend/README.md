# Mock Backend

A minimal backend that lets you test the device + frontend without the real Qwen Realtime LLM backend.

## What it does

- WS server on `ws://0.0.0.0:7790/api/voice/ws`
- On connect: speaks a fake greeting (sine-wave PCM placeholder for TTS)
- On user audio: every ~5s replies with one of:
  - Plain TTS reply
  - Demo `media_duck` (lowers video volume)
  - Demo `media_ref` (pushes inline markdown to MD viewer)
- On `interrupt` / `barge_in`: sends `stop_tts`
- On `media_duck_request`: forwards `media_duck`

## What it does NOT do

- Real ASR (won't transcribe what you say)
- Real LLM (won't actually answer your questions)
- Real TTS (sine wave 440Hz instead of voice)
- Tool calls (search_exhibition / search_web / control_media — protocol exists, real handlers not implemented)
- Visitor recognition / long-term memory

## Run

```bash
npm install
npm start
```

Then edit your device's `config.yaml`:

```yaml
llm_agent:
  host: "127.0.0.1:7790"
  token: "test-voice-token"
```

Restart the EXE. You'll hear sine-wave TTS placeholders.

## Protocol reference

Full protocol spec: `../docs/backend-protocol.md`
