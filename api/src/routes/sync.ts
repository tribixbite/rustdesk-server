/**
 * Device-side sync endpoints (client-api-spec sections 3 and 4): heartbeat,
 * sysinfo, switch-grant, and the admin-token deploy/assign helpers.
 */
import { z } from "@hono/zod-openapi";
import { now } from "../store";
import {
  getDeviceGroupByName,
  getStrategyByName,
  heartbeat,
  saveSysinfo,
  touchDevice,
  updateDevice,
} from "../devices";
import { getUserByName } from "../users";
import { addPeer, AbError, personalBook, type AddressBookRow } from "../addressbook";
import { deps, readJson, requireAuth, route, type App, type AppContext } from "../http";

const HeartbeatBody = z
  .object({
    id: z.string(),
    uuid: z.string(),
    ver: z.number().optional(),
    conns: z.array(z.number().int()).optional(),
    modified_at: z.number().optional(),
  })
  .openapi("HeartbeatRequest");

const HeartbeatReply = z
  .object({
    sysinfo: z.number().optional().describe("present: upload sysinfo again"),
    disconnect: z.array(z.number().int()).optional().describe("connection ids to close"),
    strategy: z
      .object({ config_options: z.record(z.string(), z.string()), extra: z.record(z.string(), z.string()) })
      .optional(),
    modified_at: z.number().optional(),
  })
  .openapi("HeartbeatResponse");

const SysinfoBody = z
  .object({
    id: z.string(),
    uuid: z.string(),
    cpu: z.string().optional(),
    memory: z.string().optional(),
    os: z.string().optional(),
    hostname: z.string().optional(),
    username: z.string().optional(),
    version: z.string().optional(),
  })
  .loose()
  .openapi("SysinfoRequest");

const SwitchGrantBody = z.object({
  id: z.string(),
  switch_code_verifier: z.string(),
  timestamp: z.string(),
  signature: z.string(),
});

const DeployBody = z.object({ id: z.string(), uuid: z.string(), pk: z.string() });

const AssignBody = z
  .object({
    id: z.string(),
    uuid: z.string().optional(),
    user_name: z.string().optional(),
    strategy_name: z.string().optional(),
    address_book_name: z.string().optional(),
    address_book_tag: z.string().optional(),
    address_book_alias: z.string().optional(),
    address_book_password: z.string().optional(),
    address_book_note: z.string().optional(),
    device_group_name: z.string().optional(),
    note: z.string().optional(),
    device_username: z.string().optional(),
    device_name: z.string().optional(),
  })
  .openapi("AssignRequest");

/** Accepted clock skew for switch-grant timestamps. */
const SWITCH_GRANT_SKEW = 300;

/** Body text of the sysinfo_ver reply; changes when the server wants sysinfo again. */
const SYSINFO_VER = `rustdesk-api-${Date.now()}`;

