"""Unit tests for patch_librustdesk.py (run: python3 -m unittest discover -s test)."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import patch_librustdesk as p  # noqa: E402


def disassemble(code: bytes) -> list[str]:
    """Disassemble raw arm64 bytes with llvm-mc; branch targets print as pc-relative #imm."""
    hexbytes = " ".join(f"{x:#04x}" for x in code)
    out = subprocess.run(["llvm-mc", "--disassemble", "-triple=aarch64"],
                         input=hexbytes, capture_output=True, text=True, check=True)
    return [" ".join(line.split("//")[0].split()) for line in out.stdout.splitlines() if line.strip() and not line.strip().startswith(".")]


class Encodings(unittest.TestCase):
    def test_known_words(self) -> None:
        # Values cross-checked against llvm-objdump output of the patched library.
        self.assertEqual(p.adr(1, 0x1BFD1D4, 0x1BFD210), 0x100001E1)
        self.assertEqual(p.adr(1, 0x1BFD1A8, 0x1BFD21B), 0x70000381)
        self.assertEqual(p.b(0x1BFD1AC, 0x1BFD1DC), 0x1400000C)
        self.assertEqual(p.bl(0x1BFD1EC, p.DLSYM_PLT), 0x94152CF9)
        self.assertEqual(p.cbz_x(16, 0x1BFD1FC, 0x1BFD208), 0xB4000070)

    def test_out_of_range(self) -> None:
        with self.assertRaises(ValueError):
            p.adr(1, 0, 1 << 21)
        with self.assertRaises(ValueError):
            p.b(0, 1 << 28)


class Layout(unittest.TestCase):
    def test_patches_fill_exactly_the_two_functions(self) -> None:
        free, get = p.build_patches()
        self.assertEqual(free.vaddr, p.FREEIFADDRS)
        self.assertEqual(free.vaddr + len(free.data), p.GETIFADDRS)
        self.assertEqual(get.vaddr, p.GETIFADDRS)
        self.assertEqual(get.vaddr + len(get.data), p.GETIFADDRS_END)

    def test_strings_are_where_the_adr_points(self) -> None:
        _, get = p.build_patches()
        target = p.GETIFADDRS + 8 + 13 * 4
        off = target - p.GETIFADDRS
        self.assertEqual(get.data[off:off + 23], b"getifaddrs\0freeifaddrs\0")

    @unittest.skipUnless(shutil.which("llvm-mc"), "llvm-mc not installed")
    def test_disassembly(self) -> None:
        free, get = p.build_patches()
        got = disassemble(get.data[: 15 * 4])
        # Offsets are relative to each instruction: strings at +0x3c from getifaddrs,
        # common at +8, dlsym@plt and the fail slot as computed in build_patches.
        self.assertEqual(got, [
            "adr x1, #60", "b #4",
            "stp x29, x30, [sp, #-32]!", "mov x29, sp", "str x0, [sp, #16]", "mov x0, xzr",
            f"bl #{p.DLSYM_PLT - (p.GETIFADDRS + 24)}",
            "mov x16, x0", "ldr x0, [sp, #16]", "ldp x29, x30, [sp], #32",
            "cbz x16, #12", "br x16", "nop", "mov w0, #-1", "ret",
        ])
        self.assertEqual(disassemble(free.data[:8]), [
            f"adr x1, #{p.GETIFADDRS + 60 + 11 - p.FREEIFADDRS}",
            f"b #{p.GETIFADDRS + 8 - (p.FREEIFADDRS + 4)}",
        ])


class Guard(unittest.TestCase):
    def test_refuses_other_input(self) -> None:
        with self.assertRaises(SystemExit):
            p.patch(b"\0" * 64)


if __name__ == "__main__":
    unittest.main()
