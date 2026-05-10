import React from "react";
import type { AvatarCharacter, AvatarLayoutController } from "./useAvatarLayout";
import { SCALE_MAX, SCALE_MIN } from "./useAvatarLayout";
import { Drawer } from "../ui/Drawer";

const CHARACTER_OPTIONS: { value: AvatarCharacter; label: string }[] = [
  { value: "A", label: "角色 A" },
  { value: "B", label: "角色 B" },
];

/**
 * Avatar 配置抽屉 — 走统一 Drawer 系统。
 * Header 永远固定（含 ✕），body 滑块可滚动，footer sticky。
 */
export function AvatarSettingsPanel({
  controller,
  onClose,
}: {
  controller: AvatarLayoutController;
  onClose: () => void;
}) {
  const { layout, setX, setY, setScale, setOpacity, reset, character, setCharacter } = controller;

  return (
    <Drawer
      open
      onClose={onClose}
      eyebrow="01 / 01"
      title="Avatar"
      size="sm"
      ariaLabel="数字人布局调整"
      footer={
        <>
          <button
            type="button"
            className="avatar-settings-btn"
            onClick={reset}
          >
            Reset
          </button>
          <button
            type="button"
            className="avatar-settings-btn avatar-settings-btn--primary"
            onClick={onClose}
          >
            Done
          </button>
        </>
      }
    >
      <div className="avatar-settings-row">
        <span className="avatar-settings-row-label">Character</span>
        <div
          className="avatar-settings-segmented"
          role="radiogroup"
          aria-label="切换角色"
        >
          {CHARACTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={character === opt.value}
              className={`avatar-settings-segmented-btn ${character === opt.value ? "is-active" : ""}`}
              onClick={() => setCharacter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <Row
        label="Position X"
        min={-600}
        max={600}
        step={1}
        value={layout.x}
        onChange={setX}
        format={(v) => `${Math.round(v)} px`}
      />
      <Row
        label="Position Y"
        min={-400}
        max={400}
        step={1}
        value={layout.y}
        onChange={setY}
        format={(v) => `${Math.round(v)} px`}
      />
      <Row
        label="Scale"
        min={SCALE_MIN}
        max={SCALE_MAX}
        step={0.01}
        value={layout.scale}
        onChange={setScale}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <Row
        label="Opacity"
        min={0}
        max={1}
        step={0.01}
        value={layout.opacity}
        onChange={setOpacity}
        format={(v) => `${Math.round(v * 100)}%`}
      />
    </Drawer>
  );
}

function Row({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="avatar-settings-row">
      <span className="avatar-settings-row-label">{label}</span>
      <input
        type="range"
        className="avatar-settings-row-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="avatar-settings-row-value">{format(value)}</span>
    </div>
  );
}
