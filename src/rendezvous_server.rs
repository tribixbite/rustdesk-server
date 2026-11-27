use crate::common::*;
use crate::peer::*;
use crate::webrtc_signal::{self, Ice, IceCount, ReplySink, Routes};
use hbb_common::{
    allow_err, bail,
    bytes::{Bytes, BytesMut},
    bytes_codec::BytesCodec,
    config,
    futures::future::join_all,
    futures_util::{
        sink::SinkExt,
        stream::{SplitSink, SplitStream, StreamExt},
    },
    log,
    protobuf::{Message as _, MessageField},
    rendezvous_proto::{
        register_pk_response::Result::{TOO_FREQUENT, UUID_MISMATCH},
        *,
    },
    tcp::FramedStream,
    timeout,
    tokio::{
        self,
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{mpsc, Mutex},
        time::{interval, Duration},
    },
    tokio_util::codec::Framed,
    try_into_v4,
    udp::FramedSocket,
    AddrMangle, ResultType,
};
use ipnetwork::Ipv4Network;
use sodiumoxide::crypto::sign;
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    sync::Arc,
    time::Instant,
};

#[derive(Clone, Debug)]
enum Data {
    Msg(Box<RendezvousMessage>, SocketAddr),
    RelayServers0(String),
    RelayServers(RelayServers),
}

const REG_TIMEOUT: i64 = 30_000;
type TcpStreamSink = SplitSink<Framed<TcpStream, BytesCodec>, Bytes>;
type WsSink = SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, tungstenite::Message>;
enum Sink {
    TcpStream(TcpStreamSink),
    Ws(WsSink),
}
/// A stashed controller sink. Shared so that a WebRTC route can keep it for
/// the answer and the ICE candidates that follow (see `take_tcp_sink`).
type SharedSink = Arc<Mutex<Sink>>;
// Bounds a send on a shared sink, including the wait for it.
const SINK_SEND_TIMEOUT: u64 = 3_000;
type WsStream = SplitStream<tokio_tungstenite::WebSocketStream<TcpStream>>;
/// Outbound queues of peers registered over WebSocket, keyed by the address the
/// peer map stores for them. Such a peer has no UDP address, so `io_loop`
/// delivers its messages through this queue instead (see `serve_ws_peer`).
type WsPeers = Arc<Mutex<HashMap<SocketAddr, mpsc::UnboundedSender<Bytes>>>>;
// After registering, a WebSocket peer sends nothing on its own. The server sends
// an empty frame on this interval and the client echoes it (rendezvous_mediator.rs
// `start_tcp` in the client), which keeps the peer online: well under REG_TIMEOUT,
// and under the client's own 90 s receive timeout.
const WS_PEER_HEARTBEAT_MS: u64 = 12_000;
// A registered connection that has echoed nothing for three heartbeats is dead.
const WS_PEER_IDLE_MS: u128 = 3 * WS_PEER_HEARTBEAT_MS as u128;
type Sender = mpsc::UnboundedSender<Data>;
type Receiver = mpsc::UnboundedReceiver<Data>;
static ROTATION_RELAY_SERVER: AtomicUsize = AtomicUsize::new(0);
type RelayServers = Vec<String>;
const CHECK_RELAY_TIMEOUT: u64 = 3_000;
static ALWAYS_USE_RELAY: AtomicBool = AtomicBool::new(false);
const MAX_RELAY_UUID_LEN: usize = 128;

// The peer sends this uuid to whatever relay_server names, so keep control bytes out of it.
fn validate_relay_uuid(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_RELAY_UUID_LEN
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid relay UUID");
    }
    Ok(())
}

// A peer acknowledging a RequestRelay leaves both fields empty.
fn validate_relay_response(uuid: &str, relay_server: &str) -> Result<(), &'static str> {
    if uuid.is_empty() && relay_server.is_empty() {
        return Ok(());
    }
    validate_relay_uuid(uuid)
}

// An online query for about 5000 ids is the largest message a client sends here.
const DEFAULT_MAX_MESSAGE_KB: usize = 64;
// A knob that can be turned to unbounded is not a bound.
const MAX_MESSAGE_KB_CAP: usize = 64 << 10;
// tungstenite's default, so raising MAX_MESSAGE_KB does not widen a frame past it.
const WS_DEFAULT_MAX_FRAME_SIZE: usize = 16 << 20;
// Every connection pays its read buffer up front, and tungstenite's default is 128 KiB.
const WS_BUFFER_SIZE: usize = 8 << 10;
static MAX_MESSAGE: Lazy<usize> =
    Lazy::new(|| max_message_kb(&get_arg("MAX_MESSAGE_KB")) << 10);

fn max_message_kb(arg: &str) -> usize {
    match arg.parse::<usize>() {
        Ok(kb) if kb > 0 => kb.min(MAX_MESSAGE_KB_CAP),
        _ => DEFAULT_MAX_MESSAGE_KB,
    }
}

// Store punch hole requests
use once_cell::sync::Lazy;
use tokio::sync::Mutex as TokioMutex; // differentiate if needed
#[derive(Clone)]
struct PunchReqEntry { tm: Instant, from_ip: String, to_ip: String, to_id: String }
static PUNCH_REQS: Lazy<TokioMutex<VecDeque<PunchReqEntry>>> = Lazy::new(|| TokioMutex::new(VecDeque::new()));
const PUNCH_REQ_DEDUPE_SEC: u64 = 60;
static PUNCH_REQ_MAX: Lazy<usize> =
    Lazy::new(|| get_arg("MAX_PUNCH_REQUESTS").parse().unwrap_or(100_000));

async fn record_punch_req(from_ip: String, to_ip: String, to_id: String) {
    let max = *PUNCH_REQ_MAX;
    if max == 0 { return; }
    let mut lock = PUNCH_REQS.lock().await;
    let mut dup = false;
    for e in lock.iter().rev().take(30) { // only check recent tail subset for speed
        if e.from_ip == from_ip && e.to_id == to_id {
            if e.tm.elapsed().as_secs() < PUNCH_REQ_DEDUPE_SEC { dup = true; }
            break;
        }
    }
    if !dup {
        if lock.len() >= max { lock.pop_front(); }
        lock.push_back(PunchReqEntry { tm: Instant::now(), from_ip, to_ip, to_id });
    }
}

#[derive(Clone)]
struct Inner {
    serial: i32,
    version: String,
    software_url: String,
    mask: Option<Ipv4Network>,
    local_ip: String,
    sk: Option<sign::SecretKey>,
}

#[derive(Clone)]
pub struct RendezvousServer {
    tcp_punch: Arc<Mutex<HashMap<SocketAddr, SharedSink>>>,
    ws_peers: WsPeers,
    webrtc: Arc<Routes>,
    pm: PeerMap,
    tx: Sender,
    relay_servers: Arc<RelayServers>,
    relay_servers0: Arc<RelayServers>,
    rendezvous_servers: Arc<Vec<String>>,
    inner: Arc<Inner>,
}

/// Outcome of offering a WebSocket message to `handle_ws_register`.
enum WsRegister {
    /// A RegisterPk for this id was accepted; the connection now serves it.
    Registered(String),
    /// A RegisterPk was answered with a failure, or ignored.
    Rejected,
    /// Not a RegisterPk; `handle_tcp` handles it.
    NotRegistration,
}

enum LoopFailure {
    UdpSocket,
    Listener3,
    Listener2,
    Listener,
    ConsoleListener,
}

impl RendezvousServer {
    pub fn start(port: i32, serial: i32, key: &str, rmem: usize) -> ResultType<()> {
        Self::start_with_bind(None, port, serial, key, rmem)
    }

