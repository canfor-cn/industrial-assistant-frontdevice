import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "wakefusion-avatar-layout-v1";

export interface AvatarLayout {
  x: number;       // px offset from center
  y: number;       // px offset from center
  scale: number;   // 0.3 .. 1.5
  opacity: number; // 0 .. 1
}

export const DEFAULT_LAYOUT: AvatarLayout = {
  x: 0,
  y: 0,
  scale: 1,
  opacity: 1,
};

export const SCALE_MIN = 0.3;
export const SCALE_MAX = 3.0;

function loadLayout(): AvatarLayout {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<AvatarLayout>;
    return {
      x: typeof parsed.x === "number" ? parsed.x : DEFAULT_LAYOUT.x,
      y: typeof parsed.y === "number" ? parsed.y : DEFAULT_LAYOUT.y,
      scale: clamp(parsed.scale ?? DEFAULT_LAYOUT.scale, SCALE_MIN, SCALE_MAX),
      opacity: clamp(parsed.opacity ?? DEFAULT_LAYOUT.opacity, 0, 1),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function useAvatarLayout() {
  const [layout, setLayoutState] = useState<AvatarLayout>(() => loadLayout());
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [layout]);

  const setLayout = useCallback((next: Partial<AvatarLayout>) => {
    setLayoutState((prev) => ({
      x: typeof next.x === "number" ? next.x : prev.x,
      y: typeof next.y === "number" ? next.y : prev.y,
      scale: typeof next.scale === "number" ? clamp(next.scale, SCALE_MIN, SCALE_MAX) : prev.scale,
      opacity: typeof next.opacity === "number" ? clamp(next.opacity, 0, 1) : prev.opacity,
    }));
  }, []);

  const setX       = useCallback((x: number) => setLayout({ x }), [setLayout]);
  const setY       = useCallback((y: number) => setLayout({ y }), [setLayout]);
  const setScale   = useCallback((scale: number) => setLayout({ scale }), [setLayout]);
  const setOpacity = useCallback((opacity: number) => setLayout({ opacity }), [setLayout]);

  const reset = useCallback(() => {
    setLayoutState({ ...DEFAULT_LAYOUT });
  }, []);

  const toggleEdit = useCallback(() => {
    setEditMode((v) => !v);
  }, []);

  // ESC exits edit mode
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditMode(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editMode]);

  return useMemo(() => ({
    layout,
    editMode,
    setLayout,
    setX,
    setY,
    setScale,
    setOpacity,
    reset,
    toggleEdit,
    setEditMode,
  }), [layout, editMode, setLayout, setX, setY, setScale, setOpacity, reset, toggleEdit]);
}

export type AvatarLayoutController = ReturnType<typeof useAvatarLayout>;
