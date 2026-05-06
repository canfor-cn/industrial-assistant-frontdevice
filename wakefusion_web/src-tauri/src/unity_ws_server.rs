// Unity（或任何 3D 数字人）专用的下行广播 WS server。
//
// 设计目的：解耦数字人渲染层 — 不再走 React → SendMessage 桥，而是让
// Unity / 未来的 Three.js / live2d 直接连本地 ws://127.0.0.1:9876 接
// audio_begin / audio_chunk / audio_end / stop_tts 协议（见
// dist/Build/Build/UnityWebGL-WS协议说明.md）。
//
// 与 device_ws_server 的区别：
//   - 仅下行（broadcast 给所有连接的客户端）
//   - 无鉴权（监听 127.0.0.1，外网不可达）
//   - 支持多客户端（重连容忍 + 多个数字人实例同时连）
//   - 不解析上行消息（Unity 端没什么要发回来的）

use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tungstenite::{accept, Message, WebSocket};

type WsConn = WebSocket<std::net::TcpStream>;

/// 全局 client list — broadcast 时遍历所有还活着的连接
static CLIENTS: std::sync::LazyLock<Mutex<Vec<Arc<Mutex<WsConn>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// 广播 JSON 文本到所有连接的 Unity / 数字人客户端。
/// 调用方：message_router.rs 在处理 audio_begin / audio_chunk / audio_end / stop_tts 时。
pub fn broadcast(json: &str) {
    let mut clients = CLIENTS.lock().unwrap();
    let mut dead: Vec<usize> = Vec::new();
    for (i, conn_arc) in clients.iter().enumerate() {
        let mut conn = match conn_arc.lock() {
            Ok(g) => g,
            Err(_) => { dead.push(i); continue; }
        };
        if let Err(e) = conn.send(Message::Text(json.to_string().into())) {
            tracing::debug!("Unity WS client send failed (will drop): {e}");
            dead.push(i);
        }
    }
    // 倒序删除死连接，避免索引漂移
    for i in dead.into_iter().rev() {
        clients.swap_remove(i);
    }
}

/// 启动 Unity ws server 在指定端口（默认 9876，监听 127.0.0.1）。
pub fn spawn_unity_ws_server(_app: AppHandle, port: u16) {
    std::thread::Builder::new()
        .name("unity-ws-server".into())
        .spawn(move || {
            // 仅监听 loopback —— 外网不可达，不需要鉴权
            let addr = format!("127.0.0.1:{}", port);
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!("Unity WS server bind failed on {}: {}", addr, e);
                    return;
                }
            };
            tracing::info!("Unity WS server listening on ws://{}", addr);

            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("Unity WS accept error: {}", e);
                        continue;
                    }
                };
                std::thread::spawn(move || {
                    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                    let ws = match accept(stream) {
                        Ok(ws) => ws,
                        Err(e) => {
                            tracing::warn!("Unity WS handshake failed: {}", e);
                            return;
                        }
                    };
                    tracing::info!("Unity client connected: {}", peer);

                    let conn_arc = Arc::new(Mutex::new(ws));
                    CLIENTS.lock().unwrap().push(conn_arc.clone());

                    // 简单 keep-alive 循环：让连接保留在 list 里，被 broadcast 调用 send。
                    // 不读取 client 上行消息（Unity 端按协议不会主动 send）。
                    // 死连接的清理在 broadcast 时（send 失败就 swap_remove）。
                    // 这里仅短暂检测连接关闭，避免线程永远占着资源。
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        // 偶尔 ping 一下检测对端存活；send 失败 broadcast 那边会清
                        let mut g = match conn_arc.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        if g.send(Message::Ping(vec![].into())).is_err() {
                            tracing::info!("Unity client gone: {}", peer);
                            break;
                        }
                    }
                });
            }
        })
        .expect("failed to spawn unity-ws-server thread");
}
