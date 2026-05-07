/**
 * PCM 流式播放器 — AudioWorkletProcessor
 *
 * 跑在 audio thread；主线程 postMessage 推 PCM Float32 到 queue，
 * process() 每帧从 queue 拉数据填 output → 浏览器扬声器。
 *
 * 嘴型对齐：在 audio thread 内累计 RMS，每 33ms (30fps) postMessage 主线程，
 * 主线程 SendMessage Unity OnLipEnvelope。envelope 是"实际播放出去的样本"
 * 的能量，跟扬声器输出严格同步，对齐延迟 < 25ms。
 *
 * 协议（主线程 → worklet）：
 *   {type:"pcm", samples: Float32Array}    push 一段
 *   {type:"flush"}                          清空 queue（打断）
 *
 * 协议（worklet → 主线程）：
 *   {type:"env", value: number}             RMS 0..1
 *
 * AudioContext sampleRate 在主线程构造时指定（24000 匹配 Qwen Realtime），
 * 浏览器自动 resample 到设备 native rate。worklet 内不做 resample。
 */
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.queue = [];
    /** @type {Float32Array | null} */
    this.current = null;
    this.offset = 0;

    // RMS 累积：每 ~33ms 推一次 envelope (30 fps)
    this.rmsSum = 0;
    this.rmsCount = 0;
    // sampleRate 是 AudioWorkletGlobalScope 的全局变量
    this.envInterval = (sampleRate / 30) | 0;
    this.envCounter = 0;

    // 真实播放状态（audio thread 自己知道，最准确）。
    // 用于驱动前端 MediaDuckController：playing → 立即压视频音量；
    // idle → 立即恢复。比后端 onAudioBegin/End 准确数十秒。
    this.isPlaying = false;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "pcm" && m.samples instanceof Float32Array) {
        this.queue.push(m.samples);
      } else if (m.type === "flush") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.rmsSum = 0;
        this.rmsCount = 0;
        this.envCounter = 0;
        // 立即归零：让 Unity 嘴马上闭合 + 通知主线程已停播
        this.port.postMessage({ type: "env", value: 0 });
        if (this.isPlaying) {
          this.isPlaying = false;
          this.port.postMessage({ type: "state", playing: false });
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const ch = out[0];

    for (let i = 0; i < ch.length; i++) {
      // 取下一段
      while ((!this.current || this.offset >= this.current.length) && this.queue.length > 0) {
        this.current = this.queue.shift();
        this.offset = 0;
      }

      const hasData = !!(this.current && this.offset < this.current.length);

      // 状态变化时上报主线程（用于精确驱动 MediaDuckController）
      if (hasData && !this.isPlaying) {
        this.isPlaying = true;
        this.port.postMessage({ type: "state", playing: true });
      } else if (!hasData && this.isPlaying && this.queue.length === 0) {
        this.isPlaying = false;
        this.port.postMessage({ type: "state", playing: false });
      }

      let s = 0;
      if (hasData) {
        s = this.current[this.offset++];
      }
      ch[i] = s;

      this.rmsSum += s * s;
      this.rmsCount++;

      if (++this.envCounter >= this.envInterval) {
        const rms = Math.sqrt(this.rmsSum / Math.max(1, this.rmsCount));
        this.port.postMessage({ type: "env", value: rms });
        this.rmsSum = 0;
        this.rmsCount = 0;
        this.envCounter = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
