/**
 * WebRTC client — PR 1 loopback 验证用
 *
 * 建立一个 RTCPeerConnection 连到后端 /api/voice/webrtc/loopback-offer，
 * 后端把麦克风 track 原样回传。用来验证：
 *   1. @roamhq/wrtc 连通性
 *   2. 浏览器 AEC 在 <audio srcObject=remoteStream> 场景下真正工作
 */

export type WebRTCClientOptions = {
  backendHttpUrl: string; // 例: "http://127.0.0.1:7790"
  endpoint?: string;       // 默认 "/api/voice/webrtc/loopback-offer"
  deviceId?: string;       // WebRTC session 的 deviceId（正式 Qwen 通路需要）
  onConnected?: () => void;
  onClosed?: (reason: string) => void;
  onError?: (err: Error) => void;
  onRemoteStream?: (stream: MediaStream) => void;
};

export class WebRTCClient {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private readonly opts: WebRTCClientOptions;

  constructor(opts: WebRTCClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<MediaStream> {
    if (this.pc) throw new Error("already started");

    // 1. 拿麦克风 — 开启浏览器 AEC/NS/AGC（WebRTC 的核心优势）
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    // 2. 建 RTCPeerConnection — loopback 只连本机，无需 STUN
    this.pc = new RTCPeerConnection({ iceServers: [] });

    // 3. 收远端 track（后端回传的音频）
    this.remoteStream = new MediaStream();
    this.pc.ontrack = (evt) => {
      const t = evt.track;
      console.log("[webrtc] remote track:", t.kind, t.id);
      this.remoteStream!.addTrack(t);
      this.opts.onRemoteStream?.(this.remoteStream!);
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      console.log("[webrtc] pc state:", s);
      if (s === "connected") this.opts.onConnected?.();
      if (s === "failed" || s === "closed" || s === "disconnected") {
        this.opts.onClosed?.(s ?? "closed");
      }
    };

    // 4. 推本地 mic track
    for (const track of this.localStream.getAudioTracks()) {
      this.pc.addTrack(track, this.localStream);
    }

    // 5. createOffer + setLocal + 等 ICE 采集完再发
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitIceComplete(2000);
    const finalOffer = this.pc.localDescription;
    if (!finalOffer) throw new Error("no localDescription");

    // 6. POST SDP → 后端返回 answer
    const endpoint = this.opts.endpoint ?? "/api/voice/webrtc/loopback-offer";
    const resp = await fetch(`${this.opts.backendHttpUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: finalOffer.sdp, type: finalOffer.type, deviceId: this.opts.deviceId }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`signaling failed ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const answer = await resp.json() as { sdp: string; type: "answer" };
    await this.pc.setRemoteDescription(answer);
    console.log("[webrtc] signaling done, awaiting connection...");

    return this.remoteStream!;
  }

  stop(): void {
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    this.remoteStream = null;
  }

  private async waitIceComplete(timeoutMs: number): Promise<void> {
    if (!this.pc) return;
    if (this.pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const handler = () => {
        if (this.pc?.iceGatheringState === "complete") {
          clearTimeout(timer);
          this.pc.removeEventListener("icegatheringstatechange", handler);
          resolve();
        }
      };
      this.pc!.addEventListener("icegatheringstatechange", handler);
    });
  }
}