    #[tokio::main(flavor = "multi_thread")]
    pub async fn start_with_bind(
        bind_addr: Option<IpAddr>,
        port: i32,
        serial: i32,
        key: &str,
        rmem: usize,
    ) -> ResultType<()> {
        let (key, sk) = Self::get_server_sk(key)?;
        let nat_port = port - 1;
        let ws_port = port + 2;
        let pm = PeerMap::new().await?;
        log::info!("serial={}", serial);
        let rendezvous_servers = get_servers(&get_arg("rendezvous-servers"), "rendezvous-servers");
        let mut socket = create_udp_listener(bind_addr, port, rmem).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Data>();
        let software_url = get_arg("software-url");
        let version = hbb_common::get_version_from_url(&software_url);
        if !version.is_empty() {
            log::info!("software_url: {}, version: {}", software_url, version);
        }
        let mask = get_arg("mask").parse().ok();
        let local_ip = if mask.is_none() {
            "".to_owned()
        } else {
            get_arg_or(
                "local-ip",
                local_ip_address::local_ip()
                    .map(|x| x.to_string())
                    .unwrap_or_default(),
            )
        };
        let mut rs = Self {
            tcp_punch: Arc::new(Mutex::new(HashMap::new())),
            ws_peers: Default::default(),
            webrtc: Arc::new(Routes::new(webrtc_signal::enabled_from_arg(&get_arg(
                "WEBRTC",
            )))),
            pm,
            tx: tx.clone(),
            relay_servers: Default::default(),
            relay_servers0: Default::default(),
            rendezvous_servers: Arc::new(rendezvous_servers),
            inner: Arc::new(Inner {
                serial,
                version,
                software_url,
                sk,
                mask,
                local_ip,
            }),
        };
        log::info!("mask: {:?}", rs.inner.mask);
        log::info!("local-ip: {:?}", rs.inner.local_ip);
        std::env::set_var("PORT_FOR_API", port.to_string());
        rs.parse_relay_servers(&get_arg("relay-servers"));
        let mut listener = create_tcp_listener(bind_addr, port).await?;
        let mut listener2 = create_tcp_listener(bind_addr, nat_port).await?;
        let mut listener3 = create_tcp_listener(bind_addr, ws_port).await?;
        let mut listener_console = listen_console(bind_addr, nat_port as _).await?;
        log::info!("Listening on tcp/udp {}", listener.local_addr()?);
        log::info!(
            "Listening on tcp {}, extra port for NAT test",
            listener2.local_addr()?
        );
        log::info!("Listening on websocket {}", listener3.local_addr()?);
        log::info!("MAX_MESSAGE_KB={}", *MAX_MESSAGE >> 10);
        log::info!("WEBRTC={}", if rs.webrtc.enabled() { "Y" } else { "N" });
        let test_addr = get_arg("TEST_HBBS");
        if get_arg("ALWAYS_USE_RELAY").to_uppercase() == "Y" {
            ALWAYS_USE_RELAY.store(true, Ordering::SeqCst);
        }
        log::info!(
            "ALWAYS_USE_RELAY={}",
            if ALWAYS_USE_RELAY.load(Ordering::SeqCst) {
                "Y"
            } else {
                "N"
            }
        );
        if test_addr.to_lowercase() != "no" {
            let test_addr = if test_addr.is_empty() {
                listener.local_addr()?
            } else {
                test_addr.parse()?
            };
            tokio::spawn(async move {
                if let Err(err) = test_hbbs(test_addr).await {
                    if test_addr.is_ipv6() && test_addr.ip().is_unspecified() {
                        let mut test_addr = test_addr;
                        test_addr.set_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
                        if let Err(err) = test_hbbs(test_addr).await {
                            log::error!("Failed to run hbbs test with {test_addr}: {err}");
                            std::process::exit(1);
                        }
                    } else {
                        log::error!("Failed to run hbbs test with {test_addr}: {err}");
                        std::process::exit(1);
                    }
                }
            });
        };
        let main_task = async move {
            loop {
                log::info!("Start");
                match rs
                    .io_loop(
                        &mut rx,
                        &mut listener,
                        &mut listener2,
                        &mut listener3,
                        &mut listener_console,
                        &mut socket,
                        &key,
                    )
                    .await
                {
                    LoopFailure::UdpSocket => {
                        drop(socket);
                        socket = create_udp_listener(bind_addr, port, rmem).await?;
                    }
                    LoopFailure::Listener => {
                        drop(listener);
                        listener = create_tcp_listener(bind_addr, port).await?;
                    }
                    LoopFailure::Listener2 => {
                        drop(listener2);
                        listener2 = create_tcp_listener(bind_addr, nat_port).await?;
                    }
                    LoopFailure::ConsoleListener => {
                        drop(listener_console.take());
                        listener_console = listen_console(bind_addr, nat_port as _).await?;
                    }
                    LoopFailure::Listener3 => {
                        drop(listener3);
                        listener3 = create_tcp_listener(bind_addr, ws_port).await?;
                    }
                }
            }
        };
        let listen_signal = listen_signal();
        tokio::select!(
            res = main_task => res,
            res = listen_signal => res,
        )
    }

    async fn io_loop(
        &mut self,
        rx: &mut Receiver,
        listener: &mut TcpListener,
        listener2: &mut TcpListener,
        listener3: &mut TcpListener,
        listener_console: &mut Option<TcpListener>,
        socket: &mut FramedSocket,
        key: &str,
    ) -> LoopFailure {
        let mut timer_check_relay = interval(Duration::from_millis(CHECK_RELAY_TIMEOUT));
        loop {
            tokio::select! {
                _ = timer_check_relay.tick() => {
                    if self.relay_servers0.len() > 1 {
                        let rs = self.relay_servers0.clone();
                        let tx = self.tx.clone();
                        tokio::spawn(async move {
                            check_relay_servers(rs, tx).await;
                        });
                    }
                }
                Some(data) = rx.recv() => {
                    match data {
                        Data::Msg(msg, addr) => {
                            let route = try_into_v4(addr);
                            let ws_peer = self.ws_peers.lock().await.get(&route).cloned();
                            match ws_peer {
                                Some(tx) => {
                                    if let Ok(bytes) = msg.write_to_bytes() {
                                        tx.send(Bytes::from(bytes)).ok();
                                    }
                                }
                                None => { allow_err!(socket.send(msg.as_ref(), addr).await); }
                            }
                        }
                        Data::RelayServers0(rs) => { self.parse_relay_servers(&rs); }
                        Data::RelayServers(rs) => { self.relay_servers = Arc::new(rs); }
                    }
                }
                res = socket.next() => {
                    match res {
                        Some(Ok((bytes, addr))) => {
                            if let Err(err) = self.handle_udp(&bytes, addr.into(), socket, key).await {
                                log::error!("udp failure: {}", err);
                                return LoopFailure::UdpSocket;
                            }
                        }
                        Some(Err(err)) => {
                            log::error!("udp failure: {}", err);
                            return LoopFailure::UdpSocket;
                        }
                        None => {
                            // unreachable!() ?
                        }
                    }
                }
                res = listener2.accept() => {
                    match res {
                        Ok((stream, addr))  => {
                            stream.set_nodelay(true).ok();
                            self.handle_listener2(stream, addr).await;
                        }
                        Err(err) => {
                           log::error!("listener2.accept failed: {}", err);
                           return LoopFailure::Listener2;
                        }
                    }
                }
                res = accept_or_pending(listener_console.as_ref()) => {
                    match res {
                        Ok((stream, addr))  => {
                            stream.set_nodelay(true).ok();
                            self.handle_listener2(stream, addr).await;
                        }
                        Err(err) => {
                           log::error!("console listener.accept failed: {}", err);
                           return LoopFailure::ConsoleListener;
                        }
                    }
                }
                res = listener3.accept() => {
                    match res {
                        Ok((stream, addr))  => {
                            stream.set_nodelay(true).ok();
                            self.handle_listener(stream, addr, key, true).await;
                        }
                        Err(err) => {
                           log::error!("listener3.accept failed: {}", err);
                           return LoopFailure::Listener3;
                        }
                    }
                }
                res = listener.accept() => {
                    match res {
                        Ok((stream, addr)) => {
                            stream.set_nodelay(true).ok();
                            self.handle_listener(stream, addr, key, false).await;
                        }
                       Err(err) => {
                           log::error!("listener.accept failed: {}", err);
                           return LoopFailure::Listener;
                       }
                    }
                }
            }
        }
    }

