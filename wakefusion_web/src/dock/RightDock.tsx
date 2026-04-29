import React from "react";
import { Phone, PhoneOff, Keyboard } from "lucide-react";

/**
 * 右下浮岛：CALL（RTC 全双工，主按钮）+ TYPE（文字输入，次按钮）。
 * Vogue 极简风：方块、衬线大写字母、accent = ink。
 */
export function RightDock({
  isCallActive,
  callDisabled,
  callDisabledReason,
  onToggleCall,
  onOpenKeyboard,
  isKeyboardOpen,
}: {
  isCallActive: boolean;
  callDisabled?: boolean;
  callDisabledReason?: string;
  onToggleCall: () => void;
  onOpenKeyboard: () => void;
  isKeyboardOpen: boolean;
}) {
  return (
    <div className="right-dock">
      <div className="right-dock-btn-wrap">
        <button
          type="button"
          className={`right-dock-btn right-dock-btn--primary ${isCallActive ? "is-active" : ""}`}
          onClick={onToggleCall}
          disabled={callDisabled}
        >
          {isCallActive ? <PhoneOff /> : <Phone />}
          <span className="right-dock-btn-label">
            {isCallActive ? "End Call" : "Call"}
          </span>
        </button>
        {callDisabled && callDisabledReason ? (
          <span className="right-dock-tooltip">{callDisabledReason}</span>
        ) : null}
      </div>

      <button
        type="button"
        className={`right-dock-btn right-dock-btn--secondary ${isKeyboardOpen ? "is-active" : ""}`}
        onClick={onOpenKeyboard}
      >
        <Keyboard />
        <span className="right-dock-btn-label">Type</span>
      </button>
    </div>
  );
}
