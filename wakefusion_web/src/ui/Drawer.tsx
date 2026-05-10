/**
 * Drawer — Vogue editorial 风格的统一抽屉。
 *
 * 三段式：
 *   - header：固定在顶（含 eyebrow / title / rule / × 关闭按钮）
 *   - body  ：自动 scrollable（内容超出才出现细滚动条）
 *   - footer：sticky 在底（actions 永远可见）
 *
 * 关闭方式：仅 ✕ 按钮 + ESC（点遮罩不会关 — 由用户拍板）。
 *
 * 视觉/动效全部走 index.css 的 .drawer-* 规范，保持和 Avatar / Camera
 * 等所有配置面板的一致。
 */
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

export type DrawerSize = "sm" | "md" | "lg";

export function Drawer({
  open,
  onClose,
  eyebrow,
  title,
  size = "md",
  footer,
  children,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  size?: DrawerSize;
  footer?: React.ReactNode;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const shellRef = useRef<HTMLElement | null>(null);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 打开时把焦点移到 shell（让 ESC / Tab 立刻可用）
  useEffect(() => {
    if (open) shellRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" aria-hidden="true" />
      <aside
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        className={`drawer-shell drawer-shell--${size}`}
      >
        <header className="drawer-header">
          <div className="drawer-header-text">
            {eyebrow ? <div className="drawer-eyebrow">{eyebrow}</div> : null}
            <h3 className="drawer-title">{title}</h3>
            <div className="drawer-rule" />
          </div>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </header>

        <div className="drawer-body">{children}</div>

        {footer ? <footer className="drawer-footer">{footer}</footer> : null}
      </aside>
    </>
  );
}
