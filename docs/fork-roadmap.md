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
- [x] hbbs: debug logs for WebRTC answers and ICE forwarding; trace logs
      with the SDP and candidate text (`hbbs::rendezvous_server=trace`)
- [x] Real-device session tests (2026-11-27, Saga → Saga, Android 1.5.3/1.5.0,
      one LAN): remote control and file transfer both ways over the hbbr
      relay. A 64 MB file downloaded in about 12 s (about 5 MB/s) and uploaded
      in under 29 s; MD5 matched both times.
- [x] Root cause of the WebRTC ICE timeouts: the Android client gathers no
      host candidates on Android 11+ (refused `RTM_GETLINK`; hbbs trace showed
      only `typ srflx` both ways). Client patch, harness and issue draft in
      docs/upstream/README.md.
- [x] Patched APK (client-patch/): binary patch of the 1.5.3 `librustdesk.so`
      plus a side-by-side package; verified a direct WebRTC session and P2P
      file transfer between two Sagas on one LAN.
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

1. **Get the Android WebRTC fix upstream:** draft PR
   https://github.com/rustdesk/rustdesk/pull/17293 (fork CI green, Fable-audited,
   verified on devices with the CI-built APK). Mark it ready for review when you
   are happy with it; follow up on maintainer comments. The patch in
   docs/upstream/ (tested with a harness in Termux) needs to go to
   rustdesk/rustdesk as an issue or PR; the issue text is drafted there and
   needs the maintainer's approval before posting. Meanwhile client-patch/
   builds a working copy of 1.5.3 (port the offsets for each new release). After a client release
   with it, retest two phones on one LAN (expect `typ host` candidates in the
   hbbs trace and no relay session in the hbbr log). Until then, still worth
   testing: an Android phone with a desktop 1.5.3 client, and two devices on
   different networks.
2. **WebRTC bulk throughput:** profiled (client-patch/README.md "Why direct
   transfers are slower"): about 11x the relay's sender CPU per byte, from
   webrtc-rs 0.13's per-packet task hand-offs and one sendto per 1191-byte
   packet. The fix is upstream: move rustdesk to a webrtc-rs with webrtc#813,
   #815 and #820 (or backport them into rustdesk-org/webrtc). Next local
   step: symbolized profile from an unstripped fork-ci build.
3. **OIDC login is untested against a real provider.** Configure one (for
   example Google), set `OIDC_PROVIDERS`, and log in from a client and from the
   console.
4. **Dependabot PRs #4–#8** (root crate: openssl, webpki, spin, sqlx 0.8,
   jsonwebtoken 10). Merging them makes `Cargo.lock` diverge from upstream,
   and every later upstream lockfile change would then conflict in the daily
   merge. Prefer upstreaming them, or merge only security fixes and resolve the
   lock by hand. The `/ui` PRs (#1–#3) target upstream's unused Tauri UI.
5. **CodeQL backlog** (~100 alerts, nearly all in upstream code and
   `libs/hbb_common`, e.g. hard-coded test keys and peer pk logging). Triage,
   and dismiss the test-only ones, or report them upstream.
6. **hbbr relay loop:** forward each direction independently and batch flushes
   on WebSocket legs (transfer findings items 4–5) to cut per-session latency
   under load. Medium refactor of upstream `relay()`, so upstream it as a PR
   rather than carry it.
7. **API features not implemented:**
   - email codes/alarms (needs SMTP);
   - LDAP;
   - GitHub OAuth (it is not OIDC);
   - deployment and access control enforced in hbbs;
   - `/api/record` upload: won't do. Only dead code in the OSS client calls
     it, and it is unauthenticated by design;
   - switch-grant signature check (needs device pks from hbbs);
   - raw-TCP API proxy via hbbs (only used outside WebSocket mode).
8. **Upstream contributions:** WebSocket registration (upstream issue #704) and
   WebRTC over WebSocket (PR #734 covers TCP only) would remove most of this
   fork's diff to `src/rendezvous_server.rs`.

## Test fixtures in production (remove when done)

- API user `saga-test`, which owns the Saga test phone 1636133440, and shared
  book "Family" with peer 123123123 and tags `kitchen` and `from-saga`.
