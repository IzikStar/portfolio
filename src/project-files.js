// Project files on an item: a song's Cubase project, a zip of the stems, any
// working file. meta.projects = [{ label, url, kind, visibility? }], where url
// is an uploaded file (/files/<id>) or a Drive link, kind is 'cubase' | 'zip'
// | 'other', and visibility is 'private' | 'community' | 'members' | 'public'.
// These are working files, so a missing visibility means the owner only.
import { escapeHtml as e, safeUrl } from './markdown.js';
import { canSee } from './spaces.js';

const KINDS = ['cubase', 'zip', 'other'];
const VISIBILITY = ['private', 'community', 'members', 'public'];

export function projectList(entry) {
  const list = Array.isArray(entry?.meta?.projects) ? entry.meta.projects : [];
  const out = [];
  for (const p of list.slice(0, 40)) {
    const url = p && typeof p.url === 'string' ? safeUrl(p.url) : null;
    if (!url || url.startsWith('#') || url.startsWith('mailto:')) continue;
    out.push({
      label: String(p.label ?? '').slice(0, 80),
      url,
      kind: KINDS.includes(p.kind) ? p.kind : 'other',
      visibility: VISIBILITY.includes(p.visibility) ? p.visibility : 'private',
    });
  }
  return out;
}

// May this viewer download this project file of this entry?
export function mayDownload(acc, entry, p) {
  if (acc.owner) return true;
  if (!canSee(acc, entry)) return false;
  if (p.visibility === 'public') return true;
  if (p.visibility === 'members') return acc.member;
  if (p.visibility === 'community') return Boolean(entry.spaceId && acc.communities.has(entry.spaceId));
  return false;
}

const KIND_NAME = { cubase: 'פרויקט קיובייס', zip: 'ZIP', other: 'קובץ' };
const VIS_NAME = { private: 'רק אני', community: 'לקהילה', members: 'לחברים', public: 'לכולם' };

export function projectFilesBlock(v, entry) {
  const list = projectList(entry).filter((p) => mayDownload(v.acc, entry, p));
  if (!list.length) return '';
  const rows = list.map((p) => {
    const own = p.url.startsWith('/files/');
    const name = p.label || (p.kind === 'cubase' ? 'הפרויקט בקיובייס' : 'קובץ הפרויקט');
    const link = own
      ? `<a href="${e(p.url)}" download>${e(name)}</a><span class="how">הורדה</span>`
      : `<a href="${e(p.url)}" target="_blank" rel="noopener">${e(name)} ↗</a><span class="how">בדרייב</span>`;
    const vis = v.acc.owner ? `<span class="badge vis-${p.visibility}">${VIS_NAME[p.visibility]}</span>` : '';
    return `<li>${link}<span class="type">${KIND_NAME[p.kind]}</span>${vis}</li>`;
  });
  return `<section class="block project-files"><div class="section-head"><h2>קבצי הפרויקט</h2></div><ul class="file-list" dir="auto">${rows.join('')}</ul></section>`;
}
