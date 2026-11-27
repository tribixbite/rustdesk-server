/**
 * Address books: one personal book per user plus shared books with per-user rules.
 * Shapes follow client-api-spec section 7.
 */
import type { Database } from "bun:sqlite";
import { now, parseJson } from "./store";
import { newGuid } from "./security";

/** 1 read-only, 2 read/write, 3 full control. */
export type AbRule = 1 | 2 | 3;
export const RULE_READ: AbRule = 1;
export const RULE_WRITE: AbRule = 2;
export const RULE_FULL: AbRule = 3;

export interface AddressBookRow {
  guid: string;
  name: string;
  owner_id: number;
  personal: number;
  note: string;
  info: string;
  created_at: number;
  updated_at: number;
}

/** Peer fields the client sends and reads (client-api-spec 7.5); `id` is the key. */
export const PEER_FIELDS = [
  "hash",
  "password",
  "username",
  "hostname",
  "platform",
  "alias",
  "tags",
  "forceAlwaysRelay",
  "rdpPort",
  "rdpUsername",
  "loginName",
  "device_group_name",
  "note",
  "same_server",
] as const;
export type PeerField = (typeof PEER_FIELDS)[number];
export type PeerData = Partial<Record<PeerField, unknown>>;

export interface AbPeer extends PeerData {
  id: string;
}

export interface AbTag {
  name: string;
  color: number;
}

export class AbError extends Error {}

/** The caller's personal book, created on first use. */
export function personalBook(db: Database, userId: number): AddressBookRow {
  const existing = db
    .query<AddressBookRow, [number]>("SELECT * FROM address_books WHERE owner_id = ? AND personal = 1")
    .get(userId);
  if (existing) return existing;
  const t = now();
  const row = db
    .query<AddressBookRow, [string, string, number, number, number]>(
      `INSERT INTO address_books (guid, name, owner_id, personal, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?) RETURNING *`,
    )
    .get(newGuid(), "My address book", userId, t, t);
  if (!row) throw new Error("insert returned no row");
  return row;
}

export function getBook(db: Database, guid: string): AddressBookRow | null {
  return db.query<AddressBookRow, [string]>("SELECT * FROM address_books WHERE guid = ?").get(guid);
}

/**
 * The caller's rule on a book: full control of their own books (and every book
 * for administrators), otherwise the shared rule, or null for no access.
 */
export function ruleFor(db: Database, book: AddressBookRow, userId: number, isAdmin: boolean): AbRule | null {
  if (book.owner_id === userId) return RULE_FULL;
  // The personal book of another user is private, even to administrators.
  if (book.personal === 1) return null;
  if (isAdmin) return RULE_FULL;
  const r = db
    .query<{ rule: number }, [string, number]>("SELECT rule FROM ab_rules WHERE ab_guid = ? AND user_id = ?")
    .get(book.guid, userId);
  return r ? (r.rule as AbRule) : null;
}

/** Loads a book and checks the caller holds at least `min`. */
export function requireBook(db: Database, guid: string, userId: number, isAdmin: boolean, min: AbRule): AddressBookRow {
  const book = getBook(db, guid);
  const rule = book ? ruleFor(db, book, userId, isAdmin) : null;
  if (!book || rule === null) throw new AbError("Address book not found");
  if (rule < min) throw new AbError("Permission denied");
  return book;
}

export interface SharedProfile {
  guid: string;
  name: string;
  owner: string;
  note: string;
  rule: AbRule;
  info: unknown;
}

/** Shared books visible to the caller, with the caller's rule on each. */
export function sharedProfiles(db: Database, userId: number, isAdmin: boolean): SharedProfile[] {
  const rows = db
    .query<AddressBookRow & { owner_name: string }, []>(
      `SELECT b.*, u.name AS owner_name FROM address_books b JOIN users u ON u.id = b.owner_id
       WHERE b.personal = 0 ORDER BY b.name`,
    )
    .all();
  const out: SharedProfile[] = [];
  for (const b of rows) {
    const rule = ruleFor(db, b, userId, isAdmin);
    if (rule === null) continue;
    out.push({ guid: b.guid, name: b.name, owner: b.owner_name, note: b.note, rule, info: parseJson(b.info, {}) });
  }
  return out;
}

function touchBook(db: Database, guid: string): void {
  db.query("UPDATE address_books SET updated_at = ? WHERE guid = ?").run(now(), guid);
}

