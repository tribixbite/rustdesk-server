/**
 * Devices (RustDesk peers that talk to this API), device groups, strategies,
 * heartbeats and pending disconnects.
 */
import type { Database } from "bun:sqlite";
import { now, parseJson } from "./store";

/** A device is shown online when its last heartbeat is newer than this. */
export const ONLINE_WINDOW_SECONDS = 60;

export interface DeviceRow {
  id: string;
  uuid: string;
  user_id: number | null;
  device_group_id: number | null;
  strategy_id: number | null;
  note: string;
  device_name: string;
  hostname: string;
  username: string;
  os: string;
  cpu: string;
  memory: string;
  version: string;
  sysinfo: string;
  conns: string;
  sysinfo_requested: number;
  last_online: number;
  created_at: number;
}

export interface StrategyRow {
  id: number;
  name: string;
  note: string;
  config_options: string;
  extra: string;
  modified_at: number;
  created_at: number;
}

export interface DeviceGroupRow {
  id: number;
  name: string;
  note: string;
  strategy_id: number | null;
  created_at: number;
}

export function getDevice(db: Database, id: string): DeviceRow | null {
  return db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(id);
}

/**
 * Looks up a device for an unauthenticated client request and binds its uuid on
 * first contact. Heartbeat, sysinfo and audit requests carry only `id` and
 * `uuid`; once bound, a request with a different uuid for the same id is
 * rejected, so another machine cannot report under that id. An administrator
 * can clear the binding from the console.
 *
 * Returns null when the uuid does not match.
 */
export function touchDevice(db: Database, id: string, uuid: string): DeviceRow | null {
  const existing = getDevice(db, id);
  if (!existing) {
    return db
      .query<DeviceRow, [string, string, number]>(
        "INSERT INTO devices (id, uuid, created_at) VALUES (?, ?, ?) RETURNING *",
      )
      .get(id, uuid, now());
  }
  if (existing.uuid === "") {
    db.query("UPDATE devices SET uuid = ? WHERE id = ?").run(uuid, id);
    return { ...existing, uuid };
  }
  return existing.uuid === uuid ? existing : null;
}

/** Fields of POST /api/sysinfo that are stored in their own columns. */
export interface SysinfoBody {
  cpu?: string;
  memory?: string;
  os?: string;
  hostname?: string;
  username?: string;
  version?: string;
  [key: string]: unknown;
}

export function saveSysinfo(db: Database, id: string, body: SysinfoBody): void {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  db.query(
    `UPDATE devices SET cpu = ?, memory = ?, os = ?, hostname = ?, username = ?, version = ?,
       sysinfo = ?, sysinfo_requested = 0, last_online = ? WHERE id = ?`,
  ).run(
    str(body.cpu),
    str(body.memory),
    str(body.os),
    str(body.hostname),
    str(body.username),
    str(body.version),
    JSON.stringify(body),
    now(),
    id,
  );
}

/** The heartbeat reply (client-api-spec 4.2). Empty object when nothing is pending. */
export interface HeartbeatReply {
  sysinfo?: number;
  disconnect?: number[];
  strategy?: { config_options: Record<string, string>; extra: Record<string, string> };
  modified_at?: number;
}

/**
 * Records a heartbeat and builds the reply: pending disconnects, a sysinfo
 * request, and the device's effective strategy when the client's
 * `modified_at` differs from it.
 */
export function heartbeat(db: Database, device: DeviceRow, conns: number[], clientModifiedAt: number): HeartbeatReply {
  const reply: HeartbeatReply = {};
  db.transaction(() => {
    db.query("UPDATE devices SET last_online = ?, conns = ? WHERE id = ?").run(now(), JSON.stringify(conns), device.id);
    const pending = db
      .query<{ conn_id: number }, [string]>("SELECT conn_id FROM pending_disconnects WHERE device_id = ?")
      .all(device.id)
      .map((r) => r.conn_id);
    db.query("DELETE FROM pending_disconnects WHERE device_id = ?").run(device.id);
    // Only connections that are still alive are worth closing.
    const live = pending.filter((c) => conns.includes(c));
    if (live.length > 0) reply.disconnect = live;
  })();
  if (device.sysinfo_requested === 1 || device.hostname === "") reply.sysinfo = 1;
  const strategy = effectiveStrategy(db, device);
  if (strategy && strategy.modified_at !== clientModifiedAt) {
    reply.strategy = {
      config_options: parseJson<Record<string, string>>(strategy.config_options, {}),
      extra: parseJson<Record<string, string>>(strategy.extra, {}),
    };
    reply.modified_at = strategy.modified_at;
  }
  return reply;
}

