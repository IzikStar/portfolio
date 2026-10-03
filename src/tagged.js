// What a member sees about themselves on their page (/community): where they
// were tagged and which items credit them. Also the credits line on an item
// page. Credits live in the entry's meta as [{ role, userId }], set by the
// owner in the studio; names are looked up on every render so renames follow.
import { db } from './db.js';
import { escapeHtml as e } from './markdown.js';
import { getEntry, listCredited } from './entries.js';
import { canComment, OWNER_NAME } from './comments.js';
import { getPost, canReadPost, canCommentPost, postPath } from './posts.js';
import { entryPath, fmtDate } from './site.js';

const LIMIT = 40;

async function names(env, ids) {
  if (!ids.length) return new Map();
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT id, display_name FROM users WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...new Set(ids)]))
    .all();
  return new Map(results.map((r) => [r.id, r.display_name]));
}

const creditsOf = (entry) => (Array.isArray(entry.meta?.credits) ? entry.meta.credits : []);

// "שירה: דנה · עריכה: יוסי" under an item's title. Credits to people who are
// gone or suspended are left out.
export async function creditsLine(env, entry) {
  const list = creditsOf(entry);
  if (!list.length) return '';
  const who = await names(env, list.map((c) => c.userId));
  const shown = list.filter((c) => who.has(c.userId));
  if (!shown.length) return '';
  return `<p class="credits">${shown.map((c) => `<span>${c.role ? `${e(c.role)}: ` : ''}<span class="mention" dir="auto">${e(who.get(c.userId))}</span></span>`).join('')}</p>`;
}

// Where this member was tagged, newest first, kept to what they can still open.
async function taggedFor(env, v) {
  const d = await db(env);
  const { results } = await d
    .prepare(
      `SELECT m.source, m.source_id, m.by_user, m.created_at, u.display_name AS by_name, c.entry_id AS comment_on
       FROM mentions m LEFT JOIN users u ON u.id = m.by_user
       LEFT JOIN comments c ON m.source = 'comment' AND c.id = m.source_id
       WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT ?`,
    )
    .bind(v.member.id, LIMIT)
    .all();
  const out = [];
  for (const r of results) {
    const by = r.by_user ? r.by_name : OWNER_NAME;
    if (!by) continue;
    if (r.source === 'post') {
      const post = await getPost(env, r.source_id);
      if (post && canReadPost(v, post)) out.push({ by, what: 'בפוסט', title: post.title, href: postPath(v.acc, post), at: r.created_at });
      continue;
    }
    if (!r.comment_on) continue;
    const entry = await getEntry(env, r.comment_on);
    if (entry) {
      const path = entryPath(v.acc, entry);
      if (path && canComment(v, entry)) out.push({ by, what: 'בתגובה על', title: entry.title, href: `${path}#c-${r.source_id}`, at: r.created_at });
      continue;
    }
    const post = await getPost(env, r.comment_on);
    if (post && canCommentPost(v, post)) out.push({ by, what: 'בתגובה על', title: post.title, href: `${postPath(v.acc, post)}#c-${r.source_id}`, at: r.created_at });
  }
  return out;
}

// The member's own block on /community.
export async function memberBlock(env, v) {
  if (!v.member) return '';
  const [tagged, credited] = await Promise.all([taggedFor(env, v), listCredited(env, v.acc, v.member.id)]);
  const tags = tagged.length
    ? `<ul class="tagged">${tagged
        .map((t) => `<li><span class="mention" dir="auto">${e(t.by)}</span> ${t.what} <a href="${e(t.href)}" dir="auto">${e(t.title)}</a><time datetime="${e(t.at)}">${e(fmtDate(t.at))}</time></li>`)
        .join('')}</ul>`
    : '<p class="empty">עוד אף אחד לא תייג אותך. כשמישהו יכתוב עליך @ בתגובה או בפוסט, זה יופיע כאן.</p>';
  const mine = credited
    .map((x) => ({ x, href: entryPath(v.acc, x), roles: creditsOf(x).filter((c) => c.userId === v.member.id).map((c) => c.role).filter(Boolean) }))
    .filter((c) => c.href);
  const credits = mine.length
    ? `<div class="section-head" style="margin-top:32px"><h2>הקרדיטים שלך</h2></div>
  <ul class="tagged">${mine.map((c) => `<li><a href="${e(c.href)}" dir="auto">${e(c.x.title)}</a>${c.roles.length ? `<span class="role">${e(c.roles.join(', '))}</span>` : ''}</li>`).join('')}</ul>`
    : '';
  return `<div class="section-head" style="margin-top:32px"><h2>תייגו אותך</h2></div>
  ${tags}
  ${credits}`;
}
