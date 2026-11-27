/**
 * Users and access tokens.
 */
import type { Database } from "bun:sqlite";
import { now, parseJson } from "./store";
import { hashPassword, hashToken, newGuid, newToken } from "./security";

export type UserStatus = 1 | 0 | -1;
export type TokenKind = "client" | "console" | "api";

export interface UserRow {
  id: number;
  guid: string;
  name: string;
  display_name: string;
  email: string;
  note: string;
  password_hash: string;
  is_admin: number;
  status: number;
  totp_secret: string | null;
  strategy_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface TokenRow {
  token_hash: string;
  user_id: number;
  kind: TokenKind;
  label: string;
  device_id: string;
  device_uuid: string;
  device_info: string;
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
}

/** The client's UserPayload (client-api-spec 2.4). */
export interface UserPayload {
  name: string;
  display_name: string | null;
  avatar: string | null;
  email: string | null;
  note: string | null;
  status: UserStatus;
  is_admin: boolean;
  info: { email_verification: boolean; email_alarm_notification: boolean; other: Record<string, string> };
}

export function toUserPayload(u: UserRow): UserPayload {
  const status = u.status === 0 || u.status === -1 ? (u.status as UserStatus) : 1;
  return {
    name: u.name,
    display_name: u.display_name || null,
    avatar: null,
    email: u.email || null,
    note: u.note || null,
    status,
    is_admin: u.is_admin === 1,
    info: { email_verification: false, email_alarm_notification: false, other: {} },
  };
}

export function getUserById(db: Database, id: number): UserRow | null {
  return db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByName(db: Database, name: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE name = ?").get(name);
}

export function getUserByGuid(db: Database, guid: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE guid = ?").get(guid);
}

export function getUserByEmail(db: Database, email: string): UserRow | null {
  if (!email) return null;
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
}

export function countUsers(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n ?? 0;
}

export interface NewUser {
  name: string;
  password?: string;
  displayName?: string;
  email?: string;
  note?: string;
  isAdmin?: boolean;
  status?: UserStatus;
}

/** Valid login names: 1-64 chars, letters, digits and . _ @ + - */
export function isValidUserName(name: string): boolean {
  return /^[\p{L}\p{N}._@+-]{1,64}$/u.test(name);
}

export async function createUser(db: Database, u: NewUser): Promise<UserRow> {
  if (!isValidUserName(u.name)) throw new UserError("Invalid username");
  if (getUserByName(db, u.name)) throw new UserError("Username already exists");
  const passwordHash = u.password ? await hashPassword(u.password) : "";
  const t = now();
  const row = db
    .query<UserRow, [string, string, string, string, string, string, number, number, number, number]>(
      `INSERT INTO users (guid, name, display_name, email, note, password_hash, is_admin, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      newGuid(),
      u.name,
      u.displayName ?? "",
      u.email ?? "",
      u.note ?? "",
      passwordHash,
      u.isAdmin ? 1 : 0,
      u.status ?? 1,
      t,
      t,
    );
  if (!row) throw new Error("insert returned no row");
  return row;
}

export interface UserPatch {
  displayName?: string;
  email?: string;
  note?: string;
  isAdmin?: boolean;
  status?: UserStatus;
  password?: string;
  strategyId?: number | null;
}

export async function updateUser(db: Database, id: number, p: UserPatch): Promise<UserRow | null> {
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (p.displayName !== undefined) set("display_name", p.displayName);
  if (p.email !== undefined) set("email", p.email);
  if (p.note !== undefined) set("note", p.note);
  if (p.isAdmin !== undefined) set("is_admin", p.isAdmin ? 1 : 0);
  if (p.status !== undefined) set("status", p.status);
  if (p.strategyId !== undefined) set("strategy_id", p.strategyId);
  if (p.password !== undefined) set("password_hash", await hashPassword(p.password));
  if (sets.length > 0) {
    set("updated_at", now());
    args.push(id);
    db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }
  // A disabled account or a new password ends every session of the user.
  if (p.status === 0 || p.password !== undefined) revokeUserTokens(db, id, ["client", "console"]);
  return getUserById(db, id);
}

export function setTotpSecret(db: Database, userId: number, secret: string | null): void {
  db.query("UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?").run(secret, now(), userId);
}

export function deleteUser(db: Database, id: number): void {
  db.query("DELETE FROM users WHERE id = ?").run(id);
}

export function listUsers(db: Database): UserRow[] {
  return db.query<UserRow, []>("SELECT * FROM users ORDER BY name").all();
}

/**
 * Creates the bootstrap administrator when the database has no users yet.
 * Returns true if one was created.
 */
export async function ensureBootstrapAdmin(db: Database, name: string, password: string): Promise<boolean> {
  if (countUsers(db) > 0) return false;
  if (!password) {
    throw new Error("No users exist yet: set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) to create the first administrator");
  }
  await createUser(db, { name, password, isAdmin: true, displayName: "Administrator" });
  return true;
}

// ---- tokens ----

export interface DeviceRef {
  id: string;
  uuid: string;
  info: unknown;
}

export interface IssueTokenOptions {
  kind: TokenKind;
  ttlSeconds: number | null;
  label?: string;
  device?: DeviceRef;
}

/** Issues a token and returns its raw value; only the hash is stored. */
export function issueToken(db: Database, userId: number, o: IssueTokenOptions): string {
  const token = newToken();
  const t = now();
  db.query(
    `INSERT INTO tokens (token_hash, user_id, kind, label, device_id, device_uuid, device_info, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    userId,
    o.kind,
    o.label ?? "",
    o.device?.id ?? "",
    o.device?.uuid ?? "",
    JSON.stringify(o.device?.info ?? {}),
    t,
    t,
    o.ttlSeconds === null ? null : t + o.ttlSeconds,
  );
  return token;
}

export interface Authenticated {
  user: UserRow;
  token: TokenRow;
}

/**
 * Resolves a raw bearer token to its user. Expired tokens, disabled users and
 * tokens of a kind not in `kinds` resolve to null.
 */
export function authenticate(db: Database, raw: string, kinds: readonly TokenKind[]): Authenticated | null {
  if (!raw) return null;
  const token = db.query<TokenRow, [string]>("SELECT * FROM tokens WHERE token_hash = ?").get(hashToken(raw));
  if (!token || !kinds.includes(token.kind)) return null;
  const t = now();
  if (token.expires_at !== null && token.expires_at <= t) {
    db.query("DELETE FROM tokens WHERE token_hash = ?").run(token.token_hash);
    return null;
  }
  const user = getUserById(db, token.user_id);
  if (!user || user.status === 0) return null;
  // Avoid a write on every request: refresh last_used_at at most once a minute.
  if (t - token.last_used_at >= 60) {
    db.query("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").run(t, token.token_hash);
  }
  return { user, token };
}

export function revokeToken(db: Database, raw: string): void {
  db.query("DELETE FROM tokens WHERE token_hash = ?").run(hashToken(raw));
}

export function revokeTokenHash(db: Database, tokenHash: string): void {
  db.query("DELETE FROM tokens WHERE token_hash = ?").run(tokenHash);
}

export function revokeUserTokens(db: Database, userId: number, kinds: readonly TokenKind[]): void {
  const placeholders = kinds.map(() => "?").join(", ");
  db.query(`DELETE FROM tokens WHERE user_id = ? AND kind IN (${placeholders})`).run(userId, ...kinds);
}

export interface TokenSummary {
  token_hash: string;
  kind: TokenKind;
  label: string;
  device_id: string;
  device_info: unknown;
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
}

export function listTokens(db: Database, userId: number | null, kinds: readonly TokenKind[]): Array<TokenSummary & { user_id: number }> {
  const placeholders = kinds.map(() => "?").join(", ");
  const rows =
    userId === null
      ? db.query<TokenRow, string[]>(`SELECT * FROM tokens WHERE kind IN (${placeholders}) ORDER BY created_at DESC`).all(...kinds)
      : db
          .query<TokenRow, Array<string | number>>(
            `SELECT * FROM tokens WHERE user_id = ? AND kind IN (${placeholders}) ORDER BY created_at DESC`,
          )
          .all(userId, ...kinds);
  return rows.map((r) => ({
    token_hash: r.token_hash,
    user_id: r.user_id,
    kind: r.kind,
    label: r.label,
    device_id: r.device_id,
    device_info: parseJson(r.device_info, {}),
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
  }));
}

export class UserError extends Error {}
