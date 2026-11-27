/**
 * OpenID Connect login (client-api-spec 2.6).
 *
 * 1. The client POSTs /api/oidc/auth and opens the returned `url` in a browser.
 * 2. The provider redirects the browser to /api/oidc/callback, where the code
 *    is exchanged, the ID token validated, and an access token issued.
 * 3. Meanwhile the client polls /api/oidc/auth-query until that token appears.
 *
 * Accounts are matched by verified email. With OIDC_AUTO_CREATE=Y an unknown
 * email gets a new non-admin account.
 */
import { z } from "@hono/zod-openapi";
import * as oauth from "oauth4webapi";
import type { OidcProviderConfig } from "../config";
import { now, parseJson } from "../store";
import { newToken } from "../security";
import { createUser, getUserByEmail, getUserById, getUserByName, isValidUserName, toUserPayload, type UserRow } from "../users";
import { deps, HttpError, readJson, route, type App, type AppContext } from "../http";
import { completeLogin, UserPayloadSchema } from "./account";

/** Pending browser logins expire after the client's own 180 s polling window. */
const SESSION_TTL = 10 * 60;
/** The pending reply the client keeps polling on (the text must contain this). */
const PENDING = "No authed oidc is found";

interface OidcSessionRow {
  code: string;
  state: string;
  op: string;
  nonce: string;
  code_verifier: string;
  device_id: string;
  device_uuid: string;
  device_info: string;
  user_id: number | null;
  access_token: string | null;
  error: string | null;
  expires_at: number;
}

const discoveryCache = new Map<string, Promise<oauth.AuthorizationServer>>();

/** Provider metadata from `/.well-known/openid-configuration`, cached per issuer. */
function discover(p: OidcProviderConfig): Promise<oauth.AuthorizationServer> {
  let cached = discoveryCache.get(p.issuer);
  if (!cached) {
    const issuer = new URL(p.issuer);
    cached = oauth
      .discoveryRequest(issuer, { algorithm: "oidc" })
      .then((res) => oauth.processDiscoveryResponse(issuer, res));
    // A failed discovery must not stay cached.
    cached.catch(() => discoveryCache.delete(p.issuer));
    discoveryCache.set(p.issuer, cached);
  }
  return cached;
}

function provider(c: AppContext, op: string): OidcProviderConfig {
  const p = deps(c).config.oidcProviders.find((x) => x.name === op);
  if (!p) throw new HttpError(404, `Unknown login provider: ${op}`);
  return p;
}

function redirectUri(c: AppContext): string {
  return `${deps(c).config.publicUrl}/api/oidc/callback`;
}

/** A free username derived from the provider's claims. */
function deriveUserName(c: AppContext, claims: oauth.IDToken): string {
  const { db } = deps(c);
  const candidates = [claims.preferred_username, typeof claims.email === "string" ? claims.email.split("@")[0] : undefined, `user-${claims.sub}`];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const base = raw.replace(/[^\p{L}\p{N}._@+-]/gu, "").slice(0, 56);
    if (!isValidUserName(base)) continue;
    for (let i = 0; i < 100; i++) {
      const name = i === 0 ? base : `${base}${i}`;
      if (!getUserByName(db, name)) return name;
    }
  }
  return `user-${newToken().slice(0, 8)}`;
}

async function userForClaims(c: AppContext, claims: oauth.IDToken): Promise<UserRow> {
  const { db, config } = deps(c);
  const email = typeof claims.email === "string" ? claims.email : "";
  // Only a verified address may sign in to an existing account.
  if (!email || claims.email_verified === false) throw new Error("The provider did not return a verified email address");
  const existing = getUserByEmail(db, email);
  if (existing) return existing;
  if (!config.oidcAutoCreate) throw new Error(`No account for ${email}; ask an administrator to create one`);
  return createUser(db, {
    name: deriveUserName(c, claims),
    email,
    displayName: typeof claims.name === "string" ? claims.name : "",
  });
}

const AuthBody = z
  .object({
    op: z.string(),
    id: z.string().optional(),
    uuid: z.string().optional(),
    deviceInfo: z.object({}).loose().optional(),
    apiDomain: z.string().optional(),
  })
  .openapi("OidcAuthRequest");

