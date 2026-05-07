/**
 * 浏览器 Web Audio PCM 流式播放器（主线程封装）
 *
 * 设计目标：
 *   - 后端推 PCM s16 (Qwen Realtime 输出 24kHz mono) → 浏览器无间隙播放
 *   - audio thread 直出，绕开 Unity WebGL 的 PCMReaderCallback 限制
 *   - audio thread 内算 RMS envelope，主线程接到后 SendMessage Unity 驱动嘴型
 *
 * 用法：
 *   const player = createWebAudioPlayer("/pcm-player-worklet.js");
 *   player.onEnvelope((v) => sendToUnity("...", "OnLipEnvelope", JSON.stringify({value:v})));
 *
 *   // 每段对话开始
 *   await player.begin(24000, 1);
 *
 *   // 收到 audio_chunk
 *   player.pushChunk(base64PcmS16);
 *
 *   // 服务端 audio_end
 *   player.end();
 *
 *   // 用户/系统打断
 *   player.stop();
 */

export interface WebAudioPlayer {
  /** 准备 AudioContext + 加载 worklet（首次会 addModule，~100-300ms）。可重复调用。 */
  begin(sampleRate: number, channels: number): Promise<void>;
  /** 推一段 base64 编码的 PCM s16 little-endian。 */
  pushChunk(pcmS16Base64: string): void;
  /** 后端 audio_end：等队列自然排空（不立即停）。 */
  end(): void;
  /** 立刻清空队列、嘴型归零；用于 stop_tts / 用户打断。 */
  stop(): void;
  /** 注册 envelope 回调；worklet 每 ~33ms 推一次 RMS (0..1)。 */
  onEnvelope(cb: (value: number) => void): void;
  /**
   * 注册"真实播放状态"回调；worklet 在 audio thread 内监测 ring buffer 状态变化时推送：
   * - playing=true：刚开始有 PCM 输出（用户真的听到声音）
   * - playing=false：buffer 排空 + queue 空（用户真的听完了）
   *
   * 比后端 onAudioBegin/End 精确：onAudioEnd 是"Qwen 推完最后一个 chunk"，
   * 但 worklet ring buffer 还会播几十秒。worklet 自己上报的是真实出声状态。
   */
  onPlaybackState(cb: (playing: boolean) => void): void;
  /** 销毁：close AudioContext。一般无需调用（单例复用）。 */
  destroy(): void;
}

type PlayerState = {
  ctx: AudioContext | null;
  node: AudioWorkletNode | null;
  workletReady: Promise<void> | null;
  envelopeCb: ((v: number) => void) | null;
  playbackStateCb: ((playing: boolean) => void) | null;
  preferredSampleRate: number;
};

export function createWebAudioPlayer(workletUrl: string): WebAudioPlayer {
  const state: PlayerState = {
    ctx: null,
    node: null,
    workletReady: null,
    envelopeCb: null,
    playbackStateCb: null,
    preferredSampleRate: 24000,
  };

  async function ensureCtxAndWorklet(sampleRate: number): Promise<void> {
    if (state.ctx && state.ctx.state !== "closed") {
      // 已经创建过；如果 sampleRate 跟之前一致就复用，否则重建
      if (state.ctx.sampleRate === sampleRate && state.node) return;
      // sampleRate 变了——关掉重建（罕见，目前后端固定 24000）
      try { state.node?.disconnect(); } catch { /* ignore */ }
      try { await state.ctx.close(); } catch { /* ignore */ }
      state.ctx = null; state.node = null; state.workletReady = null;
    }

    const ctx = new AudioContext({
      sampleRate,
      latencyHint: "interactive",
    });
    state.ctx = ctx;
    state.preferredSampleRate = sampleRate;

    state.workletReady = ctx.audioWorklet.addModule(workletUrl).then(() => {
      const node = new AudioWorkletNode(ctx, "pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (ev) => {
        const m = ev.data;
        if (!m) return;
        if (m.type === "env" && state.envelopeCb) {
          state.envelopeCb(m.value);
        } else if (m.type === "state" && state.playbackStateCb) {
          state.playbackStateCb(!!m.playing);
        }
      };
      node.connect(ctx.destination);
      state.node = node;
      console.log("[webAudioPcmPlayer] worklet ready, sampleRate=" + ctx.sampleRate);
    }).catch((err) => {
      console.error("[webAudioPcmPlayer] addModule failed:", err);
      throw err;
    });

    await state.workletReady;

    // autoplay flag (Tauri lib.rs 已加 --autoplay-policy=no-user-gesture-required)
    // 应该让 ctx 直接 running；但保险起见 resume 一下
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
  }

  function pcmS16Base64ToFloat32(b64: string): Float32Array {
    const bin = atob(b64);
    const len = bin.length;
    if (len === 0 || (len & 1) !== 0) return new Float32Array(0);
    // bin 字符 → bytes → Int16 → Float32
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const sampleCount = len >> 1;
    const out = new Float32Array(sampleCount);
    // little-endian s16 → -1..1
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < sampleCount; i++) {
      const s = dv.getInt16(i * 2, true);
      out[i] = s / 32768;
    }
    return out;
  }

  return {
    async begin(sampleRate: number, _channels: number) {
      await ensureCtxAndWorklet(sampleRate);
    },

    pushChunk(b64: string) {
      const node = state.node;
      if (!node) {
        console.warn("[webAudioPcmPlayer] pushChunk called before begin()/worklet ready");
        return;
      }
      const samples = pcmS16Base64ToFloat32(b64);
      if (samples.length === 0) return;
      // zero-copy transfer
      node.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
    },

    end() {
      // 不做任何事 — worklet queue 自然排空、扬声器自然停。
      // characterController StopTalking 由 unityWsShim 在 audio_end 时显式触发。
    },

    stop() {
      const node = state.node;
      if (!node) return;
      node.port.postMessage({ type: "flush" });
    },

    onEnvelope(cb) {
      state.envelopeCb = cb;
    },

    onPlaybackState(cb) {
      state.playbackStateCb = cb;
    },

    destroy() {
      try { state.node?.disconnect(); } catch { /* ignore */ }
      try { state.ctx?.close(); } catch { /* ignore */ }
      state.ctx = null;
      state.node = null;
      state.workletReady = null;
      state.envelopeCb = null;
      state.playbackStateCb = null;
    },
  };
}
