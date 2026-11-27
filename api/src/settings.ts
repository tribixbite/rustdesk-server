/**
 * Console-editable server settings, stored as JSON in the `settings` table.
 */
import type { Database } from "bun:sqlite";
import { parseJson } from "./store";

export interface Settings {
  /** Peers allowed per address book; 0 = unlimited. */
  max_peer_one_ab: number;
  /** Days of audit history kept; 0 = forever. */
  audit_retention_days: number;
}

export const DEFAULT_SETTINGS: Settings = {
  max_peer_one_ab: 0,
  audit_retention_days: 180,
};

export function getSetting<K extends keyof Settings>(db: Database, key: K): Settings[K] {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? parseJson<Settings[K]>(row.value, DEFAULT_SETTINGS[key]) : DEFAULT_SETTINGS[key];
}

export function getSettings(db: Database): Settings {
  return {
    max_peer_one_ab: getSetting(db, "max_peer_one_ab"),
    audit_retention_days: getSetting(db, "audit_retention_days"),
  };
}

export function setSettings(db: Database, patch: Partial<Settings>): Settings {
  const upsert = db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && k in DEFAULT_SETTINGS) upsert.run(k, JSON.stringify(v));
    }
  })();
  return getSettings(db);
}
