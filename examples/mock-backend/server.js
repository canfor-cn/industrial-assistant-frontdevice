#!/usr/bin/env node
/**
 * Mock Backend Server — replaces the real Qwen Realtime backend for local testing.
 *
 * Goals:
 *   - Accept device/frontend ws connection on /api/voice/ws
 *   - Speak fake greetings on connect
 *   - Echo back a canned TTS reply (sine-wave PCM) when device sends audio
 *   - Demonstrate tool-call protocol (search_exhibition / control_media / search_web)
 *   - Push media_ref / media_duck / stop_tts so the device's full UI flow can be exercised
 *
 * NOT included:
 *   - Real LLM (Qwen / OpenAI / etc.)
 *   - Real RAG / wiki content
 *   - Real TTS (we synthesize sine-wave PCM as placeholder audio)
 *   - Real ASR (we don't transcribe device audio, just echo)
 *
 * Usage:
 *   npm install
 *   node server.js
 *   → Listens on ws://0.0.0.0:7790/api/voice/ws
 *   → Edit config.yaml of the device:  llm_agent.host: 127.0.0.1:7790
 */

import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 7790;
const PATH = "/api/voice/ws";
const SHARED_TOKEN = process.env.VOICE_SHARED_TOKEN || "test-voice-token";

// ── Helpers ────────────────────────────────────────────────────────

/** 生成 PCM s16le 24kHz 单声道 sine wave 作为"假 TTS"音频。 */
function generateSinePCM(durationMs, freq = 440, sampleRate = 24000) {
  const sampleCount = Math.floor(sampleRate * durationMs / 1000);
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.3;
    const s16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    buf.writeInt16LE(s16, i * 2);
  }
  return buf;
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把整段 PCM 切成 ~167ms 的 chunk 流式推给 device，模拟真 TTS。 */
async function streamFakeTTS(ws, deviceId, text) {
  const traceId = `rt-${randomUUID()}`;
  const sampleRate = 24000;
  const channels = 1;
  // 用文字长度估算 audio 时长：每字 ~150ms
  const durationMs = Math.max(800, text.length * 150);
  const totalPCM = generateSinePCM(durationMs, 440, sampleRate);
  const CHUNK_BYTES = 8000;  // ~167ms @ 24kHz s16

  // 1. audio_begin
  sendJson(ws, {
    type: "audio_begin",
    traceId,
    deviceId,
    codec: "pcm_s16",
    mimeType: "audio/pcm",
    sampleRate,
    channels,
  });

  // 2. assistant transcript
  sendJson(ws, {
    type: "subtitle_ai_stream",
    traceId,
    deviceId,
    text,
  });
  sendJson(ws, {
    type: "subtitle_ai_commit",
    traceId,
    deviceId,
  });

  // 3. audio_chunk × N
  let seq = 1;
  for (let off = 0; off < totalPCM.length; off += CHUNK_BYTES) {
    if (ws.readyState !== ws.OPEN) return;
    const slice = totalPCM.subarray(off, Math.min(off + CHUNK_BYTES, totalPCM.length));
    sendJson(ws, {
      type: "audio_chunk",
      traceId,
      deviceId,
      seq,
      codec: "pcm_s16",
      sampleRate,
      channels,
      data: slice.toString("base64"),
    });
    seq++;
    await sleep(160);  // 模拟流式生成节奏
  }

  // 4. audio_end
  sendJson(ws, {
    type: "audio_end",
    traceId,
    deviceId,
  });
}

// ── Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT, path: PATH });

console.log(`[mock-backend] ws://0.0.0.0:${PORT}${PATH}`);
console.log(`[mock-backend] Edit device config.yaml: llm_agent.host: 127.0.0.1:${PORT}`);
console.log(`[mock-backend] Token: ${SHARED_TOKEN}`);

wss.on("connection", async (ws, req) => {
  // 简单鉴权：Tauri 用 query param ?token=...&deviceId=...
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const deviceId = url.searchParams.get("deviceId") || "unknown-device";
  if (token !== SHARED_TOKEN) {
    console.warn(`[mock-backend] Reject: bad token from ${req.socket.remoteAddress}`);
    ws.close(1008, "Bad token");
    return;
  }
  console.log(`[mock-backend] Device connected: ${deviceId} (${req.socket.remoteAddress})`);

  // 主动打个招呼
  await sleep(500);
  await streamFakeTTS(ws, deviceId, "你好，我是 mock 后端。我能听到你说话，但不做真 ASR/LLM。");

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      // 我们不处理二进制帧
      return;
    }
    let msg;
    try { msg = JSON.parse(String(raw)); }
    catch { console.warn(`[mock-backend] Non-JSON: ${String(raw).slice(0, 80)}`); return; }

    const t = msg.type;
    switch (t) {
      case "device_state":
        // 静默接收
        break;

      case "greeting":
        await streamFakeTTS(ws, deviceId, "你好呀，欢迎来到展厅。这是 mock 后端在说话。");
        break;

      case "audio_stream_start":
        console.log(`[mock-backend] device started streaming audio (traceId=${msg.traceId})`);
        break;

      case "audio_stream_chunk":
        // 我们不做 ASR，每收到 ~30 个 chunk（约 5 秒）回应一次假 TTS
        ws.__chunkCount = (ws.__chunkCount || 0) + 1;
        if (ws.__chunkCount >= 30) {
          ws.__chunkCount = 0;
          // 随机演示几种 TTS 内容 + 工具调用
          const dice = Math.floor(Math.random() * 3);
          if (dice === 0) {
            await streamFakeTTS(ws, deviceId, "我听到你说话了，但我只是 mock 后端，不会真 ASR。");
          } else if (dice === 1) {
            // 演示 control_media duck/restore
            sendJson(ws, { type: "media_duck", deviceId, action: "duck", level: 0.2 });
            await streamFakeTTS(ws, deviceId, "现在压低视频音量演示一下。");
            sendJson(ws, { type: "media_duck", deviceId, action: "restore", level: 1 });
          } else {
            // 演示 media_ref（推一个假媒体引用）
            sendJson(ws, {
              type: "media_ref",
              deviceId,
              assetId: "mock-demo",
              assetType: "wiki",
              url: "",
              label: "Mock 示例资料",
              inlineBody: "# Mock 示例\n\n这是 mock backend 推送的 inline markdown。\n\n- 项目 1\n- 项目 2\n- 项目 3\n",
            });
            await streamFakeTTS(ws, deviceId, "屏幕上展示了一份示例资料。");
          }
        }
        break;

      case "audio_stream_stop":
        console.log(`[mock-backend] device stopped streaming`);
        break;

      case "user_speech_end":
      case "barge_in":
      case "interrupt":
        // 用户打断 → 立刻 stop_tts
        sendJson(ws, { type: "stop_tts", deviceId, reason: "interrupt" });
        break;

      case "media_duck_request":
        // 透传成 media_duck
        sendJson(ws, { type: "media_duck", deviceId, action: "duck", level: 0.1 });
        break;

      case "face_embedding":
      case "voice_embedding":
        // 静默接收（真后端会做访客识别）
        break;

      case "face_update":
      case "timeout_exit":
        break;

      default:
        if (process.env.VERBOSE) console.log(`[mock-backend] msg: ${t}`);
    }
  });

  ws.on("close", () => {
    console.log(`[mock-backend] Device disconnected: ${deviceId}`);
  });
});
