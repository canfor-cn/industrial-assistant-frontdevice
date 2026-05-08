# Industrial Assistant — Device + Frontend

数字人交互终端，用于工业展厅 / 服务大厅等场景。

```
┌─ User ─────────────────────────────────────────────────┐
│   ↓ 走到摄像头前 / 说话                                 │
└─────────────────┬───────────────────────────────────────┘
                  ↓
┌─ Device (Python) ──────────────────────────────────────┐
│   • USB UVC / Orbbec Gemini camera                      │
│   • XVF3800 mic array (or any UVC mic)                  │
│   • MediaPipe 人脸 / 嘴动检测                             │
│   • Silero VAD + KWS                                    │
└─────────────────┬───────────────────────────────────────┘
                  ↓ ws://127.0.0.1:8765
┌─ Tauri Host (Rust) + WebView (React) ──────────────────┐
│   • Unity WebGL 数字人渲染                                │
│   • Web Audio AudioWorklet 流式 TTS 播放                 │
│   • 配置面板（avatar / camera / persona）                 │
└─────────────────┬───────────────────────────────────────┘
                  ↓ ws://your-backend:7790/api/voice/ws
┌─ Backend (NOT in this repo) ───────────────────────────┐
│   • Qwen Realtime / OpenAI Realtime / your own LLM     │
│   • RAG / wiki / TTS                                    │
└─────────────────────────────────────────────────────────┘
```

This repo contains **device + Tauri frontend ONLY**. The LLM/RAG backend is closed-source.
For local testing, use the included [mock backend](examples/mock-backend/) — it speaks fake
sine-wave TTS so you can verify the whole pipeline works without paying for an LLM API.

---

## What's in this repo

| Path | Description |
|---|---|
| `wakefusion/` | Device-side Python (vision/audio/wakeword/decision) |
| `wakefusion_web/` | Tauri host (Rust) + React UI + Unity WebGL bindings |
| `wakefusion_web/public/Build/` | Unity WebGL build output (downloaded via `npm install` postinstall, see below) |
| `examples/mock-backend/` | Minimal Node.js backend for local testing |
| `docs/backend-protocol.md` | WS message protocol contract |
| `config/config.yaml` | Device config (camera / audio / hardware / backend URL) |
| `requirements-device.txt` | Python deps |

---

## Quick start (local + mock backend)

### Prereqs
- **Windows 10/11** (Linux/Mac may work for parts but not officially supported)
- **Python 3.13** + pip
- **Node.js 22+**
- **Rust toolchain** (rustup default stable)
- (Optional) **Orbbec Gemini camera** — without it, the system falls back to USB UVC
- (Optional) **reSpeaker XVF3800** — without it, any default UVC mic works

### Steps

```bash
# 1. Clone
git clone https://github.com/canfor-cn/industrial-assistant-frontdevice.git
cd industrial-assistant-frontdevice

# 2. Install Python deps
pip install -r requirements-device.txt

# 3. Install frontend deps (auto-downloads Unity Build via postinstall)
cd wakefusion_web
npm install

# 4. Build the Tauri EXE
npm run tauri:build
# → produces: src-tauri/target/release/wakefusion-terminal-host.exe

# 5. Start the mock backend (separate terminal)
cd ../examples/mock-backend
npm install
npm start
# → ws://0.0.0.0:7790/api/voice/ws

# 6. Edit config.yaml so the EXE points at the mock backend
# (default already points at 127.0.0.1:7790)

# 7. Run the EXE — you should see Unity render + hear sine-wave TTS
```

If everything works you'll see:
- Unity 数字人 enters frame
- A "Hello" greeting plays as sine-wave audio (mock backend's placeholder TTS)
- When you speak into the mic, the mock backend echoes a fake reply every ~5 seconds

---

## Production: connect to a real backend

You need a backend implementing [`docs/backend-protocol.md`](docs/backend-protocol.md). Options:

1. **Build your own** — wrap Qwen Realtime / OpenAI Realtime / Gemini Live and bridge messages
2. **Use a vendor** — anyone offering a service compatible with this protocol

Then edit `config.yaml`:
```yaml
llm_agent:
  host: "your-backend.example.com:7790"
  use_ssl: true                # use wss://
  token: "your-shared-secret"
```

---

## Unity WebGL build (large file handling)

The Unity build (`Build.data` ~245 MB, `Build.wasm` ~28 MB) is **not** in git history.
On `npm install`, the postinstall script downloads it from GitHub Releases:

```bash
cd wakefusion_web
npm install
# → fetches latest Build.zip from GitHub Releases → extracts to public/Build/
```

If the auto-download fails (firewall / no internet / behind GFW…), manually:
1. Download the latest `Build.zip` from [Releases](../../releases)
2. Unzip into `wakefusion_web/public/Build/` so you have:
   ```
   public/Build/
     Build.data
     Build.framework.js
     Build.loader.js
     Build.wasm
   ```

---

## Contributing

Pull requests welcome. Please:

1. **Fork** this repo
2. Create a **feature branch** in your fork (`git checkout -b feature/my-change`)
3. Commit your change with a clear message
4. Open a **PR against `main`** of this repo
5. Wait for review (we'll respond within a few days)

`main` requires review approval before merge. Direct push to `main` is disabled.
For substantial changes, please **open an Issue first** to discuss.

---

## License

[TBD — choose a license: MIT / Apache 2.0 / GPL / proprietary]

---

## Notes

- This repo is a `git subtree split` of `wakefusion_wake_module/` from a private upstream.
  Releases land here first via maintainer push; PRs flow back into upstream after review.
