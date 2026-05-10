/**
 * CameraSelectorPanel — 摄像头选择 + 实时预览 + 人脸 overlay。
 * 走统一 Drawer 系统，header 永远固定（含 ✕），body 可滚动，footer sticky。
 *
 * 双通道数据流（监控/工业 HMI 事实标准）：
 *   • 视频流 →  HTTP MJPEG (Tauri Rust :7892/preview.mjpg)
 *               浏览器 <img> 原生 multipart 解码，0 JS 开销
 *   • 元数据 →  WS `camera_preview` 事件（faces/distance/talking/width/height）
 *               用于 face box overlay + 信息行
 *
 *   - 3s 轮询 invoke("request_camera_list") → device 上行 camera_list
 *   - 选 + Apply → invoke("select_camera", {backend,index,name}) →
 *     Rust camera_capture_runtime 切换 capture session → 预览自动切换
 */

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ChevronDown, AlertCircle } from "lucide-react";
import { Drawer } from "../ui/Drawer";

interface CameraInfo {
  index: number;
  name: string;
  backend: string;
}

interface CameraListEvent {
  cameras: CameraInfo[];
  active?: { backend: string; usb_index: number | null; last_selected_name?: string };
}

interface FaceData {
  x: number; y: number; w: number; h: number;
  distance_m?: number | null;
  frontal_percent?: number;
}

interface CameraPreviewEvent {
  // jpeg 字段已被 Rust 端移除 — 视频流走 MJPEG HTTP，这里只剩 metadata
  width: number;
  height: number;
  faces: FaceData[];
  distance_m: number | null;
  is_talking: boolean;
}

interface CameraPreviewStatusEvent {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  source?: string;
}

/** MJPEG HTTP 端点 — Rust/Tauri USB capture runtime owns the camera handle. */
const MJPEG_URL = "http://127.0.0.1:7892/preview.mjpg";

const LIST_REFRESH_MS = 3000;

const keyOf = (backend: string, index: number) => `${backend}:${index}`;

