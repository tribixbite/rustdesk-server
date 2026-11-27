# Changes meant for upstream projects

Fixes found while testing this fork that belong in other repositories. Nothing
here is built or deployed; each item says where it should go.

## RustDesk client: Android WebRTC offers no host candidates

**Target:** rustdesk/rustdesk, `src/platform/android_ifaddrs.c`
(added in #15684, present in 1.5.0–1.5.3 and master as of 2026-11-27).
**Patch:** [client-android-ifaddrs-getlink.patch](client-android-ifaddrs-getlink.patch)
(`git am` on rustdesk/rustdesk master `45e34a6`).

What happens:

- The Android build replaces `getifaddrs()` with its own netlink version,
  because the API 21 sysroot lacks it. That version dumps `RTM_GETLINK` first
  and fails as a whole if the dump fails.
- Android 11+ refuses `RTM_GETLINK` to apps targeting API 30 or later (the
  app targets 36). The kernel logs
  `avc: denied { nlmsg_readpriv } … tclass=netlink_route_socket`.
- webrtc-util reads the failure as "no interfaces" (`ifaces().unwrap_or_default()`),
  so the ICE agent gathers no host candidates, only server-reflexive ones from
  STUN.
- Two Android peers behind the same NAT then need UDP hairpinning. Without it
  every ICE check fails, the answerer logs
  `webrtc wait_connected failed: WebRTC wait_connected timeout`, and the
  session falls back to the relay.

Evidence (Saga phone, Android 15, RustDesk 1.5.3, this deployment): every
WebRTC answerer start (`New webrtc stream` at 02:17:26.567 and
05:33:18.862) is followed within 3 ms by the `nlmsg_readpriv` denial for the
RustDesk process, and both sessions ended on the relay. The two phones were on
one /24 for the second attempt.

The fix: on `EACCES`/`EPERM` from the link dump, dump addresses alone and name
each with `if_indextoname()`, with flags from `SIOCGIFFLAGS`. Bionic's own
`getifaddrs()` does the same for these apps.

### Test

`ifaddrs-harness.c` compiles the shim under test names (via `ifaddrs-hook.h`)
and compares its output with bionic's `getifaddrs()`. With `refuse`, it also
fails the `RTM_GETLINK` send with `EACCES`. It runs in Termux on Android:

```sh
clang -include docs/upstream/ifaddrs-hook.h -c <rustdesk>/src/platform/android_ifaddrs.c -o shim.o
clang docs/upstream/ifaddrs-harness.c shim.o -o harness
./harness && ./harness refuse
```

Results on Android 15 (Termux, where the kernel already refuses
`RTM_GETLINK`): the original shim fails with `Permission denied` in both
modes. The patched shim returns the same 11 addresses as bionic in both.

Confirmed on devices with an equivalent binary patch of the released 1.5.3
library (bionic's `getifaddrs()` instead of the shim; see
[client-patch/](../../client-patch/README.md)): with the patched app on one
phone, the session between two phones on one LAN connected directly over
WebRTC in about 1.1 s, and the hbbs trace showed the patched side's
`typ host` candidate. The C patch itself has been tested with the harness only,
not in an app build.

### Issue text (draft, not posted)

> **Android: WebRTC gathers no host candidates on Android 11+ (RTM_GETLINK refused), so LAN P2P between phones fails**
>
> On Android 11+, apps targeting API ≥ 30 are refused the `RTM_GETLINK`
> netlink dump (`avc: denied { nlmsg_readpriv }`). `src/platform/android_ifaddrs.c`
> returns -1 when that dump fails, webrtc-util turns the error into an empty
> interface list, and the ICE agent offers only srflx candidates. Two Android
> peers behind one NAT without hairpinning then time out
> (`webrtc wait_connected timeout`) and use the relay. Reproduced with 1.5.3
> on Android 15; the denial is logged at the start of every answerer. A fix
> that falls back to `RTM_GETADDR` + `if_indextoname()` + `SIOCGIFFLAGS` (what
> bionic does), plus a harness that runs in Termux, is attached.
