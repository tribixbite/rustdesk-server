/**
 * Contract tests for the endpoints the RustDesk client calls, following
 * client-api-spec (scratchpad) / docs/api.md. Each quirk the client depends
 * on is asserted explicitly.
 */
import { describe, expect, test } from "bun:test";
import { DEVICE, makeApp } from "./helpers";
import { setTotpSecret } from "../src/users";
import { hotp, base32Decode, newTotpSecret } from "../src/security";
import { createStrategy, updateDevice, requestDisconnect, createDeviceGroup, updateDeviceGroup } from "../src/devices";
import { createSharedBook, updateSharedBook } from "../src/addressbook";

describe("account", () => {
  test("login-options lists configured OIDC providers as oidc/<name>", async () => {
    const plain = makeApp();
    expect((await plain.call("GET", "/api/login-options")).json).toEqual([]);
    const withOidc = makeApp({
      OIDC_PROVIDERS: JSON.stringify([{ name: "google", issuer: "https://accounts.google.com", clientId: "a", clientSecret: "b" }]),
    });
    expect((await withOidc.call("GET", "/api/login-options")).json).toEqual(["oidc/google"]);
  });

  test("OIDC: auth-query hands the token out once, and a replayed callback cannot undo the login", async () => {
    const t = makeApp({
      OIDC_PROVIDERS: JSON.stringify([{ name: "google", issuer: "https://accounts.google.com", clientId: "a", clientSecret: "b" }]),
    });
    const u = await t.user("alice", "password-1");
    // A session as the callback leaves it after a successful provider login.
    t.db
      .query(
        `INSERT INTO oidc_sessions (code, state, op, nonce, code_verifier, device_id, device_uuid, device_info, expires_at, user_id, access_token)
         VALUES ('c1', 's1', 'google', 'n', 'v', ?, ?, '{}', ?, ?, 'tok-1')`,
      )
      .run(DEVICE.id, DEVICE.uuid, Math.floor(Date.now() / 1000) + 300, u.id);

    const replay = await t.call("GET", "/api/oidc/callback?state=s1&code=x");
    expect(replay.status).toBe(400);
    expect(replay.text).toContain("Already signed in");

    const wrongDevice = await t.call("GET", `/api/oidc/auth-query?code=c1&id=other`);
    expect(wrongDevice.json).toEqual({ error: "Login was started on another device" });

    const first = await t.call("GET", `/api/oidc/auth-query?code=c1&id=${DEVICE.id}&uuid=${DEVICE.uuid}`);
    expect(first.json).toMatchObject({ access_token: "tok-1", type: "access_token", user: { name: "alice" } });
    const second = await t.call("GET", `/api/oidc/auth-query?code=c1&id=${DEVICE.id}&uuid=${DEVICE.uuid}`);
    expect(second.json).toEqual({ error: "Login expired, please try again" });
  });

  test("password login returns access_token and a UserPayload; wrong password gives {error}", async () => {
    const t = makeApp();
    await t.user("alice", "password-1");
    const bad = await t.call("POST", "/api/login", { body: { username: "alice", password: "nope", type: "account" } });
    expect(bad.status).toBe(401);
    expect(bad.json).toEqual({ error: "Wrong credentials" });

    const ok = await t.call("POST", "/api/login", {
      body: { username: "alice", password: "password-1", id: DEVICE.id, uuid: DEVICE.uuid, type: "account", deviceInfo: { os: "linux", type: "client", name: "pc" } },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.type).toBe("access_token");
    expect(typeof ok.json.access_token).toBe("string");
    expect(ok.json.user).toMatchObject({ name: "alice", status: 1, is_admin: false, info: {} });
  });

  test("TOTP: step 1 signals email_check/tfa_check with a secret, step 2 exchanges the code", async () => {
    const t = makeApp();
    const u = await t.user("bob", "password-2");
    const secret = newTotpSecret();
    setTotpSecret(t.db, u.id, secret);

    const step1 = await t.call("POST", "/api/login", { body: { username: "bob", password: "password-2", type: "account" } });
    expect(step1.json.type).toBe("email_check");
    expect(step1.json.tfa_type).toBe("tfa_check");
    expect(step1.json.access_token).toBeUndefined();

    const wrong = await t.call("POST", "/api/login", { body: { type: "email_code", secret: step1.json.secret, verificationCode: "000000", tfaCode: "000000" } });
    expect(wrong.status).toBe(401);

    const code = hotp(base32Decode(secret), Math.floor(Date.now() / 1000 / 30));
    const step2 = await t.call("POST", "/api/login", { body: { type: "email_code", secret: step1.json.secret, verificationCode: code, tfaCode: code } });
    expect(step2.json.type).toBe("access_token");
    expect(typeof step2.json.access_token).toBe("string");
  });

  test("failed logins are throttled per user", async () => {
    const t = makeApp();
    await t.user("carol-throttle", "password-3");
    for (let i = 0; i < 10; i++) {
      await t.call("POST", "/api/login", { body: { username: "carol-throttle", password: "x", type: "account" } });
    }
    const blocked = await t.call("POST", "/api/login", { body: { username: "carol-throttle", password: "password-3", type: "account" } });
    expect(blocked.json.error).toContain("Too many failed attempts");
  });

  test("currentUser needs a valid token (401 otherwise); logout revokes it", async () => {
    const t = makeApp();
    await t.user("dave", "password-4");
    const token = await t.login("dave", "password-4");
    const me = await t.call("POST", "/api/currentUser", { token, body: DEVICE });
    expect(me.status).toBe(200);
    expect(me.json.name).toBe("dave");
    expect((await t.call("POST", "/api/currentUser", { token: "bogus", body: DEVICE })).status).toBe(401);
    const out = await t.call("POST", "/api/logout", { token, body: DEVICE });
    expect(out.status).toBe(200);
    expect((await t.call("POST", "/api/currentUser", { token, body: DEVICE })).status).toBe(401);
  });

  test("a client login makes the user the device's owner", async () => {
    const t = makeApp();
    const u = await t.user("erin", "password-5");
    await t.login("erin", "password-5");
    const row = t.db.query<{ user_id: number }, [string]>("SELECT user_id FROM devices WHERE id = ?").get(DEVICE.id);
    expect(row?.user_id).toBe(u.id);
  });
});

describe("heartbeat and sysinfo", () => {
  test("first heartbeat asks for sysinfo; sysinfo replies SYSINFO_UPDATED as plain text", async () => {
    const t = makeApp();
    const hb = await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, ver: 1005030, modified_at: 0 } });
    expect(hb.json).toEqual({ sysinfo: 1 });
    const si = await t.call("POST", "/api/sysinfo", {
      body: { ...DEVICE, cpu: "8/8 cores", memory: "7.5GB", os: "android / Android 14", hostname: "saga", version: "1.5.3" },
    });
    expect(si.text).toBe("SYSINFO_UPDATED");
    expect((await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, modified_at: 0 } })).json).toEqual({});
  });

  test("a different uuid for a bound id is ignored by heartbeat and refused by sysinfo", async () => {
    const t = makeApp();
    await t.call("POST", "/api/heartbeat", { body: { ...DEVICE } });
    const other = { id: DEVICE.id, uuid: "b3RoZXI=" };
    expect((await t.call("POST", "/api/heartbeat", { body: other })).json).toEqual({});
    expect((await t.call("POST", "/api/sysinfo", { body: { ...other, hostname: "evil" } })).text).toBe("ID_NOT_FOUND");
  });

  test("strategy is sent until the client echoes its modified_at", async () => {
    const t = makeApp();
    await t.call("POST", "/api/sysinfo", { body: { ...DEVICE, hostname: "h" } });
    const s = createStrategy(t.db, "locked", { "enable-file-transfer": "N", "api-server": "https://evil" });
    updateDevice(t.db, DEVICE.id, { strategyId: s.id });
    const first = await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, modified_at: 0 } });
    // Keys the client rejects are not sent at all.
    expect(first.json.strategy).toEqual({ config_options: { "enable-file-transfer": "N" }, extra: {} });
    expect(first.json.modified_at).toBe(s.modified_at);
    const again = await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, modified_at: s.modified_at } });
    expect(again.json).toEqual({});
  });

  test("strategy falls back from device to owner to device group", async () => {
    const t = makeApp();
    await t.call("POST", "/api/sysinfo", { body: { ...DEVICE, hostname: "h" } });
    const g = createDeviceGroup(t.db, "family");
    const viaGroup = createStrategy(t.db, "group", { "enable-audio": "N" });
    updateDeviceGroup(t.db, g.id, { strategyId: viaGroup.id });
    updateDevice(t.db, DEVICE.id, { deviceGroupId: g.id });
    expect((await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, modified_at: 0 } })).json.modified_at).toBe(viaGroup.modified_at);
    const own = createStrategy(t.db, "own", { "enable-audio": "Y" });
    updateDevice(t.db, DEVICE.id, { strategyId: own.id });
    expect((await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, modified_at: 0 } })).json.modified_at).toBe(own.modified_at);
  });

  test("pending disconnects go out once, and only for live connections", async () => {
    const t = makeApp();
    await t.call("POST", "/api/sysinfo", { body: { ...DEVICE, hostname: "h" } });
    requestDisconnect(t.db, DEVICE.id, 7);
    requestDisconnect(t.db, DEVICE.id, 99);
    const hb = await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, conns: [7, 8] } });
    expect(hb.json.disconnect).toEqual([7]);
    expect((await t.call("POST", "/api/heartbeat", { body: { ...DEVICE, conns: [7, 8] } })).json.disconnect).toBeUndefined();
  });
});

