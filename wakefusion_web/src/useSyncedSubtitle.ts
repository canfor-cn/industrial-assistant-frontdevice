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

// ── User voice line ──

interface UserVoiceState {
  audioId: string;
  text: string;
}

// ── Sentence pack queue entry ──

interface SentencePack {
  index: number;
  text: string;
  audioBuffer: ArrayBuffer;
  mimeType: string;
}

export function useSyncedSubtitle() {
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
  const audioContextRef = useRef<AudioContext | null>(null);
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

    // Play audio
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const ctx = audioContextRef.current;

    ctx.decodeAudioData(pack.audioBuffer.slice(0))
      .then((decoded) => {
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        source.onended = () => {
          // 500ms pause between sentences for natural rhythm
          setTimeout(() => {
            playingRef.current = false;
            tryPlayNext();
          }, 500);
        };
        source.start();
      })
      .catch((err) => {
        console.error("[SyncSubtitle] Audio decode failed for sentence", pack.index, err);
        playingRef.current = false;
        tryPlayNext();
      });
  }, [startFade]);

  // ── Public API ──

  const pushSentencePack = useCallback((
    sentenceIndex: number,
    text: string,
    audioBase64: string,
    _mimeType: string,
  ) => {
    // Decode base64 to ArrayBuffer
    const bin = atob(audioBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    queueRef.current.push({
      index: sentenceIndex,
      text,
      audioBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

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
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
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
