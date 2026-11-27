/**
 * Typed client for the console API. Response interfaces mirror the handlers and
 * zod schemas in src/routes/admin.ts, account.ts and oidc.ts.
 */

const TOKEN_KEY = "rustdesk-console-token";

/** Reads the stored access token; storage may be unavailable (private mode). */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

/** Fallback when localStorage throws, so a session still works for this tab. */
let memoryToken: string | null = null;

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked: the in-memory copy keeps this tab signed in.
  }
}

/** Listeners told when the server rejects the stored token (HTTP 401). */
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(f: () => void): () => void {
  unauthorizedListeners.add(f);
  return () => unauthorizedListeners.delete(f);
}

/** An API failure carrying the server's `error` text and the HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions {
  /** Send the bearer token and treat 401 as an expired session (default true). */
  auth?: boolean;
}

/**
 * Calls the API and returns the parsed JSON body (or undefined for an empty
 * body). Throws ApiError with the server's `error` message on a non-2xx reply.
 */
export async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Cannot reach the server", 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const msg = isErrorBody(data) ? data.error : `${res.status} ${res.statusText}`.trim();
    if (res.status === 401 && auth) {
      setToken(null);
      for (const f of unauthorizedListeners) f();
    }
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

function isErrorBody(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string";
}

export const get = <T>(path: string) => request<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
export const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const del = <T>(path: string) => request<T>("DELETE", path);

const enc = encodeURIComponent;

// ---- response types ----

export type UserStatus = 1 | 0 | -1;

/** AdminUserSchema in admin.ts. */
export interface AdminUser {
  guid: string;
  name: string;
  display_name: string;
  email: string;
  note: string;
  is_admin: boolean;
  status: UserStatus;
  totp_enabled: boolean;
  strategy_id: number | null;
  created_at: number;
}

/** UserPayloadSchema in account.ts. */
export interface UserPayload {
  name: string;
  display_name?: string | null;
  email: string | null;
  note: string | null;
  status: UserStatus;
  is_admin: boolean;
}

export type LoginReply =
  | { type: "access_token"; access_token: string; user: UserPayload }
  | { type: "email_check"; tfa_type?: string; secret: string; user: UserPayload };

export interface Overview {
  users: number;
  devices: number;
  online: number;
  shared_books: number;
  connections_24h: number;
  alarms_24h: number;
  server: {
    id_server: string;
    relay_server: string;
    api_server: string;
    key: string;
    config_string: string;
    oidc_providers: string[];
  };
}

export interface Device {
  id: string;
  uuid_bound: boolean;
  owner: { guid: string; name: string } | null;
  device_group_id: number | null;
  strategy_id: number | null;
  effective_strategy: string | null;
  note: string;
  device_name: string;
  hostname: string;
  username: string;
  os: string;
  cpu: string;
  memory: string;
  version: string;
  conns: number[];
  online: boolean;
  last_online: number;
  created_at: number;
}

export interface DevicePatch {
  user_guid?: string | null;
  device_group_id?: number | null;
  strategy_id?: number | null;
  note?: string;
  device_name?: string;
  clear_uuid?: boolean;
  request_sysinfo?: boolean;
}

export interface DeviceGroup {
  id: number;
  name: string;
  note: string;
  strategy_id: number | null;
  created_at: number;
  user_guids: string[];
}

export interface GroupBody {
  name?: string;
  note?: string;
  strategy_id?: number | null;
  user_guids?: string[];
}

export interface Strategy {
  id: number;
  name: string;
  note: string;
  config_options: Record<string, string>;
  extra: Record<string, unknown>;
  /** Milliseconds (a change marker clients compare), unlike the other timestamps. */
  modified_at: number;
  created_at: number;
}

export interface StrategyBody {
  name?: string;
  note?: string;
  options?: Record<string, string>;
}

/** OptionKind / StrategyOption in src/strategy-options.ts. */
export type OptionKind =
  | { type: "bool" }
  | { type: "enum"; values: Array<{ value: string; label: string }> }
  | { type: "number"; min?: number; max?: number }
  | { type: "text"; placeholder?: string };

