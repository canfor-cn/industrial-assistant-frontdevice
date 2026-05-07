/**
 * AudioActivityState — 数字人/用户的"原子音频活动状态"事实记录器。
 *
 * 设计哲学：state machine as **single source of truth**，**不调用任何外部模块**。
 * 消费者（视频播放器、Unity、灯光、动画……）各自订阅 state，**自行**决定如何反应。
 *
 * 例如：
 *   - 视频播放器看到 tts.playing=true → 自己降音量到 0.2
 *   - Unity 看到 user.speaking=true → 自己切待机口型
 *   - 灯光控制看到任一活跃 → 自己调亮度
 *   状态机本身不操作他们任何一个。
 *
 * 输入信号：
 *   - setTtsPlaying(playing): 由 worklet "state" 消息驱动（精确，audio thread 真实状态）
 *   - touchUserSpeech():       由 device audio_stream_chunk 心跳驱动；
 *                              内部 silenceMs(默认 2s) 后自动转 user.speaking=false
 *
 * 输出：
 *   - state: { tts: { playing }, user: { speaking } }
 *     可作为 useEffect / useMemo 依赖
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type AudioActivityState = {
  tts: { playing: boolean };
  user: { speaking: boolean };
};

const DEFAULT_USER_SILENCE_MS = 2000;

export interface AudioActivityController {
  /** 当前事实状态（reactive，可作 useEffect/useMemo 依赖）。 */
  readonly state: AudioActivityState;
  /** 由 worklet "state" 消息直接驱动的精确 TTS 播放状态。 */
  setTtsPlaying(playing: boolean): void;
  /** 用户说话心跳信号；每次调用刷新 silence timer，超时自动 user.speaking=false。 */
  touchUserSpeech(): void;
  /** 全部清零（page unload / barge-in 用）。 */
  reset(): void;
}

export function useAudioActivityState(options?: {
  userSilenceMs?: number;
}): AudioActivityController {
  const userSilenceMs = options?.userSilenceMs ?? DEFAULT_USER_SILENCE_MS;

  const [state, setState] = useState<AudioActivityState>(() => ({
    tts: { playing: false },
    user: { speaking: false },
  }));

  const userTimerRef = useRef<number | null>(null);

  const setTtsPlaying = useCallback((playing: boolean) => {
    setState((prev) => (prev.tts.playing === playing ? prev : { ...prev, tts: { playing } }));
  }, []);

  const clearUserTimer = useCallback(() => {
    if (userTimerRef.current != null) {
      window.clearTimeout(userTimerRef.current);
      userTimerRef.current = null;
    }
  }, []);

  const touchUserSpeech = useCallback(() => {
    setState((prev) => (prev.user.speaking ? prev : { ...prev, user: { speaking: true } }));
    clearUserTimer();
    userTimerRef.current = window.setTimeout(() => {
      userTimerRef.current = null;
      setState((prev) => ({ ...prev, user: { speaking: false } }));
    }, userSilenceMs);
  }, [clearUserTimer, userSilenceMs]);

  const reset = useCallback(() => {
    clearUserTimer();
    setState({ tts: { playing: false }, user: { speaking: false } });
  }, [clearUserTimer]);

  useEffect(() => {
    return () => {
      if (userTimerRef.current != null) window.clearTimeout(userTimerRef.current);
    };
  }, []);

  return { state, setTtsPlaying, touchUserSpeech, reset };
}
