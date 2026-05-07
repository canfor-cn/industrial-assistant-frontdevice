import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isTauriEnv, tauriSendText, tauriSendAudio, tauriGetCachedAudio, tauriGetBackendHost, tauriGetHostStatus, tauriGetBackendWsStatus, subscribeTauriEvents, type VoiceMessage, type DeviceStatePayload } from "./useTauriBackend";
import { EditorialBackdrop } from "./background/EditorialBackdrop";
import {
  Mic,
  Image as ImageIcon,
  PlayCircle,
  Volume2,
  FileText,
  Database,
  RefreshCw,
  Trash2,
  Upload,
  Network,
  Radio,
  X,
  Maximize,
  Minimize,
  Camera,
  Eye,
  EyeOff,
  User,
  Ruler,
  Activity,
  Settings,
} from "lucide-react";
import { useMediaStateMachine } from "./media/useMediaStateMachine";
import { createMediaQueue } from "./media/mediaQueue";
import { MediaPresenter } from "./media/MediaPresenter";
import { isPlayableMedia as isPlayableMediaCheck } from "./media/types";
import type { MediaRef as MediaRefType } from "./media/types";
import { useSyncedSubtitle } from "./useSyncedSubtitle";
import { useUnityBridge } from "./useUnityBridge";
import { startUnityWsShim, stopUnityWsShim, subscribePcmPlaybackState } from "./unityWsShim";
import { useAudioActivityState } from "./useAudioActivityState";
import { PCMStreamPlayer } from "./pcmStreamPlayer";
import { WebRTCClient } from "./webrtcClient";
import { startWebrtcLipSync, type LipSyncSession } from "./webrtcLipSync";
import { useAvatarLayout } from "./avatar/useAvatarLayout";
import { DraggableAvatarFrame } from "./avatar/DraggableAvatarFrame";
import { AvatarSettingsPanel } from "./avatar/AvatarSettingsPanel";
import { RightDock } from "./dock/RightDock";
import { KeyboardComposer } from "./dock/KeyboardComposer";
import { MagazineSubtitle } from "./subtitle/MagazineSubtitle";

interface MediaRef {
  assetId: string;
  assetType: "image" | "video" | "audio" | "document" | string;
  url: string;
  label: string;
  frameUrl?: string;
  startMs?: number;
  endMs?: number;
  traceId?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  mediaRefs?: MediaRef[];
  source?: "text" | "voice";
  audioId?: string;
  audioUrl?: string;
  audioBase64?: string;
  audioMime?: string;
}

interface RagExhibit {
  id: string;
  name: string;
  exhibitCode?: string;
  category?: string;
  location?: string;
}

interface RagAsset {
  id: string;
  exhibitId?: string;
  assetType: string;
  displayName?: string;
  sourceUri?: string;
  storageUri?: string;
  status?: string;
}

interface RagJob {
  id: string;
  asset_id?: string;
  job_type: string;
  status: string;
  step?: string;
  progress?: number;
  error_msg?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface RagGraphSnapshot {
  nodes?: Array<{ id: string; label: string; type?: string }>;
  edges?: Array<{ from: string; to: string; type?: string }>;
}

interface PendingUploadItem {
  id: string;
  file: File;
  status: "selected" | "uploading" | "uploaded" | "ingesting" | "done" | "failed";
  error?: string;
}

interface MediaHistoryEntry {
  id: string;
  ref: MediaRef;
  sourceTraceId?: string;
  startedAt: number;
  endedAt?: number;
  status: "playing" | "ended" | "stopped";
}

type SinkCapableMediaElement = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

declare global {
  interface Window {
    createUnityInstance: any;
    unityInstance: any;
  }
}

export default function App() {
  const relayUrl = (import.meta.env.VITE_WAKEFUSION_RELAY_URL as string | undefined) ?? "";
  const directWsUrlDefault = (() => {
    if (typeof window === "undefined") return "ws://127.0.0.1:7790/api/voice/ws";
    const { protocol, hostname } = window.location;
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${hostname || "127.0.0.1"}:7790/api/voice/ws`;
  })();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isUnityLoaded, setIsUnityLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState("未连接");
  const [ragOpen, setRagOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [personaData, setPersonaData] = useState<Record<string, string>>({});
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaStatus, setPersonaStatus] = useState("");
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [deviceAddr, setDeviceAddr] = useState("");
  const [deviceLastSeen, setDeviceLastSeen] = useState<number | null>(null);
  const [deviceState, setDeviceState] = useState<DeviceStatePayload | null>(null);
  const [setupProgress, setSetupProgress] = useState<{ message: string; done: boolean; error: boolean } | null>(null);
  const [uiVisible, setUiVisible] = useState(false);
  const [ragTenantId, setRagTenantId] = useState("default");
  const [ragExhibits, setRagExhibits] = useState<RagExhibit[]>([]);
  const [selectedExhibitId, setSelectedExhibitId] = useState("");
  const [ragAssets, setRagAssets] = useState<RagAsset[]>([]);
  const [ragJobs, setRagJobs] = useState<RagJob[]>([]);
  const [ragQuery, setRagQuery] = useState("");
  const [ragQueryResult, setRagQueryResult] = useState("");
  const [graphSnapshot, setGraphSnapshot] = useState<RagGraphSnapshot | null>(null);
  const [newExhibitName, setNewExhibitName] = useState("");
  const [ragStatus, setRagStatus] = useState("");
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);
  const [playbackHistory, setPlaybackHistory] = useState<MediaHistoryEntry[]>([]);
  const [playbackState, setPlaybackState] = useState<"idle" | "playing" | "ended" | "stopped">("idle");
  const [stageMediaVolume, setStageMediaVolume] = useState(1);

  // 音频活动状态机：worklet 真实播放状态 + 用户说话心跳的事实记录器。
  // App.tsx 是消费者：根据 state 自己 derive 视频音量。
  // userSilenceMs=5000：用户单次说话通常 < 5s，超过则用户已结束/数字人接管。
  const audioActivity = useAudioActivityState({ userSilenceMs: 5000 });

  // 订阅 worklet "playing/idle" → 写入状态机（audio thread 精确来源）
  useEffect(() => {
    return subscribePcmPlaybackState((playing) => {
      audioActivity.setTtsPlaying(playing);
    });
  }, [audioActivity]);

  // 状态机 → 视频音量（多源取 min，最严格的源决定）
  useEffect(() => {
    let v = 1;
    if (audioActivity.state.tts.playing) v = Math.min(v, 0.2);
    if (audioActivity.state.user.speaking) v = Math.min(v, 0.1);
    setStageMediaVolume(v);
  }, [audioActivity.state]);

  // Media state machine + queue (replaces stageMediaRef / stageMode / timer refs)
  const mediaMachine = useMediaStateMachine({
    onActivate: (refs, sourceTraceId) => {
      setStageMediaVolume(1);
      setPlaybackState("playing");
      setPlaybackHistory((prev) => {
        const next = prev.map((item) =>
          item.status === "playing" ? { ...item, status: "stopped" as const, endedAt: Date.now() } : item,
        );
        return [
          {
            id: `${refs[0].assetId}-${Date.now()}`,
            ref: refs[0],
            sourceTraceId,
            startedAt: Date.now(),
            status: "playing" as const,
          },
          ...next,
        ].slice(0, 20);
      });
    },
    onExit: (reason) => {
      void exitStageFullscreen();
      setPlaybackState(reason === "ended" ? "ended" : "stopped");
      setPlaybackHistory((prev) => {
        const next = [...prev];
        const index = next.findIndex((item) => item.status === "playing");
        if (index >= 0) {
          next[index] = { ...next[index], status: reason === "ended" ? "ended" : "stopped", endedAt: Date.now() };
        }
        return next;
      });
    },
  });

  // Derived compat shims for code that still references the old names
  const stageMediaRef = mediaMachine.currentRefs[0] ?? null;
  const stageMode = mediaMachine.state === "playing" ? "media" : mediaMachine.state === "idle" ? "avatar" : mediaMachine.state;

  const mediaQueueRef = useRef(createMediaQueue((refs, traceId) => {
    mediaMachine.activate(refs, traceId);
  }));
  // Keep the queue callback in sync with the latest mediaMachine.activate
  useEffect(() => {
    mediaQueueRef.current = createMediaQueue((refs, traceId) => {
      mediaMachine.activate(refs, traceId);
    });
  }, [mediaMachine.activate]);
  const [pendingUploads, setPendingUploads] = useState<PendingUploadItem[]>([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [avatarPanelOpen, setAvatarPanelOpen] = useState(false);
  const avatarController = useAvatarLayout();

  // Live subtitle panel: sentence-level audio-text sync
  const unityBridge = useUnityBridge();
  const syncSub = useSyncedSubtitle({
    onPlayAudio: (_audioBase64, _mimeType) => {
      // 数字人音频已解耦到 ws://127.0.0.1:9876（Tauri unity_ws_server 广播）
      // React 这层不再做音频中继；这个 onPlayAudio 回调保留以便兼容 useSyncedSubtitle 接口
    },
  });
  const [preferredSinkId, setPreferredSinkId] = useState<string | null>(null);
  const [directWsBaseUrl] = useState(() => {
    if (isTauriEnv()) {
      return directWsUrlDefault;
    }
    const stored = localStorage.getItem("wakefusion.directWsBaseUrl")?.trim();
    return stored || directWsUrlDefault;
  });
  const [directToken] = useState(() => localStorage.getItem("wakefusion.directToken") ?? "test-voice-token");
  const [directDeviceId] = useState(() => localStorage.getItem("wakefusion.directDeviceId") ?? `browser-${Math.random().toString(36).slice(2, 10)}`);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const stageSurfaceRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const relaySocketRef = useRef<WebSocket | null>(null);
  const directSocketRef = useRef<WebSocket | null>(null);
  const directSocketKeyRef = useRef("");
  // AEC 模式：浏览器（非 Tauri）环境启用 MediaStream 输出 + <audio> 播放，让浏览器 AEC 识别自播放做回声消除
  // 临时关闭（通过 localStorage 开关 wakefusion.enableWebAec=1 恢复）——排查 AEC 导致麦克风收到静音的副作用
  const pcmPlayerRef = useRef<PCMStreamPlayer>(new PCMStreamPlayer({
    aecMode: !isTauriEnv() && typeof localStorage !== "undefined" && localStorage.getItem("wakefusion.enableWebAec") === "1",
  }));
  const aecAudioRef = useRef<HTMLAudioElement>(null);
  const aecBoundRef = useRef(false);
  // Web 电话半双工：TTS 播放期间上行改发静音 PCM，防止扬声器回声触发 Qwen server_vad
  const ttsPlayingRef = useRef(false);
  const ttsTailUntilRef = useRef(0);
  // WebRTC loopback 测试（PR 1）：验证浏览器 AEC 真的工作
  const webrtcClientRef = useRef<WebRTCClient | null>(null);
  const webrtcAudioRef = useRef<HTMLAudioElement>(null);
  // WebRTC 全双工对话（PR 2）：接入 Qwen
  const [isWebrtcCall, setIsWebrtcCall] = useState(false);
  const webrtcCtrlWsRef = useRef<WebSocket | null>(null);
  const webrtcLipSyncRef = useRef<LipSyncSession | null>(null);
  const webrtcDialogueIdRef = useRef<string>("");

  // 确保 pcmPlayer 的 MediaStream 已经绑到隐藏 <audio> 元素（浏览器 AEC 路径所需）
  function ensureAecBound(sampleRate: number) {
    if (isTauriEnv() || aecBoundRef.current) return;
    pcmPlayerRef.current.begin(sampleRate);
    const out = pcmPlayerRef.current.getOutputStream();
    if (out && aecAudioRef.current) {
      aecAudioRef.current.srcObject = out;
      void aecAudioRef.current.play().catch(() => { /* 需要用户手势，稍后再试 */ });
      aecBoundRef.current = true;
    }
  }
  const currentTraceRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const subtitleScrollRef = useRef<HTMLDivElement>(null);
  // (mediaReturnTimerRef and stageTransitionTimerRef removed — handled by mediaMachine)
  const subtitleEndRef = useRef<HTMLDivElement>(null);

  const connectionLabel = useMemo(() => {
    if (isWebrtcCall) return "通话中";
    return connectionStatus;
  }, [connectionStatus, isWebrtcCall]);

  const recentUniqueMedia = useMemo(() => {
    const seen = new Set<string>();
    return playbackHistory.filter((item) => {
      if (seen.has(item.ref.assetId)) return false;
      seen.add(item.ref.assetId);
      return true;
    }).slice(0, 6);
  }, [playbackHistory]);

  const [tauriBackendHost, setTauriBackendHost] = useState("127.0.0.1:7790");
  useEffect(() => {
    if (isTauriEnv()) {
      tauriGetBackendHost().then(setTauriBackendHost);
    }
  }, []);

  const ragApiBaseUrl = useMemo(() => {
    if (isTauriEnv()) {
      return `http://${tauriBackendHost}`;
    }
    try {
      const url = new URL(directWsBaseUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return "http://127.0.0.1:7790";
    }
  }, [directWsBaseUrl, tauriBackendHost]);

  const currentTurnMessages = (() => {
    const lastUserIndex = [...messages].map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex === -1) {
      return messages.slice(-1);
    }
    return messages.slice(lastUserIndex);
  })();

