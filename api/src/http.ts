/**
 * Shared HTTP plumbing: app context types, error replies, body parsing,
 * bearer authentication, pagination and OpenAPI registration.
 *
 * Handlers parse request bodies themselves instead of using the zod-openapi
 * validator, because the RustDesk client sends empty POST bodies, raw u64
 * numbers that must not go through JSON number parsing, and expects
 * `{"error": "..."}` on failure. The same zod schemas are registered in the
 * OpenAPI document so /docs stays accurate.
 */
import type { Database } from "bun:sqlite";
import type { Context, Handler } from "hono";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Config } from "./config";
import { authenticate, type Authenticated, type TokenKind } from "./users";
import type { LoginThrottle } from "./routes/account";

export interface Deps {
  db: Database;
  config: Config;
  /** Failed-login counters; one per app instance. */
  throttle: LoginThrottle;
}

export type AppEnv = { Variables: { deps: Deps } };
export type AppContext = Context<AppEnv>;
export type App = OpenAPIHono<AppEnv>;

/** An error that becomes `{"error": message}` with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500,
    message: string,
  ) {
    super(message);
  }
}

export function deps(c: AppContext): Deps {
  return c.get("deps");
}

/** Reads and validates a JSON body; an empty body validates as `{}`. */
export async function readJson<S extends z.ZodType>(c: AppContext, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  return parseJsonText(text, schema);
}

export function parseJsonText<S extends z.ZodType>(text: string, schema: S): z.infer<S> {
  let value: unknown = {};
  if (text.trim() !== "") {
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, `${where}${issue?.message ?? "Invalid request"}`);
  }
  return parsed.data;
}

export function bearerToken(c: AppContext): string {
  const h = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? "";
}

/** Authenticates the request's bearer token; 401 "Invalid token" otherwise. */
export function requireAuth(c: AppContext, kinds: readonly TokenKind[] = ["client", "console"]): Authenticated {
  const auth = authenticate(deps(c).db, bearerToken(c), kinds);
  if (!auth) throw new HttpError(401, "Invalid token");
  return auth;
}

export function requireAdmin(c: AppContext, kinds: readonly TokenKind[] = ["console", "client"]): Authenticated {
  const auth = requireAuth(c, kinds);
  if (auth.user.is_admin !== 1) throw new HttpError(403, "Admin required!");
  return auth;
}

export interface PageQuery {
  current: number;
  pageSize: number;
  limit: number;
  offset: number;
}

/** `current` (1-based) and `pageSize` query parameters, as the client sends them. */
export function pageQuery(c: AppContext, defaultSize = 100, maxSize = 1000): PageQuery {
  const num = (v: string | undefined, d: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const current = num(c.req.query("current"), 1);
  const pageSize = Math.min(num(c.req.query("pageSize"), defaultSize), maxSize);
  return { current, pageSize, limit: pageSize, offset: (current - 1) * pageSize };
}

/** Slices an in-memory list into the client's `{total, data}` page shape. */
export function paginate<T>(items: T[], q: PageQuery): { total: number; data: T[] } {
  return { total: items.length, data: items.slice(q.offset, q.offset + q.limit) };
}

/** 200 with a zero-length body: what the client's address-book actions treat as success. */
export function emptyOk(c: AppContext): Response {
  return c.body(null, 200);
}

// ---- OpenAPI registration ----

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

type Method = "get" | "post" | "put" | "delete" | "patch";

export interface DocSpec {
  method: Method;
  /** OpenAPI path, e.g. "/api/ab/peer/add/{guid}". */
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  /** Bearer token required. */
  auth?: boolean;
  body?: z.ZodType;
  query?: z.ZodObject;
  params?: z.ZodObject;
  /** JSON response schema for 200, or a description of a non-JSON 200 reply. */
  response?: z.ZodType | { text: string } | { empty: string };
}

/**
 * Registers a route in the OpenAPI document and mounts its handler.
 * Error replies are documented once for every route.
 */
export function route(app: App, spec: DocSpec, handler: Handler<AppEnv>): void {
  const responses: RouteConfig["responses"] = {};
  const r = spec.response;
  if (r === undefined || "empty" in (r as object)) {
    responses[200] = { description: r && "empty" in r ? r.empty : "Success (empty body)" };
  } else if ("text" in (r as object)) {
    responses[200] = { description: (r as { text: string }).text, content: { "text/plain": { schema: z.string() } } };
  } else {
    responses[200] = { description: "Success", content: { "application/json": { schema: r as z.ZodType } } };
  }
  responses[400] = { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } };
  if (spec.auth) {
    responses[401] = { description: "Missing or invalid token", content: { "application/json": { schema: ErrorSchema } } };
  }
  const config: RouteConfig = {
    method: spec.method,
    path: spec.path,
    tags: spec.tags,
    summary: spec.summary,
    description: spec.description,
    security: spec.auth ? [{ bearer: [] }] : [],
    request: {
      ...(spec.body ? { body: { content: { "application/json": { schema: spec.body } }, required: false } } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.params ? { params: spec.params } : {}),
    },
    responses,
  };
  app.openAPIRegistry.registerPath(config);
  const honoPath = spec.path.replace(/\{(\w+)\}/g, ":$1");
  app.on(spec.method.toUpperCase(), honoPath, handler);
}
