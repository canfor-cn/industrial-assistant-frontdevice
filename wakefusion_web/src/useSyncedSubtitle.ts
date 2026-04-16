import { useCallback, useRef, useState, useEffect } from "react";

/**
 * Sentence-pack based text-audio synchronisation hook.
 *
 * Each sentence arrives as a complete pack (text + audio bundled).
 * Packs are queued and played sequentially: display text → play audio → next pack.
 * Perfect alignment guaranteed since text and audio are never separated.
 */

const FADE_DELAY_MS = 5000;
const FADE_DURATION_MS = 1200;

// ── WAV duration estimation ──

/**
 * Estimate duration (ms) from a WAV base64 string by parsing the RIFF header.
 * Falls back to a rough estimate if header is non-standard.
 */
function estimateWavDurationMs(audioBase64: string): number {
  try {
    const headerB64 = audioBase64.slice(0, 172); // 128 bytes
    const bin = atob(headerB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);

    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff !== "RIFF" || wave !== "WAVE") {
      return fallbackDuration(audioBase64);
    }

    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    const numChannels = view.getUint16(22, true);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    if (byteRate === 0) return fallbackDuration(audioBase64);

    const totalBytes = Math.floor(audioBase64.length * 3 / 4);
    const dataBytes = totalBytes - 44;
    return Math.max(0, (dataBytes / byteRate) * 1000);
  } catch {
    return fallbackDuration(audioBase64);
  }
}

function fallbackDuration(audioBase64: string): number {
  const totalBytes = Math.floor(audioBase64.length * 3 / 4);
  return Math.max(500, (totalBytes / (22050 * 2)) * 1000);
}

// ── User voice line ──

interface UserVoiceState {
  audioId: string;
  text: string;
}

// ── Sentence pack queue entry ──

interface SentencePack {
  index: number;
  text: string;
  audioBase64: string;
  durationMs: number;
  mimeType: string;
}

// ── Options ──

interface SyncedSubtitleOptions {
  onPlayAudio?: (audioBase64: string, mimeType: string) => void;
}

export function useSyncedSubtitle(options?: SyncedSubtitleOptions) {
  // ── User voice line ──
  const [userVoice, setUserVoice] = useState<UserVoiceState | null>(null);
  const [userPhase, setUserPhase] = useState<"hidden" | "active" | "fading">("hidden");
  const userFadeRef = useRef<number | null>(null);

  // ── Assistant line ──
  const [assistantText, setAssistantText] = useState("");
  const [assistantPhase, setAssistantPhase] = useState<"hidden" | "active" | "fading">("hidden");
  const assistantFadeRef = useRef<number | null>(null);

  // ── Pack queue ──
  const queueRef = useRef<SentencePack[]>([]);
  const playingRef = useRef(false);
  const doneRef = useRef(false); // sentence_pack_done received

  // ── Helpers ──

  const clearFade = (ref: React.MutableRefObject<number | null>) => {
    if (ref.current) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  };

  const startFade = useCallback((
    setPhase: (p: "hidden" | "active" | "fading") => void,
    fadeRef: React.MutableRefObject<number | null>,
    onHidden?: () => void,
  ) => {
    clearFade(fadeRef);
    fadeRef.current = window.setTimeout(() => {
      setPhase("fading");
      fadeRef.current = window.setTimeout(() => {
        setPhase("hidden");
        onHidden?.();
        fadeRef.current = null;
      }, FADE_DURATION_MS);
    }, FADE_DELAY_MS);
  }, []);

  // ── User voice API ──

  const showVoiceStart = useCallback((audioId: string) => {
    clearFade(userFadeRef);
    setUserVoice({ audioId, text: "" });
    setUserPhase("active");
  }, []);

  const showVoiceText = useCallback((_audioId: string | undefined, text: string) => {
    setUserVoice((prev) => ({ audioId: prev?.audioId ?? _audioId ?? "", text }));
    setUserPhase("active");
    startFade(setUserPhase, userFadeRef, () => setUserVoice(null));
  }, [startFade]);

  // ── Pack queue playback ──

  const tryPlayNext = useCallback(() => {
    if (playingRef.current) return;
    const pack = queueRef.current.shift();
    if (!pack) {
      // Queue empty — if all done, start fade
      if (doneRef.current) {
        startFade(setAssistantPhase, assistantFadeRef, () => setAssistantText(""));
      }
      return;
    }

    // Show text immediately
    clearFade(assistantFadeRef);
    setAssistantText(pack.text);
    setAssistantPhase("active");
    playingRef.current = true;

    // Delegate audio playback to external callback (Unity bridge)
    options?.onPlayAudio?.(pack.audioBase64, pack.mimeType);

    // Advance to next pack after estimated duration + 500ms gap
    setTimeout(() => {
      playingRef.current = false;
      tryPlayNext();
    }, pack.durationMs + 500);
  }, [startFade, options]);

  // ── Public API ──

  const pushSentencePack = useCallback((
    sentenceIndex: number,
    text: string,
    audioBase64: string,
    _mimeType: string,
  ) => {
    const durationMs = estimateWavDurationMs(audioBase64);

    queueRef.current.push({
      index: sentenceIndex,
      text,
      audioBase64,
      durationMs,
      mimeType: _mimeType,
    });

    doneRef.current = false;
    tryPlayNext();
  }, [tryPlayNext]);

  const signalPacksDone = useCallback(() => {
    doneRef.current = true;
    if (!playingRef.current && queueRef.current.length === 0) {
      startFade(setAssistantPhase, assistantFadeRef, () => setAssistantText(""));
    }
  }, [startFade]);

  // Keep old API names for backward compat (no-ops or delegated)
  const pushToken = useCallback((_text: string) => {}, []);
  const pushSentenceBoundary = useCallback((_idx: number, _text: string) => {}, []);
  const pushAudioChunk = useCallback((_idx: number, _data: ArrayBuffer) => {}, []);
  const signalAudioEnd = useCallback(() => {}, []);
  const signalTextEnd = useCallback(() => {
    signalPacksDone();
  }, [signalPacksDone]);

  // ── Reset ──

  const reset = useCallback(() => {
    queueRef.current = [];
    playingRef.current = false;
    doneRef.current = false;

    clearFade(userFadeRef);
    clearFade(assistantFadeRef);

    setUserVoice(null);
    setUserPhase("hidden");
    setAssistantText("");
    setAssistantPhase("hidden");
  }, []);

  // ── Cleanup ──
  useEffect(() => {
    return () => {
      if (userFadeRef.current) window.clearTimeout(userFadeRef.current);
      if (assistantFadeRef.current) window.clearTimeout(assistantFadeRef.current);
    };
  }, []);

  return {
    userVoice, userPhase, showVoiceStart, showVoiceText,
    assistantText, assistantPhase,
    pushSentencePack, signalPacksDone,
    // Backward compat stubs
    pushToken, pushSentenceBoundary, pushAudioChunk, signalAudioEnd, signalTextEnd,
    reset,
  };
}