export interface StrategyOption {
  key: string;
  label: string;
  group: string;
  kind: OptionKind;
}

export interface StrategyOptions {
  options: StrategyOption[];
  rejected: string[];
}

export type AbRule = 1 | 2 | 3;

export interface SharedBook {
  guid: string;
  name: string;
  note: string;
  owner: string;
  peers: number;
  has_password: boolean;
  rules: Array<{ user_guid: string; rule: AbRule }>;
  updated_at: number;
}

export interface BookBody {
  name?: string;
  note?: string;
  password?: string;
  rules?: Array<{ user_guid: string; rule: AbRule }>;
}

/** A peer of a shared book (password replaced by has_password). */
export interface BookPeer {
  id: string;
  username?: string;
  hostname?: string;
  platform?: string;
  alias?: string;
  tags?: string[];
  note?: string;
  has_password: boolean;
}

export interface Page<T> {
  total: number;
  data: T[];
}

/** ConnAuditRow in src/audit.ts. */
export interface ConnAudit {
  guid: string;
  device_id: string;
  conn_id: number;
  session_id: string;
  ip: string;
  peer_id: string;
  peer_name: string;
  conn_type: number | null;
  primary_auth: number | null;
  two_factor: number | null;
  conn_audit_ref: string;
  note: string;
  created_at: number;
  authorized_at: number | null;
  closed_at: number | null;
}

export interface FileAudit {
  id: number;
  device_id: string;
  peer_id: string;
  conn_id: number;
  /** 0 sent from the device, 1 received by the device. */
  type: number;
  path: string;
  is_file: number;
  info: unknown;
  created_at: number;
}

export interface AlarmAudit {
  id: number;
  device_id: string;
  typ: number;
  typ_name: string;
  info: unknown;
  conn_id: number;
  conn_audit_ref: string;
  created_at: number;
}

export type TokenKind = "client" | "console" | "api";

/** TokenSummary in src/users.ts. */
export interface TokenSummary {
  token_hash: string;
  user_id: number;
  kind: TokenKind;
  label: string;
  device_id: string;
  device_info: unknown;
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
}

export interface AdminToken extends TokenSummary {
  user: string;
}

export interface Settings {
  max_peer_one_ab: number;
  audit_retention_days: number;
}

export interface UserCreate {
  name: string;
  password: string;
  display_name?: string;
  email?: string;
  note?: string;
  is_admin?: boolean;
}

export interface UserPatch {
  display_name?: string;
  email?: string;
  note?: string;
  is_admin?: boolean;
  status?: UserStatus;
  password?: string;
  strategy_id?: number | null;
}

// ---- endpoints ----

const DEVICE_INFO = { type: "browser", os: "web", name: "Web console" };

