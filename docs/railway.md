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

- Every session goes through hbbr; there is no direct peer-to-peer or LAN
  hole punching. Session traffic counts as Railway egress.
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

In each RustDesk client: **Settings → Network → ID/Relay server**:

| Field        | Value                    |
| ------------ | ------------------------ |
| ID server    | `<hbbs domain>`          |
| Relay server | `<hbbr domain>`          |
| API server   | `https://<hbbs domain>`  |
| Key          | `KEY_PUB`                |

Then turn on **Use WebSocket** in the same Network page.

The API server entry is what makes the client use `wss://` instead of `ws://`.
The client only checks whether it starts with `https`
(`hbb_common::websocket::check_ws`). The open-source server has no API, so
account login and the shared address book are unavailable; those are
RustDesk Server Pro features.
