//! WebRTC signalling relay for clients that reach hbbs over WebSocket.
//!
//! Since 1.5.0 a client can open a direct WebRTC (ICE) connection even when it
//! talks to the rendezvous server over WebSocket only: hbbs never touches
//! media or STUN, it only forwards the SDP offer and answer and the trickled
//! ICE candidates between the two peers. The flow, with A the controlling side
//! and B the controlled side:
//!
//! 1. A sends `PunchHoleRequest{webrtc_sdp_offer}` on its punch connection and
//!    keeps that connection open. hbbs opens a [`Routes`] entry keyed by that
//!    connection's address and puts the offer into the `PunchHole` sent to B.
//! 2. B answers with `RelayResponse{webrtc_sdp_answer}` (or `PunchHoleSent`)
//!    on a new connection. hbbs forwards it to A without consuming A's sink, so
//!    later candidates can still reach A.
//! 3. Trickle ICE: A sends `IceCandidate{id}` on its punch connection; hbbs
//!    forwards it to B's registered address. B sends
//!    `IceCandidate{socket_addr}` (A's mangled address from `PunchHole`) on one
//!    long-lived connection of its own; hbbs forwards it to A's punch
//!    connection.
//!
//! Every candidate and answer must match a live route: the right peer id, the
//! offer's session key (its DTLS fingerprint), and for anything coming from B,
//! the IP B registered from. Routes expire after [`ROUTE_TTL`] without traffic,
//! after [`MAX_ROUTE_LIFETIME`] in any case, and when A's connection closes.
//!
//! The SDP fingerprint parser, the address decoder and the limits follow
//! rustdesk/rustdesk-server#734 (NotOfficer), which implements the same relay
//! for plain TCP connections.

use hbb_common::{rendezvous_proto::IceCandidate, try_into_v4};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, SocketAddrV6},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// Largest `webrtc://` offer or answer endpoint accepted. A trickle endpoint
/// carries no candidates and is about 1 KiB once base64 encoded.
pub(crate) const MAX_SDP_LEN: usize = 4096;
/// Largest single ICE candidate accepted.
pub(crate) const MAX_ICE_CANDIDATE_LEN: usize = 2048;
/// Largest session key (DTLS fingerprint) accepted.
pub(crate) const MAX_SESSION_KEY_LEN: usize = 256;
/// Candidates forwarded per route and direction. The controller re-sends each
/// candidate once, so this holds 64 distinct candidates from A.
pub(crate) const MAX_ICE_PER_DIRECTION: u32 = 128;
/// IceCandidate frames one connection may carry in total.
pub(crate) const MAX_ICE_FRAMES: u32 = 2 * MAX_ICE_PER_DIRECTION + 64;
/// Candidates without a matching route that close the connection carrying them.
pub(crate) const MAX_ICE_MISSES: u32 = 16;
/// Routes held at once, and per source IP of the controlling side.
const MAX_ROUTES: usize = 10_000;
const MAX_ROUTES_PER_IP: usize = 32;
/// A route lives this long after its last forwarded message...
pub(crate) const ROUTE_TTL: Duration = Duration::from_secs(60);
/// ...and never longer than this after the offer.
pub(crate) const MAX_ROUTE_LIFETIME: Duration = Duration::from_secs(120);

/// Whether the `WEBRTC` switch enables signalling. On unless it is set to a
/// clear "off" value, so an unset variable keeps the feature on.
pub(crate) fn enabled_from_arg(value: &str) -> bool {
    !matches!(
        value.trim().to_ascii_uppercase().as_str(),
        "N" | "NO" | "0" | "OFF" | "FALSE"
    )
}

/// One signalling session from the controlling connection `ctl` to `peer_id`.
#[derive(Debug)]
struct Route {
    peer_id: String,
    /// IP the controlled peer registered from; its answer and candidates must
    /// come from there.
    peer_ip: IpAddr,
    session_key: String,
    created: Instant,
    expires: Instant,
    /// Whether a response (answer, relay response, punch hole response) has
    /// already been delivered to the controller on its kept sink.
    replied: bool,
    to_peer: u32,
    to_controller: u32,
}

impl Route {
    fn alive(&self, now: Instant) -> bool {
        now < self.expires
    }

    /// Extends the route after traffic, up to its hard lifetime.
    fn touch(&mut self, now: Instant) {
        self.expires = (now + ROUTE_TTL).min(self.created + MAX_ROUTE_LIFETIME);
    }
}

