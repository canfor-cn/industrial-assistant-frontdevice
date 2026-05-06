// Unity WebGL WS shim — 移植自 Unity 工程师交付的 demo index.html (line 100-235)
//
// 设计角色：协议适配层
//   ws://127.0.0.1:9876 (Tauri unity_ws_server 广播)
//        ↓
//   本 shim 收 audio_begin / audio_chunk / audio_end / stop_tts / error 等
//        ↓
//   翻译成 unityInstance.SendMessage("WebCommunication", "OnAudioBegin/...", JSON)
//        ↓
//   Unity 内部 C# OnAudioBegin/Chunk/End handler（PlayScheduled 零间隙调度）
//
// 未来换 3D 引擎（Three.js / live2d）时仅需替换本文件 + Unity Build，Tauri 协议层不变。
//
// 协议来源：dist/Build/Build/UnityWebGL-WS协议说明.md + index.html line 127-202

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

// 新协议 audio_begin 时暂存的元数据，用于把后续 audio_chunk 的裸 PCM 拼成 WAV。
// Unity 当前 build 的 OnAudioChunk 实测有 bug（PCM 解码不工作），我们在前端把
// PCM 拼 44 字节 WAV header → 走已经验证 OK 的 OnPlayAudio 路径绕开。
let pcmStreamMeta: { traceId: string; sampleRate: number; channels: number } | null = null;

function pcmBase64ToWavBase64(pcmBase64: string, sampleRate: number, channels: number): string {
  const binary = atob(pcmBase64);
  const pcmLen = binary.length;
  const total = 44 + pcmLen;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  // RIFF
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46;       // "RIFF"
  view.setUint32(4, 36 + pcmLen, true);
  buf[8] = 0x57; buf[9] = 0x41; buf[10] = 0x56; buf[11] = 0x45;     // "WAVE"
  // fmt
  buf[12] = 0x66; buf[13] = 0x6D; buf[14] = 0x74; buf[15] = 0x20;   // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                                       // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);                                      // 16-bit
  // data
  buf[36] = 0x64; buf[37] = 0x61; buf[38] = 0x74; buf[39] = 0x61;   // "data"
  view.setUint32(40, pcmLen, true);
  for (let i = 0; i < pcmLen; i++) buf[44 + i] = binary.charCodeAt(i);
  let bin = "";
  const block = 0x8000;
  for (let i = 0; i < buf.length; i += block) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + block)));
  }
  return btoa(bin);
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
  // 容许多行 JSON（同 demo 行为）
  const lines = String(text).split(/\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.warn("[Unity WS] 非 JSON 文本，已忽略:", line.slice(0, 120));
      continue;
    }
    const t = msg.type as string | undefined;
    if (t === "dialogueStart" || t === "dialogue_start") {
      sendToUnity("WebCommunication", "OnDialogueStart", JSON.stringify({ dialogueId: msg.dialogueId }));
    } else if (t === "interrupt") {
      sendToUnity("WebCommunication", "OnInterrupt", "{}");
    } else if (t === "audio_begin") {
      // 暂存元数据 + 让 Unity 重置 dspTime 锚点（OnDialogueStart 内做的）
      const traceId = String(msg.traceId ?? "");
      const sampleRate = Number(msg.sampleRate) || 24000;
      const channels = Number(msg.channels) || 1;
      pcmStreamMeta = { traceId, sampleRate, channels };
      sendToUnity("WebCommunication", "OnDialogueStart", JSON.stringify({ dialogueId: traceId }));
    } else if (t === "audio_chunk") {
      // PCM s16 → WAV → OnPlayAudio（绕开 Unity OnAudioChunk 当前实现的 bug）
      if (!pcmStreamMeta) {
        console.warn("[Unity WS] audio_chunk 在 audio_begin 之前到达，忽略");
        continue;
      }
      const codec = (msg.codec as string) || "pcm_s16";
      if (codec !== "pcm_s16" && codec !== "pcm_s16le") {
        console.warn("[Unity WS] 当前仅支持 pcm_s16/pcm_s16le，收到:", codec);
        continue;
      }
      try {
        const wavBase64 = pcmBase64ToWavBase64(
          String(msg.data ?? ""),
          pcmStreamMeta.sampleRate,
          pcmStreamMeta.channels,
        );
        sendToUnity("WebCommunication", "OnPlayAudio", JSON.stringify({
          dialogueId: pcmStreamMeta.traceId,
          audioBase64: wavBase64,
          format: "wav",
          sampleRate: pcmStreamMeta.sampleRate,
          channels: pcmStreamMeta.channels,
        }));
      } catch (e) {
        console.error("[Unity WS] PCM→WAV 失败:", e);
      }
    } else if (t === "audio_end") {
      // PlayScheduled 队列自然播完，无需 OnAudioEnd（Unity 当前 OnAudioEnd 行为不明）
      pcmStreamMeta = null;
    } else if (t === "stop_tts") {
      sendToUnity("WebCommunication", "OnStopTts", JSON.stringify({
        traceId: msg.traceId,
        reason: (msg.reason as string) || "",
      }));
    } else if (t === "error" && (msg as { code?: string }).code === "request_cancelled") {
      sendToUnity("WebCommunication", "OnStopTts", JSON.stringify({
        traceId: msg.traceId,
        reason: "request_cancelled",
      }));
    } else if (t === "playAudio" || t === "play_audio") {
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
    // Tauri unity_ws_server 重启或瞬时断网时自动重连（5 秒）
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
 *
 * URL 解析优先级（同 demo 行为）：
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
}
