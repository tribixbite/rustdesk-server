/**
 * Address-book endpoints (client-api-spec section 7).
 *
 * Read endpoints return JSON. Action endpoints return 200 with an EMPTY body on
 * success and `{"error"}` otherwise; the client treats any other body,
 * including `{}`, as a failure.
 */
import { z } from "@hono/zod-openapi";
import { parseJson } from "../store";
import {
  AbError,
  addPeer,
  addTag,
  deletePeers,
  deleteTags,
  getLegacyBlob,
  listPeers,
  listTags,
  personalBook,
  renameTag,
  requireBook,
  RULE_READ,
  RULE_WRITE,
  setLegacyBlob,
  sharedProfiles,
  updatePeer,
  updateTagColor,
} from "../addressbook";
import { deps, emptyOk, HttpError, pageQuery, paginate, readJson, requireAuth, route, type App, type AppContext } from "../http";
import { getSetting } from "../settings";

const GuidParam = z.object({ guid: z.string() });
const PageParams = z.object({ current: z.string().optional(), pageSize: z.string().optional() });

const PeerSchema = z
  .object({
    id: z.string(),
    hash: z.string().optional(),
    password: z.string().optional(),
    username: z.string().optional(),
    hostname: z.string().optional(),
    platform: z.string().optional(),
    alias: z.string().optional(),
    tags: z.array(z.string()).optional(),
    forceAlwaysRelay: z.string().optional(),
    rdpPort: z.string().optional(),
    rdpUsername: z.string().optional(),
    loginName: z.string().optional(),
    device_group_name: z.string().optional(),
    note: z.string().optional(),
    same_server: z.boolean().nullable().optional(),
  })
  .loose()
  .openapi("AbPeer");

const TagSchema = z.object({ name: z.string(), color: z.number().int() }).openapi("AbTag");

const ProfileSchema = z
  .object({
    guid: z.string(),
    name: z.string(),
    owner: z.string(),
    note: z.string(),
    rule: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("1 read, 2 read/write, 3 full control"),
    info: z.unknown(),
  })
  .openapi("AbProfile");

const page = <T extends z.ZodType>(item: T) => z.object({ total: z.number().int(), data: z.array(item) });

/** Runs an action and maps address-book errors to `{"error"}`. */
async function action(c: AppContext, f: () => void | Promise<void>): Promise<Response> {
  try {
    await f();
    return emptyOk(c);
  } catch (e) {
    if (e instanceof AbError) return c.json({ error: e.message }, e.message === "Address book not found" ? 404 : 400);
    throw e;
  }
}

function guidParam(c: AppContext): string {
  return c.req.param("guid") ?? "";
}