/// Outcome of offering a candidate to [`Routes`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Ice {
    /// Matches a live route: forward it.
    Forward,
    /// Matches a live route that used up its budget: drop it quietly.
    OverBudget,
    /// Matches no live route: drop it and count a miss.
    NoMatch,
}

/// How a response for the controller connection is delivered.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReplySink {
    /// No WebRTC route: take the sink out of `tcp_punch`, as without WebRTC.
    Take,
    /// First response on a WebRTC route: send on the sink and leave it in
    /// place for the candidates that follow.
    Keep,
    /// A WebRTC route already got its response: drop this one, as the classic
    /// path does once the sink is gone.
    Drop,
}

/// IceCandidate frames seen on one connection.
#[derive(Default, Debug)]
pub(crate) struct IceCount {
    pub(crate) frames: u32,
    pub(crate) misses: u32,
}

/// Live signalling routes, keyed by the controller connection's address.
pub(crate) struct Routes {
    enabled: bool,
    map: Mutex<HashMap<SocketAddr, Route>>,
}

impl Routes {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            map: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    // Nothing here panics while holding the lock, so a poisoned map is still
    // consistent and can keep serving.
    fn lock(&self) -> MutexGuard<'_, HashMap<SocketAddr, Route>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Opens a route for an offer from controller connection `ctl` to
    /// `peer_id`, registered from `peer_ip`. Returns false when the offer must
    /// not be forwarded: signalling is off, the offer is malformed, or the
    /// table is full.
    pub(crate) fn open(&self, ctl: SocketAddr, peer_id: &str, peer_ip: IpAddr, offer: &str) -> bool {
        self.open_at(Instant::now(), ctl, peer_id, peer_ip, offer)
    }

    fn open_at(
        &self,
        now: Instant,
        ctl: SocketAddr,
        peer_id: &str,
        peer_ip: IpAddr,
        offer: &str,
    ) -> bool {
        if !self.enabled {
            return false;
        }
        let Some(session_key) = offer_session_key(offer) else {
            return false;
        };
        let ctl = try_into_v4(ctl);
        let mut map = self.lock();
        map.retain(|_, r| r.alive(now));
        // A new offer on the same connection replaces the old route.
        if !map.contains_key(&ctl) {
            let from_ip = map.keys().filter(|k| k.ip() == ctl.ip()).count();
            if map.len() >= MAX_ROUTES || from_ip >= MAX_ROUTES_PER_IP {
                return false;
            }
        }
        map.insert(
            ctl,
            Route {
                peer_id: peer_id.to_owned(),
                peer_ip: unmap(peer_ip),
                session_key,
                created: now,
                expires: now + ROUTE_TTL,
                replied: false,
                to_peer: 0,
                to_controller: 0,
            },
        );
        true
    }

    /// Whether `answer` from `sender` for `peer_id` may go to controller
    /// connection `ctl`: the route is live and has not been answered, the
    /// answer comes from the peer the offer went to, from the IP it registered
    /// from, and is a plausible endpoint.
    pub(crate) fn answer_allowed(
        &self,
        ctl: SocketAddr,
        peer_id: &str,
        sender: IpAddr,
        answer: &str,
    ) -> bool {
        self.answer_allowed_at(Instant::now(), ctl, peer_id, sender, answer)
    }

    fn answer_allowed_at(
        &self,
        now: Instant,
        ctl: SocketAddr,
        peer_id: &str,
        sender: IpAddr,
        answer: &str,
    ) -> bool {
        if answer.is_empty() || answer.len() > MAX_SDP_LEN || !answer.starts_with("webrtc://") {
            return false;
        }
        let mut map = self.lock();
        let Some(r) = map.get_mut(&try_into_v4(ctl)) else {
            return false;
        };
        if !r.alive(now) || r.replied || r.peer_id != peer_id || r.peer_ip != unmap(sender) {
            return false;
        }
        r.touch(now);
        true
    }

    /// How to deliver a response for controller connection `ctl`; marks a
    /// WebRTC route as answered.
    pub(crate) fn reply_sink(&self, ctl: SocketAddr) -> ReplySink {
        self.reply_sink_at(Instant::now(), ctl)
    }

    fn reply_sink_at(&self, now: Instant, ctl: SocketAddr) -> ReplySink {
        let mut map = self.lock();
        match map.get_mut(&try_into_v4(ctl)) {
            Some(r) if r.alive(now) => {
                if r.replied {
                    ReplySink::Drop
                } else {
                    r.replied = true;
                    ReplySink::Keep
                }
            }
            _ => ReplySink::Take,
        }
    }

