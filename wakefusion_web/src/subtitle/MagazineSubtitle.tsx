import React from "react";

/**
 * 单行 Vogue 字幕：当前在说话的一方独占一行，对方淡出。
 * 优先级：assistant 正在说 > user 正在说 > 隐藏。
 */
export function MagazineSubtitle({
  userText,
  userPhase,
  assistantText,
  assistantPhase,
}: {
  userText: string;
  userPhase: "hidden" | "active" | "fading";
  assistantText: string;
  assistantPhase: "hidden" | "active" | "fading";
}) {
  const showAssistant = assistantPhase !== "hidden" && assistantText.trim().length > 0;
  const showUser = !showAssistant && userPhase !== "hidden" && userText.trim().length > 0;

  if (!showAssistant && !showUser) return null;

  if (showAssistant) {
    return (
      <div className="magazine-subtitle magazine-subtitle--assistant">
        <span className={`magazine-subtitle-text ${assistantPhase === "fading" ? "is-fading" : ""}`}>
          {assistantText}
        </span>
      </div>
    );
  }

  return (
    <div className="magazine-subtitle magazine-subtitle--user">
      <span className={`magazine-subtitle-text ${userPhase === "fading" ? "is-fading" : ""}`}>
        {userText || "聆听中"}
      </span>
    </div>
  );
}