/** Strategy precedence: the device's own, then its owner's, then its device group's. */
export function effectiveStrategy(db: Database, device: DeviceRow): StrategyRow | null {
  const byId = (id: number | null) =>
    id === null ? null : db.query<StrategyRow, [number]>("SELECT * FROM strategies WHERE id = ?").get(id);
  const own = byId(device.strategy_id);
  if (own) return own;
  if (device.user_id !== null) {
    const user = db.query<{ strategy_id: number | null }, [number]>("SELECT strategy_id FROM users WHERE id = ?").get(device.user_id);
    const viaUser = byId(user?.strategy_id ?? null);
    if (viaUser) return viaUser;
  }
  if (device.device_group_id !== null) {
    const group = db
      .query<{ strategy_id: number | null }, [number]>("SELECT strategy_id FROM device_groups WHERE id = ?")
      .get(device.device_group_id);
    return byId(group?.strategy_id ?? null);
  }
  return null;
}

export function requestDisconnect(db: Database, deviceId: string, connId: number): void {
  db.query("INSERT OR IGNORE INTO pending_disconnects (device_id, conn_id, created_at) VALUES (?, ?, ?)").run(deviceId, connId, now());
}

export function isOnline(d: Pick<DeviceRow, "last_online">, at = now()): boolean {
  return at - d.last_online < ONLINE_WINDOW_SECONDS;
}

/** Associates a device with the user who logged in on it. */
export function setDeviceOwner(db: Database, deviceId: string, userId: number): void {
  db.query(
    `INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id`,
  ).run(deviceId, userId, now());
}

export interface DevicePatch {
  userId?: number | null;
  deviceGroupId?: number | null;
  strategyId?: number | null;
  note?: string;
  deviceName?: string;
  username?: string;
  clearUuid?: boolean;
  requestSysinfo?: boolean;
}

