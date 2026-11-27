/**
 * Token, password and TOTP primitives.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A new random token, URL-safe base64 of 32 bytes. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A random identifier for rows exposed to clients (address-book guids, audit guids). */
export function newGuid(): string {
  return crypto.randomUUID();
}

/** Tokens are stored only as this digest. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// ---- TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) ----

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** A new 160-bit TOTP secret, base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value for a counter (RFC 4226). */
export function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Checks a TOTP code, accepting one step of clock drift either way.
 * `atSeconds` is injectable for tests.
 */
export function verifyTotp(secretBase32: string, code: string, atSeconds = Date.now() / 1000): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const step = Math.floor(atSeconds / 30);
  for (const drift of [0, -1, 1]) {
    const expected = Buffer.from(hotp(secret, step + drift));
    if (timingSafeEqual(expected, Buffer.from(normalized))) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps. */
export function totpUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