describe("address book", () => {
  async function setup() {
    const t = makeApp();
    await t.user("owner", "password-1");
    const token = await t.login("owner", "password-1");
    const guid = (await t.call("POST", "/api/ab/personal", { token, raw: "" })).json.guid as string;
    return { t, token, guid };
  }

  test("personal returns a guid; settings returns max_peer_one_ab", async () => {
    const { t, token, guid } = await setup();
    expect(typeof guid).toBe("string");
    expect((await t.call("POST", "/api/ab/personal", { token, raw: "" })).json.guid).toBe(guid);
    expect((await t.call("POST", "/api/ab/settings", { token, raw: "" })).json).toEqual({ max_peer_one_ab: 0 });
  });

  test("actions succeed with 200 and an EMPTY body; errors are {error}", async () => {
    const { t, token, guid } = await setup();
    const add = await t.call("POST", `/api/ab/peer/add/${guid}`, { token, body: { id: "111", alias: "pc", tags: ["home"], password: "dropped-for-personal" } });
    expect(add.status).toBe(200);
    expect(add.text).toBe("");
    const dup = await t.call("POST", `/api/ab/peer/add/${guid}`, { token, body: { id: "111" } });
    expect(dup.json).toEqual({ error: "Peer already exists" });

    const peers = await t.call("POST", `/api/ab/peers?current=1&pageSize=100&ab=${guid}`, { token, raw: "" });
    expect(peers.json.total).toBe(1);
    // Personal books never store a plaintext password.
    expect(peers.json.data).toEqual([{ id: "111", alias: "pc", tags: ["home"] }]);
  });

  test("peer update changes only the fields sent; empty hash forgets the password", async () => {
    const { t, token, guid } = await setup();
    await t.call("POST", `/api/ab/peer/add/${guid}`, { token, body: { id: "222", alias: "a", note: "n" } });
    expect((await t.call("PUT", `/api/ab/peer/update/${guid}`, { token, body: { id: "222", hash: "aGFzaA==" } })).text).toBe("");
    expect((await t.call("PUT", `/api/ab/peer/update/${guid}`, { token, body: { id: "222", username: "u", hostname: "h" } })).text).toBe("");
    let peer = (await t.call("POST", `/api/ab/peers?ab=${guid}`, { token, raw: "" })).json.data[0];
    expect(peer).toEqual({ id: "222", alias: "a", note: "n", hash: "aGFzaA==", username: "u", hostname: "h" });
    await t.call("PUT", `/api/ab/peer/update/${guid}`, { token, body: { id: "222", hash: "" } });
    peer = (await t.call("POST", `/api/ab/peers?ab=${guid}`, { token, raw: "" })).json.data[0];
    expect(peer.hash).toBeUndefined();
  });

  test("tags: list order, rename and delete propagate into peers", async () => {
    const { t, token, guid } = await setup();
    await t.call("POST", `/api/ab/tag/add/${guid}`, { token, body: { name: "work", color: 4288585374 } });
    await t.call("POST", `/api/ab/tag/add/${guid}`, { token, body: { name: "home", color: 1 } });
    await t.call("POST", `/api/ab/peer/add/${guid}`, { token, body: { id: "333", tags: ["work", "home"] } });
    expect((await t.call("POST", `/api/ab/tags/${guid}`, { token, raw: "" })).json).toEqual([
      { name: "work", color: 4288585374 },
      { name: "home", color: 1 },
    ]);
    expect((await t.call("PUT", `/api/ab/tag/rename/${guid}`, { token, body: { old: "work", new: "office" } })).text).toBe("");
    expect((await t.call("DELETE", `/api/ab/tag/${guid}`, { token, body: ["home"] })).text).toBe("");
    const peer = (await t.call("POST", `/api/ab/peers?ab=${guid}`, { token, raw: "" })).json.data[0];
    expect(peer.tags).toEqual(["office"]);
    expect((await t.call("PUT", `/api/ab/tag/update/${guid}`, { token, body: { name: "office", color: 5 } })).text).toBe("");
    expect((await t.call("DELETE", `/api/ab/peer/${guid}`, { token, body: ["333"] })).text).toBe("");
    expect((await t.call("POST", `/api/ab/peers?ab=${guid}`, { token, raw: "" })).json.total).toBe(0);
  });

  test("shared books: visible with the caller's rule; read-only cannot write; others cannot see", async () => {
    const t = makeApp();
    const admin = await t.user("root", "password-1", true);
    const reader = await t.user("reader", "password-2");
    await t.user("stranger", "password-3");
    const book = createSharedBook(t.db, admin.id, "Family", "", "shared-pass");
    updateSharedBook(t.db, book.guid, { rules: [{ userId: reader.id, rule: 1 }] });

    const rt = await t.login("reader", "password-2");
    const profiles = await t.call("POST", "/api/ab/shared/profiles?current=1&pageSize=100", { token: rt, raw: "" });
    expect(profiles.json.total).toBe(1);
    expect(profiles.json.data[0]).toMatchObject({ guid: book.guid, name: "Family", owner: "root", rule: 1, info: { password: "shared-pass" } });
    const denied = await t.call("POST", `/api/ab/peer/add/${book.guid}`, { token: rt, body: { id: "9" } });
    expect(denied.json).toEqual({ error: "Permission denied" });

    const st = await t.login("stranger", "password-3", { id: "555555555", uuid: "cw==" });
    expect((await t.call("POST", "/api/ab/shared/profiles", { token: st, raw: "" })).json.total).toBe(0);
    expect((await t.call("POST", `/api/ab/peers?ab=${book.guid}`, { token: st, raw: "" })).status).toBe(404);
  });

  test("shared books keep the plaintext shared password and drop the hash", async () => {
    const t = makeApp();
    const admin = await t.user("root", "password-1", true);
    const book = createSharedBook(t.db, admin.id, "Team");
    const token = await t.login("root", "password-1");
    await t.call("POST", `/api/ab/peer/add/${book.guid}`, { token, body: { id: "777", password: "pw", hash: "h" } });
    expect((await t.call("POST", `/api/ab/peers?ab=${book.guid}`, { token, raw: "" })).json.data).toEqual([{ id: "777", password: "pw" }]);
  });

  test("legacy blob round-trips; unset book is null", async () => {
    const { t, token } = await setup();
    expect((await t.call("GET", "/api/ab", { token })).text).toBe("null");
    const data = JSON.stringify({ tags: ["a"], peers: [{ id: "1" }], tag_colors: "{}" });
    expect((await t.call("POST", "/api/ab", { token, body: { data } })).status).toBe(200);
    expect((await t.call("GET", "/api/ab", { token })).json).toEqual({ data });
  });

  test("401 without a token", async () => {
    const t = makeApp();
    expect((await t.call("POST", "/api/ab/personal", { raw: "" })).status).toBe(401);
  });
});

