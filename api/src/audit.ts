/**
 * Connection, file-transfer and alarm audit records (client-api-spec section 5).
 */
import type { Database } from "bun:sqlite";
import { now, parseJson } from "./store";
import { newGuid } from "./security";

/** How long a nonce is remembered; the client retries within 120 s. */
const NONCE_TTL_SECONDS = 24 * 3600;

/**
 * Records a nonce. Returns false when it was seen before, so the record is a
 * client retry and must not be stored again.
 */
export function claimNonce(db: Database, nonce: string): boolean {
  if (!nonce) return true;
  const r = db.query("INSERT OR IGNORE INTO audit_nonces (nonce, created_at) VALUES (?, ?)").run(nonce, now());
  return r.changes === 1;
}

export function pruneNonces(db: Database): void {
  db.query("DELETE FROM audit_nonces WHERE created_at < ?").run(now() - NONCE_TTL_SECONDS);
}

/**
 * Pulls a JSON number field out of the raw body text without passing it through
 * a float. `session_id` is a random u64, which JSON.parse would round.
 */
export function rawJsonNumber(raw: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`).exec(raw);
  return m?.[1] ?? null;
}

export interface ConnAuditRow {
  guid: string;
  device_id: string;
  conn_id: number;
  session_id: string;
  ip: string;
  peer_id: string;
  peer_name: string;
  conn_type: number | null;
  primary_auth: number | null;
  two_factor: number | null;
  conn_audit_ref: string;
  note: string;
  created_at: number;
  authorized_at: number | null;
  closed_at: number | null;
}

/** The open record of a connection: newest row for (device, conn_id) not yet closed. */
function openConn(db: Database, deviceId: string, connId: number): ConnAuditRow | null {
  return db
    .query<ConnAuditRow, [string, number]>(
      `SELECT * FROM audit_conn WHERE device_id = ? AND conn_id = ? AND closed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(deviceId, connId);
}

export interface ConnRecord {
  action?: string;
  ip?: string;
  conn_audit_ref?: string;
  peer?: unknown;
  type?: number;
  primary_auth?: number;
  two_factor?: number;
  note?: string;
}

/**
 * Stores one of the three conn record shapes: `action:"new"`, the login record
 * (no action, has `peer`), or `action:"close"`.
 */
