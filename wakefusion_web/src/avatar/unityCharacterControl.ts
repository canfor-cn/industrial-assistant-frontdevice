export type AvatarCharacter = "A" | "B";

export const CHARACTER_DEFAULT: AvatarCharacter = "A";

/**
 * Unity 工程内通过 F8 在两个角色之间 toggle。createUnityInstance 时把
 * keyboardListeningElement 指向了 canvas#unity-canvas，所以事件必须派发到 canvas，
 * 否则 Unity 收不到。
 */
export function dispatchUnityCharacterToggle(): boolean {
  if (typeof document === "undefined") return false;
  const canvas = document.getElementById("unity-canvas") as HTMLCanvasElement | null;
  const target: EventTarget = canvas ?? window;
  const init = {
    code: "F8",
    key: "F8",
    keyCode: 119,
    which: 119,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit;
  try {
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  } catch (e) {
    console.warn("[unityCharacterControl] dispatch F8 failed:", e);
    return false;
  }
}