export function CameraSelectorPanel({ onClose }: { onClose: () => void }) {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [activeKey, setActiveKey] = useState<string>("");
  const [lastSelectedName, setLastSelectedName] = useState<string>("");
  const [pendingSelection, setPendingSelection] = useState<string>("");
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: 640, h: 360 });
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [distance, setDistance] = useState<number | null>(null);
  const [isTalking, setIsTalking] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  // 切换摄像头时强制 <img> 重新拉 MJPEG（cache-bust）
  const [streamNonce, setStreamNonce] = useState<number>(() => Date.now());
  const [streamError, setStreamError] = useState(false);
  // 视频 FPS 来自 Rust capture runtime；分析 FPS 按 metadata 事件计数。
  const [fps, setFps] = useState<number>(0);
  const [analysisFps, setAnalysisFps] = useState<number>(0);
  const fpsTsRef = useRef<number[]>([]);
  const fpsLastEmitRef = useRef<number>(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let unlistenList: UnlistenFn | undefined;
    let unlistenPreview: UnlistenFn | undefined;
    let unlistenPreviewStatus: UnlistenFn | undefined;
    let unlistenSelected: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      try {
        await invoke("start_camera_preview");
      } catch (e) {
        console.warn("[Camera] start_camera_preview failed:", e);
      }

      unlistenList = await listen<CameraListEvent>("camera_list", (ev) => {
        if (cancelled) return;
        const list = Array.isArray(ev.payload?.cameras) ? ev.payload.cameras : [];
        setCameras(list);
        const a = ev.payload?.active;
        if (a && a.backend) {
          const k = (a.backend === "usb" || a.backend === "uvc")
            ? keyOf(a.backend, a.usb_index ?? 0)
            : keyOf(a.backend, 0);
          setActiveKey(k);
          setPendingSelection((prev) => prev || k);
        }
        setLastSelectedName(a?.last_selected_name ?? "");
      });

      unlistenPreview = await listen<CameraPreviewEvent>("camera_preview", (ev) => {
        if (cancelled) return;
        const p = ev.payload;
        // 视频流由 <img src=MJPEG_URL> 浏览器原生处理；这里只更新 overlay metadata
        setPreviewSize({ w: p.width || 640, h: p.height || 360 });
        setFaces(Array.isArray(p.faces) ? p.faces : []);
        setDistance(typeof p.distance_m === "number" ? p.distance_m : null);
        setIsTalking(!!p.is_talking);

        // FPS：滑动 1s 窗内帧数 = fps；setState 1Hz 节流（不影响视频流畅）
        const now = performance.now();
        const buf = fpsTsRef.current;
        buf.push(now);
        while (buf.length && buf[0] < now - 1000) buf.shift();
        if (now - fpsLastEmitRef.current >= 1000) {
          setAnalysisFps(buf.length);
          fpsLastEmitRef.current = now;
        }
      });

      unlistenPreviewStatus = await listen<CameraPreviewStatusEvent>("camera_preview_status", (ev) => {
        if (cancelled) return;
        const p = ev.payload;
        if (typeof p.width === "number" && typeof p.height === "number" && p.width > 0 && p.height > 0) {
          setPreviewSize({ w: p.width, h: p.height });
        }
        if (typeof p.fps === "number" && Number.isFinite(p.fps)) {
          setFps(Math.round(p.fps));
        }
      });

      unlistenSelected = await listen<{ backend: string; index: number; name: string }>(
        "camera_selected",
        (ev) => {
          if (cancelled) return;
          setStatusMsg(`已切换到：${ev.payload.name}`);
          window.setTimeout(() => setStatusMsg(""), 3000);
          // 触发 <img> 重连 MJPEG，让浏览器拿到新源的视频流
          setStreamNonce(Date.now());
        },
      );

      try { await invoke("request_camera_list"); } catch { /* ignore */ }
    })();

    const listTimer = window.setInterval(() => {
      invoke("request_camera_list").catch(() => { /* ignore */ });
    }, LIST_REFRESH_MS);

    return () => {
      cancelled = true;
      unlistenList?.();
      unlistenPreview?.();
      unlistenPreviewStatus?.();
      unlistenSelected?.();
      window.clearInterval(listTimer);
      invoke("stop_camera_preview").catch(() => { /* ignore */ });
    };
  }, []);

  // 人脸 overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = previewSize.w;
    const h = previewSize.h;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = isTalking ? "#22c55e" : "#3b82f6";
    ctx.fillStyle = isTalking ? "#22c55e" : "#3b82f6";
    ctx.font = "12px system-ui, sans-serif";
    for (const f of faces) {
      const x = (f.x ?? 0) * w;
      const y = (f.y ?? 0) * h;
      const fw = (f.w ?? 0) * w;
      const fh = (f.h ?? 0) * h;
      ctx.strokeRect(x, y, fw, fh);
      const labelParts: string[] = [];
      if (typeof f.distance_m === "number") labelParts.push(`${f.distance_m.toFixed(2)} m`);
      if (typeof f.frontal_percent === "number") labelParts.push(`正向 ${Math.round(f.frontal_percent)}%`);
      const label = labelParts.join(" | ");
      if (label) {
        const ty = Math.max(12, y - 4);
        ctx.fillText(label, x, ty);
      }
    }
  }, [faces, previewSize, isTalking]);

  function onApply() {
    if (!pendingSelection) return;
    const [backend, idxStr] = pendingSelection.split(":");
    const index = Number(idxStr) || 0;
    const cam = cameras.find((c) => c.backend === backend && c.index === index);
    invoke("select_camera", {
      backend,
      index,
      name: cam?.name ?? `${backend}:${index}`,
    }).then(() => {
      setStatusMsg("切换中…");
    }).catch((e) => {
      setStatusMsg(`切换失败：${e}`);
    });
  }

  const canApply = !!pendingSelection && pendingSelection !== activeKey;

  return (
    <Drawer
      open
      onClose={onClose}
      eyebrow="CAMERA / 01 / 01"
      title="Camera"
      size="md"
      ariaLabel="摄像头配置"
      footer={
        <>
          <button
            type="button"
            className="avatar-settings-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="avatar-settings-btn avatar-settings-btn--primary"
            onClick={onApply}
            disabled={!canApply}
          >
            Apply
          </button>
        </>
      }
    >
      {/* Preview — 视频走 MJPEG HTTP（浏览器原生），overlay 走 canvas */}
      <div className="drawer-section">
        <div className="drawer-section-title">Preview</div>
        <div className="camera-preview-box">
          {streamError ? (
            <div className="camera-preview-placeholder">
              MJPEG :7892 不可用 — 请确认 EXE 已重启且 Rust 摄像头 runtime 在跑
              <br />
              <button
                type="button"
                className="camera-stream-retry"
                onClick={() => { setStreamError(false); setStreamNonce(Date.now()); }}
              >
                重试
              </button>
            </div>
          ) : (
            <img
              src={`${MJPEG_URL}?t=${streamNonce}`}
              alt="camera preview"
              className="camera-preview-img"
              onError={() => setStreamError(true)}
              onLoad={() => setStreamError(false)}
            />
          )}
          <canvas ref={canvasRef} className="camera-preview-overlay" />
          {fps > 0 && !streamError ? (
            <div className="camera-fps-badge" aria-label="frame rate">
              {fps} <span className="camera-fps-unit">FPS</span>
            </div>
          ) : null}
        </div>
        <div className="camera-info-row">
          <span className="camera-info-label">fps</span>
          <span className="camera-info-value">{fps > 0 ? fps : "—"}</span>
          <span className="camera-info-label">analysis</span>
          <span className="camera-info-value">{analysisFps > 0 ? `${analysisFps} fps` : "—"}</span>
          <span className="camera-info-label">faces</span>
          <span className="camera-info-value">{faces.length}</span>
          <span className="camera-info-label">distance</span>
          <span className="camera-info-value">{distance != null ? `${distance.toFixed(2)} m` : "—"}</span>
          <span className="camera-info-label">talking</span>
          <span className="camera-info-value">{isTalking ? "yes" : "no"}</span>
        </div>
      </div>

      {/* Devices — 下拉选择，永远展示当前 active（即使设备未接入） */}
      <div className="drawer-section">
        <div className="drawer-section-title">Device</div>
        <CameraDeviceSelect
          cameras={cameras}
          activeKey={activeKey}
          lastSelectedName={lastSelectedName}
          pendingSelection={pendingSelection}
          onChange={setPendingSelection}
        />
      </div>

      {statusMsg ? (
        <div className="camera-status-msg">{statusMsg}</div>
      ) : null}
    </Drawer>
  );
}

