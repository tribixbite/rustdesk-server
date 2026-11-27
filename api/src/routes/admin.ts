/**
 * Web-console API (`/api/admin/*` for administrators, `/api/me/*` for any user).
 * Not called by the RustDesk client.
 */
import { z } from "@hono/zod-openapi";
import { now, parseJson } from "../store";
import { newTotpSecret, totpUri, verifyPassword, verifyTotp } from "../security";
import {
  createUser,
  deleteUser,
  getUserByGuid,
  issueToken,
  listTokens,
  listUsers,
  revokeTokenHash,
  setTotpSecret,
  updateUser,
  UserError,
  type UserRow,
} from "../users";
import {
  createDeviceGroup,
  createStrategy,
  deleteDevice,
  deleteDeviceGroup,
  deleteStrategy,
  deviceGroupUserIds,
  effectiveStrategy,
  getDevice,
  isOnline,
  listDeviceGroups,
  listDevices,
  listStrategies,
  requestDisconnect,
  STRATEGY_REJECTED_KEYS,
  updateDevice,
  updateDeviceGroup,
  updateStrategy,
} from "../devices";
import {
  AbError,
  bookRules,
  createSharedBook,
  deleteBook,
  getBook,
  listPeers,
  listSharedBooks,
  updateSharedBook,
  type AbRule,
} from "../addressbook";
import { listAlarmAudits, listConnAudits, listFileAudits } from "../audit";
import { getSettings, setSettings } from "../settings";
import { STRATEGY_OPTIONS } from "../strategy-options";
import { deps, emptyOk, HttpError, pageQuery, readJson, requireAdmin, requireAuth, route, type App, type AppContext } from "../http";

const Ok = z.object({ ok: z.literal(true) });

/** The console's view of a user. */
function adminUser(u: UserRow) {
  return {
    guid: u.guid,
    name: u.name,
    display_name: u.display_name,
    email: u.email,
    note: u.note,
    is_admin: u.is_admin === 1,
    status: u.status,
    totp_enabled: u.totp_secret !== null,
    strategy_id: u.strategy_id,
    created_at: u.created_at,
  };
}

const AdminUserSchema = z
  .object({
    guid: z.string(),
    name: z.string(),
    display_name: z.string(),
    email: z.string(),
    note: z.string(),
    is_admin: z.boolean(),
    status: z.number().int(),
    totp_enabled: z.boolean(),
    strategy_id: z.number().int().nullable(),
    created_at: z.number().int(),
  })
  .openapi("AdminUser");

const Status = z.union([z.literal(1), z.literal(0), z.literal(-1)]);

const UserCreate = z.object({
  name: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
  display_name: z.string().optional(),
  email: z.string().optional(),
  note: z.string().optional(),
  is_admin: z.boolean().optional(),
});

const UserPatch = z.object({
  display_name: z.string().optional(),
  email: z.string().optional(),
  note: z.string().optional(),
  is_admin: z.boolean().optional(),
  status: Status.optional(),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  strategy_id: z.number().int().nullable().optional(),
});

const DevicePatch = z.object({
  user_guid: z.string().nullable().optional(),
  device_group_id: z.number().int().nullable().optional(),
  strategy_id: z.number().int().nullable().optional(),
  note: z.string().optional(),
  device_name: z.string().optional(),
  clear_uuid: z.boolean().optional().describe("forget the bound machine uuid (after a reinstall)"),
  request_sysinfo: z.boolean().optional(),
});

const GroupBody = z.object({
  name: z.string().min(1).optional(),
  note: z.string().optional(),
  strategy_id: z.number().int().nullable().optional(),
  user_guids: z.array(z.string()).optional().describe("users who may see this group's devices"),
});

const StrategyBody = z.object({
  name: z.string().min(1).optional(),
  note: z.string().optional(),
  options: z.record(z.string(), z.string()).optional(),
});

const BookBody = z.object({
  name: z.string().min(1).optional(),
  note: z.string().optional(),
  password: z.string().optional().describe("default shared password for new peers; empty clears it"),
  rules: z
    .array(z.object({ user_guid: z.string(), rule: z.union([z.literal(1), z.literal(2), z.literal(3)]) }))
    .optional(),
});

function userIdForGuid(c: AppContext, guid: string): number {
  const u = getUserByGuid(deps(c).db, guid);
  if (!u) throw new HttpError(404, `User not found: ${guid}`);
  return u.id;
}

