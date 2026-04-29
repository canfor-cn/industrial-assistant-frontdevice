import React, { useCallback, useEffect, useRef } from "react";
import { SendHorizontal, X } from "lucide-react";

/**
 * 衬线大字 + 下划线风格的极简输入条。回车发送，Esc 关闭。
 * onSend 由父组件接现有的 sendText() 闭包。
 */
export function KeyboardComposer({
  value,
  onChange,
  onSend,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  // Stop propagation so global hotkeys (e.g. ui-toggle hotzone) don't fire
  const stop = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
  }, []);

  return (
    <div className="keyboard-composer">
      <span className="keyboard-composer-eyebrow">Ask</span>
      <textarea
        ref={inputRef}
        className="keyboard-composer-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyDownCapture={stop}
        onKeyUpCapture={stop}
        placeholder="说点什么…"
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        lang="zh-CN"
      />
      <div className="keyboard-composer-actions">
        <button
          type="button"
          className="keyboard-composer-btn"
          onClick={onClose}
          aria-label="关闭"
        >
          <X size={14} />
        </button>
        <button
          type="button"
          className="keyboard-composer-btn keyboard-composer-btn--send"
          onClick={onSend}
          aria-label="发送"
        >
          <SendHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}
