import { describe, expect, test } from "bun:test";
import { makeApp } from "./helpers";
import { clientConfigString } from "../src/routes/admin";
import { base32Decode, hotp } from "../src/security";

/** Decodes the client's server-config string (flutter common.dart ServerConfig.decode). */
function decodeConfig(s: string): unknown {
  const b64 = s.split("").reverse().join("");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

async function consoleLogin(t: ReturnType<typeof makeApp>, name: string, password: string): Promise<string> {
  const r = await t.call("POST", "/api/login", { body: { username: name, password, type: "account", deviceInfo: { type: "browser", os: "web", name: "console" } } });
  return r.json.access_token as string;
}

describe("console API", () => {
  test("admin routes refuse non-admins with 403 Admin required!", async () => {
    const t = makeApp();
    await t.user("plain", "password-1");
    const token = await consoleLogin(t, "plain", "password-1");
    const r = await t.call("GET", "/api/admin/users", { token });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "Admin required!" });
  });

  test("user lifecycle: create, duplicate, disable revokes sessions, cannot demote self", async () => {
    const t = makeApp();
    await t.user("root", "password-1", true);
    const token = await consoleLogin(t, "root", "password-1");
    const created = await t.call("POST", "/api/admin/users", { token, body: { name: "grandma", password: "long-password", email: "g@example.test" } });
    expect(created.json).toMatchObject({ name: "grandma", is_admin: false, status: 1, totp_enabled: false });
    expect((await t.call("POST", "/api/admin/users", { token, body: { name: "grandma", password: "long-password" } })).status).toBe(409);
    expect((await t.call("POST", "/api/admin/users", { token, body: { name: "x", password: "short" } })).json.error).toContain("at least 8");

    const gToken = await consoleLogin(t, "grandma", "long-password");
    await t.call("PATCH", `/api/admin/users/${created.json.guid}`, { token, body: { status: 0 } });
    expect((await t.call("GET", "/api/me", { token: gToken })).status).toBe(401);

    const me = (await t.call("GET", "/api/me", { token })).json;
    expect((await t.call("PATCH", `/api/admin/users/${me.guid}`, { token, body: { is_admin: false } })).status).toBe(400);
  });

  test("overview carries a config string that decodes to the server settings", async () => {
    const t = makeApp();
    await t.user("root", "password-1", true);
    const token = await consoleLogin(t, "root", "password-1");
    const o = (await t.call("GET", "/api/admin/overview", { token })).json;
    expect(decodeConfig(o.server.config_string)).toEqual({
      host: "hbbs.example.test",
      relay: "hbbr.example.test",
      api: "https://api.example.test",
      key: "z+7KImTC1loA9Vwul3Sa0kL9HwRFOoD9y432sOVbq5Y=",
    });
  });

  test("config string keeps Dart's base64url padding", () => {
    // 3 json bytes over a multiple of 3 forces padding; Dart emits "=" which Node's base64url omits.
    const s = clientConfigString("a", "", "", "");
    expect(s.startsWith("=")).toBe(true);
    expect(decodeConfig(s)).toEqual({ host: "a", relay: "", api: "", key: "" });
  });

  test("TOTP enrolment needs a valid code; login then asks for it", async () => {
    const t = makeApp();
    await t.user("sam", "password-1");
    const token = await consoleLogin(t, "sam", "password-1");
    const setup = (await t.call("POST", "/api/me/totp/setup", { token })).json;
    expect(setup.uri).toStartWith("otpauth://totp/");
    expect((await t.call("POST", "/api/me/totp/enable", { token, body: { secret: setup.secret, code: "000000" } })).status).toBe(400);
    const code = hotp(base32Decode(setup.secret), Math.floor(Date.now() / 30000));
    expect((await t.call("POST", "/api/me/totp/enable", { token, body: { secret: setup.secret, code } })).json).toEqual({ ok: true });
    const step1 = await t.call("POST", "/api/login", { body: { username: "sam", password: "password-1", type: "account" } });
    expect(step1.json.tfa_type).toBe("tfa_check");
  });

  test("password change revokes old sessions and returns a fresh console token", async () => {
    const t = makeApp();
    await t.user("pat", "password-1");
    const token = await consoleLogin(t, "pat", "password-1");
    expect((await t.call("POST", "/api/me/password", { token, body: { current: "wrong", new: "password-2" } })).status).toBe(400);
    const changed = await t.call("POST", "/api/me/password", { token, body: { current: "password-1", new: "password-2" } });
    expect((await t.call("GET", "/api/me", { token })).status).toBe(401);
    expect((await t.call("GET", "/api/me", { token: changed.json.access_token })).status).toBe(200);
  });

  test("API tokens authorize rustdesk --assign; login tokens do not", async () => {
    const t = makeApp();
    await t.user("root", "password-1", true);
    await t.user("kid", "password-2");
    const token = await consoleLogin(t, "root", "password-1");
    const api = (await t.call("POST", "/api/admin/tokens", { token, body: { label: "assign" } })).json.token as string;
    const body = { id: "123456789", uuid: "dQ==", user_name: "kid", note: "tablet" };
    expect((await t.call("POST", "/api/devices/cli", { token, body })).status).toBe(401);
    const ok = await t.call("POST", "/api/devices/cli", { token: api, body });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("");
    const bad = await t.call("POST", "/api/devices/cli", { token: api, body: { ...body, user_name: "nobody" } });
    expect(bad.text).toBe("User not found: nobody");
    const devices = (await t.call("GET", "/api/admin/devices", { token })).json;
    expect(devices[0]).toMatchObject({ id: "123456789", note: "tablet", owner: { name: "kid" } });
  });
});
