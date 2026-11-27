# Deploying to Railway

This fork can run on [Railway](https://railway.com) from its own source, with no
third-party image or template. It is sized for personal use: a handful of
machines, all connecting through the relay.

## How it works

Railway exposes services through an HTTPS edge (WebSockets supported, with no
duration or idle limit) and through TCP proxies on random high ports. It has no
inbound UDP. RustDesk clients have a WebSocket mode that maps a server *domain*
to fixed paths:

| Client endpoint                | Railway service | Domain target port | Listener          |
| ------------------------------ | --------------- | ------------------ | ----------------- |
| `wss://<hbbs domain>/ws/id`    | `hbbs`          | 21118              | hbbs WebSocket    |
| `wss://<hbbr domain>/ws/relay` | `hbbr`          | 21119              | hbbr WebSocket    |

A Railway service gets only one generated domain, so hbbs and hbbr run as two
services built from the same image (`railway/Dockerfile`).
`railway/entrypoint.sh` picks the binary from `RUSTDESK_ROLE`. Neither listener
checks the request path, so no reverse proxy is needed. Railway's edge sets
`X-Real-IP`, and both servers use it as the client address.

### Registration over WebSocket (fork change)

Upstream hbbs registers peers only over UDP. On TCP and WebSocket it ignores
`RegisterPeer` and answers `RegisterPk` with `NOT_SUPPORT`
([rustdesk/rustdesk-server#704](https://github.com/rustdesk/rustdesk-server/issues/704)).
RustDesk documents client WebSocket mode as a Server Pro feature. Without UDP, a
stock open-source hbbs therefore cannot register any client, on Railway or
behind any WebSocket-only proxy.

This fork accepts `RegisterPk` on the WebSocket listener, with the same
validation as UDP. An accepted connection stays open as that peer's route:

- hbbs sends an empty frame every 12 s, and the client echoes it. Each echo
  refreshes the peer's registration, which drives online status and punch
  requests.
- Messages for the peer (`PunchHole`, `RequestRelay`, `FetchLocalAddr`) go down
  that connection instead of UDP.
- The route is dropped after 36 s without an echo, or when the same ID
  registers from somewhere else.

Plain TCP is unchanged and still answers `NOT_SUPPORT`, because the client's TCP
mode expects a key exchange that open-source hbbs does not implement.

Consequences of WebSocket-only mode:

- There is no TCP, UDP or LAN hole punching. A session goes through hbbr
  unless a direct WebRTC connection succeeds (see
  [Direct connections (WebRTC)](#direct-connections-webrtc)). Relayed traffic
  counts as Railway egress.
- The plain TCP/UDP ports (21115–21117) are not exposed. Clients that are not
  set to WebSocket mode cannot reach the server.
- Both servers run with `-k _`. A client needs the server's public key to start
  a connection (hbbs checks it on punch requests) and to use the relay. Without
  the key, a client can register its own ID but cannot reach anyone.

## Variables

| Variable        | Service      | Value                                                     |
| --------------- | ------------ | --------------------------------------------------------- |
| `RUSTDESK_ROLE` | hbbs / hbbr  | `hbbs` or `hbbr`                                          |
| `KEY_PUB`       | both         | public key from `rustdesk-utils genkeypair`               |
| `KEY_PRIV`      | both         | secret key from the same keypair                          |
| `RELAY`         | hbbs         | the hbbr domain (`:21117` is appended when no port given) |
| `RAILWAY_DOCKERFILE_PATH` | both | `railway/Dockerfile` (otherwise Railway auto-detects Rust and builds with Railpack, which fails) |
| `WEBRTC`        | hbbs (optional) | `N` turns off WebRTC signalling; on when unset        |

Both services must use the same keypair. The entrypoint validates it and
rewrites `id_ed25519`/`id_ed25519.pub` in `/data` on every start, so the
variables are the source of truth. Mount a volume on hbbs at `/data` to keep its
peer database (`db_v2.sqlite3`) across deploys.

## Setup

```sh
git submodule update --init            # the build context needs libs/hbb_common
cargo run --release --bin rustdesk-utils -- genkeypair

railway init --name rustdesk
railway add --service hbbs
railway add --service hbbr

railway domain --service hbbs --port 21118
railway domain --service hbbr --port 21119
# `railway volume --service hbbs add` panics in CLI 4.66.0; link the service first.
railway service link hbbs
railway volume add --mount-path /data

railway variable set --service hbbs --skip-deploys \
  RAILWAY_DOCKERFILE_PATH=railway/Dockerfile \
  RUSTDESK_ROLE=hbbs RELAY=<hbbr domain> KEY_PUB=<public> KEY_PRIV=<secret>
railway variable set --service hbbr --skip-deploys \
  RAILWAY_DOCKERFILE_PATH=railway/Dockerfile \
  RUSTDESK_ROLE=hbbr KEY_PUB=<public> KEY_PRIV=<secret>

railway up --ci --service hbbs
railway up --ci --service hbbr
```

`railway up` uploads the working tree, including the submodule checkout.
Railway's GitHub builder is not used because Railway does not document
submodule support.

## Staying current

`.github/workflows/railway.yml` runs daily. It merges `rustdesk/rustdesk-server`
master into this fork through GitHub's merge-upstream API. If upstream moved,
it runs `cargo test` and then `railway up` for both services. Pushes to master
and manual runs deploy too. It needs a `RAILWAY_TOKEN` repository secret holding
a Railway project token.

Known limits:

- A merge conflict, or an upstream change to a workflow file (which the default
  `GITHUB_TOKEN` cannot push), fails the job. GitHub then emails you, and you
  merge by hand.
- GitHub disables scheduled workflows after 60 days without repository
  activity. If upstream is quiet that long, re-enable the workflow from the
  Actions tab.

## Client configuration

In each RustDesk client: **Settings → Network → ID/Relay server** (on mobile,
**Settings → ID/Relay server**):

| Field        | Value                        |
| ------------ | ---------------------------- |
| ID server    | `<hbbs domain>`              |
| Relay server | `<hbbr domain>`              |
| API server   | `https://<api domain>`       |
| Key          | `KEY_PUB`                    |

Then turn on **Use WebSocket**. The web console's overview page shows these
values, a configuration string for **Import server config**, and a QR code
that mobile clients scan from the same dialog.

The API server must start with `https`: that is what makes the client use
`wss://` instead of `ws://` (`hbb_common::websocket::check_ws`). It points at
the `api` service, which provides account login, shared address books,
devices, strategies and audit logs (docs/api.md).

## Relay throughput

hbbr limits each relayed session to `SINGLE_BANDWIDTH` (default 128 Mbit/s,
about 16 MB/s) and, after `DOWNGRADE_START_CHECK` (default 30 minutes), cuts a
session that averaged over `DOWNGRADE_THRESHOLD` of that cap down to
`LIMIT_SPEED` (default 32 Mbit/s). For a private relay these are raised on the
hbbr service:

| Variable                | Value   | Effect                                          |
| ----------------------- | ------- | ----------------------------------------------- |
| `SINGLE_BANDWIDTH`      | `2000`  | per-session cap in Mbit/s                       |
| `TOTAL_BANDWIDTH`       | `4000`  | cap shared by all sessions                      |
| `LIMIT_SPEED`           | `2000`  | downgrade target equal to the cap: no downgrade |
| `DOWNGRADE_START_CHECK` | `86400` | first downgrade check after 24 h                |

Every relayed byte is Railway egress. hbbr logs one line per session when it
ends (duration, bytes each way, average Mbit/s, whether it was downgraded), so
`railway logs --service hbbr` shows what a transfer actually achieved. Direct
WebRTC sessions (below) do not pass through Railway at all and are the faster
path whenever the two networks allow it.

## Direct connections (WebRTC)

> **Status (2026-11-27).** The signalling has been checked end to end with
> real clients. Official Android clients 1.5.0 → 1.5.3 on one LAN exchanged
> the offer, the answer and all ICE candidates through hbbs, both ways (debug
> log: `RUST_LOG=info,hbbs::rendezvous_server=debug`). In those tests ICE then
> timed out on the clients (`webrtc wait_connected timeout`), and sessions ran
> on the hbbr relay as designed. A direct WebRTC session through this
> deployment has not been observed yet. See docs/fork-roadmap.md.

RustDesk clients from 1.5.0 can connect peer to peer over WebRTC even when they
reach the server over WebSocket only. hbbs only passes the signalling between
the two clients: the SDP offer and answer, and the ICE candidates (each
machine's addresses) that follow. It never carries media or STUN traffic, so
the server needs no UDP. Upstream hbbs does not forward these messages; this
fork does, unless `WEBRTC=N` is set on hbbs. Each session logs
`WebRTC offer from … to … forwarded` when it starts.

To use it, turn it on in the client that **starts** the connection:
**Settings → General → Other → Enable WebRTC P2P connection** (desktop), or
the **Enable WebRTC P2P connection** switch in the mobile settings. This is the
local option `enable-webrtc=Y`. It defaults to off for any self-hosted server,
so it must be set explicitly. The controlled side needs no setting. Turn it on
in both clients if you connect in both directions.

How a connection is made:

- The client tries WebRTC and the hbbr relay at the same time. A relay that is
  ready first waits up to 2.5 s (client option `relay-fallback-delay`, in
  seconds) for WebRTC, then is used if WebRTC has not connected. If WebRTC
  fails, the session stays on the relay, with no action needed.
- Both machines need outbound UDP: to public STUN servers (the client defaults
  include Cloudflare's and Google's; override them with the client option
  `ice-servers`), and to each other for the ICE checks.
- WebRTC is not used when the client has a SOCKS proxy configured, or when the
  peer is set to always connect via relay.

NAT limits, with STUN only and no TURN server:

- Usually works when at least one side has an endpoint-independent mapping
  (full-cone, restricted-cone or port-restricted cone NAT), and on the same LAN.
- Fails between two symmetric NATs, and between a symmetric and a
  port-restricted NAT. These are common on mobile carrier-grade NAT and some
  corporate firewalls. Such sessions fall back to the relay.
- A TURN server would not help here. Railway has no UDP for one, and TURN over
  TCP is itself a relay, with no gain over hbbr.

The signalling is protected by WSS up to Railway's edge, like all other
WebSocket traffic. It is plain text from the edge to hbbs inside Railway. hbbs
forwards an answer or candidate only on a live route: the right peer ID, the
offer's DTLS fingerprint as session key, and, for anything from the controlled
side, the IP that side registered from. Routes end 60 s after their last
message, 120 s after the offer at the latest, or when the controlling client's
connection closes. The controlling client also checks the answer's DTLS
fingerprint against the controlled client's key, which hbbs signs.
