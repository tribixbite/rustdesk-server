# Fork roadmap

Working task list for this fork (tribixbite/rustdesk-server). The fork tracks
rustdesk/rustdesk-server daily. Everything it adds is either a new directory
(`api/`, `railway/`) or a small hook into upstream files, so merges stay clean.

## Done

- [x] Railway deployment of hbbs, hbbr and api from source (docs/railway.md)
- [x] Daily upstream merge → test → deploy (`.github/workflows/railway.yml`)
- [x] Dependabot (cargo, actions, docker) + security updates; CodeQL for Rust
      and Actions, also dispatched after each upstream merge
- [x] hbbs: peer registration over WebSocket (commit 845f7fa). Verified with the
      official Android client 1.5.3.
- [x] hbbs: WebRTC signalling relay (`src/webrtc_signal.rs`, `WEBRTC` switch).
      Verified with real clients for offer, answer and ICE both ways.
- [x] hbbs: debug logs for WebRTC answers and ICE forwarding
- [x] hbbr: per-session throughput log; relay limits raised through variables
      (docs/railway.md "Relay throughput")
- [x] api: the client's Pro API (36 endpoints): login with TOTP and OIDC,
      address books (personal and shared, rules, tags), devices, heartbeat
      strategies and disconnects, accessible devices, audit, `--assign`
      (docs/api.md). Verified with the Android client: login, device
      ownership, shared-book read and write.
- [x] api: OpenAPI 3.1 at `/openapi.json`, Scalar docs at `/docs`
- [x] api: Preact web console at `/` (users, devices, groups, strategies, books,
      audit, tokens, settings, my account; config QR verified to decode)

## Open, by priority

1. **WebRTC never got past ICE in the real-device tests.** Signalling completes,
   but ICE times out between two Android phones on one LAN. Next steps:
   - test a desktop client as controller (1.5.3, Windows or Linux), and a pair
     on different networks (one on mobile data);
   - get client-side ICE traces (desktop `--log` or the RUST_LOG of a debug
     build) to see candidate pairs and check results;
   - check the controller's view: does it apply B's candidates once the answer
     is set (`client.rs` ICE bridge)?
2. **OIDC login is untested against a real provider.** Configure one (for
   example Google), set `OIDC_PROVIDERS`, and log in from a client and from the
   console.
3. **Dependabot PRs #4–#8** (root crate: openssl, webpki, spin, sqlx 0.8,
   jsonwebtoken 10). Merging them makes `Cargo.lock` diverge from upstream,
   and every later upstream lockfile change would then conflict in the daily
   merge. Prefer upstreaming them, or merge only security fixes and resolve the
   lock by hand. The `/ui` PRs (#1–#3) target upstream's unused Tauri UI.
4. **CodeQL backlog** (~100 alerts, nearly all in upstream code and
   `libs/hbb_common`, e.g. hard-coded test keys and peer pk logging). Triage,
   and dismiss the test-only ones, or report them upstream.
5. **hbbr relay loop:** forward each direction independently and batch flushes
   on WebSocket legs (transfer findings items 4–5) to cut per-session latency
   under load. Medium refactor of upstream `relay()`, so upstream it as a PR
   rather than carry it.
6. **API features not implemented:**
   - email codes/alarms (needs SMTP);
   - LDAP;
   - GitHub OAuth (it is not OIDC);
   - deployment and access control enforced in hbbs;
   - `/api/record` upload;
   - switch-grant signature check (needs device pks from hbbs);
   - raw-TCP API proxy via hbbs (only used outside WebSocket mode).
7. **Upstream contributions:** WebSocket registration (upstream issue #704) and
   WebRTC over WebSocket (PR #734 covers TCP only) would remove most of this
   fork's diff to `src/rendezvous_server.rs`.

## Test fixtures in production (remove when done)

- API user `saga-test`, which owns the Saga test phone 1636133440, and shared
  book "Family" with peer 123123123 and tags `kitchen` and `from-saga`.
