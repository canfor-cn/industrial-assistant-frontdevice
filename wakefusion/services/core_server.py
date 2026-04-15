# Fix Windows GBK encoding crash when spawned without terminal
import sys as _sys
if hasattr(_sys.stdout, 'reconfigure'):
    try:
        _sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        _sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

"""
核心决策模块 (Core Server)
整合视觉和音频输入，实现多模态唤醒和状态管理
"""
import zmq
import json
import base64
import time
import threading
import queue
import logging
import uuid
import asyncio
from enum import Enum
from typing import Optional
from wakefusion.config import get_config
try:
    import websockets
except ImportError:
    websockets = None  # 如果未安装，设置为None
# SystemState枚举已删除，改用布尔标志位

# 配置日志
logger = logging.getLogger("core_server")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
logger.addHandler(handler)


class CoreServer:
    """核心决策服务器"""
    
    def __init__(self, config_path: Optional[str] = None,
                 vision_queue: Optional["queue.Queue"] = None,
                 lip_sync_event: Optional[threading.Event] = None):
        """
        初始化核心服务器

        Args:
            config_path: 配置文件路径（可选）
            vision_queue: 视觉数据队列（替代 ZMQ SUB :5555）
            lip_sync_event: 唇动检测控制事件（替代 ZMQ PUB :5564）
        """
        # 加载配置
        self.config = get_config(config_path)
        self.zmq_config = self.config.zmq
        self.vision_wake_config = self.config.vision_wake
        self.audio_threshold_config = self.config.audio_threshold
        self.conversation_config = self.config.conversation
        self.llm_agent_config = self.config.llm_agent
        self.audio_playback_config = self.config.audio_playback
        
        # 初始化ZMQ Context
        self.zmq_context = zmq.Context()
        
        # 视觉数据队列（替代 ZMQ SUB :5555）
        self._vision_queue = vision_queue
        self._lip_sync_event = lip_sync_event
        
        self.audio_sub_socket = self.zmq_context.socket(zmq.SUB)
        self.audio_sub_socket.connect(f"tcp://127.0.0.1:{self.zmq_config.audio_pub_port}")
        self.audio_sub_socket.setsockopt_string(zmq.SUBSCRIBE, "")
        
        # ZMQ REQ Socket（控制音频模块）
        self.audio_req_socket = self.zmq_context.socket(zmq.REQ)
        self.audio_req_socket.connect(f"tcp://127.0.0.1:{self.zmq_config.audio_ctrl_port}")
        self.audio_req_socket.setsockopt(zmq.REQ_RELAXED, 1)
        self.audio_req_socket.setsockopt(zmq.REQ_CORRELATE, 1)
        self.audio_req_socket.setsockopt(zmq.RCVTIMEO, self.zmq_config.req_rep_timeout_ms)
        
        # ASR相关Socket已删除（ASR已迁移到服务器端）
        
        # VAD 防抖参数（展厅抗噪核心）
        self._vad_speech_count: int = 0
        self._vad_silence_count: int = 0
        
        # ZMQ REP Socket（接收LLM控制指令）
        self._control_rep_socket: Optional[zmq.Socket] = None
        
        # 视觉控制通过 lip_sync_event（threading.Event）替代 ZMQ PUB :5564
        
        # 音频播放队列（可清空）
        self.audio_playback_queue = queue.Queue()
        self._playback_active = False
        self._playback_thread: Optional[threading.Thread] = None
        
        # 音频预缓冲相关变量
        self._audio_prebuffer = []  # 预缓冲列表
        self._prebuffer_target_ms = self.audio_playback_config.prebuffer_ms  # 目标预缓冲时长（毫秒）
        self._prebuffer_target_samples = int(self.audio_playback_config.sample_rate * self._prebuffer_target_ms / 1000)  # 目标采样点数
        self._is_prebuffering = True  # 是否处于预缓冲阶段
        
        # Session管理
        self._current_audio_session_id: Optional[str] = None  # 当前音频流session ID
        self._binary_frame_shield_until: float = 0.0  # 二进制帧屏蔽截止时间
        self._current_audio_seq: int = 0  # 当前上行音频段 chunk 序号
        
        # 防回声的Drain机制
        self._wait_for_audio_drain = False  # 等待音频排空标志
        self._media_ducked = False  # 当前媒体是否处于压低音量状态
        
        # 硬件冷却期（硬打断后）
        self._cooldown_until: float = 0.0
        
        # 🌟 新增：用于屏蔽麦克风瞬间开启时的物理电流声或尾音回声
        self._ignore_audio_until: float = 0.0
        
        # ZMQ Socket 线程安全锁 (防止跨线程并发调用导致C++底层崩溃)
        self._audio_req_lock = threading.Lock()
        # _vision_ctrl_lock removed (lip_sync_event is thread-safe)
        self._state_lock = threading.RLock()  # 可重入锁：允许同一线程多次获取（例如 _process_vision_data 持有锁后调用 _exit_interactive_mode）
        
        # Poller用于同时监听多个socket
        self.poller = zmq.Poller()
        self.poller.register(self.audio_sub_socket, zmq.POLLIN)
        
        # 状态管理（使用布尔标志位替代SystemState枚举）
        self.is_interactive_mode: bool = False  # 是否处于持续对话交互期
        self.is_playing_tts: bool = False  # 当前喇叭是否在出声
        self.is_vision_target_present: bool = False  # 视觉区间[0.4m, 4.5m]内是否有人
        
        # 视觉状态缓存
        self._latest_vision_wake: bool = False
        self._latest_vision_is_talking: bool = False
        self._last_vision_timestamp: float = 0.0
        
        # VAD超时管理（已改为纯事件驱动，不再需要独立线程）
        self._last_vad_time: float = 0.0
        self._last_lip_active_time: float = time.time()  # 唇动计时器
        self.current_silence_timeout: float = self.conversation_config.vad_silence_timeout_default_sec
        
        # 90秒交互超时管理
        self._interactive_timeout_thread: Optional[threading.Thread] = None
        self._interactive_timeout_should_exit: bool = False
        self._last_vad_false_time: float = 0.0  # 最后一次VAD变为False的时间
        
        # 🌟 保底机制：30秒交流上限时间（防止视觉受损和极度噪音环境下数据无限制传输）
        self._listening_start_time: float = 0.0  # 进入LISTENING状态的时间戳
        self._max_listening_duration: float = self.conversation_config.long_sentence_timeout_s  # 最大监听时长（秒），使用长句保底超时配置
        
        # 对话轮次和唤醒路径管理已删除（简化架构，不再需要）
        
        # 宏微观双重超时管理
        self._user_has_spoken: bool = False  # 用户是否已开口（用于微观超时判断）
        self._vad_silence_start: Optional[float] = None  # VAD静音开始时间
        self._lip_silence_start: Optional[float] = None  # 唇动静音开始时间
        self._interactive_start_time: Optional[float] = None  # 进入交互模式的时间戳
        
        # PROCESSING超时管理
        self._processing_start_time: float = 0.0
        self._processing_timeout_sec: float = self.config.runtime.processing_timeout_sec
        self._processing_timeout_thread: Optional[threading.Thread] = None
        self._processing_timeout_should_exit: bool = False
        
        # traceID管理（在VAD从False变True且trace_id==None时生成）
        self._current_trace_id: Optional[str] = None
        self._last_vad_state: bool = False  # 上一次VAD状态，用于检测VAD从False变True
        
        # WebSocket Client（统一网关）
        self._ws_client = None
        self._ws_connected = False
        self._ws_thread: Optional[threading.Thread] = None
        self._ws_loop: Optional[asyncio.AbstractEventLoop] = None
        
        # 本地WebSocket Server（用于转发消息给UI）
        self._ui_ws_server = None
        self._ui_ws_clients = set()  # 存储连接的UI客户端
        self._ui_ws_thread: Optional[threading.Thread] = None
        self._ui_ws_loop: Optional[asyncio.AbstractEventLoop] = None

        # UI音频缓冲：按traceId缓存上行PCM块，ASR结果到达时附带音频发给前端
        self._ui_audio_buffer: dict = {}  # {trace_id: [bytes, ...]}
        
        # 初始化控制socket
        self._init_control_socket()
        
        # 初始化视觉控制socket
        self._init_vision_ctrl_socket()
        
        # ASR相关初始化已删除（ASR已迁移到服务器端）
        
        # 初始化WebSocket Client
        self._init_websocket_client()
        
        # 初始化本地WebSocket Server（用于转发消息给UI）
        self._init_ui_websocket_server()
        
        # 启动音频播放线程
        self._start_playback_thread()
        
        logger.info("Core Server initialized")
        logger.info(f"  Vision SUB: tcp://127.0.0.1:{self.zmq_config.vision_pub_port}")
        logger.info(f"  Audio SUB: tcp://127.0.0.1:{self.zmq_config.audio_pub_port}")
        logger.info(f"  Audio REQ: tcp://127.0.0.1:{self.zmq_config.audio_ctrl_port}")
        logger.info(f"  ASR Result PULL: tcp://127.0.0.1:{self.zmq_config.asr_result_push_port}")
        logger.info(f"  Vision Data: {'queue' if vision_queue else 'disabled'}")
        logger.info(f"  Control REP: tcp://127.0.0.1:{self.zmq_config.core_control_rep_port}")
        logger.info(f"  LLM Agent: {self.llm_agent_config.host} (deviceId: {self.llm_agent_config.device_id})")
        logger.info(f"  Initial timeout: {self.current_silence_timeout}s")
    
    def _reconnect_audio_socket(self):
        """重新连接音频REQ socket（当audio_service重启时）"""
        try:
            if self.audio_req_socket:
                self.audio_req_socket.close()
        except:
            pass
        try:
            self.audio_req_socket = self.zmq_context.socket(zmq.REQ)
            self.audio_req_socket.connect(f"tcp://127.0.0.1:{self.zmq_config.audio_ctrl_port}")
            self.audio_req_socket.setsockopt(zmq.REQ_RELAXED, 1)
            self.audio_req_socket.setsockopt(zmq.REQ_CORRELATE, 1)
            self.audio_req_socket.setsockopt(zmq.RCVTIMEO, self.zmq_config.req_rep_timeout_ms)
            logger.info("🔄 音频REQ socket已重新连接")
            return True
        except Exception as e:
            logger.error(f"❌ 音频REQ socket重连失败: {e}")
            return False
    
    def _send_vision_command(self, command: str):
        """向音频模块发送视觉触发命令"""
        try:
            with self._audio_req_lock:
                self.audio_req_socket.send_json({"command": command})
                reply = self.audio_req_socket.recv_json()
                logger.info(f"👁️ 视觉命令 {command}: {reply}")
        except Exception as e:
            logger.warning(f"⚠️ 视觉命令 {command} 发送失败: {e}")

    def _send_threshold_command(self, threshold: float):
        """向音频模块发送阈值调整指令（带自动重连）"""
        max_retries = 2
        for attempt in range(max_retries):
            try:
                with self._audio_req_lock:
                    self.audio_req_socket.send_json({"command": "set_threshold", "value": threshold})
                    reply = self.audio_req_socket.recv_json()
                    if reply.get("status") == "ok":
                        old_threshold = getattr(self, '_last_sent_threshold', None)
                        if old_threshold is None or abs(threshold - old_threshold) > 0.01:
                            logger.info(f"✅ 音频阈值已更新: {threshold:.2f}")
                        self._last_sent_threshold = threshold
                        return True
                    else:
                        logger.warning(f"⚠️ 音频阈值更新失败: {reply}")
                        return False
            except (zmq.Again, zmq.ZMQError, ConnectionError) as e:
                if attempt < max_retries - 1:
                    logger.warning(f"⚠️ 音频阈值更新失败，尝试重连 (尝试 {attempt + 1}/{max_retries})...")
                    if self._reconnect_audio_socket():
                        continue
                logger.error(f"❌ 音频阈值更新失败: {e}")
                return False
        return False
    
    def _init_control_socket(self):
        """初始化控制socket（接收LLM指令）"""
        self._control_rep_socket = self.zmq_context.socket(zmq.REP)
        self._control_rep_socket.bind(f"tcp://127.0.0.1:{self.zmq_config.core_control_rep_port}")
        self._control_rep_socket.setsockopt(zmq.RCVTIMEO, 100)  # 100ms超时，非阻塞
        self.poller.register(self._control_rep_socket, zmq.POLLIN)
    
    def _init_vision_ctrl_socket(self):
        """视觉控制已改为 threading.Event，此方法保留为空"""
        logger.info("  Vision Ctrl: threading.Event (in-process)")
    
    # ASR相关方法已删除（ASR已迁移到服务器端）
    
    def _init_websocket_client(self):
        """初始化WebSocket Client（统一网关）"""
        try:
            import websockets
            self._websockets_module = websockets
        except ImportError:
            logger.error("❌ websockets未安装，无法连接LLM Agent。请运行: pip install websockets")
            return
        
        # 启动WebSocket Client线程
        self._ws_thread = threading.Thread(target=self._websocket_client_worker, daemon=True)
        self._ws_thread.start()
        logger.info("🌐 WebSocket Client线程已启动")
    
    def _init_ui_websocket_server(self):
        """UI WebSocket Server已废弃 — UI由Rust宿主WebView提供"""
        logger.info("UI WebSocket Server已禁用（由Rust宿主管理）")
    
    def _ui_websocket_server_worker(self):
        """UI WebSocket Server工作线程"""
        import websockets
        
        # 创建新的事件循环
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._ui_ws_loop = loop
        
        async def handle_ui_client(websocket, *args, **kwargs):
            """处理UI客户端连接（兼容websockets 14+去除path参数的变更）"""
            self._ui_ws_clients.add(websocket)
            logger.info(f"🎨 UI客户端已连接: {websocket.remote_address}")
            try:
                # 保持连接，等待消息
                async for message in websocket:
                    # UI可能发送消息，这里可以处理
                    try:
                        data = json.loads(message)
                        logger.debug(f"📨 收到UI消息: {data.get('type')}")
                    except:
                        pass
            except websockets.exceptions.ConnectionClosed:
                pass
            finally:
                self._ui_ws_clients.discard(websocket)
                logger.info(f"🎨 UI客户端已断开: {websocket.remote_address}")
        
        async def server_main():
            """启动WebSocket服务器"""
            ui_port = self._ui_ws_port
            async with websockets.serve(handle_ui_client, "127.0.0.1", ui_port):
                logger.info(f"✅ UI WebSocket Server已启动 (ws://127.0.0.1:{ui_port})")
                await asyncio.Future()  # 永久运行
        
        try:
            loop.run_until_complete(server_main())
        except Exception as e:
            logger.error(f"❌ UI WebSocket Server异常: {e}")
    
    def _forward_to_ui(self, message: dict):
        """转发消息给所有连接的UI客户端（线程安全）"""
        if not self._ui_ws_clients or not self._ui_ws_loop:
            return
        
        try:
            message_json = json.dumps(message, ensure_ascii=False)
            # 使用线程安全的方式发送
            asyncio.run_coroutine_threadsafe(
                self._broadcast_to_ui_clients(message_json),
                self._ui_ws_loop
            )
        except Exception as e:
            logger.debug(f"转发消息给UI失败: {e}")

    def _set_media_duck(self, action: str, level: float):
        """通知前端媒体播放器降音量或恢复音量"""
        self._forward_to_ui({
            "type": "media_duck",
            "action": action,
            "level": level,
        })
    
    async def _broadcast_to_ui_clients(self, message_json: str):
        """向所有UI客户端广播消息"""
        disconnected = set()
        for client in self._ui_ws_clients:
            try:
                await client.send(message_json)
            except Exception:
                disconnected.add(client)
        
        # 清理断开的连接
        self._ui_ws_clients -= disconnected
    
    def _websocket_client_worker(self):
        """WebSocket Client工作线程（异步事件循环）"""
        import websockets
        import websockets.exceptions
        
        # 创建新的事件循环（在独立线程中）
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._ws_loop = loop
        
        # 构建WebSocket URL — 连接到Rust宿主的device_ws_server
        device_upstream = getattr(self.config, 'device_upstream', None)
        if device_upstream and hasattr(device_upstream, 'host'):
            upstream_host = device_upstream.host
            upstream_port = getattr(device_upstream, 'port', 8765)
            url = f"ws://{upstream_host}:{upstream_port}"
        else:
            # Fallback: 连接Rust宿主默认地址
            url = "ws://127.0.0.1:8765"

        reconnect_interval = getattr(self.llm_agent_config, 'reconnect_interval_sec', 5.0)
        ping_interval = getattr(self.llm_agent_config, 'ping_interval_sec', 30.0)
        
        async def client_main():
            """WebSocket客户端主循环"""
            while True:
                try:
                    logger.info(f"🔌 正在连接LLM Agent: {url}")
                    async with websockets.connect(url) as websocket:
                        self._ws_client = websocket
                        self._ws_connected = True
                        logger.info("✅ WebSocket已连接")
                        
                        # 发送初始设备状态
                        self._report_device_state("idle")
                        
                        # 启动ping任务
                        ping_task = asyncio.create_task(self._ping_worker(websocket, ping_interval))
                        
                        try:
                            # 接收消息循环
                            async for message in websocket:
                                try:
                                    if isinstance(message, str):
                                        try:
                                            data = json.loads(message)
                                            await self._handle_websocket_message(data)
                                        except json.JSONDecodeError:
                                            logger.warning(f"⚠️ 无效的JSON消息: {message}")
                                    elif isinstance(message, bytes):
                                        logger.warning("⚠️ 收到遗留二进制帧，当前统一协议只处理 JSON 文本帧")
                                except Exception as e:
                                    logger.error(f"❌ 处理WebSocket消息失败: {e}")
                        except websockets.exceptions.ConnectionClosed:
                            logger.warning("⚠️ WebSocket连接已关闭")
                            # 🌟 网络断线处理：丢弃音频，清空trace_id，退出交互模式
                            with self._state_lock:
                                self._current_trace_id = None
                                if self.is_interactive_mode:
                                    logger.warning("🚨 网络断线，退出交互模式")
                                    self.is_interactive_mode = False
                                    self._send_stop_streaming_command()
                        finally:
                            ping_task.cancel()
                            self._ws_connected = False
                            self._ws_client = None
                
                except Exception as e:
                    logger.error(f"❌ WebSocket连接失败: {e}")
                    # 🌟 网络断线处理：丢弃音频，清空trace_id，退出交互模式
                    with self._state_lock:
                        self._current_trace_id = None
                        if self.is_interactive_mode:
                            logger.warning("🚨 网络连接失败，退出交互模式")
                            self.is_interactive_mode = False
                            self._send_stop_streaming_command()
                    self._ws_connected = False
                    self._ws_client = None
                
                # 重连前等待
                logger.info(f"⏳ {reconnect_interval}秒后重连...")
                await asyncio.sleep(reconnect_interval)
        
        # 运行事件循环
        loop.run_until_complete(client_main())
    
    async def _ping_worker(self, websocket, interval: float):
        """Ping保活任务"""
        try:
            while True:
                await asyncio.sleep(interval)
                # 🌟 修复：直接尝试发送ping，如果连接已关闭会抛出异常
                try:
                    await websocket.send(json.dumps({"type": "ping"}))
                except Exception as e:
                    # 检查是否是连接关闭异常（兼容不同版本的websockets）
                    if "ConnectionClosed" in str(type(e).__name__) or "ConnectionClosed" in str(e):
                        # 连接已关闭，退出循环
                        break
                    # 检查是否是AttributeError（websocket对象可能已被销毁）
                    if isinstance(e, AttributeError):
                        # websocket对象可能已被销毁，退出循环
                        break
                    # 其他异常继续抛出
                    raise
        except asyncio.CancelledError:
            # 任务被取消（正常情况，当连接关闭时）
            pass
        except Exception as e:
            # 其他异常，记录但不中断主循环
            logger.debug(f"Ping任务异常（已忽略）: {e}")
    
    async def _handle_websocket_message(self, data: dict):
        """处理从LLM Agent接收的WebSocket消息"""
        msg_type = data.get("type")
        
        if msg_type == "route":
            if self.is_interactive_mode and not self.is_playing_tts:
                self._report_device_state("thinking")
            logger.info(f"🧭 路由结果: {data.get('route', '')}")
        elif msg_type == "asr":
            text = data.get("text", "")
            if text:
                logger.info(f"📝 转发用户字幕: {text}")
                trace_id = data.get("traceId")
                stage = data.get("stage", "final")
                ui_msg = {
                    "type": "subtitle_user",
                    "traceId": trace_id,
                    "stage": stage,
                    "text": text
                }
                # ASR final 时附带录音音频（WAV base64）供前端播放
                if stage == "final" and trace_id and trace_id in self._ui_audio_buffer:
                    chunks = self._ui_audio_buffer.pop(trace_id, [])
                    if chunks:
                        pcm_data = b"".join(chunks)
                        wav_data = self._pcm_to_wav(pcm_data, 16000, 1, 16)
                        ui_msg["audioData"] = base64.b64encode(wav_data).decode("ascii")
                        ui_msg["audioMime"] = "audio/wav"
                self._forward_to_ui(ui_msg)
        elif msg_type == "token":
            text = data.get("text", "")
            if text:
                self._forward_to_ui({
                    "type": "subtitle_ai_stream",
                    "traceId": data.get("traceId"),
                    "text": text
                })
        elif msg_type == "media_ref":
            self._forward_to_ui({
                "type": "media_ref",
                "traceId": data.get("traceId"),
                "assetId": data.get("assetId"),
                "assetType": data.get("assetType"),
                "url": data.get("url"),
                "label": data.get("label"),
                "startMs": data.get("startMs"),
                "endMs": data.get("endMs")
            })
        elif msg_type == "audio_begin":
            # 从 audio_begin 中读取实际采样率，动态适配播放参数
            server_sr = data.get("sampleRate")
            if server_sr and isinstance(server_sr, (int, float)) and int(server_sr) > 0:
                new_sr = int(server_sr)
                if new_sr != self._current_playback_sample_rate:
                    logger.info(f"🎵 采样率切换: {self._current_playback_sample_rate} → {new_sr}Hz")
                    self._current_playback_sample_rate = new_sr
                    self._need_reopen_stream = True
            logger.info(f"🎵 收到 audio_begin，重置本地播放缓冲 (sampleRate={self._current_playback_sample_rate}Hz)")
            self._current_audio_session_id = str(uuid.uuid4())
            self._audio_prebuffer.clear()
            self._is_prebuffering = True
            self._wait_for_audio_drain = False
            self._start_tts_playback()
        elif msg_type == "audio_chunk":
            audio_b64 = data.get("data", "")
            if audio_b64:
                await self._handle_websocket_audio_chunk(audio_b64)
        elif msg_type == "audio_end":
            logger.info("📥 收到 audio_end，等待音频队列排空")
            if self._is_prebuffering and self._audio_prebuffer:
                for buffered_data in self._audio_prebuffer:
                    try:
                        self.audio_playback_queue.put_nowait(buffered_data.tobytes())
                    except queue.Full:
                        pass
                self._audio_prebuffer.clear()
                self._is_prebuffering = False
            self._wait_for_audio_drain = True
        elif msg_type == "stop_tts":
            # 停止TTS合成
            logger.info("🛑 收到stop_tts消息，清空播放队列和预缓冲区")
            self.clear_playback_queue()
            self._audio_prebuffer.clear()
            self._is_prebuffering = True
            # 更新session_id以屏蔽残留帧
            self._current_audio_session_id = str(uuid.uuid4())
            # 设置500ms二进制流屏蔽期
            self._binary_frame_shield_until = time.time() + 0.5
        elif msg_type == "stop":
            reason = data.get("reason", "server_stop")
            logger.warning(f"🛑 [最高指令] 收到服务端 stop 指令 (原因: {reason})")
            logger.warning(f"🚨 强制终止：立即停止播报，并完全退出唤醒交互状态！")
            
            # 1. 强行停止当前的 TTS 播报和嘴型动作
            self._stop_tts_playback()
            
            # 2. 清空字幕
            self._forward_to_ui({"type": "subtitle_clear"})
            
            # 3. 彻底退出交互模式（自动通知底层断开推流、重置冷却，阈值恢复 0.9）
            if self.is_interactive_mode:
                self._exit_interactive_mode()
        elif msg_type == "tts_playing":
            # Rust 前端正在播放 TTS — 保持交互模式，刷新活动时间
            self.is_playing_tts = True
            self._last_speech_time = time.time()
            logger.debug("🔊 [持续对话] TTS 播放中，保持交互模式")
        elif msg_type == "tts_idle":
            # Rust 前端 TTS 播完 — 开始等待用户下一句话
            self.is_playing_tts = False
            self._last_speech_time = time.time()  # 从现在开始计算空闲
            logger.info("🔇 [持续对话] TTS 播放完毕，等待用户继续对话...")
        elif msg_type == "pong":
            # Ping响应
            pass
        elif msg_type == "error":
            # 错误消息
            error_msg = data.get("message", "未知错误")
            logger.error(f"❌ LLM Agent错误: {error_msg}")
        elif msg_type == "final":
            self._forward_to_ui({
                "type": "subtitle_ai_commit",
                "traceId": data.get("traceId")
            })
        elif msg_type == "warning":
            # 警告消息
            warn_msg = data.get("message", "未知警告")
            logger.warning(f"⚠️ LLM Agent警告: {warn_msg}")
    
    async def _handle_websocket_audio_chunk(self, audio_b64: str):
        """处理从 LLM Agent 接收的 base64 音频块"""
        import numpy as np
        
        # 检查屏蔽期
        if time.time() < self._binary_frame_shield_until:
            return  # 丢弃残留帧
        
        # 检查session_id（如果帧属于旧session，丢弃）
        # 注意：session_id在收到route消息时应该已经设置，这里只做校验
        # 如果_current_audio_session_id为None，说明是新的一轮，需要初始化
        if self._current_audio_session_id is None:
            self._current_audio_session_id = str(uuid.uuid4())
            logger.info(f"🎵 新音频流session开始: {self._current_audio_session_id}")
        
        # 转换为numpy数组
        try:
            audio_data = base64.b64decode(audio_b64)
            audio_array = np.frombuffer(audio_data, dtype=np.int16)
        except Exception as e:
            logger.error(f"❌ 音频数据转换失败: {e}")
            return
        
        # 首帧触发逻辑
        is_first_frame = False
        if self._is_prebuffering and len(self._audio_prebuffer) == 0:
            is_first_frame = True
            # 如果当前不在TTS播放状态，开始TTS播放
            if not self.is_playing_tts:
                self._start_tts_playback()
            # 🌟 修复：已删除发送START_LIP_SYNC给视觉模块的代码，防止误杀用户唇动检测
        
        # 预缓冲机制
        if self._is_prebuffering:
            # 预缓冲阶段：存入暂存区
            self._audio_prebuffer.append(audio_array)
            total_samples = sum(len(arr) for arr in self._audio_prebuffer)
            
            if total_samples >= self._prebuffer_target_samples:
                # 达到阈值：一次性入队所有缓冲数据
                for buffered_data in self._audio_prebuffer:
                    try:
                        self.audio_playback_queue.put_nowait(buffered_data.tobytes())
                    except queue.Full:
                        logger.warning("⚠️ 播放队列已满，丢弃音频块")
                        break
                self._audio_prebuffer.clear()
                self._is_prebuffering = False  # 切换到直通模式
                logger.info("✅ 预缓冲完成，切换到直通模式")
        else:
            # 直通模式：直接入队，无延迟
            try:
                self.audio_playback_queue.put_nowait(audio_data)
            except queue.Full:
                logger.warning("⚠️ 播放队列已满，丢弃音频块")
    
    # ASR结果接收和处理方法已删除（ASR已迁移到服务器端，结果通过WebSocket接收）
    
    def _send_websocket_message(self, message: dict):
        """通过WebSocket发送消息给LLM Agent（线程安全）"""
        if not self._ws_connected or not self._ws_client or not self._ws_loop:
            logger.debug("⚠️ WebSocket未连接，跳过消息发送")
            return
        
        try:
            message_json = json.dumps(message, ensure_ascii=False)
            # 使用线程安全的方式发送（从ZMQ线程调用WebSocket线程的event loop）
            asyncio.run_coroutine_threadsafe(
                self._ws_client.send(message_json),
                self._ws_loop
            )
        except Exception as e:
            logger.error(f"❌ 发送WebSocket消息失败: {e}")
    
    def _report_device_state(self, state: str):
        """上报设备状态（idle/listening/thinking/speaking），包含视觉和音频详情"""
        # 视觉状态
        vision_faces = 0
        vision_distance = None
        vision_talking = False
        if hasattr(self, '_latest_vision_is_talking'):
            vision_talking = self._latest_vision_is_talking
        if hasattr(self, '_vision_data_count'):
            # 从最近一帧视觉数据中提取
            pass
        # 从 _process_vision_data 中缓存的最新数据
        if hasattr(self, '_last_vision_faces'):
            vision_faces = self._last_vision_faces
        if hasattr(self, '_last_vision_distance'):
            vision_distance = self._last_vision_distance

        message = {
            "type": "device_state",
            "state": state,
            "deviceId": self.llm_agent_config.device_id,
            "timestamp": time.time(),
            "vision": {
                "faces": vision_faces,
                "distance_m": vision_distance,
                "is_talking": vision_talking,
                "active": getattr(self, '_is_vision_wake_active', False),
            },
            "audio": {
                "interactive": self.is_interactive_mode,
                "tts_playing": self.is_playing_tts,
            },
        }
        self._send_websocket_message(message)
        logger.debug(f"📊 设备状态已上报: {state}")
    
    def _send_interrupt(self, trace_id: Optional[str] = None, reason: str = "unknown"):
        """发送interrupt消息给LLM Agent"""
        message = {
            "type": "interrupt",
            "traceId": trace_id or self._current_trace_id,
            "deviceId": self.llm_agent_config.device_id,
            "reason": reason,
            "timestamp": time.time()
        }
        self._send_websocket_message(message)
        logger.info(f"🛑 已发送interrupt消息 (traceId={trace_id or self._current_trace_id}, reason={reason})")
    
    def _start_playback_thread(self):
        """启动音频播放线程"""
        self._playback_active = True
        self._current_playback_sample_rate = self.audio_playback_config.sample_rate  # 从配置读取默认采样率
        self._need_reopen_stream = False  # 标记是否需要重建播放流
        self._playback_thread = threading.Thread(target=self._audio_playback_worker, daemon=True)
        self._playback_thread.start()
        logger.info("🎵 音频播放线程已启动")
    
    def _audio_playback_worker(self):
        """音频播放工作线程（通过XVF3800扬声器接口播放，使用流式播放）"""
        try:
            import sounddevice as sd
            import numpy as np
        except ImportError:
            logger.error("❌ sounddevice未安装，无法播放音频。请运行: pip install sounddevice")
            return
        except OSError as e:
            logger.error(f"❌ 本地音频播放不可用（PortAudio 缺失或系统音频库异常）: {e}")
            return
        
        # 尝试查找目标输出设备
        output_device = None
        output_device_match = (self.audio_playback_config.output_device_match or "XVF3800").lower()
        try:
            devices = sd.query_devices()
            for i, device in enumerate(devices):
                device_name = str(device.get('name', ''))
                if output_device_match in device_name.lower():
                    if device['max_output_channels'] > 0:
                        output_device = i
                        logger.info(f"🎵 找到目标输出设备: {device_name} (ID: {i})")
                        break
        except Exception as e:
            logger.debug(f"查找音频设备时出错: {e}")

        if output_device is None and self.audio_playback_config.strict_output_device:
            logger.error(
                f"❌ 未找到目标输出设备: {self.audio_playback_config.output_device_match}，"
                "严格输出模式已启用，禁止回退到系统默认输出设备"
            )
            return
        
        # 使用OutputStream进行流式播放（支持动态采样率切换）
        channels = self.audio_playback_config.channels
        current_sr = self._current_playback_sample_rate

        while self._playback_active:
            try:
                with sd.OutputStream(samplerate=current_sr,
                                   channels=channels,
                                   dtype=np.int16,
                                   device=output_device) as stream:
                    logger.info(f"🎵 音频流式播放已启动 (采样率: {current_sr}Hz, 声道: {channels})")
                    self._need_reopen_stream = False

                    while self._playback_active and not self._need_reopen_stream:
                        try:
                            # 尝试获取音频帧（PCM int16裸流字节）
                            audio_data = self.audio_playback_queue.get(timeout=0.1)

                            # 转换为numpy数组并播放
                            audio_array = np.frombuffer(audio_data, dtype=np.int16)
                            stream.write(audio_array)  # 无缝拼接

                        except queue.Empty:
                            # 队列为空时的处理（完美触发排空）
                            if self._wait_for_audio_drain:
                                logger.info("✅ 音频队列已彻底排空，安全切换到 LISTENING 状态")
                                self._wait_for_audio_drain = False
                                self._is_prebuffering = True      # 为下一轮对话重置预缓冲
                                self._audio_prebuffer.clear()
                                self._current_audio_session_id = None  # 重置session
                                self._stop_tts_playback()  # 停止TTS播放，触发免唤醒等后续逻辑
                            continue
                        except Exception as e:
                            logger.error(f"❌ 音频播放异常: {e}")

                # 流关闭后检查是否需要以新采样率重新打开
                if self._need_reopen_stream:
                    current_sr = self._current_playback_sample_rate
                    logger.info(f"🔄 以新采样率重建播放流: {current_sr}Hz")

            except Exception as e:
                logger.error(f"❌ 创建音频输出流失败: {e}")
                break  # 避免无限重试
    
    def clear_playback_queue(self):
        """清空播放队列（硬打断）"""
        count = 0
        while not self.audio_playback_queue.empty():
            try:
                self.audio_playback_queue.get_nowait()
                count += 1
            except queue.Empty:
                break
        if count > 0:
            logger.info(f"已清空播放队列: {count} 个音频块")
    
    def _handle_hard_cutoff(self, reason: str = "wake_word_barge_in"):
        """硬打断处理：停止播报，清空队列，发送停止信号"""
        logger.warning(f"🚨 硬打断：停止播报，清空队列，发送停止信号 (reason: {reason})")
        
        with self._state_lock:
            # 1. 清空播放队列
            self.clear_playback_queue()
        
            # 2. 生成新session_id
            self._current_audio_session_id = str(uuid.uuid4())
            
            # 3. 设置标志位
            self.is_playing_tts = False
            
            # 4. 清空预缓冲区
            self._audio_prebuffer.clear()
            self._is_prebuffering = True
            
            # 5. 重置排空标志
            self._wait_for_audio_drain = False
            
            # 6. 设置500ms二进制流屏蔽期
            self._binary_frame_shield_until = time.time() + 0.5
            
            # 7. 启动冷却期（屏蔽OWW，但VAD和推流继续）
            self._cooldown_until = time.time() + (self.config.kws.cooldown_ms / 1000.0)
            
            # 8. 发送interrupt给服务端
            self._send_interrupt(reason=reason)
            
            # 9. 🌟 修复：已删除同步停止视觉唇动的代码，防止误杀用户唇动检测
                    
        logger.info("✅ 硬打断完成，启动冷却期")
    
    def _is_in_cooldown(self) -> bool:
        """检查是否在冷却期内"""
        return time.time() < self._cooldown_until
    
    def _send_reset_cooldown_command(self):
        """向音频模块发送重置冷却期指令（允许立即再次唤醒，带自动重连）"""
        max_retries = 2
        for attempt in range(max_retries):
            try:
                with self._audio_req_lock:
                    self.audio_req_socket.send_json({"command": "reset_cooldown"})
                    reply = self.audio_req_socket.recv_json()
                    if reply.get("status") == "ok":
                        logger.info("✅ 音频冷却期已重置")
                        return True
                    else:
                        logger.warning(f"⚠️ 音频冷却期重置失败: {reply}")
                        return False
            except (zmq.Again, zmq.ZMQError, ConnectionError) as e:
                if attempt < max_retries - 1:
                    if self._reconnect_audio_socket():
                        continue
                logger.error(f"❌ 音频冷却期重置失败: {e}")
                return False
        return False
    
    def _send_start_streaming_command(self):
        """向音频模块发送强制推流指令（用于连续对话免唤醒，带自动重连）"""
        max_retries = 2
        for attempt in range(max_retries):
            try:
                with self._audio_req_lock:
                    self.audio_req_socket.send_json({"command": "start_streaming"})
                    reply = self.audio_req_socket.recv_json()
                    if reply.get("status") == "ok":
                        logger.info("✅ 已通知音频底层开启持续拾音")
                        return True
                    else:
                        logger.warning(f"⚠️ 开启推流指令失败: {reply}")
                        return False
            except (zmq.Again, zmq.ZMQError, ConnectionError) as e:
                if attempt < max_retries - 1:
                    if self._reconnect_audio_socket():
                        continue
                logger.error(f"❌ 开启推流指令失败: {e}")
                return False
            except Exception as e:
                logger.error(f"❌ 发送开启推流指令异常: {e}")
                return False
        return False
    
    def _send_stop_streaming_command(self):
        """向音频模块发送停止推流指令（进入PROCESSING等状态时停止音频推流，带自动重连）"""
        max_retries = 2
        for attempt in range(max_retries):
            try:
                # 🌟 修复：移除 zmq.NOBLOCK，因为 REQ 必须确保命令可靠发出去
                with self._audio_req_lock:
                    self.audio_req_socket.send_json({"command": "stop_streaming"})
                    try:
                        reply = self.audio_req_socket.recv_json()
                        if reply.get("status") == "ok":
                            logger.info("✅ 已通知音频底层停止推流")
                            return True
                        else:
                            logger.warning(f"⚠️ 音频推流停止失败: {reply}")
                            return False
                    except zmq.Again:
                        logger.debug("音频推流停止命令已发送（无回复或超时）")
                        return True
            except (zmq.ZMQError, ConnectionError) as e:
                if attempt < max_retries - 1:
                    if self._reconnect_audio_socket():
                        continue
                logger.error(f"❌ 音频推流停止失败: {e}")
                return False
            except Exception as e:
                logger.error(f"❌ 音频推流停止异常: {e}")
                return False
        return False
    
    def _exit_interactive_mode(self, use_abort: bool = False):
        """退出交互模式（替代原来的_transition_to_idle）"""
        with self._state_lock:
            logger.info(f"状态转换: 退出交互模式")
            if self._media_ducked:
                self._set_media_duck("restore", 1.0)
                self._media_ducked = False
            
            # 🌟 修复1：VAD超时检查已移至 _process_audio_data，不再需要独立线程
            
            # 停止90秒交互超时检查线程
            if self._interactive_timeout_thread and self._interactive_timeout_thread.is_alive():
                self._interactive_timeout_should_exit = True
            
            # 如果正在交互，需要发送结束标记并停止音频推流
            if self.is_interactive_mode:
                if use_abort:
                    # 发送interrupt消息给服务端
                    if self._current_trace_id:
                        self._send_interrupt(reason="abort")
                else:
                    # 发送audio_end消息
                    if self._current_trace_id:
                        self._send_audio_segment_end(self._current_trace_id, "vad_timeout")
                
            # 重置对话上下文
            self._current_trace_id = None
            
            # 恢复默认阈值
            self._send_threshold_command(self.audio_threshold_config.default)
            
            # 🌟 任务1：彻底同步视觉状态，防止假死
            self._is_vision_wake_active = False
            self._vision_wake_debounce_active = False
            # 任务2：确保交互结束后清理防抖记忆
            if hasattr(self, '_vision_wake_debounce_start'):
                delattr(self, '_vision_wake_debounce_start')
            if hasattr(self, '_vision_leave_debounce_start'):
                delattr(self, '_vision_leave_debounce_start')
            
            # 🌟 核心修复：状态重置和日志对齐
            self.is_interactive_mode = False
            self.is_playing_tts = False
            self._current_wake_path = "unknown"
            
            logger.info("状态转换: 退出交互模式，通知底层结束推流并关闭唇动检测")
            self._send_stop_streaming_command()
            
            # 休眠时关闭唇动检测，节省 CPU/GPU 算力
            if self._lip_sync_event is not None:
                self._lip_sync_event.clear()
                logger.info("🛑 交互结束，已关闭唇动检测")
            
            # 退出交互时才重置底层唤醒冷却
            self._send_reset_cooldown_command()
            
            # 上报设备状态
            self._report_device_state("idle")
    
    # _transition_to_visual_wake已删除，视觉唤醒判定逻辑移至_process_vision_data
    
    def _enter_interactive_mode(self, wake_path: str = "unknown"):
        """进入交互模式（替代原来的_transition_to_listening）"""
        with self._state_lock:
            prev_interactive = self.is_interactive_mode
            logger.info(f"状态转换: 进入交互模式 (路径: {wake_path})")
            
            # 记录唤醒路径
            self._current_wake_path = wake_path
            
            # 🌟 核心修复：重置所有交互计时器，避免"时间穿越"引发的瞬间挂断
            self._last_speech_time = time.time()
            self._vad_silence_start = None
            self._lip_silence_start = None
            self._user_has_spoken = False
            self._last_vad_time = time.time()
            self._last_lip_active_time = time.time()  # 重置唇动计时器
            if hasattr(self, '_last_vad_false_time'):
                self._last_vad_false_time = 0.0  # 重置VAD False时间戳
            self._consecutive_macro_timeouts = 0  # 重置连续发呆计数器
            
            # 记录进入交互模式的时间
            self._listening_start_time = time.time()
            self._interactive_start_time = time.time()  # 记录交互模式开始时间
            logger.info(f"⏱️ [保底机制] 开始计时，30秒交流上限时间已启动")
            
            # 如果是进入免唤醒持续对话或视觉直接触发，必须主动通知音频底层拉起流模式
            if wake_path in ("持续对话", "视觉直接触发"):
                self._send_start_streaming_command()
        
            # 🌟 修复1：消除轮询执念 - 不再启动独立的VAD超时检查线程
            # VAD超时检查已移至 _process_audio_data 中，实现纯事件驱动
            
            # 启动90秒交互超时检查线程（保留，因为需要独立计时）
            self._interactive_timeout_should_exit = False
            if self._interactive_timeout_thread is None or not self._interactive_timeout_thread.is_alive():
                self._interactive_timeout_thread = threading.Thread(target=self._interactive_timeout_checker, daemon=True)
                self._interactive_timeout_thread.start()
            
            # 唤醒时开启唇动检测
            if self._lip_sync_event is not None:
                self._lip_sync_event.set()
                logger.info("🎬 唤醒成功，已开启唇动检测")
            
            self.is_interactive_mode = True
            
            # 上报设备状态
            self._report_device_state("listening")
    
    # ASR标记发送方法已删除（ASR已迁移到服务器端，通过WebSocket通信）
    
    async def _send_websocket_text(self, data: dict):
        """发送WebSocket Text Frame（JSON）"""
        if self._ws_connected and self._ws_client:
            try:
                await self._ws_client.send(json.dumps(data))
            except Exception as e:
                logger.error(f"发送WebSocket文本消息失败: {e}")
    
    def _send_audio_segment_begin(self, trace_id: str, sample_rate: int = 16000):
        self._current_audio_seq = 0
        # 初始化UI音频缓冲
        self._ui_audio_buffer[trace_id] = []
        self._send_websocket_message({
            "type": "audio_segment_begin",
            "traceId": trace_id,
            "deviceId": self.llm_agent_config.device_id,
            "mimeType": "audio/pcm;rate=16000",
            "codec": "pcm_s16le",
            "sampleRate": sample_rate,
            "channels": 1,
            "timestamp": time.time()
        })

    def _send_audio_segment_chunk(self, trace_id: str, audio_data: bytes):
        # 同时缓存到UI音频缓冲
        if trace_id in self._ui_audio_buffer:
            self._ui_audio_buffer[trace_id].append(audio_data)
        self._send_websocket_message({
            "type": "audio_segment_chunk",
            "traceId": trace_id,
            "deviceId": self.llm_agent_config.device_id,
            "seq": self._current_audio_seq,
            "data": base64.b64encode(audio_data).decode("ascii"),
            "timestamp": time.time()
        })
        self._current_audio_seq += 1

    def _send_audio_segment_end(self, trace_id: str, reason: str):
        self._send_websocket_message({
            "type": "audio_segment_end",
            "traceId": trace_id,
            "deviceId": self.llm_agent_config.device_id,
            "reason": reason,
            "timestamp": time.time()
        })
    
    @staticmethod
    def _pcm_to_wav(pcm_data: bytes, sample_rate: int = 16000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
        """将原始PCM数据转换为WAV格式（添加44字节WAV头）"""
        import struct
        data_size = len(pcm_data)
        byte_rate = sample_rate * channels * bits_per_sample // 8
        block_align = channels * bits_per_sample // 8
        header = struct.pack(
            '<4sI4s4sIHHIIHH4sI',
            b'RIFF', 36 + data_size, b'WAVE',
            b'fmt ', 16, 1,  # PCM format
            channels, sample_rate, byte_rate, block_align, bits_per_sample,
            b'data', data_size
        )
        return header + pcm_data

    # 🌟 修复1：_vad_timeout_checker 方法已删除
    # VAD超时检查逻辑已移至 _process_audio_data 中，实现纯事件驱动，避免多线程锁竞争
    
    def _handle_vad_end(self):
        """处理VAD结束（句子截断，不退出交互模式）"""
        # 🌟 核心修复：VAD截断只是划分句子，只发送audio_end并清空trace_id
        # 禁止切断推流和重置冷却期
        if self._current_trace_id:
            self._send_audio_segment_end(self._current_trace_id, "vad_timeout")
        self._current_trace_id = None
        if self._media_ducked:
            self._set_media_duck("restore", 1.0)
            self._media_ducked = False
    
    def _handle_vad_timeout(self):
        """处理VAD超时"""
        # 🌟 修复：如果用户根本没开口，直接退出交互模式
        if not self._user_has_spoken:
            logger.info("👻 检测到幽灵唤醒（用户未开口），强制丢弃音频！")
        
        # 退出交互模式
        self._exit_interactive_mode(use_abort=not self._user_has_spoken)
    
    # PROCESSING状态已删除，不再需要单独的状态转换
    # 当发送audio_end后，等待服务端回复，期间is_interactive_mode保持True
    
    def _processing_timeout_checker(self):
        """处理超时守卫线程（已废弃，保留用于向后兼容）"""
        # 此方法已废弃，因为不再有PROCESSING状态
        pass
    
    def _interactive_timeout_checker(self):
        """后台线程：持续对话空闲超时检测
        TTS 播放中不计时，TTS 播完后开始倒计时"""
        logger.info("⏱️ [持续对话超时检查线程] 已启动")
        # 视觉直接触发模式下：只要人还在镜头前就不退出，人离开会通过
        # _vision_leave_debounce_start 机制触发退出（见 _process_vision_data）
        IDLE_TIMEOUT_SHORT = 15.0   # 纯语音/视觉降维路径：15 秒空闲退出
        IDLE_TIMEOUT_LONG = 60.0    # 视觉直接触发：60 秒空闲退出（人可以慢慢想）
        MAX_TIMEOUT = 180.0         # 极限保底
        while True:
            if self._interactive_timeout_should_exit:
                logger.info("⏱️ [持续对话超时检查线程] 收到退出信号")
                break

            time.sleep(1.0)

            if not self.is_interactive_mode:
                continue

            if self.is_playing_tts:
                # TTS 正在播放，用户在听，不计时
                self._last_speech_time = time.time()
                continue

            now = time.time()
            elapsed = now - self._last_speech_time if self._last_speech_time else 0

            # 持续对话模式用长超时；其他模式用短超时
            wake_path = getattr(self, '_current_wake_path', 'unknown')
            idle_timeout = IDLE_TIMEOUT_LONG if wake_path == "视觉直接触发" else IDLE_TIMEOUT_SHORT

            # 空闲超时：退出（人离开通常先由视觉防抖触发退出）
            if elapsed > idle_timeout:
                logger.warning(f"🛑 [持续对话] 空闲 {elapsed:.0f}秒 (路径={wake_path}，阈值={idle_timeout}s)，退出交互模式")
                self._exit_interactive_mode()
            # 极限保底
            elif elapsed > MAX_TIMEOUT:
                logger.warning(f"🛑 [持续对话] 极限保底 {MAX_TIMEOUT}秒，强制退出")
                self._exit_interactive_mode()
    
    def _start_tts_playback(self):
        """开始TTS播放（设置is_playing_tts标志）"""
        with self._state_lock:
            logger.info("状态转换: 开始TTS播放")
            self.is_playing_tts = True
            # 🌟 核心修复：TTS播放时不再重置冷却期，避免误杀免唤醒状态
            
            # 上报设备状态
            self._report_device_state("speaking")
    
    def _stop_tts_playback(self):
        """停止TTS播放（TTS播放结束）"""
        with self._state_lock:
            logger.info("状态转换: TTS播放结束")
            self.is_playing_tts = False
            
            # 🌟 核心修复：开启绝对物理防抖时间！
            # 屏蔽这段时间内的任何 VAD 波动和硬打断，防止自己录到自己的尾音
            debounce_window = self.conversation_config.lip_recent_window_s
            self._ignore_audio_until = time.time() + debounce_window
            logger.info(f"🛡️ 激活物理防抖护盾：{debounce_window}秒内忽略所有音频输入（直到 {self._ignore_audio_until:.2f}）")
            
            # 如果仍在交互模式，继续监听（等待用户继续说话）
            if self.is_interactive_mode:
                self._send_start_streaming_command()
                self._report_device_state("listening")
    
    def _handle_visual_cutoff(self, context: str = "监听"):
        """处理视觉斩断（最高优先级打断）"""
        logger.warning(f"🚨 视觉斩断：检测到用户离开，立即切断{context}")
        
        # 发送interrupt消息给LLM Agent（如果当前有traceId）
        if self._current_trace_id:
            self._send_interrupt(reason="visual-cutoff")
        
        # 🌟 修复1：VAD超时检查已移至 _process_audio_data，不再需要独立线程
        # 退出交互模式
        self._exit_interactive_mode(use_abort=True)
    
    def _handle_tts_stop(self):
        """处理TTS停止（视觉检测到用户离开，停止数字人播报）"""
        logger.warning("🚨 视觉斩断：停止TTS播报")
        
        # 🌟 核心修复 3：完整实现视觉离开时的物理斩断逻辑
        self._send_interrupt(reason="visual-cutoff")
        self.clear_playback_queue()
        self._audio_prebuffer.clear()
        self._is_prebuffering = True
        self._wait_for_audio_drain = False
        
        # 更新session以屏蔽网络管道里的残余音频
        self._current_audio_session_id = str(uuid.uuid4())
        self._binary_frame_shield_until = time.time() + 0.5
        
        # 退出交互模式
        self._exit_interactive_mode(use_abort=True)
    
    def set_silence_timeout(self, timeout_sec: float):
        """
        外部接口：动态调整VAD静音超时时间
        
        Args:
            timeout_sec: 新的超时时间（秒）
        """
        if timeout_sec < 1.0 or timeout_sec > 60.0:
            logger.warning(f"超时值 {timeout_sec} 超出合理范围 [1.0, 60.0]，已限制")
            timeout_sec = max(1.0, min(60.0, timeout_sec))
        self.current_silence_timeout = timeout_sec
        logger.info(f"✅ VAD静音超时已动态调整为: {timeout_sec}秒")
    
    def run(self):
        """运行核心服务器主循环（带全局崩溃护盾）"""
        logger.info("🚀 Core Server started")
        _heartbeat_last = time.time()

        while True:
            try:
                # 💓 心跳日志：每 10 秒打印一次，证明主循环还活着
                if time.time() - _heartbeat_last >= 10.0:
                    logger.info(f"💓 [core_server] heartbeat | interactive={self.is_interactive_mode} | wake_path={getattr(self, '_current_wake_path', '?')} | vision_active={getattr(self, '_is_vision_wake_active', False)}")
                    _heartbeat_last = time.time()

                # 使用Poller同时监听视觉和音频数据
                socks = dict(self.poller.poll(timeout=100))  # 100ms超时
                
                # 处理视觉数据（从内存队列读取，替代 ZMQ SUB）
                if self._vision_queue is not None:
                    latest_vision_data = None
                    try:
                        while True:
                            latest_vision_data = self._vision_queue.get_nowait()
                    except queue.Empty:
                        pass
                    except Exception as e:
                        logger.error(f"处理视觉数据异常: {e}", exc_info=True)

                    if latest_vision_data:
                        if not hasattr(self, '_vision_data_count'):
                            self._vision_data_count = 0
                        self._vision_data_count += 1
                        if self._vision_data_count % 10 == 0:
                            faces_count = len(latest_vision_data.get("faces", []))
                            logger.debug(f"📥 收到最新视觉数据 (第{self._vision_data_count}帧, {faces_count}个人脸)")

                        self._process_vision_data(latest_vision_data)
                
                # 处理音频数据
                if self.audio_sub_socket in socks:
                    try:
                        # 🌟 修复：连续读取所有到达的音频块，防止音频处理落后导致延迟
                        while True:
                            metadata_json, audio_binary = self.audio_sub_socket.recv_multipart(zmq.NOBLOCK)
                            metadata = json.loads(metadata_json.decode('utf-8'))
                            self._process_audio_data(metadata, audio_binary)
                    except zmq.Again:
                        pass  # 队列已抽干
                    except Exception as e:
                        logger.error(f"处理音频数据异常: {e}")
                
                # 处理控制指令（LLM下行控制）
                if getattr(self, '_control_rep_socket', None) and self._control_rep_socket in socks:
                    try:
                        request = self._control_rep_socket.recv_json(zmq.NOBLOCK)
                        response = self._handle_control_command(request)
                        self._control_rep_socket.send_json(response)
                    except zmq.Again:
                        pass
                    except Exception as e:
                        logger.error(f"处理控制指令异常: {e}")
                        try:
                            self._control_rep_socket.send_json({"status": "error", "message": str(e)})
                        except:
                            pass
                
                # 检查视觉数据丢失（降低到1秒，更快响应）
                if time.time() - getattr(self, '_last_vision_timestamp', 0) > 1.0:
                    if getattr(self, '_latest_vision_wake', False):
                        logger.warning("⚠️ 视觉数据丢失（>1秒），视为wake=false")
                        self._latest_vision_wake = False
                        
                        # 🌟 修复：构造虚拟的离开事件喂给状态机，让各状态的专属规则接管
                        mock_vision_data = {"faces": [], "is_talking": False, "timestamp": time.time()}
                        self._process_vision_data(mock_vision_data)
                
                # 检查冷却期（忽略VAD和KWS事件）
                if self._is_in_cooldown():
                    continue
                
            except KeyboardInterrupt:
                logger.info("🛑 Core Server stopped by user")
                self._cleanup()
                break  # 只有用户按 Ctrl+C 才真正退出程序
            except Exception as e:
                # 🌟 核心护盾：捕获所有未知异常，打印堆栈，但不退出 while True！
                import traceback
                logger.error(f"💥 主循环遭遇致命错误并已被拦截: {e}")
                logger.error(traceback.format_exc())
                time.sleep(1.0)  # 防止因为疯狂报错导致 CPU 100%
    
    def _check_vision_target_present(self, faces: list) -> bool:
        """检查是否有人在[0.4m, 4.5m]区间内"""
        for face in faces:
            distance_m = face.get("distance_m") or face.get("distance")
            if distance_m and 0.4 <= distance_m <= 4.5:
                return True
        return False
    
    def _check_vision_wake_condition(self, faces: list) -> bool:
        """检查是否满足视觉唤醒条件（持续对话模式：只要有人在 4m 内）。

        旧策略要求 frontal_percent >= 40% 过滤背对镜头的路人，但在持续对话
        场景下这个门限会导致侧面/低头用户无法激活。改为：只要有人脸且距离
        <= 4m 就满足。LLM 侧通过 DECISION:ignore 过滤"旁人闲聊"的噪音。
        """
        if not faces:
            return False
        best_dist = None
        best_frontal = 0.0
        for face in faces:
            distance_m = face.get("distance_m") or face.get("distance")
            frontal_percent = face.get("frontal_percent", 0.0)
            if distance_m and distance_m <= 4.0:
                if best_dist is None or distance_m < best_dist:
                    best_dist = distance_m
                    best_frontal = frontal_percent
        if best_dist is not None:
            # 诊断日志：打印第一次满足条件时的数值（用于调参）
            if not getattr(self, '_vision_wake_diag_logged', False):
                logger.info(f"👁️ [视觉唤醒诊断] 满足条件: 最近距离={best_dist}m, frontal={best_frontal}%")
                self._vision_wake_diag_logged = True
            return True
        self._vision_wake_diag_logged = False
        return False
    
    def _process_vision_data(self, vision_data: dict):
        """处理视觉数据（纯传感器数据，业务逻辑在core_server中处理）"""
        faces = vision_data.get("faces", [])
        distance_m = vision_data.get("distance_m")
        is_talking = vision_data.get("is_talking", False)

        # 缓存最新视觉状态（供 _report_device_state 使用）
        self._last_vision_faces = len(faces)
        self._last_vision_distance = distance_m
        
        # 🌟 增加视觉流实时诊断日志，让用户看清摄像头每秒的真实判定
        if not hasattr(self, '_diag_last_lip') or self._diag_last_lip != is_talking:
            logger.info(f"👀 [视觉实时诊断] 摄像头捕捉到 -> {'👄 正在动嘴' if is_talking else '😶 嘴唇静止'}")
            self._diag_last_lip = is_talking
        
        # 如果 distance_m 不在顶层，尝试从 faces 中获取
        if distance_m is None and faces:
            for face in faces:
                distance_m = face.get("distance_m") or face.get("distance")
                if distance_m:
                    break
        
        # 更新视觉状态缓存
        prev_is_talking = self._latest_vision_is_talking
        self._latest_vision_is_talking = is_talking
        self._last_vision_timestamp = time.time()
        
        # 🌟 修复：一旦检测到嘴巴动，刷新计时器
        if is_talking:
            self._last_lip_active_time = time.time()
            # 唇动从静音变为说话，清除静音开始时间
            if self._lip_silence_start is not None:
                self._lip_silence_start = None
        elif prev_is_talking and not is_talking:
            self._last_lip_active_time = time.time()
            # 唇动从说话变为静音，记录静音开始时间
            if self._lip_silence_start is None and self.is_interactive_mode:
                self._lip_silence_start = time.time()
        
        # ========== 视觉唤醒判定逻辑（在core_server中处理） ==========
        vision_wake_candidate = self._check_vision_wake_condition(faces)
        
        # 🌟 视觉日志降噪：只记录状态变化，不刷屏
        # 记录上一帧的状态
        last_candidate = getattr(self, '_last_vision_log_candidate', None)
        last_debounce_active = getattr(self, '_last_vision_log_debounce_active', None)
        
        # 计算当前状态（用于判断是否变化）
        current_debounce_active = getattr(self, '_vision_wake_debounce_active', False)
        
        # 只有当 candidate 状态改变或防抖状态改变时才打印日志
        should_log = False
        log_message = ""
        
        # candidate 状态改变：仅用于内部状态记录，不再打印瞬时“满足/不满足”日志
        if last_candidate != vision_wake_candidate:
            should_log = True
            self._last_vision_log_candidate = vision_wake_candidate
        
        # 简化输出：移除防抖状态日志
        # 防抖状态改变时不再打印日志
        
        if should_log and log_message:
            logger.info(log_message)
        
        # 初始化状态记录
        if last_candidate is None:
            self._last_vision_log_candidate = vision_wake_candidate
        if last_debounce_active is None:
            self._last_vision_log_debounce_active = current_debounce_active
        
        # 防抖处理（进入防抖200ms，离开防抖1000ms）
        if vision_wake_candidate:
            # 满足视觉唤醒条件
            # 1. 发现目标，立即清理任何"离开防抖"的倒计时
            if hasattr(self, '_vision_leave_debounce_start'):
                delattr(self, '_vision_leave_debounce_start')
                
            # 2. 处理"进入防抖"逻辑
            if not getattr(self, '_vision_wake_debounce_active', False) or not hasattr(self, '_vision_wake_debounce_start'):
                # 刚开始进入防抖
                self._vision_wake_debounce_active = True
                self._vision_wake_debounce_start = time.time()
            elif time.time() - self._vision_wake_debounce_start >= (self.vision_wake_config.enter_debounce_ms / 1000.0):
                # 进入防抖完成，切换阈值
                if not getattr(self, '_is_vision_wake_active', False):
                    self._send_threshold_command(self.audio_threshold_config.visual_wake)
                    self._send_vision_command("vision_wake")
                    self._is_vision_wake_active = True
                    logger.info(f"👁️ 视觉降维打击激活，阈值已降至{self.audio_threshold_config.visual_wake:.2f}，视觉触发模式开启")

                    # 🌟 持续对话模式：人在摄像头前就直接进入交互模式，跳过 KWS
                    # 所有 VAD 分段的音频都送给后端，由 LLM 的 DECISION:respond/wait/ignore 决定是否回答
                    if not self.is_interactive_mode:
                        logger.info("🤝 [视觉直接触发] 跳过 KWS，直接进入持续对话模式")
                        self._enter_interactive_mode("视觉直接触发")
            
            # 🌟 注意：如果防抖时间还没到，这里没有 else，什么都不做，安静等待 200ms 走完
            
        else:
            # 🌟 修复缩进：这里必须和最外层的 if vision_wake_candidate 对齐！
            # 不满足视觉唤醒条件（人不在镜头前）
            
            # 1. 目标丢失，立即中断并清理任何"进入防抖"的状态和倒计时
            self._vision_wake_debounce_active = False
            if hasattr(self, '_vision_wake_debounce_start'):
                delattr(self, '_vision_wake_debounce_start')
            
            # 2. 处理"离开防抖"逻辑
            # 🌟 持续对话模式下人脸丢失的容错窗口延长到 5 秒（避免转头/遮挡时误退出）
            wake_path = getattr(self, '_current_wake_path', 'unknown')
            leave_debounce_s = 5.0 if wake_path == "视觉直接触发" else (self.vision_wake_config.leave_debounce_ms / 1000.0)
            if not hasattr(self, '_vision_leave_debounce_start'):
                # 刚开始离开防抖
                self._vision_leave_debounce_start = time.time()
            elif time.time() - self._vision_leave_debounce_start >= leave_debounce_s:
                # 离开防抖完成，彻底离开，恢复阈值
                if getattr(self, '_is_vision_wake_active', False):
                    # 1. 恢复默认听力阈值 + 关闭视觉触发模式
                    self._send_threshold_command(self.audio_threshold_config.default)
                    self._send_vision_command("vision_leave")
                    logger.info(f"👁️ 视觉降维打击结束，阈值已恢复至{self.audio_threshold_config.default:.2f}，视觉触发模式关闭")
                    self._is_vision_wake_active = False

                    # 2. 无人时强制终止交互模式（无论什么唤醒路径）
                    if self.is_interactive_mode:
                        logger.info(f"🛑 视觉检测无人 {leave_debounce_s}s，强制退出交互模式（唤醒路径={wake_path}，距离={distance_m}m）")
                        self._exit_interactive_mode()
        
        # ========== 视觉区间判断（用于视觉斩断） ==========
        vision_target_present = self._check_vision_target_present(faces)
        
        # 带防抖的视觉斩断判断
        if not vision_target_present:
            if not hasattr(self, '_vision_leave_debounce_start'):
                self._vision_leave_debounce_start = time.time()
            elif time.time() - self._vision_leave_debounce_start >= (self.vision_wake_config.leave_debounce_ms / 1000.0):
                # 触发视觉斩断
                with self._state_lock:
                    self.is_vision_target_present = False
                    if self.is_interactive_mode:
                        timed_out_trace_id = self._current_trace_id
                        # 🌟 修复3：视觉斩断时的断尾处理
                        # 如果人离开镜头的瞬间，他正好还在说话（_current_trace_id 还不为 None），
                        # 先发送 audio_end 来正常闭合 ASR 管道，然后再发送 timeout_exit
                        if self._current_trace_id:
                            logger.info("🔄 视觉斩断：检测到未完成的对话，先发送 audio_end 闭合 ASR 管道")
                            self._send_audio_segment_end(self._current_trace_id, "visual_cutoff")
                            self._current_trace_id = None
                        
                        # 停止交互
                        self._exit_interactive_mode(use_abort=True)
                        
                        # 发送timeout_exit通知服务端
                        if self._ws_connected and self._ws_client and self._ws_loop:
                            try:
                                asyncio.run_coroutine_threadsafe(
                                    self._send_websocket_text({
                                        "type": "timeout_exit",
                                        "deviceId": self.llm_agent_config.device_id,
                                        "traceId": timed_out_trace_id,
                                        "timestamp": time.time()
                                    }),
                                    self._ws_loop
                                )
                            except Exception as e:
                                logger.error(f"发送timeout_exit消息失败: {e}")
                        logger.info("🚨 视觉斩断：用户离开[0.4m, 4.5m]区间，退出交互模式")
        else:
            # 有人在区间内，重置防抖
            if hasattr(self, '_vision_leave_debounce_start'):
                delattr(self, '_vision_leave_debounce_start')
            with self._state_lock:
                self.is_vision_target_present = True
        
        # 🌟 修复：已删除视觉状态机抢跑代码，让 _user_has_spoken 的修改权完全交还给 _process_audio_data，保证一定能生成 trace_id
    
    def _process_audio_data(self, metadata: dict, audio_binary: bytes):
        """处理音频数据"""
        current_time = time.time()
        
        # 🛡️ 护盾拦截：如果在无敌时间内，直接丢弃 VAD 和 打断 信号！
        if current_time < getattr(self, '_ignore_audio_until', 0.0):
            # 🌟 核心修复：护盾期间同步刷新所有静音计时器，防止刚出护盾就瞬间超时！
            self._vad_silence_start = current_time
            self._lip_silence_start = current_time
            if self._interactive_start_time:
                self._interactive_start_time = current_time
            self._last_speech_time = current_time
            self._last_lip_active_time = current_time
            logger.debug(f"🛡️ 物理防抖护盾生效中，忽略音频输入（剩余 {self._ignore_audio_until - current_time:.2f}秒），已冻结所有计时器")
            return
        
        # 🌟 TTS 播放状态下的音频处理：
        # - 旧策略：完全丢弃除唤醒词外的所有音频（防止声学反馈自循环）
        # - 持续对话模式（视觉直接触发）：允许用户任何时候说话打断，不要求唤醒词
        #   依靠后端 LLM 的 DECISION:ignore 过滤回声，XVF3800 的 AEC 通道已经做了回声消除
        wake_path = getattr(self, '_current_wake_path', 'unknown')
        if self.is_playing_tts:
            # 冻结静音超时（无论走哪条路径）
            self._vad_silence_start = current_time
            self._lip_silence_start = current_time
            if self._interactive_start_time:
                self._interactive_start_time = current_time
            self._last_speech_time = current_time

            if wake_path != "视觉直接触发":
                # 非持续对话模式：保持原策略 —— 只处理唤醒词
                wake_word = metadata.get("wake_word", {})
                if wake_word.get("detected", False):
                    confidence = wake_word.get("confidence", 0.0)
                    if hasattr(self, '_is_vision_wake_active') and self._is_vision_wake_active:
                        threshold = self.audio_threshold_config.visual_wake
                    else:
                        threshold = self.audio_threshold_config.default

                    if confidence >= threshold:
                        logger.info(f"⚡ 交互中检测到唤醒词，触发硬打断！")
                        self._stop_tts_playback()
                        self._send_interrupt(reason="wake_word")
                        self._current_trace_id = None
                        self._user_has_spoken = False
                        self._vad_silence_start = time.time()
                        self._lip_silence_start = time.time()
                return
            # 持续对话模式：允许 VAD 触发的真人说话打断
            # 不 return，继续往下走正常 VAD → audio forwarding 流程
            # 依赖：后端 likelyEcho 过滤 TTS 回声，LLM DECISION:ignore 过滤噪音
            vad_now = metadata.get("vad", False)
            if vad_now and not self._user_has_spoken:
                logger.info("🗣️ [持续对话] TTS 播放中检测到用户说话，触发软打断，交由后端判定")
                self._stop_tts_playback()
                self._send_interrupt(reason="continuous_barge_in")
                # 继续流程让音频被转发到后端，由 LLM 决定如何处理
        
        vad = metadata.get("vad", False)
        wake_word = metadata.get("wake_word", {})
        
        # =================================================================
        # 第一阶段：极其严谨的"开门"判定（防伪验证）
        # =================================================================
        # 记录最后一次看到真实唇动的时间
        lip_sync = getattr(self, '_latest_vision_is_talking', False)
        if lip_sync:
            self._last_lip_active_time = current_time
        elif not hasattr(self, '_last_lip_active_time'):
            self._last_lip_active_time = 0
            
        wake_path = getattr(self, '_current_wake_path', 'unknown')
        
        # 门槛设定：纯语音只要声音；视觉降维必须【声音 + 最近2.0秒内有唇动】
        # 视觉直接触发（持续对话模式）：只需要声音，跳过唇动门控（让 LLM 用 DECISION 过滤）
        is_valid_speech_start = vad
        if wake_path == "视觉降维打击":
            # 🌟 核心修复：放宽到 2.0 秒，抵抗嘴唇检测的瞬间闪烁误差
            lip_window = getattr(self.conversation_config, 'lip_recent_window_s', 2.0)
            # 如果配置值小于2.0，使用2.0作为最小容错窗口
            if lip_window < 2.0:
                lip_window = 2.0
            recent_lip_activity = (current_time - self._last_lip_active_time) < lip_window
            is_valid_speech_start = vad and recent_lip_activity

        # 一旦通过防伪验证，无条件信任，生成 TraceID！
        if self.is_interactive_mode and self._current_trace_id is None:
            if is_valid_speech_start and not self._user_has_spoken:
                if self._interactive_start_time and (current_time - self._interactive_start_time) < 0.2:
                    pass  # 极短的防连击保护
                else:
                    self._user_has_spoken = True
                    self._consecutive_macro_timeouts = 0  # 🌟 只要有真实开口，立刻清零发呆计数
                    self._talking_confirm_count = 0
                    
                    # 🌟🌟🌟 新增核心修复：开门瞬间，强制重置所有静默计时器！🌟🌟🌟
                    # 彻底阻断旧的静默时间被继承到微观状态中，给用户完整的 1.5 秒输出窗口
                    self._vad_silence_start = current_time
                    self._lip_silence_start = current_time
                    
                    self._current_trace_id = str(uuid.uuid4())
                    logger.info(f"🗣️ 检测到用户真实开口(双模防伪通过)，生成 traceId: {self._current_trace_id}，已完全交由微观接管！")
                    self._send_audio_segment_begin(self._current_trace_id, 16000)

        # 更新VAD状态
        prev_vad_state = self._last_vad_state
        self._last_vad_state = vad
        
        # 🌟 90秒重置机制：每次VAD由True变False时，重置并重新开始90秒倒计时
        if prev_vad_state and not vad:
            self._last_vad_false_time = current_time
            logger.debug(f"🔄 VAD从True变为False，重置90秒倒计时")
        
        # ⬇️⬇️⬇️ 核心修复：必须与上方 if 平级！ ⬇️⬇️⬇️
        # 🌟 修复状态机漏风：只有在交互模式下，才允许修改 _user_has_spoken！
        if self.is_interactive_mode:
            # =================================================================
            # 第二阶段：更新静音计时器（仅追踪真实声音和唇动）
            # =================================================================
            if vad:
                self._vad_silence_start = current_time
                self._last_speech_time = current_time
                if not self._media_ducked:
                    self._set_media_duck("duck", 0.1)
                    self._media_ducked = True
            elif not self._vad_silence_start:
                self._vad_silence_start = current_time

            if lip_sync:
                self._lip_silence_start = current_time
            elif not self._lip_silence_start:
                self._lip_silence_start = current_time

            if (
                not vad
                and self._media_ducked
                and self._vad_silence_start
                and (current_time - self._vad_silence_start) >= 0.8
            ):
                self._set_media_duck("restore", 1.0)
                self._media_ducked = False

            # 🌟 核心修复：TTS播放期间暂停所有超时倒计时
            if self.is_playing_tts:
                # 如果正在播放声音，暂停所有的超时倒计时
                self._last_speech_time = current_time
                return  # 不进行超时检查
            
            # =================================================================
            # 第三阶段：极其严格的 宏观/微观 隔离截断
            # =================================================================
            if self._vad_silence_start and self._lip_silence_start:
                now = current_time
                vad_silence_time = now - self._vad_silence_start if self._vad_silence_start else 0
                lip_silence_time = now - self._lip_silence_start if self._lip_silence_start else 0
                
                # 从配置读取参数
                micro_limit = self.conversation_config.vad_fast_cutoff_sec
                macro_limit = self.conversation_config.vad_silence_timeout_default_sec if wake_path == "纯语音唤醒" else self.conversation_config.vad_silence_timeout_visual_sec

                trigger_cut = False
                cut_reason = ""

                # 🛡️ 状态 A：已经开口（有单号） -> 走微观关门
                if self._current_trace_id is not None:
                    if wake_path == "纯语音唤醒" and vad_silence_time >= micro_limit:
                        trigger_cut = True
                        cut_reason = f"{micro_limit}s纯语音微观超时"
                    elif wake_path in ("视觉降维打击", "视觉直接触发"):
                        # 🌟 微观：用 VAD 静默判断（视觉直接触发不依赖唇动）
                        if wake_path == "视觉直接触发":
                            # 持续对话模式：只看 VAD，不看唇动（唇动在远距离/角度下不稳定）
                            if vad_silence_time >= micro_limit:
                                trigger_cut = True
                                cut_reason = f"{micro_limit}s持续对话微观超时 (VAD静默)"
                        else:
                            # 视觉降维打击：保持原双模 OR 逻辑
                            if vad_silence_time >= micro_limit or lip_silence_time >= micro_limit:
                                trigger_cut = True
                                cut_reason = f"{micro_limit}s单模态微观超时 (声音或唇动静默)"

                # 👻 状态 B：根本没开口（没单号） -> 走宏观发呆
                elif self._current_trace_id is None:
                    if wake_path == "纯语音唤醒" and vad_silence_time >= macro_limit:
                        trigger_cut = True
                        cut_reason = f"{macro_limit}s纯语音宏观发呆"
                    elif wake_path == "视觉降维打击":
                        # 🌟 宏观 OR 逻辑：只要有一个静默 5 秒，就算发呆（不怕环境噪音咬死VAD）
                        if vad_silence_time >= macro_limit or lip_silence_time >= macro_limit:
                            trigger_cut = True
                            cut_reason = f"{macro_limit}s视觉宏观发呆 (声音或唇动已静默)"
                    elif wake_path == "视觉直接触发":
                        # 🌟 持续对话模式：人在镜头前时不主动丢弃音频，只做 no-op
                        # 让用户长时间思考/沉默不会触发"发呆"退出；
                        # 真的一直不说话时，退出由 _interactive_timeout_checker 线程负责
                        pass

                # ⚠️ 状态 C：30秒长句兜底（仅限有单号的情况下兜底长语音）
                if self._current_trace_id is not None and self._interactive_start_time and (now - self._interactive_start_time) >= self.conversation_config.long_sentence_timeout_s:
                    trigger_cut = True
                    cut_reason = f"{self.conversation_config.long_sentence_timeout_s}s长句保底超时"

                # 执行截断动作
                if trigger_cut:
                    logger.info(f"✂️ 触发 VAD 句子截断: {cut_reason}")
                    
                    if self._current_trace_id is None:
                        # 没开口的宏观超时：累加次数，本地丢弃
                        self._consecutive_macro_timeouts += 1
                        logger.info(f"👻 检测到幽灵音频或发呆，本地丢弃 (连续发呆次数: {self._consecutive_macro_timeouts}/6)")

                        # 🌟 核心修复：连续6次发呆，仅关闭持续拾音，绝对不碰阈值！
                        if self._consecutive_macro_timeouts >= 6:
                            logger.warning("🛑 连续 6 次发呆，主动结束持续拾音。阈值保持不变，完全交由视觉模块管控！")
                            with self._state_lock:
                                self.is_interactive_mode = False
                                self._send_stop_streaming_command()
                                self._report_device_state("idle")
                            return  # 直接退出，等待下一次真实唤醒
                    else:
                        # 真正开口过的话：正常发送结束标志
                        self._handle_vad_end()
                    
                    # 彻底重置状态
                    self._user_has_spoken = False
                    self._vad_silence_start = now
                    self._lip_silence_start = now
                    self._talking_confirm_count = 0
                    self._interactive_start_time = now
                    return  # 不再处理后续音频
        else:
            # 🌟 修复：非交互模式下，不更新 VAD 状态变量，防止状态泄漏
            # 但需要重置计数器，避免状态残留
            if not vad:
                self._vad_silence_count += 1
                self._vad_speech_count = 0
        
        # 处理唤醒词检测
        if wake_word.get("detected", False):
            confidence = wake_word.get("confidence", 0.0)
            keyword = wake_word.get("keyword", "unknown")
            
            # 🌟 修复"闹鬼"问题：记录所有收到的唤醒词事件（用于调试）
            logger.info(f"🔔 [CoreServer] 收到唤醒词事件: 关键词={keyword}, 置信度={confidence:.2%}, 交互模式={self.is_interactive_mode}, 播放TTS={self.is_playing_tts}")
            
            # 路径A：视觉降维打击（视觉唤醒激活且不在交互模式）
            if (not self.is_interactive_mode and 
                hasattr(self, '_is_vision_wake_active') and self._is_vision_wake_active and
                confidence >= self.audio_threshold_config.visual_wake):
                logger.info(f"✅ [路径A] 视觉降维打击：置信度{confidence:.2%} >= 阈值{self.audio_threshold_config.visual_wake}")
                self._enter_interactive_mode("视觉降维打击")
            
            # 路径B：纯语音唤醒（不在交互模式，突破高阈值）
            elif (not self.is_interactive_mode and 
                  confidence >= self.audio_threshold_config.default):
                logger.info(f"✅ [路径B] 纯语音唤醒：置信度{confidence:.2%} >= 阈值{self.audio_threshold_config.default}")
                self._enter_interactive_mode("纯语音唤醒")
            
            # 路径C：交互中检测到唤醒词（硬打断，不退出交互模式）
            elif self.is_interactive_mode and not self.is_playing_tts:
                # 根据视觉唤醒状态选择阈值
                if hasattr(self, '_is_vision_wake_active') and self._is_vision_wake_active:
                    threshold = self.audio_threshold_config.visual_wake
                else:
                    threshold = self.audio_threshold_config.default
                
                if confidence >= threshold:
                    logger.info(f"⚡ 交互中检测到唤醒词 {keyword}，触发硬打断！")
                    self._stop_tts_playback()
                    self._send_interrupt(reason="wake_word")
                    # 重置当前句子收音状态，但不退出交互模式！
                    self._current_trace_id = None
                    self._user_has_spoken = False
                    self._vad_silence_start = time.time()
                    self._lip_silence_start = time.time()
            
            # 路径D：唤醒词硬打断（在TTS播放状态下）
            elif self.is_playing_tts:
                # 根据视觉唤醒状态选择阈值
                if hasattr(self, '_is_vision_wake_active') and self._is_vision_wake_active:
                    threshold = self.audio_threshold_config.visual_wake
                else:
                    threshold = self.audio_threshold_config.default
                
                if confidence >= threshold:
                    logger.info(f"✅ [路径D] 唤醒词硬打断：置信度{confidence:.2%} >= 阈值{threshold}")
                    logger.info("🛑 听到唤醒词，触发硬打断！")
                    self._handle_hard_cutoff("wake_word_barge_in")
                    
                    # 如果不在交互模式，进入交互模式
                    if not self.is_interactive_mode:
                        self._enter_interactive_mode("唤醒词打断")
            
            else:
                # 记录为什么唤醒词没有被处理
                if self.is_playing_tts:
                    threshold = self.audio_threshold_config.visual_wake if (hasattr(self, '_is_vision_wake_active') and self._is_vision_wake_active) else self.audio_threshold_config.default
                    logger.warning(f"⚠️ [路径C被跳过] TTS播放状态，但置信度{confidence:.2%} < 阈值{threshold}，不触发硬打断")
                elif self.is_interactive_mode:
                    logger.warning(f"⚠️ [唤醒词被忽略] 已在交互模式，但不在TTS播放状态")
                else:
                    threshold = self.audio_threshold_config.visual_wake if (hasattr(self, '_is_vision_wake_active') and self._is_vision_wake_active) else self.audio_threshold_config.default
                    logger.warning(f"⚠️ [唤醒词被忽略] 不在交互模式，但置信度{confidence:.2%} < 阈值{threshold}")
        
        # 当前句子在统一 WS 中以 JSON 文本帧持续上传。
        if self.is_interactive_mode and self._current_trace_id:
            self._send_audio_segment_chunk(self._current_trace_id, audio_binary)
    
    def _handle_control_command(self, request: dict) -> dict:
        """
        处理控制指令（LLM下行控制）
        
        Args:
            request: 控制请求（JSON格式）
        
        Returns:
            dict: 响应（JSON格式）
        """
        command = request.get("command")
        
        if command == "extend_window":
            # 延长免唤醒窗口
            timeout_sec = request.get("value", 15.0)
            self.set_silence_timeout(timeout_sec)
            return {"status": "ok", "new_timeout": timeout_sec}
        
        elif command == "play_video":
            # 播放视频（未来扩展）
            video_id = request.get("video_id", "")
            logger.info(f"收到播放视频指令: {video_id}")
            return {"status": "ok", "message": "视频播放功能待实现"}
        
        elif command == "set_parameter":
            # 设置其他系统参数（未来扩展）
            param_name = request.get("param_name", "")
            param_value = request.get("param_value", "")
            logger.info(f"收到设置参数指令: {param_name} = {param_value}")
            return {"status": "ok", "message": "参数设置功能待实现"}
        
        else:
            return {"status": "error", "message": f"未知命令: {command}"}
    
    def _cleanup(self):
        """清理资源"""
        logger.info("正在清理资源...")
        
        # 停止音频播放线程
        self._playback_active = False
        if self._playback_thread and self._playback_thread.is_alive():
            self._playback_thread.join(timeout=0.5)
            if self._playback_thread.is_alive():
                logger.warning("⚠️ 音频播放线程未在超时内退出，强制继续")
        
        # 🌟 修复1：VAD超时检查已移至 _process_audio_data，不再需要独立线程
        
        # 停止90秒交互超时线程
        self._interactive_timeout_should_exit = True
        if self._interactive_timeout_thread and self._interactive_timeout_thread.is_alive():
            self._interactive_timeout_thread.join(timeout=0.5)
            if self._interactive_timeout_thread.is_alive():
                logger.warning("⚠️ 90秒交互超时线程未在超时内退出，强制继续")
        
        # 关闭sockets（设置LINGER=0避免阻塞）
        # 注意：必须先设置LINGER，再关闭socket，最后关闭context
        try:
            # 设置所有socket的LINGER为0，立即关闭，不等待
            sockets_to_close = []
            # ASR相关socket已删除
            if self._control_rep_socket:
                sockets_to_close.append(self._control_rep_socket)
            sockets_to_close.extend([
                self.audio_sub_socket,
                self.audio_req_socket
            ])
            
            # 先设置LINGER，再关闭
            for sock in sockets_to_close:
                try:
                    sock.setsockopt(zmq.LINGER, 0)  # 立即关闭，不等待
                except:
                    pass
            
            # 然后关闭所有socket
            for sock in sockets_to_close:
                try:
                    sock.close()
                except:
                    pass
            
            # 最后关闭context
            try:
                self.zmq_context.term()
            except:
                pass
                
        except Exception as e:
            logger.error(f"清理资源异常: {e}")
        
        logger.info("✅ 资源清理完成")


def main():
    """主函数"""
    import argparse
    from pathlib import Path
    
    parser = argparse.ArgumentParser(description="Core Server - 核心决策模块")
    parser.add_argument("--config", type=str, default=None, help="配置文件路径")
    
    args = parser.parse_args()
    
    # 🌟 修复：自动搜索配置文件（和 runtime.py / tts_service.py 保持一致）
    config_path = args.config
    if config_path is None:
        # 尝试从项目根目录定位 config.yaml
        project_root = Path(__file__).resolve().parents[2]
        candidate = project_root / "config" / "config.yaml"
        if candidate.exists():
            config_path = str(candidate)
            print(f"自动定位配置文件: {config_path}")
        else:
            # 兜底搜索
            for p in ["config/config.yaml", "config.yaml", "../config/config.yaml"]:
                if Path(p).exists():
                    config_path = p
                    break
    
    server = CoreServer(config_path=config_path)
    server.run()


if __name__ == "__main__":
    main()
