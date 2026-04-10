import { useCallback, useRef, useState } from "react";
import type { MediaRef, MediaKind, MediaMachineState } from "./types";
import { resolveMediaKind } from "./types";

const EXIT_DURATION_MS = 420;

export interface MediaMachine {
  /** Current state of the media presentation. */
  state: MediaMachineState;
  /** All refs in the current presentation batch. */
  currentRefs: MediaRef[];
  /** Current index within the batch (for carousels). */
  currentIndex: number;
  /** Canonical kind derived from the first ref. */
  mediaKind: MediaKind;
  /** The traceId that activated the current presentation. */
  sourceTraceId: string | undefined;

  /** Activate a new batch of media refs. Handles preemption. */
  activate: (refs: MediaRef[], traceId?: string) => void;
  /** Signal that the media is loaded and ready to display. */
  ready: () => void;
  /** Signal natural playback completion (video/audio ended). */
  ended: () => void;
  /** Dismiss the current media (user action or timeout). */
  dismiss: (reason?: string) => void;
  /** Set the current carousel index. */
  setIndex: (i: number) => void;
}

export interface MediaMachineCallbacks {
  onActivate?: (refs: MediaRef[], sourceTraceId?: string) => void;
  onExit?: (reason: "ended" | "stopped" | "timeout") => void;
}

export function useMediaStateMachine(
  callbacks?: MediaMachineCallbacks,
): MediaMachine {
  const [state, setState] = useState<MediaMachineState>("idle");
  const [currentRefs, setCurrentRefs] = useState<MediaRef[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [mediaKind, setMediaKind] = useState<MediaKind>(null);
  const [sourceTraceId, setSourceTraceId] = useState<string | undefined>();

  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const transitionToIdle = useCallback(() => {
    clearExitTimer();
    setState("idle");
    setCurrentRefs([]);
    setCurrentIndex(0);
    setMediaKind(null);
    setSourceTraceId(undefined);
  }, [clearExitTimer]);

  const startExit = useCallback(
    (reason: "ended" | "stopped" | "timeout") => {
      clearExitTimer();
      setState("exiting");
      callbacksRef.current?.onExit?.(reason);
      exitTimerRef.current = setTimeout(transitionToIdle, EXIT_DURATION_MS);
    },
    [clearExitTimer, transitionToIdle],
  );

  const activate = useCallback(
    (refs: MediaRef[], traceId?: string) => {
      if (refs.length === 0) return;
      clearExitTimer();
      setCurrentRefs(refs);
      setCurrentIndex(0);
      setMediaKind(resolveMediaKind(refs));
      setSourceTraceId(traceId);
      setState("loading");
      callbacksRef.current?.onActivate?.(refs, traceId);
    },
    [clearExitTimer],
  );

  const ready = useCallback(() => {
    setState((prev) => (prev === "loading" ? "playing" : prev));
  }, []);

  const ended = useCallback(() => {
    startExit("ended");
  }, [startExit]);

  const dismiss = useCallback(
    (reason?: string) => {
      const r =
        reason === "timeout"
          ? "timeout"
          : reason === "ended"
            ? "ended"
            : "stopped";
      startExit(r as "ended" | "stopped" | "timeout");
    },
    [startExit],
  );

  const setIndex = useCallback((i: number) => {
    setCurrentIndex(i);
  }, []);

  return {
    state,
    currentRefs,
    currentIndex,
    mediaKind,
    sourceTraceId,
    activate,
    ready,
    ended,
    dismiss,
    setIndex,
  };
}