describe("audit", () => {
  test("conn records: new, login, close; u64 session_id kept exactly; nonce dedupes; empty-body success", async () => {
    const t = makeApp();
    await t.call("POST", "/api/heartbeat", { body: DEVICE });
    const post = (raw: string) => t.call("POST", "/api/audit/conn", { raw });
    const opened = await post(`{"action":"new","ip":"203.0.113.9","id":"${DEVICE.id}","uuid":"${DEVICE.uuid}","conn_id":5,"session_id":0,"nonce":"n1"}`);
    expect(opened.status).toBe(200);
    expect(opened.text).toBe("");
    // 18446744073709551557 is above 2^53: a float parse would round it.
    const login = `{"peer":["987654321","Laptop"],"type":0,"primary_auth":2,"id":"${DEVICE.id}","uuid":"${DEVICE.uuid}","conn_id":5,"session_id":18446744073709551557,"nonce":"n2"}`;
    await post(login);
    await post(login); // client retry with the same nonce
    await post(`{"action":"close","id":"${DEVICE.id}","uuid":"${DEVICE.uuid}","conn_id":5,"session_id":18446744073709551557,"nonce":"n3"}`);

    const rows = t.db.query<any, []>("SELECT * FROM audit_conn").all();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: "18446744073709551557", peer_id: "987654321", peer_name: "Laptop", conn_type: 0, primary_auth: 2, ip: "203.0.113.9" });
    expect(rows[0].closed_at).not.toBeNull();

    await t.user("ctl", "password-1");
    const token = await t.login("ctl", "password-1", { id: "987654321", uuid: "bA==" });
    const active = await t.call("GET", `/api/audit/conn/active?id=${DEVICE.id}&session_id=18446744073709551557&conn_type=0`, { token });
    expect(active.json).toBe(rows[0].guid);
    expect((await t.call("PUT", "/api/audit", { token, body: { guid: rows[0].guid, note: "fixed printer" } })).status).toBe(200);
    expect(t.db.query<{ note: string }, []>("SELECT note FROM audit_conn").get()?.note).toBe("fixed printer");
  });

  test("file and alarm records store the JSON-encoded info", async () => {
    const t = makeApp();
    await t.call("POST", "/api/heartbeat", { body: DEVICE });
    const info = JSON.stringify({ ip: "1.2.3.4", name: "x", num: 1, files: [["a.txt", 3]] });
    expect((await t.call("POST", "/api/audit/file", { body: { ...DEVICE, peer_id: "9", conn_id: 1, type: 1, path: "/sdcard", is_file: false, info, nonce: "f1" } })).text).toBe("");
    expect((await t.call("POST", "/api/audit/alarm", { body: { ...DEVICE, typ: 2, info: JSON.stringify({ ip: "1.2.3.4" }), conn_id: 1, nonce: "a1" } })).text).toBe("");
    expect(JSON.parse(t.db.query<{ info: string }, []>("SELECT info FROM audit_file").get()?.info ?? "{}").files).toEqual([["a.txt", 3]]);
    expect(t.db.query<{ typ: number }, []>("SELECT typ FROM audit_alarm").get()?.typ).toBe(2);
  });
});

