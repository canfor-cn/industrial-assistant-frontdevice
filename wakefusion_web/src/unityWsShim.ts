// Unity WebGL WS shim — 协议适配层
//
// 数据流：
//   ws://127.0.0.1:9876 (Tauri unity_ws_server 广播 audio_begin / audio_chunk / audio_end / stop_tts)
//        ↓
//   本 shim 拦截 audio_chunk PCM → 浏览器 Web Audio (AudioWorkletNode) 直接播放
//        ↓ (worklet audio thread 内每 33ms 算 RMS envelope)
//   主线程接 envelope → SendMessage("WebCommunication", "OnLipEnvelope", JSON{value})
//   Unity 用 envelope 驱动 SkinnedMeshRenderer.SetBlendShapeWeight 嘴张幅度
//
// 设计原因：
//   Unity WebGL 不支持 streamed AudioClip + PCMReaderCallback —— Unity 自己播音频
//   会自动降级 callback 不触发 → 完全静音。因此把音频播放彻底从 Unity 剥离，
//   交给浏览器原生 Web Audio API。Unity 只负责渲染 + 接 envelope 驱动嘴型。
//
// 仍走 Unity 内部播放的协议（保留兼容）：
//   - playAudio / play_audio / playAudioBinary（WebRTC 通话路径用，参见 webrtcLipSync.ts）
//   - dialogueStart / dialogue_start / interrupt
//
// 协议来源：dist/Build/Build/UnityWebGL-WS协议说明.md

import { createWebAudioPlayer, type WebAudioPlayer } from "./webAudioPcmPlayer";

declare global {
  interface Window {
    unityInstance?: { SendMessage(obj: string, method: string, arg: string): void };
  }
}

let activeWs: WebSocket | null = null;
let pendingBinaryPlay: { dialogueId: string; format: string; sampleRate: number; channels: number } | null = null;
let reconnectTimer: number | null = null;
let shouldReconnect = true;
let lastUrl: string = "";

// 浏览器侧 PCM 流式播放器（AudioContext + AudioWorklet）。单例复用。
let pcmPlayer: WebAudioPlayer | null = null;
let pcmPlayerActiveTraceId: string | null = null;

function ensurePcmPlayer(): WebAudioPlayer {
  if (!pcmPlayer) {
    pcmPlayer = createWebAudioPlayer("/pcm-player-worklet.js");
    pcmPlayer.onEnvelope((value) => {
      // worklet 在 audio thread 内每 33ms 推一次 RMS（实际播放出去的样本能量）
      // → 主线程 SendMessage Unity → SetBlendShapeWeight，对齐延迟 ~25ms
      sendToUnity("WebCommunication", "OnLipEnvelope", JSON.stringify({ value }));
    });
  }
  return pcmPlayer;
}