function intParam(c: AppContext, name: string): number {
  const n = Number.parseInt(c.req.param(name) ?? "", 10);
  if (!Number.isFinite(n)) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

/** Maps a SQLite UNIQUE violation to a 409 with a readable message. */
function unique<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint/.test(e.message)) throw new HttpError(409, `${what} already exists`);
    throw e;
  }
}

/** The server-config string RustDesk clients import ("Import server config" / QR `config=`). */
export function clientConfigString(host: string, relay: string, api: string, key: string): string {
  // Dart's base64UrlEncode keeps the "=" padding, which Node's "base64url" drops.
  const b64 = Buffer.from(JSON.stringify({ host, relay, api, key }), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return b64.split("").reverse().join("");
}

export function registerAdminRoutes(app: App): void {
  const t = { users: ["Console: users"], devices: ["Console: devices"], books: ["Console: address books"], audit: ["Console: audit"], server: ["Console: server"], me: ["Console: my account"] };

  // ---- server overview ----

  route(
    app,
    { method: "get", path: "/api/admin/overview", tags: t.server, summary: "Counts, server details and the client config string", auth: true },
    (c) => {
      requireAdmin(c);
      const { db, config } = deps(c);
      const devices = listDevices(db);
      const at = now();
      const count = (sql: string) => db.query<{ n: number }, [number]>(sql).get(at - 86400)?.n ?? 0;
      const api = config.publicUrl;
      return c.json({
        users: listUsers(db).length,
        devices: devices.length,
        online: devices.filter((d) => isOnline(d, at)).length,
        shared_books: listSharedBooks(db).length,
        connections_24h: count("SELECT COUNT(*) AS n FROM audit_conn WHERE created_at >= ?"),
        alarms_24h: count("SELECT COUNT(*) AS n FROM audit_alarm WHERE created_at >= ?"),
        server: {
          id_server: config.rendezvousServer,
          relay_server: config.relayServer,
          api_server: api,
          key: config.serverKey,
          config_string: clientConfigString(config.rendezvousServer, config.relayServer, api, config.serverKey),
          oidc_providers: config.oidcProviders.map((p) => p.name),
        },
      });
    },
  );

  // ---- users ----

  route(app, { method: "get", path: "/api/admin/users", tags: t.users, summary: "All users", auth: true, response: z.array(AdminUserSchema) }, (c) => {
    requireAdmin(c);
    return c.json(listUsers(deps(c).db).map(adminUser));
  });

  route(app, { method: "post", path: "/api/admin/users", tags: t.users, summary: "Create a user", auth: true, body: UserCreate, response: AdminUserSchema }, async (c) => {
    requireAdmin(c);
    const b = await readJson(c, UserCreate);
    try {
      const u = await createUser(deps(c).db, {
        name: b.name.trim(),
        password: b.password,
        displayName: b.display_name,
        email: b.email,
        note: b.note,
        isAdmin: b.is_admin,
      });
      return c.json(adminUser(u));
    } catch (e) {
      if (e instanceof UserError) throw new HttpError(409, e.message);
      throw e;
    }
  });

  route(
    app,
    { method: "patch", path: "/api/admin/users/{guid}", tags: t.users, summary: "Update a user", auth: true, params: z.object({ guid: z.string() }), body: UserPatch, response: AdminUserSchema },
    async (c) => {
      const me = requireAdmin(c);
      const b = await readJson(c, UserPatch);
      const id = userIdForGuid(c, c.req.param("guid") ?? "");
      if (id === me.user.id && (b.is_admin === false || b.status === 0)) throw new HttpError(400, "You cannot demote or disable yourself");
      const u = await updateUser(deps(c).db, id, {
        displayName: b.display_name,
        email: b.email,
        note: b.note,
        isAdmin: b.is_admin,
        status: b.status,
        password: b.password,
        strategyId: b.strategy_id,
      });
      if (!u) throw new HttpError(404, "User not found");
      return c.json(adminUser(u));
    },
  );

  route(
    app,
    { method: "post", path: "/api/admin/users/{guid}/reset-totp", tags: t.users, summary: "Turn off a user's two-factor login", auth: true, params: z.object({ guid: z.string() }), response: Ok },
    (c) => {
      requireAdmin(c);
      setTotpSecret(deps(c).db, userIdForGuid(c, c.req.param("guid") ?? ""), null);
      return c.json({ ok: true as const });
    },
  );

  route(
    app,
    { method: "delete", path: "/api/admin/users/{guid}", tags: t.users, summary: "Delete a user, their personal address book and sessions", auth: true, params: z.object({ guid: z.string() }), response: Ok },
    (c) => {
      const me = requireAdmin(c);
      const id = userIdForGuid(c, c.req.param("guid") ?? "");
      if (id === me.user.id) throw new HttpError(400, "You cannot delete yourself");
      deleteUser(deps(c).db, id);
      return c.json({ ok: true as const });
    },
  );

  // ---- devices ----

  route(app, { method: "get", path: "/api/admin/devices", tags: t.devices, summary: "All devices with status, owner, group and strategy", auth: true }, (c) => {
    requireAdmin(c);
    const { db } = deps(c);
    const users = new Map(listUsers(db).map((u) => [u.id, u]));
    const at = now();
    return c.json(
      listDevices(db).map((d) => ({
        id: d.id,
        uuid_bound: d.uuid !== "",
        owner: d.user_id === null ? null : { guid: users.get(d.user_id)?.guid ?? "", name: users.get(d.user_id)?.name ?? "" },
        device_group_id: d.device_group_id,
        strategy_id: d.strategy_id,
        effective_strategy: effectiveStrategy(db, d)?.name ?? null,
        note: d.note,
        device_name: d.device_name,
        hostname: d.hostname,
        username: d.username,
        os: d.os,
        cpu: d.cpu,
        memory: d.memory,
        version: d.version,
        conns: parseJson<number[]>(d.conns, []),
        online: isOnline(d, at),
        last_online: d.last_online,
        created_at: d.created_at,
      })),
    );
  });

  route(
    app,
    { method: "patch", path: "/api/admin/devices/{id}", tags: t.devices, summary: "Update a device", auth: true, params: z.object({ id: z.string() }), body: DevicePatch, response: Ok },
    async (c) => {
      requireAdmin(c);
      const { db } = deps(c);
      const id = c.req.param("id") ?? "";
      if (!getDevice(db, id)) throw new HttpError(404, "Device not found");
      const b = await readJson(c, DevicePatch);
      updateDevice(db, id, {
        userId: b.user_guid === undefined ? undefined : b.user_guid === null ? null : userIdForGuid(c, b.user_guid),
        deviceGroupId: b.device_group_id,
        strategyId: b.strategy_id,
        note: b.note,
        deviceName: b.device_name,
        clearUuid: b.clear_uuid,
        requestSysinfo: b.request_sysinfo,
      });
      return c.json({ ok: true as const });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/admin/devices/{id}/disconnect",
      tags: t.devices,
      summary: "Close a live connection on its next heartbeat",
      auth: true,
      params: z.object({ id: z.string() }),
      body: z.object({ conn_id: z.number().int() }),
      response: Ok,
    },
    async (c) => {
      requireAdmin(c);
      const b = await readJson(c, z.object({ conn_id: z.number().int() }));
      requestDisconnect(deps(c).db, c.req.param("id") ?? "", b.conn_id);
      return c.json({ ok: true as const });
    },
  );

  route(
    app,
    { method: "delete", path: "/api/admin/devices/{id}", tags: t.devices, summary: "Forget a device", auth: true, params: z.object({ id: z.string() }), response: Ok },
    (c) => {
      requireAdmin(c);
      deleteDevice(deps(c).db, c.req.param("id") ?? "");
      return c.json({ ok: true as const });
    },
  );

  // ---- device groups ----

  route(app, { method: "get", path: "/api/admin/device-groups", tags: t.devices, summary: "Device groups with their users", auth: true }, (c) => {
    requireAdmin(c);
    const { db } = deps(c);
    const users = new Map(listUsers(db).map((u) => [u.id, u.guid]));
    return c.json(
      listDeviceGroups(db).map((g) => ({ ...g, user_guids: deviceGroupUserIds(db, g.id).map((id) => users.get(id) ?? "") })),
    );
  });

  route(app, { method: "post", path: "/api/admin/device-groups", tags: t.devices, summary: "Create a device group", auth: true, body: GroupBody }, async (c) => {
    requireAdmin(c);
    const b = await readJson(c, GroupBody);
    if (!b.name) throw new HttpError(400, "name is required");
    const { db } = deps(c);
    const g = unique("Device group", () => createDeviceGroup(db, b.name ?? "", b.note ?? ""));
    updateDeviceGroup(db, g.id, { strategyId: b.strategy_id, userIds: b.user_guids?.map((x) => userIdForGuid(c, x)) });
    return c.json({ id: g.id });
  });

  route(
    app,
    { method: "patch", path: "/api/admin/device-groups/{id}", tags: t.devices, summary: "Update a device group", auth: true, params: z.object({ id: z.string() }), body: GroupBody, response: Ok },
    async (c) => {
      requireAdmin(c);
      const b = await readJson(c, GroupBody);
      const id = intParam(c, "id");
      unique("Device group", () =>
        updateDeviceGroup(deps(c).db, id, { name: b.name, note: b.note, strategyId: b.strategy_id, userIds: b.user_guids?.map((x) => userIdForGuid(c, x)) }),
      );
      return c.json({ ok: true as const });
    },
  );

  route(
    app,
    { method: "delete", path: "/api/admin/device-groups/{id}", tags: t.devices, summary: "Delete a device group", auth: true, params: z.object({ id: z.string() }), response: Ok },
    (c) => {
      requireAdmin(c);
      deleteDeviceGroup(deps(c).db, intParam(c, "id"));
      return c.json({ ok: true as const });
    },
  );

  // ---- strategies ----

  route(app, { method: "get", path: "/api/admin/strategies", tags: t.devices, summary: "Strategies (client settings pushed by heartbeat)", auth: true }, (c) => {
    requireAdmin(c);
    return c.json(listStrategies(deps(c).db).map((s) => ({ ...s, config_options: parseJson(s.config_options, {}), extra: parseJson(s.extra, {}) })));
  });

  route(app, { method: "get", path: "/api/admin/strategy-options", tags: t.devices, summary: "Known client options for the strategy editor", auth: true }, (c) => {
    requireAdmin(c);
    return c.json({ options: STRATEGY_OPTIONS, rejected: [...STRATEGY_REJECTED_KEYS] });
  });

  route(app, { method: "post", path: "/api/admin/strategies", tags: t.devices, summary: "Create a strategy", auth: true, body: StrategyBody }, async (c) => {
    requireAdmin(c);
    const b = await readJson(c, StrategyBody);
    if (!b.name) throw new HttpError(400, "name is required");
    const s = unique("Strategy", () => createStrategy(deps(c).db, b.name ?? "", b.options ?? {}, b.note ?? ""));
    return c.json({ id: s.id });
  });

  route(
    app,
    { method: "patch", path: "/api/admin/strategies/{id}", tags: t.devices, summary: "Update a strategy (clients pick it up on their next heartbeat)", auth: true, params: z.object({ id: z.string() }), body: StrategyBody, response: Ok },
    async (c) => {
      requireAdmin(c);
      const b = await readJson(c, StrategyBody);
      const id = intParam(c, "id");
      unique("Strategy", () => updateStrategy(deps(c).db, id, { name: b.name, note: b.note, options: b.options }));
      return c.json({ ok: true as const });
    },
  );

  route(
    app,
    { method: "delete", path: "/api/admin/strategies/{id}", tags: t.devices, summary: "Delete a strategy", auth: true, params: z.object({ id: z.string() }), response: Ok },
    (c) => {
      requireAdmin(c);
      deleteStrategy(deps(c).db, intParam(c, "id"));
      return c.json({ ok: true as const });
    },
  );

  // ---- shared address books ----

  route(app, { method: "get", path: "/api/admin/address-books", tags: t.books, summary: "Shared address books with their rules", auth: true }, (c) => {
    requireAdmin(c);
    const { db } = deps(c);
    const users = new Map(listUsers(db).map((u) => [u.id, u.guid]));
    return c.json(
      listSharedBooks(db).map((b) => ({
        guid: b.guid,
        name: b.name,
        note: b.note,
        owner: b.owner_name,
        peers: b.peers,
        has_password: Boolean(parseJson<{ password?: string }>(b.info, {}).password),
        rules: bookRules(db, b.guid).map((r) => ({ user_guid: users.get(r.user_id) ?? "", rule: r.rule })),
        updated_at: b.updated_at,
      })),
    );
  });

  route(app, { method: "post", path: "/api/admin/address-books", tags: t.books, summary: "Create a shared address book", auth: true, body: BookBody }, async (c) => {
    const me = requireAdmin(c);
    const b = await readJson(c, BookBody);
    const { db } = deps(c);
    try {
      const book = createSharedBook(db, me.user.id, b.name ?? "", b.note ?? "", b.password ?? "");
      if (b.rules) updateSharedBook(db, book.guid, { rules: b.rules.map((r) => ({ userId: userIdForGuid(c, r.user_guid), rule: r.rule as AbRule })) });
      return c.json({ guid: book.guid });
    } catch (e) {
      if (e instanceof AbError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  route(
    app,
    { method: "patch", path: "/api/admin/address-books/{guid}", tags: t.books, summary: "Rename, re-note, set the shared password or the sharing rules", auth: true, params: z.object({ guid: z.string() }), body: BookBody, response: Ok },
    async (c) => {
      requireAdmin(c);
      const b = await readJson(c, BookBody);
      const guid = c.req.param("guid") ?? "";
      const book = getBook(deps(c).db, guid);
      if (!book || book.personal === 1) throw new HttpError(404, "Address book not found");
      updateSharedBook(deps(c).db, guid, {
        name: b.name,
        note: b.note,
        password: b.password,
        rules: b.rules?.map((r) => ({ userId: userIdForGuid(c, r.user_guid), rule: r.rule as AbRule })),
      });
      return c.json({ ok: true as const });
    },
  );

  route(
    app,
    { method: "get", path: "/api/admin/address-books/{guid}/peers", tags: t.books, summary: "Peers of a shared address book", auth: true, params: z.object({ guid: z.string() }) },
    (c) => {
      requireAdmin(c);
      const guid = c.req.param("guid") ?? "";
      const book = getBook(deps(c).db, guid);
      if (!book || book.personal === 1) throw new HttpError(404, "Address book not found");
      // Shared passwords stay out of the console listing.
      return c.json(listPeers(deps(c).db, guid).map(({ password, hash, ...p }) => ({ ...p, has_password: Boolean(password) })));
    },
  );

  route(
    app,
    { method: "delete", path: "/api/admin/address-books/{guid}", tags: t.books, summary: "Delete a shared address book", auth: true, params: z.object({ guid: z.string() }), response: Ok },
    (c) => {
      requireAdmin(c);
      deleteBook(deps(c).db, c.req.param("guid") ?? "");
      return c.json({ ok: true as const });
    },
  );

  // ---- audit ----

  const auditQuery = z.object({ current: z.string().optional(), pageSize: z.string().optional(), device_id: z.string().optional() });
  route(app, { method: "get", path: "/api/admin/audit/conn", tags: t.audit, summary: "Connection log", auth: true, query: auditQuery }, (c) => {
    requireAdmin(c);
    const q = pageQuery(c, 50, 500);
    return c.json(listConnAudits(deps(c).db, q.limit, q.offset, c.req.query("device_id") || undefined));
  });
  route(app, { method: "get", path: "/api/admin/audit/file", tags: t.audit, summary: "File-transfer log", auth: true, query: auditQuery }, (c) => {
    requireAdmin(c);
    const q = pageQuery(c, 50, 500);
    return c.json(listFileAudits(deps(c).db, q.limit, q.offset));
  });
  route(app, { method: "get", path: "/api/admin/audit/alarm", tags: t.audit, summary: "Security alarms", auth: true, query: auditQuery }, (c) => {
    requireAdmin(c);
    const q = pageQuery(c, 50, 500);
    return c.json(listAlarmAudits(deps(c).db, q.limit, q.offset));
  });

  // ---- tokens and sessions ----

  route(app, { method: "get", path: "/api/admin/tokens", tags: t.server, summary: "Sessions and API tokens of all users", auth: true }, (c) => {
    requireAdmin(c);
    const { db } = deps(c);
    const users = new Map(listUsers(db).map((u) => [u.id, u.name]));
    return c.json(listTokens(db, null, ["client", "console", "api"]).map((x) => ({ ...x, user: users.get(x.user_id) ?? "" })));
  });

  route(
    app,
    {
      method: "post",
      path: "/api/admin/tokens",
      tags: t.server,
      summary: "Create an API token for `rustdesk --assign` (shown once)",
      auth: true,
      body: z.object({ label: z.string().min(1) }),
      response: z.object({ token: z.string() }),
    },
    async (c) => {
      const me = requireAdmin(c);
      const b = await readJson(c, z.object({ label: z.string().min(1) }));
      return c.json({ token: issueToken(deps(c).db, me.user.id, { kind: "api", ttlSeconds: null, label: b.label }) });
    },
  );

  route(
    app,
    { method: "delete", path: "/api/admin/tokens/{hash}", tags: t.server, summary: "Revoke a session or API token", auth: true, params: z.object({ hash: z.string() }), response: Ok },
    (c) => {
      requireAdmin(c);
      revokeTokenHash(deps(c).db, c.req.param("hash") ?? "");
      return c.json({ ok: true as const });
    },
  );

  // ---- settings ----

  const SettingsSchema = z.object({ max_peer_one_ab: z.number().int().min(0), audit_retention_days: z.number().int().min(0) });
  route(app, { method: "get", path: "/api/admin/settings", tags: t.server, summary: "Server settings", auth: true, response: SettingsSchema }, (c) => {
    requireAdmin(c);
    return c.json(getSettings(deps(c).db));
  });
  route(app, { method: "patch", path: "/api/admin/settings", tags: t.server, summary: "Change server settings", auth: true, body: SettingsSchema.partial(), response: SettingsSchema }, async (c) => {
    requireAdmin(c);
    return c.json(setSettings(deps(c).db, await readJson(c, SettingsSchema.partial())));
  });

  // ---- my account (any user) ----

  route(app, { method: "get", path: "/api/me", tags: t.me, summary: "The signed-in user", auth: true, response: AdminUserSchema }, (c) => {
    return c.json(adminUser(requireAuth(c).user));
  });

  const PasswordBody = z.object({ current: z.string(), new: z.string().min(8, "Password must be at least 8 characters") });
  route(app, { method: "post", path: "/api/me/password", tags: t.me, summary: "Change my password (ends my other sessions)", auth: true, body: PasswordBody }, async (c) => {
    const auth = requireAuth(c);
    const b = await readJson(c, PasswordBody);
    if (!(await verifyPassword(b.current, auth.user.password_hash))) throw new HttpError(400, "Current password is wrong");
    await updateUser(deps(c).db, auth.user.id, { password: b.new });
    // updateUser revoked every session, including this one; hand out a fresh console token.
    return c.json({ access_token: issueToken(deps(c).db, auth.user.id, { kind: "console", ttlSeconds: deps(c).config.tokenTtlSeconds }) });
  });

  route(
    app,
    { method: "post", path: "/api/me/totp/setup", tags: t.me, summary: "A new TOTP secret to enrol (not active until confirmed)", auth: true, response: z.object({ secret: z.string(), uri: z.string() }) },
    (c) => {
      const auth = requireAuth(c);
      const secret = newTotpSecret();
      return c.json({ secret, uri: totpUri("RustDesk", auth.user.name, secret) });
    },
  );

  const TotpEnable = z.object({ secret: z.string(), code: z.string() });
  route(app, { method: "post", path: "/api/me/totp/enable", tags: t.me, summary: "Turn on two-factor login with a code from the new secret", auth: true, body: TotpEnable, response: Ok }, async (c) => {
    const auth = requireAuth(c);
    const b = await readJson(c, TotpEnable);
    if (!verifyTotp(b.secret, b.code)) throw new HttpError(400, "Wrong 2FA Code");
    setTotpSecret(deps(c).db, auth.user.id, b.secret);
    return c.json({ ok: true as const });
  });

  const TotpDisable = z.object({ code: z.string() });
  route(app, { method: "post", path: "/api/me/totp/disable", tags: t.me, summary: "Turn off two-factor login (needs a current code)", auth: true, body: TotpDisable, response: Ok }, async (c) => {
    const auth = requireAuth(c);
    const b = await readJson(c, TotpDisable);
    if (!auth.user.totp_secret || !verifyTotp(auth.user.totp_secret, b.code)) throw new HttpError(400, "Wrong 2FA Code");
    setTotpSecret(deps(c).db, auth.user.id, null);
    return c.json({ ok: true as const });
  });

  route(app, { method: "get", path: "/api/me/sessions", tags: t.me, summary: "My sessions", auth: true }, (c) => {
    const auth = requireAuth(c);
    return c.json(listTokens(deps(c).db, auth.user.id, ["client", "console"]));
  });

  route(app, { method: "post", path: "/api/me/logout-everywhere", tags: t.me, summary: "End all my sessions", auth: true }, (c) => {
    const auth = requireAuth(c);
    deps(c).db.query("DELETE FROM tokens WHERE user_id = ? AND kind IN ('client','console')").run(auth.user.id);
    return emptyOk(c);
  });

}
