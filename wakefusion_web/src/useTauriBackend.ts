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
export interface VoiceMessage {
  traceId: string;
  text: string;
  role: string;
  audioId?: string;
  audioData?: string; // base64
  audioMime?: string;
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
  onVoiceMessage?: (msg: VoiceMessage) => void;
  onTtsAudioChunk?: (data: string, mimeType: string) => void;
  onTtsAudioEnd?: () => void;
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

  if (handlers.onVoiceMessage) {
    const h = handlers.onVoiceMessage;
    unlisteners.push(
      await tauriListen<VoiceMessage>("voice_message", (p) => h(p))
    );
  }

  if (handlers.onTtsAudioChunk) {
    const h = handlers.onTtsAudioChunk;
    unlisteners.push(
      await tauriListen<{ data: string; mimeType: string }>("tts_audio_chunk", (p) =>
        h(p.data, p.mimeType)
      )
    );
  }

  if (handlers.onTtsAudioEnd) {
    const h = handlers.onTtsAudioEnd;
    unlisteners.push(
      await tauriListen<{}>("tts_audio_end", () => h())
    );
  }

  return () => {
    for (const u of unlisteners) u();
  };
}