export function registerOidcRoutes(app: App): void {
  const tags = ["Account"];

  route(
    app,
    {
      method: "post",
      path: "/api/oidc/auth",
      tags,
      summary: "Start an OpenID Connect login; open `url` in a browser and poll auth-query with `code`",
      body: AuthBody,
      response: z.object({ code: z.string(), url: z.string() }),
    },
    async (c) => {
      const { db } = deps(c);
      const body = await readJson(c, AuthBody);
      const p = provider(c, body.op);
      const as = await discover(p).catch(() => {
        throw new HttpError(500, `Login provider ${p.name} is unreachable`);
      });
      if (!as.authorization_endpoint) throw new HttpError(500, `Login provider ${p.name} has no authorization endpoint`);
      const verifier = oauth.generateRandomCodeVerifier();
      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      const code = newToken();
      db.query("DELETE FROM oidc_sessions WHERE expires_at <= ?").run(now());
      db.query(
        `INSERT INTO oidc_sessions (code, state, op, nonce, code_verifier, device_id, device_uuid, device_info, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(code, state, p.name, nonce, verifier, body.id ?? "", body.uuid ?? "", JSON.stringify(body.deviceInfo ?? {}), now() + SESSION_TTL);
      const url = new URL(as.authorization_endpoint);
      url.searchParams.set("client_id", p.clientId);
      url.searchParams.set("redirect_uri", redirectUri(c));
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", p.scopes ?? "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      return c.json({ code, url: url.toString() });
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/api/oidc/callback",
      tags,
      summary: "Browser redirect target of the login provider (not called by the RustDesk client)",
      response: { text: "An HTML page telling the user to return to RustDesk" },
    },
    async (c) => {
      const { db } = deps(c);
      const state = c.req.query("state") ?? "";
      const session = db.query<OidcSessionRow, [string]>("SELECT * FROM oidc_sessions WHERE state = ?").get(state);
      if (!session || session.expires_at <= now()) return c.html(page("Login expired", "Start the login again from RustDesk."), 400);
      // A replayed or reloaded callback must not overwrite a completed login with an error.
      if (session.user_id !== null) return c.html(page("Already signed in", "This login is complete. You can close this tab."), 400);
      const fail = (message: string) => {
        db.query("UPDATE oidc_sessions SET error = ? WHERE code = ?").run(message, session.code);
        return c.html(page("Login failed", message), 400);
      };
      try {
        const p = provider(c, session.op);
        const as = await discover(p);
        const client: oauth.Client = { client_id: p.clientId };
        const clientAuth = oauth.ClientSecretPost(p.clientSecret);
        const params = oauth.validateAuthResponse(as, client, new URL(c.req.url), session.state);
        const response = await oauth.authorizationCodeGrantRequest(as, client, clientAuth, params, redirectUri(c), session.code_verifier);
        const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
          expectedNonce: session.nonce,
          requireIdToken: true,
        });
        const claims = oauth.getValidatedIdTokenClaims(result);
        if (!claims) return fail("The provider did not return an ID token");
        const user = await userForClaims(c, claims);
        if (user.status === 0) return fail("This account is disabled");
        const kind = parseJson<{ type?: string }>(session.device_info, {}).type === "browser" ? "console" : "client";
        const token = completeLogin(c, user, { id: session.device_id, uuid: session.device_uuid, info: parseJson(session.device_info, {}) }, kind);
        db.query("UPDATE oidc_sessions SET user_id = ?, access_token = ?, error = NULL WHERE code = ?").run(user.id, token, session.code);
        return c.html(page("Logged in", `Signed in as ${user.name}. You can close this tab and return to RustDesk.`));
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Login failed");
      }
    },
  );

  route(
    app,
    {
      method: "get",
      path: "/api/oidc/auth-query",
      tags,
      summary: "Poll for the result of an OpenID Connect login",
      description: `Replies \`{"error": "${PENDING}"}\` until the browser login completes.`,
      query: z.object({ code: z.string(), id: z.string().optional(), uuid: z.string().optional() }),
      response: z.object({ access_token: z.string(), type: z.literal("access_token"), user: UserPayloadSchema }),
    },
    (c) => {
      const { db } = deps(c);
      const session = db.query<OidcSessionRow, [string]>("SELECT * FROM oidc_sessions WHERE code = ?").get(c.req.query("code") ?? "");
      if (!session || session.expires_at <= now()) return c.json({ error: "Login expired, please try again" });
      if ((c.req.query("id") ?? "") !== session.device_id) return c.json({ error: "Login was started on another device" });
      if (session.error) return c.json({ error: session.error });
      if (!session.access_token || session.user_id === null) return c.json({ error: PENDING });
      // The token is handed out once: the row is the only place it exists in clear text
      // (tokens are otherwise stored hashed), so it goes as soon as the client has it.
      db.query("DELETE FROM oidc_sessions WHERE code = ?").run(session.code);
      const user = getUserById(db, session.user_id);
      if (!user) return c.json({ error: "Account no longer exists" });
      return c.json({ access_token: session.access_token, type: "access_token", user: toUserPayload(user) });
    },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A minimal self-contained result page for the browser leg of the login. */
function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:dark;--bg:#0f1115;--fg:#e6e8eb;--muted:#9aa3ad}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:28rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:var(--muted);margin:0}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
