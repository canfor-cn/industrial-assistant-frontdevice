/**
 * Tauri IPC backend hook.
 * When running inside Tauri, replaces WS connections with invoke() + listen().
 * When running in browser, returns null (caller falls back to WS).
 */

let _isTauri: boolean | null = null;

export function isTauriEnv(): boolean {
  if (_isTauri === null) {
    _isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
  }
  return _isTauri;
}

/** Send recorded audio to backend via Tauri invoke */
export async function tauriSendAudio(
  traceId: string,
  audioData: string, // base64
  mimeType: string,
  language: string = "zh"
): Promise<void> {
  if (!isTauriEnv()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("send_audio", { traceId, audioData, mimeType, language });
}

/** Send text to backend via Tauri invoke */
export async function tauriSendText(text: string, traceId: string, deviceId: string): Promise<void> {
  if (!isTauriEnv()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("send_text", { text, traceId, deviceId });
}

export interface TauriEventUnlisten {
  (): void;
}

/** Listen to a Tauri event, returns unlisten function */
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<TauriEventUnlisten> {
  if (!isTauriEnv()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<T>(event, (ev) => handler(ev.payload));
  return unlisten;
}

/**
 * Subscribe to all Tauri events that the Rust host emits.
 * Returns a cleanup function.
 */
export interface DeviceStatePayload {
  state: string; // idle | listening | thinking | speaking
  vision?: {
    faces: number;
    distance_m: number | null;
    is_talking: boolean;
    active: boolean;
  };
  audio?: {
    interactive: boolean;
    tts_playing: boolean;
    micReady?: boolean;
  };
  hardware?: {
    micReady: boolean;
    cameraReady: boolean;
  };
  timestamp?: number;
}

export interface VoiceMessage {
  traceId: string;
  text: string;
  role: string;
  audioId?: string;
  audioData?: string; // base64
  audioMime?: string;
}

export type TauriHostStatus = {
  mode: string;
  connected: boolean;
  deviceId: string;
  backendHost: string;
  deviceConnected: boolean;
  deviceAddr: string;
};

/** Get the full host status including current device connection (for late-mount UI sync). */
export async function tauriGetHostStatus(): Promise<TauriHostStatus | null> {
  if (!isTauriEnv()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<TauriHostStatus>("host_status");
  } catch {
    return null;
  }
}

export type BackendWsStatusSnapshot = {
  connected: boolean;
  host: string;
  reason?: string;
};

/**
 * Pull the current backend WS link status from Rust. The Rust ws_client typically
 * connects before React mounts, so the live `backend_ws_status` event is often
 * fired before any subscriber exists. Call this on mount to recover the state.
 */
export async function tauriGetBackendWsStatus(): Promise<BackendWsStatusSnapshot | null> {
  if (!isTauriEnv()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<BackendWsStatusSnapshot>("get_backend_ws_status");
  } catch {
    return null;
  }
}

/** Get the backend host address from Rust config (e.g. "192.168.0.97:7790") */
let _cachedBackendHost: string | null = null;
export async function tauriGetBackendHost(): Promise<string> {
  if (_cachedBackendHost) return _cachedBackendHost;
  if (!isTauriEnv()) return "127.0.0.1:7790";
  try {
    const status = await tauriGetHostStatus();
    _cachedBackendHost = status?.backendHost || "127.0.0.1:7790";
    return _cachedBackendHost;
  } catch {
    return "127.0.0.1:7790";
  }
}

/** Get cached audio from Rust host by audioId */
export async function tauriGetCachedAudio(audioId: string): Promise<{ audioData: string; audioMime: string } | null> {
  if (!isTauriEnv()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("get_cached_audio", { audioId });
  } catch {
    return null;
  }
}

export async function subscribeTauriEvents(handlers: {
  onToken?: (traceId: string, text: string) => void;
  onAsrResult?: (traceId: string, text: string, stage: string, audioId?: string) => void;
  onFinal?: (traceId: string) => void;
  onClear?: () => void;
  onMediaRef?: (data: any) => void;
  onRoute?: (traceId: string, route: string) => void;
  onConnectionStatus?: (connected: boolean, message: string) => void;
  /** Tauri host ↔ backend WS link status (the real connection, not "WebView ↔ host") */
  onBackendWsStatus?: (connected: boolean, host: string, reason?: string) => void;
  onVoiceMessage?: (msg: VoiceMessage) => void;
  onUserVoiceStart?: (audioId: string) => void;
  onUserVoiceText?: (audioId: string | undefined, traceId: string, text: string) => void;
  onSentenceBoundary?: (traceId: string, sentenceIndex: number, text: string) => void;
  onSentencePack?: (sentenceIndex: number, text: string, audio: string, mimeType: string, sampleRate: number, traceId: string) => void;
  onSentencePackDone?: () => void;
  onMediaControl?: (action: string, message: string) => void;
  onTtsAudioBegin?: (mimeType: string, codec: string, sampleRate: number) => void;
  onTtsAudioChunk?: (data: string, mimeType: string, codec: string, sampleRate: number, sentenceIndex?: number) => void;
  onTtsAudioEnd?: () => void;
  onDeviceStatus?: (connected: boolean, deviceAddr: string) => void;
  onDeviceState?: (state: DeviceStatePayload) => void;
  onSessionUpdate?: (sessionId: string, sessionAction: string, traceId: string) => void;
  onStopTts?: (traceId: string) => void;
  onSetupProgress?: (phase: string, message: string, done: boolean, error: boolean) => void;
}): Promise<() => void> {
  if (!isTauriEnv()) return () => {};

  const unlisteners: TauriEventUnlisten[] = [];

  if (handlers.onToken) {
    const h = handlers.onToken;
    unlisteners.push(
      await tauriListen<{ traceId: string; text: string }>("subtitle_ai_stream", (p) =>
        h(p.traceId, p.text)
      )
    );
  }

  if (handlers.onAsrResult) {
    const h = handlers.onAsrResult;
    unlisteners.push(
      await tauriListen<{ traceId: string; text: string; stage: string; audioId?: string }>("subtitle_user", (p) =>
        h(p.traceId, p.text, p.stage, p.audioId)
      )
    );
  }

  if (handlers.onFinal) {
    const h = handlers.onFinal;
    unlisteners.push(
      await tauriListen<{ traceId: string }>("subtitle_ai_commit", (p) => h(p.traceId))
    );
  }

  if (handlers.onClear) {
    const h = handlers.onClear;
    unlisteners.push(await tauriListen<{}>("subtitle_clear", () => h()));
  }

  if (handlers.onMediaRef) {
    const h = handlers.onMediaRef;
    unlisteners.push(await tauriListen<any>("media_ref", (p) => h(p)));
  }

  if (handlers.onRoute) {
    const h = handlers.onRoute;
    unlisteners.push(
      await tauriListen<{ traceId: string; route: string }>("route", (p) => h(p.traceId, p.route))
    );
  }

  if (handlers.onConnectionStatus) {
    const h = handlers.onConnectionStatus;
    unlisteners.push(
      await tauriListen<{ connected: boolean; message: string }>("connection_status", (p) =>
        h(p.connected, p.message)
      )
    );
  }

  if (handlers.onBackendWsStatus) {
    const h = handlers.onBackendWsStatus;
    unlisteners.push(
      await tauriListen<{ connected: boolean; host: string; reason?: string }>(
        "backend_ws_status",
        (p) => h(p.connected, p.host, p.reason),
      )
    );
  }

  if (handlers.onVoiceMessage) {
    const h = handlers.onVoiceMessage;
    unlisteners.push(
      await tauriListen<VoiceMessage>("voice_message", (p) => h(p))
    );
  }

  if (handlers.onUserVoiceStart) {
    const h = handlers.onUserVoiceStart;
    unlisteners.push(
      await tauriListen<{ audioId: string }>("user_voice_start", (p) => h(p.audioId))
    );
  }

  if (handlers.onUserVoiceText) {
    const h = handlers.onUserVoiceText;
    unlisteners.push(
      await tauriListen<{ audioId?: string; traceId: string; text: string }>("user_voice_text", (p) =>
        h(p.audioId, p.traceId, p.text)
      )
    );
  }

  if (handlers.onSentenceBoundary) {
    const h = handlers.onSentenceBoundary;
    unlisteners.push(
      await tauriListen<{ traceId: string; sentenceIndex: number; text: string }>("sentence_boundary", (p) =>
        h(p.traceId, p.sentenceIndex, p.text)
      )
    );
  }

  if (handlers.onSentencePack) {
    const h = handlers.onSentencePack;
    unlisteners.push(
      await tauriListen<{ sentenceIndex: number; text: string; audio: string; mimeType: string; sampleRate: number; traceId: string }>("sentence_pack", (p) =>
        h(p.sentenceIndex, p.text, p.audio, p.mimeType, p.sampleRate, p.traceId)
      )
    );
  }

  if (handlers.onSentencePackDone) {
    const h = handlers.onSentencePackDone;
    unlisteners.push(
      await tauriListen<{}>("sentence_pack_done", () => h())
    );
  }

  if (handlers.onMediaControl) {
    const h = handlers.onMediaControl;
    unlisteners.push(
      await tauriListen<{ action: string; message: string }>("media_control", (p) =>
        h(p.action ?? "", p.message ?? "")
      )
    );
  }

  if (handlers.onTtsAudioBegin) {
    const h = handlers.onTtsAudioBegin;
    unlisteners.push(
      await tauriListen<{ mimeType: string; codec: string; sampleRate: number }>("tts_audio_begin", (p) =>
        h(p.mimeType ?? "", p.codec ?? "", p.sampleRate ?? 0)
      )
    );
  }

  if (handlers.onTtsAudioChunk) {
    const h = handlers.onTtsAudioChunk;
    unlisteners.push(
      await tauriListen<{ data: string; mimeType: string; codec?: string; sampleRate?: number; sentenceIndex?: number }>("tts_audio_chunk", (p) =>
        h(p.data, p.mimeType, p.codec ?? "", p.sampleRate ?? 0, p.sentenceIndex)
      )
    );
  }

  if (handlers.onTtsAudioEnd) {
    const h = handlers.onTtsAudioEnd;
    unlisteners.push(
      await tauriListen<{}>("tts_audio_end", () => h())
    );
  }

  if (handlers.onDeviceStatus) {
    const h = handlers.onDeviceStatus;
    unlisteners.push(
      await tauriListen<{ connected: boolean; deviceAddr: string }>("device_status", (p) =>
        h(p.connected, p.deviceAddr ?? "")
      )
    );
  }

  if (handlers.onDeviceState) {
    const h = handlers.onDeviceState;
    unlisteners.push(
      await tauriListen<DeviceStatePayload>("device_state", (p) => h(p))
    );
  }

  if (handlers.onSessionUpdate) {
    const h = handlers.onSessionUpdate;
    unlisteners.push(
      await tauriListen<{ sessionId: string; sessionAction: string; traceId: string }>("session_update", (p) =>
        h(p.sessionId, p.sessionAction, p.traceId)
      )
    );
  }

  if (handlers.onStopTts) {
    const h = handlers.onStopTts;
    unlisteners.push(
      await tauriListen<{ traceId: string }>("stop_tts", (p) => h(p.traceId))
    );
  }

  if (handlers.onSetupProgress) {
    const h = handlers.onSetupProgress;
    unlisteners.push(
      await tauriListen<{ phase: string; message: string; done: boolean; error: boolean }>("setup_progress", (p) =>
        h(p.phase, p.message, p.done, p.error)
      )
    );
  }

  return () => {
    for (const u of unlisteners) u();
  };
}