export function registerSyncRoutes(app: App): void {
  route(
    app,
    {
      method: "post",
      path: "/api/heartbeat",
      tags: ["Device sync"],
      summary: "Device heartbeat; delivers disconnects, sysinfo requests and strategies",
      description: "Sent every 15 s (3 s while connections are live). Reply `{}` when nothing is pending.",
      body: HeartbeatBody,
      response: HeartbeatReply,
    },
    async (c) => {
      const { db } = deps(c);
      const body = await readJson(c, HeartbeatBody);
      const device = touchDevice(db, body.id, body.uuid);
      // A uuid that does not match the bound device is ignored rather than refused,
      // so the client's loop just carries on.
      if (!device) return c.json({});
      return c.json(heartbeat(db, device, body.conns ?? [], body.modified_at ?? 0));
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/sysinfo",
      tags: ["Device sync"],
      summary: "Upload device information",
      description: "Replies with plain text `SYSINFO_UPDATED`, or `ID_NOT_FOUND` when the uuid does not match the device.",
      body: SysinfoBody,
      response: { text: "SYSINFO_UPDATED or ID_NOT_FOUND" },
    },
    async (c) => {
      const { db } = deps(c);
      const body = await readJson(c, SysinfoBody);
      const device = touchDevice(db, body.id, body.uuid);
      if (!device) return c.text("ID_NOT_FOUND");
      saveSysinfo(db, device.id, body);
      return c.text("SYSINFO_UPDATED");
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/sysinfo_ver",
      tags: ["Device sync"],
      summary: "Cheap check whether sysinfo must be uploaded again",
      response: { text: "An opaque version string" },
    },
    (c) => c.text(SYSINFO_VER),
  );

  route(
    app,
    {
      method: "post",
      path: "/api/switch-grant",
      tags: ["Device sync"],
      summary: "Record a switch-sides grant",
      description:
        "Stores the grant with a timestamp check. The Ed25519 signature is not verified, because device public keys are held by hbbs, not this service, and hbbs does not consult grants.",
      body: SwitchGrantBody,
      response: z.object({ accepted: z.boolean(), server_time: z.number().optional() }),
    },
    async (c) => {
      const { db } = deps(c);
      const body = await readJson(c, SwitchGrantBody);
      const ts = Number.parseInt(body.timestamp, 10);
      const t = now();
      if (!Number.isFinite(ts) || Math.abs(t - ts) > SWITCH_GRANT_SKEW) {
        return c.json({ accepted: false, server_time: t });
      }
      // TODO: verify `signature` once device public keys are available to this service.
      db.query("INSERT OR REPLACE INTO switch_grants (verifier, device_id, timestamp, created_at) VALUES (?, ?, ?, ?)").run(
        body.switch_code_verifier,
        body.id,
        ts,
        t,
      );
      db.query("DELETE FROM switch_grants WHERE created_at < ?").run(t - 3600);
      return c.json({ accepted: true });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/devices/deploy",
      tags: ["Device sync"],
      summary: "Explicit device deployment",
      description:
        'Always `{"result":"NOT_ENABLED"}`: hbbs in this fork does not require deployment, so devices register without it.',
      auth: true,
      body: DeployBody,
      response: z.object({ result: z.enum(["OK", "NOT_ENABLED", "INVALID_INPUT", "ID_TAKEN"]) }),
    },
    (c) => {
      requireAuth(c, ["api"]);
      return c.json({ result: "NOT_ENABLED" });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/devices/cli",
      tags: ["Device sync"],
      summary: "Assign a device to a user, strategy, address book or group (rustdesk --assign)",
      description: "Requires an API token with administrator rights. Empty body on success; otherwise a plain-text error.",
      auth: true,
      body: AssignBody,
    },
    async (c) => {
      const auth = requireAuth(c, ["api"]);
      if (auth.user.is_admin !== 1) return c.text("Admin required!", 403);
      const body = await readJson(c, AssignBody);
      const error = assignDevice(c, body);
      return error ? c.text(error, 400) : c.body(null, 200);
    },
  );
}

/** Applies `rustdesk --assign` fields; returns an error message or null. */
function assignDevice(c: AppContext, body: z.infer<typeof AssignBody>): string | null {
  const { db } = deps(c);
  if (body.uuid && !touchDevice(db, body.id, body.uuid)) return "Device uuid mismatch";
  if (!body.uuid) touchDevice(db, body.id, "");
  let userId: number | undefined;
  if (body.user_name) {
    const user = getUserByName(db, body.user_name);
    if (!user) return `User not found: ${body.user_name}`;
    userId = user.id;
  }
  let strategyId: number | undefined;
  if (body.strategy_name) {
    const s = getStrategyByName(db, body.strategy_name);
    if (!s) return `Strategy not found: ${body.strategy_name}`;
    strategyId = s.id;
  }
  let groupId: number | undefined;
  if (body.device_group_name) {
    const g = getDeviceGroupByName(db, body.device_group_name);
    if (!g) return `Device group not found: ${body.device_group_name}`;
    groupId = g.id;
  }
  let book: AddressBookRow | null = null;
  if (body.address_book_name) {
    book =
      db.query<AddressBookRow, [string]>("SELECT * FROM address_books WHERE name = ? AND personal = 0").get(body.address_book_name) ??
      (userId !== undefined && body.address_book_name === "My address book" ? personalBook(db, userId) : null);
    if (!book) return `Address book not found: ${body.address_book_name}`;
  }
  updateDevice(db, body.id, {
    userId,
    strategyId,
    deviceGroupId: groupId,
    note: body.note,
    deviceName: body.device_name,
    username: body.device_username,
  });
  if (book) {
    try {
      addPeer(
        db,
        book,
        {
          id: body.id,
          alias: body.address_book_alias,
          tags: body.address_book_tag ? [body.address_book_tag] : undefined,
          password: body.address_book_password,
          note: body.address_book_note,
        },
        0,
      );
    } catch (e) {
      if (!(e instanceof AbError && e.message === "Peer already exists")) throw e;
    }
  }
  return null;
}

