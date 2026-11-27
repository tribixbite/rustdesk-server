/**
 * Account endpoints the RustDesk client calls (client-api-spec section 2):
 * login (with TOTP second step), current user, logout, login options.
 */
import { z } from "@hono/zod-openapi";
import { now } from "../store";
import { newToken, verifyPassword, verifyTotp } from "../security";
import { touchDevice, setDeviceOwner } from "../devices";
import {
  getUserByName,
  getUserById,
  issueToken,
  revokeToken,
  toUserPayload,
  type TokenKind,
  type UserRow,
} from "../users";
import { bearerToken, deps, emptyOk, HttpError, readJson, requireAuth, route, type App, type AppContext } from "../http";

const DeviceInfoSchema = z
  .object({ os: z.string().optional(), type: z.string().optional(), name: z.string().optional() })
  .loose()
  .openapi("DeviceInfo");

export const UserPayloadSchema = z
  .object({
    name: z.string(),
    display_name: z.string().nullable(),
    avatar: z.string().nullable(),
    email: z.string().nullable(),
    note: z.string().nullable(),
    status: z.union([z.literal(1), z.literal(0), z.literal(-1)]),
    is_admin: z.boolean(),
    info: z.object({}).loose(),
  })
  .openapi("UserPayload");

const LoginBody = z
  .object({
    username: z.string().optional(),
    password: z.string().optional(),
    id: z.string().optional(),
    uuid: z.string().optional(),
    autoLogin: z.boolean().optional(),
    type: z.string().optional(),
    verificationCode: z.string().optional(),
    tfaCode: z.string().optional(),
    secret: z.string().optional(),
    deviceInfo: DeviceInfoSchema.optional(),
  })
  .openapi("LoginRequest");

const LoginReply = z
  .object({
    type: z.enum(["access_token", "email_check"]),
    access_token: z.string().optional(),
    tfa_type: z.string().optional(),
    secret: z.string().optional(),
    user: UserPayloadSchema,
  })
  .openapi("LoginResponse");

const DeviceIdBody = z.object({ id: z.string().optional(), uuid: z.string().optional() });

/** How long the second login step may take. */
const PENDING_LOGIN_TTL = 5 * 60;
const MAX_TOTP_ATTEMPTS = 5;

/**
 * Failed-login throttle over a sliding `windowSeconds`. Keys are the username
 * (`user:` prefix, at most `userLimit` failures) and the client IP (`ip:`
 * prefix, at most `ipLimit`), so neither guessing one account's password nor
 * spraying many accounts from one address gets far. The IP limit is higher
 * because a household shares one public address.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();
  constructor(
    private readonly userLimit = 10,
    private readonly ipLimit = 30,
    private readonly windowSeconds = 15 * 60,
  ) {}

  blocked(keys: string[], at = now()): boolean {
    return keys.some((k) => this.recent(k, at).length >= (k.startsWith("ip:") ? this.ipLimit : this.userLimit));
  }

  fail(keys: string[], at = now()): void {
    for (const k of keys) this.failures.set(k, [...this.recent(k, at), at]);
  }

  clear(keys: string[]): void {
    for (const k of keys) this.failures.delete(k);
  }

  private recent(key: string, at: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => at - t < this.windowSeconds);
  }
}

export function clientIp(c: AppContext): string {
  // Railway's edge sets X-Real-IP; fall back to the first X-Forwarded-For hop.
  return c.req.header("X-Real-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

/** Token kind from the device info: the web console identifies itself as a browser. */
function tokenKind(info: z.infer<typeof DeviceInfoSchema> | undefined): TokenKind {
  return info?.type === "browser" ? "console" : "client";
}

/**
 * Issues the access token that completes a login, and records the logged-in
 * user as the device's owner (that is what "My devices" in the group tab and
 * strategy-by-user resolve against).
 */
export function completeLogin(
  c: AppContext,
  user: UserRow,
  device: { id: string; uuid: string; info: unknown },
  kind: TokenKind,
): string {
  const { db, config } = deps(c);
  const token = issueToken(db, user.id, { kind, ttlSeconds: config.tokenTtlSeconds, device });
  if (kind === "client" && device.id && device.uuid && touchDevice(db, device.id, device.uuid)) {
    setDeviceOwner(db, device.id, user.id);
  }
  return token;
}

interface PendingLoginRow {
  secret: string;
  user_id: number;
  device_id: string;
  device_uuid: string;
  device_info: string;
  kind: TokenKind;
  attempts: number;
  expires_at: number;
}

