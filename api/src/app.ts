/**
 * Builds the HTTP application: client API, console API, OpenAPI document and
 * interactive docs, and the web console's static files.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HttpError, type AppEnv, type Deps } from "./http";
import { LoginThrottle, registerAccountRoutes } from "./routes/account";
import { registerOidcRoutes } from "./routes/oidc";
import { registerSyncRoutes } from "./routes/sync";
import { registerAuditRoutes } from "./routes/audit";
import { registerAbRoutes } from "./routes/ab";
import { registerGroupRoutes } from "./routes/groups";
import { registerAdminRoutes } from "./routes/admin";

export const API_VERSION = "0.1.0";

export function createApp(input: Omit<Deps, "throttle"> & Partial<Pick<Deps, "throttle">>): OpenAPIHono<AppEnv> {
  const d: Deps = { ...input, throttle: input.throttle ?? new LoginThrottle() };
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", d);
    await next();
  });

  // Every API error is `{"error": "..."}`, which the RustDesk client shows to the user.
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(`${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/healthz", (c) => c.text("ok"));

  registerAccountRoutes(app);
  registerOidcRoutes(app);
  registerSyncRoutes(app);
  registerAuditRoutes(app);
  registerAbRoutes(app);
  registerGroupRoutes(app);
  registerAdminRoutes(app);

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : serveIndex(c, d)));

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description: "Access token from POST /api/login (or an API token for /api/devices/*)",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "RustDesk API",
      version: API_VERSION,
      description:
        "Account login, address books, devices, strategies and audit for RustDesk clients, plus the web console API. " +
        "Client endpoints follow the official client's contract; `/api/admin/*` and `/api/me/*` serve the console.",
    },
  });
  app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "RustDesk API", theme: "deepSpace", darkMode: true }));

  // Web console: built assets, with index.html for client-side routes.
  if (existsSync(d.config.webDir)) {
    app.use("/assets/*", serveStatic({ root: d.config.webDir, rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }));
  }
  return app;
}

function serveIndex(c: Parameters<Parameters<OpenAPIHono<AppEnv>["notFound"]>[0]>[0], d: Deps): Response | Promise<Response> {
  const index = join(d.config.webDir, "index.html");
  if (c.req.method !== "GET" || !existsSync(index)) return c.text("Not found", 404);
  return new Response(Bun.file(index), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}
