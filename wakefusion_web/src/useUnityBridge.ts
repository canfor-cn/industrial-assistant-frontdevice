import { useCallback, useRef } from "react";

/**
 * Thin wrapper around Unity WebGL SendMessage API.
 * Manages dialogueId state and provides typed methods for the
 * dialogueStart / playAudio / interrupt protocol.
 */

function sendToUnity(objectName: string, methodName: string, arg: string) {
  const instance = (window as any).unityInstance;
  if (!instance?.SendMessage) {
    console.warn("[UnityBridge] Unity not ready, skipping:", methodName);
    return;
  }
  try {
    console.log("[UnityBridge]", methodName, arg.length > 200 ? arg.slice(0, 200) + "..." : arg);
    instance.SendMessage(objectName, methodName, arg);
  } catch (e) {
    console.error("[UnityBridge] SendMessage failed:", e);
  }
}

export function useUnityBridge() {
  const dialogueIdRef = useRef<string>("");

  const startDialogue = useCallback((dialogueId: string) => {
    dialogueIdRef.current = dialogueId;
    sendToUnity("WebCommunication", "OnDialogueStart", JSON.stringify({ dialogueId }));
  }, []);

  const playAudio = useCallback((audioBase64: string, format = "wav", sampleRate = 22050, channels = 1) => {
    const dialogueId = dialogueIdRef.current;
    if (!dialogueId) return;
    sendToUnity("WebCommunication", "OnPlayAudio", JSON.stringify({
      dialogueId,
      audioBase64,
      format,
      sampleRate,
      channels,
    }));
  }, []);

  const interrupt = useCallback(() => {
    sendToUnity("WebCommunication", "OnInterrupt", "{}");
  }, []);

  return { startDialogue, playAudio, interrupt };
}
