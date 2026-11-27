/**
 * SQLite storage: opening the database and applying schema migrations.
 *
 * Migrations are append-only. Each entry runs once, in order, inside a
 * transaction, and `PRAGMA user_version` records how many have been applied.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    guid          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    status        INTEGER NOT NULL DEFAULT 1,      -- 1 normal, 0 disabled, -1 unverified
    totp_secret   TEXT,                            -- base32; NULL when TOTP is off
    strategy_id   INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- Access tokens. Only a SHA-256 of each token is stored.
  CREATE TABLE tokens (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('client', 'console', 'api')),
    label        TEXT NOT NULL DEFAULT '',
    device_id    TEXT NOT NULL DEFAULT '',
    device_uuid  TEXT NOT NULL DEFAULT '',
    device_info  TEXT NOT NULL DEFAULT '{}',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at   INTEGER                          -- NULL: no expiry (API tokens)
  );
  CREATE INDEX tokens_user ON tokens(user_id);

  -- Step 1 of a two-factor login, waiting for the TOTP code.
  CREATE TABLE pending_logins (
    secret      TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL DEFAULT '',
    device_uuid TEXT NOT NULL DEFAULT '',
    device_info TEXT NOT NULL DEFAULT '{}',
    kind        TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE strategies (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    note           TEXT NOT NULL DEFAULT '',
    config_options TEXT NOT NULL DEFAULT '{}',    -- JSON {option: value}
    extra          TEXT NOT NULL DEFAULT '{}',
    modified_at    INTEGER NOT NULL,              -- echoed by clients; changes on every edit
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE device_groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    note        TEXT NOT NULL DEFAULT '',
    strategy_id INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
  );

  -- Users who may see the devices of a group in "Accessible devices".
  CREATE TABLE device_group_access (
    device_group_id INTEGER NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (device_group_id, user_id)
  );

  CREATE TABLE devices (
    id                 TEXT PRIMARY KEY,           -- RustDesk ID
    uuid               TEXT NOT NULL DEFAULT '',   -- bound on first contact
    user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    device_group_id    INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
    strategy_id        INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
    note               TEXT NOT NULL DEFAULT '',
    device_name        TEXT NOT NULL DEFAULT '',   -- admin override of hostname
    hostname           TEXT NOT NULL DEFAULT '',
    username           TEXT NOT NULL DEFAULT '',
    os                 TEXT NOT NULL DEFAULT '',
    cpu                TEXT NOT NULL DEFAULT '',
    memory             TEXT NOT NULL DEFAULT '',
    version            TEXT NOT NULL DEFAULT '',
    sysinfo            TEXT NOT NULL DEFAULT '{}',
    conns              TEXT NOT NULL DEFAULT '[]', -- live connection ids from the last heartbeat
    sysinfo_requested  INTEGER NOT NULL DEFAULT 0,
    last_online        INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE INDEX devices_group ON devices(device_group_id);

  -- Connections an administrator asked to close, delivered by the next heartbeat.
  CREATE TABLE pending_disconnects (
    device_id  TEXT NOT NULL,
    conn_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, conn_id)
  );

  CREATE TABLE address_books (
    guid       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    personal   INTEGER NOT NULL DEFAULT 0,
    note       TEXT NOT NULL DEFAULT '',
    info       TEXT NOT NULL DEFAULT '{}',        -- JSON; {password} = default shared password
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX address_books_personal ON address_books(owner_id) WHERE personal = 1;

  -- Shared-book permissions: 1 read, 2 read/write, 3 full control.
  CREATE TABLE ab_rules (
    ab_guid TEXT NOT NULL REFERENCES address_books(guid) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule    INTEGER NOT NULL CHECK (rule BETWEEN 1 AND 3),
    PRIMARY KEY (ab_guid, user_id)
  );

  CREATE TABLE ab_peers (
    ab_guid    TEXT NOT NULL REFERENCES address_books(guid) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',        -- JSON of every other peer field
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ab_guid, id)
  );

  CREATE TABLE ab_tags (
    ab_guid TEXT NOT NULL REFERENCES address_books(guid) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    color   INTEGER NOT NULL DEFAULT 0,
    sort    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ab_guid, name)
  );

  -- Whole-book blob of the legacy address-book API (old desktop UI).
  CREATE TABLE legacy_ab (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE audit_conn (
    guid           TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL,
    conn_id        INTEGER NOT NULL,
    session_id     TEXT NOT NULL DEFAULT '0',      -- u64 kept as text (exceeds 2^53)
    ip             TEXT NOT NULL DEFAULT '',
    peer_id        TEXT NOT NULL DEFAULT '',
    peer_name      TEXT NOT NULL DEFAULT '',
    conn_type      INTEGER,
    primary_auth   INTEGER,
    two_factor     INTEGER,
    conn_audit_ref TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    authorized_at  INTEGER,
    closed_at      INTEGER
  );
  CREATE INDEX audit_conn_device ON audit_conn(device_id, conn_id);
  CREATE INDEX audit_conn_session ON audit_conn(device_id, session_id);
  CREATE INDEX audit_conn_created ON audit_conn(created_at);

  CREATE TABLE audit_file (
    id         INTEGER PRIMARY KEY,
    device_id  TEXT NOT NULL,
    peer_id    TEXT NOT NULL DEFAULT '',
    conn_id    INTEGER NOT NULL DEFAULT 0,
    type       INTEGER NOT NULL,                  -- 0 sent from device, 1 received by device
    path       TEXT NOT NULL DEFAULT '',
    is_file    INTEGER NOT NULL DEFAULT 0,
    info       TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_file_created ON audit_file(created_at);

  CREATE TABLE audit_alarm (
    id             INTEGER PRIMARY KEY,
    device_id      TEXT NOT NULL,
    typ            INTEGER NOT NULL,
    info           TEXT NOT NULL DEFAULT '{}',
    conn_id        INTEGER NOT NULL DEFAULT 0,
    conn_audit_ref TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX audit_alarm_created ON audit_alarm(created_at);

  -- Audit nonces already stored, so client retries are not recorded twice.
  CREATE TABLE audit_nonces (
    nonce      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE oidc_sessions (
    code          TEXT PRIMARY KEY,               -- handed to the client, polled by it
    state         TEXT NOT NULL UNIQUE,           -- sent to the provider
    op            TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    device_id     TEXT NOT NULL DEFAULT '',
    device_uuid   TEXT NOT NULL DEFAULT '',
    device_info   TEXT NOT NULL DEFAULT '{}',
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    access_token  TEXT,                           -- raw token, cleared once delivered
    error         TEXT,
    expires_at    INTEGER NOT NULL
  );

  CREATE TABLE switch_grants (
    verifier   TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    timestamp  INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Console-editable settings (JSON values).
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

/** Current Unix time in seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Opens (creating if needed) the database at `path` and migrates it. ":memory:" for tests. */
export function openStore(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const applied = row?.user_version ?? 0;
  for (let i = applied; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i];
    if (sql === undefined) continue;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}

/** Parses a JSON column, falling back when the stored text is not valid JSON. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
