import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isTauriEnv, tauriSendText, tauriSendAudio, tauriGetCachedAudio, tauriGetBackendHost, tauriGetHostStatus, subscribeTauriEvents, type VoiceMessage, type DeviceStatePayload } from "./useTauriBackend";
import { ParticleBackground } from "./ParticleBackground";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  SendHorizontal,
  Keyboard,
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
  ChevronDown,
  Maximize,
  Minimize,
  Camera,
  Eye,
  EyeOff,
  User,
  Ruler,
  Activity,
} from "lucide-react";
import { useMediaStateMachine } from "./media/useMediaStateMachine";
import { createMediaQueue } from "./media/mediaQueue";
import { MediaPresenter } from "./media/MediaPresenter";
import { isPlayableMedia as isPlayableMediaCheck } from "./media/types";
import type { MediaRef as MediaRefType } from "./media/types";
import { useSyncedSubtitle } from "./useSyncedSubtitle";
import { useUnityBridge } from "./useUnityBridge";
import { PCMStreamPlayer } from "./pcmStreamPlayer";
import { WebRTCClient } from "./webrtcClient";

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
  const [isRecording, setIsRecording] = useState(false);
  const [isPhoneCall, setIsPhoneCall] = useState(false);
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
  const [showTextInput, setShowTextInput] = useState(false);

  // Live subtitle panel: sentence-level audio-text sync
  const unityBridge = useUnityBridge();
  const syncSub = useSyncedSubtitle({
    onPlayAudio: (audioBase64, _mimeType) => {
      unityBridge.playAudio(audioBase64);
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  // Phone-call (continuous streaming) mode refs
  const phoneCallStreamRef = useRef<MediaStream | null>(null);
  const phoneCallCtxRef = useRef<AudioContext | null>(null);
  const phoneCallNodeRef = useRef<ScriptProcessorNode | null>(null);
  const phoneCallTraceIdRef = useRef<string>("");
  const phoneCallSeqRef = useRef<number>(0);
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
  const [isWebrtcTest, setIsWebrtcTest] = useState(false);
  // WebRTC 全双工对话（PR 2）：接入 Qwen
  const [isWebrtcCall, setIsWebrtcCall] = useState(false);
  const webrtcCtrlWsRef = useRef<WebSocket | null>(null);

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
    if (isRecording) return "录音中";
    return connectionStatus;
  }, [connectionStatus, isRecording]);

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
    setConnectionStatus("Tauri host 已连接");
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    subscribeTauriEvents({
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
        if (codec === "pcm_s16le" && sampleRate > 0) {
          ensureAecBound(sampleRate);
          pcmPlayerRef.current.begin(sampleRate);
        }
      },
      onTtsAudioChunk: (data, _mimeType, codec, sampleRate) => {
        if (cancelled) return;
        if (codec === "pcm_s16le" && sampleRate > 0) {
          const bytes = decodeBase64ToBytes(data);
          pcmPlayerRef.current.push(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            sampleRate,
          );
        }
      },
      onTtsAudioEnd: () => {
        // Realtime 流式无需关闭（下一段 begin 会重置）；cascade 模式下播放队列自然结束
      },
      onMediaControl: (action, _message) => {
        if (!cancelled) applyMediaControl(action);
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
        }).catch((err: any) => {
          console.error("Unity load failed", err);
        });
      }
    };

    document.body.appendChild(script);
    }, 500); // 500ms delay — let UI paint first

    return () => {
      clearTimeout(delayTimer);
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
            if (data.action === "duck") {
              setStageMediaVolume(typeof data.level === "number" ? data.level : 0.1);
            } else if (data.action === "restore") {
              setStageMediaVolume(typeof data.level === "number" ? data.level : 1);
            }
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
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
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
        if (data.type === "stop_tts") {
          unityBridge.interrupt();
          syncSub.reset();
          pcmPlayerRef.current.interrupt();
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

  async function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.stop();
    recorder.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    setIsRecording(false);
    setConnectionStatus("录音结束，正在上传");
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setConnectionStatus("当前浏览器不支持录音");
      return;
    }

    try {
      if (!isTauriEnv()) {
        await ensureAssistantSocket();
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderChunksRef.current = [];
      const traceId = `browser-audio-${Date.now()}`;
      if (!isTauriEnv()) {
        ensureVoiceUserMessage(traceId); // Browser mode: show immediately
      }
      recorderRef.current = recorder;
      setIsRecording(true);
      setConnectionStatus("录音中");

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recorderChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setIsRecording(false);
        setConnectionStatus("录音器出错");
      };

      recorder.onstop = async () => {
        const blob = new Blob(recorderChunksRef.current, { type: recorder.mimeType || "audio/webm" });

        // Transcode browser audio (webm/opus) → 16kHz mono WAV to match device format
        let wavBase64: string;
        try {
          const arrayBuf = await blob.arrayBuffer();
          const audioCtx = new AudioContext();
          const decoded = await audioCtx.decodeAudioData(arrayBuf);
          audioCtx.close().catch(() => {});

          // Resample to 16kHz mono via OfflineAudioContext
          const targetRate = 16000;
          const offlineLen = Math.round(decoded.duration * targetRate);
          const offline = new OfflineAudioContext(1, offlineLen, targetRate);
          const src = offline.createBufferSource();
          src.buffer = decoded;
          src.connect(offline.destination);
          src.start();
          const rendered = await offline.startRendering();
          const float32 = rendered.getChannelData(0);

          // Float32 → Int16 PCM + WAV header
          const pcmLen = float32.length * 2;
          const wavLen = 44 + pcmLen;
          const wavBuf = new ArrayBuffer(wavLen);
          const view = new DataView(wavBuf);
          // RIFF header
          const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
          writeStr(0, "RIFF");
          view.setUint32(4, wavLen - 8, true);
          writeStr(8, "WAVE");
          writeStr(12, "fmt ");
          view.setUint32(16, 16, true);        // fmt chunk size
          view.setUint16(20, 1, true);          // PCM
          view.setUint16(22, 1, true);          // mono
          view.setUint32(24, targetRate, true);  // sample rate
          view.setUint32(28, targetRate * 2, true); // byte rate
          view.setUint16(32, 2, true);          // block align
          view.setUint16(34, 16, true);         // bits per sample
          writeStr(36, "data");
          view.setUint32(40, pcmLen, true);
          // PCM samples
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          }

          // ArrayBuffer → base64
          const wavBytes = new Uint8Array(wavBuf);
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < wavBytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, Array.from(wavBytes.subarray(i, i + chunk)));
          }
          wavBase64 = btoa(binary);
        } catch (err) {
          console.error("[Recording] Transcode to WAV failed, falling back to raw:", err);
          // Fallback: send original blob as-is
          const rawBuf = await blob.arrayBuffer();
          const rawBytes = new Uint8Array(rawBuf);
          let binary = "";
          for (const byte of rawBytes) binary += String.fromCharCode(byte);
          wavBase64 = btoa(binary);
        }

        const wavMime = "audio/wav";
        try {
          if (isTauriEnv()) {
            // Tauri: send to Rust host — it will emit voice_message back to display
            await tauriSendAudio(traceId, wavBase64, wavMime, "zh");
          } else {
          // Browser: display locally + send via WS
          ensureVoiceUserMessage(traceId, "语音识别中…", URL.createObjectURL(blob));
          const socket = await ensureAssistantSocket();
          socket.send(JSON.stringify({
            type: "audio_segment_begin",
            traceId,
            deviceId: directDeviceId.trim(),
            mimeType: wavMime,
            codec: "pcm_s16le",
            language: "zh",
            context: buildMediaContext(),
          }));
          socket.send(JSON.stringify({
            type: "audio_segment_chunk",
            traceId,
            deviceId: directDeviceId.trim(),
            seq: 0,
            data: wavBase64,
          }));
          socket.send(JSON.stringify({
            type: "audio_segment_end",
            traceId,
            deviceId: directDeviceId.trim(),
            reason: "browser_recording_complete",
          }));
          } // end else (non-Tauri)
        } catch (error) {
          setConnectionStatus(error instanceof Error ? error.message : "录音上传失败");
        }
      };

      recorder.start();
    } catch (error) {
      setIsRecording(false);
      setConnectionStatus(error instanceof Error ? error.message : "无法开始录音");
    }
  }

  // ── Phone-call mode (continuous streaming to backend realtime) ──────
  // Uses Web Audio API to capture 16kHz mono PCM in small chunks (~100ms each),
  // base64-encoded and sent as audio_stream_chunk. Server-side VAD (Qwen) handles
  // utterance boundaries; client does NOT VAD.

  async function startPhoneCall(): Promise<void> {
    if (isPhoneCall) return;
    if (isTauriEnv()) {
      setConnectionStatus("Tauri 模式暂不支持电话模式");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setConnectionStatus("浏览器不支持录音");
      return;
    }
    try {
      const socket = await ensureAssistantSocket();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          // AEC 开关默认关（会导致麦克风采集变静音）；开 Web AEC 时通过 localStorage wakefusion.enableWebAec=1
          echoCancellation: localStorage.getItem("wakefusion.enableWebAec") === "1",
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      phoneCallStreamRef.current = stream;

      // AEC 准备：让 pcmPlayer 的 MediaStream 输出绑到 <audio> 元素，
      // 浏览器 AEC 才能把"我方 TTS 输出"从麦克风输入里扣除回声
      // 电话按钮点击本身就是用户手势，audio.play() 此时一定成功
      ensureAecBound(24000);

      // Create AudioContext at target sample rate if possible; otherwise use default and resample.
      const ctx = new AudioContext({ sampleRate: 16000 });
      phoneCallCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);

      // ScriptProcessorNode is deprecated but universally supported.
      // Buffer size 2048 @ 16kHz ≈ 128ms per chunk.
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      phoneCallNodeRef.current = processor;

      const traceId = `phone-${Date.now()}`;
      phoneCallTraceIdRef.current = traceId;
      phoneCallSeqRef.current = 0;

      // Send stream_start
      console.log("[phone] AudioContext sampleRate =", ctx.sampleRate);
      socket.send(JSON.stringify({
        type: "audio_stream_start",
        traceId,
        deviceId: directDeviceId.trim(),
        mimeType: "audio/pcm",
        codec: "pcm_s16le",
        sampleRate: ctx.sampleRate,
        channels: 1,
        language: "zh",
      }));

      processor.onaudioprocess = (ev) => {
        if (!phoneCallNodeRef.current) return;
        const float32 = ev.inputBuffer.getChannelData(0);
        // Diagnostic: compute RMS every ~20 chunks (~2.5s)
        if (phoneCallSeqRef.current % 20 === 0) {
          let sum = 0;
          for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
          const rms = Math.sqrt(sum / float32.length);
          console.log(`[phone] seq=${phoneCallSeqRef.current} rms=${rms.toFixed(4)} len=${float32.length}`);
        }
        // 🔇 半双工：TTS 播放期间 + 尾音 500ms 内，上行改发静音 PCM
        // 防止扬声器回声被 Qwen server_vad 误当成用户说话触发 barge-in 循环
        const mute = ttsPlayingRef.current || Date.now() < ttsTailUntilRef.current;
        // Float32 → Int16 PCM（mute 时直接零）
        const pcm = new Int16Array(float32.length);
        if (!mute) {
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
        }
        // mute=true 时 pcm 保持全 0（Int16Array 默认 0）
        // Int16Array → base64
        const bytes = new Uint8Array(pcm.buffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
        }
        const b64 = btoa(binary);
        socket.send(JSON.stringify({
          type: "audio_stream_chunk",
          traceId,
          deviceId: directDeviceId.trim(),
          seq: phoneCallSeqRef.current++,
          data: b64,
        }));
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      setIsPhoneCall(true);
      setConnectionStatus("电话模式已接通");
    } catch (err) {
      setConnectionStatus(err instanceof Error ? err.message : "无法启动电话模式");
      stopPhoneCall();
    }
  }

  function stopPhoneCall(): void {
    const traceId = phoneCallTraceIdRef.current;
    try {
      // Send stream_stop over existing socket (best-effort)
      const socket = directSocketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN && traceId) {
        socket.send(JSON.stringify({
          type: "audio_stream_stop",
          traceId,
          deviceId: directDeviceId.trim(),
          reason: "user_ended",
        }));
      }
    } catch { /* ignore */ }
    try { phoneCallNodeRef.current?.disconnect(); } catch { /* ignore */ }
    try { phoneCallCtxRef.current?.close(); } catch { /* ignore */ }
    try { phoneCallStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    pcmPlayerRef.current.interrupt();
    phoneCallNodeRef.current = null;
    phoneCallCtxRef.current = null;
    phoneCallStreamRef.current = null;
    phoneCallTraceIdRef.current = "";
    phoneCallSeqRef.current = 0;
    setIsPhoneCall(false);
    setConnectionStatus("电话已挂断");
  }

  // ── WebRTC Loopback 测试（PR 1）────────────────────────────────────
  async function startWebrtcTest(): Promise<void> {
    if (isWebrtcTest) return;
    if (isTauriEnv()) {
      setConnectionStatus("Tauri 模式不支持 WebRTC 测试");
      return;
    }
    try {
      // 后端 HTTP base：去掉 /api/voice/ws 这种 ws 路径，只要 origin
      const wsUrl = directWsBaseUrl;
      const httpBase = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/api\/voice\/ws.*$/, "");
      const client = new WebRTCClient({
        backendHttpUrl: httpBase,
        onConnected: () => setConnectionStatus("WebRTC 已连接（loopback）"),
        onClosed: (r) => setConnectionStatus(`WebRTC 已断开：${r}`),
        onError: (e) => setConnectionStatus(`WebRTC 错误：${e.message}`),
        onRemoteStream: (stream) => {
          if (webrtcAudioRef.current) {
            webrtcAudioRef.current.srcObject = stream;
            void webrtcAudioRef.current.play().catch(() => {});
          }
        },
      });
      webrtcClientRef.current = client;
      await client.start();
      setIsWebrtcTest(true);
      setConnectionStatus("WebRTC 协商完成，说话测试自己听");
    } catch (err) {
      setConnectionStatus(err instanceof Error ? err.message : "WebRTC 启动失败");
      webrtcClientRef.current?.stop();
      webrtcClientRef.current = null;
    }
  }

  function stopWebrtcTest(): void {
    webrtcClientRef.current?.stop();
    webrtcClientRef.current = null;
    if (webrtcAudioRef.current) webrtcAudioRef.current.srcObject = null;
    setIsWebrtcTest(false);
    setConnectionStatus("WebRTC 测试已停止");
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
            if (data.action === "duck") setStageMediaVolume(typeof data.level === "number" ? data.level : 0.1);
            else if (data.action === "restore") setStageMediaVolume(typeof data.level === "number" ? data.level : 1);
          }
        } catch { /* ignore */ }
      };

      const client = new WebRTCClient({
        backendHttpUrl: httpBase,
        endpoint: "/api/voice/webrtc/offer",
        deviceId,
        onConnected: () => setConnectionStatus("WebRTC 对话已接通（和 Qwen 说话）"),
        onClosed: (r) => setConnectionStatus(`WebRTC 已断开：${r}`),
        onError: (e) => setConnectionStatus(`WebRTC 错误：${e.message}`),
        onRemoteStream: (stream) => {
          if (webrtcAudioRef.current) {
            webrtcAudioRef.current.srcObject = stream;
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

  // (Old TTS playback functions removed — audio playback now handled by useSyncedSubtitle)

  function isolateComposerKeyboard(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") {
      const nativeEvent = event.nativeEvent as KeyboardEvent;
      nativeEvent.stopImmediatePropagation?.();
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    isolateComposerKeyboard(event);
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendText();
    }
  }

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

  return (
    <div className="app-shell" ref={appShellRef}>
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
        <ParticleBackground dimmed={stageMode === "media" || stageMode === "loading"} />
        <div className={`stage-avatar-shell ${stageMode === "media" || stageMode === "loading" ? "is-dimmed" : ""}`}>
          <canvas ref={canvasRef} className="unity-canvas" />
        </div>
        <MediaPresenter machine={mediaMachine} volume={stageMediaVolume} />
      </div>

      {/* Layer 2-3: Floating UI overlay */}
      <div className="ui-overlay">
        {/* Top-right: double-click hotzone to toggle UI */}
        <div
          className="ui-toggle-hotzone"
          onDoubleClick={() => setUiVisible((v) => !v)}
        />

        {/* Top-left: branding */}
        {uiVisible && (
          <div className="overlay-branding">
            <span className="brand-name-cn">成都曜曜慧道科技有限公司</span>
            <span className="brand-name-en">Chengdu YaoYao Huidao Exhibition Co., Ltd.</span>
          </div>
        )}

        {/* Top-right: status + fullscreen + management */}
        {uiVisible && (
          <header className="overlay-header">
            <div className={`overlay-status ${isRecording ? "is-recording" : ""}`}>{connectionLabel}</div>
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
          <div className="stage-idle-hint">点击下方麦克风开始对话</div>
        ) : null}

        {/* Live subtitle panel — always visible, not controlled by uiVisible */}
        {(syncSub.userPhase !== "hidden" || syncSub.assistantPhase !== "hidden") ? (
          <div className="live-subtitle-panel">
            {/* Line 1: User voice + text */}
            {syncSub.userPhase !== "hidden" && syncSub.userVoice ? (
              <div className={`live-subtitle-line live-subtitle-user ${syncSub.userPhase === "fading" ? "is-fading" : ""}`}>
                {!syncSub.userVoice.audioId.startsWith("text-") && (
                  <Volume2 className="live-subtitle-voice-icon" />
                )}
                <span className="live-subtitle-text">
                  {syncSub.userVoice.text || "语音识别中…"}
                </span>
              </div>
            ) : null}
            {/* Line 2: Assistant text (synced with TTS audio) */}
            {syncSub.assistantPhase !== "hidden" && syncSub.assistantText ? (
              <div className={`live-subtitle-line live-subtitle-assistant ${syncSub.assistantPhase === "fading" ? "is-fading" : ""}`}>
                <span className="live-subtitle-text">{syncSub.assistantText}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Action bar */}
        {uiVisible && <div className="action-bar">
          {showTextInput ? (
            <div className="action-text-input">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onFocus={() => { canvasRef.current?.blur(); }}
                onKeyDownCapture={isolateComposerKeyboard}
                onKeyUpCapture={isolateComposerKeyboard}
                onKeyDown={handleComposerKeyDown}
                placeholder="输入问题，Enter 发送"
                rows={1}
                lang="zh-CN"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className="action-text-btns">
                <button type="button" className={`action-icon-btn ${isRecording ? "is-recording" : ""}`} onClick={() => void (isRecording ? stopRecording() : startRecording())}>
                  {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                <button type="button" className="action-send-btn" onClick={() => void sendText()}>
                  <SendHorizontal className="h-4 w-4" />
                </button>
                <button type="button" className="action-close-btn" onClick={() => setShowTextInput(false)}>
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className={`mic-button ${isRecording ? "is-recording" : ""}`}
                onClick={() => void (isRecording ? stopRecording() : startRecording())}
                disabled={isPhoneCall}
              >
                {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                <span>{isRecording ? "点击结束录音" : "点击开始对话"}</span>
              </button>
              <button
                type="button"
                className={`phone-button ${isPhoneCall ? "is-active" : ""}`}
                onClick={() => void (isPhoneCall ? stopPhoneCall() : startPhoneCall())}
                disabled={isRecording}
                title={isPhoneCall ? "挂断电话" : "电话模式（连续对话）"}
              >
                {isPhoneCall ? <PhoneOff className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
                <span>{isPhoneCall ? "挂断" : "电话模式"}</span>
              </button>
              <button type="button" className="keyboard-toggle" onClick={() => setShowTextInput(true)} title="文字输入">
                <Keyboard className="h-5 w-5" />
              </button>
              <button
                type="button"
                className={`phone-button ${isWebrtcTest ? "is-active" : ""}`}
                onClick={() => void (isWebrtcTest ? stopWebrtcTest() : startWebrtcTest())}
                disabled={isRecording || isPhoneCall || isWebrtcCall}
                title={isWebrtcTest ? "结束 WebRTC 测试" : "WebRTC Loopback 测试（PR1）"}
                style={{ background: isWebrtcTest ? "#8b5cf6" : undefined }}
              >
                <span>{isWebrtcTest ? "RTC停止" : "RTC测试"}</span>
              </button>
              <button
                type="button"
                className={`phone-button ${isWebrtcCall ? "is-active" : ""}`}
                onClick={() => void (isWebrtcCall ? stopWebrtcCall() : startWebrtcCall())}
                disabled={isRecording || isPhoneCall || isWebrtcTest}
                title={isWebrtcCall ? "结束 WebRTC 对话" : "WebRTC 全双工对话（PR2，Qwen）"}
                style={{ background: isWebrtcCall ? "#10b981" : undefined }}
              >
                <span>{isWebrtcCall ? "RTC挂断" : "RTC对话"}</span>
              </button>
            </>
          )}
        </div>}
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