/** Keeps only known peer fields, and drops the secret the book type must not hold. */
function sanitizePeer(book: AddressBookRow, input: Record<string, unknown>): PeerData {
  const out: PeerData = {};
  for (const f of PEER_FIELDS) {
    if (input[f] !== undefined) out[f] = input[f];
  }
  if (Array.isArray(out.tags)) out.tags = out.tags.filter((t): t is string => typeof t === "string");
  else if (out.tags !== undefined) delete out.tags;
  // Personal books hold the password hash; shared books the plaintext shared password.
  if (book.personal === 1) delete out.password;
  else delete out.hash;
  return out;
}

export function listPeers(db: Database, guid: string): AbPeer[] {
  return db
    .query<{ id: string; data: string }, [string]>("SELECT id, data FROM ab_peers WHERE ab_guid = ? ORDER BY id")
    .all(guid)
    .map((r) => ({ id: r.id, ...parseJson<PeerData>(r.data, {}) }));
}

export function countPeers(db: Database, guid: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ab_peers WHERE ab_guid = ?").get(guid)?.n ?? 0;
}

export function addPeer(db: Database, book: AddressBookRow, input: Record<string, unknown>, maxPeers: number): void {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) throw new AbError("Invalid peer id");
  if (maxPeers > 0 && countPeers(db, book.guid) >= maxPeers) throw new AbError("exceed_max_devices");
  const t = now();
  const exists = db.query<{ id: string }, [string, string]>("SELECT id FROM ab_peers WHERE ab_guid = ? AND id = ?").get(book.guid, id);
  if (exists) throw new AbError("Peer already exists");
  db.query("INSERT INTO ab_peers (ab_guid, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    book.guid,
    id,
    JSON.stringify(sanitizePeer(book, input)),
    t,
    t,
  );
  touchBook(db, book.guid);
}

/** Partial update: only the fields present in `input` change (client-api-spec 7.8). */
export function updatePeer(db: Database, book: AddressBookRow, input: Record<string, unknown>): void {
  const id = typeof input.id === "string" ? input.id : "";
  const row = db.query<{ data: string }, [string, string]>("SELECT data FROM ab_peers WHERE ab_guid = ? AND id = ?").get(book.guid, id);
  if (!row) throw new AbError("Peer not found");
  const merged = { ...parseJson<PeerData>(row.data, {}), ...sanitizePeer(book, input) };
  // An empty hash means "forget the saved password".
  if (merged.hash === "") delete merged.hash;
  db.query("UPDATE ab_peers SET data = ?, updated_at = ? WHERE ab_guid = ? AND id = ?").run(JSON.stringify(merged), now(), book.guid, id);
  touchBook(db, book.guid);
}

export function deletePeers(db: Database, book: AddressBookRow, ids: string[]): void {
  const del = db.query("DELETE FROM ab_peers WHERE ab_guid = ? AND id = ?");
  db.transaction(() => {
    for (const id of ids) del.run(book.guid, id);
  })();
  touchBook(db, book.guid);
}

export function listTags(db: Database, guid: string): AbTag[] {
  return db
    .query<AbTag, [string]>("SELECT name, color FROM ab_tags WHERE ab_guid = ? ORDER BY sort, name")
    .all(guid);
}

export function addTag(db: Database, book: AddressBookRow, name: string, color: number): void {
  if (!name) throw new AbError("Invalid tag name");
  const max = db.query<{ m: number | null }, [string]>("SELECT MAX(sort) AS m FROM ab_tags WHERE ab_guid = ?").get(book.guid)?.m ?? 0;
  db.query("INSERT OR REPLACE INTO ab_tags (ab_guid, name, color, sort) VALUES (?, ?, ?, ?)").run(book.guid, name, color, max + 1);
  touchBook(db, book.guid);
}

export function updateTagColor(db: Database, book: AddressBookRow, name: string, color: number): void {
  const r = db.query("UPDATE ab_tags SET color = ? WHERE ab_guid = ? AND name = ?").run(color, book.guid, name);
  if (r.changes === 0) throw new AbError("Tag not found");
  touchBook(db, book.guid);
}

/** Renames a tag and rewrites it inside every peer of the book. */
export function renameTag(db: Database, book: AddressBookRow, oldName: string, newName: string): void {
  if (!newName) throw new AbError("Invalid tag name");
  db.transaction(() => {
    const clash = db.query("SELECT 1 FROM ab_tags WHERE ab_guid = ? AND name = ?").get(book.guid, newName);
    if (clash) throw new AbError("Tag already exists");
    const r = db.query("UPDATE ab_tags SET name = ? WHERE ab_guid = ? AND name = ?").run(newName, book.guid, oldName);
    if (r.changes === 0) throw new AbError("Tag not found");
    rewritePeerTags(db, book.guid, (tags) => tags.map((t) => (t === oldName ? newName : t)));
  })();
  touchBook(db, book.guid);
}

