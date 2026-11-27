/**
 * Entry point: load configuration, open the database, create the bootstrap
 * administrator if needed, start the HTTP server and periodic cleanup.
 */
import { loadConfig } from "./config";
import { openStore, now } from "./store";
import { ensureBootstrapAdmin } from "./users";
import { pruneNonces } from "./audit";
import { getSetting } from "./settings";
import { createApp } from "./app";

const config = loadConfig();
const db = openStore(config.databasePath);

if (await ensureBootstrapAdmin(db, config.adminUsername, config.adminPassword)) {
  console.log(`Created administrator "${config.adminUsername}"`);
}

/** Expired sessions, finished logins and audit records past retention. */
function cleanup(): void {
  const t = now();
  db.query("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").run(t);
  db.query("DELETE FROM pending_logins WHERE expires_at <= ?").run(t);
  db.query("DELETE FROM oidc_sessions WHERE expires_at <= ?").run(t);
  pruneNonces(db);
  const days = getSetting(db, "audit_retention_days");
  if (days > 0) {
    const cutoff = t - days * 86400;
    for (const table of ["audit_conn", "audit_file", "audit_alarm"]) {
      db.query(`DELETE FROM ${table} WHERE created_at < ?`).run(cutoff);
    }
  }
}
cleanup();
setInterval(cleanup, 3600_000);

const app = createApp({ db, config });
const server = Bun.serve({ port: config.port, hostname: "::", fetch: app.fetch });
console.log(`RustDesk API listening on ${server.url} (public URL ${config.publicUrl})`);