    #[inline]
    async fn handle_udp(
        &mut self,
        bytes: &BytesMut,
        addr: SocketAddr,
        socket: &mut FramedSocket,
        key: &str,
    ) -> ResultType<()> {
        if let Ok(msg_in) = RendezvousMessage::parse_from_bytes(bytes) {
            match msg_in.union {
                Some(rendezvous_message::Union::RegisterPeer(rp)) => {
                    // B registered
                    if !rp.id.is_empty() && rp.id.len() <= MAX_PEER_ID_LEN {
                        log::trace!("New peer registered: {:?} {:?}", &rp.id, &addr);
                        self.update_addr(rp.id, addr, socket).await?;
                        if self.inner.serial > rp.serial {
                            let mut msg_out = RendezvousMessage::new();
                            msg_out.set_configure_update(ConfigUpdate {
                                serial: self.inner.serial,
                                rendezvous_servers: (*self.rendezvous_servers).clone(),
                                ..Default::default()
                            });
                            socket.send(&msg_out, addr).await?;
                        }
                    }
                }
                Some(rendezvous_message::Union::RegisterPk(rk)) => {
                    if let Some(msg_out) = self.register_pk(rk, addr).await {
                        socket.send(&msg_out, addr).await?;
                    }
                }
                Some(rendezvous_message::Union::PunchHoleRequest(ph)) => {
                    // UDP PunchHoleRequest is intentionally unsupported.
                    // The supported client path sends PunchHoleRequest over TCP/WS.
                }
                Some(rendezvous_message::Union::PunchHoleSent(phs)) => {
                    // UDP PunchHoleSent is intentionally unsupported to avoid UDP reflection/amplification
                }
                Some(rendezvous_message::Union::LocalAddr(la)) => {
                    // UDP LocalAddr is intentionally unsupported to avoid UDP reflection/amplification
                }
                Some(rendezvous_message::Union::ConfigureUpdate(mut cu)) => {
                    if try_into_v4(addr).ip().is_loopback() && cu.serial > self.inner.serial {
                        let mut inner: Inner = (*self.inner).clone();
                        inner.serial = cu.serial;
                        self.inner = Arc::new(inner);
                        self.rendezvous_servers = Arc::new(
                            cu.rendezvous_servers
                                .drain(..)
                                .filter(|x| {
                                    !x.is_empty()
                                        && test_if_valid_server(x, "rendezvous-server").is_ok()
                                })
                                .collect(),
                        );
                        log::info!(
                            "configure updated: serial={} rendezvous-servers={:?}",
                            self.inner.serial,
                            self.rendezvous_servers
                        );
                    }
                }
                Some(rendezvous_message::Union::SoftwareUpdate(su)) => {
                    if !self.inner.version.is_empty() && su.url != self.inner.version {
                        let mut msg_out = RendezvousMessage::new();
                        msg_out.set_software_update(SoftwareUpdate {
                            url: self.inner.software_url.clone(),
                            ..Default::default()
                        });
                        socket.send(&msg_out, addr).await?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Validates a RegisterPk and records the peer's key, returning the reply
    /// to send back. `None` means the request is ignored without a reply.
    /// Shared by the UDP path and peers registered over WebSocket.
    async fn register_pk(
        &mut self,
        rk: RegisterPk,
        addr: SocketAddr,
    ) -> Option<RendezvousMessage> {
        if rk.uuid.is_empty() || rk.pk.is_empty() {
            return None;
        }
        let id = rk.id;
        let ip = addr.ip().to_string();
        if id.len() < 6 || id.len() > MAX_PEER_ID_LEN {
            return Some(rk_res(UUID_MISMATCH));
        } else if !self.check_ip_blocker(&ip, &id).await {
            return Some(rk_res(TOO_FREQUENT));
        }
        let peer = self.pm.get_or(&id).await;
        let (changed, ip_changed) = {
            let peer = peer.read().await;
            if peer.uuid.is_empty() {
                (true, false)
            } else {
                if peer.uuid == rk.uuid {
                    if peer.info.ip != ip && peer.pk != rk.pk {
                        log::warn!(
                            "Peer {} ip/pk mismatch: {}/{:?} vs {}/{:?}",
                            id,
                            ip,
                            rk.pk,
                            peer.info.ip,
                            peer.pk,
                        );
                        drop(peer);
                        return Some(rk_res(UUID_MISMATCH));
                    }
                } else {
                    log::warn!(
                        "Peer {} uuid mismatch: {:?} vs {:?}",
                        id,
                        rk.uuid,
                        peer.uuid
                    );
                    drop(peer);
                    return Some(rk_res(UUID_MISMATCH));
                }
                let ip_changed = peer.info.ip != ip;
                (
                    peer.uuid != rk.uuid || peer.pk != rk.pk || ip_changed,
                    ip_changed,
                )
            }
        };
        let mut req_pk = peer.read().await.reg_pk;
        if req_pk.1.elapsed().as_secs() > 6 {
            req_pk.0 = 0;
        } else if req_pk.0 > 2 {
            return Some(rk_res(TOO_FREQUENT));
        }
        req_pk.0 += 1;
        req_pk.1 = Instant::now();
        peer.write().await.reg_pk = req_pk;
        if ip_changed {
            let mut lock = IP_CHANGES.lock().await;
            if let Some((tm, ips)) = lock.get_mut(&id) {
                if tm.elapsed().as_secs() > IP_CHANGE_DUR {
                    *tm = Instant::now();
                    ips.clear();
                    ips.insert(ip.clone(), 1);
                } else if let Some(v) = ips.get_mut(&ip) {
                    *v += 1;
                } else {
                    ips.insert(ip.clone(), 1);
                }
            } else {
                lock.insert(
                    id.clone(),
                    (Instant::now(), HashMap::from([(ip.clone(), 1)])),
                );
            }
        }
        if changed {
            self.pm.update_pk(id, peer, addr, rk.uuid, rk.pk, ip).await;
        }
        let mut msg_out = RendezvousMessage::new();
        msg_out.set_register_pk_response(RegisterPkResponse {
            result: register_pk_response::Result::OK.into(),
            ..Default::default()
        });
        Some(msg_out)
    }

    #[inline]
    async fn handle_tcp(
        &mut self,
        bytes: &[u8],
        sink: &mut Option<Sink>,
        addr: SocketAddr,
        key: &str,
        ws: bool,
        ice: &mut IceCount,
    ) -> bool {
        if let Ok(msg_in) = RendezvousMessage::parse_from_bytes(bytes) {
            match msg_in.union {
                Some(rendezvous_message::Union::PunchHoleRequest(ph)) => {
                    // there maybe several attempt, so sink can be none
                    if let Some(sink) = sink.take() {
                        self.tcp_punch.lock().await.insert(try_into_v4(addr), Arc::new(Mutex::new(sink)));
                    }
                    allow_err!(self.handle_tcp_punch_hole_request(addr, ph, key, ws).await);
                    return true;
                }
                Some(rendezvous_message::Union::RequestRelay(mut rf)) => {
                    if let Err(err) = validate_relay_uuid(&rf.uuid) {
                        log::warn!(
                            "Drop RequestRelay from {addr}: {err} (length {})",
                            rf.uuid.len()
                        );
                        return false;
                    }
                    // there maybe several attempt, so sink can be none
                    if let Some(sink) = sink.take() {
                        self.tcp_punch.lock().await.insert(try_into_v4(addr), Arc::new(Mutex::new(sink)));
                    }
                    if let Some(peer) = self.pm.get_in_memory(&rf.id).await {
                        let mut msg_out = RendezvousMessage::new();
                        rf.socket_addr = AddrMangle::encode(addr).into();
                        msg_out.set_request_relay(rf);
                        let peer_addr = peer.read().await.socket_addr;
                        self.tx.send(Data::Msg(msg_out.into(), peer_addr)).ok();
                    }
                    return true;
                }
                Some(rendezvous_message::Union::RelayResponse(mut rr)) => {
                    if let Err(err) = validate_relay_response(&rr.uuid, &rr.relay_server) {
                        log::warn!(
                            "Drop RelayResponse from {addr}: {err} (length {})",
                            rr.uuid.len()
                        );
                        return false;
                    }
                    let addr_b = AddrMangle::decode(&rr.socket_addr);
                    rr.socket_addr = Default::default();
                    // Before set_pk, which replaces the id in the oneof.
                    if !rr.webrtc_sdp_answer.is_empty() {
                        if self.webrtc.answer_allowed(addr_b, rr.id(), addr.ip(), &rr.webrtc_sdp_answer) {
                            log::debug!("WebRTC answer from {} to {:?} forwarded", rr.id(), addr_b);
                        } else {
                            log::debug!("WebRTC answer from {} ({:?}) to {:?} dropped: no matching route", rr.id(), addr, addr_b);
                            rr.webrtc_sdp_answer.clear();
                        }
                    }
                    let id = rr.id();
                    if !id.is_empty() {
                        let pk = self.get_pk(&rr.version, id.to_owned()).await;
                        rr.set_pk(pk);
                    }
                    let mut msg_out = RendezvousMessage::new();
                    if !rr.relay_server.is_empty() {
                        if self.is_lan(addr_b) {
                            // https://github.com/rustdesk/rustdesk-server/issues/24
                            rr.relay_server = self.inner.local_ip.clone();
                        } else if rr.relay_server == self.inner.local_ip {
                            rr.relay_server = self.get_relay_server(addr.ip(), addr_b.ip());
                        }
                    }
                    msg_out.set_relay_response(rr);
                    allow_err!(self.send_to_tcp_sync(msg_out, addr_b).await);
                }
                Some(rendezvous_message::Union::PunchHoleSent(phs)) => {
                    allow_err!(self.handle_hole_sent(phs, addr, None).await);
                }
                Some(rendezvous_message::Union::LocalAddr(la)) => {
                    allow_err!(self.handle_local_addr(la, addr, None).await);
                }
                Some(rendezvous_message::Union::TestNatRequest(tar)) => {
                    let mut msg_out = RendezvousMessage::new();
                    let mut res = TestNatResponse {
                        port: addr.port() as _,
                        ..Default::default()
                    };
                    if self.inner.serial > tar.serial {
                        let mut cu = ConfigUpdate::new();
                        cu.serial = self.inner.serial;
                        cu.rendezvous_servers = (*self.rendezvous_servers).clone();
                        res.cu = MessageField::from_option(Some(cu));
                    }
                    msg_out.set_test_nat_response(res);
                    Self::send_to_sink(sink, msg_out).await;
                }
                Some(rendezvous_message::Union::IceCandidate(ice_in)) if self.webrtc.enabled() => {
                    // true keeps the controller's punch connection and the
                    // controlled side's candidate connection open
                    return self.handle_ice_candidate(ice_in, addr, ice).await;
                }
                Some(rendezvous_message::Union::RegisterPk(_)) => {
                    let res = register_pk_response::Result::NOT_SUPPORT;
                    let mut msg_out = RendezvousMessage::new();
                    msg_out.set_register_pk_response(RegisterPkResponse {
                        result: res.into(),
                        ..Default::default()
                    });
                    Self::send_to_sink(sink, msg_out).await;
                }
                _ => {}
            }
        }
        false
    }

    #[inline]
    async fn update_addr(
        &mut self,
        id: String,
        socket_addr: SocketAddr,
        socket: &mut FramedSocket,
    ) -> ResultType<()> {
        let (request_pk, ip_change) = if let Some(old) = self.pm.get_in_memory(&id).await {
            let mut old = old.write().await;
            let ip = socket_addr.ip();
            let ip_change = if old.socket_addr.port() != 0 {
                ip != old.socket_addr.ip()
            } else {
                ip.to_string() != old.info.ip
            } && !ip.is_loopback();
            let request_pk = old.pk.is_empty() || ip_change;
            if !request_pk {
                old.socket_addr = socket_addr;
                old.last_reg_time = Instant::now();
            }
            let ip_change = if ip_change && old.reg_pk.0 <= 2 {
                Some(if old.socket_addr.port() == 0 {
                    old.info.ip.clone()
                } else {
                    old.socket_addr.to_string()
                })
            } else {
                None
            };
            (request_pk, ip_change)
        } else {
            (true, None)
        };
        if let Some(old) = ip_change {
            log::info!("IP change of {} from {} to {}", id, old, socket_addr);
        }
        let mut msg_out = RendezvousMessage::new();
        msg_out.set_register_peer_response(RegisterPeerResponse {
            request_pk,
            ..Default::default()
        });
        socket.send(&msg_out, socket_addr).await
    }

    #[inline]
    async fn handle_hole_sent<'a>(
        &mut self,
        phs: PunchHoleSent,
        addr: SocketAddr,
        socket: Option<&'a mut FramedSocket>,
    ) -> ResultType<()> {
        // punch hole sent from B, tell A that B is ready to be connected
        let addr_a = AddrMangle::decode(&phs.socket_addr);
        log::debug!(
            "{} punch hole response to {:?} from {:?}",
            if socket.is_none() { "TCP" } else { "UDP" },
            &addr_a,
            &addr
        );
        let webrtc_sdp_answer =
            if self.webrtc.answer_allowed(addr_a, &phs.id, addr.ip(), &phs.webrtc_sdp_answer) {
                phs.webrtc_sdp_answer.clone()
            } else {
                String::new()
            };
        let mut msg_out = RendezvousMessage::new();
        let mut p = PunchHoleResponse {
            socket_addr: AddrMangle::encode(addr).into(),
            pk: self.get_pk(&phs.version, phs.id).await,
            relay_server: phs.relay_server.clone(),
            webrtc_sdp_answer,
            ..Default::default()
        };
        if let Ok(t) = phs.nat_type.enum_value() {
            p.set_nat_type(t);
        }
        msg_out.set_punch_hole_response(p);
        if let Some(socket) = socket {
            socket.send(&msg_out, addr_a).await?;
        } else {
            self.send_to_tcp(msg_out, addr_a).await;
        }
        Ok(())
    }

    #[inline]
    async fn handle_local_addr<'a>(
        &mut self,
        la: LocalAddr,
        addr: SocketAddr,
        socket: Option<&'a mut FramedSocket>,
    ) -> ResultType<()> {
        // relay local addrs of B to A
        let addr_a = AddrMangle::decode(&la.socket_addr);
        log::debug!(
            "{} local addrs response to {:?} from {:?}",
            if socket.is_none() { "TCP" } else { "UDP" },
            &addr_a,
            &addr
        );
        let mut msg_out = RendezvousMessage::new();
        let mut p = PunchHoleResponse {
            socket_addr: la.local_addr.clone(),
            pk: self.get_pk(&la.version, la.id).await,
            relay_server: la.relay_server,
            ..Default::default()
        };
        p.set_is_local(true);
        msg_out.set_punch_hole_response(p);
        if let Some(socket) = socket {
            socket.send(&msg_out, addr_a).await?;
        } else {
            self.send_to_tcp(msg_out, addr_a).await;
        }
        Ok(())
    }

    #[inline]
    async fn handle_punch_hole_request(
        &mut self,
        addr: SocketAddr,
        ph: PunchHoleRequest,
        key: &str,
        ws: bool,
    ) -> ResultType<(RendezvousMessage, Option<SocketAddr>)> {
        let mut ph = ph;
        if !key.is_empty() && ph.licence_key != key {
            log::warn!("Authentication failed from {} for peer {} - invalid key", addr, ph.id);
            let mut msg_out = RendezvousMessage::new();
            msg_out.set_punch_hole_response(PunchHoleResponse {
                failure: punch_hole_response::Failure::LICENSE_MISMATCH.into(),
                ..Default::default()
            });
            return Ok((msg_out, None));
        }
        let id = ph.id;
        // punch hole request from A, relay to B,
        // check if in same intranet first,
        // fetch local addrs if in same intranet.
        // because punch hole won't work if in the same intranet,
        // all routers will drop such self-connections.
        if let Some(peer) = self.pm.get(&id).await {
            let (elapsed, peer_addr) = {
                let r = peer.read().await;
                (r.last_reg_time.elapsed().as_millis() as i64, r.socket_addr)
            };
            if elapsed >= REG_TIMEOUT {
                let mut msg_out = RendezvousMessage::new();
                msg_out.set_punch_hole_response(PunchHoleResponse {
                    failure: punch_hole_response::Failure::OFFLINE.into(),
                    ..Default::default()
                });
                return Ok((msg_out, None));
            }
            
            // record punch hole request (from addr -> peer id/peer_addr)
            record_punch_req(
                try_into_v4(addr).ip().to_string(),
                try_into_v4(peer_addr).ip().to_string(),
                id.clone(),
            )
            .await;

            let mut msg_out = RendezvousMessage::new();
            let peer_is_lan = self.is_lan(peer_addr);
            let is_lan = self.is_lan(addr);
            let mut relay_server = self.get_relay_server(addr.ip(), peer_addr.ip());
            let server_relay = ALWAYS_USE_RELAY.load(Ordering::SeqCst) || (peer_is_lan ^ is_lan);
            if server_relay {
                if peer_is_lan {
                    // https://github.com/rustdesk/rustdesk-server/issues/24
                    relay_server = self.inner.local_ip.clone()
                }
                ph.nat_type = NatType::SYMMETRIC.into(); // will force relay
            }
            let same_intranet: bool = !ws
                && (peer_is_lan && is_lan || {
                    match (peer_addr, addr) {
                        (SocketAddr::V4(a), SocketAddr::V4(b)) => a.ip() == b.ip(),
                        (SocketAddr::V6(a), SocketAddr::V6(b)) => a.ip() == b.ip(),
                        _ => false,
                    }
                });
            let socket_addr = AddrMangle::encode(addr).into();
            if same_intranet {
                log::debug!(
                    "Fetch local addr {:?} {:?} request from {:?}",
                    id,
                    peer_addr,
                    addr
                );
                msg_out.set_fetch_local_addr(FetchLocalAddr {
                    socket_addr,
                    relay_server,
                    ..Default::default()
                });
            } else {
                log::debug!(
                    "Punch hole {:?} {:?} request from {:?}",
                    id,
                    peer_addr,
                    addr
                );
                let mut punch_hole = PunchHole {
                    socket_addr,
                    nat_type: ph.nat_type,
                    relay_server,
                    ..Default::default()
                };
                // A WebRTC offer goes to the peer only with a signalling route
                // for its answer and candidates; a relay the server forces
                // keeps it out.
                if !server_relay
                    && !ph.webrtc_sdp_offer.is_empty()
                    && self.webrtc.open(addr, &id, peer_addr.ip(), &ph.webrtc_sdp_offer)
                {
                    log::info!("WebRTC offer from {} to {} forwarded", addr, id);
                    punch_hole.webrtc_sdp_offer = ph.webrtc_sdp_offer;
                    punch_hole.force_relay = ph.force_relay;
                }
                msg_out.set_punch_hole(punch_hole);
            }
            Ok((msg_out, Some(peer_addr)))
        } else {
            let mut msg_out = RendezvousMessage::new();
            msg_out.set_punch_hole_response(PunchHoleResponse {
                failure: punch_hole_response::Failure::ID_NOT_EXIST.into(),
                ..Default::default()
            });
            Ok((msg_out, None))
        }
    }

    #[inline]
    async fn handle_online_request(
        &mut self,
        stream: &mut FramedStream,
        peers: Vec<String>,
    ) -> ResultType<()> {
        let mut states = BytesMut::zeroed((peers.len() + 7) / 8);
        for (i, peer_id) in peers.iter().enumerate() {
            if let Some(peer) = self.pm.get_in_memory(peer_id).await {
                let elapsed = peer.read().await.last_reg_time.elapsed().as_millis() as i64;
                // bytes index from left to right
                let states_idx = i / 8;
                let bit_idx = 7 - i % 8;
                if elapsed < REG_TIMEOUT {
                    states[states_idx] |= 0x01 << bit_idx;
                }
            }
        }

        let mut msg_out = RendezvousMessage::new();
        msg_out.set_online_response(OnlineResponse {
            states: states.into(),
            ..Default::default()
        });
        stream.send(&msg_out).await?;

        Ok(())
    }

    #[inline]
    async fn send_to_tcp(&mut self, msg: RendezvousMessage, addr: SocketAddr) {
        let tcp = self.take_tcp_sink(addr).await;
        tokio::spawn(async move {
            Self::send_to_shared_sink(tcp, msg).await;
        });
    }

    /// The stashed sink of controller connection `addr` for one response.
    /// Without a WebRTC route it is taken out, as it always was; a WebRTC route
    /// keeps it in place for the ICE candidates, but serves no second response.
    async fn take_tcp_sink(&self, addr: SocketAddr) -> Option<SharedSink> {
        let addr = try_into_v4(addr);
        let mut tcp_punch = self.tcp_punch.lock().await;
        match self.webrtc.reply_sink(addr) {
            ReplySink::Take => tcp_punch.remove(&addr),
            ReplySink::Keep => tcp_punch.get(&addr).cloned(),
            ReplySink::Drop => None,
        }
    }

    async fn send_to_shared_sink(sink: Option<SharedSink>, msg: RendezvousMessage) {
        if let Some(sink) = sink {
            // the timeout covers waiting for the sink as well
            let send = async {
                let mut sink = sink.lock().await;
                Self::write_sink(&mut sink, msg).await;
            };
            if timeout(SINK_SEND_TIMEOUT, send).await.is_err() {
                log::debug!("Timeout writing to a tcp connection");
            }
        }
    }

    #[inline]
    async fn send_to_sink(sink: &mut Option<Sink>, msg: RendezvousMessage) {
        if let Some(sink) = sink.as_mut() {
            Self::write_sink(sink, msg).await;
        }
    }

    async fn write_sink(sink: &mut Sink, msg: RendezvousMessage) {
        if let Ok(bytes) = msg.write_to_bytes() {
            match sink {
                Sink::TcpStream(s) => {
                    allow_err!(s.send(Bytes::from(bytes)).await);
                }
                Sink::Ws(ws) => {
                    allow_err!(ws.send(tungstenite::Message::Binary(Bytes::from(bytes))).await);
                }
            }
        }
    }

    #[inline]
    async fn send_to_tcp_sync(
        &mut self,
        msg: RendezvousMessage,
        addr: SocketAddr,
    ) -> ResultType<()> {
        let sink = self.take_tcp_sink(addr).await;
        Self::send_to_shared_sink(sink, msg).await;
        Ok(())
    }

    /// Trickle ICE (see webrtc_signal.rs). The controller sends its candidates
    /// on its punch connection, with the target id; the controlled side sends
    /// them on a connection of its own, with the controller's address from
    /// PunchHole. Returns false to close a connection that sends too many
    /// frames or candidates matching no route.
    async fn handle_ice_candidate(
        &mut self,
        ice: IceCandidate,
        addr: SocketAddr,
        count: &mut IceCount,
    ) -> bool {
        count.frames += 1;
        if count.frames > webrtc_signal::MAX_ICE_FRAMES {
            log::debug!("Too many IceCandidate from {:?}", addr);
            return false;
        }
        let len = ice.candidate.len();
        let valid = webrtc_signal::valid_candidate(&ice);
        // Over the route's budget: dropped quietly. Only candidates without a
        // matching route count as misses.
        let mut over_budget = false;
        if valid && ice.socket_addr.is_empty() {
            match self.webrtc.ice_to_peer(addr, &ice.id, &ice.session_key) {
                Ice::Forward => {
                    if let Some(peer) = self.pm.get_in_memory(&ice.id).await {
                        let peer_addr = peer.read().await.socket_addr;
                        log::debug!("IceCandidate from controller {:?} to {} forwarded", addr, ice.id);
                        self.tx.send(Data::Msg(forward_ice(ice).into(), peer_addr)).ok();
                        return true;
                    }
                }
                Ice::OverBudget => over_budget = true,
                Ice::NoMatch => {}
            }
        } else if valid {
            if let Some(ctl) = webrtc_signal::decode_addr(&ice.socket_addr) {
                match self.webrtc.ice_to_controller(ctl, addr.ip(), &ice.session_key) {
                    Ice::Forward => {
                        let sink = self.tcp_punch.lock().await.get(&try_into_v4(ctl)).cloned();
                        if sink.is_some() {
                            log::debug!("IceCandidate from {:?} to controller {:?} forwarded", addr, ctl);
                            Self::send_to_shared_sink(sink, forward_ice(ice)).await;
                            return true;
                        }
                        log::debug!("IceCandidate from {:?}: controller {:?} has no open connection", addr, ctl);
                    }
                    Ice::OverBudget => over_budget = true,
                    Ice::NoMatch => {}
                }
            }
        }
        if over_budget {
            log::debug!("IceCandidate over the route's budget from {:?}", addr);
            return true;
        }
        count.misses += 1;
        log::debug!("Dropped IceCandidate ({} bytes) from {:?}", len, addr);
        count.misses <= webrtc_signal::MAX_ICE_MISSES
    }

    #[inline]
    async fn handle_tcp_punch_hole_request(
        &mut self,
        addr: SocketAddr,
        ph: PunchHoleRequest,
        key: &str,
        ws: bool,
    ) -> ResultType<()> {
        let (msg, to_addr) = self.handle_punch_hole_request(addr, ph, key, ws).await?;
        if let Some(addr) = to_addr {
            self.tx.send(Data::Msg(msg.into(), addr))?;
        } else {
            self.send_to_tcp_sync(msg, addr).await?;
        }
        Ok(())
    }

    #[inline]
    async fn handle_udp_punch_hole_request(
        &mut self,
        addr: SocketAddr,
        ph: PunchHoleRequest,
        key: &str,
    ) -> ResultType<()> {
        let (msg, to_addr) = self.handle_punch_hole_request(addr, ph, key, false).await?;
        self.tx.send(Data::Msg(
            msg.into(),
            match to_addr {
                Some(addr) => addr,
                None => addr,
            },
        ))?;
        Ok(())
    }

    async fn check_ip_blocker(&self, ip: &str, id: &str) -> bool {
        let mut lock = IP_BLOCKER.lock().await;
        let now = Instant::now();
        if let Some(old) = lock.get_mut(ip) {
            let counter = &mut old.0;
            if counter.1.elapsed().as_secs() > IP_BLOCK_DUR {
                counter.0 = 0;
            } else if counter.0 > 30 {
                return false;
            }
            counter.0 += 1;
            counter.1 = now;

            let counter = &mut old.1;
            let is_new = counter.0.get(id).is_none();
            if counter.1.elapsed().as_secs() > DAY_SECONDS {
                counter.0.clear();
            } else if counter.0.len() > 300 {
                return !is_new;
            }
            if is_new {
                counter.0.insert(id.to_owned());
            }
            counter.1 = now;
        } else {
            lock.insert(ip.to_owned(), ((0, now), (Default::default(), now)));
        }
        true
    }

    fn parse_relay_servers(&mut self, relay_servers: &str) {
        let rs = get_servers(relay_servers, "relay-servers");
        self.relay_servers0 = Arc::new(rs);
        self.relay_servers = self.relay_servers0.clone();
    }

    fn get_relay_server(&self, _pa: IpAddr, _pb: IpAddr) -> String {
        if self.relay_servers.is_empty() {
            return "".to_owned();
        } else if self.relay_servers.len() == 1 {
            return self.relay_servers[0].clone();
        }
        let i = ROTATION_RELAY_SERVER.fetch_add(1, Ordering::SeqCst) % self.relay_servers.len();
        self.relay_servers[i].clone()
    }

    async fn check_cmd(&self, cmd: &str) -> String {
        use std::fmt::Write as _;

        let mut res = "".to_owned();
        let mut fds = cmd.trim().split(' ');
        match fds.next() {
            Some("h") => {
                res = format!(
                    "{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
                    "relay-servers(rs) <separated by ,>",
                    "reload-geo(rg)",
                    "ip-blocker(ib) [<ip>|<number>] [-]",
                    "ip-changes(ic) [<id>|<number>] [-]",
                    "punch-requests(pr) [<number>] [-]",
                    "always-use-relay(aur)",
                    "test-geo(tg) <ip1> <ip2>"
                )
            }
            Some("relay-servers" | "rs") => {
                if let Some(rs) = fds.next() {
                    self.tx.send(Data::RelayServers0(rs.to_owned())).ok();
                } else {
                    for ip in self.relay_servers.iter() {
                        let _ = writeln!(res, "{ip}");
                    }
                }
            }
            Some("ip-blocker" | "ib") => {
                let mut lock = IP_BLOCKER.lock().await;
                lock.retain(|&_, (a, b)| {
                    a.1.elapsed().as_secs() <= IP_BLOCK_DUR
                        || b.1.elapsed().as_secs() <= DAY_SECONDS
                });
                res = format!("{}\n", lock.len());
                let ip = fds.next();
                let mut start = ip.map(|x| x.parse::<i32>().unwrap_or(-1)).unwrap_or(-1);
                if start < 0 {
                    if let Some(ip) = ip {
                        if let Some((a, b)) = lock.get(ip) {
                            let _ = writeln!(
                                res,
                                "{}/{}s {}/{}s",
                                a.0,
                                a.1.elapsed().as_secs(),
                                b.0.len(),
                                b.1.elapsed().as_secs()
                            );
                        }
                        if fds.next() == Some("-") {
                            lock.remove(ip);
                        }
                    } else {
                        start = 0;
                    }
                }
                if start >= 0 {
                    let mut it = lock.iter();
                    for i in 0..(start + 10) {
                        let x = it.next();
                        if x.is_none() {
                            break;
                        }
                        if i < start {
                            continue;
                        }
                        if let Some((ip, (a, b))) = x {
                            let _ = writeln!(
                                res,
                                "{}: {}/{}s {}/{}s",
                                ip,
                                a.0,
                                a.1.elapsed().as_secs(),
                                b.0.len(),
                                b.1.elapsed().as_secs()
                            );
                        }
                    }
                }
            }
            Some("ip-changes" | "ic") => {
                let mut lock = IP_CHANGES.lock().await;
                lock.retain(|&_, v| v.0.elapsed().as_secs() < IP_CHANGE_DUR_X2 && v.1.len() > 1);
                res = format!("{}\n", lock.len());
                let id = fds.next();
                let mut start = id.map(|x| x.parse::<i32>().unwrap_or(-1)).unwrap_or(-1);
                if !(0..=10_000_000).contains(&start) {
                    if let Some(id) = id {
                        if let Some((tm, ips)) = lock.get(id) {
                            let _ = writeln!(res, "{}s {:?}", tm.elapsed().as_secs(), ips);
                        }
                        if fds.next() == Some("-") {
                            lock.remove(id);
                        }
                    } else {
                        start = 0;
                    }
                }
                if start >= 0 {
                    let mut it = lock.iter();
                    for i in 0..(start + 10) {
                        let x = it.next();
                        if x.is_none() {
                            break;
                        }
                        if i < start {
                            continue;
                        }
                        if let Some((id, (tm, ips))) = x {
                            let _ = writeln!(res, "{}: {}s {:?}", id, tm.elapsed().as_secs(), ips,);
                        }
                    }
                }
            }
            Some("punch-requests" | "pr") => {
                use std::fmt::Write as _;
                let mut lock = PUNCH_REQS.lock().await;
                let arg = fds.next();
                if let Some("-") = arg { lock.clear(); }
                else {
                    let mut start = arg.and_then(|x| x.parse::<usize>().ok()).unwrap_or(0);
                    let mut page_size = fds.next().and_then(|x| x.parse::<usize>().ok()).unwrap_or(10);
                    if page_size == 0 { page_size = 10; }
                    for (_, e) in lock.iter().enumerate().skip(start).take(page_size) {
                        let age = e.tm.elapsed();
                        let event_system = std::time::SystemTime::now() - age;
                        let event_iso = chrono::DateTime::<chrono::Utc>::from(event_system)
                            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                        let _ = writeln!(res, "{} {} -> {}@{}", event_iso, e.from_ip, e.to_id, e.to_ip);
                    }
                }
            }
            Some("always-use-relay" | "aur") => {
                if let Some(rs) = fds.next() {
                    if rs.to_uppercase() == "Y" {
                        ALWAYS_USE_RELAY.store(true, Ordering::SeqCst);
                    } else {
                        ALWAYS_USE_RELAY.store(false, Ordering::SeqCst);
                    }
                    self.tx.send(Data::RelayServers0(rs.to_owned())).ok();
                } else {
                    let _ = writeln!(
                        res,
                        "ALWAYS_USE_RELAY: {:?}",
                        ALWAYS_USE_RELAY.load(Ordering::SeqCst)
                    );
                }
            }
            Some("test-geo" | "tg") => {
                if let Some(rs) = fds.next() {
                    if let Ok(a) = rs.parse::<IpAddr>() {
                        if let Some(rs) = fds.next() {
                            if let Ok(b) = rs.parse::<IpAddr>() {
                                res = format!("{:?}", self.get_relay_server(a, b));
                            }
                        } else {
                            res = format!("{:?}", self.get_relay_server(a, a));
                        }
                    }
                }
            }
            _ => {}
        }
        res
    }

    /// Handles loopback console requests and external NAT or online-status queries.
    async fn handle_listener2(&self, stream: TcpStream, addr: SocketAddr) {
        let mut rs = self.clone();
        let ip = try_into_v4(addr).ip();
        if ip.is_loopback() {
            tokio::spawn(async move {
                let mut stream = stream;
                let mut buffer = [0; 1024];
                if let Ok(Ok(n)) = timeout(1000, stream.read(&mut buffer[..])).await {
                    if let Ok(data) = std::str::from_utf8(&buffer[..n]) {
                        let res = rs.check_cmd(data).await;
                        if let Err(err) = timeout(1000, stream.write_all(res.as_bytes()))
                            .await
                            .unwrap_or_else(|elapsed| Err(elapsed.into()))
                        {
                            log::warn!("Failed to send the console reply: {err}");
                        }
                    }
                }
            });
            return;
        }
        let mut stream = FramedStream::from(stream, addr);
        stream.codec_mut().set_max_packet_length(*MAX_MESSAGE);
        tokio::spawn(async move {
            let mut stream = stream;
            if let Some(Ok(bytes)) = stream.next_timeout(30_000).await {
                if let Ok(msg_in) = RendezvousMessage::parse_from_bytes(&bytes) {
                    match msg_in.union {
                        Some(rendezvous_message::Union::TestNatRequest(_)) => {
                            let mut msg_out = RendezvousMessage::new();
                            msg_out.set_test_nat_response(TestNatResponse {
                                port: addr.port() as _,
                                ..Default::default()
                            });
                            stream.send(&msg_out).await.ok();
                        }
                        Some(rendezvous_message::Union::OnlineRequest(or)) => {
                            allow_err!(rs.handle_online_request(&mut stream, or.peers).await);
                        }
                        _ => {}
                    }
                }
            }
        });
    }

    async fn handle_listener(&self, stream: TcpStream, addr: SocketAddr, key: &str, ws: bool) {
        log::debug!("Tcp connection from {:?}, ws: {}", addr, ws);
        let mut rs = self.clone();
        let key = key.to_owned();
        tokio::spawn(async move {
            allow_err!(rs.handle_listener_inner(stream, addr, &key, ws).await);
        });
    }

    /// Processes rendezvous messages on an accepted TCP or WebSocket connection.
    #[inline]
    async fn handle_listener_inner(
        &mut self,
        stream: TcpStream,
        mut addr: SocketAddr,
        key: &str,
        ws: bool,
    ) -> ResultType<()> {
        let mut sink;
        let mut ice = IceCount::default();
        if ws {
            use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
            let callback = |req: &Request, response: Response| {
                let headers = req.headers();
                // X-Real-IP / X-Forwarded-For are trusted as-is so that the real
                // client IP is preserved when the WebSocket port runs behind a
                // reverse proxy (WSS). They are NOT validated: anyone who can reach
                // this port directly can spoof an arbitrary IP, bypassing IP-based
                // rate limiting / blocking and corrupting logged IPs. Do not expose
                // the WebSocket port directly to untrusted networks; only the
                // reverse proxy, which overwrites these headers, should be able to
                // connect to it.
                // https://github.com/rustdesk/rustdesk-server/issues/634
                let real_ip = headers
                    .get("X-Real-IP")
                    .or_else(|| headers.get("X-Forwarded-For"))
                    .and_then(|header_value| header_value.to_str().ok());
                if let Some(ip) = real_ip {
                    if let Ok(ip) = ip.parse() {
                        addr = SocketAddr::new(ip, addr.port());
                    }
                }
                Ok(response)
            };
            let ws_config = tungstenite::protocol::WebSocketConfig::default()
                .max_message_size(Some(*MAX_MESSAGE))
                .max_frame_size(Some((*MAX_MESSAGE).min(WS_DEFAULT_MAX_FRAME_SIZE)))
                .read_buffer_size(WS_BUFFER_SIZE)
                .write_buffer_size(WS_BUFFER_SIZE);
            let ws_stream = timeout(
                30_000,
                tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config)),
            )
            .await??;
            let (a, mut b) = ws_stream.split();
            sink = Some(Sink::Ws(a));
            let mut registered = None;
            while let Ok(Some(Ok(msg))) = timeout(30_000, b.next()).await {
                if let tungstenite::Message::Binary(bytes) = msg {
                    match self.handle_ws_register(&bytes, &mut sink, addr).await {
                        WsRegister::Registered(id) => {
                            registered = Some(id);
                            break;
                        }
                        WsRegister::Rejected => continue,
                        WsRegister::NotRegistration => {}
                    }
                    if !self.handle_tcp(&bytes, &mut sink, addr, key, ws, &mut ice).await {
                        break;
                    }
                }
            }
            if let Some(id) = registered {
                self.serve_ws_peer(id, addr, key, &mut sink, &mut b).await;
            }
        } else {
            let mut framed = Framed::new(stream, BytesCodec::new());
            framed.codec_mut().set_max_packet_length(*MAX_MESSAGE);
            let (a, mut b) = framed.split();
            sink = Some(Sink::TcpStream(a));
            while let Ok(Some(Ok(bytes))) = timeout(30_000, b.next()).await {
                if !self.handle_tcp(&bytes, &mut sink, addr, key, ws, &mut ice).await {
                    break;
                }
            }
        }
        if sink.is_none() {
            self.tcp_punch.lock().await.remove(&try_into_v4(addr));
            self.webrtc.remove(addr);
        }
        log::debug!("Tcp connection from {:?} closed", addr);
        Ok(())
    }

    /// Handles a RegisterPk arriving on a WebSocket connection. The UDP path is
    /// the only other place peers register; plain TCP still answers NOT_SUPPORT
    /// in `handle_tcp`, because the client expects a key exchange there first.
    async fn handle_ws_register(
        &mut self,
        bytes: &[u8],
        sink: &mut Option<Sink>,
        addr: SocketAddr,
    ) -> WsRegister {
        let Ok(msg_in) = RendezvousMessage::parse_from_bytes(bytes) else {
            return WsRegister::NotRegistration;
        };
        let Some(rendezvous_message::Union::RegisterPk(rk)) = msg_in.union else {
            return WsRegister::NotRegistration;
        };
        let id = rk.id.clone();
        let Some(msg_out) = self.register_pk(rk, addr).await else {
            return WsRegister::Rejected;
        };
        let ok = is_register_pk_ok(&msg_out);
        Self::send_to_sink(sink, msg_out).await;
        if !ok {
            return WsRegister::Rejected;
        }
        // register_pk updates the stored address only when the key or IP
        // changed, but a reconnecting peer arrives on a new connection.
        if let Some(peer) = self.pm.get_in_memory(&id).await {
            let mut w = peer.write().await;
            w.socket_addr = addr;
            w.last_reg_time = Instant::now();
        }
        WsRegister::Registered(id)
    }

    /// Keeps a peer registered over WebSocket reachable: delivers the messages
    /// `io_loop` routes to its address, sends heartbeats, and refreshes its
    /// registration when they are echoed. Returns when the connection fails,
    /// goes quiet, or a newer registration of the same id replaces it.
    async fn serve_ws_peer(
        &mut self,
        id: String,
        addr: SocketAddr,
        key: &str,
        sink: &mut Option<Sink>,
        stream: &mut WsStream,
    ) {
        let route = try_into_v4(addr);
        let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
        // Peers share an IP behind NAT but not the connection's source port, so
        // the address identifies this connection.
        self.ws_peers.lock().await.insert(route, tx.clone());
        log::info!("Peer {} registered over WebSocket from {}", id, addr);
        let mut heartbeat = interval(Duration::from_millis(WS_PEER_HEARTBEAT_MS));
        let mut last_recv = Instant::now();
        let mut ice = IceCount::default();
        loop {
            tokio::select! {
                res = stream.next() => {
                    let Some(Ok(msg)) = res else { break };
                    last_recv = Instant::now();
                    let bytes = match msg {
                        tungstenite::Message::Binary(bytes) => bytes,
                        tungstenite::Message::Close(_) => break,
                        _ => continue,
                    };
                    if bytes.is_empty() {
                        if !self.refresh_ws_peer(&id, addr).await {
                            log::info!("Peer {} re-registered elsewhere, closing {}", id, addr);
                            break;
                        }
                        continue;
                    }
                    match self.handle_ws_register(&bytes, sink, addr).await {
                        WsRegister::Registered(_) | WsRegister::Rejected => continue,
                        WsRegister::NotRegistration => {}
                    }
                    // Whether handle_tcp would end a one-shot connection does not
                    // matter here, but if it took the sink nothing more can be sent.
                    self.handle_tcp(&bytes, sink, addr, key, true, &mut ice).await;
                    if sink.is_none() {
                        break;
                    }
                }
                Some(bytes) = rx.recv() => {
                    if !Self::send_ws_bytes(sink, bytes).await {
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    if last_recv.elapsed().as_millis() > WS_PEER_IDLE_MS {
                        log::info!("Peer {} on {} stopped answering heartbeats", id, addr);
                        break;
                    }
                    if !Self::send_ws_bytes(sink, Bytes::new()).await {
                        break;
                    }
                }
            }
        }
        let mut ws_peers = self.ws_peers.lock().await;
        if ws_peers.get(&route).is_some_and(|cur| cur.same_channel(&tx)) {
            ws_peers.remove(&route);
        }
    }

    /// Marks a WebSocket peer as just seen. Returns false when the peer map no
    /// longer points at this connection, i.e. the id registered again elsewhere.
    async fn refresh_ws_peer(&self, id: &str, addr: SocketAddr) -> bool {
        let Some(peer) = self.pm.get_in_memory(id).await else {
            return false;
        };
        let mut w = peer.write().await;
        if try_into_v4(w.socket_addr) != try_into_v4(addr) {
            return false;
        }
        w.last_reg_time = Instant::now();
        true
    }

    /// Sends one binary frame on a WebSocket sink; false if it cannot be sent.
    async fn send_ws_bytes(sink: &mut Option<Sink>, bytes: Bytes) -> bool {
        match sink.as_mut() {
            Some(Sink::Ws(ws)) => ws.send(tungstenite::Message::Binary(bytes)).await.is_ok(),
            _ => false,
        }
    }

    #[inline]
    async fn get_pk(&mut self, version: &str, id: String) -> Bytes {
        if version.is_empty() || self.inner.sk.is_none() {
            Bytes::new()
        } else {
            match self.pm.get(&id).await {
                Some(peer) => {
                    let pk = peer.read().await.pk.clone();
                    sign::sign(
                        &hbb_common::rendezvous_proto::IdPk {
                            id,
                            pk,
                            ..Default::default()
                        }
                        .write_to_bytes()
                        .unwrap_or_default(),
                        self.inner.sk.as_ref().unwrap(),
                    )
                    .into()
                }
                _ => Bytes::new(),
            }
        }
    }

    #[inline]
    fn get_server_sk(key: &str) -> ResultType<(String, Option<sign::SecretKey>)> {
        let mut out_sk = None;
        let mut key = key.to_owned();
        if let Ok(sk) = base64::decode(&key) {
            if sk.len() == sign::SECRETKEYBYTES {
                log::info!("The key is a crypto private key");
                key = base64::encode(&sk[(sign::SECRETKEYBYTES / 2)..]);
                let mut tmp = [0u8; sign::SECRETKEYBYTES];
                tmp[..].copy_from_slice(&sk);
                out_sk = Some(sign::SecretKey(tmp));
            }
        }

        if key.is_empty() || key == "-" || key == "_" {
            let (pk, sk) = crate::common::gen_sk(0)?;
            out_sk = sk;
            if !key.is_empty() {
                key = pk;
            }
        }

        if !key.is_empty() {
            log::info!("Key: {}", key);
        }
        Ok((key, out_sk))
    }

    #[inline]
    fn is_lan(&self, addr: SocketAddr) -> bool {
        if let Some(network) = &self.inner.mask {
            match addr {
                SocketAddr::V4(v4_socket_addr) => {
                    return network.contains(*v4_socket_addr.ip());
                }

                SocketAddr::V6(v6_socket_addr) => {
                    if let Some(v4_addr) = v6_socket_addr.ip().to_ipv4() {
                        return network.contains(v4_addr);
                    }
                }
            }
        }
        false
    }
}

async fn check_relay_servers(rs0: Arc<RelayServers>, tx: Sender) {
    let mut futs = Vec::new();
    let rs = Arc::new(Mutex::new(Vec::new()));
    for x in rs0.iter() {
        let mut host = x.to_owned();
        if !host.contains(':') {
            host = format!("{}:{}", host, config::RELAY_PORT);
        }
        let rs = rs.clone();
        let x = x.clone();
        futs.push(tokio::spawn(async move {
            if FramedStream::new(&host, None, CHECK_RELAY_TIMEOUT)
                .await
                .is_ok()
            {
                rs.lock().await.push(x);
            }
        }));
    }
    join_all(futs).await;
    log::debug!("check_relay_servers");
    let rs = std::mem::take(&mut *rs.lock().await);
    if !rs.is_empty() {
        tx.send(Data::RelayServers(rs)).ok();
    }
}

// temp solution to solve udp socket failure
async fn test_hbbs(addr: SocketAddr) -> ResultType<()> {
    let mut addr = addr;
    if addr.ip().is_unspecified() {
        addr.set_ip(if addr.is_ipv4() {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        });
    }

    let mut socket = FramedSocket::new(config::Config::get_any_listen_addr(addr.is_ipv4())).await?;
    let mut msg_out = RendezvousMessage::new();
    msg_out.set_register_peer(RegisterPeer {
        id: "(:test_hbbs:)".to_owned(),
        ..Default::default()
    });
    let mut last_time_recv = Instant::now();

    let mut timer = interval(Duration::from_secs(1));
    loop {
        tokio::select! {
          _ = timer.tick() => {
              if last_time_recv.elapsed().as_secs() > 12 {
                  bail!("Timeout of test_hbbs");
              }
              socket.send(&msg_out, addr).await?;
          }
          Some(Ok((bytes, _))) = socket.next() => {
              if let Ok(msg_in) = RendezvousMessage::parse_from_bytes(&bytes) {
                 log::trace!("Recv {:?} of test_hbbs", msg_in);
                 last_time_recv = Instant::now();
              }
          }
        }
    }
}

#[inline]
/// Whether a reply built by `register_pk` accepts the registration.
fn is_register_pk_ok(msg: &RendezvousMessage) -> bool {
    matches!(
        &msg.union,
        Some(rendezvous_message::Union::RegisterPkResponse(res))
            if res.result.enum_value() == Ok(register_pk_response::Result::OK)
    )
}

/// The candidate as forwarded to the other side: only what it routes by.
fn forward_ice(ice: IceCandidate) -> RendezvousMessage {
    let mut msg_out = RendezvousMessage::new();
    msg_out.set_ice_candidate(IceCandidate {
        session_key: ice.session_key,
        candidate: ice.candidate,
        ..Default::default()
    });
    msg_out
}

fn rk_res(res: register_pk_response::Result) -> RendezvousMessage {
    let mut msg_out = RendezvousMessage::new();
    msg_out.set_register_pk_response(RegisterPkResponse {
        result: res.into(),
        ..Default::default()
    });
    msg_out
}

async fn create_udp_listener(
    bind_addr: Option<IpAddr>,
    port: i32,
    rmem: usize,
) -> ResultType<FramedSocket> {
    if let Some(bind_addr) = bind_addr {
        let addr = SocketAddr::new(bind_addr, port as _);
        return FramedSocket::new_reuse(&addr, true, rmem).await;
    }
    let addr = SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port as _);
    if let Ok(s) = FramedSocket::new_reuse(&addr, true, rmem).await {
        log::debug!("listen on udp {:?}", s.local_addr());
        return Ok(s);
    }
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port as _);
    let s = FramedSocket::new_reuse(&addr, true, rmem).await?;
    log::debug!("listen on udp {:?}", s.local_addr());
    Ok(s)
}