  const latestUserMessage = currentTurnMessages.find((message) => message.role === "user");
  const latestAssistantMessage = [...currentTurnMessages].reverse().find((message) => message.role === "assistant");
  const latestUserText = latestUserMessage?.text ?? "";
  const latestUserSource = latestUserMessage?.source ?? "text";
  const latestUserAudioId = latestUserMessage?.audioId;
  const latestUserAudioUrl = latestUserMessage?.audioUrl;
  const latestUserAudioBase64 = latestUserMessage?.audioBase64;
  const latestUserAudioMime = latestUserMessage?.audioMime;
  const hasPlayableAudio = !!(latestUserAudioId || latestUserAudioUrl || latestUserAudioBase64);
  const latestAssistantFull = latestAssistantMessage?.text ?? "";
  const latestAssistantMediaRefs = latestAssistantMessage?.mediaRefs ?? [];

  // (Old scroll effect and timer-based reveal removed — replaced by LiveSubtitlePanel)

  useEffect(() => {
    const host = stageSurfaceRef.current;
    if (!host) return;
    const media = host.querySelector("video, audio") as HTMLMediaElement | null;
    if (!media) return;
    media.volume = stageMediaVolume;
  }, [stageMediaVolume, stageMediaRef, stageMode]);

  useEffect(() => {
    let disposed = false;

    async function resolvePreferredSink() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (disposed) return;
        const sink = devices.find((device) => (
          device.kind === "audiooutput" &&
          device.label.toLowerCase().includes("xvf3800")
        ));
        setPreferredSinkId(sink?.deviceId ?? null);
      } catch (error) {
        console.warn("Resolve preferred audio sink failed", error);
        if (!disposed) {
          setPreferredSinkId(null);
        }
      }
    }

