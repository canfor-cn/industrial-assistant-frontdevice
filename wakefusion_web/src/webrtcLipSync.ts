/**
 * RTC remote MediaStream → Unity OnPlayAudio 适配。
 *
 * 现状：WebRTC 路径下，浏览器 <audio> 直接播 SRTP 解码出来的音频，
 * 但 Unity WebGL 数字人收不到任何音频信号，所以嘴型不动。
 *
 * 本模块把 RTC 远端流分一份：
 *   MediaStream → AudioContext → ScriptProcessor → 累积 ~chunkMs 的 PCM →
 *   线性 resample 到 22050Hz mono → WAV header → base64 → playAudio()
 *
 * Unity 收到 OnPlayAudio 后用自带的"音频驱动嘴型"逻辑解码 + 触发口型动画。
 * （见 useUnityBridge.ts 与 plan 2026-04-16-unity-webgl-audio-driven.md）
 *
 * 调用方应同时把浏览器 <audio> 元素 muted=true，避免双声道
 * （RTC AEC 由 PeerConnection 自行处理，不依赖 <audio> 作 reference signal）。
 */

export interface LipSyncSession {
  stop: () => void;
}

export interface LipSyncOptions {
  /** 多少毫秒 flush 一次（越小越实时但越抖） */
  chunkMs?: number;
  /** Unity 期望的 PCM 采样率，默认 22050 */
  targetRate?: number;
}

export function startWebrtcLipSync(
  stream: MediaStream,
  playAudio: (audioBase64: string, format?: string, sampleRate?: number, channels?: number) => void,
  options?: LipSyncOptions,
): LipSyncSession {
  const chunkMs = options?.chunkMs ?? 220;
  const targetRate = options?.targetRate ?? 22050;

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    console.warn("[lipsync] no audio track on stream — bailing");
    return { stop: () => { /* noop */ } };
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // 输出端经 gain=0 接 destination，强制 onaudioprocess 触发但不出声
  const sink = ctx.createGain();
  sink.gain.value = 0;

  let buffer: number[] = [];
  let lastFlush = performance.now();
  let stopped = false;

  processor.onaudioprocess = (ev) => {
    if (stopped) return;
    const input = ev.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) {
      buffer.push(input[i]);
    }
    const now = performance.now();
    if (now - lastFlush >= chunkMs) {
      flush(ctx.sampleRate);
      lastFlush = now;
    }
  };

  function flush(srcRate: number) {
    if (buffer.length === 0) return;
    const src = new Float32Array(buffer);
    buffer = [];

    const ratio = srcRate / targetRate;
    const dstLen = Math.floor(src.length / ratio);
    if (dstLen <= 0) return;
    const dst = new Int16Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, src.length - 1);
      const frac = idx - i0;
      const s = src[i0] * (1 - frac) + src[i1] * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      dst[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    }

    const pcmLen = dst.length * 2;
    const wavLen = 44 + pcmLen;
    const wavBuf = new ArrayBuffer(wavLen);
    const view = new DataView(wavBuf);
    writeStr(view, 0, "RIFF");
    view.setUint32(4, wavLen - 8, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, "data");
    view.setUint32(40, pcmLen, true);
    new Int16Array(wavBuf, 44, dst.length).set(dst);

    const bytes = new Uint8Array(wavBuf);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
    }
    try {
      playAudio(btoa(binary), "wav", targetRate, 1);
    } catch (err) {
      console.error("[lipsync] playAudio failed:", err);
    }
  }

  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

  return {
    stop: () => {
      stopped = true;
      try { processor.disconnect(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
      try { sink.disconnect(); } catch { /* ignore */ }
      try { void ctx.close(); } catch { /* ignore */ }
      buffer = [];
    },
  };
}

function writeStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
