import React, { useCallback, useEffect, useRef } from "react";
import { motion } from "motion/react";
import type { AvatarLayoutController } from "./useAvatarLayout";
import { SCALE_MAX, SCALE_MIN } from "./useAvatarLayout";

/**
 * Wraps the Unity Canvas with a transform-based translate/scale + opacity layer.
 *
 * - Default mode: invisible, pointer-events pass through to Unity (Unity handles its own input).
 * - Edit mode: a transparent capture overlay sits *above* the canvas to intercept pointer events
 *   for dragging; corner handles allow resize; wheel adjusts scale.
 *
 * Uses CSS transform on the outer wrapper — never resizes the canvas element itself, so the
 * Unity GL context is preserved.
 */
export function DraggableAvatarFrame({
  controller,
  children,
}: {
  controller: AvatarLayoutController;
  children: React.ReactNode;
}) {
  const { layout, editMode, setLayout, setScale } = controller;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; layoutX: number; layoutY: number } | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number; scale: number; corner: Corner } | null>(null);

  const onOverlayPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      layoutX: layout.x,
      layoutY: layout.y,
    };
  }, [layout.x, layout.y]);

  const onOverlayPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    setLayout({
      x: start.layoutX + (e.clientX - start.x),
      y: start.layoutY + (e.clientY - start.y),
    });
  }, [setLayout]);

  const onOverlayPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragStartRef.current = null;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!editMode) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setScale(layout.scale + delta);
  }, [editMode, layout.scale, setScale]);

  // wheel needs non-passive listener to call preventDefault
  useEffect(() => {
    const node = overlayRef.current;
    if (!node) return;
    if (!editMode) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      setScale(layout.scale + delta);
    };
    node.addEventListener("wheel", handler, { passive: false });
    return () => node.removeEventListener("wheel", handler);
  }, [editMode, layout.scale, setScale]);

  const onHandlePointerDown = useCallback((corner: Corner) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scale: layout.scale,
      corner,
    };
  }, [layout.scale]);

  const onHandlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    e.stopPropagation();
    // 等比缩放：取较大方向位移 / 200px ≈ 一档 1.0
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const sign = (start.corner === "se" || start.corner === "sw")
      ? (start.corner === "se" ? (dx + dy) : (-dx + dy))
      : (start.corner === "ne" ? (dx - dy) : (-dx - dy));
    const next = start.scale + sign / 320;
    setScale(Math.max(SCALE_MIN, Math.min(SCALE_MAX, next)));
  }, [setScale]);

  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    resizeStartRef.current = null;
  }, []);

  return (
    <motion.div
      style={{
        position: "absolute",
        inset: 0,
        x: layout.x,
        y: layout.y,
        scale: layout.scale,
        opacity: layout.opacity,
        transformOrigin: "center center",
      }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
    >
      {children}
      {editMode ? (
        <>
          <div
            ref={overlayRef}
            className="avatar-edit-overlay"
            onPointerDown={onOverlayPointerDown}
            onPointerMove={onOverlayPointerMove}
            onPointerUp={onOverlayPointerUp}
            onPointerCancel={onOverlayPointerUp}
            onWheel={onWheel}
          />
          <div className="avatar-edit-frame">
            <span className="avatar-edit-eyebrow">Editing · Avatar</span>
            <div
              className="avatar-edit-handle avatar-edit-handle--nw"
              onPointerDown={onHandlePointerDown("nw")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerUp}
            />
            <div
              className="avatar-edit-handle avatar-edit-handle--ne"
              onPointerDown={onHandlePointerDown("ne")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerUp}
            />
            <div
              className="avatar-edit-handle avatar-edit-handle--sw"
              onPointerDown={onHandlePointerDown("sw")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerUp}
            />
            <div
              className="avatar-edit-handle avatar-edit-handle--se"
              onPointerDown={onHandlePointerDown("se")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerUp}
            />
          </div>
        </>
      ) : null}
    </motion.div>
  );
}

type Corner = "nw" | "ne" | "sw" | "se";