export function registerAccountRoutes(app: App): void {
  route(
    app,
    {
      method: "get",
      path: "/api/login-options",
      tags: ["Account"],
      summary: "Login methods offered on the client's login dialog",
      description: 'An array of strings; "oidc/<name>" for each configured OpenID Connect provider.',
      response: z.array(z.string()),
    },
    (c) => c.json(deps(c).config.oidcProviders.map((p) => `oidc/${p.name}`)),
  );

  route(
    app,
    {
      method: "post",
      path: "/api/login",
      tags: ["Account"],
      summary: "Password login, with a TOTP second step when enabled",
      description:
        'Step 1 `type:"account"` with username/password returns an access token, or `type:"email_check", tfa_type:"tfa_check"` with a `secret` when TOTP is on. Step 2 `type:"email_code"` sends that `secret` and the code in `verificationCode`.',
      body: LoginBody,
      response: LoginReply,
    },
    async (c) => {
      const { db, throttle } = deps(c);
      const body = await readJson(c, LoginBody);
      const device = { id: body.id ?? "", uuid: body.uuid ?? "", info: body.deviceInfo ?? {} };
      const ip = `ip:${clientIp(c)}`;

      if (body.type === "email_code") {
        const pending = db.query<PendingLoginRow, [string]>("SELECT * FROM pending_logins WHERE secret = ?").get(body.secret ?? "");
        if (!pending || pending.expires_at <= now()) throw new HttpError(401, "Login session expired, please log in again");
        const user = getUserById(db, pending.user_id);
        if (!user || user.status === 0 || !user.totp_secret) throw new HttpError(401, "Login session expired, please log in again");
        const code = body.tfaCode || body.verificationCode || "";
        if (!verifyTotp(user.totp_secret, code)) {
          const attempts = pending.attempts + 1;
          if (attempts >= MAX_TOTP_ATTEMPTS) db.query("DELETE FROM pending_logins WHERE secret = ?").run(pending.secret);
          else db.query("UPDATE pending_logins SET attempts = ? WHERE secret = ?").run(attempts, pending.secret);
          throw new HttpError(401, "Wrong 2FA Code");
        }
        db.query("DELETE FROM pending_logins WHERE secret = ?").run(pending.secret);
        const token = completeLogin(c, user, { id: pending.device_id, uuid: pending.device_uuid, info: JSON.parse(pending.device_info) }, pending.kind);
        return c.json({ type: "access_token", access_token: token, user: toUserPayload(user) });
      }

      const username = (body.username ?? "").trim();
      const keys = [`user:${username.toLowerCase()}`, ip];
      if (throttle.blocked(keys)) throw new HttpError(401, "Too many failed attempts, try again later");
      const user = username ? getUserByName(db, username) : null;
      const ok = user ? await verifyPassword(body.password ?? "", user.password_hash) : false;
      if (!user || !ok) {
        throttle.fail(keys);
        throw new HttpError(401, "Wrong credentials");
      }
      throttle.clear([keys[0] ?? ""]);
      if (user.status === 0) throw new HttpError(401, "User is disabled");

      const kind = tokenKind(body.deviceInfo);
      if (user.totp_secret) {
        const secret = newToken();
        db.query(
          `INSERT INTO pending_logins (secret, user_id, device_id, device_uuid, device_info, kind, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(secret, user.id, device.id, device.uuid, JSON.stringify(device.info), kind, now() + PENDING_LOGIN_TTL);
        db.query("DELETE FROM pending_logins WHERE expires_at <= ?").run(now());
        return c.json({ type: "email_check", tfa_type: "tfa_check", secret, user: toUserPayload(user) });
      }
      const token = completeLogin(c, user, device, kind);
      return c.json({ type: "access_token", access_token: token, user: toUserPayload(user) });
    },
  );

  route(
    app,
    {
      method: "post",
      path: "/api/currentUser",
      tags: ["Account"],
      summary: "The logged-in user",
      auth: true,
      body: DeviceIdBody,
      response: UserPayloadSchema,
    },
    (c) => c.json(toUserPayload(requireAuth(c).user)),
  );

  route(
    app,
    {
      method: "post",
      path: "/api/logout",
      tags: ["Account"],
      summary: "Revoke the current access token",
      auth: true,
      body: DeviceIdBody,
    },
    (c) => {
      revokeToken(deps(c).db, bearerToken(c));
      return emptyOk(c);
    },
  );
}
