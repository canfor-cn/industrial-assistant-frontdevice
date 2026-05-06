import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHARACTER_DEFAULT,
  dispatchUnityCharacterToggle,
  type AvatarCharacter,
} from "./unityCharacterControl";

const STORAGE_KEY = "wakefusion-avatar-layout-v1";
const CHARACTER_STORAGE_KEY = "wakefusion-avatar-character-v1";

export interface AvatarLayout {
  x: number;       // px offset from center
  y: number;       // px offset from center
  scale: number;   // 0.3 .. 1.5
  opacity: number; // 0 .. 1
}

export type { AvatarCharacter } from "./unityCharacterControl";

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

function loadCharacter(): AvatarCharacter {
  if (typeof window === "undefined") return CHARACTER_DEFAULT;
  try {
    const raw = window.localStorage.getItem(CHARACTER_STORAGE_KEY);
    return raw === "A" || raw === "B" ? raw : CHARACTER_DEFAULT;
  } catch {
    return CHARACTER_DEFAULT;
  }
}

export function useAvatarLayout() {
  const [layout, setLayoutState] = useState<AvatarLayout>(() => loadLayout());
  const [editMode, setEditMode] = useState(false);
  const [character, setCharacterState] = useState<AvatarCharacter>(() => loadCharacter());
  // Unity 启动时默认是角色 A —— 用 ref 跟踪"已下发给 Unity 的角色"，
  // 与持久化的 character state 比对，以决定是否要补按 F8。
  const unitySyncedCharacterRef = useRef<AvatarCharacter>(CHARACTER_DEFAULT);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [layout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CHARACTER_STORAGE_KEY, character);
    } catch {
      /* quota / private mode — ignore */
    }
  }, [character]);

  // 启动时若持久化的 character 与 Unity 默认（A）不一致，等 Unity 加载完成后补按一次 F8。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (character === unitySyncedCharacterRef.current) return;

    let cancelled = false;
    const tryDispatch = () => {
      if (cancelled) return;
      const unityReady = !!(window as any).unityInstance;
      if (!unityReady) {
        window.setTimeout(tryDispatch, 300);
        return;
      }
      if (dispatchUnityCharacterToggle()) {
        unitySyncedCharacterRef.current = character;
      }
    };
    tryDispatch();
    return () => { cancelled = true; };
    // 仅在 mount 时跑一次：把持久化的初始 character 同步给刚加载完的 Unity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const setCharacter = useCallback((next: AvatarCharacter) => {
    setCharacterState((prev) => {
      if (prev === next) return prev;
      // 用户主动切换：立即下发 F8。Unity 未就绪时 dispatch 会落到 window 上没人接，
      // 但 unitySyncedCharacterRef 仍按 prev 保留，下一次 mount 的 sync effect 会自动补。
      const dispatched = dispatchUnityCharacterToggle();
      if (dispatched && (window as any).unityInstance) {
        unitySyncedCharacterRef.current = next;
      }
      return next;
    });
  }, []);

  const toggleCharacter = useCallback(() => {
    setCharacter(character === "A" ? "B" : "A");
  }, [character, setCharacter]);

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
    character,
    setCharacter,
    toggleCharacter,
  }), [layout, editMode, setLayout, setX, setY, setScale, setOpacity, reset, toggleEdit, character, setCharacter, toggleCharacter]);
}

export type AvatarLayoutController = ReturnType<typeof useAvatarLayout>;