describe("accessible devices", () => {
  test("non-admins see themselves and their own and shared-group devices; admins see all", async () => {
    const t = makeApp();
    await t.user("admin", "password-1", true);
    const u = await t.user("kid", "password-2");
    const kidToken = await t.login("kid", "password-2");
    await t.call("POST", "/api/sysinfo", { body: { ...DEVICE, hostname: "kid-phone", os: "android / Android 14", username: "" } });
    const other = { id: "222222222", uuid: "b3RoZXI=" };
    await t.call("POST", "/api/sysinfo", { body: { ...other, hostname: "tv" } });

    const users = await t.call("GET", "/api/users?current=1&pageSize=100&accessible=&status=1", { token: kidToken });
    expect(users.json.data.map((x: any) => x.name)).toEqual(["kid"]);
    let peers = await t.call("GET", "/api/peers?current=1&pageSize=100&accessible=&status=1", { token: kidToken });
    expect(peers.json.data.map((x: any) => x.id)).toEqual([DEVICE.id]);
    expect(peers.json.data[0]).toMatchObject({ info: { os: "android / Android 14", device_name: "kid-phone" }, user_name: "kid" });

    const g = createDeviceGroup(t.db, "living room");
    updateDeviceGroup(t.db, g.id, { userIds: [u.id] });
    updateDevice(t.db, other.id, { deviceGroupId: g.id });
    peers = await t.call("GET", "/api/peers?accessible=", { token: kidToken });
    expect(peers.json.total).toBe(2);
    expect((await t.call("GET", "/api/device-group/accessible", { token: kidToken })).json).toEqual({ total: 1, data: [{ name: "living room" }] });

    const adminToken = await t.login("admin", "password-1", { id: "333333333", uuid: "YQ==" });
    expect((await t.call("GET", "/api/users?accessible=", { token: adminToken })).json.total).toBe(2);
  });
});

describe("documentation", () => {
  test("openapi.json documents the client and console routes", async () => {
    const t = makeApp();
    const doc = (await t.call("GET", "/openapi.json")).json;
    expect(doc.openapi).toBe("3.1.0");
    for (const p of ["/api/login", "/api/heartbeat", "/api/ab/peer/add/{guid}", "/api/audit/conn", "/api/admin/users", "/api/me/totp/setup"]) {
      expect(Object.keys(doc.paths)).toContain(p);
    }
  });

  test("unknown /api paths are JSON 404s", async () => {
    const t = makeApp();
    const r = await t.call("POST", "/api/nope", { raw: "" });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "Not found" });
  });
});
