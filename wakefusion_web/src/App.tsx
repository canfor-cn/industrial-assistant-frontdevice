import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isTauriEnv, tauriSendText, tauriSendAudio, tauriGetCachedAudio, subscribeTauriEvents, type VoiceMessage } from "./useTauriBackend";
import {
  Mic,
  MicOff,
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
  X,
  ChevronDown,
  Maximize,
  Minimize,
} from "lucide-react";

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
    if (typeof window === "undefined") return "ws://127.0.0.1:7788/api/voice/ws";
    const { protocol, hostname } = window.location;
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${hostname || "127.0.0.1"}:7788/api/voice/ws`;
  })();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isUnityLoaded, setIsUnityLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState("未连接");
  const [isRecording, setIsRecording] = useState(false);
  const [ragOpen, setRagOpen] = useState(false);
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
  const [stageMediaRef, setStageMediaRef] = useState<MediaRef | null>(null);
  const [stageMode, setStageMode] = useState<"avatar" | "loading" | "media" | "exiting">("avatar");
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);
  const [playbackHistory, setPlaybackHistory] = useState<MediaHistoryEntry[]>([]);
  const [playbackState, setPlaybackState] = useState<"idle" | "playing" | "ended" | "stopped">("idle");
  const [stageMediaVolume, setStageMediaVolume] = useState(1);
  const [pendingUploads, setPendingUploads] = useState<PendingUploadItem[]>([]);
  const [showTextInput, setShowTextInput] = useState(false);
  const [displayedAssistantText, setDisplayedAssistantText] = useState("");
  const [subtitlePhase, setSubtitlePhase] = useState<"hidden" | "visible" | "fading">("hidden");
  const [preferredSinkId, setPreferredSinkId] = useState<string | null>(null);
  const [directWsBaseUrl] = useState(() => localStorage.getItem("wakefusion.directWsBaseUrl") ?? directWsUrlDefault);
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
  const currentTraceRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const subtitleScrollRef = useRef<HTMLDivElement>(null);
  const mediaReturnTimerRef = useRef<number | null>(null);
  const stageTransitionTimerRef = useRef<number | null>(null);
  const subtitleEndRef = useRef<HTMLDivElement>(null);
  const assistantFullTextRef = useRef("");
  const displayTimerRef = useRef<number | null>(null);
  const subtitleFadeTimerRef = useRef<number | null>(null);
  const ttsSegmentBuffersRef = useRef(new Map<string, Uint8Array[]>());
  const ttsSegmentMetaRef = useRef(new Map<string, { mimeType?: string }>());
  const ttsPlaybackQueueRef = useRef<Array<{ url: string; mimeType: string }>>([]);
  const ttsCurrentAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsCurrentUrlRef = useRef<string | null>(null);
  // Web Audio API queue for Tauri mode (bypasses blob URL limitations)
  const ttsWebAudioQueueRef = useRef<ArrayBuffer[]>([]);
  const ttsWebAudioPlayingRef = useRef(false);
  const ttsAudioContextRef = useRef<AudioContext | null>(null);

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

  const ragApiBaseUrl = useMemo(() => {
    try {
      const url = new URL(directWsBaseUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return "http://127.0.0.1:7788";
    }
  }, [directWsBaseUrl]);

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

  useEffect(() => {
    const host = subtitleScrollRef.current;
    if (host) {
      host.scrollTop = host.scrollHeight;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ block: "end" });
    subtitleEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, displayedAssistantText, latestAssistantMediaRefs, subtitlePhase]);

  useEffect(() => {
    return () => {
      if (ttsCurrentAudioRef.current) {
        ttsCurrentAudioRef.current.pause();
        ttsCurrentAudioRef.current.src = "";
        ttsCurrentAudioRef.current = null;
      }
      if (ttsCurrentUrlRef.current) {
        URL.revokeObjectURL(ttsCurrentUrlRef.current);
        ttsCurrentUrlRef.current = null;
      }
      for (const item of ttsPlaybackQueueRef.current) {
        URL.revokeObjectURL(item.url);
      }
      ttsPlaybackQueueRef.current = [];
      ttsSegmentBuffersRef.current.clear();
      ttsSegmentMetaRef.current.clear();
    };
  }, []);

  // Token buffer: uniform-speed character reveal
  useEffect(() => {
    assistantFullTextRef.current = latestAssistantFull;

    if (!latestAssistantFull) {
      setDisplayedAssistantText("");
      if (displayTimerRef.current) {
        window.clearInterval(displayTimerRef.current);
        displayTimerRef.current = null;
      }
      return;
    }

    // Start the reveal timer if not already running
    if (!displayTimerRef.current) {
      displayTimerRef.current = window.setInterval(() => {
        setDisplayedAssistantText((prev) => {
          const full = assistantFullTextRef.current;
          if (prev.length >= full.length) {
            return prev;
          }
          // Adaptive speed: if buffer > 30 chars behind, go faster
          const lag = full.length - prev.length;
          const step = lag > 60 ? 3 : lag > 30 ? 2 : 1;
          return full.slice(0, prev.length + step);
        });
      }, 80); // ~12 chars/sec base speed
    }

    return undefined;
  }, [latestAssistantFull]);

  // Show subtitle when there's content, reset fade
  useEffect(() => {
    if (latestUserText || latestAssistantFull) {
      setSubtitlePhase("visible");
      // Clear any pending fade timer
      if (subtitleFadeTimerRef.current) {
        window.clearTimeout(subtitleFadeTimerRef.current);
        subtitleFadeTimerRef.current = null;
      }
    }
  }, [latestUserText, latestAssistantFull]);

  // Detect when all text is fully displayed → start 5s fade timer
  useEffect(() => {
    if (!latestAssistantFull || displayedAssistantText.length < latestAssistantFull.length) {
      return;
    }
    // Fully caught up — stop the interval
    if (displayTimerRef.current) {
      window.clearInterval(displayTimerRef.current);
      displayTimerRef.current = null;
    }
    // Start 5s countdown to fade
    if (subtitleFadeTimerRef.current) {
      window.clearTimeout(subtitleFadeTimerRef.current);
    }
    subtitleFadeTimerRef.current = window.setTimeout(() => {
      setSubtitlePhase("fading");
      // After the CSS transition (1s), hide completely
      subtitleFadeTimerRef.current = window.setTimeout(() => {
        setSubtitlePhase("hidden");
        subtitleFadeTimerRef.current = null;
      }, 1200);
    }, 5000);

    return () => {
      if (subtitleFadeTimerRef.current) {
        window.clearTimeout(subtitleFadeTimerRef.current);
        subtitleFadeTimerRef.current = null;
      }
    };
  }, [displayedAssistantText, latestAssistantFull]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
      if (subtitleFadeTimerRef.current) window.clearTimeout(subtitleFadeTimerRef.current);
    };
  }, []);

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
    if (!stageMediaRef || !isPlayableMedia(stageMediaRef.assetType) || !preferredSinkId) {
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
      onToken: (traceId, text) => {
        if (!cancelled) appendAssistantChunk(traceId, text);
      },
      onAsrResult: (traceId, text, stage, audioId) => {
        if (cancelled) return;
        if (stage !== "final" && stage !== "done") return;
        // audioId alignment: discard if it doesn't match the current user message's audioId
        setMessages((prev) => {
          const userMsg = prev.find((m) => m.id === `${traceId}-user`);
          if (userMsg?.audioId && audioId && userMsg.audioId !== audioId) return prev;
          const filtered = prev.filter((m) => m.id !== `${traceId}-user`);
          return [...filtered, { ...userMsg!, text, audioId: audioId ?? userMsg?.audioId }];
        });
      },
      onFinal: (_traceId) => {},
      onClear: () => {
        if (!cancelled) {
          setMessages([]);
          setDisplayedAssistantText("");
        }
      },
      onMediaRef: (data) => {
        if (cancelled) return;
        const ref = normalizeMediaRef(data);
        if (isPlayableMedia(ref.assetType)) {
          activateStageMedia(ref, data.traceId || "");
        }
        appendMediaRefToLatest(ref);
      },
      onConnectionStatus: (_connected, message) => {
        if (!cancelled) setConnectionStatus(message);
      },
      onVoiceMessage: (msg) => {
        if (cancelled) return;
        // audioId from gateway — audio data is cached in Rust, not sent to WebView
        appendUserMessage(msg.traceId, msg.text, "voice", undefined, undefined, msg.audioMime, msg.audioId);
      },
      onTtsAudioChunk: (data, mimeType) => {
        if (cancelled) return;
        try {
          const bin = atob(data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          console.log(`[TTS] chunk received: ${bytes.length} bytes, queue=${ttsPlaybackQueueRef.current.length}`);
          enqueueTtsPlayback([bytes], mimeType || "audio/wav");
        } catch (e) {
          console.error("TTS audio decode error", e);
        }
      },
      onTtsAudioEnd: () => {
        // TTS stream finished — no special handling needed
      },
    }).then((unsub) => {
      if (cancelled) {
        // Effect was cleaned up before subscription completed — immediately unsub
        unsub();
      } else {
        cleanup = unsub;
      }
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
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
    return () => {
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
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
            if (isPlayableMedia(ref.assetType)) {
              activateStageMedia(ref, data.traceId ? String(data.traceId) : undefined);
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
      if (mediaReturnTimerRef.current) {
        window.clearTimeout(mediaReturnTimerRef.current);
      }
      if (stageTransitionTimerRef.current) {
        window.clearTimeout(stageTransitionTimerRef.current);
      }
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
    // Reset subtitle buffer state
    assistantFullTextRef.current = "";
    setDisplayedAssistantText("");
    setSubtitlePhase("hidden");
    if (displayTimerRef.current) {
      window.clearInterval(displayTimerRef.current);
      displayTimerRef.current = null;
    }
    if (subtitleFadeTimerRef.current) {
      window.clearTimeout(subtitleFadeTimerRef.current);
      subtitleFadeTimerRef.current = null;
    }
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

  function clearMediaReturnTimer() {
    if (mediaReturnTimerRef.current) {
      window.clearTimeout(mediaReturnTimerRef.current);
      mediaReturnTimerRef.current = null;
    }
  }

  function clearStageTransitionTimer() {
    if (stageTransitionTimerRef.current) {
      window.clearTimeout(stageTransitionTimerRef.current);
      stageTransitionTimerRef.current = null;
    }
  }

  function activateStageMedia(ref: MediaRef, sourceTraceId?: string) {
    clearMediaReturnTimer();
    clearStageTransitionTimer();
    setStageMediaVolume(1);
    setPlaybackState("playing");
    setStageMediaRef(ref);
    setStageMode("loading");
    setPlaybackHistory((prev) => {
      const next = prev.map((item) => (
        item.status === "playing" ? { ...item, status: "stopped", endedAt: Date.now() } : item
      ));
      return [
        {
          id: `${ref.assetId}-${Date.now()}`,
          ref,
          sourceTraceId,
          startedAt: Date.now(),
          status: "playing",
        },
        ...next,
      ].slice(0, 20);
    });
  }

  function markLatestPlayback(status: "ended" | "stopped") {
    setPlaybackHistory((prev) => {
      const next = [...prev];
      const index = next.findIndex((item) => item.status === "playing");
      if (index >= 0) {
        next[index] = { ...next[index], status, endedAt: Date.now() };
      }
      return next;
    });
  }

  function returnToAvatar(reason: "ended" | "stopped" = "stopped") {
    clearMediaReturnTimer();
    clearStageTransitionTimer();
    void exitStageFullscreen();
    setPlaybackState(reason === "ended" ? "ended" : "stopped");
    markLatestPlayback(reason);
    setStageMode("exiting");
    stageTransitionTimerRef.current = window.setTimeout(() => {
      setStageMediaRef(null);
      setStageMode("avatar");
      stageTransitionTimerRef.current = null;
    }, 420);
  }

  function handleStageMediaEnded() {
    clearMediaReturnTimer();
    setPlaybackState("ended");
    markLatestPlayback("ended");
    mediaReturnTimerRef.current = window.setTimeout(() => {
      returnToAvatar("ended");
      setPlaybackState("idle");
      mediaReturnTimerRef.current = null;
    }, 1000);
  }

  function handleStageMediaReady() {
    clearStageTransitionTimer();
    setStageMode("media");
  }

  function replayLastMedia() {
    const latest = playbackHistory[0];
    if (!latest) return false;
    activateStageMedia(latest.ref, latest.sourceTraceId);
    return true;
  }

  function applyMediaControl(action?: string) {
    if (action === "replay_last") {
      return replayLastMedia() ? "好的，我已经为您重新播放刚刚的媒体内容。" : "当前没有可重播的媒体。";
    }
    if (action === "return_avatar") {
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
    return {
      media: {
        stageMode,
        isFullscreen: isStageFullscreen,
        currentMedia: stageMediaRef
          ? {
              assetId: stageMediaRef.assetId,
              assetType: stageMediaRef.assetType,
              label: stageMediaRef.label,
              url: stageMediaRef.url,
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
          const message = typeof data.message === "string" && data.message
            ? `语音识别失败：${data.message}`
            : "语音识别失败";
          setMessages((prev) => [...prev, { id: `${traceId}-audio-error-${Date.now()}`, role: "assistant", text: message }]);
          setConnectionStatus("语音识别失败");
          return;
        }
        if (data.type === "audio_begin") {
          ttsSegmentBuffersRef.current.set(traceId, []);
          ttsSegmentMetaRef.current.set(traceId, {
            mimeType: typeof data.mimeType === "string" && data.mimeType ? data.mimeType : "audio/wav",
          });
          return;
        }
        if (data.type === "audio_chunk" && typeof data.data === "string") {
          const chunk = decodeBase64ToBytes(data.data);
          const meta = ttsSegmentMetaRef.current.get(traceId);
          enqueueTtsPlayback([chunk], meta?.mimeType ?? "audio/wav");
          return;
        }
        if (data.type === "audio_end") {
          ttsSegmentBuffersRef.current.delete(traceId);
          ttsSegmentMetaRef.current.delete(traceId);
          return;
        }
        if (data.type === "token" && data.text) {
          appendAssistantChunk(traceId, String(data.text));
          return;
        }
        if (data.type === "media_ref" && data.url) {
          const ref = normalizeMediaRef(data);
          if (isPlayableMedia(ref.assetType)) {
            activateStageMedia(ref, traceId);
          }
          setMessages((prev) => attachMediaToLatestAssistant(prev, ref));
          return;
        }
        if (data.type === "media_control") {
          const responseText = applyMediaControl(typeof data.action === "string" ? data.action : undefined) || String(data.message ?? "");
          if (responseText) {
            setMessages((prev) => [...prev, { id: `${traceId}-assistant-media-control`, role: "assistant", text: responseText }]);
          }
          setConnectionStatus("媒体控制已执行");
          return;
        }
        if (data.type === "stop_tts") {
          stopTtsPlayback();
          setConnectionStatus("播放已打断");
          return;
        }
        if (data.type === "final") {
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
    const traceId = `browser-text-${Date.now()}`;
    resetConversation(traceId);
    appendUserMessage(traceId, text, "text");
    setInput("");
    try {
      if (isTauriEnv()) {
        await tauriSendText(text, traceId, directDeviceId.trim());
      } else {
        const socket = await ensureAssistantSocket();
        socket.send(JSON.stringify({
          type: "asr",
          stage: "final",
          traceId,
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
      resetConversation(traceId);
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
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        const data = btoa(binary);
        try {
          if (isTauriEnv()) {
            // Tauri: send to Rust host — it will emit voice_message back to display
            await tauriSendAudio(traceId, data, blob.type || "audio/webm", "zh");
          } else {
          // Browser: display locally + send via WS
          ensureVoiceUserMessage(traceId, "语音识别中…", URL.createObjectURL(blob));
          const socket = await ensureAssistantSocket();
          socket.send(JSON.stringify({
            type: "audio_segment_begin",
            traceId,
            deviceId: directDeviceId.trim(),
            mimeType: blob.type || "audio/webm",
            codec: recorder.mimeType || undefined,
            language: "zh",
            context: buildMediaContext(),
          }));
          socket.send(JSON.stringify({
            type: "audio_segment_chunk",
            traceId,
            deviceId: directDeviceId.trim(),
            seq: 0,
            data,
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

  function decodeBase64ToBytes(data: string) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function concatChunks(chunks: Uint8Array[]) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  function playNextTtsSegment() {
    if (ttsCurrentAudioRef.current || ttsPlaybackQueueRef.current.length === 0) return;
    const next = ttsPlaybackQueueRef.current.shift();
    if (!next) return;
    const audio = new Audio(next.url);
    ttsCurrentAudioRef.current = audio;
    ttsCurrentUrlRef.current = next.url;
    audio.onended = () => {
      audio.src = "";
      ttsCurrentAudioRef.current = null;
      if (ttsCurrentUrlRef.current) {
        URL.revokeObjectURL(ttsCurrentUrlRef.current);
        ttsCurrentUrlRef.current = null;
      }
      playNextTtsSegment();
    };
    audio.onerror = () => {
      audio.pause();
      audio.src = "";
      ttsCurrentAudioRef.current = null;
      if (ttsCurrentUrlRef.current) {
        URL.revokeObjectURL(ttsCurrentUrlRef.current);
        ttsCurrentUrlRef.current = null;
      }
      playNextTtsSegment();
    };
    audio.play().catch((error) => {
      console.error("TTS playback failed", error);
      audio.pause();
      audio.src = "";
      ttsCurrentAudioRef.current = null;
      if (ttsCurrentUrlRef.current) {
        URL.revokeObjectURL(ttsCurrentUrlRef.current);
        ttsCurrentUrlRef.current = null;
      }
      playNextTtsSegment();
    });
  }

  function enqueueTtsPlayback(chunks: Uint8Array[], mimeType: string) {
    const merged = concatChunks(chunks);
    if (isTauriEnv()) {
      // Tauri mode: use Web Audio API (blob URLs don't work in WebView2)
      ttsWebAudioQueueRef.current.push(merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength));
      playNextWebAudioSegment();
    } else {
      // Browser mode: use <audio> + blob URL
      const url = URL.createObjectURL(new Blob([merged], { type: mimeType || "audio/wav" }));
      ttsPlaybackQueueRef.current.push({ url, mimeType });
      playNextTtsSegment();
    }
  }

  function playNextWebAudioSegment() {
    if (ttsWebAudioPlayingRef.current || ttsWebAudioQueueRef.current.length === 0) return;
    const buf = ttsWebAudioQueueRef.current.shift();
    if (!buf) return;
    ttsWebAudioPlayingRef.current = true;

    if (!ttsAudioContextRef.current) {
      ttsAudioContextRef.current = new AudioContext();
    }
    const ctx = ttsAudioContextRef.current;

    ctx.decodeAudioData(buf.slice(0)) // slice to avoid detached buffer
      .then((audioBuffer) => {
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => {
          ttsWebAudioPlayingRef.current = false;
          playNextWebAudioSegment();
        };
        source.start();
      })
      .catch((err) => {
        console.error("Web Audio decode failed:", err);
        ttsWebAudioPlayingRef.current = false;
        playNextWebAudioSegment();
      });
  }

  function stopTtsPlayback() {
    // Stop <audio> mode
    if (ttsCurrentAudioRef.current) {
      ttsCurrentAudioRef.current.pause();
      ttsCurrentAudioRef.current.currentTime = 0;
      ttsCurrentAudioRef.current.src = "";
      ttsCurrentAudioRef.current = null;
    }
    if (ttsCurrentUrlRef.current) {
      URL.revokeObjectURL(ttsCurrentUrlRef.current);
      ttsCurrentUrlRef.current = null;
    }
    for (const item of ttsPlaybackQueueRef.current) {
      URL.revokeObjectURL(item.url);
    }
    ttsPlaybackQueueRef.current = [];
    ttsSegmentBuffersRef.current.clear();
    ttsSegmentMetaRef.current.clear();
    // Stop Web Audio mode
    ttsWebAudioQueueRef.current = [];
    ttsWebAudioPlayingRef.current = false;
    if (ttsAudioContextRef.current) {
      ttsAudioContextRef.current.close().catch(() => {});
      ttsAudioContextRef.current = null;
    }
  }

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
    const response = await fetch(`${ragApiBaseUrl}${path}`, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
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
    void Promise.all([refreshRagStatus(), refreshRagExhibits(), refreshRagJobs(), loadGraph()]);
  }, [ragOpen]);

  useEffect(() => {
    if (!ragOpen || !selectedExhibitId) return;
    void refreshRagAssets(selectedExhibitId);
  }, [selectedExhibitId, ragOpen]);

  useEffect(() => {
    if (!ragOpen) return undefined;
    const timer = window.setInterval(() => {
      void Promise.all([refreshRagJobs(), refreshRagStatus()]);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [ragOpen, ragTenantId]);

  return (
    <div className="app-shell" ref={appShellRef}>
      {/* Layer 0-1: Full-screen stage */}
      <div className="stage-fullscreen" ref={stageSurfaceRef}>
        {!isUnityLoaded && (
          <div className="unity-loading">
            <div className="unity-loading-ring" />
            <div>{loadingProgress}%</div>
          </div>
        )}
        <div className={`stage-avatar-shell ${stageMode === "media" || stageMode === "loading" ? "is-dimmed" : ""}`}>
          <canvas ref={canvasRef} className="unity-canvas" />
        </div>
        <div className={`stage-media-shell ${stageMediaRef ? "is-mounted" : ""} ${stageMode === "media" ? "is-visible" : ""} ${stageMode === "loading" ? "is-loading" : ""} ${stageMode === "exiting" ? "is-exiting" : ""}`}>
          {stageMediaRef ? renderStageMedia(stageMediaRef, {
            onReady: handleStageMediaReady,
            onEnded: handleStageMediaEnded,
            showCover: stageMode === "loading",
          }) : null}
        </div>
      </div>

      {/* Layer 2-3: Floating UI overlay */}
      <div className="ui-overlay">
        {/* Top-left: branding */}
        <div className="overlay-branding">
          <span className="brand-name-cn">成都曜曜慧道科技有限公司</span>
          <span className="brand-name-en">Chengdu YaoYao Huidao Exhibition Co., Ltd.</span>
        </div>

        {/* Top-right: status + fullscreen + management */}
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
          <button type="button" className="overlay-btn" onClick={() => setRagOpen(true)} aria-label="打开知识库管理">
            <Database className="h-4 w-4" />
          </button>
        </header>

        {/* Left-bottom: media history (max 3, text cards) */}
        {recentUniqueMedia.length > 0 ? (
          <div className="media-history">
            {recentUniqueMedia.slice(0, 3).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`history-card is-${item.status}`}
                onClick={() => activateStageMedia(item.ref, item.sourceTraceId)}
              >
                <span className="history-card-text">{item.ref.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Idle hint */}
        {currentTurnMessages.length === 0 && stageMode === "avatar" ? (
          <div className="stage-idle-hint">点击下方麦克风开始对话</div>
        ) : null}

        {/* Subtitle bar — two-line structure: question + answer */}
        {subtitlePhase !== "hidden" && (latestUserText || displayedAssistantText) ? (
          <div className={`subtitle-bar ${subtitlePhase === "fading" ? "is-fading" : ""}`}>
            {/* Line 1: User question */}
            {latestUserText ? (
              <div className="subtitle-question">
                <span className="subtitle-question-label">你：</span>
                <span className="subtitle-question-text">
                  {latestUserSource === "voice" ? (
                    hasPlayableAudio ? (
                      <button
                        type="button"
                        className="subtitle-question-audio-btn"
                        onClick={() => {
                          // Play via Web Audio API (works in both Tauri and browser)
                          const playFromArrayBuffer = (buf: ArrayBuffer) => {
                            const ctx = new AudioContext();
                            ctx.decodeAudioData(buf).then(decoded => {
                              const src = ctx.createBufferSource();
                              src.buffer = decoded;
                              src.connect(ctx.destination);
                              src.onended = () => ctx.close();
                              src.start();
                            }).catch(e => console.error("Audio decode failed", e));
                          };
                          if (latestUserAudioId && isTauriEnv()) {
                            // Fetch from Rust gateway cache by audioId
                            tauriGetCachedAudio(latestUserAudioId).then(result => {
                              if (!result) return;
                              const bin = atob(result.audioData);
                              const bytes = new Uint8Array(bin.length);
                              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                              playFromArrayBuffer(bytes.buffer);
                            }).catch(e => console.error("Play cached audio failed", e));
                          } else if (latestUserAudioBase64) {
                            const bin = atob(latestUserAudioBase64);
                            const bytes = new Uint8Array(bin.length);
                            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                            playFromArrayBuffer(bytes.buffer);
                          } else if (latestUserAudioUrl) {
                            // Blob URL (from browser recording)
                            fetch(latestUserAudioUrl).then(r => r.arrayBuffer()).then(playFromArrayBuffer)
                              .catch(e => console.error("Play audio failed", e));
                          }
                        }}
                        aria-label="播放识别前的原始语音"
                      >
                        <Volume2 className="subtitle-question-audio-icon" />
                      </button>
                    ) : (
                      <Volume2 className="subtitle-question-audio-icon" />
                    )
                  ) : null}
                  <span>{latestUserText}</span>
                </span>
              </div>
            ) : null}
            {/* Line 2: Assistant answer (scrollable, uniform-speed reveal) */}
            {displayedAssistantText ? (
              <div ref={subtitleScrollRef} className="subtitle-answer chat-scrollbar">
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {displayedAssistantText}
                  </ReactMarkdown>
                </div>
                {latestAssistantMediaRefs.length > 0 ? (
                  <div className="subtitle-media">
                    {latestAssistantMediaRefs.map((ref) => (
                      <button
                        key={`${ref.assetId}-${ref.url}`}
                        type="button"
                        className="subtitle-media-chip"
                        onClick={() => {
                          if (isPlayableMedia(ref.assetType)) {
                            activateStageMedia(ref, ref.traceId);
                            return;
                          }
                          window.open(ref.url, "_blank", "noopener,noreferrer");
                        }}
                      >
                        {renderMediaIcon(ref.assetType)}
                        <span>{ref.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <div ref={subtitleEndRef} />
                <div ref={messagesEndRef} />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Action bar */}
        <div className="action-bar">
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
              >
                {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                <span>{isRecording ? "点击结束录音" : "点击开始对话"}</span>
              </button>
              <button type="button" className="keyboard-toggle" onClick={() => setShowTextInput(true)} title="文字输入">
                <Keyboard className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </div>

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

function normalizeMediaRef(data: any): MediaRef {
  return {
    assetId: String(data.assetId ?? data.url),
    assetType: String(data.assetType ?? "document"),
    url: String(data.url),
    label: String(data.label ?? data.url),
    frameUrl: data.frameUrl ? String(data.frameUrl) : undefined,
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

function isPlayableMedia(assetType: string) {
  return assetType === "image" || assetType === "video" || assetType === "audio";
}

function renderStageMedia(
  ref: MediaRef,
  callbacks?: { onReady?: () => void; onEnded?: () => void; showCover?: boolean },
) {
  const playbackUrl = stripPlaybackFragment(ref.url);
  if (ref.assetType === "image") {
    return (
      <div className="stage-media-body">
        <img src={playbackUrl} alt={ref.label} className="stage-media-image" onLoad={callbacks?.onReady} />
      </div>
    );
  }
  if (ref.assetType === "video") {
    return (
      <div className="stage-media-body">
        <video
          src={playbackUrl}
          className="stage-media-video"
          controls
          autoPlay
          playsInline
          preload="auto"
          poster={ref.frameUrl}
          onCanPlay={callbacks?.onReady}
          onPlaying={callbacks?.onReady}
          onEnded={callbacks?.onEnded}
        />
        {ref.frameUrl ? <img src={ref.frameUrl} alt="" className={`stage-media-cover ${callbacks?.showCover ? "is-visible" : ""}`} /> : null}
      </div>
    );
  }
  if (ref.assetType === "audio") {
    return (
      <div className="stage-media-body stage-media-audio-wrap">
        <div className="stage-audio-visual">
          <Volume2 className="h-10 w-10" />
          <div>
            <strong>{ref.label}</strong>
            <p>音频资料已切换到舞台区播放。</p>
          </div>
        </div>
        <audio
          src={playbackUrl}
          className="stage-media-audio"
          controls
          autoPlay
          preload="auto"
          onCanPlay={callbacks?.onReady}
          onPlaying={callbacks?.onReady}
          onEnded={callbacks?.onEnded}
        />
      </div>
    );
  }
  return null;
}

function stripPlaybackFragment(url: string) {
  return url.split("#")[0];
}

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