function sendToUnity(objName: string, methodName: string, arg: string): void {
  const inst = window.unityInstance;
  if (!inst?.SendMessage) {
    console.warn("[Unity WS] Unity 未就绪，跳过", methodName);
    return;
  }
  try {
    inst.SendMessage(objName, methodName, arg);
  } catch (e) {
    console.error("[Unity WS] SendMessage 失败:", e);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function handleWebSocketTextMessage(text: string): void {
  // 容许多行 JSON
  const lines = String(text).split(/\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn("[Unity WS] 非 JSON 文本，已忽略:", line.slice(0, 120));
      continue;
    }
    const t = msg.type as string | undefined;

    if (t === "dialogueStart" || t === "dialogue_start") {
      sendToUnity("WebCommunication", "OnDialogueStart", JSON.stringify({ dialogueId: msg.dialogueId }));
    } else if (t === "interrupt") {
      pcmPlayer?.stop();
      sendToUnity("WebCommunication", "OnInterrupt", "{}");
    } else if (t === "audio_begin") {
      // 浏览器 Web Audio 主播路径：开新一段
      const traceId = String(msg.traceId ?? "");
      const sampleRate = Number(msg.sampleRate) || 24000;
      const channels = Number(msg.channels) || 1;
      pcmPlayerActiveTraceId = traceId;
      ensurePcmPlayer().begin(sampleRate, channels).catch((err) => {
        console.error("[Unity WS] webAudioPlayer begin failed:", err);
      });
      // Unity 端切说话动画
      sendToUnity("WebCommunication", "OnAudioBegin", JSON.stringify({
        traceId,
        codec: (msg.codec as string) || "pcm_s16",
        sampleRate,
        channels,
      }));
    } else if (t === "audio_chunk") {
      // 直接交给浏览器 worklet（绕开 Unity AudioSource）
      const codec = (msg.codec as string) || "pcm_s16";
      if (codec !== "pcm_s16" && codec !== "pcm_s16le") {
        console.warn("[Unity WS] 当前仅支持 pcm_s16/pcm_s16le，收到:", codec);
        continue;
      }
      const data = String(msg.data ?? "");
      if (data.length === 0) continue;
      ensurePcmPlayer().pushChunk(data);
    } else if (t === "audio_end") {
      // 队列自然排空；Unity 端切回待机动画 + 嘴归位
      pcmPlayer?.end();
      sendToUnity("WebCommunication", "OnAudioEnd", JSON.stringify({
        traceId: msg.traceId ?? pcmPlayerActiveTraceId ?? "",
      }));
      pcmPlayerActiveTraceId = null;
    } else if (t === "stop_tts") {
      // 立即清 worklet queue → envelope 立即归零；Unity 切回待机
      pcmPlayer?.stop();
      sendToUnity("WebCommunication", "OnStopTts", JSON.stringify({
        traceId: msg.traceId,
        reason: (msg.reason as string) || "",
      }));
      pcmPlayerActiveTraceId = null;
    } else if (t === "error" && (msg as { code?: string }).code === "request_cancelled") {
      pcmPlayer?.stop();
      sendToUnity("WebCommunication", "OnStopTts", JSON.stringify({
        traceId: msg.traceId,
        reason: "request_cancelled",
      }));
      pcmPlayerActiveTraceId = null;
    } else if (t === "playAudio" || t === "play_audio") {
      // 旧协议（WebRTC 通话路径用 webrtcLipSync.ts 调用）：仍走 Unity 内部播放
      sendToUnity("WebCommunication", "OnPlayAudio", JSON.stringify({
        dialogueId: msg.dialogueId,
        audioBase64: msg.audioBase64,
        format: (msg.format as string) || "wav",
        sampleRate: (msg.sampleRate as number) || 24000,
        channels: (msg.channels as number) || 1,
      }));
    } else if (t === "playAudioBinary" || t === "play_audio_binary") {
      pendingBinaryPlay = {
        dialogueId: (msg.dialogueId as string) || "",
        format: (msg.format as string) || "wav",
        sampleRate: ((msg.sampleRate as number) > 0 ? (msg.sampleRate as number) : 24000),
        channels: ((msg.channels as number) > 0 ? (msg.channels as number) : 1),
      };
    } else {
      console.warn("[Unity WS] 未知 type:", t);
    }
  }
}

function handleWebSocketBinaryMessage(arrayBuffer: ArrayBuffer): void {
  // 仅 RTC 旧协议（playAudioBinary）走二进制帧
  if (!pendingBinaryPlay) {
    console.warn("[Unity WS] 收到二进制帧但未先收到 playAudioBinary 元数据，已忽略");
    return;
  }
  const meta = pendingBinaryPlay;
  pendingBinaryPlay = null;
  const b64 = arrayBufferToBase64(arrayBuffer);
  sendToUnity("WebCommunication", "OnPlayAudio", JSON.stringify({
    dialogueId: meta.dialogueId,
    audioBase64: b64,
    format: meta.format,
    sampleRate: meta.sampleRate,
    channels: meta.channels,
  }));
}

function connectUnityWebSocket(url: string): void {
  if (!url || !String(url).trim()) return;
  if (activeWs) {
    try { activeWs.close(); } catch { /* noop */ }
    activeWs = null;
  }
  pendingBinaryPlay = null;
  const ws = new WebSocket(String(url).trim());
  activeWs = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    console.log("[Unity WS] 已连接:", url);
  };
  ws.onclose = () => {
    if (activeWs === ws) activeWs = null;
    pendingBinaryPlay = null;
    console.log("[Unity WS] 已断开");
    if (shouldReconnect && lastUrl) {
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        if (shouldReconnect) connectUnityWebSocket(lastUrl);
      }, 5000);
    }
  };
  ws.onerror = (e) => {
    console.error("[Unity WS] 错误", e);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") handleWebSocketTextMessage(ev.data);
    else if (ev.data instanceof ArrayBuffer) handleWebSocketBinaryMessage(ev.data);
  };
}

function getQueryParam(name: string): string {
  const m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
}

/**
 * 启动 Unity WS shim。在 Unity instance 已就绪后调用。
 * URL 解析优先级：
 *   1. defaultUrl 参数（硬编码）
 *   2. URL 查询参数 ?ws=...
 *   3. 默认 ws://127.0.0.1:9876
 */
export function startUnityWsShim(defaultUrl?: string): void {
  const url = (defaultUrl && defaultUrl.trim())
    || getQueryParam("ws")
    || "ws://127.0.0.1:9876";
  shouldReconnect = true;
  lastUrl = url;
  connectUnityWebSocket(url);
  // 预热 PCM 播放器：让 worklet 在用户第一次说话前就 ready，避免首响应 addModule 延迟
  ensurePcmPlayer().begin(24000, 1).catch(() => { /* ignore — 真正用时 begin 会再试 */ });
}

/** 主动停止 ws 连接（页面卸载或 Unity 销毁时）*/
export function stopUnityWsShim(): void {
  shouldReconnect = false;
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeWs) {
    try { activeWs.close(); } catch { /* noop */ }
    activeWs = null;
  }
  pendingBinaryPlay = null;
  try { pcmPlayer?.destroy(); } catch { /* ignore */ }
  pcmPlayer = null;
  pcmPlayerActiveTraceId = null;
}