export const Api = {
  login: (username: string, password: string) =>
    request<LoginReply>("POST", "/api/login", { username, password, type: "account", deviceInfo: DEVICE_INFO }, { auth: false }),
  loginTotp: (secret: string, code: string) =>
    request<LoginReply>("POST", "/api/login", { type: "email_code", secret, verificationCode: code, tfaCode: code, deviceInfo: DEVICE_INFO }, { auth: false }),
  loginOptions: () => request<string[]>("GET", "/api/login-options", undefined, { auth: false }),
  oidcAuth: (op: string) => request<{ code: string; url: string }>("POST", "/api/oidc/auth", { op, deviceInfo: { type: "browser" } }, { auth: false }),
  oidcQuery: (code: string) =>
    request<{ access_token?: string; error?: string }>("GET", `/api/oidc/auth-query?code=${enc(code)}&id=`, undefined, { auth: false }),
  logout: () => post<void>("/api/logout"),

  me: () => get<AdminUser>("/api/me"),
  changePassword: (current: string, next: string) => post<{ access_token: string }>("/api/me/password", { current, new: next }),
  totpSetup: () => post<{ secret: string; uri: string }>("/api/me/totp/setup"),
  totpEnable: (secret: string, code: string) => post<{ ok: true }>("/api/me/totp/enable", { secret, code }),
  totpDisable: (code: string) => post<{ ok: true }>("/api/me/totp/disable", { code }),
  mySessions: () => get<TokenSummary[]>("/api/me/sessions"),
  logoutEverywhere: () => post<void>("/api/me/logout-everywhere"),

  overview: () => get<Overview>("/api/admin/overview"),

  users: () => get<AdminUser[]>("/api/admin/users"),
  createUser: (b: UserCreate) => post<AdminUser>("/api/admin/users", b),
  updateUser: (guid: string, b: UserPatch) => patch<AdminUser>(`/api/admin/users/${enc(guid)}`, b),
  resetTotp: (guid: string) => post<{ ok: true }>(`/api/admin/users/${enc(guid)}/reset-totp`),
  deleteUser: (guid: string) => del<{ ok: true }>(`/api/admin/users/${enc(guid)}`),

  devices: () => get<Device[]>("/api/admin/devices"),
  updateDevice: (id: string, b: DevicePatch) => patch<{ ok: true }>(`/api/admin/devices/${enc(id)}`, b),
  disconnect: (id: string, connId: number) => post<{ ok: true }>(`/api/admin/devices/${enc(id)}/disconnect`, { conn_id: connId }),
  deleteDevice: (id: string) => del<{ ok: true }>(`/api/admin/devices/${enc(id)}`),

  groups: () => get<DeviceGroup[]>("/api/admin/device-groups"),
  createGroup: (b: GroupBody) => post<{ id: number }>("/api/admin/device-groups", b),
  updateGroup: (id: number, b: GroupBody) => patch<{ ok: true }>(`/api/admin/device-groups/${id}`, b),
  deleteGroup: (id: number) => del<{ ok: true }>(`/api/admin/device-groups/${id}`),

  strategies: () => get<Strategy[]>("/api/admin/strategies"),
  strategyOptions: () => get<StrategyOptions>("/api/admin/strategy-options"),
  createStrategy: (b: StrategyBody) => post<{ id: number }>("/api/admin/strategies", b),
  updateStrategy: (id: number, b: StrategyBody) => patch<{ ok: true }>(`/api/admin/strategies/${id}`, b),
  deleteStrategy: (id: number) => del<{ ok: true }>(`/api/admin/strategies/${id}`),

  books: () => get<SharedBook[]>("/api/admin/address-books"),
  createBook: (b: BookBody) => post<{ guid: string }>("/api/admin/address-books", b),
  updateBook: (guid: string, b: BookBody) => patch<{ ok: true }>(`/api/admin/address-books/${enc(guid)}`, b),
  bookPeers: (guid: string) => get<BookPeer[]>(`/api/admin/address-books/${enc(guid)}/peers`),
  deleteBook: (guid: string) => del<{ ok: true }>(`/api/admin/address-books/${enc(guid)}`),

  connAudit: (current: number, pageSize: number) => get<Page<ConnAudit>>(`/api/admin/audit/conn?current=${current}&pageSize=${pageSize}`),
  fileAudit: (current: number, pageSize: number) => get<Page<FileAudit>>(`/api/admin/audit/file?current=${current}&pageSize=${pageSize}`),
  alarmAudit: (current: number, pageSize: number) => get<Page<AlarmAudit>>(`/api/admin/audit/alarm?current=${current}&pageSize=${pageSize}`),

  tokens: () => get<AdminToken[]>("/api/admin/tokens"),
  createToken: (label: string) => post<{ token: string }>("/api/admin/tokens", { label }),
  revokeToken: (hash: string) => del<{ ok: true }>(`/api/admin/tokens/${enc(hash)}`),

  settings: () => get<Settings>("/api/admin/settings"),
  updateSettings: (b: Partial<Settings>) => patch<Settings>("/api/admin/settings", b),
} as const;
