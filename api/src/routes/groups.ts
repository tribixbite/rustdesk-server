/**
 * "Accessible devices" (group tab) endpoints (client-api-spec section 8).
 */
import { z } from "@hono/zod-openapi";
import { accessibleDeviceGroups, accessibleDevices, listDeviceGroups } from "../devices";
import { listUsers, toUserPayload, type UserRow } from "../users";
import { deps, pageQuery, paginate, requireAuth, route, type App } from "../http";
import { UserPayloadSchema } from "./account";

const PageParams = z.object({
  current: z.string().optional(),
  pageSize: z.string().optional(),
  accessible: z.string().optional(),
  status: z.string().optional(),
});

const PeerPayloadSchema = z
  .object({
    id: z.string(),
    info: z.object({ username: z.string(), os: z.string(), device_name: z.string() }),
    status: z.number().int(),
    user: z.string(),
    user_name: z.string(),
    device_group_name: z.string(),
    note: z.string(),
  })
  .openapi("PeerPayload");

const page = <T extends z.ZodType>(item: T) => z.object({ total: z.number().int(), data: z.array(item) });

export function registerGroupRoutes(app: App): void {
  const tags = ["Accessible devices"];

  route(
    app,
    {
      method: "get",
      path: "/api/device-group/accessible",
      tags,
      summary: "Device groups the caller may see",
      auth: true,
      query: PageParams,
      response: page(z.object({ name: z.string() })),
    },
    (c) => {
      const auth = requireAuth(c);
      const groups = accessibleDeviceGroups(deps(c).db, auth.user.id, auth.user.is_admin === 1);
      return c.json(paginate(groups.map((g) => ({ name: g.name })), pageQuery(c)));
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/api/users",
      tags,
      summary: "Users the caller may see (all for administrators, otherwise themself)",
      auth: true,
      query: PageParams,
      response: page(UserPayloadSchema),
    },
    (c) => {
      const auth = requireAuth(c);
      const { db } = deps(c);
      const wantStatus = c.req.query("status");
      let users: UserRow[] = auth.user.is_admin === 1 ? listUsers(db) : [auth.user];
      if (wantStatus !== undefined && wantStatus !== "") users = users.filter((u) => String(u.status) === wantStatus);
      return c.json(paginate(users.map(toUserPayload), pageQuery(c)));
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/api/peers",
      tags,
      summary: "Devices the caller may see: their own and those of groups shared with them (all for administrators)",
      auth: true,
      query: PageParams,
      response: page(PeerPayloadSchema),
    },
    (c) => {
      const auth = requireAuth(c);
      const { db } = deps(c);
      const users = new Map(listUsers(db).map((u) => [u.id, u]));
      const groups = new Map(listDeviceGroups(db).map((g) => [g.id, g.name]));
      const peers = accessibleDevices(db, auth.user.id, auth.user.is_admin === 1).map((d) => {
        const owner = d.user_id === null ? undefined : users.get(d.user_id);
        return {
          id: d.id,
          // The client maps `os` to a platform by the part before " / ".
          info: { username: d.username, os: d.os, device_name: d.device_name || d.hostname },
          status: 1,
          user: owner?.guid ?? "",
          user_name: owner?.name ?? "",
          device_group_name: d.device_group_id === null ? "" : (groups.get(d.device_group_id) ?? ""),
          note: d.note,
        };
      });
      return c.json(paginate(peers, pageQuery(c)));
    },
  );
}
