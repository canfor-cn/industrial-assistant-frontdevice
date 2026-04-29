use crate::config::LlmAgentConfig;
use crate::ws_protocol::{self, DownstreamMessage, UpstreamMessage};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tungstenite::Message;

/// Status of the Tauri host ↔ backend WS link.
/// Emitted to the WebView so the UI can show real connection state
/// (instead of mistaking "Tauri host running" for "backend reachable").
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackendWsStatus {
    pub connected: bool,
    pub host: String,
    pub reason: Option<String>,
}

/// Last-known status — read by `get_backend_ws_status` Tauri command so the
/// WebView can pull the current value on mount (avoids the emit-vs-subscribe race
/// where the Rust connect happens before React useEffect runs).
static LAST_STATUS: OnceLock<Mutex<BackendWsStatus>> = OnceLock::new();

pub fn current_status() -> BackendWsStatus {
    LAST_STATUS
        .get()
        .and_then(|m| m.lock().ok().map(|g| g.clone()))
        .unwrap_or(BackendWsStatus {
            connected: false,
            host: String::new(),
            reason: Some("not initialized".into()),
        })
}

fn emit_status(app: &AppHandle, host: &str, connected: bool, reason: Option<String>) {
    let evt = BackendWsStatus {
        connected,
        host: host.to_string(),
        reason,
    };
    let cell = LAST_STATUS.get_or_init(|| Mutex::new(evt.clone()));
    if let Ok(mut g) = cell.lock() { *g = evt.clone(); }
    if let Err(e) = app.emit("backend_ws_status", &evt) {
        tracing::warn!("failed to emit backend_ws_status: {e}");
    }
}

/// Runs the WS client loop on a dedicated OS thread. Reconnects on disconnect.
pub fn spawn_ws_thread(
    app: AppHandle,
    config: LlmAgentConfig,
    downstream_tx: mpsc::UnboundedSender<DownstreamMessage>,
    upstream_rx: crossbeam_channel::Receiver<UpstreamMessage>,
) {
    std::thread::Builder::new()
        .name("ws-client".into())
        .spawn(move || {
            ws_loop(app, config, downstream_tx, upstream_rx);
        })
        .expect("failed to spawn ws-client thread");
}

