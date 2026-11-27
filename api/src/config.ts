/**
 * Runtime configuration, read once from the environment.
 *
 * Every value has a working default for local development; production values
 * are set as Railway service variables (see docs/railway.md).
 */

/** A configured OpenID Connect provider offered on the client's login dialog. */
export interface OidcProviderConfig {
  /** Name shown by the client and sent back as `op` (e.g. "google", "github"). */
  name: string;
  /** Issuer URL used for discovery (`/.well-known/openid-configuration`). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scopes; defaults to "openid email profile". */
  scopes?: string;
}

export interface Config {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** SQLite database file. */
  databasePath: string;
  /** Public base URL of this service, used for OIDC redirects and config export. */
  publicUrl: string;
  /** Bootstrap administrator, created only when the user table is empty. */
  adminUsername: string;
  adminPassword: string;
  /** Lifetime of client and console access tokens, in seconds. */
  tokenTtlSeconds: number;
  /** RustDesk server details shown in the console's client-config export. */
  rendezvousServer: string;
  relayServer: string;
  serverKey: string;
  oidcProviders: OidcProviderConfig[];
  /** Create an account on first OIDC login when no user matches the email. */
  oidcAutoCreate: boolean;
  /** Directory holding the built web console (index.html + bundle). */
  webDir: string;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function parseOidcProviders(raw: string | undefined): OidcProviderConfig[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("OIDC_PROVIDERS must be a JSON array");
  return parsed.map((p, i) => {
    const o = p as Record<string, unknown>;
    for (const key of ["name", "issuer", "clientId", "clientSecret"] as const) {
      if (typeof o[key] !== "string" || o[key] === "") {
        throw new Error(`OIDC_PROVIDERS[${i}].${key} must be a non-empty string`);
      }
    }
    return {
      name: o.name as string,
      issuer: o.issuer as string,
      clientId: o.clientId as string,
      clientSecret: o.clientSecret as string,
      scopes: typeof o.scopes === "string" ? o.scopes : undefined,
    };
  });
}

/** Builds the configuration from an environment map (defaults to process.env). */
export function loadConfig(env: Env = process.env): Config {
  const port = int(env, "API_PORT", 21114);
  return {
    port,
    databasePath: env.DATABASE_PATH ?? "./data/rustdesk-api.sqlite3",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    adminUsername: env.ADMIN_USERNAME ?? "admin",
    adminPassword: env.ADMIN_PASSWORD ?? "",
    tokenTtlSeconds: int(env, "TOKEN_TTL_SECONDS", 30 * 24 * 3600),
    rendezvousServer: env.RENDEZVOUS_SERVER ?? "",
    relayServer: env.RELAY_SERVER ?? "",
    serverKey: env.KEY_PUB ?? "",
    oidcProviders: parseOidcProviders(env.OIDC_PROVIDERS),
    oidcAutoCreate: (env.OIDC_AUTO_CREATE ?? "N").toUpperCase() === "Y",
    webDir: env.WEB_DIR ?? new URL("../dist/web", import.meta.url).pathname,
  };
}
