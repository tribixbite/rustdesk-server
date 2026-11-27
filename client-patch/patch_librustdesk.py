"""Binary patch for RustDesk 1.5.3 Android (arm64): use bionic's getifaddrs().

The client links its own getifaddrs()/freeifaddrs() (src/platform/android_ifaddrs.c).
That version dumps RTM_GETLINK first and fails as a whole when Android 11+ refuses
the dump to apps targeting API 30+, so WebRTC gathers no host (LAN) candidates.
Bionic's getifaddrs() handles that refusal and exists from API 24, so this patch
replaces both shim bodies with a small stub that looks the libc function up with
dlsym(RTLD_DEFAULT, name) and tail-calls it. Every caller in the library calls the
shim directly, so the two bodies are the only bytes that change.

The offsets below belong to one exact build (see LIB_SHA256); the patcher refuses
any other input. See README.md for how they were found.

usage: python3 patch_librustdesk.py <in librustdesk.so> <out librustdesk.so>
"""

from __future__ import annotations

import hashlib
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

# librustdesk.so from rustdesk-1.5.3-aarch64-signed.apk (GitHub release 1.5.3).
LIB_SHA256 = "40f41d9e7315102a1ec8f0021c10400578a74a7a5e1ede224b47ed0895f9a4f6"
# The R+E LOAD segment maps file offset 0xba8c00 at vaddr 0xbacc00.
VADDR_TO_OFFSET = 0x4000
# Shim functions (virtual addresses) and the bytes they occupy.
FREEIFADDRS = 0x1BFD1A8  # 44 bytes, ends where getifaddrs starts
GETIFADDRS = 0x1BFD1D4  # 308 bytes, ends at the netlink dump helper 0x1bfd308
GETIFADDRS_END = 0x1BFD308
# dlsym is imported; its PLT stub.
DLSYM_PLT = 0x21485D0
# First words of each original function, checked before patching.
EXPECTED = {
    FREEIFADDRS: 0xB4000140,  # cbz x0, ...
    GETIFADDRS: 0xD10183FF,  # sub sp, sp, #0x60
}

BRK = 0xD4200000  # brk #0: fills unreachable bytes


def _imm(value: int, bits: int) -> int:
    """Two's-complement field of `bits` bits; raises if `value` does not fit."""
    if not -(1 << (bits - 1)) <= value < (1 << (bits - 1)):
        raise ValueError(f"offset {value:#x} does not fit in {bits} bits")
    return value & ((1 << bits) - 1)


def adr(rd: int, pc: int, target: int) -> int:
    off = _imm(target - pc, 21)
    return (off & 3) << 29 | 0b10000 << 24 | (off >> 2) << 5 | rd


def b(pc: int, target: int) -> int:
    return 0x14000000 | _imm((target - pc) >> 2, 26)


def bl(pc: int, target: int) -> int:
    return 0x94000000 | _imm((target - pc) >> 2, 26)


def cbz_x(rt: int, pc: int, target: int) -> int:
    return 0xB4000000 | _imm((target - pc) >> 2, 19) << 5 | rt


@dataclass(frozen=True)
class Patch:
    """Bytes to write at a virtual address."""

    vaddr: int
    data: bytes


def build_patches() -> list[Patch]:
    """Assemble the stubs.

    getifaddrs:  adr x1, "getifaddrs";  b common
    freeifaddrs: adr x1, "freeifaddrs"; b common
    common: save x0 and lr, x0 = dlsym(NULL /* RTLD_DEFAULT on LP64 bionic */, x1),
            restore, then br x16 to the libc function (x16 so BTI would accept it),
            or return -1 if dlsym found nothing.
    """
    words: list[int] = []
    g = GETIFADDRS
    common = g + 8
    # Layout of the getifaddrs area: 2 entry words, 13 common words, strings.
    fail = common + 4 * 11
    str_get = common + 4 * 13
    str_free = str_get + len(b"getifaddrs\0")
    words += [adr(1, g, str_get), b(g + 4, common)]
    body = [
        0xA9BE7BFD,  # stp x29, x30, [sp, #-32]!
        0x910003FD,  # mov x29, sp
        0xF9000BE0,  # str x0, [sp, #16]
        0xAA1F03E0,  # mov x0, xzr
        None,  # bl dlsym@plt
        0xAA0003F0,  # mov x16, x0
        0xF9400BE0,  # ldr x0, [sp, #16]
        0xA8C27BFD,  # ldp x29, x30, [sp], #32
        None,  # cbz x16, fail
        0xD61F0200,  # br x16
        0xD503201F,  # nop (keeps fail at a fixed slot)
        0x12800000,  # fail: mov w0, #-1
        0xD65F03C0,  # ret
    ]
    for i, w in enumerate(body):
        pc = common + 4 * i
        if i == 4:
            w = bl(pc, DLSYM_PLT)
        elif i == 8:
            w = cbz_x(16, pc, fail)
        assert w is not None
        words.append(w)
    code = struct.pack(f"<{len(words)}I", *words)
    assert g + len(code) == str_get
    strings = b"getifaddrs\0freeifaddrs\0"
    area = code + strings
    size = GETIFADDRS_END - GETIFADDRS
    area += struct.pack("<I", BRK) * ((size - len(area)) // 4)
    area += b"\0" * (size - len(area))

    f = FREEIFADDRS
    free_words = [adr(1, f, str_free), b(f + 4, common)]
    free_words += [BRK] * ((GETIFADDRS - FREEIFADDRS) // 4 - len(free_words))
    return [Patch(f, struct.pack(f"<{len(free_words)}I", *free_words)), Patch(g, area)]


def patch(lib: bytes) -> bytes:
    if hashlib.sha256(lib).hexdigest() != LIB_SHA256:
        raise SystemExit("input is not the RustDesk 1.5.3 arm64 librustdesk.so this patch is for")
    out = bytearray(lib)
    for vaddr, word in EXPECTED.items():
        off = vaddr - VADDR_TO_OFFSET
        if struct.unpack_from("<I", out, off)[0] != word:
            raise SystemExit(f"unexpected code at {vaddr:#x}")
    for p in build_patches():
        off = p.vaddr - VADDR_TO_OFFSET
        out[off : off + len(p.data)] = p.data
    return bytes(out)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    src, dst = Path(argv[1]), Path(argv[2])
    dst.write_bytes(patch(src.read_bytes()))
    print(f"patched {dst} sha256 {hashlib.sha256(dst.read_bytes()).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
