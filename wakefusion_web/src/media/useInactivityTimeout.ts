import { useCallback, useEffect, useRef } from "react";

/**
 * Generic inactivity timeout hook.
 * Starts a countdown when `active` is true; any call to `resetTimer` restarts it.
 * Fires `onTimeout` once when the countdown expires.
 */
export function useInactivityTimeout(
  active: boolean,
  timeoutMs: number,
  onTimeout: () => void,
): { resetTimer: () => void } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    clear();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onTimeoutRef.current();
    }, timeoutMs);
  }, [clear, timeoutMs]);

  const resetTimer = useCallback(() => {
    if (active) start();
  }, [active, start]);

  useEffect(() => {
    if (active) {
      start();
    } else {
      clear();
    }
    return clear;
  }, [active, start, clear]);

  return { resetTimer };
}
