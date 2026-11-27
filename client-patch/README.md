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

## Build

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
relay. # TODO find out why (webrtc-rs SCTP window/pacing, or the client's data-channel
framing) before calling WebRTC the faster path; `relay-fallback-delay` and "Always connect
via relay" per peer are the client-side switches meanwhile.
