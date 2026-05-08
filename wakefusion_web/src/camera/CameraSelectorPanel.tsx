/**
 * CameraSelectorPanel — 摄像头选择 + 实时预览 + 人脸 overlay。
 *
 * 数据流：
 *   - 3s 轮询 invoke("request_camera_list") → device 上行 camera_list →
 *     Tauri emit "camera_list" → 本组件 listen 更新列表
 *   - 打开面板时 invoke("start_camera_preview") → device 开始推 camera_preview →
 *     emit "camera_preview" → 本组件渲染 jpeg + face overlay
 *   - 关闭面板时 invoke("stop_camera_preview")
 *   - 选择新摄像头 → invoke("select_camera", {backend,index,name}) →
 *     device 写 config + 重启 vision_service → 新源出图 → 预览自动切换
 */

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface CameraInfo {
  index: number;
  name: string;
  backend: string;
}

interface CameraListEvent {
  cameras: CameraInfo[];
  active?: { backend: string; usb_index: number | null };
}

interface FaceData {
  x: number; y: number; w: number; h: number;
  distance_m?: number | null;
  frontal_percent?: number;
}

interface CameraPreviewEvent {
  jpeg: string;
  width: number;
  height: number;
  faces: FaceData[];
  distance_m: number | null;
  is_talking: boolean;
}

const LIST_REFRESH_MS = 3000;

export function CameraSelectorPanel({ onClose }: { onClose: () => void }) {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [activeKey, setActiveKey] = useState<string>("");  // "{backend}:{index}"
  const [pendingSelection, setPendingSelection] = useState<string>("");
  const [previewJpeg, setPreviewJpeg] = useState<string>("");
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: 640, h: 360 });
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [distance, setDistance] = useState<number | null>(null);
  const [isTalking, setIsTalking] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // 1) 启动预览 + 注册 emit listener
  useEffect(() => {
    let unlistenList: UnlistenFn | undefined;
    let unlistenPreview: UnlistenFn | undefined;
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
          const key = a.backend === "usb" ? `usb:${a.usb_index ?? 0}` : `${a.backend}:0`;
          setActiveKey(key);
          if (!pendingSelection) setPendingSelection(key);
        }
      });

      unlistenPreview = await listen<CameraPreviewEvent>("camera_preview", (ev) => {
        if (cancelled) return;
        const p = ev.payload;
        if (!p?.jpeg) return;
        setPreviewJpeg(`data:image/jpeg;base64,${p.jpeg}`);
        setPreviewSize({ w: p.width || 640, h: p.height || 360 });
        setFaces(Array.isArray(p.faces) ? p.faces : []);
        setDistance(typeof p.distance_m === "number" ? p.distance_m : null);
        setIsTalking(!!p.is_talking);
      });

      unlistenSelected = await listen<{ backend: string; index: number; name: string }>(
        "camera_selected",
        (ev) => {
          if (cancelled) return;
          setStatusMsg(`已切换到：${ev.payload.name}`);
          window.setTimeout(() => setStatusMsg(""), 3000);
        },
      );

      // 立即触发一次列表请求，避免等 3s
      try { await invoke("request_camera_list"); } catch { /* ignore */ }
    })();

    // 2) 3s 轮询列表
    const listTimer = window.setInterval(() => {
      invoke("request_camera_list").catch(() => { /* ignore */ });
    }, LIST_REFRESH_MS);

    return () => {
      cancelled = true;
      unlistenList?.();
      unlistenPreview?.();
      unlistenSelected?.();
      window.clearInterval(listTimer);
      invoke("stop_camera_preview").catch(() => { /* ignore */ });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3) 人脸 overlay 用 Canvas 画
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
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
      // faces 坐标是归一化 (0..1)
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

  return (
    <aside className="camera-settings-window" aria-label="摄像头配置">
      <div className="avatar-settings-eyebrow">CAMERA / 01 / 01</div>
      <h3 className="avatar-settings-title">Camera</h3>
      <div className="avatar-settings-rule" />

      <div className="camera-preview-box">
        {previewJpeg ? (
          <>
            <img ref={imgRef} src={previewJpeg} alt="camera preview" className="camera-preview-img" />
            <canvas ref={canvasRef} className="camera-preview-overlay" />
          </>
        ) : (
          <div className="camera-preview-placeholder">等待预览…</div>
        )}
      </div>

      <div className="camera-info-row">
        <span className="camera-info-label">faces</span>
        <span className="camera-info-value">{faces.length}</span>
        <span className="camera-info-label">distance</span>
        <span className="camera-info-value">{distance != null ? `${distance.toFixed(2)} m` : "—"}</span>
        <span className="camera-info-label">talking</span>
        <span className="camera-info-value">{isTalking ? "yes" : "no"}</span>
      </div>

      <div className="avatar-settings-row">
        <span className="avatar-settings-row-label">Device</span>
        <select
          className="camera-device-select"
          value={pendingSelection}
          onChange={(e) => setPendingSelection(e.target.value)}
        >
          {cameras.length === 0 && <option value="">—等待列表—</option>}
          {cameras.map((c) => {
            const key = `${c.backend}:${c.index}`;
            const isActive = key === activeKey;
            return (
              <option key={key} value={key}>
                {isActive ? "✓ " : ""}[{c.backend}:{c.index}] {c.name}
              </option>
            );
          })}
        </select>
      </div>

      {statusMsg ? (
        <div className="camera-status-msg">{statusMsg}</div>
      ) : null}

      <div className="avatar-settings-actions">
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
          disabled={!pendingSelection || pendingSelection === activeKey}
        >
          Apply
        </button>
      </div>
    </aside>
  );
}
