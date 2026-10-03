// D1 schema for the platform. Tables are created on first use, so a fresh
// database (production or a preview) needs no manual migration step.
// Every statement is idempotent; add new columns with a new numbered step.
//
//   spaces      the site's wings (music, books, ...) and what lives inside a
//               wing: a book, a sketch series, a genre. Each wing, and any
//               space that says so, has its own community.
//   space_members  who belongs to which community (requests wait for the owner)
//   entries     every piece of content: a song, a chapter, an article, a project...
//   comments    what the community says about an item (optionally one paragraph)
//               or about a blog post: entry_id holds the id of either (both are UUIDs)
//   posts       community blog posts, one blog per community (a wing, or a space
//               with its own community); space_id is that community's space
//   mentions    who was tagged where (@ in a comment or a post), for the member's page
//   files       files attached to an entry (the bytes live in KV as "blob:<id>")
//   users       community members (the owner is not a row: ADMIN_PASSWORD)
//   invites     invite links for new members
//   api_tokens  keys for the future Claude connector (hashed)
//   settings    small key/value settings

export const KINDS = ['idea', 'article', 'project', 'work', 'song', 'chapter', 'torah', 'sketch', 'dub', 'humor', 'video'];
// private: only the owner. community: the community of the item's space.
// members: anyone signed in. public: everyone.
export const VISIBILITY = ['private', 'community', 'members', 'public'];

// The wings. Their ids are fixed: pages and the studio address them by id.
export const WINGS = [
  { id: 'music', title: 'מוזיקה', en: 'Music', kind: 'song' },
  { id: 'books', title: 'ספרים', en: 'Books', kind: 'chapter' },
  { id: 'sketches', title: 'מערכונים', en: 'Sketches', kind: 'sketch' },
  { id: 'humor', title: 'דיבובים והומור', en: 'Dubbing & humor', kind: 'dub' },
  { id: 'torah', title: 'דברי תורה', en: 'Torah', kind: 'torah' },
  { id: 'articles', title: 'מאמרים', en: 'Articles', kind: 'article' },
  { id: 'software', title: 'תוכנה', en: 'Software', kind: 'project' },
  { id: 'videos', title: 'סרטונים', en: 'Videos', kind: 'video' },
];
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
  `CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    wing TEXT NOT NULL,
    parent_id TEXT,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'collection',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'public',
    join_mode TEXT NOT NULL DEFAULT 'request',
    own_community INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS spaces_slug ON spaces(wing, slug)`,
  `CREATE TABLE IF NOT EXISTS space_members (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    PRIMARY KEY (space_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS space_members_user ON space_members(user_id, status)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    user_id TEXT,
    author TEXT NOT NULL,
    anchor INTEGER,
    quote TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    reply_to TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS comments_entry ON comments(entry_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS comments_recent ON comments(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    user_id TEXT,
    author TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'visible',
    public INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS posts_slug ON posts(space_id, slug)`,
  `CREATE INDEX IF NOT EXISTS posts_recent ON posts(space_id, pinned, created_at)`,
  `CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS mentions (
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    by_user TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, source_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS mentions_user ON mentions(user_id, created_at)`,
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

// Columns added after a table first shipped, with what to fill them with.
const COLUMNS = [
  {
    table: 'entries',
    column: 'space_id',
    sql: 'ALTER TABLE entries ADD COLUMN space_id TEXT',
    backfill: [
      `UPDATE entries SET space_id = 'articles' WHERE kind = 'article' AND space_id IS NULL`,
      `UPDATE entries SET space_id = 'software' WHERE kind = 'project' AND space_id IS NULL`,
    ],
  },
];

async function migrate(DB) {
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  for (const c of COLUMNS) {
    const { results } = await DB.prepare(`PRAGMA table_info(${c.table})`).all();
    if (results.some((r) => r.name === c.column)) continue;
    try {
      await DB.prepare(c.sql).run();
    } catch (err) {
      // Another instance added it first.
      if (!/duplicate column/i.test(String(err?.message))) throw err;
      continue;
    }
    for (const sql of c.backfill) await DB.prepare(sql).run();
  }
  await DB.prepare('CREATE INDEX IF NOT EXISTS entries_space ON entries(space_id, status)').run();
  const now = new Date().toISOString();
  await DB.batch(
    WINGS.map((w, i) =>
      DB.prepare(
        `INSERT OR IGNORE INTO spaces (id, wing, parent_id, slug, kind, title, visibility, join_mode, own_community, sort, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'wing', ?, 'public', 'request', 1, ?, ?, ?)`,
      ).bind(w.id, w.id, w.id, w.title, i, now, now),
    ),
  );
}

// One schema check per worker instance (and per database, for tests).
const ready = new WeakMap();

export function db(env) {
  if (!env.DB) throw new Error('The DB binding is missing.');
  let p = ready.get(env.DB);
  if (!p) {
    p = migrate(env.DB).catch((err) => {
      ready.delete(env.DB);
      throw err;
    });
    ready.set(env.DB, p);
  }
  return p.then(() => env.DB);
}