/**
 * 自定义下拉：保持"当前选择"永远可见（即使设备未接入），点击展开候选。
 *
 * UX 规则（按用户要求）：
 *   - 默认显示 saved selection（来自 config.yaml 的 last_selected_name）
 *   - 即使该设备未接入，仍显示该名称 + ⚠ 未接入 标识
 *   - 展开后列出所有当前接入的设备，可点切换 pending
 *   - 从未选过 → 显示"— 选择摄像头 —"占位
 */
function CameraDeviceSelect({
  cameras,
  activeKey,
  lastSelectedName,
  pendingSelection,
  onChange,
}: {
  cameras: CameraInfo[];
  activeKey: string;
  lastSelectedName: string;
  pendingSelection: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点外面关
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = cameras.find((c) => keyOf(c.backend, c.index) === pendingSelection);
  const activeCam = cameras.find((c) => keyOf(c.backend, c.index) === activeKey);

  // "上次选择"在当前列表中找不到 → 显示"未接入"占位，并允许 pendingSelection 仍指向 activeKey
  const savedNotPresent = activeKey && !activeCam;
  const displayName =
    selected?.name ??
    (savedNotPresent ? lastSelectedName || "上次选择的设备" : "") ??
    "";
  const displaySub = selected
    ? `${selected.backend.toUpperCase()} · index ${selected.index}`
    : savedNotPresent
      ? "⚠ 设备未接入"
      : "— 选择摄像头 —";

  return (
    <div className="camera-select-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`camera-select-trigger ${open ? "is-open" : ""} ${savedNotPresent && !selected ? "is-warn" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="camera-select-meta">
          <span className="camera-select-name">{displayName || "— 选择摄像头 —"}</span>
          <span className="camera-select-sub">{displaySub}</span>
        </span>
        {savedNotPresent && !selected ? (
          <AlertCircle size={14} strokeWidth={1.5} className="camera-select-warn-icon" />
        ) : null}
        <ChevronDown size={14} strokeWidth={1.5} className={`camera-select-chevron ${open ? "is-open" : ""}`} />
      </button>

      {open ? (
        <ul className="camera-select-menu" role="listbox" aria-label="可用摄像头">
          {cameras.length === 0 ? (
            <li className="camera-select-empty">— 未发现设备 —</li>
          ) : (
            cameras.map((c) => {
              const k = keyOf(c.backend, c.index);
              const isActive = k === activeKey;
              const isPending = k === pendingSelection;
              return (
                <li
                  key={k}
                  role="option"
                  aria-selected={isPending}
                  className={`camera-select-option ${isPending ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}
                  onClick={() => {
                    onChange(k);
                    setOpen(false);
                  }}
                >
                  <span className="camera-device-dot" aria-hidden="true" />
                  <span className="camera-select-meta">
                    <span className="camera-select-name">{c.name}</span>
                    <span className="camera-select-sub">
                      {c.backend.toUpperCase()} · index {c.index}
                    </span>
                  </span>
                  {isActive ? <span className="camera-device-badge">Active</span> : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
