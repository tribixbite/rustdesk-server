/**
 * Test harness: an app over an in-memory database, plus request helpers.
 */
import { loadConfig } from "../src/config";
import { openStore } from "../src/store";
import { createApp } from "../src/app";
import { createUser } from "../src/users";

export const DEVICE = { id: "123456789", uuid: "dXVpZC1vbmU=" };

export function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    PUBLIC_URL: "https://api.example.test",
    RENDEZVOUS_SERVER: "hbbs.example.test",
    RELAY_SERVER: "hbbr.example.test",
    KEY_PUB: "z+7KImTC1loA9Vwul3Sa0kL9HwRFOoD9y432sOVbq5Y=",
    WEB_DIR: "/nonexistent",
    ...env,
  });
  const db = openStore(":memory:");
  const app = createApp({ db, config });

  async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const res = await app.request(path, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json: json as any };
  }

  async function user(name: string, password: string, isAdmin = false) {
    return createUser(db, { name, password, isAdmin });
  }

  /** Logs in as the RustDesk client on DEVICE and returns the access token. */
  async function login(name: string, password: string, device = DEVICE): Promise<string> {
    const r = await call("POST", "/api/login", {
      body: { username: name, password, id: device.id, uuid: device.uuid, autoLogin: true, type: "account", deviceInfo: { os: "android", type: "client", name: "test" } },
    });
    if (r.status !== 200 || r.json?.type !== "access_token") throw new Error(`login failed: ${r.status} ${r.text}`);
    return r.json.access_token as string;
  }

  return { app, db, config, call, user, login };
}
