import type { MediaRef } from "./types";

const DEBOUNCE_MS = 300;

/**
 * Collects media refs arriving for the same traceId within a short debounce
 * window, then flushes them as a single batch.
 *
 * If a ref with a **different** traceId arrives, the current batch is flushed
 * immediately (preemption) and a new batch starts.
 */
export function createMediaQueue(
  onBatch: (refs: MediaRef[], traceId: string) => void,
) {
  let currentTraceId: string | null = null;
  let batch: MediaRef[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (batch.length > 0 && currentTraceId !== null) {
      onBatch([...batch], currentTraceId);
    }
    batch = [];
    currentTraceId = null;
  }

  function push(ref: MediaRef, traceId: string) {
    // Different trace → flush current batch immediately (preemption)
    if (currentTraceId !== null && traceId !== currentTraceId) {
      flush();
    }

    currentTraceId = traceId;
    batch.push(ref);

    // Restart debounce timer
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  return { push, flush };
}