    void resolvePreferredSink();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!stageMediaRef || !isPlayableMediaCheck(stageMediaRef.assetType) || !preferredSinkId) {
      return;
    }
    const host = stageSurfaceRef.current;
    if (!host) return;
    const media = host.querySelector("video, audio") as SinkCapableMediaElement | null;
    if (!media || typeof media.setSinkId !== "function") return;
    media.setSinkId(preferredSinkId).catch((error) => {
      console.warn("Bind XVF3800 audio sink failed", error);
    });
  }, [preferredSinkId, stageMediaRef, stageMode]);

  // Tauri IPC event subscription (replaces WS when running inside Tauri host)
  useEffect(() => {
    if (!isTauriEnv()) return;
    // 不要在这里写 setConnectionStatus("已连接") —— 那只代表 WebView ↔ Tauri host
    // 真实的"后端是否可达"由 Rust 端 ws_client 通过 backend_ws_status 事件告知。
    setConnectionStatus("等待后端…");
    // Rust 端 ws connect 通常在 React 挂载之前就完成，初次 emit 的事件会丢。
    // 主动 pull 一次当前状态恢复初始 UI。
    tauriGetBackendWsStatus().then((snap) => {
      if (!snap) return;
      if (snap.connected) {
        setConnectionStatus(`已连接 (${snap.host})`);
      } else if (snap.reason && snap.reason !== "not initialized") {
        setConnectionStatus(`后端未连接：${snap.reason}`);
      }
    });
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    subscribeTauriEvents({
      onBackendWsStatus: (connected, host, reason) => {
        if (cancelled) return;
        if (connected) {
          setConnectionStatus(`已连接 (${host})`);
        } else {
          setConnectionStatus(reason ? `后端未连接：${reason}` : `后端未连接 (${host})`);
        }
      },
      onToken: (_traceId, text) => {
        if (!cancelled) syncSub.pushToken(text);
      },
      onAsrResult: () => {
        // ASR text now handled by onUserVoiceText — no longer update messages[]
      },
      onFinal: (_traceId) => {
        if (!cancelled) syncSub.signalTextEnd();
      },
      onClear: () => {
        if (!cancelled) syncSub.reset();
      },
      onMediaRef: (data) => {
        if (cancelled) return;
        const ref = normalizeMediaRef(data);
        if (isPlayableMediaCheck(ref.assetType)) {
          mediaQueueRef.current.push(ref as MediaRefType, data.traceId || "");
        }
      },
      onConnectionStatus: (_connected, message) => {
        if (!cancelled) setConnectionStatus(message);
      },
      onVoiceMessage: () => {
        // Voice display now handled by onUserVoiceStart/onUserVoiceText
      },
      onUserVoiceStart: (audioId) => {
        if (!cancelled) syncSub.showVoiceStart(audioId);
      },
      onUserVoiceText: (audioId, _traceId, text) => {
        if (!cancelled) syncSub.showVoiceText(audioId, text);
      },
      onSentencePack: (sentenceIndex, text, audio, mimeType, _sampleRate, traceId) => {
        if (cancelled) return;
        if (traceId && traceId !== currentTraceRef.current) {
          unityBridge.interrupt();
          unityBridge.startDialogue(traceId);
          currentTraceRef.current = traceId;
        }
        syncSub.pushSentencePack(sentenceIndex, text, audio, mimeType);
      },
      onSentencePackDone: () => {
        if (!cancelled) syncSub.signalPacksDone();
      },
      onTtsAudioBegin: (_mimeType, codec, sampleRate) => {
        if (cancelled) return;
        // 数字人渲染层已解耦：Unity 自己通过 ws://127.0.0.1:9876 接 audio_begin/chunk/end
        // （由 Tauri unity_ws_server 广播；message_router 在每个 audio_* 事件时同步推送一份给那个端口）。
        // React 这层不再做音频中继 —— 仅保留字幕同步、UI 状态等。
        // 保留 ensureAecBound 作为浏览器路径诊断兜底（不影响主路径）。
        if (codec === "pcm_s16le" && sampleRate > 0) {
          ensureAecBound(sampleRate);
        }
      },
      onTtsAudioChunk: (_data, _mimeType, _codec, _sampleRate) => {
        if (cancelled) return;
        // 不再调 unityBridge.playAudio —— Unity 自己从 ws 接 audio_chunk
      },
      onTtsAudioEnd: () => {
        // 不再调 unityBridge —— Unity 自己从 ws 接 audio_end
      },
      onMediaControl: (action, _message) => {
        if (!cancelled) applyMediaControl(action);
      },
      onMediaDuck: (action, _level) => {
        if (cancelled) return;
        // duck 信号现在仅作为"用户说话心跳"的入口（device speech 上行被后端节流转发）。
        // 状态机 silence timer 兜底自动恢复，不再依赖 restore 信号。
        // TTS 通道由 worklet 直接驱动，不走这条。
        if (action === "duck") audioActivity.touchUserSpeech();
      },
      onDeviceStatus: (connected, addr) => {
        if (cancelled) return;
        setDeviceConnected(connected);
        setDeviceAddr(addr);
        if (connected) setDeviceLastSeen(Date.now());
      },
      onDeviceState: (state) => {
        if (cancelled) return;
        setDeviceState(state);
        setDeviceLastSeen(Date.now());
      },
      onSessionUpdate: (_sessionId, _sessionAction, traceId) => {
        if (cancelled) return;
        unityBridge.interrupt();
        syncSub.reset();
        unityBridge.startDialogue(traceId);
        currentTraceRef.current = traceId;
      },
      onStopTts: (_traceId) => {
        if (cancelled) return;
        unityBridge.interrupt();
        syncSub.reset();
        // 同 ws-onmessage 路径：barge-in 时关掉 wiki/document MD viewer，
        // video/image/audio 保留（用户可能只是想插话不是想关视频）
        const cur = mediaMachine.currentRefs[0] as { assetType?: string } | undefined;
        if (cur && (cur.assetType === "wiki" || cur.assetType === "document")) {
          mediaMachine.dismiss("stopped");
        }
        setConnectionStatus("播放已打断");
      },
      onSetupProgress: (_phase, message, done, error) => {
        if (cancelled) return;
        if (done && !error) {
          // Install succeeded — dismiss after 2s
          setSetupProgress({ message, done, error });
          setTimeout(() => setSetupProgress(null), 2000);
        } else {
          setSetupProgress({ message, done, error });
        }
      },
    }).then((unsub) => {
      if (cancelled) {
        // Effect was cleaned up before subscription completed — immediately unsub
        unsub();
      } else {
        cleanup = unsub;
        // After subscription is active, pull initial device status.
        // Rust only emits device_status on connect/disconnect transitions, so if
        // the device connected before this component mounted we'd miss the event.
        // This recovers the current state on late mounts.
        tauriGetHostStatus().then((status) => {
          if (cancelled || !status) return;
          setDeviceConnected(status.deviceConnected);
          setDeviceAddr(status.deviceAddr);
          if (status.deviceConnected) setDeviceLastSeen(Date.now());
        });
      }
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    // Delay Unity loading so UI renders first (avoids blocking the main thread)
    const delayTimer = setTimeout(() => {
    // 注入 Unity ws 协议地址：让 Unity 自己连本地 ws://127.0.0.1:9876 接 audio_*。
    // 解耦数字人渲染层 — 未来换 Three.js / live2d 也连同一个端口即可。
    // Tauri host 在 lib.rs 启动时已起好这个 server（见 unity_ws_server.rs）。
    (window as any).UNITY_WEBSOCKET_DEFAULT_URL = "ws://127.0.0.1:9876";
    const script = document.createElement("script");
    script.src = "/Build/Build.loader.js";
    script.async = true;

    script.onload = () => {
      if (canvasRef.current) {
        canvasRef.current.id = "unity-canvas";
        canvasRef.current.tabIndex = 0;
        const config = {
          dataUrl: "/Build/Build.data",
          frameworkUrl: "/Build/Build.framework.js",
          codeUrl: "/Build/Build.wasm",
          streamingAssetsUrl: "StreamingAssets",
          companyName: "DefaultCompany",
          productName: "SZHDDigitalHumanWebGL",
          productVersion: "0.1.0",
          webglContextAttributes: {
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
          },
          keyboardListeningElement: canvasRef.current,
        };
        window.createUnityInstance(canvasRef.current, config, (progress: number) => {
          setLoadingProgress(Math.round(progress * 100));
        }).then((instance: any) => {
          window.unityInstance = instance;
          setIsUnityLoaded(true);
          // Unity 就绪后启动 ws shim：连本地 9876，把 audio_begin/chunk/end/stop_tts
          // 翻译成 SendMessage("WebCommunication", "OnAudioBegin/...") 转发给 Unity。
          // 这是从 Unity demo index.html 移植的协议适配层（详见 unityWsShim.ts）。
          startUnityWsShim("ws://127.0.0.1:9876");
        }).catch((err: any) => {
          console.error("Unity load failed", err);
        });
      }
    };

    document.body.appendChild(script);
    }, 500); // 500ms delay — let UI paint first

    return () => {
      clearTimeout(delayTimer);
      stopUnityWsShim();
    };
  }, []);

  useEffect(() => {
    if (!relayUrl) {
      return undefined;
    }

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(relayUrl);
      relaySocketRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("Relay 已连接");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "subtitle_user" && data.text) {
            const traceId = data.traceId ? String(data.traceId) : `relay-${Date.now()}`;
            let audioUrl: string | undefined;
            if (data.audioData && data.audioMime) {
              try {
                const bin = atob(data.audioData);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                audioUrl = URL.createObjectURL(new Blob([bytes], { type: data.audioMime }));
              } catch (e) {
                console.error("Failed to decode relay audio", e);
              }
            }
            // 先到先显示，后到覆盖（partial → final）
            appendUserMessage(traceId, String(data.text), "voice", audioUrl);
            return;
          }
          if (data.type === "subtitle_ai_stream" && data.text) {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant" && !last.mediaRefs?.length) {
                next[next.length - 1] = { ...last, text: `${last.text}${String(data.text)}` };
                return next;
              }
              return [...next, { id: `${Date.now()}-relay-ai`, role: "assistant", text: String(data.text) }];
            });
            return;
          }
          if (data.type === "subtitle_clear") {
            setMessages([]);
            return;
          }
          if (data.type === "media_ref" && data.url) {
            const ref = normalizeMediaRef(data);
            if (isPlayableMediaCheck(ref.assetType)) {
              mediaQueueRef.current.push(ref as MediaRefType, data.traceId ? String(data.traceId) : "");
            }
            setMessages((prev) => attachMediaToLatestAssistant(prev, ref));
            return;
          }
          if (data.type === "media_duck") {
            // duck 心跳路由到状态机；restore 信号忽略（silence timer 兜底）
            if (data.action === "duck") audioActivity.touchUserSpeech();
            return;
          }
          if (data.type === "media_control") {
            const responseText = applyMediaControl(typeof data.action === "string" ? data.action : undefined) || String(data.message ?? "");
            if (responseText) {
              setMessages((prev) => [...prev, { id: `${Date.now()}-relay-media-control`, role: "assistant", text: responseText }]);
            }
            return;
          }
        } catch (error) {
          console.error("Relay message parse failed", error);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnectionStatus("Relay 重连中");
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {};
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      relaySocketRef.current = null;
    };
  }, [relayUrl]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsStageFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (!isTauriEnv()) {
        directSocketRef.current?.close();
      }
    };
  }, []);

  async function enterStageFullscreen() {
    const host = appShellRef.current;
    if (!host || document.fullscreenElement) return false;
    try {
      await host.requestFullscreen();
      return true;
    } catch (error) {
      console.error("Enter fullscreen failed", error);
      return false;
    }
  }

  async function exitStageFullscreen() {
    if (!document.fullscreenElement) return true;
    try {
      await document.exitFullscreen();
      return true;
    } catch (error) {
      console.error("Exit fullscreen failed", error);
      return false;
    }
  }

  function buildAssistantWsUrl() {
    const url = new URL(directWsBaseUrl);
    url.searchParams.set("deviceId", directDeviceId.trim());
    url.searchParams.set("token", directToken.trim());
    return url.toString();
  }

  function resetConversation(traceId: string) {
    currentTraceRef.current = traceId;
    setMessages([]);
    setConnectionStatus("等待后端响应");
    syncSub.reset();
  }

  function appendUserMessage(traceId: string, text: string, source: "text" | "voice" = "text", audioUrl?: string, audioBase64?: string, audioMime?: string, audioId?: string) {
    setMessages((prev) => {
      const filtered = prev.filter((item) => item.id !== `${traceId}-user`);
      const previous = prev.find((item) => item.id === `${traceId}-user`);
      return [...filtered, {
        id: `${traceId}-user`,
        role: "user" as const,
        text,
        source,
        audioId: audioId ?? previous?.audioId,
        audioUrl: audioUrl ?? previous?.audioUrl,
        audioBase64: audioBase64 ?? previous?.audioBase64,
        audioMime: audioMime ?? previous?.audioMime,
      }];
    });
  }

  function ensureVoiceUserMessage(traceId: string, text = "语音识别中…", audioUrl?: string) {
    appendUserMessage(traceId, text, "voice", audioUrl);
  }

  function appendAssistantChunk(traceId: string, text: string) {
    setMessages((prev) => {
      const next = [...prev];
      const index = next.findIndex((item) => item.id === `${traceId}-assistant`);
      if (index >= 0) {
        next[index] = { ...next[index], text: `${next[index].text}${text}` };
        return next;
      }
      return [...next, { id: `${traceId}-assistant`, role: "assistant", text }];
    });
  }

  function activateStageMedia(ref: MediaRef, sourceTraceId?: string) {
    mediaQueueRef.current.push(ref as MediaRefType, sourceTraceId ?? "");
  }

  function returnToAvatar(_reason: "ended" | "stopped" = "stopped") {
    mediaMachine.dismiss(_reason);
  }

  function replayLastMedia() {
    const latest = playbackHistory[0];
    if (!latest) return false;
    mediaMachine.activate([latest.ref as MediaRefType], latest.sourceTraceId);
    return true;
  }

  function applyMediaControl(action?: string) {
    if (action === "replay_last") {
      return replayLastMedia() ? "好的，我已经为您重新播放刚刚的媒体内容。" : "当前没有可重播的媒体。";
    }
    if (action === "return_avatar" || action === "stop" || action === "pause") {
      returnToAvatar("stopped");
      return "好的，已经切回数字人讲解。";
    }
    if (action === "enter_fullscreen") {
      void enterStageFullscreen();
      return stageMediaRef ? "好的，已切换到全屏播放。" : "当前没有正在播放的媒体。";
    }
    if (action === "exit_fullscreen") {
      void exitStageFullscreen();
      return "好的，已退出全屏播放。";
    }
    return "";
  }

  function buildMediaContext() {
    const currentRef = mediaMachine.currentRefs[0] ?? null;
    return {
      media: {
        stageMode: mediaMachine.state,
        isFullscreen: isStageFullscreen,
        currentMedia: currentRef
          ? {
              assetId: currentRef.assetId,
              assetType: currentRef.assetType,
              label: currentRef.label,
              url: currentRef.url,
            }
          : null,
        recentMedia: playbackHistory.slice(0, 3).map((item) => ({
          assetId: item.ref.assetId,
          assetType: item.ref.assetType,
          label: item.ref.label,
          url: item.ref.url,
          status: item.status,
        })),
      },
    };
  }

  async function ensureAssistantSocket() {
    // In Tauri mode, WS is managed by the Rust host — no direct connection from frontend
    if (isTauriEnv()) {
      throw new Error("WS not available in Tauri mode — use invoke() instead");
    }
    const targetUrl = buildAssistantWsUrl();
    const current = directSocketRef.current;
    if (current && current.readyState === WebSocket.OPEN && directSocketKeyRef.current === targetUrl) {
      return current;
    }

    if (current) {
      current.close();
      directSocketRef.current = null;
      directSocketKeyRef.current = "";
    }

    setConnectionStatus("Assistant 连接中");

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(targetUrl);
      const timer = window.setTimeout(() => {
        ws.close();
        reject(new Error("Assistant WS 连接超时"));
      }, 8000);

      ws.onopen = () => {
        window.clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("Assistant WS 连接失败"));
      };
    });

    directSocketRef.current = socket;
    directSocketKeyRef.current = targetUrl;
    setConnectionStatus("Assistant 已连接");

    socket.onclose = () => {
      if (directSocketRef.current === socket) {
        directSocketRef.current = null;
        directSocketKeyRef.current = "";
        setConnectionStatus("Assistant 已断开");
      }
    };

    socket.onerror = () => {
      setConnectionStatus("Assistant 通信异常");
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const traceId = String(data.traceId ?? currentTraceRef.current ?? "");
        if (!traceId) return;

        if (data.type === "asr" && data.text) {
          const asrAudioId = data.audioId ? String(data.audioId) : undefined;
          // audioId alignment: discard if it doesn't match current user message
          setMessages((prev) => {
            const userMsg = prev.find((m) => m.id === `${traceId}-user`);
            if (userMsg?.audioId && asrAudioId && userMsg.audioId !== asrAudioId) {
              console.warn("ASR audioId mismatch, discarding", { expected: userMsg.audioId, got: asrAudioId });
              return prev;
            }
            const filtered = prev.filter((m) => m.id !== `${traceId}-user`);
            return [...filtered, {
              ...(userMsg ?? { id: `${traceId}-user`, role: "user" as const, source: "voice" as const }),
              text: String(data.text),
              audioId: asrAudioId ?? userMsg?.audioId,
            }];
          });
          return;
        }
        if (data.type === "audio_error") {
          setConnectionStatus("语音识别失败");
          return;
        }
        if (data.type === "audio_begin") {
          if (data.codec === "pcm_s16le" && typeof data.sampleRate === "number") {
            ensureAecBound(data.sampleRate);
            pcmPlayerRef.current.begin(data.sampleRate);
          }
          ttsPlayingRef.current = true;
          return;
        }
        if (data.type === "audio_chunk" && typeof data.data === "string") {
          const chunk = decodeBase64ToBytes(data.data);
          const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          if (data.codec === "pcm_s16le" && typeof data.sampleRate === "number") {
            pcmPlayerRef.current.push(buf, data.sampleRate);
          } else {
            const sentenceIndex = typeof data.sentenceIndex === "number" ? data.sentenceIndex : 0;
            syncSub.pushAudioChunk(sentenceIndex, buf);
          }
          return;
        }
        if (data.type === "audio_end") {
          syncSub.signalAudioEnd();
          ttsPlayingRef.current = false;
          ttsTailUntilRef.current = Date.now() + 500; // TTS 尾音保护 500ms，防扬声器衰减声被捕获
          return;
        }
        if (data.type === "sentence_boundary" && data.text) {
          const sentenceIndex = typeof data.sentenceIndex === "number" ? data.sentenceIndex : 0;
          syncSub.pushSentenceBoundary(sentenceIndex, String(data.text));
          return;
        }
        if (data.type === "token" && data.text) {
          syncSub.pushToken(String(data.text));
          return;
        }
        if (data.type === "sentence_pack" && data.text && data.audio) {
          const traceId = data.traceId || "";
          if (traceId && traceId !== currentTraceRef.current) {
            unityBridge.interrupt();
            unityBridge.startDialogue(traceId);
            currentTraceRef.current = traceId;
          }
          syncSub.pushSentencePack(
            typeof data.sentenceIndex === "number" ? data.sentenceIndex : 0,
            String(data.text),
            String(data.audio),
            String(data.mimeType ?? "audio/wav"),
          );
          return;
        }
        if (data.type === "sentence_pack_done") {
          syncSub.signalPacksDone();
          return;
        }
        if (data.type === "asr" && data.text) {
          syncSub.showVoiceText(undefined, String(data.text));
          return;
        }
        if (data.type === "media_ref" && data.url) {
          const ref = normalizeMediaRef(data);
          if (isPlayableMediaCheck(ref.assetType)) {
            mediaQueueRef.current.push(ref as MediaRefType, traceId);
          }
          return;
        }
        if (data.type === "media_control") {
          applyMediaControl(typeof data.action === "string" ? data.action : undefined);
          setConnectionStatus("媒体控制已执行");
          return;
        }
        if (data.type === "media_duck") {
          if (data.action === "duck") {
            audioActivity.touchUserSpeech();
            setConnectionStatus("媒体降音");
          }
          // restore 信号忽略：silence timer 兜底
          return;
        }
        if (data.type === "stop_tts") {
          unityBridge.interrupt();
          syncSub.reset();
          pcmPlayerRef.current.interrupt();
          // 用户 barge-in / 停止讲解时，wiki / document 类型的 MD viewer 应该自动关闭
          // （用户在换话题，长篇资料没必要继续显示）。video / image / audio 保留——
          // 用户可能只是想跟小慧聊几句，不想关掉正在看的视频。
          const cur = mediaMachine.currentRefs[0] as { assetType?: string } | undefined;
          if (cur && (cur.assetType === "wiki" || cur.assetType === "document")) {
            mediaMachine.dismiss("stopped");
          }
          setConnectionStatus("播放已打断");
          return;
        }
        if (data.type === "final") {
          syncSub.signalTextEnd();
          return;
        }
        if (data.type === "warning") {
          setConnectionStatus(String(data.message ?? "收到警告"));
          return;
        }
        if (data.type === "error") {
          setConnectionStatus(String(data.message ?? "请求失败"));
        }
      } catch (error) {
        console.error("Assistant message parse failed", error);
      }
    };

    return socket;
  }

  async function sendText() {
    const text = input.trim();
    if (!text) return;
    // Generate a local placeholder traceId for immediate UI feedback.
    // The real traceId + sessionId come from the backend in the meta event.
    const localTraceId = `browser-text-${Date.now()}`;
    // Show text input as user voice line (without voice icon since it's typed)
    syncSub.showVoiceStart(`text-${localTraceId}`);
    syncSub.showVoiceText(`text-${localTraceId}`, text);
    setInput("");
    try {
      if (isTauriEnv()) {
        await tauriSendText(text, localTraceId, directDeviceId.trim());
      } else {
        const socket = await ensureAssistantSocket();
        socket.send(JSON.stringify({
          type: "asr",
          stage: "final",
          deviceId: directDeviceId.trim(),
          text,
          context: buildMediaContext(),
        }));
      }
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : "文本发送失败");
    }
  }

  // ── WebRTC 全双工对话（PR 2）：接入 Qwen ────────────────────────────
  async function startWebrtcCall(): Promise<void> {
    if (isWebrtcCall) return;
    if (isTauriEnv()) { setConnectionStatus("Tauri 模式不支持 WebRTC 对话"); return; }
    try {
      const wsUrl = directWsBaseUrl;
      const httpBase = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/api\/voice\/ws.*$/, "");
      const deviceId = directDeviceId.trim() || `browser-${Math.random().toString(36).slice(2, 10)}`;

      // 先建控制 WS，收 media_ref / media_control / media_duck 等下行
      const ctrlWsUrl = wsUrl.replace(/\/api\/voice\/ws.*$/, `/api/voice/webrtc/control/ws?deviceId=${encodeURIComponent(deviceId)}`);
      const ctrlWs = new WebSocket(ctrlWsUrl);
      webrtcCtrlWsRef.current = ctrlWs;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("control ws connect timeout")), 5000);
        ctrlWs.onopen = () => { clearTimeout(timer); resolve(); };
        ctrlWs.onerror = () => { clearTimeout(timer); reject(new Error("control ws connect failed")); };
      });
      ctrlWs.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "media_ref") {
            const ref = normalizeMediaRef(data);
            if (isPlayableMediaCheck(ref.assetType)) {
              mediaQueueRef.current.push(ref as MediaRefType, data.traceId || deviceId);
            }
          } else if (data.type === "media_control") {
            applyMediaControl(typeof data.action === "string" ? data.action : undefined);
          } else if (data.type === "media_duck") {
            if (data.action === "duck") audioActivity.touchUserSpeech();
          }
        } catch { /* ignore */ }
      };

      // 通知 Unity：新对话开始（让数字人切换到说话状态机）
      const dialogueId = `webrtc-${Date.now()}`;
      webrtcDialogueIdRef.current = dialogueId;
      unityBridge.startDialogue(dialogueId);

      const client = new WebRTCClient({
        backendHttpUrl: httpBase,
        endpoint: "/api/voice/webrtc/offer",
        deviceId,
        onConnected: () => setConnectionStatus("WebRTC 对话已接通（和 Qwen 说话）"),
        onClosed: (r) => setConnectionStatus(`WebRTC 已断开：${r}`),
        onError: (e) => setConnectionStatus(`WebRTC 错误：${e.message}`),
        onRemoteStream: (stream) => {
          // ⚠️ 浏览器 <audio> 必须出声、不能 muted。
          // 浏览器 RTC AEC 把 <audio> 输出当作 echo reference signal —
          // muted=true 会让 AEC 失效，Unity 的扬声器输出被麦克风采集回去触发
          // server VAD 死循环，Qwen 永远说不完一句话就被打断。
          //
          // 所以：浏览器独占出声 + AEC 正常。Unity 嘴型同步暂时关掉，
          // 等找到 Unity 端"只接收 envelope 不出声"的接口后再做。
          if (webrtcAudioRef.current) {
            webrtcAudioRef.current.srcObject = stream;
            webrtcAudioRef.current.muted = false;
            void webrtcAudioRef.current.play().catch(() => {});
          }
        },
      });
      webrtcClientRef.current = client;
      await client.start();
      setIsWebrtcCall(true);
    } catch (err) {
      setConnectionStatus(err instanceof Error ? err.message : "WebRTC 对话启动失败");
      webrtcClientRef.current?.stop();
      webrtcClientRef.current = null;
    }
  }

  function stopWebrtcCall(): void {
    webrtcClientRef.current?.stop();
    webrtcClientRef.current = null;
    try { webrtcCtrlWsRef.current?.close(); } catch { /* ignore */ }
    webrtcCtrlWsRef.current = null;
    try { webrtcLipSyncRef.current?.stop(); } catch { /* ignore */ }
    webrtcLipSyncRef.current = null;
    try { unityBridge.interrupt(); } catch { /* ignore */ }
    webrtcDialogueIdRef.current = "";
    if (webrtcAudioRef.current) webrtcAudioRef.current.srcObject = null;
    setIsWebrtcCall(false);
    setConnectionStatus("WebRTC 对话已结束");
  }

  function decodeBase64ToBytes(data: string) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * 把 base64 编码的 raw PCM (s16le) 包成 base64 编码的 WAV，
   * 让 Unity OnPlayAudio (期望 wav 格式) 能直接吃。
   * 每个 audio_chunk 独立打 header，Unity 内部排队播放。
   */
  function wrapPcmAsWavBase64(pcmBase64: string, sampleRate: number, channels: number): string {
    const pcm = decodeBase64ToBytes(pcmBase64);
    const byteRate = sampleRate * channels * 2;
    const blockAlign = channels * 2;
    const wavLen = 44 + pcm.byteLength;
    const buf = new ArrayBuffer(wavLen);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, wavLen - 8, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                  // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);                 // bits per sample
    writeStr(36, "data");
    view.setUint32(40, pcm.byteLength, true);
    new Uint8Array(buf, 44).set(pcm);
    // base64 编码
    const all = new Uint8Array(buf);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < all.length; i += step) {
      binary += String.fromCharCode.apply(null, Array.from(all.subarray(i, i + step)));
    }
    return btoa(binary);
  }

  // (Old TTS playback functions removed — audio playback now handled by useSyncedSubtitle)

  async function ragFetch(path: string, init?: RequestInit) {
    const requestUrl = `${ragApiBaseUrl}${path}`;
    const response = await fetch(requestUrl, init);
    const text = await response.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Invalid JSON from ${requestUrl}: ${text.slice(0, 120)}`);
    }
    if (!response.ok) {
      throw new Error(data?.error ?? `Request failed: ${response.status}`);
    }
    return data;
  }

  async function refreshRagExhibits() {
    setRagStatus("正在加载 RAG 列表");
    const data = await ragFetch(`/rag/exhibits?tenantId=${encodeURIComponent(ragTenantId)}`);
    const exhibits = Array.isArray(data.exhibits) ? data.exhibits as RagExhibit[] : [];
    setRagExhibits(exhibits);
    setRagStatus(`已加载 ${exhibits.length} 个展品`);
    if (exhibits.length && !selectedExhibitId) {
      setSelectedExhibitId(exhibits[0].id);
    }
    if (!exhibits.length) {
      setSelectedExhibitId("");
      setRagAssets([]);
    }
  }

  async function refreshRagAssets(exhibitId: string) {
    if (!exhibitId) {
      setRagAssets([]);
      return;
    }
    setRagStatus("正在加载文件列表");
    const data = await ragFetch(`/rag/exhibits/${encodeURIComponent(exhibitId)}/assets?tenantId=${encodeURIComponent(ragTenantId)}`);
    setRagAssets(Array.isArray(data.assets) ? data.assets as RagAsset[] : []);
    setRagStatus(`当前展品文件 ${Array.isArray(data.assets) ? data.assets.length : 0} 个`);
  }

  async function refreshRagJobs() {
    const data = await ragFetch(`/rag/jobs?tenantId=${encodeURIComponent(ragTenantId)}&limit=20`);
    const jobs = Array.isArray(data.jobs) ? data.jobs as RagJob[] : [];
    const deduped = new Map<string, RagJob>();
    for (const job of jobs) {
      const key = job.asset_id ? `${job.asset_id}:${job.job_type.replace(/^reindex_/, "ingest_")}` : job.id;
      if (!deduped.has(key)) {
        deduped.set(key, job);
      }
    }
    setRagJobs(Array.from(deduped.values()));
  }

  async function refreshRagStatus() {
    const data = await ragFetch("/rag/status");
    const fixedId = typeof data.tenantId === "string" && data.tenantId.trim() ? data.tenantId.trim() : "default";
    setRagTenantId(fixedId);
    setRagStatus(`队列 ${Number(data.queueSize ?? 0)} · 固定 RAG ID：${fixedId}`);
  }

  async function createExhibit() {
    const name = newExhibitName.trim();
    if (!name) {
      setRagStatus("展品名称不能为空");
      return;
    }
    setRagStatus("正在创建展品");
    const data = await ragFetch("/rag/exhibits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: ragTenantId, name }),
    });
    setNewExhibitName("");
    await Promise.all([refreshRagExhibits(), refreshRagJobs(), refreshRagStatus()]);
    if (data.id) {
      setSelectedExhibitId(String(data.id));
      await refreshRagAssets(String(data.id));
    }
  }

  async function deleteAsset(assetId: string) {
    if (!assetId) return;
    setRagStatus("正在删除文件");
    await ragFetch(`/rag/assets/${encodeURIComponent(assetId)}?tenantId=${encodeURIComponent(ragTenantId)}`, {
      method: "DELETE",
    });
    await Promise.all([
      selectedExhibitId ? refreshRagAssets(selectedExhibitId) : Promise.resolve(),
      refreshRagJobs(),
      loadGraph(),
    ]);
  }

  async function uploadAsset(file: File) {
    try {
      if (!selectedExhibitId) {
        setRagStatus("请先创建或选择展品");
        return;
      }
      const uploadId = `${file.name}-${file.size}-${file.lastModified}`;
      setPendingUploads((prev) => prev.map((item) => (
        item.id === uploadId ? { ...item, status: "uploading", error: undefined } : item
      )));
      setRagStatus(`正在上传 ${file.name}`);
      const formData = new FormData();
      formData.append("file", file, file.name);
      const uploadResponse = await fetch(`${ragApiBaseUrl}/rag/upload`, {
        method: "POST",
        body: formData,
      });
      const uploadText = await uploadResponse.text();
      const upload = uploadText ? JSON.parse(uploadText) : {};
      if (!uploadResponse.ok) {
        throw new Error(upload?.error ?? `上传失败: ${uploadResponse.status}`);
      }
      setPendingUploads((prev) => prev.map((item) => (
        item.id === uploadId ? { ...item, status: "uploaded" } : item
      )));
      setPendingUploads((prev) => prev.map((item) => (
        item.id === uploadId ? { ...item, status: "ingesting" } : item
      )));
      await ragFetch("/rag/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: ragTenantId,
          exhibitId: selectedExhibitId,
          sourceType: inferSourceType(file),
          sourceUri: upload.path,
          meta: { title: file.name },
        }),
      });
      await Promise.all([refreshRagAssets(selectedExhibitId), refreshRagJobs(), refreshRagStatus()]);
      setPendingUploads((prev) => prev.map((item) => (
        item.id === uploadId ? { ...item, status: "done" } : item
      )));
      setRagStatus(`${file.name} 已进入索引队列，下面可查看进度和失败原因`);
    } catch (error) {
      console.error("RAG upload failed", error);
      const uploadId = `${file.name}-${file.size}-${file.lastModified}`;
      const message = error instanceof Error ? error.message : "上传失败";
      setPendingUploads((prev) => prev.map((item) => (
        item.id === uploadId ? { ...item, status: "failed", error: message } : item
      )));
      setRagStatus(`上传失败：${message}`);
    }
  }

  async function uploadPendingFiles() {
    const queued = pendingUploads.filter((item) => item.status === "selected" || item.status === "failed");
    if (!queued.length) {
      setRagStatus("请先选择文件");
      return;
    }
    for (const item of queued) {
      await uploadAsset(item.file);
    }
  }

  function removePendingUpload(id: string) {
    setPendingUploads((prev) => prev.filter((item) => item.id !== id));
  }

  async function queryRag() {
    const query = ragQuery.trim();
    if (!query) {
      setRagQueryResult("请输入检索问题");
      return;
    }
    setRagQueryResult("检索中...");
    const data = await ragFetch("/rag/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: ragTenantId, query, topK: 8 }),
    });
    setRagQueryResult(JSON.stringify(data, null, 2));
  }

  async function loadGraph() {
    setRagStatus("正在加载图谱");
    const data = await ragFetch(`/rag/graph?tenantId=${encodeURIComponent(ragTenantId)}&limit=50`);
    setGraphSnapshot(data as RagGraphSnapshot);
    setRagStatus("图谱已刷新");
  }

  useEffect(() => {
    if (!ragOpen) return;
    void (async () => {
      try {
        await Promise.all([refreshRagStatus(), refreshRagExhibits(), refreshRagJobs(), loadGraph()]);
      } catch (error) {
        setRagStatus(`RAG 加载失败：${String(error)}`);
      }
    })();
  }, [ragOpen]);

  // Auto-load persona when panel opens
  useEffect(() => {
    if (!personaOpen) return;
    void (async () => {
      try {
        const res = await fetch(`${ragApiBaseUrl}/api/persona`);
        if (res.ok) {
          const data = await res.json();
          setPersonaData(data);
          setPersonaStatus("");
        }
      } catch (e) {
        setPersonaStatus(`加载失败: ${String(e)}`);
      }
    })();
  }, [personaOpen]);

  useEffect(() => {
    if (!ragOpen || !selectedExhibitId) return;
    void refreshRagAssets(selectedExhibitId);
  }, [selectedExhibitId, ragOpen]);

  useEffect(() => {
    if (!ragOpen) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          await Promise.all([refreshRagJobs(), refreshRagStatus()]);
        } catch (error) {
          setRagStatus(`RAG 刷新失败：${String(error)}`);
        }
      })();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [ragOpen, ragTenantId]);

  const anyDrawerOpen = devicePanelOpen || ragOpen || personaOpen;

  return (
    <div className={`app-shell ${anyDrawerOpen ? "is-drawer-open" : ""}`} ref={appShellRef}>
      {/* AEC 辅助：隐藏的 <audio> 播放 pcmPlayer 的 MediaStream 输出，让浏览器 AEC 识别 */}
      <audio ref={aecAudioRef} autoPlay playsInline style={{ display: "none" }} />
      {/* WebRTC 测试：隐藏 <audio> 播放 RTCPeerConnection 的 remote stream（浏览器 AEC 自动生效） */}
      <audio ref={webrtcAudioRef} autoPlay playsInline style={{ display: "none" }} />
      {/* Setup progress overlay */}
      {setupProgress && !setupProgress.done && (
        <div className="setup-overlay">
          <div className="setup-overlay-content">
            <div className="setup-overlay-spinner" />
            <div className="setup-overlay-message">{setupProgress.message}</div>
          </div>
        </div>
      )}
      {setupProgress && setupProgress.done && setupProgress.error && (
        <div className="setup-overlay is-error">
          <div className="setup-overlay-content">
            <div className="setup-overlay-icon">!</div>
            <div className="setup-overlay-message">{setupProgress.message}</div>
            <div className="setup-overlay-hint">详情请查看 pip-install.log</div>
            <button className="setup-overlay-dismiss" onClick={() => setSetupProgress(null)}>关闭</button>
          </div>
        </div>
      )}
      {/* Layer 0-1: Full-screen stage */}
      <div className="stage-fullscreen" ref={stageSurfaceRef}>
        {!isUnityLoaded && (
          <div className="unity-loading">
            <div className="unity-loading-ring" />
            <div>{loadingProgress}%</div>
          </div>
        )}
        <EditorialBackdrop dimmed={stageMode === "media" || stageMode === "loading"} />
        <DraggableAvatarFrame controller={avatarController}>
          <div className={`stage-avatar-shell ${stageMode === "media" || stageMode === "loading" ? "is-dimmed" : ""}`}>
            <canvas ref={canvasRef} className="unity-canvas" />
          </div>
        </DraggableAvatarFrame>
        <MediaPresenter machine={mediaMachine} volume={stageMediaVolume} />
      </div>

      {/* Layer 2-3: Floating UI overlay */}
      <div className="ui-overlay">
        {/* Top-right: double-click hotzone to toggle UI */}
        <div
          className="ui-toggle-hotzone"
          onDoubleClick={() => setUiVisible((v) => !v)}
        />

        {/* 顶左品牌 lockup 已移除：品牌渲染只保留在 EditorialBackdrop 顶部刊头，避免重复 */}

        {/* Top-right: status + fullscreen + management */}
        {uiVisible && (
          <header className="overlay-header">
            <div className={`overlay-status ${isWebrtcCall ? "is-recording" : ""}`}>{connectionLabel}</div>
            <button
              type="button"
              className="overlay-btn"
              onClick={() => void (isStageFullscreen ? exitStageFullscreen() : enterStageFullscreen())}
              aria-label={isStageFullscreen ? "退出全屏" : "全屏"}
            >
              {isStageFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className={`overlay-btn ${avatarController.editMode ? "is-active" : ""}`}
              onClick={() => {
                avatarController.toggleEdit();
                setAvatarPanelOpen((v) => !v);
              }}
              aria-label="调整数字人位置/大小"
              title="调整数字人"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={`overlay-btn ${deviceConnected ? "is-device-online" : "is-device-offline"}`}
              onClick={() => setDevicePanelOpen(true)}
              aria-label="设备状态"
            >
              <Radio className="h-4 w-4" />
            </button>
            <button type="button" className="overlay-btn" onClick={() => setRagOpen(true)} aria-label="打开知识库管理">
              <Database className="h-4 w-4" />
            </button>
            <button type="button" className="overlay-btn" onClick={() => setPersonaOpen(true)} aria-label="人设管理">
              <User className="h-4 w-4" />
            </button>
          </header>
        )}

        {/* Avatar settings floating window (Vogue editorial) */}
        {avatarPanelOpen ? (
          <AvatarSettingsPanel
            controller={avatarController}
            onClose={() => {
              avatarController.setEditMode(false);
              setAvatarPanelOpen(false);
            }}
          />
        ) : null}

        {/* Left-bottom: media history (max 3, text cards) */}
        {uiVisible && recentUniqueMedia.length > 0 ? (
          <div className="media-history">
            {recentUniqueMedia.slice(0, 3).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`history-card is-${item.status}`}
                onClick={() => mediaMachine.activate([item.ref as MediaRefType], item.sourceTraceId)}
              >
                <span className="history-card-text">{item.ref.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Idle hint */}
        {uiVisible && currentTurnMessages.length === 0 && stageMode === "avatar" ? (
          <div className="stage-idle-hint">tap call · 开始对话</div>
        ) : null}

        {/* Live subtitle (Vogue editorial) — always visible, not controlled by uiVisible */}
        <MagazineSubtitle
          userText={syncSub.userVoice?.text ?? ""}
          userPhase={syncSub.userPhase}
          assistantText={syncSub.assistantText}
          assistantPhase={syncSub.assistantPhase}
        />

        {/* Right dock: Call (RTC) + Type (keyboard) */}
        {uiVisible ? (
          <RightDock
            isCallActive={isWebrtcCall}
            callDisabled={isTauriEnv()}
            callDisabledReason={isTauriEnv() ? "请在浏览器中使用" : undefined}
            onToggleCall={() => void (isWebrtcCall ? stopWebrtcCall() : startWebrtcCall())}
            onOpenKeyboard={() => setKeyboardOpen((v) => !v)}
            isKeyboardOpen={keyboardOpen}
          />
        ) : null}

        {/* Keyboard composer (Vogue inline input) */}
        {uiVisible && keyboardOpen ? (
          <KeyboardComposer
            value={input}
            onChange={setInput}
            onSend={() => {
              void sendText();
              setKeyboardOpen(false);
            }}
            onClose={() => setKeyboardOpen(false)}
          />
        ) : null}
      </div>

      {/* Device status panel */}
      {devicePanelOpen ? (
        <aside className="rag-drawer">
          <div className="rag-drawer-backdrop" onClick={() => setDevicePanelOpen(false)} />
          <div className="rag-panel device-panel">
            <header className="rag-panel-header">
              <div>
                <div className="rag-eyebrow">Device</div>
                <h3>设备状态</h3>
              </div>
              <button type="button" className="icon-button" onClick={() => setDevicePanelOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="device-panel-body">
              {/* Section: Connection */}
              <div className="device-section">
                <div className="device-section-title">
                  <Radio className="h-3.5 w-3.5" />
                  <span>连接</span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">设备</span>
                  <span className={`device-status-badge ${deviceConnected ? "is-online" : "is-offline"}`}>
                    {deviceConnected ? "在线" : "离线"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">后端</span>
                  <span className={`device-status-badge ${connectionStatus.includes("已连接") || connectionStatus.includes("ready") || connectionStatus.includes("Tauri") ? "is-online" : "is-offline"}`}>
                    {connectionStatus}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">设备地址</span>
                  <span className="device-status-value">{deviceAddr || "—"}</span>
                </div>
              </div>

              {/* Section: Vision (Camera) */}
              <div className="device-section">
                <div className="device-section-title">
                  <Camera className="h-3.5 w-3.5" />
                  <span>摄像头</span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">硬件</span>
                  <span className={`device-status-badge ${deviceState?.hardware?.cameraReady === false ? "is-offline" : "is-online"}`}>
                    {deviceState?.hardware?.cameraReady === false ? "未就绪 (摄像头未检测到)" : "就绪"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">
                    <User className="h-3 w-3" style={{display:'inline',verticalAlign:'middle',marginRight:4}} />
                    人脸
                  </span>
                  <span className="device-status-value device-value-highlight">
                    {deviceState?.vision?.faces ?? "—"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">
                    <Ruler className="h-3 w-3" style={{display:'inline',verticalAlign:'middle',marginRight:4}} />
                    距离
                  </span>
                  <span className="device-status-value">
                    {deviceState?.vision?.distance_m != null ? `${deviceState.vision.distance_m.toFixed(1)}m` : "—"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">唇动</span>
                  <span className={`device-status-badge ${deviceState?.vision?.is_talking ? "is-online" : "is-muted"}`}>
                    {deviceState?.vision?.is_talking ? "说话中" : "静止"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">视觉唤醒</span>
                  <span className={`device-status-badge ${deviceState?.vision?.active ? "is-online" : "is-muted"}`}>
                    {deviceState?.vision?.active ? "激活" : "未激活"}
                  </span>
                </div>
              </div>

              {/* Section: Audio (Microphone) */}
              <div className="device-section">
                <div className="device-section-title">
                  <Mic className="h-3.5 w-3.5" />
                  <span>麦克风</span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">硬件</span>
                  <span className={`device-status-badge ${deviceState?.hardware?.micReady === false ? "is-offline" : "is-online"}`}>
                    {deviceState?.hardware?.micReady === false ? "未就绪 (XVF3800 未检测到)" : "就绪"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">
                    <Activity className="h-3 w-3" style={{display:'inline',verticalAlign:'middle',marginRight:4}} />
                    状态
                  </span>
                  <span className={`device-status-badge ${
                    deviceState?.hardware?.micReady === false ? "is-offline" :
                    deviceState?.state === "listening" ? "is-listening" :
                    deviceState?.state === "speaking" ? "is-speaking" :
                    deviceState?.state === "thinking" ? "is-thinking" :
                    "is-muted"
                  }`}>
                    {deviceState?.hardware?.micReady === false ? "不可用" :
                     deviceState?.state === "listening" ? "拾音中" :
                     deviceState?.state === "speaking" ? "播报中" :
                     deviceState?.state === "thinking" ? "思考中" :
                     deviceState?.state === "idle" ? "空闲" : "未知"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">交互模式</span>
                  <span className={`device-status-badge ${deviceState?.audio?.interactive ? "is-online" : "is-muted"}`}>
                    {deviceState?.audio?.interactive ? "对话中" : "待机"}
                  </span>
                </div>
                <div className="device-status-row">
                  <span className="device-status-label">TTS</span>
                  <span className={`device-status-badge ${deviceState?.audio?.tts_playing ? "is-speaking" : "is-muted"}`}>
                    {deviceState?.audio?.tts_playing ? "播放中" : "静默"}
                  </span>
                </div>
              </div>

              {/* Footer: last seen */}
              {deviceLastSeen ? (
                <div className="device-status-row device-footer">
                  <span className="device-status-label">最后更新</span>
                  <span className="device-status-value">{new Date(deviceLastSeen).toLocaleTimeString()}</span>
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      ) : null}

      {/* RAG drawer */}
      {ragOpen ? (
        <aside className="rag-drawer">
          <div className="rag-drawer-backdrop" onClick={() => setRagOpen(false)} />
          <div className="rag-panel">
            <header className="rag-panel-header">
              <div>
                <div className="rag-eyebrow">RAG Control</div>
                <h3>知识库管理</h3>
              </div>
              <button type="button" className="icon-button" onClick={() => setRagOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="rag-toolbar">
              <div className="rag-fixed-id">
                <span>固定 RAG ID</span>
                <strong>{ragTenantId}</strong>
              </div>
              <button type="button" className="rag-button" onClick={() => void refreshRagExhibits()}>
                <RefreshCw className="h-4 w-4" />
                刷新
              </button>
            </div>

            <div className="rag-create-row">
              <input
                value={newExhibitName}
                onChange={(event) => setNewExhibitName(event.target.value)}
                placeholder="新建展品名称"
              />
              <button type="button" className="rag-button" onClick={() => void createExhibit()}>
                创建展品
              </button>
            </div>

            <div className="rag-sections">
              <section className="rag-card">
                <div className="rag-card-title">文件列表</div>
                <div className="rag-exhibit-list">
                  {ragExhibits.length ? ragExhibits.map((exhibit) => (
                    <button
                      key={exhibit.id}
                      type="button"
                      className={`rag-exhibit-item ${selectedExhibitId === exhibit.id ? "is-active" : ""}`}
                      onClick={() => setSelectedExhibitId(exhibit.id)}
                    >
                      <strong>{exhibit.name}</strong>
                      <small>{exhibit.id}</small>
                    </button>
                  )) : <div className="rag-empty">暂无展品</div>}
                </div>
                <div className="rag-assets">
                  {ragAssets.length ? ragAssets.map((asset) => (
                    <div key={asset.id} className="rag-asset-row">
                      <div className="rag-asset-meta">
                        <strong>{asset.displayName ?? asset.storageUri ?? asset.sourceUri ?? asset.id}</strong>
                        <small>{asset.assetType} · {asset.status ?? "unknown"}</small>
                      </div>
                      <button type="button" className="icon-button" onClick={() => void deleteAsset(asset.id)}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )) : <div className="rag-empty">当前展品暂无文件</div>}
                </div>
                <div className="rag-upload-row">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length) {
                        setPendingUploads((prev) => {
                          const existing = new Map(prev.map((item) => [item.id, item]));
                          for (const file of files) {
                            const id = `${file.name}-${file.size}-${file.lastModified}`;
                            if (!existing.has(id)) {
                              existing.set(id, { id, file, status: "selected" });
                            }
                          }
                          return Array.from(existing.values());
                        });
                        setRagStatus(`已选择 ${files.length} 个文件，点击“上传入库”开始处理`);
                      }
                      event.currentTarget.value = "";
                    }}
                  />
                  <button type="button" className="rag-button" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="h-4 w-4" />
                    选择文件
                  </button>
                  <button type="button" className="rag-button" onClick={() => void uploadPendingFiles()}>
                    <Upload className="h-4 w-4" />
                    上传入库
                  </button>
                </div>
                <div className="rag-upload-queue">
                  {pendingUploads.length ? pendingUploads.map((item) => (
                    <div key={item.id} className={`rag-upload-item is-${item.status}`}>
                      <div className="rag-upload-item-meta">
                        <strong>{item.file.name}</strong>
                        <small>{formatBytes(item.file.size)} · {formatUploadStatus(item.status)}</small>
                        {item.error ? <div className="rag-job-error">{item.error}</div> : null}
                      </div>
                      <button type="button" className="icon-button" onClick={() => removePendingUpload(item.id)}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )) : <div className="rag-empty">未选择文件</div>}
                </div>
              </section>

              <section className="rag-card">
                <div className="rag-card-header">
                  <div className="rag-card-title">入库任务</div>
                  <button type="button" className="rag-button" onClick={() => void refreshRagJobs()}>
                    <RefreshCw className="h-4 w-4" />
                    刷新任务
                  </button>
                </div>
                <div className="rag-jobs">
                  {ragJobs.length ? ragJobs.map((job) => (
                    <div key={job.id} className={`rag-job-row is-${job.status}`}>
                      <div className="rag-job-main">
                        <strong>{job.job_type}</strong>
                        <small>{formatJobStep(job.step)} · {job.progress ?? 0}% · {job.status}</small>
                        {job.error_msg ? <div className="rag-job-error">{job.error_msg}</div> : null}
                      </div>
                    </div>
                  )) : <div className="rag-empty">暂无任务</div>}
                </div>
              </section>

              <section className="rag-card">
                <div className="rag-card-title">检索</div>
                <div className="rag-query-row">
                  <textarea value={ragQuery} onChange={(event) => setRagQuery(event.target.value)} placeholder="输入检索问题" />
                  <button type="button" className="rag-button" onClick={() => void queryRag()}>
                    <Database className="h-4 w-4" />
                    检索
                  </button>
                </div>
                <pre className="rag-output">{ragQueryResult || "暂无检索结果"}</pre>
              </section>

              <section className="rag-card">
                <div className="rag-card-header">
                  <div className="rag-card-title">图谱</div>
                  <button type="button" className="rag-button" onClick={() => void loadGraph()}>
                    <Network className="h-4 w-4" />
                    刷新图谱
                  </button>
                </div>
                <div className="rag-graph-summary">
                  <span>节点 {graphSnapshot?.nodes?.length ?? 0}</span>
                  <span>关系 {graphSnapshot?.edges?.length ?? 0}</span>
                </div>
                <div className="rag-graph-nodes">
                  {(graphSnapshot?.nodes ?? []).slice(0, 24).map((node) => (
                    <span key={node.id} className="rag-node-pill">{node.label}</span>
                  ))}
                </div>
                <pre className="rag-output">{graphSnapshot ? JSON.stringify(graphSnapshot, null, 2) : "暂无图谱数据"}</pre>
              </section>
            </div>

            <div className="rag-footer-status">{ragStatus || `后端接口：${ragApiBaseUrl}`}</div>
          </div>
        </aside>
      ) : null}

      {/* ── Persona Settings Drawer ── */}
      {personaOpen ? (
        <>
          <div className="rag-drawer-backdrop" onClick={() => setPersonaOpen(false)} />
          <aside className="rag-drawer">
            <div className="rag-drawer-header">
              <h2>人设管理</h2>
              <button type="button" className="rag-close" onClick={() => setPersonaOpen(false)}>✕</button>
            </div>
            <div className="rag-drawer-body" style={{padding: "16px", display: "flex", flexDirection: "column", gap: "12px"}}>
              {[
                { key: "name", label: "名字", placeholder: "小慧" },
                { key: "role", label: "角色", placeholder: "展厅的真人讲解员" },
                { key: "venue", label: "展厅地址", placeholder: "四川省成都市成华区" },
                { key: "greeting", label: "问候语", placeholder: "你好，我是小慧，请问有什么可以帮您的？" },
                { key: "personality", label: "性格特点", placeholder: "热情专业、什么问题都能聊、自然口语化" },
                { key: "restrictions", label: "限制/禁忌", placeholder: "不说系统术语；用第一人称" },
                { key: "asrCorrections", label: "ASR 纠错规则", placeholder: "兴龙→兴蓉、成化→成华" },
              ].map(({ key, label, placeholder }) => (
                <label key={key} style={{display:"flex", flexDirection:"column", gap:"4px", fontSize:"13px"}}>
                  <span style={{fontWeight:600, color:"#ccc"}}>{label}</span>
                  <textarea
                    rows={key === "personality" || key === "restrictions" || key === "asrCorrections" ? 3 : 1}
                    placeholder={placeholder}
                    value={personaData[key] ?? ""}
                    onChange={(e) => setPersonaData((prev) => ({ ...prev, [key]: e.target.value }))}
                    style={{
                      background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.15)",
                      borderRadius:"6px", padding:"8px", color:"#eee", fontSize:"13px", resize:"vertical",
                    }}
                  />
                </label>
              ))}
              <button
                type="button"
                disabled={personaSaving}
                onClick={async () => {
                  setPersonaSaving(true);
                  setPersonaStatus("保存中...");
                  try {
                    const res = await fetch(`${ragApiBaseUrl}/api/persona`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ ...personaData, name: personaData.name || "小慧" }),
                    });
                    const d = await res.json();
                    setPersonaStatus(d.ok ? "✓ 已保存，下次对话自动生效" : `✗ ${d.error}`);
                  } catch (e) {
                    setPersonaStatus(`✗ 保存失败: ${String(e)}`);
                  } finally {
                    setPersonaSaving(false);
                  }
                }}
                style={{
                  padding:"10px", borderRadius:"8px", border:"none", cursor:"pointer",
                  background:"linear-gradient(135deg,#4f8cff,#6c63ff)", color:"#fff",
                  fontWeight:600, fontSize:"14px",
                }}
              >
                {personaSaving ? "保存中..." : "保存人设（热重载）"}
              </button>
              {personaStatus && <div style={{fontSize:"12px",color:personaStatus.startsWith("✓") ? "#4ade80" : "#f87171"}}>{personaStatus}</div>}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}

function inferSourceType(file: File): "document" | "image" | "video" | "audio" | "text" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("text/")) return "text";
  return "document";
}

// Cached backend host for URL rewriting (set from tauriGetBackendHost or page location)
let _rewriteHost: string | null = null;
function initRewriteHost() {
  if (_rewriteHost) return;
  if (isTauriEnv()) {
    tauriGetBackendHost().then((h) => { _rewriteHost = h.split(":")[0]; });
  } else if (typeof window !== "undefined" && window.location.hostname && window.location.hostname !== "localhost") {
    _rewriteHost = window.location.hostname;
  }
}
initRewriteHost();

function rewriteMediaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && _rewriteHost && _rewriteHost !== "127.0.0.1") {
      parsed.hostname = _rewriteHost;
      return parsed.toString();
    }
  } catch {
    // Not a valid URL, return as-is
  }
  return url;
}

function normalizeMediaRef(data: any): MediaRef {
  return {
    assetId: String(data.assetId ?? data.url),
    assetType: String(data.assetType ?? "document"),
    url: rewriteMediaUrl(String(data.url)),
    label: String(data.label ?? data.url),
    frameUrl: data.frameUrl ? rewriteMediaUrl(String(data.frameUrl)) : undefined,
    startMs: typeof data.startMs === "number" ? data.startMs : undefined,
    endMs: typeof data.endMs === "number" ? data.endMs : undefined,
    traceId: data.traceId ? String(data.traceId) : undefined,
  };
}

function attachMediaToLatestAssistant(messages: ChatMessage[], ref: MediaRef): ChatMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role === "assistant") {
      const refs = next[index].mediaRefs ?? [];
      const deduped = [ref, ...refs.filter((item) => item.assetId !== ref.assetId)];
      next[index] = { ...next[index], mediaRefs: deduped.slice(0, 4) };
      return next;
    }
  }
  return [...next, { id: `${Date.now()}-assistant-media`, role: "assistant", text: "", mediaRefs: [ref] }];
}

function formatAssetType(assetType: string) {
  if (assetType === "image") return "Image";
  if (assetType === "video") return "Video";
  if (assetType === "audio") return "Audio";
  if (assetType === "document") return "Document";
  return assetType;
}

function renderMediaIcon(assetType: string) {
  if (assetType === "image") return <ImageIcon className="h-4 w-4" />;
  if (assetType === "video") return <PlayCircle className="h-4 w-4" />;
  if (assetType === "audio") return <Volume2 className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

// isPlayableMedia and renderStageMedia moved to media/ module

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUploadStatus(status: PendingUploadItem["status"]) {
  if (status === "selected") return "待上传";
  if (status === "uploading") return "上传中";
  if (status === "uploaded") return "上传完成";
  if (status === "ingesting") return "入库中";
  if (status === "done") return "已完成";
  if (status === "failed") return "失败";
  return status;
}

function formatJobStep(step?: string) {
  if (!step) return "pending";
  if (step === "started") return "已开始";
  if (step === "media_processing") return "媒体预处理";
  if (step === "indexing_transcript") return "转写入库";
  if (step === "search_ready") return "已可检索";
  if (step === "enhancing_keyframes") return "增强关键帧";
  if (step === "enhancing_graph") return "增强图谱";
  if (step === "search_ready_with_partial_enhancement") return "可检索，部分增强失败";
  if (step === "indexing") return "收尾入库";
  if (step === "completed") return "完成";
  return step;
}