export function recordConn(db: Database, deviceId: string, connId: number, sessionId: string, rec: ConnRecord): void {
  const t = now();
  if (rec.action === "new") {
    db.query(
      `INSERT INTO audit_conn (guid, device_id, conn_id, session_id, ip, conn_audit_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newGuid(), deviceId, connId, sessionId, rec.ip ?? "", rec.conn_audit_ref ?? "", t);
    return;
  }
  const open = openConn(db, deviceId, connId);
  if (rec.action === "close") {
    if (open) db.query("UPDATE audit_conn SET closed_at = ? WHERE guid = ?").run(t, open.guid);
    return;
  }
  const peer = Array.isArray(rec.peer) ? rec.peer : [];
  const peerId = typeof peer[0] === "string" ? peer[0] : "";
  const peerName = typeof peer[1] === "string" ? peer[1] : "";
  const intOrNull = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  if (open) {
    db.query(
      `UPDATE audit_conn SET session_id = ?, peer_id = ?, peer_name = ?, conn_type = ?, primary_auth = ?,
         two_factor = ?, authorized_at = ? WHERE guid = ?`,
    ).run(sessionId, peerId, peerName, intOrNull(rec.type), intOrNull(rec.primary_auth), intOrNull(rec.two_factor), t, open.guid);
  } else {
    // The "new" record was lost (e.g. the API was down); keep the login anyway.
    db.query(
      `INSERT INTO audit_conn (guid, device_id, conn_id, session_id, peer_id, peer_name, conn_type, primary_auth,
         two_factor, created_at, authorized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newGuid(), deviceId, connId, sessionId, peerId, peerName, intOrNull(rec.type), intOrNull(rec.primary_auth), intOrNull(rec.two_factor), t, t);
  }
}

/** Guid of the audit row for a session the controller just opened (client-api-spec 5.4). */
export function findConnGuid(db: Database, deviceId: string, sessionId: string, connType: number | null): string | null {
  const row =
    connType === null
      ? db
          .query<{ guid: string }, [string, string]>(
            "SELECT guid FROM audit_conn WHERE device_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(deviceId, sessionId)
      : db
          .query<{ guid: string }, [string, string, number]>(
            `SELECT guid FROM audit_conn WHERE device_id = ? AND session_id = ? AND conn_type = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(deviceId, sessionId, connType);
  return row?.guid ?? null;
}

export function setConnNoteByGuid(db: Database, guid: string, note: string): boolean {
  return db.query("UPDATE audit_conn SET note = ? WHERE guid = ?").run(note, guid).changes > 0;
}

export function setConnNoteBySession(db: Database, deviceId: string, sessionId: string, note: string): boolean {
  const guid = findConnGuid(db, deviceId, sessionId, null);
  return guid ? setConnNoteByGuid(db, guid, note) : false;
}

export interface FileRecord {
  peer_id?: string;
  conn_id?: number;
  type?: number;
  path?: string;
  is_file?: boolean;
  info?: string;
}

export function recordFile(db: Database, deviceId: string, rec: FileRecord): void {
  db.query(
    `INSERT INTO audit_file (device_id, peer_id, conn_id, type, path, is_file, info, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deviceId,
    rec.peer_id ?? "",
    rec.conn_id ?? 0,
    rec.type ?? 0,
    rec.path ?? "",
    rec.is_file ? 1 : 0,
    // `info` arrives as a JSON-encoded string; store it as parsed JSON text.
    JSON.stringify(parseJson(rec.info, {})),
    now(),
  );
}

export interface AlarmRecord {
  typ?: number;
  info?: string;
  conn_id?: number;
  conn_audit_ref?: string;
}

export function recordAlarm(db: Database, deviceId: string, rec: AlarmRecord): void {
  db.query(
    `INSERT INTO audit_alarm (device_id, typ, info, conn_id, conn_audit_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(deviceId, rec.typ ?? 0, JSON.stringify(parseJson(rec.info, {})), rec.conn_id ?? 0, rec.conn_audit_ref ?? "", now());
}

/** Alarm types (client-api-spec 5.3). */
export const ALARM_TYPES: Readonly<Record<number, string>> = {
  0: "IP not in whitelist",
  1: "More than 30 failed login attempts",
  2: "More than 6 failed attempts within a minute",
  6: "Too many attempts from an IPv6 prefix",
  7: "OS-credential login back-off",
  8: "OS-credential login concurrency gate",
  9: "Session scope violation",
  10: "ID not in ID whitelist",
};

export interface Page<T> {
  total: number;
  data: T[];
}

export function listConnAudits(db: Database, limit: number, offset: number, deviceId?: string): Page<ConnAuditRow> {
  const where = deviceId ? "WHERE device_id = ?" : "";
  const args: Array<string | number> = deviceId ? [deviceId] : [];
  const total = db.query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM audit_conn ${where}`).get(...args)?.n ?? 0;
  const data = db
    .query<ConnAuditRow, Array<string | number>>(`SELECT * FROM audit_conn ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  return { total, data };
}

export function listFileAudits(db: Database, limit: number, offset: number): Page<Record<string, unknown>> {
  const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_file").get()?.n ?? 0;
  const data = db
    .query<Record<string, unknown> & { info: string }, [number, number]>("SELECT * FROM audit_file ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset)
    .map((r) => ({ ...r, info: parseJson(r.info, {}) }));
  return { total, data };
}

export function listAlarmAudits(db: Database, limit: number, offset: number): Page<Record<string, unknown>> {
  const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_alarm").get()?.n ?? 0;
  const data = db
    .query<Record<string, unknown> & { info: string; typ: number }, [number, number]>(
      "SELECT * FROM audit_alarm ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset)
    .map((r) => ({ ...r, info: parseJson(r.info, {}), typ_name: ALARM_TYPES[r.typ] ?? `type ${r.typ}` }));
  return { total, data };
}