    /// Counts a candidate from the controller on its connection `ctl`, for
    /// `peer_id`.
    pub(crate) fn ice_to_peer(&self, ctl: SocketAddr, peer_id: &str, session_key: &str) -> Ice {
        self.ice_at(Instant::now(), ctl, Some(peer_id), None, session_key)
    }

    /// Counts a candidate from the controlled side, sent from `sender`, for
    /// controller connection `ctl`.
    pub(crate) fn ice_to_controller(&self, ctl: SocketAddr, sender: IpAddr, session_key: &str) -> Ice {
        self.ice_at(Instant::now(), ctl, None, Some(sender), session_key)
    }

    fn ice_at(
        &self,
        now: Instant,
        ctl: SocketAddr,
        to_peer: Option<&str>,
        from_peer: Option<IpAddr>,
        session_key: &str,
    ) -> Ice {
        let mut map = self.lock();
        let Some(r) = map.get_mut(&try_into_v4(ctl)) else {
            return Ice::NoMatch;
        };
        if !r.alive(now)
            || r.session_key != session_key
            || to_peer.is_some_and(|id| id != r.peer_id)
            || from_peer.is_some_and(|ip| unmap(ip) != r.peer_ip)
        {
            return Ice::NoMatch;
        }
        let n = if to_peer.is_some() {
            &mut r.to_peer
        } else {
            &mut r.to_controller
        };
        if *n >= MAX_ICE_PER_DIRECTION {
            return Ice::OverBudget;
        }
        *n += 1;
        r.touch(now);
        Ice::Forward
    }

    /// Drops the route of controller connection `ctl`, when it closes.
    pub(crate) fn remove(&self, ctl: SocketAddr) {
        self.lock().remove(&try_into_v4(ctl));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// Whether a candidate is well formed enough to look up a route for.
pub(crate) fn valid_candidate(ice: &IceCandidate) -> bool {
    !ice.candidate.is_empty()
        && ice.candidate.len() <= MAX_ICE_CANDIDATE_LEN
        && !ice.session_key.is_empty()
        && ice.session_key.len() <= MAX_SESSION_KEY_LEN
}

/// An IPv4-mapped IPv6 address as plain IPv4, so both spellings compare equal.
fn unmap(ip: IpAddr) -> IpAddr {
    try_into_v4(SocketAddr::new(ip, 0)).ip()
}

/// AddrMangle::decode without its unchecked arithmetic, for addresses from the
/// network; the same result as AddrMangle::decode in a release build.
/// From rustdesk/rustdesk-server#734.
pub(crate) fn decode_addr(bytes: &[u8]) -> Option<SocketAddr> {
    if bytes.is_empty() {
        return None;
    }
    if bytes.len() > 16 {
        if bytes.len() != 18 {
            return None;
        }
        let mut ip = [0u8; 16];
        ip.copy_from_slice(&bytes[..16]);
        let port = u16::from_le_bytes([bytes[16], bytes[17]]);
        return Some(SocketAddr::V6(SocketAddrV6::new(ip.into(), port, 0, 0)));
    }
    let mut padded = [0u8; 16];
    padded[..bytes.len()].copy_from_slice(bytes);
    let number = u128::from_le_bytes(padded);
    let tm = (number >> 17) & (u32::MAX as u128);
    let ip = ((number >> 49).wrapping_sub(tm) as u32).to_le_bytes();
    let port = (number & 0xFF_FFFF).wrapping_sub(tm & 0xFFFF);
    Some(SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]),
        port as u16,
    )))
}

/// The clients' ICE session key for a WebRTC offer: the DTLS fingerprint of its
/// SDP (hbb_common webrtc.rs `get_key_for_sdp`). The offer is "webrtc://" +
/// standard base64 of a JSON session description. From rustdesk/rustdesk-server#734.
pub(crate) fn offer_session_key(offer: &str) -> Option<String> {
    if offer.len() > MAX_SDP_LEN {
        return None;
    }
    let json = base64::decode(offer.strip_prefix("webrtc://")?).ok()?;
    let desc: serde_json::Value = serde_json::from_slice(&json).ok()?;
    let key = sdp_fingerprint(desc.get("sdp")?.as_str()?)?;
    if key.is_empty() || key.len() > MAX_SESSION_KEY_LEN {
        return None;
    }
    Some(key)
}

