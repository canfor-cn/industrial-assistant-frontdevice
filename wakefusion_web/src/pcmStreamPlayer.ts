// Streaming PCM player for Qwen-Omni-Realtime audio_chunk (pcm_s16le @ 24kHz).
// Uses Web Audio API to schedule gapless playback of Int16 PCM frames as they arrive.
//
// Output routing:
//  - aecMode=false (default): source → ctx.destination → speaker (simple path)
//  - aecMode=true: source → MediaStreamAudioDestinationNode → exposed MediaStream
//    外层应把 MediaStream 绑到一个 <audio srcObject={stream}> 元素，
//    这样浏览器 AEC 能识别为"我方输出"，从麦克风输入中扣除，消除自播放回声。

export class PCMStreamPlayer {
  private ctx: AudioContext | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private nextStartTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private currentSampleRate = 24000;
  private readonly aecMode: boolean;

  constructor(options: { aecMode?: boolean } = {}) {
    this.aecMode = options.aecMode ?? false;
  }

  /** 外部拿 MediaStream 去绑 `<audio>` 元素（只在 aecMode=true 时有值）。 */
  getOutputStream(): MediaStream | null {
    return this.streamDest?.stream ?? null;
  }

  private ensureCtx(sampleRate: number): void {
    if (this.ctx && this.ctx.sampleRate !== sampleRate) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.streamDest = null;
    }
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate });
      if (this.aecMode) {
        this.streamDest = this.ctx.createMediaStreamDestination();
      }
    }
    this.currentSampleRate = sampleRate;
  }

  begin(sampleRate: number): void {
    // 先停掉旧回答的所有已 schedule sources，防止和新回答叠加播放
    this.interrupt();
    this.ensureCtx(sampleRate);
    if (this.ctx) this.nextStartTime = this.ctx.currentTime;
  }

  push(pcm16: ArrayBuffer, sampleRate: number): void {
    if (!this.ctx || this.ctx.sampleRate !== sampleRate) {
      this.ensureCtx(sampleRate);
      if (this.ctx) this.nextStartTime = this.ctx.currentTime;
    }
    const ctx = this.ctx!;
    const int16 = new Int16Array(pcm16);
    if (int16.length === 0) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buffer = ctx.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // AEC mode 路由到 MediaStream（用 <audio> 播放，浏览器 AEC 生效）
    // 否则直接 → destination → 扬声器
    const target: AudioNode = this.aecMode && this.streamDest ? this.streamDest : ctx.destination;
    src.connect(target);
    const startAt = Math.max(this.nextStartTime, ctx.currentTime);
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.push(src);
    src.onended = () => {
      const idx = this.sources.indexOf(src);
      if (idx >= 0) this.sources.splice(idx, 1);
    };
  }

  interrupt(): void {
    for (const src of this.sources) {
      try { src.stop(); } catch {}
    }
    this.sources = [];
    if (this.ctx) this.nextStartTime = this.ctx.currentTime;
  }

  close(): void {
    this.interrupt();
    this.streamDest = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
