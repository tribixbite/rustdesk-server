import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  hashPassword,
  hashToken,
  hotp,
  newTotpSecret,
  verifyPassword,
  verifyTotp,
} from "../src/security";

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" (SHA1).
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

describe("TOTP", () => {
  test("matches the RFC 6238 SHA1 test vectors (8 digits)", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [t, code] of vectors) {
      expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
    }
  });

  test("accepts the current and adjacent steps only", () => {
    const secret = base32Encode(RFC_SECRET);
    const at = 1111111109;
    const step = Math.floor(at / 30);
    expect(verifyTotp(secret, hotp(RFC_SECRET, step), at)).toBe(true);
    expect(verifyTotp(secret, hotp(RFC_SECRET, step - 1), at)).toBe(true);
    expect(verifyTotp(secret, hotp(RFC_SECRET, step + 1), at)).toBe(true);
    expect(verifyTotp(secret, hotp(RFC_SECRET, step + 2), at)).toBe(false);
    expect(verifyTotp(secret, "12345", at)).toBe(false);
    expect(verifyTotp(secret, "abcdef", at)).toBe(false);
  });

  test("base32 round-trips and new secrets decode to 20 bytes", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(Array.from(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"))).toEqual(Array.from(RFC_SECRET));
    expect(base32Decode(newTotpSecret()).length).toBe(20);
  });
});

describe("passwords and tokens", () => {
  test("argon2id hash verifies only the right password", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });

  test("token hash is stable hex sha256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