export function registerAbRoutes(app: App): void {
  const tags = ["Address book"];

  route(
    app,
    {
      method: "post",
      path: "/api/ab/personal",
      tags,
      summary: "Guid of the caller's personal address book (enables the profile-based API)",
      auth: true,
      response: z.object({ guid: z.string() }),
    },
    (c) => {
      const auth = requireAuth(c);
      return c.json({ guid: personalBook(deps(c).db, auth.user.id).guid });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/ab/settings",
      tags,
      summary: "Address-book limits",
      auth: true,
      response: z.object({ max_peer_one_ab: z.number().int().describe("0 = unlimited") }),
    },
    (c) => {
      requireAuth(c);
      return c.json({ max_peer_one_ab: getSetting(deps(c).db, "max_peer_one_ab") });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/ab/shared/profiles",
      tags,
      summary: "Shared address books visible to the caller",
      auth: true,
      query: PageParams,
      response: page(ProfileSchema),
    },
    (c) => {
      const auth = requireAuth(c);
      return c.json(paginate(sharedProfiles(deps(c).db, auth.user.id, auth.user.is_admin === 1), pageQuery(c)));
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/ab/peers",
      tags,
      summary: "Peers of one address book",
      auth: true,
      query: PageParams.extend({ ab: z.string() }),
      response: page(PeerSchema),
    },
    (c) => {
      const auth = requireAuth(c);
      const { db } = deps(c);
      try {
        const book = requireBook(db, c.req.query("ab") ?? "", auth.user.id, auth.user.is_admin === 1, RULE_READ);
        return c.json(paginate(listPeers(db, book.guid), pageQuery(c)));
      } catch (e) {
        if (e instanceof AbError) throw new HttpError(404, e.message);
        throw e;
      }
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/ab/tags/{guid}",
      tags,
      summary: "Tags of one address book, in display order",
      auth: true,
      params: GuidParam,
      response: z.array(TagSchema),
    },
    (c) => {
      const auth = requireAuth(c);
      const { db } = deps(c);
      try {
        const book = requireBook(db, guidParam(c), auth.user.id, auth.user.is_admin === 1, RULE_READ);
        return c.json(listTags(db, book.guid));
      } catch (e) {
        if (e instanceof AbError) throw new HttpError(404, e.message);
        throw e;
      }
    },
  );

  // ---- actions (empty 200 on success) ----

  const writable = (c: AppContext) => {
    const auth = requireAuth(c);
    return requireBook(deps(c).db, guidParam(c), auth.user.id, auth.user.is_admin === 1, RULE_WRITE);
  };

  route(
    app,
    { method: "post", path: "/api/ab/peer/add/{guid}", tags, summary: "Add one peer", auth: true, params: GuidParam, body: PeerSchema },
    async (c) => {
      const body = await readJson(c, PeerSchema);
      return action(c, () => addPeer(deps(c).db, writable(c), body, getSetting(deps(c).db, "max_peer_one_ab")));
    },
  );

  route(
    app,
    {
      method: "put",
      path: "/api/ab/peer/update/{guid}",
      tags,
      summary: "Update fields of one peer (only the fields sent change)",
      auth: true,
      params: GuidParam,
      body: PeerSchema.partial().extend({ id: z.string() }),
    },
    async (c) => {
      const body = await readJson(c, PeerSchema.partial().extend({ id: z.string() }));
      return action(c, () => updatePeer(deps(c).db, writable(c), body));
    },
  );

  route(
    app,
    { method: "delete", path: "/api/ab/peer/{guid}", tags, summary: "Delete peers by id", auth: true, params: GuidParam, body: z.array(z.string()) },
    async (c) => {
      const ids = await readJson(c, z.array(z.string()));
      return action(c, () => deletePeers(deps(c).db, writable(c), ids));
    },
  );

  route(
    app,
    { method: "post", path: "/api/ab/tag/add/{guid}", tags, summary: "Add a tag", auth: true, params: GuidParam, body: TagSchema },
    async (c) => {
      const body = await readJson(c, TagSchema);
      return action(c, () => addTag(deps(c).db, writable(c), body.name, body.color));
    },
  );

  const RenameBody = z.object({ old: z.string(), new: z.string() });
  route(
    app,
    { method: "put", path: "/api/ab/tag/rename/{guid}", tags, summary: "Rename a tag (also in every peer)", auth: true, params: GuidParam, body: RenameBody },
    async (c) => {
      const body = await readJson(c, RenameBody);
      return action(c, () => renameTag(deps(c).db, writable(c), body.old, body.new));
    },
  );

  route(
    app,
    { method: "put", path: "/api/ab/tag/update/{guid}", tags, summary: "Change a tag's colour", auth: true, params: GuidParam, body: TagSchema },
    async (c) => {
      const body = await readJson(c, TagSchema);
      return action(c, () => updateTagColor(deps(c).db, writable(c), body.name, body.color));
    },
  );

  route(
    app,
    { method: "delete", path: "/api/ab/tag/{guid}", tags, summary: "Delete tags (also from every peer)", auth: true, params: GuidParam, body: z.array(z.string()) },
    async (c) => {
      const names = await readJson(c, z.array(z.string()));
      return action(c, () => deleteTags(deps(c).db, writable(c), names));
    },
  );

  // ---- legacy whole-book API (old desktop UI, and clients on servers without the profile API) ----

  const LegacyBody = z.object({ data: z.string().describe("JSON string {tags, peers, tag_colors}") });

  route(
    app,
    {
      method: "get",
      path: "/api/ab",
      tags,
      summary: "Legacy: the caller's whole address book as a JSON string",
      auth: true,
      response: z.object({ data: z.string() }).nullable(),
    },
    (c) => {
      const auth = requireAuth(c);
      const data = getLegacyBlob(deps(c).db, auth.user.id);
      return data === null ? c.json(null) : c.json({ data });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/ab/get",
      tags,
      summary: "Legacy (old desktop UI): the caller's whole address book",
      auth: true,
      response: z.object({ data: z.string() }),
    },
    (c) => {
      const auth = requireAuth(c);
      return c.json({ data: getLegacyBlob(deps(c).db, auth.user.id) ?? JSON.stringify({ tags: [], peers: [] }) });
    },
  );

  route(
    app,
    { method: "post", path: "/api/ab", tags, summary: "Legacy: replace the caller's whole address book", auth: true, body: LegacyBody },
    async (c) => {
      const auth = requireAuth(c);
      const body = await readJson(c, LegacyBody);
      // The blob must itself be JSON; keep it opaque otherwise.
      if (parseJson<unknown>(body.data, undefined) === undefined) throw new HttpError(400, "data must be a JSON string");
      if (body.data.length > 4 * 1024 * 1024) throw new HttpError(413, "Address book too large");
      setLegacyBlob(deps(c).db, auth.user.id, body.data);
      return emptyOk(c);
    },
  );
}