// The session-level a=fingerprint, else the first one of an application
// section, as `get_key_for_sdp` picks it. From rustdesk/rustdesk-server#734.
fn sdp_fingerprint(sdp: &str) -> Option<String> {
    let mut in_media = false;
    let mut application = false;
    let mut media_fp = None;
    for line in sdp.lines() {
        if let Some(media) = line.strip_prefix("m=") {
            in_media = true;
            application = media.split(' ').next() == Some("application");
        } else if let Some(fp) = line.strip_prefix("a=fingerprint:") {
            if !in_media {
                return Some(fp.to_owned());
            }
            if application && media_fp.is_none() {
                media_fp = Some(fp.to_owned());
            }
        }
    }
    media_fp
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use hbb_common::AddrMangle;

    pub(crate) const FP: &str = "sha-256 97:52:D6:1F:1E:87:6C:DA:B8:21:95:64:A5:85:89:FA:02:71:C7:4D:B3:FD:25:92:40:FB:6B:65:24:3C:79:88";

    /// A `webrtc://` endpoint as the client encodes it.
    pub(crate) fn endpoint(kind: &str, sdp: &str) -> String {
        let json = serde_json::json!({"type": kind, "sdp": sdp, "ice_policy": "all"});
        format!("webrtc://{}", base64::encode(json.to_string()))
    }

    /// A trickle offer whose session key is [`FP`].
    pub(crate) fn offer() -> String {
        endpoint(
            "offer",
            &format!(
                "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=fingerprint:{}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
                FP
            ),
        )
    }

    fn ctl(port: u16) -> SocketAddr {
        SocketAddr::new("10.0.0.1".parse().unwrap(), port)
    }

    fn peer_ip() -> IpAddr {
        "10.0.0.2".parse().unwrap()
    }

    #[test]
    fn switch_is_on_unless_turned_off() {
        for on in ["", "Y", "yes", "1", "on", "true"] {
            assert!(enabled_from_arg(on), "{on:?}");
        }
        for off in ["N", "n", "no", "0", "off", "FALSE", " n "] {
            assert!(!enabled_from_arg(off), "{off:?}");
        }
    }

    #[test]
    fn session_key_from_session_level_or_application_section() {
        assert_eq!(offer_session_key(&offer()).as_deref(), Some(FP));
        let media = format!(
            "v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\na=fingerprint:sha-256 11\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:{}\r\n",
            FP
        );
        assert_eq!(offer_session_key(&endpoint("offer", &media)).as_deref(), Some(FP));
        assert_eq!(offer_session_key(&endpoint("offer", "v=0\r\ns=-\r\n")), None);
        assert_eq!(offer_session_key("webrtc://not-base64!"), None);
        assert_eq!(offer_session_key("http://x"), None);
        let big = endpoint("offer", &format!("a=fingerprint:{FP}\r\n{}", "a=x\r\n".repeat(1000)));
        assert_eq!(offer_session_key(&big), None);
    }

    #[test]
    fn decode_matches_addr_mangle_and_never_panics() {
        for addr in [
            "1.2.3.4:5678",
            "255.255.255.255:65535",
            "0.0.0.0:0",
            "[2001:db8::1]:443",
        ] {
            let addr: SocketAddr = addr.parse().unwrap();
            assert_eq!(decode_addr(&AddrMangle::encode(addr)), Some(addr));
        }
        assert_eq!(decode_addr(&[]), None);
        assert_eq!(decode_addr(&[0xff; 17]), None);
        for len in 1..=16 {
            decode_addr(&vec![0xff; len]);
        }
    }

    #[test]
    fn disabled_or_malformed_offers_open_no_route() {
        let off = Routes::new(false);
        assert!(!off.enabled());
        assert!(!off.open(ctl(1), "peer", peer_ip(), &offer()));
        let routes = Routes::new(true);
        assert!(!routes.open(ctl(1), "peer", peer_ip(), "webrtc://e30="));
        assert_eq!(routes.reply_sink(ctl(1)), ReplySink::Take);
        assert_eq!(routes.len(), 0);
    }

    #[test]
    fn answer_only_from_the_peer_host_and_only_once() {
        let routes = Routes::new(true);
        assert!(routes.open(ctl(1), "peer", peer_ip(), &offer()));
        let answer = endpoint("answer", "v=0\r\n");
        let other: IpAddr = "10.0.0.3".parse().unwrap();
        assert!(!routes.answer_allowed(ctl(1), "peer", other, &answer));
        assert!(!routes.answer_allowed(ctl(1), "other", peer_ip(), &answer));
        assert!(!routes.answer_allowed(ctl(2), "peer", peer_ip(), &answer));
        assert!(!routes.answer_allowed(ctl(1), "peer", peer_ip(), "garbage"));
        // the IPv4-mapped spelling of the same host is the same host
        let mapped: IpAddr = "::ffff:10.0.0.2".parse().unwrap();
        assert!(routes.answer_allowed(ctl(1), "peer", mapped, &answer));
        assert_eq!(routes.reply_sink(ctl(1)), ReplySink::Keep);
        assert!(!routes.answer_allowed(ctl(1), "peer", peer_ip(), &answer));
        assert_eq!(routes.reply_sink(ctl(1)), ReplySink::Drop);
        assert_eq!(routes.reply_sink(ctl(2)), ReplySink::Take);
    }

    #[test]
    fn ice_needs_the_route_session_and_peer_and_has_a_budget() {
        let routes = Routes::new(true);
        assert!(routes.open(ctl(1), "peer", peer_ip(), &offer()));
        let other: IpAddr = "10.0.0.3".parse().unwrap();
        assert_eq!(routes.ice_to_peer(ctl(1), "peer", "wrong"), Ice::NoMatch);
        assert_eq!(routes.ice_to_peer(ctl(1), "other", FP), Ice::NoMatch);
        assert_eq!(routes.ice_to_peer(ctl(2), "peer", FP), Ice::NoMatch);
        assert_eq!(routes.ice_to_controller(ctl(1), other, FP), Ice::NoMatch);
        for _ in 0..MAX_ICE_PER_DIRECTION {
            assert_eq!(routes.ice_to_peer(ctl(1), "peer", FP), Ice::Forward);
        }
        assert_eq!(routes.ice_to_peer(ctl(1), "peer", FP), Ice::OverBudget);
        // the other direction has a budget of its own
        assert_eq!(routes.ice_to_controller(ctl(1), peer_ip(), FP), Ice::Forward);
        routes.remove(ctl(1));
        assert_eq!(routes.ice_to_controller(ctl(1), peer_ip(), FP), Ice::NoMatch);
    }

    #[test]
    fn routes_expire_idle_and_at_the_hard_lifetime() {
        let routes = Routes::new(true);
        let t0 = Instant::now();
        assert!(routes.open_at(t0, ctl(1), "peer", peer_ip(), &offer()));
        let idle = t0 + ROUTE_TTL;
        assert_eq!(routes.ice_at(idle, ctl(1), Some("peer"), None, FP), Ice::NoMatch);
        assert_eq!(routes.reply_sink_at(idle, ctl(1)), ReplySink::Take);
        // traffic keeps a route alive, but not past its lifetime
        let mut now = t0;
        while now < t0 + MAX_ROUTE_LIFETIME - Duration::from_secs(10) {
            now += Duration::from_secs(10);
            assert_eq!(routes.ice_at(now, ctl(1), None, Some(peer_ip()), FP), Ice::Forward);
        }
        let end = t0 + MAX_ROUTE_LIFETIME;
        assert_eq!(routes.ice_at(end, ctl(1), None, Some(peer_ip()), FP), Ice::NoMatch);
        // expired routes are swept when the next offer opens one
        assert!(routes.open_at(end, ctl(2), "peer", peer_ip(), &offer()));
        assert_eq!(routes.len(), 1);
    }

    #[test]
    fn routes_are_capped_per_source_ip() {
        let routes = Routes::new(true);
        for port in 0..MAX_ROUTES_PER_IP as u16 {
            assert!(routes.open(ctl(port), "peer", peer_ip(), &offer()));
        }
        assert!(!routes.open(ctl(9999), "peer", peer_ip(), &offer()));
        // replacing the route of a connection that has one is fine
        assert!(routes.open(ctl(0), "peer", peer_ip(), &offer()));
        let elsewhere = SocketAddr::new("10.0.0.9".parse().unwrap(), 1);
        assert!(routes.open(elsewhere, "peer", peer_ip(), &offer()));
    }

    #[test]
    fn candidate_shape_is_bounded() {
        let ok = IceCandidate {
            session_key: FP.to_owned(),
            candidate: "candidate:1 1 udp 1 10.0.0.1 9 typ host".to_owned(),
            ..Default::default()
        };
        assert!(valid_candidate(&ok));
        let mut empty = ok.clone();
        empty.candidate.clear();
        assert!(!valid_candidate(&empty));
        let mut big = ok.clone();
        big.candidate = "x".repeat(MAX_ICE_CANDIDATE_LEN + 1);
        assert!(!valid_candidate(&big));
        let mut no_key = ok;
        no_key.session_key.clear();
        assert!(!valid_candidate(&no_key));
    }
}
