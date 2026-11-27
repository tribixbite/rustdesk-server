/**
 * Audit endpoints (client-api-spec section 5).
 *
 * Success for the device-side posts is a 2xx with an EMPTY body; anything else
 * makes the client retry. Records carry a `nonce` and are stored once.
 */
import { z } from "@hono/zod-openapi";
import { touchDevice } from "../devices";
import {
  claimNonce,
  findConnGuid,
  rawJsonNumber,
  recordAlarm,
  recordConn,
  recordFile,
  setConnNoteByGuid,
  setConnNoteBySession,
} from "../audit";
import { deps, emptyOk, HttpError, parseJsonText, requireAuth, route, type App } from "../http";

const ConnBody = z
  .object({
    id: z.string(),
    uuid: z.string().optional(),
    conn_id: z.number().int().optional(),
    session_id: z.number().optional().describe("u64; read from the raw body to keep its precision"),
    nonce: z.string().optional(),
    action: z.string().optional().describe('"new", "close", or absent for the login record'),
    ip: z.string().optional(),
    conn_audit_ref: z.string().optional(),
    peer: z.array(z.string()).optional().describe("[controller id, controller name]"),
    type: z.number().int().optional(),
    primary_auth: z.number().int().optional(),
    two_factor: z.number().int().optional(),
    note: z.string().optional(),
  })
  .loose()
  .openapi("ConnAudit");

const FileBody = z
  .object({
    id: z.string(),
    uuid: z.string(),
    peer_id: z.string().optional(),
    conn_id: z.number().int().optional(),
    type: z.number().int().optional(),
    path: z.string().optional(),
    is_file: z.boolean().optional(),
    info: z.string().optional().describe("JSON-encoded string"),
    nonce: z.string().optional(),
  })
  .loose()
  .openapi("FileAudit");

const AlarmBody = z
  .object({
    id: z.string(),
    uuid: z.string(),
    typ: z.number().int(),
    info: z.string().optional().describe("JSON-encoded string"),
    conn_id: z.number().int().optional(),
    conn_audit_ref: z.string().optional(),
    nonce: z.string().optional(),
  })
  .loose()
  .openapi("AlarmAudit");

const NoteBody = z.object({ guid: z.string(), note: z.string() });

export function registerAuditRoutes(app: App): void {
  route(
    app,
    {
      method: "post",
      path: "/api/audit/conn",
      tags: ["Audit"],
      summary: "Connection audit record (opened, authorized, closed), or a controller's session note",
      body: ConnBody,
      response: { empty: "Recorded (empty body)" },
    },
    async (c) => {
      const { db } = deps(c);
      const raw = await c.req.text();
      const body = parseJsonText(raw, ConnBody);
      const sessionId = rawJsonNumber(raw, "session_id") ?? "0";
      // Controller-side note: {id: <remote peer>, session_id, note}, sent without a uuid.
      if (body.note !== undefined && body.uuid === undefined) {
        setConnNoteBySession(db, body.id, sessionId, body.note);
        return emptyOk(c);
      }
      if (!touchDevice(db, body.id, body.uuid ?? "")) throw new HttpError(403, "Device uuid mismatch");
      if (!claimNonce(db, body.nonce ?? "")) return emptyOk(c);
      recordConn(db, body.id, body.conn_id ?? 0, sessionId, body);
      return emptyOk(c);
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/audit/file",
      tags: ["Audit"],
      summary: "File-transfer audit record",
      body: FileBody,
      response: { empty: "Recorded (empty body)" },
    },
    async (c) => {
      const { db } = deps(c);
      const body = parseJsonText(await c.req.text(), FileBody);
      if (!touchDevice(db, body.id, body.uuid)) throw new HttpError(403, "Device uuid mismatch");
      if (claimNonce(db, body.nonce ?? "")) recordFile(db, body.id, body);
      return emptyOk(c);
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/audit/alarm",
      tags: ["Audit"],
      summary: "Security alarm record",
      body: AlarmBody,
      response: { empty: "Recorded (empty body)" },
    },
    async (c) => {
      const { db } = deps(c);
      const body = parseJsonText(await c.req.text(), AlarmBody);
      if (!touchDevice(db, body.id, body.uuid)) throw new HttpError(403, "Device uuid mismatch");
      if (claimNonce(db, body.nonce ?? "")) recordAlarm(db, body.id, body);
      return emptyOk(c);
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/api/audit/conn/active",
      tags: ["Audit"],
      summary: "Guid of the audit record of a session the caller opened",
      description: "Replies with a JSON string; an empty string tells the client to retry.",
      auth: true,
      query: z.object({ id: z.string(), session_id: z.string(), conn_type: z.string().optional() }),
      response: z.string(),
    },
    (c) => {
      requireAuth(c);
      const { db } = deps(c);
      const connType = Number.parseInt(c.req.query("conn_type") ?? "", 10);
      const guid = findConnGuid(db, c.req.query("id") ?? "", c.req.query("session_id") ?? "", Number.isFinite(connType) ? connType : null);
      return c.json(guid ?? "");
    },
  );

  route(
    app,
    {
      method: "put",
      path: "/api/audit",
      tags: ["Audit"],
      summary: "Attach the controller's end-of-session note to an audit record",
      auth: true,
      body: NoteBody,
    },
    async (c) => {
      requireAuth(c);
      const body = parseJsonText(await c.req.text(), NoteBody);
      if (!setConnNoteByGuid(deps(c).db, body.guid, body.note.slice(0, 4096))) throw new HttpError(404, "Audit record not found");
      return emptyOk(c);
    },
  );
}