#[inline]
async fn create_tcp_listener(bind_addr: Option<IpAddr>, port: i32) -> ResultType<TcpListener> {
    let s = listen_tcp(bind_addr, port as _).await?;
    log::debug!("listen on tcp {:?}", s.local_addr());
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_message_kb_falls_back_to_default_and_is_capped() {
        assert_eq!(max_message_kb(""), DEFAULT_MAX_MESSAGE_KB);
        assert_eq!(max_message_kb("0"), DEFAULT_MAX_MESSAGE_KB);
        assert_eq!(max_message_kb("abc"), DEFAULT_MAX_MESSAGE_KB);
        assert_eq!(max_message_kb("256"), 256);
        assert_eq!(max_message_kb(&usize::MAX.to_string()), MAX_MESSAGE_KB_CAP);
    }

    #[test]
    fn default_message_bound_holds_an_online_query_for_5000_ids() {
        let mut msg = RendezvousMessage::new();
        msg.set_online_request(OnlineRequest {
            id: "1234567890".to_owned(),
            peers: (0..5000).map(|i| format!("{i:010}")).collect(),
            ..Default::default()
        });
        let len = msg.write_to_bytes().unwrap().len();
        assert!(len <= DEFAULT_MAX_MESSAGE_KB << 10, "{len}");
    }

    #[test]
    fn register_pk_ok_only_for_an_ok_register_pk_response() {
        assert!(is_register_pk_ok(&rk_res(register_pk_response::Result::OK)));
        assert!(!is_register_pk_ok(&rk_res(UUID_MISMATCH)));
        assert!(!is_register_pk_ok(&rk_res(TOO_FREQUENT)));
        let mut other = RendezvousMessage::new();
        other.set_test_nat_response(TestNatResponse::default());
        assert!(!is_register_pk_ok(&other));
        assert!(!is_register_pk_ok(&RendezvousMessage::new()));
    }

    #[test]
    fn relay_uuid_validation() {
        let uuid = "e4c181d0-41c7-4ae6-8ef0-36581b6b2b12";
        assert_eq!(validate_relay_response(uuid, "relay.example"), Ok(()));
        assert_eq!(validate_relay_response("", ""), Ok(()));
        let max_len = "a".repeat(128);
        for value in [
            uuid,
            "E4C181D0-41C7-4AE6-8EF0-36581B6B2B12",
            "e4c181d041c74ae68ef036581b6b2b12",
            "01890a5d-ac96-774b-bcce-b302099a8057",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "a_b-c",
            max_len.as_str(),
        ] {
            assert_eq!(validate_relay_uuid(value), Ok(()), "rejected {value:?}");
        }
        let too_long = "a".repeat(129);
        for value in [
            "",
            "\r\nPING\r\n",
            "e4c181d0-41c7-4ae6-8ef0-36581b6b2b12\n",
            "e4c181d0 41c7",
            "{e4c181d0-41c7-4ae6-8ef0-36581b6b2b12}",
            "e4c181d0\0",
            "é",
            too_long.as_str(),
        ] {
            assert!(validate_relay_uuid(value).is_err(), "accepted {value:?}");
            assert!(validate_relay_response(value, "relay.example").is_err());
        }
    }

    #[hbb_common::tokio::test]
    async fn udp_listener_uses_bind_address() {
        let bind_addr = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let socket = create_udp_listener(Some(bind_addr), 0, 0).await.unwrap();
        assert_eq!(socket.local_addr().unwrap().ip(), bind_addr);
    }

    #[hbb_common::tokio::test]
    async fn punch_reqs_bounded() {
        let max = *PUNCH_REQ_MAX;
        // 31 ids keep every request just outside the 30-entry dedupe window;
        // one request at least, so MAX_PUNCH_REQUESTS=0 is exercised too
        for i in 0..(max * 2).max(1) {
            record_punch_req(
                "1.2.3.4".to_owned(),
                "5.6.7.8".to_owned(),
                format!("peer{}", i % 31),
            )
            .await;
        }
        let lock = PUNCH_REQS.lock().await;
        assert_eq!(lock.len(), max);
        if max > 0 {
            // the oldest half is evicted and the newest kept
            assert_eq!(lock.front().unwrap().to_id, format!("peer{}", max % 31));
            assert_eq!(lock.back().unwrap().to_id, format!("peer{}", (max * 2 - 1) % 31));
        }
    }

    // WebRTC signalling end to end over real WebSocket connections: A is the
    // controlling client, B the controlled one, registered from 127.0.0.1.
    mod webrtc {
        use super::*;
        use crate::webrtc_signal::tests::{endpoint, offer, FP};

        type Ws = tokio_tungstenite::WebSocketStream<TcpStream>;
        const PEER: &str = "peerb1";

        // One database for the whole test binary: PeerMap::new reads DB_URL
        // from the environment, which parallel tests share.
        static DB: Lazy<tempfile::TempDir> =
            Lazy::new(|| tempfile::tempdir().expect("temporary directory"));

        struct Harness {
            rs: RendezvousServer,
            rx: Receiver,
            addr: SocketAddr,
            peer_addr: SocketAddr,
        }

        /// A server whose WebSocket listener runs, with `PEER` registered from
        /// 127.0.0.1 and `io_loop`'s routing replaced by `rx`.
        async fn harness(webrtc: bool) -> Harness {
            std::env::set_var("DB_URL", DB.path().join("db_v2.sqlite3"));
            let pm = PeerMap::new().await.unwrap();
            let (tx, rx) = mpsc::unbounded_channel::<Data>();
            let rs = RendezvousServer {
                tcp_punch: Default::default(),
                ws_peers: Default::default(),
                webrtc: Arc::new(Routes::new(webrtc)),
                pm,
                tx,
                relay_servers: Default::default(),
                relay_servers0: Default::default(),
                rendezvous_servers: Default::default(),
                inner: Arc::new(Inner {
                    serial: 0,
                    version: String::new(),
                    software_url: String::new(),
                    mask: None,
                    local_ip: String::new(),
                    sk: None,
                }),
            };
            let peer_addr: SocketAddr = "127.0.0.1:40000".parse().unwrap();
            {
                let peer = rs.pm.get_or(PEER).await;
                let mut w = peer.write().await;
                w.socket_addr = peer_addr;
                w.last_reg_time = Instant::now();
            }
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = rs.clone();
            tokio::spawn(async move {
                while let Ok((stream, from)) = listener.accept().await {
                    server.handle_listener(stream, from, "", true).await;
                }
            });
            Harness {
                rs,
                rx,
                addr,
                peer_addr,
            }
        }

        async fn connect(addr: SocketAddr) -> (Ws, SocketAddr) {
            let stream = TcpStream::connect(addr).await.unwrap();
            let local = stream.local_addr().unwrap();
            let (ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}"), stream)
                .await
                .unwrap();
            (ws, local)
        }

        async fn send(ws: &mut Ws, msg: RendezvousMessage) {
            let bytes = msg.write_to_bytes().unwrap();
            ws.send(tungstenite::Message::Binary(bytes.into())).await.unwrap();
        }

        async fn recv(ws: &mut Ws) -> RendezvousMessage {
            loop {
                let msg = timeout(5_000, ws.next()).await.unwrap().unwrap().unwrap();
                if let tungstenite::Message::Binary(bytes) = msg {
                    return RendezvousMessage::parse_from_bytes(&bytes).unwrap();
                }
            }
        }

        /// Waits until the server closes `ws`, failing if it sends anything.
        async fn closed(ws: &mut Ws) {
            match timeout(5_000, ws.next()).await.unwrap() {
                None | Some(Err(_)) | Some(Ok(tungstenite::Message::Close(_))) => {}
                Some(Ok(other)) => panic!("connection still open: {other:?}"),
            }
        }

        /// The next message `io_loop` would deliver, and where to.
        async fn routed(rx: &mut Receiver) -> (RendezvousMessage, SocketAddr) {
            loop {
                if let Data::Msg(msg, to) = timeout(5_000, rx.recv()).await.unwrap().unwrap() {
                    return (*msg, to);
                }
            }
        }

        fn punch_hole_request(offer: &str) -> RendezvousMessage {
            let mut msg = RendezvousMessage::new();
            msg.set_punch_hole_request(PunchHoleRequest {
                id: PEER.to_owned(),
                force_relay: true,
                webrtc_sdp_offer: offer.to_owned(),
                ..Default::default()
            });
            msg
        }

        fn relay_response(socket_addr: &Bytes, answer: &str) -> RendezvousMessage {
            let mut rr = RelayResponse {
                socket_addr: socket_addr.clone(),
                uuid: "e4c181d0-41c7-4ae6-8ef0-36581b6b2b12".to_owned(),
                relay_server: "relay.example".to_owned(),
                webrtc_sdp_answer: answer.to_owned(),
                ..Default::default()
            };
            rr.set_id(PEER.to_owned());
            let mut msg = RendezvousMessage::new();
            msg.set_relay_response(rr);
            msg
        }

        fn ice(id: &str, socket_addr: &Bytes, candidate: &str) -> RendezvousMessage {
            let mut msg = RendezvousMessage::new();
            msg.set_ice_candidate(IceCandidate {
                id: id.to_owned(),
                socket_addr: socket_addr.clone(),
                session_key: FP.to_owned(),
                candidate: candidate.to_owned(),
                ..Default::default()
            });
            msg
        }

        fn punch_hole(msg: RendezvousMessage) -> PunchHole {
            match msg.union {
                Some(rendezvous_message::Union::PunchHole(ph)) => ph,
                other => panic!("expected PunchHole, got {other:?}"),
            }
        }

        fn relay(msg: RendezvousMessage) -> RelayResponse {
            match msg.union {
                Some(rendezvous_message::Union::RelayResponse(rr)) => rr,
                other => panic!("expected RelayResponse, got {other:?}"),
            }
        }

        fn candidate(msg: RendezvousMessage) -> IceCandidate {
            match msg.union {
                Some(rendezvous_message::Union::IceCandidate(ice)) => ice,
                other => panic!("expected IceCandidate, got {other:?}"),
            }
        }

        #[hbb_common::tokio::test]
        async fn offer_answer_and_candidates_reach_both_sides() {
            let mut h = harness(true).await;
            let offer = offer();
            let (mut a, a_local) = connect(h.addr).await;
            send(&mut a, punch_hole_request(&offer)).await;

            let (msg, to) = routed(&mut h.rx).await;
            assert_eq!(to, h.peer_addr);
            let ph = punch_hole(msg);
            assert_eq!(ph.webrtc_sdp_offer, offer);
            assert!(ph.force_relay);
            assert_eq!(AddrMangle::decode(&ph.socket_addr), a_local);

            // B answers on a connection of its own; A gets the answer and
            // keeps its punch connection
            let answer = endpoint("answer", "v=0\r\n");
            let (mut b, _) = connect(h.addr).await;
            send(&mut b, relay_response(&ph.socket_addr, &answer)).await;
            let rr = relay(recv(&mut a).await);
            assert_eq!(rr.webrtc_sdp_answer, answer);
            assert_eq!(rr.uuid, "e4c181d0-41c7-4ae6-8ef0-36581b6b2b12");

            // A -> B on A's punch connection, routed to B's registration
            send(&mut a, ice(PEER, &Bytes::new(), "a-1")).await;
            let (msg, to) = routed(&mut h.rx).await;
            assert_eq!(to, h.peer_addr);
            let c = candidate(msg);
            assert_eq!((c.session_key.as_str(), c.candidate.as_str()), (FP, "a-1"));
            assert!(c.id.is_empty() && c.socket_addr.is_empty());

            // B -> A on one long-lived connection, which stays open
            let (mut b_ice, _) = connect(h.addr).await;
            for n in ["b-1", "b-2"] {
                send(&mut b_ice, ice("", &ph.socket_addr, n)).await;
                let c = candidate(recv(&mut a).await);
                assert_eq!((c.session_key.as_str(), c.candidate.as_str()), (FP, n));
                assert!(c.socket_addr.is_empty());
            }

            // a second response for the same route is not delivered; the
            // server closes a response connection once it has handled it
            let (mut b2, _) = connect(h.addr).await;
            send(&mut b2, relay_response(&ph.socket_addr, &answer)).await;
            closed(&mut b2).await;
            send(&mut b_ice, ice("", &ph.socket_addr, "b-3")).await;
            let c = candidate(recv(&mut a).await);
            assert_eq!(c.candidate, "b-3");

            // closing A's connection drops its sink and route
            drop(a);
            for _ in 0..100 {
                if !h.rs.tcp_punch.lock().await.contains_key(&a_local) {
                    break;
                }
                hbb_common::sleep(0.05).await;
            }
            assert!(!h.rs.tcp_punch.lock().await.contains_key(&a_local));
            assert_eq!(h.rs.webrtc.ice_to_peer(a_local, PEER, FP), Ice::NoMatch);
        }

        #[hbb_common::tokio::test]
        async fn candidates_from_another_host_or_session_are_dropped() {
            let mut h = harness(true).await;
            // B registered from another host than the one its replies come
            // from: nothing those carry is forwarded
            let registered: SocketAddr = "10.9.9.9:40000".parse().unwrap();
            h.rs.pm.get_or(PEER).await.write().await.socket_addr = registered;
            let (mut a, _) = connect(h.addr).await;
            send(&mut a, punch_hole_request(&offer())).await;
            let (msg, to) = routed(&mut h.rx).await;
            assert_eq!(to, registered);
            let ph = punch_hole(msg);
            assert!(!ph.webrtc_sdp_offer.is_empty());
            let (mut b, _) = connect(h.addr).await;
            send(&mut b, ice("", &ph.socket_addr, "spoofed")).await;
            send(&mut b, relay_response(&ph.socket_addr, &endpoint("answer", "v=0\r\n"))).await;
            let rr = relay(recv(&mut a).await);
            assert!(rr.webrtc_sdp_answer.is_empty());
            // a wrong session key from A is not routed to B
            let mut wrong = ice(PEER, &Bytes::new(), "a-1");
            if let Some(rendezvous_message::Union::IceCandidate(c)) = wrong.union.as_mut() {
                c.session_key = "sha-256 00".to_owned();
            }
            send(&mut a, wrong).await;
            send(&mut a, ice(PEER, &Bytes::new(), "a-2")).await;
            let c = candidate(routed(&mut h.rx).await.0);
            assert_eq!(c.candidate, "a-2");
        }

        #[hbb_common::tokio::test]
        async fn disabled_switch_keeps_the_classic_flow() {
            let mut h = harness(false).await;
            let (mut a, _) = connect(h.addr).await;
            send(&mut a, punch_hole_request(&offer())).await;
            let ph = punch_hole(routed(&mut h.rx).await.0);
            assert!(ph.webrtc_sdp_offer.is_empty());
            assert!(!ph.force_relay);
            let (mut b, _) = connect(h.addr).await;
            send(&mut b, relay_response(&ph.socket_addr, &endpoint("answer", "v=0\r\n"))).await;
            assert!(relay(recv(&mut a).await).webrtc_sdp_answer.is_empty());
            // an IceCandidate is an unknown message, which ends the connection
            send(&mut a, ice(PEER, &Bytes::new(), "a-1")).await;
            closed(&mut a).await;
        }
    }
}
