# RustDesk Android P2P fix (patched APK)

Until upstream fixes the Android client (see [docs/upstream/](../docs/upstream/README.md)),
WebRTC between two Android 11+ phones behind one router never connects: the app gathers no
LAN (host) ICE candidates. This directory turns the **official RustDesk 1.5.3 arm64 APK**
into a fixed copy, without rebuilding the app.

## What it changes

Only `lib/arm64-v8a/librustdesk.so`, 352 bytes of it: the bodies of the client's own
`getifaddrs()` (at `0x1bfd1d4`) and `freeifaddrs()` (at `0x1bfd1a8`) become stubs that
look up bionic's functions with `dlsym(RTLD_DEFAULT, …)` and jump to them. Bionic's
`getifaddrs()` (API 24+) works for apps targeting API 30+. Every caller in the library
calls these two functions directly, so nothing else needs to change.

`patch_librustdesk.py` only accepts the library whose SHA-256 it pins and checks the first
instruction of both functions before writing. How the offsets were found: the netlink
`socket(AF_NETLINK, SOCK_RAW|SOCK_CLOEXEC, NETLINK_ROUTE)` call in `llvm-objdump -d`
output, followed by dumps with `RTM_GETLINK` (0x12) and then `RTM_GETADDR` (0x16), matches
`src/platform/android_ifaddrs.c`; `freeifaddrs()` is the function right before it.

The APK also gets its own package name (`com.carriez.flutter_hbb.p2pfix`, label "RustDesk
P2P fix", debuggable) so it installs **beside** the official app, and is signed with a
local key. A re-signed APK cannot update the official app; installing it in place would
need the official one uninstalled, which deletes its settings and login.

## Fork build (preferred): the source fix, built by CI

The source fix is on [tribixbite/rustdesk `fix/android-webrtc-host-candidates`](https://github.com/tribixbite/rustdesk/tree/fix/android-webrtc-host-candidates)
(PR to upstream pending). The fork-only branch `fork-ci/android-apk` adds a workflow
that runs upstream's own aarch64 Android build steps and uploads the APK as an artifact,
debug-signed and without releases. To install it beside the official app:

```sh
gh run download <run id> -R tribixbite/rustdesk -n rustdesk-1.5.3-aarch64-test.apk -D /tmp/ci
client-patch/clone.sh /tmp/ci/rustdesk-1.5.3-aarch64.apk   # -> build/<name>-p2pfix.apk
adb install -r --no-incremental client-patch/build/rustdesk-1.5.3-aarch64-p2pfix.apk
```

`clone.sh` uses the same package name and key as `build.sh`, so it updates an installed
binary-patched copy in place and keeps its settings. Verified 2026-11-27 (CI run
46012040234): the CI library imports `if_indextoname`/`ioctl`; on the Saga it offered a
`typ host` candidate and connected directly in about 1.0 s.

## Build (binary patch of the release)

```sh
client-patch/build.sh        # -> client-patch/build/rustdesk-1.5.3-p2pfix.apk
```

It downloads the release APK (pinned by hash), runs the unit tests, patches the library,
and on Android (Termux) also runs `test/libtest.c`, which `dlopen`s the real library and
calls its `getifaddrs()` by address: the original fails with `Permission denied`, the
patched one returns the same addresses as bionic. Then it repacks, renames the package
(`CloneManifest.kt`, built with APKEditor), aligns and signs. `build/` holds the key and
outputs and is not committed.

## Install and set up on a phone

```sh
adb install --no-incremental client-patch/build/rustdesk-1.5.3-p2pfix.apk
```

Configure it like the official app (server, relay, API, key, Use WebSocket), or, since
the copy is debuggable, write `app_flutter/RustDesk2.toml` with `adb shell run-as
com.carriez.flutter_hbb.p2pfix`. Notes from testing:

- Android allows one screen capture at a time. Granting the copy screen capture stops
  the official app's capture (and vice versa); re-grant the one you want.
- The copy needs "display over other apps" before it starts its service
  (`adb shell appops set com.carriez.flutter_hbb.p2pfix SYSTEM_ALERT_WINDOW allow`).
- Only one side needs the fix: the patched phone offers a host candidate, the unpatched
  phone's checks reach it directly, and ICE learns the other address from them.

## Result (2026-11-27, two Sagas on one LAN, through this fork's Railway server)

| Session | Path | Detail |
|---|---|---|
| Control, official 1.5.0 → patched copy | **WebRTC direct** | `connected` 1.05–1.1 s after the offer; hbbr session closed after 0.4 s with 116 bytes; hbbs trace showed `typ host` from the copy |
| File transfer, 64 MB, run 1 | WebRTC direct | 16.2 s (about 4.1 MB/s), MD5 matched |
| File transfer, 64 MB, run 2 | WebRTC direct | 18.1 s, MD5 matched |
| File transfer, 64 MB, peer set to "Always connect via relay" | hbbr relay | 11.1 s (about 5.8 MB/s), 67.1 MB through hbbr, MD5 matched |
| Same pair, official app on both sides (before) | relay only | ICE `wait_connected timeout`, `typ srflx` only |

So the fix makes direct sessions work, and they keep file data off Railway, but on this
LAN a bulk transfer over the WebRTC data channel was about 1.5x **slower** than over the
relay.

## Why direct transfers are slower (profiled 2026-11-27)

Same 64 MB download, patched copy sending, official app receiving, Saga ↔ Saga on one
Wi-Fi (idle RTT about 20 ms):

| Path | Time | Sender CPU (`simpleperf`, cpu-clock) |
|---|---|---|
| WebRTC, default (no SCTP congestion control) | 15.1–18.1 s | about 16 s of CPU in a 12 s window: 1.3 cores |
| WebRTC, `allow-webrtc-congestion-control=Y` | 20.8 s | lower, but slower |
| hbbr relay (peer set to "Always connect via relay") | 10.0–11.1 s | 1.8 s of CPU for the whole transfer |

- About **11x more sender CPU per byte** over WebRTC. No single thread is pegged; the two
  busiest run about 35–47% each, which is one serial pipeline hopping between threads.
- Kernel time is 47% of the sender's CPU, and over half of that is threads parking and
  waking each other (futex via `syscall`, eventfd via `write`); 34% is one `sendto` per
  1191-byte SCTP packet (about 56,000 for 64 MB). Window and RTT are not the limit:
  1 MiB in flight at 20 ms allows about 50 MB/s. Turning congestion control on made it
  slower, so loss recovery is not the limit either.
- Cause: RustDesk pins webrtc-rs 0.13 (fork `rustdesk-org/webrtc@49c89bd`, for its Rust
  1.75 toolchain). Upstream webrtc-rs reworked exactly this hot path afterwards (coalesced
  wakeups and a dedicated reactor, webrtc#813; burst-read and one SACK per batch,
  webrtc#815 + rtc#124; zero-copy and hardware AES; UDP GSO/GRO, webrtc#820), reporting
  about 2x throughput at about half the CPU per byte
  (https://webrtc.rs/blog/2026/07/18/from-13-mbps-to-beating-pion.html).

# TODO closing the gap means upgrading RustDesk's webrtc-rs or backporting those changes
into its 0.13 fork; both are upstream (rustdesk/rustdesk, rustdesk-org/webrtc) work.
Until then, for large transfers between two devices on the same LAN, "Always connect via
relay" on that peer is faster, at the cost of Railway egress.