export function updateDevice(db: Database, id: string, p: DevicePatch): DeviceRow | null {
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (p.userId !== undefined) set("user_id", p.userId);
  if (p.deviceGroupId !== undefined) set("device_group_id", p.deviceGroupId);
  if (p.strategyId !== undefined) set("strategy_id", p.strategyId);
  if (p.note !== undefined) set("note", p.note);
  if (p.deviceName !== undefined) set("device_name", p.deviceName);
  if (p.username !== undefined) set("username", p.username);
  if (p.clearUuid) set("uuid", "");
  if (p.requestSysinfo) set("sysinfo_requested", 1);
  if (sets.length > 0) {
    args.push(id);
    db.query(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }
  return getDevice(db, id);
}

export function deleteDevice(db: Database, id: string): void {
  db.query("DELETE FROM devices WHERE id = ?").run(id);
  db.query("DELETE FROM pending_disconnects WHERE device_id = ?").run(id);
}

/** Devices a user may see in "Accessible devices": admins see all; others their own and their groups'. */
export function accessibleDevices(db: Database, userId: number, isAdmin: boolean): DeviceRow[] {
  if (isAdmin) return db.query<DeviceRow, []>("SELECT * FROM devices ORDER BY id").all();
  return db
    .query<DeviceRow, [number, number]>(
      `SELECT d.* FROM devices d
       WHERE d.user_id = ?
          OR d.device_group_id IN (SELECT device_group_id FROM device_group_access WHERE user_id = ?)
       ORDER BY d.id`,
    )
    .all(userId, userId);
}

export function listDevices(db: Database): DeviceRow[] {
  return db.query<DeviceRow, []>("SELECT * FROM devices ORDER BY last_online DESC, id").all();
}

// ---- device groups ----

export function listDeviceGroups(db: Database): DeviceGroupRow[] {
  return db.query<DeviceGroupRow, []>("SELECT * FROM device_groups ORDER BY name").all();
}

export function accessibleDeviceGroups(db: Database, userId: number, isAdmin: boolean): DeviceGroupRow[] {
  if (isAdmin) return listDeviceGroups(db);
  return db
    .query<DeviceGroupRow, [number]>(
      `SELECT g.* FROM device_groups g JOIN device_group_access a ON a.device_group_id = g.id
       WHERE a.user_id = ? ORDER BY g.name`,
    )
    .all(userId);
}

export function getDeviceGroupByName(db: Database, name: string): DeviceGroupRow | null {
  return db.query<DeviceGroupRow, [string]>("SELECT * FROM device_groups WHERE name = ?").get(name);
}

export function createDeviceGroup(db: Database, name: string, note = ""): DeviceGroupRow {
  const row = db
    .query<DeviceGroupRow, [string, string, number]>(
      "INSERT INTO device_groups (name, note, created_at) VALUES (?, ?, ?) RETURNING *",
    )
    .get(name, note, now());
  if (!row) throw new Error("insert returned no row");
  return row;
}

export function updateDeviceGroup(
  db: Database,
  id: number,
  p: { name?: string; note?: string; strategyId?: number | null; userIds?: number[] },
): void {
  db.transaction(() => {
    if (p.name !== undefined) db.query("UPDATE device_groups SET name = ? WHERE id = ?").run(p.name, id);
    if (p.note !== undefined) db.query("UPDATE device_groups SET note = ? WHERE id = ?").run(p.note, id);
    if (p.strategyId !== undefined) db.query("UPDATE device_groups SET strategy_id = ? WHERE id = ?").run(p.strategyId, id);
    if (p.userIds !== undefined) {
      db.query("DELETE FROM device_group_access WHERE device_group_id = ?").run(id);
      const ins = db.query("INSERT INTO device_group_access (device_group_id, user_id) VALUES (?, ?)");
      for (const u of p.userIds) ins.run(id, u);
    }
  })();
}

export function deviceGroupUserIds(db: Database, id: number): number[] {
  return db
    .query<{ user_id: number }, [number]>("SELECT user_id FROM device_group_access WHERE device_group_id = ?")
    .all(id)
    .map((r) => r.user_id);
}

export function deleteDeviceGroup(db: Database, id: number): void {
  db.query("DELETE FROM device_groups WHERE id = ?").run(id);
}

// ---- strategies ----

/** Options a strategy may not set: the client drops these (client-api-spec 4.4). */
export const STRATEGY_REJECTED_KEYS: ReadonlySet<string> = new Set([
  "custom-rendezvous-server",
  "rendezvous-servers",
  "api-server",
  "relay-server",
  "key",
  "ice-servers",
  "allow-insecure-tls-fallback",
  "allow-websocket",
  "websocket-port",
  "2fa",
  "bot",
  "preset-address-book-password",
  "enable-trusted-devices",
  "trusted-device-expiration-days",
  "preset-address-book-name",
  "preset-address-book-tag",
  "preset-address-book-alias",
  "preset-address-book-note",
  "preset-device-name",
  "preset-device-username",
  "preset-note",
  "windows-service-video-save-directory",
  "stop-service",
  "reg_recovery",
]);

export function listStrategies(db: Database): StrategyRow[] {
  return db.query<StrategyRow, []>("SELECT * FROM strategies ORDER BY name").all();
}

export function getStrategyByName(db: Database, name: string): StrategyRow | null {
  return db.query<StrategyRow, [string]>("SELECT * FROM strategies WHERE name = ?").get(name);
}

/**
 * A new `modified_at` for a strategy edit. Clients compare it for equality, so it
 * only has to differ from every value handed out before; milliseconds plus a
 * monotonic bump makes two edits in the same millisecond distinct.
 */
function nextModifiedAt(db: Database): number {
  const max = db.query<{ m: number | null }, []>("SELECT MAX(modified_at) AS m FROM strategies").get()?.m ?? 0;
  return Math.max(Date.now(), max + 1);
}

function cleanOptions(options: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    if (!STRATEGY_REJECTED_KEYS.has(k)) out[k] = String(v);
  }
  return out;
}

export function createStrategy(db: Database, name: string, options: Record<string, string>, note = ""): StrategyRow {
  const row = db
    .query<StrategyRow, [string, string, string, number, number]>(
      "INSERT INTO strategies (name, note, config_options, modified_at, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(name, note, JSON.stringify(cleanOptions(options)), nextModifiedAt(db), now());
  if (!row) throw new Error("insert returned no row");
  return row;
}

export function updateStrategy(
  db: Database,
  id: number,
  p: { name?: string; note?: string; options?: Record<string, string> },
): void {
  db.transaction(() => {
    if (p.name !== undefined) db.query("UPDATE strategies SET name = ? WHERE id = ?").run(p.name, id);
    if (p.note !== undefined) db.query("UPDATE strategies SET note = ? WHERE id = ?").run(p.note, id);
    if (p.options !== undefined) {
      db.query("UPDATE strategies SET config_options = ?, modified_at = ? WHERE id = ?").run(
        JSON.stringify(cleanOptions(p.options)),
        nextModifiedAt(db),
        id,
      );
    }
  })();
}

export function deleteStrategy(db: Database, id: number): void {
  db.query("DELETE FROM strategies WHERE id = ?").run(id);
}
