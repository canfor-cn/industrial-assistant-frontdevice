import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';

// --- 1. 类型定义 ---
interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

interface MediaRef {
  assetId: string;
  assetType: 'image' | 'video' | 'audio' | 'document' | string;
  url: string;
  label: string;
  traceId?: string;
}

interface HostServiceStatus {
  id: string;
  label: string;
  state: string;
  healthy: boolean;
  detail?: string;
}

interface HostStatus {
  mode: 'browser' | 'tauri';
  relayUrl: string;
  services: HostServiceStatus[];
}

// --- 1.1 级联下落打字机组件 ---
const CascadeTypewriter = ({ text }: { text: string }) => {
  // 将文本拆分为字符数组
  const characters = Array.from(text);
  
  // 动画配置：下落时间为 0.4s，字符间延迟为 0.2s (符合 1落0, 2在1/3, 3在2/3 的逻辑)
  const duration = 0.4;
  const stagger = duration / 2;

  return (
    <span className="inline-flex flex-wrap">
      {characters.map((char, i) => (
        <motion.span
          key={i}
          initial={{ y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{
            duration: duration,
            delay: i * stagger,
            ease: "easeOut"
          }}
          className="inline-block whitespace-pre"
        >
          {char}
        </motion.span>
      ))}
    </span>
  );
};

// --- 1.2 数据流背景组件 ---
const DataStream = () => {
  const [chars, setChars] = useState('');
  useEffect(() => {
    const charset = '01ABCDEF';
    let str = '';
    for(let i=0; i<500; i++) str += charset[Math.floor(Math.random()*charset.length)] + (i % 10 === 0 ? '\n' : ' ');
    setChars(str + '\n' + str); // Double for seamless loop
  }, []);

  return (
    <div className="data-stream-bg">
      <div className="data-column whitespace-pre font-mono">
        {chars}
      </div>
    </div>
  );
};

declare global {
  interface Window {
    createUnityInstance: any;
    unityInstance: any;
  }
}

export default function App() {
  const colleagueUrl = (globalThis as typeof globalThis & { __WAKEFUSION_BG_URL__?: string }).__WAKEFUSION_BG_URL__ ?? "https://example.com";
  const relayUrl = (import.meta.env.VITE_WAKEFUSION_RELAY_URL as string | undefined) ?? "ws://127.0.0.1:8765";

  // --- 2. 状态管理 ---
  // 🌟 使用统一的对话列表，保证气泡顺序自然（不再分两个孤立的 state）
  const [messages, setMessages] = useState<{id: string, type: 'user'|'ai', text: string}[]>([]);
  const [mediaRefs, setMediaRefs] = useState<MediaRef[]>([]);
  const [isUnityLoaded, setIsUnityLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [uiOpacity, setUiOpacity] = useState(1);
  const [isSleeping, setIsSleeping] = useState(false);
  const [hostStatus, setHostStatus] = useState<HostStatus>({
    mode: 'browser',
    relayUrl,
    services: [],
  });
  const [hostBusy, setHostBusy] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const uiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- 3. Unity WebGL 加载逻辑 ---
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "/Build/Build.loader.js"; 
    script.async = true;
    
    script.onload = () => {
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
          preserveDrawingBuffer: false
        }
      };

      if (canvasRef.current) {
        window.createUnityInstance(canvasRef.current, config, (progress: number) => {
          setLoadingProgress(Math.round(progress * 100));
        }).then((instance: any) => {
          window.unityInstance = instance;
          setIsUnityLoaded(true);
          wakeUpUI();
        }).catch((err: any) => {
          console.error("❌ Unity 加载失败:", err);
        });
      }
    };

    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  // --- 4. WebSocket 通信逻辑 ---
  useEffect(() => {
    let ws: WebSocket | null = null;
    let isCleaningUp = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (isCleaningUp) return;
      
      ws = new WebSocket(relayUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("✅ Web UI 已成功连接到 Core Server");
      };

      // 🌟 修复：无论第一次还是重连，都必须重新绑定 onmessage！
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "subtitle_user") {
            const uniqueId = Date.now().toString() + "-user";
            setMessages([{ id: uniqueId, type: 'user', text: data.text }]);
            setMediaRefs([]);
            wakeUpUI();
          } 
          else if (data.type === "subtitle_ai_stream") {
            setMessages(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.type === 'ai') {
                next[next.length - 1] = { ...last, text: last.text + data.text };
                return next;
              }
              return [...next, {
                id: Date.now().toString() + "-ai-" + Math.random().toString(36).substring(2, 6),
                type: 'ai',
                text: data.text,
              }];
            });
            wakeUpUI();
          } 
          else if (data.type === "subtitle_clear") {
            setMessages([]); 
            setMediaRefs([]);
          }
          else if (data.type === "media_ref" && data.url) {
            setMediaRefs(prev => {
              const next = [
                {
                  assetId: String(data.assetId ?? data.url),
                  assetType: String(data.assetType ?? 'document'),
                  url: String(data.url),
                  label: String(data.label ?? data.url),
                  traceId: data.traceId ? String(data.traceId) : undefined,
                },
                ...prev.filter((item) => item.assetId !== String(data.assetId ?? data.url)),
              ];
              return next.slice(0, 4);
            });
            wakeUpUI();
          }
          
          // Unity 动作指令透传
          if (data.action === "playAudio" && window.unityInstance) {
            window.unityInstance.SendMessage("WebCommunication", "OnPlayAudio", JSON.stringify(data.data));
          }
        } catch (err) {
          console.error("WS 解析失败", err);
        }
      };

      ws.onclose = () => {
        // 只有在非主动卸载组件的情况下，才尝试断线重连
        if (!isCleaningUp) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };
      
      ws.onerror = () => {
        // 静默捕获报错，防止红字污染控制台
      };
    };

    // 🌟 核心修复：延迟 150ms 连接，完美避开 React StrictMode 的瞬间挂载/卸载风暴
    const startTimeout = setTimeout(connect, 150);

    return () => {
      // 清理逻辑，彻底掐断幽灵连接
      isCleaningUp = true;
      clearTimeout(startTimeout);
      clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null; // 摘除回调，防止触发重连
        ws.onerror = null;
        ws.close();
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [relayUrl]);

  useEffect(() => {
    let cancelled = false;

    const loadHostStatus = async () => {
      try {
        const status = await invoke<HostStatus>('host_status');
        if (!cancelled) {
          setHostStatus(status);
        }
      } catch {
        if (!cancelled) {
          setHostStatus({
            mode: 'browser',
            relayUrl,
            services: [],
          });
        }
      }
    };

    void loadHostStatus();
    const timer = setInterval(loadHostStatus, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [relayUrl]);

  // --- 5. 演示模式已移除，改为完全数据驱动 ---

  // --- 6. UI 唤醒与自动隐藏逻辑 ---
  const wakeUpUI = () => {
    setUiOpacity(1);
    setIsSleeping(false);
    if (uiTimeoutRef.current) clearTimeout(uiTimeoutRef.current);
    uiTimeoutRef.current = setTimeout(() => {
      setUiOpacity(0);
      setIsSleeping(true);
      // 15秒后自动清空消息，触发退出动画
      setMessages([]);
    }, 15000);
  };

  const appendMessage = (text: string, sender: 'user' | 'ai') => {
    // 兼容旧版协议：将 sender 转换为 type
    const type = sender === 'user' ? 'user' : 'ai';
    setMessages(prev => {
      // 如果当前是休眠状态，清空旧消息，只显示新的
      const base = isSleeping ? [] : prev.slice(-4);
      return [...base, {
        id: Date.now().toString() + Math.random(),
        type,
        text
      }];
    });
    wakeUpUI();
  };

  const runHostCommand = async (command: 'start_stack' | 'stop_stack' | 'restart_stack') => {
    setHostBusy(true);
    try {
      await invoke(command);
      const status = await invoke<HostStatus>('host_status');
      setHostStatus(status);
    } catch (error) {
      console.error(`宿主命令 ${command} 执行失败`, error);
    } finally {
      setHostBusy(false);
    }
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent font-mono">
      
      {/* 1. 同事网页背景 */}
      <iframe 
        src={colleagueUrl}
        className="absolute inset-0 z-0 w-full h-full border-none pointer-events-auto"
        title="Background"
      />

      {/* 2. 赛博网格装饰 (同步 UI 显隐，向下向后退去) */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 0 }}
        animate={{ 
          opacity: uiOpacity ? 0.2 : 0, 
          scale: uiOpacity ? 1 : 0.9,
          y: uiOpacity ? 0 : 100 // 向下退去
        }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="absolute inset-0 z-10 pointer-events-none overflow-hidden"
      >
        <div className="cyber-grid-warp absolute inset-0" />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-60" />
      </motion.div>

      {/* 3. 数字人层 */}
      <motion.div 
        drag
        dragMomentum={false}
        className="absolute bottom-0 left-0 z-20 w-[28vw] h-[80vh] cursor-grab active:cursor-grabbing pointer-events-auto"
        initial={{ x: 20, y: 0 }}
      >
        <div className="relative w-full h-full">
          <canvas id="unity-canvas" ref={canvasRef} className="w-full h-full bg-transparent outline-none" />
          {!isUnityLoaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-cyan-900/10 backdrop-blur-md rounded-3xl border border-cyan-500/20">
              <span className="text-cyan-400 text-xs mb-4 tracking-[0.3em] animate-pulse">INITIALIZING NEURAL CORE...</span>
              <div className="w-32 h-0.5 bg-cyan-900/30 rounded-full overflow-hidden">
                <motion.div className="h-full bg-cyan-400 shadow-[0_0_10px_#22d3ee]" animate={{ width: `${loadingProgress}%` }} />
              </div>
            </div>
          )}
        </div>
      </motion.div>

      {/* 4. 赛博对话 UI 层 (同步锁屏/解锁特效，完全数据驱动) */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ 
          opacity: uiOpacity, 
          scale: uiOpacity ? 1 : 0.9 
        }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="absolute inset-0 z-30 w-full h-full pointer-events-none flex flex-col justify-end pb-20 px-12"
      >
        <div className="w-full flex flex-col justify-end gap-10">
          <AnimatePresence mode="popLayout">
            {/* 🌟 动态字幕渲染区：统一的 messages 列表 */}
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                layout
                initial={{ 
                  opacity: 0, 
                  x: msg.type === 'ai' ? -200 : 200,
                  scale: 0.8,
                  filter: 'blur(10px)' 
                }}
                animate={{ 
                  opacity: 1, 
                  x: 0, 
                  scale: 1,
                  filter: 'blur(0px)' 
                }}
                exit={{ 
                  opacity: 0, 
                  scale: 0.8, 
                  x: msg.type === 'ai' ? -200 : 200,
                  filter: 'blur(10px)' 
                }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                className="grid grid-cols-5 w-full gap-12"
              >
                {msg.type === 'ai' ? (
                  <div className="col-start-2 col-span-2 flex justify-start pointer-events-auto">
                    <div className="glass-neural-ai scanline px-10 py-6">
                      <DataStream />
                      <div className="relative z-10">
                        <div className="flex items-center gap-3 mb-2 opacity-40">
                          <div className="w-2 h-2 bg-cyan-400 animate-ping" />
                          <span className="text-[10px] tracking-[0.2em] text-cyan-400 font-bold uppercase">Entity_Response</span>
                        </div>
                        <p className="text-2xl font-bold text-cyan-50 leading-tight tracking-tight">
                          <CascadeTypewriter text={msg.text} />
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="col-start-4 col-span-2 flex justify-end pointer-events-auto">
                    <div className="glass-neural-user scanline px-10 py-6">
                      <DataStream />
                      <div className="relative z-10">
                        <div className="flex items-center justify-end gap-3 mb-2 opacity-40">
                          <span className="text-[10px] tracking-[0.2em] text-fuchsia-400 font-bold uppercase">User_Input</span>
                          <div className="w-2 h-2 bg-fuchsia-400 animate-ping" />
                        </div>
                        <p className="text-2xl font-bold text-fuchsia-50 leading-tight tracking-tight text-right">
                          <CascadeTypewriter text={msg.text} />
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, x: 80 }}
        animate={{ opacity: uiOpacity, x: uiOpacity ? 0 : 80 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="absolute right-10 top-10 z-30 w-[22rem] pointer-events-auto"
      >
        <div className="glass-neural-ai scanline px-6 py-5 mb-4">
          <DataStream />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4 opacity-50">
              <div className="w-2 h-2 bg-cyan-400 animate-ping" />
              <span className="text-[10px] tracking-[0.2em] text-cyan-400 font-bold uppercase">Knowledge Panel</span>
            </div>
            {mediaRefs.length === 0 ? (
              <p className="text-sm text-cyan-100/70 leading-6">当前无资料联动内容。</p>
            ) : (
              <div className="flex flex-col gap-3">
                {mediaRefs.map((asset) => (
                  <a
                    key={asset.assetId}
                    href={asset.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-2xl border border-cyan-400/20 bg-black/30 px-4 py-3 hover:border-cyan-300/40"
                  >
                    <div className="text-[10px] tracking-[0.16em] uppercase text-cyan-300/60">{asset.assetType}</div>
                    <div className="mt-1 text-base font-semibold text-cyan-50">{asset.label}</div>
                    <div className="mt-2 truncate text-xs text-cyan-100/60">{asset.url}</div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="glass-neural-ai scanline px-6 py-5">
          <DataStream />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4 opacity-50">
              <div className="w-2 h-2 bg-emerald-400 animate-ping" />
              <span className="text-[10px] tracking-[0.2em] text-emerald-300 font-bold uppercase">Host Control</span>
            </div>
            <div className="mb-3 text-xs text-cyan-100/70">
              模式：<span className="text-cyan-50">{hostStatus.mode}</span>
            </div>
            <div className="mb-4 text-xs text-cyan-100/70 break-all">
              Relay：<span className="text-cyan-50">{hostStatus.relayUrl}</span>
            </div>
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                disabled={hostBusy || hostStatus.mode !== 'tauri'}
                onClick={() => void runHostCommand('start_stack')}
                className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100 disabled:opacity-40"
              >
                启动
              </button>
              <button
                type="button"
                disabled={hostBusy || hostStatus.mode !== 'tauri'}
                onClick={() => void runHostCommand('restart_stack')}
                className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100 disabled:opacity-40"
              >
                重启
              </button>
              <button
                type="button"
                disabled={hostBusy || hostStatus.mode !== 'tauri'}
                onClick={() => void runHostCommand('stop_stack')}
                className="rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-100 disabled:opacity-40"
              >
                停止
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {hostStatus.services.length === 0 ? (
                <p className="text-sm text-cyan-100/70 leading-6">浏览器模式下不接管本地进程。</p>
              ) : (
                hostStatus.services.map((service) => (
                  <div key={service.id} className="rounded-2xl border border-cyan-400/20 bg-black/30 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-cyan-50">{service.label}</div>
                      <div className={`text-[10px] uppercase tracking-[0.16em] ${service.healthy ? 'text-emerald-300' : 'text-amber-300'}`}>
                        {service.state}
                      </div>
                    </div>
                    {service.detail ? (
                      <div className="mt-2 text-xs text-cyan-100/60 break-all">{service.detail}</div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* 底部装饰线 */}
      <div className="absolute inset-0 z-10 pointer-events-none opacity-10 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%]" />
    </div>
  );
}
