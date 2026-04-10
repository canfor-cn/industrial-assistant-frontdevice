import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaRef } from "./types";
import { stripPlaybackFragment } from "./types";

const AUTO_SCROLL_PX_PER_SEC = 50;
const RESUME_DELAY_MS = 5_000;

interface DocumentViewerProps {
  mediaRef: MediaRef;
  onReady: () => void;
  onInteraction: () => void;
}

/**
 * Renders a document inline using an iframe with auto-scroll.
 * Touch/scroll pauses auto-scroll; it resumes after 5 s of inactivity.
 */
export function DocumentViewer({
  mediaRef,
  onReady,
  onInteraction,
}: DocumentViewerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const [autoScrolling, setAutoScrolling] = useState(true);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyFiredRef = useRef(false);

  const playbackUrl = stripPlaybackFragment(mediaRef.url);

  // ── Auto-scroll loop ──
  const scrollStep = useCallback((timestamp: number) => {
    if (lastFrameRef.current !== null) {
      const dt = (timestamp - lastFrameRef.current) / 1000;
      const el = wrapperRef.current;
      if (el) {
        el.scrollTop += AUTO_SCROLL_PX_PER_SEC * dt;
      }
    }
    lastFrameRef.current = timestamp;
    rafRef.current = requestAnimationFrame(scrollStep);
  }, []);

  useEffect(() => {
    if (autoScrolling) {
      lastFrameRef.current = null;
      rafRef.current = requestAnimationFrame(scrollStep);
    } else {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = null;
    }
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [autoScrolling, scrollStep]);

  // ── Interaction handling ──
  const handleInteraction = useCallback(() => {
    onInteraction();
    setAutoScrolling(false);
    // Clear existing resume timer
    if (resumeTimerRef.current !== null) {
      clearTimeout(resumeTimerRef.current);
    }
    resumeTimerRef.current = setTimeout(() => {
      setAutoScrolling(true);
      resumeTimerRef.current = null;
    }, RESUME_DELAY_MS);
  }, [onInteraction]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  const handleIframeLoad = useCallback(() => {
    if (!readyFiredRef.current) {
      readyFiredRef.current = true;
      onReady();
    }
  }, [onReady]);

  return (
    <div
      className="stage-doc-viewer"
      ref={wrapperRef}
      onTouchStart={handleInteraction}
      onWheel={handleInteraction}
      onScroll={handleInteraction}
    >
      <iframe
        src={playbackUrl}
        className="stage-doc-frame"
        title={mediaRef.label}
        onLoad={handleIframeLoad}
      />
    </div>
  );
}