fn ws_loop(
    app: AppHandle,
    config: LlmAgentConfig,
    downstream_tx: mpsc::UnboundedSender<DownstreamMessage>,
    upstream_rx: crossbeam_channel::Receiver<UpstreamMessage>,
) {
    let protocol = if config.use_ssl { "wss" } else { "ws" };
    let url = format!(
        "{}://{}/api/voice/ws?deviceId={}&token={}",
        protocol, config.host, config.device_id, config.token
    );
    let reconnect_ms = (config.reconnect_interval_sec * 1000.0) as u64;

    // Pending messages that failed to send — retry on next connection
    let mut pending: Vec<String> = Vec::new();

    loop {
        tracing::info!("Connecting to backend WS: {}", url);
        // TCP connect with 5s timeout to avoid blocking when backend is down
        let addr_str = url
            .replace("ws://", "")
            .replace("wss://", "")
            .split('/')
            .next()
            .unwrap_or("127.0.0.1:7790")
            .split('?')
            .next()
            .unwrap_or("127.0.0.1:7790")
            .to_string();
        let tcp = match addr_str.parse::<std::net::SocketAddr>() {
            Ok(addr) => std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(5)),
            Err(_) => {
                // Hostname resolution — use regular connect with a thread timeout
                let addr_clone = addr_str.clone();
                let handle = std::thread::spawn(move || std::net::TcpStream::connect(&addr_clone));
                match handle.join() {
                    Ok(result) => result,
                    Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "connect thread panicked")),
                }
            }
        };
        let tcp_stream = match tcp {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Backend unreachable: {e}");
                emit_status(&app, &config.host, false, Some(format!("backend unreachable: {e}")));
                std::thread::sleep(std::time::Duration::from_millis(reconnect_ms));
                continue;
            }
        };
        match tungstenite::client(&url, tcp_stream) {
            Ok((mut socket, _response)) => {
                tracing::info!("WS connected");
                emit_status(&app, &config.host, true, None);

                // Send initial device state
                let init = UpstreamMessage::DeviceState {
                    state: "idle".into(),
                    device_id: config.device_id.clone(),
                    timestamp: ws_protocol::now_ts(),
                };
                let _ = socket.send(Message::Text(serde_json::to_string(&init).unwrap().into()));

                // Set non-blocking for interleaved read + write
                let _ = socket.get_mut().set_nonblocking(true);

                // Retry pending messages from previous failed connection
                if !pending.is_empty() {
                    tracing::info!("Retrying {} pending messages", pending.len());
                    let retry = std::mem::take(&mut pending);
                    let mut retry_ok = true;
                    for json in retry {
                        let _ = socket.get_mut().set_nonblocking(false);
                        if let Err(e) = socket.send(Message::Text(json.clone().into())) {
                            tracing::warn!("WS retry send failed: {e}");
                            pending.push(json);
                            retry_ok = false;
                            break;
                        }
                        let _ = socket.get_mut().set_nonblocking(true);
                    }
                    if !retry_ok {
                        let _ = socket.close(None);
                        continue; // reconnect
                    }
                    let _ = socket.get_mut().set_nonblocking(true);
                }

                let mut last_ping = std::time::Instant::now();
                let ping_interval = std::time::Duration::from_secs_f64(config.ping_interval_sec);

                'inner: loop {
                    // Check for upstream messages to send
                    while let Ok(msg) = upstream_rx.try_recv() {
                        let json = serde_json::to_string(&msg).unwrap();
                        let preview: String = json.chars().take(50).collect();
                        // Switch to blocking for send (large audio chunks need it)
                        let _ = socket.get_mut().set_nonblocking(false);
                        let send_result = socket.send(Message::Text(json.clone().into()));
                        let _ = socket.get_mut().set_nonblocking(true);
                        if let Err(e) = send_result {
                            tracing::warn!("WS send failed: {e} (msg: {preview})");
                            pending.push(json); // Save for retry
                            // Drain remaining channel messages into pending
                            while let Ok(remaining) = upstream_rx.try_recv() {
                                if let Ok(j) = serde_json::to_string(&remaining) {
                                    pending.push(j);
                                }
                            }
                            tracing::info!("Saved {} messages for retry after reconnect", pending.len());
                            break 'inner;
                        }
                    }

                    // Send ping if needed
                    if last_ping.elapsed() >= ping_interval {
                        let ping = UpstreamMessage::Ping {
                            device_id: config.device_id.clone(),
                            timestamp: ws_protocol::now_ts(),
                        };
                        if socket
                            .send(Message::Text(serde_json::to_string(&ping).unwrap().into()))
                            .is_err()
                        {
                            break 'inner;
                        }
                        last_ping = std::time::Instant::now();
                    }

                    // Try to read messages
                    match socket.read() {
                        Ok(Message::Text(text)) => {
                            if let Ok(msg) = serde_json::from_str::<DownstreamMessage>(&text) {
                                let _ = downstream_tx.send(msg);
                            }
                        }
                        Ok(Message::Close(_)) => {
                            tracing::warn!("WS closed by server");
                            break 'inner;
                        }
                        Ok(_) => {} // Binary, Ping, Pong
                        Err(tungstenite::Error::Io(ref e))
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            // Non-blocking: no data available, sleep briefly
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => {
                            tracing::warn!("WS read error (will reconnect): {e:?}");
                            break 'inner;
                        }
                    }
                }

                let _ = socket.close(None);
                emit_status(&app, &config.host, false, Some("disconnected".into()));
            }
            Err(e) => {
                tracing::warn!("WS connection failed: {e}");
                emit_status(&app, &config.host, false, Some(format!("ws handshake failed: {e}")));
            }
        }

        tracing::info!("Reconnecting in {}ms...", reconnect_ms);
        std::thread::sleep(std::time::Duration::from_millis(reconnect_ms));
    }
}
