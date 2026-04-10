import { useCallback, useEffect, useRef, useState } from "react";
import { X, ZoomIn } from "lucide-react";
import type { MediaRef } from "./types";
import { stripPlaybackFragment } from "./types";

const AUTO_ROTATE_MS = 5_000;

interface ImageCarouselProps {
  refs: MediaRef[];
  currentIndex: number;
  onIndexChange: (i: number) => void;
  onReady: () => void;
  onInteraction: () => void;
}

/**
 * Displays one or more images as a carousel with auto-rotation,
 * dot indicators, swipe navigation, and a tap-to-zoom lightbox.
 */
export function ImageCarousel({
  refs,
  currentIndex,
  onIndexChange,
  onReady,
  onInteraction,
}: ImageCarouselProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const rotateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const readyFiredRef = useRef(false);

  const count = refs.length;

  // Auto-rotate
  const startRotation = useCallback(() => {
    if (rotateTimerRef.current !== null) clearInterval(rotateTimerRef.current);
    if (count <= 1) return;
    rotateTimerRef.current = setInterval(() => {
      onIndexChange((currentIndex + 1) % count);
    }, AUTO_ROTATE_MS);
  }, [count, currentIndex, onIndexChange]);

  const pauseRotation = useCallback(() => {
    if (rotateTimerRef.current !== null) {
      clearInterval(rotateTimerRef.current);
      rotateTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!lightboxOpen) startRotation();
    return pauseRotation;
  }, [lightboxOpen, startRotation, pauseRotation]);

  // Touch swipe
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      onInteraction();
      pauseRotation();
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    },
    [onInteraction, pauseRotation],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      touchStartRef.current = null;
      if (Math.abs(dx) > 50) {
        const next =
          dx < 0
            ? Math.min(currentIndex + 1, count - 1)
            : Math.max(currentIndex - 1, 0);
        onIndexChange(next);
      }
      startRotation();
    },
    [currentIndex, count, onIndexChange, startRotation],
  );

  const handleImageLoad = useCallback(() => {
    if (!readyFiredRef.current) {
      readyFiredRef.current = true;
      onReady();
    }
  }, [onReady]);

  const handleClick = useCallback(() => {
    onInteraction();
    setLightboxOpen(true);
    pauseRotation();
  }, [onInteraction, pauseRotation]);

  const closeLightbox = useCallback(() => {
    setLightboxOpen(false);
    onInteraction();
    startRotation();
  }, [onInteraction, startRotation]);

  const current = refs[currentIndex];
  if (!current) return null;

  return (
    <>
      <div
        className="stage-carousel"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onClick={handleClick}
      >
        <img
          src={stripPlaybackFragment(current.url)}
          alt={current.label}
          className="stage-carousel-image"
          onLoad={handleImageLoad}
          draggable={false}
        />
        <div className="stage-carousel-zoom-hint">
          <ZoomIn className="h-5 w-5" />
        </div>
        {count > 1 && (
          <div className="stage-carousel-dots">
            {refs.map((_, i) => (
              <button
                key={i}
                className={`stage-carousel-dot ${i === currentIndex ? "is-active" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onInteraction();
                  onIndexChange(i);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {lightboxOpen && (
        <Lightbox
          src={stripPlaybackFragment(current.url)}
          label={current.label}
          onClose={closeLightbox}
          onInteraction={onInteraction}
        />
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Lightbox sub-component
// ────────────────────────────────────────────────────────────────

interface LightboxProps {
  src: string;
  label: string;
  onClose: () => void;
  onInteraction: () => void;
}

function Lightbox({ src, label, onClose, onInteraction }: LightboxProps) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastDistRef = useRef<number | null>(null);
  const lastCenterRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      onInteraction();
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastDistRef.current = Math.hypot(dx, dy);
        lastCenterRef.current = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      } else if (e.touches.length === 1 && scale > 1) {
        dragStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          tx: translate.x,
          ty: translate.y,
        };
      }
    },
    [onInteraction, scale, translate],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2 && lastDistRef.current !== null) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const ratio = dist / lastDistRef.current;
        setScale((prev) => Math.max(1, Math.min(5, prev * ratio)));
        lastDistRef.current = dist;
        e.preventDefault();
      } else if (e.touches.length === 1 && dragStartRef.current) {
        const dx = e.touches[0].clientX - dragStartRef.current.x;
        const dy = e.touches[0].clientY - dragStartRef.current.y;
        setTranslate({
          x: dragStartRef.current.tx + dx,
          y: dragStartRef.current.ty + dy,
        });
      }
    },
    [],
  );

  const handleTouchEnd = useCallback(() => {
    lastDistRef.current = null;
    lastCenterRef.current = null;
    dragStartRef.current = null;
  }, []);

  // Double tap to reset zoom
  const lastTapRef = useRef(0);
  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    }
    lastTapRef.current = now;
  }, []);

  return (
    <div
      className="stage-lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button className="stage-lightbox-close" onClick={onClose}>
        <X className="h-6 w-6" />
      </button>
      <img
        src={src}
        alt={label}
        className="stage-lightbox-image"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
        }}
        draggable={false}
        onClick={handleDoubleTap}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
    </div>
  );
}