/** Deletes tags and removes them from every peer of the book. */
export function deleteTags(db: Database, book: AddressBookRow, names: string[]): void {
  const drop = new Set(names);
  db.transaction(() => {
    const del = db.query("DELETE FROM ab_tags WHERE ab_guid = ? AND name = ?");
    for (const n of names) del.run(book.guid, n);
    rewritePeerTags(db, book.guid, (tags) => tags.filter((t) => !drop.has(t)));
  })();
  touchBook(db, book.guid);
}

function rewritePeerTags(db: Database, guid: string, f: (tags: string[]) => string[]): void {
  const rows = db.query<{ id: string; data: string }, [string]>("SELECT id, data FROM ab_peers WHERE ab_guid = ?").all(guid);
  const upd = db.query("UPDATE ab_peers SET data = ? WHERE ab_guid = ? AND id = ?");
  for (const r of rows) {
    const data = parseJson<PeerData>(r.data, {});
    if (!Array.isArray(data.tags)) continue;
    const before = data.tags as string[];
    const after = f(before);
    if (after.length !== before.length || after.some((t, i) => t !== before[i])) {
      upd.run(JSON.stringify({ ...data, tags: after }), guid, r.id);
    }
  }
}

// ---- shared-book management (console) ----

export function createSharedBook(db: Database, ownerId: number, name: string, note = "", password = ""): AddressBookRow {
  if (!name.trim()) throw new AbError("Invalid name");
  const t = now();
  const info = password ? JSON.stringify({ password }) : "{}";
  const row = db
    .query<AddressBookRow, [string, string, number, string, string, number, number]>(
      `INSERT INTO address_books (guid, name, owner_id, personal, note, info, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?) RETURNING *`,
    )
    .get(newGuid(), name.trim(), ownerId, note, info, t, t);
  if (!row) throw new Error("insert returned no row");
  return row;
}

export function updateSharedBook(
  db: Database,
  guid: string,
  p: { name?: string; note?: string; password?: string; rules?: Array<{ userId: number; rule: AbRule }> },
): void {
  db.transaction(() => {
    if (p.name !== undefined) db.query("UPDATE address_books SET name = ? WHERE guid = ? AND personal = 0").run(p.name, guid);
    if (p.note !== undefined) db.query("UPDATE address_books SET note = ? WHERE guid = ? AND personal = 0").run(p.note, guid);
    if (p.password !== undefined) {
      const info = p.password ? JSON.stringify({ password: p.password }) : "{}";
      db.query("UPDATE address_books SET info = ? WHERE guid = ? AND personal = 0").run(info, guid);
    }
    if (p.rules !== undefined) {
      db.query("DELETE FROM ab_rules WHERE ab_guid = ?").run(guid);
      const ins = db.query("INSERT INTO ab_rules (ab_guid, user_id, rule) VALUES (?, ?, ?)");
      for (const r of p.rules) ins.run(guid, r.userId, r.rule);
    }
  })();
  touchBook(db, guid);
}

export function bookRules(db: Database, guid: string): Array<{ user_id: number; rule: AbRule }> {
  return db.query<{ user_id: number; rule: AbRule }, [string]>("SELECT user_id, rule FROM ab_rules WHERE ab_guid = ?").all(guid);
}

export function listSharedBooks(db: Database): Array<AddressBookRow & { owner_name: string; peers: number }> {
  return db
    .query<AddressBookRow & { owner_name: string; peers: number }, []>(
      `SELECT b.*, u.name AS owner_name, (SELECT COUNT(*) FROM ab_peers p WHERE p.ab_guid = b.guid) AS peers
       FROM address_books b JOIN users u ON u.id = b.owner_id WHERE b.personal = 0 ORDER BY b.name`,
    )
    .all();
}

export function deleteBook(db: Database, guid: string): void {
  db.query("DELETE FROM address_books WHERE guid = ? AND personal = 0").run(guid);
}

// ---- legacy whole-book blob (client-api-spec 7.4) ----

export function getLegacyBlob(db: Database, userId: number): string | null {
  return db.query<{ data: string }, [number]>("SELECT data FROM legacy_ab WHERE user_id = ?").get(userId)?.data ?? null;
}

export function setLegacyBlob(db: Database, userId: number, data: string): void {
  db.query(
    `INSERT INTO legacy_ab (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(userId, data, now());
}
