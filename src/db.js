// D1 schema for the platform. Tables are created on first use, so a fresh
// database (production or a preview) needs no manual migration step.
// Every statement is idempotent; add new columns with a new numbered step.
//
//   entries     every piece of content: idea, article, project, work
//   files       files attached to an entry (the bytes live in KV as "blob:<id>")
//   users       community members (the owner is not a row: ADMIN_PASSWORD)
//   invites     invite links for new members
//   api_tokens  keys for the future Claude connector (hashed)
//   settings    small key/value settings

export const KINDS = ['idea', 'article', 'project', 'work'];
export const VISIBILITY = ['private', 'members', 'public'];
export const STATUS = ['draft', 'published'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    slug TEXT,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    status TEXT NOT NULL DEFAULT 'draft',
    tags TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    pinned INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'studio',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS entries_kind_slug ON entries(kind, slug) WHERE slug IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS entries_list ON entries(kind, status, visibility, published_at)`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    entry_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS files_entry ON files(entry_id)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    request_note TEXT NOT NULL DEFAULT '',
    invite_code TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

// One schema check per worker instance (and per database, for tests).
const ready = new WeakMap();

export function db(env) {
  if (!env.DB) throw new Error('The DB binding is missing.');
  let p = ready.get(env.DB);
  if (!p) {
    p = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      ready.delete(env.DB);
      throw err;
    });
    ready.set(env.DB, p);
  }
  return p.then(() => env.DB);
}
