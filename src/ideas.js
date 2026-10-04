// Ideas: the owner's private notebook. An idea is an entry of kind 'idea'
// (visitors never see one). On top of the plain entry routes, the notebook
// needs: capturing text with a recording or a photo in one request, the list
// with each idea's files, growing an idea into a draft in a wing, and the
// sparks (short prompts) the ideas page shows.
//
// Idea-only fields live in meta: wing (which wing it leans toward), spark
// (the prompt it came from), notes (what was added later: [{ at, text }]).
// They change through updateIdea, which merges on the server, so a phone
// with a stale copy cannot wipe a note written from the desktop.
import { db, KINDS, WINGS } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { fromRow, getEntry, createEntry, saveEntry } from './entries.js';
import { checkFile, attachFile, fileInfo } from './files.js';
import { fileKind, downloadKind, DOWNLOAD_TYPE } from './limits.js';

const MAX_TEXT = 200_000;
const MAX_SPARKS = 300;
const MAX_SPARK_TEXT = 300;
const MAX_NOTE = 4000;
const MAX_NOTES = 100;
const WING_IDS = WINGS.map((w) => w.id);
const SPARK_WINGS = ['any', ...WING_IDS];

// The prompts shown until the owner writes his own. 'any' fits every wing.
export const DEFAULT_SPARKS = [
  { wing: 'music', text: 'שורה ראשונה של שיר: "כשהאור בחדר נגמר". תמשיך ממנה.' },
  { wing: 'music', text: 'שיר שכולו שאלות, בלי תשובה אחת.' },
  { wing: 'music', text: 'ריף של שלושה אקורדים שמסרב להיגמר. איזה מילים הוא מבקש?' },
  { wing: 'music', text: 'שיר למישהו שעוד לא מכיר את עצמו. מה הפזמון?' },
  { wing: 'music', text: 'לקחת ניגון ישן ולכתוב לו מילים חדשות לגמרי.' },
  { wing: 'books', text: 'מה אם בספר הבא של גרגמיץ המפה משקרת?' },
  { wing: 'books', text: 'מה אם בגרגמיץ מישהו מגלה שהוא בכלל לא הגיבור של הסיפור?' },
  { wing: 'books', text: 'מה אם ההרפתקה הבאה של גרגמיץ מתחילה בטעות של שנייה אחת?' },
  { wing: 'books', text: 'דמות משנית מהספר מקבלת פרק משלה. מי, ולמה דווקא עכשיו?' },
  { wing: 'books', text: 'מה הדבר הכי מביך שיכול לקרות לגיבור באמצע הרפתקה?' },
  { wing: 'books', text: 'סצנה שלמה בלי מילה אחת של דיאלוג. מה קורה בה?' },
  { wing: 'books', text: 'מה אם הנבל צודק?' },
  { wing: 'sketches', text: 'מערכון: שני אנשים שמנסים לסיים שיחה ולא מצליחים.' },
  { wing: 'sketches', text: 'פקיד שמתייחס לעניין קטן כמו לשאלה של חיים ומוות.' },
  { wing: 'sketches', text: 'ראיון עבודה למשרה שלא קיימת.' },
  { wing: 'sketches', text: 'מישהו מגיע מוקדם מדי. בשעתיים.' },
  { wing: 'sketches', text: 'מדריך טיולים שמכיר את המקום פחות מהקבוצה.' },
  { wing: 'humor', text: 'לדבב קטע טבע כאילו הוא תוכנית ריאליטי.' },
  { wing: 'humor', text: 'קול למשהו שאין לו קול: מקרר, רמזור, שלט בכניסה.' },
  { wing: 'humor', text: 'מה אומרים בלב שני כלבים שנפגשים ברחוב?' },
  { wing: 'humor', text: 'קריין חדשות שמדווח על בוקר רגיל אצלך בבית.' },
  { wing: 'torah', text: 'איזה פסוק בפרשה הפריע לך השבוע? תתחיל משם.' },
  { wing: 'torah', text: 'דבר תורה מהנקודה של הדמות שלא מדברת בסיפור.' },
  { wing: 'torah', text: 'מה המדרש היה אומר על משהו שקרה לך היום?' },
  { wing: 'torah', text: 'שאלה אחת פשוטה על הפרשה שאף פעם לא שאלת.' },
  { wing: 'articles', text: 'דעה שהחזקת לפני עשר שנים ושינית. למה?' },
  { wing: 'articles', text: 'משהו שכולם מסכימים עליו ואתה לא בטוח.' },
  { wing: 'articles', text: 'להסביר דבר שאתה יודע טוב לילד בן עשר.' },
  { wing: 'software', text: 'כלי קטן שהיית רוצה שיהיה לך הבוקר.' },
  { wing: 'software', text: 'משהו שאתה עושה ידנית פעם בשבוע. איך זה נראה אוטומטי?' },
  { wing: 'software', text: 'מה היית בונה אם היה לך סוף שבוע שלם בלי הפרעות?' },
  { wing: 'videos', text: 'סרטון של דקה: הדבר שהכי קל להראות במצלמה ובלתי אפשרי להסביר בטקסט.' },
  { wing: 'videos', text: 'מאחורי הקלעים של משהו שכבר סיימת.' },
  { wing: 'any', text: 'מה הצחיק אותך היום? יש בזה משהו.' },
  { wing: 'any', text: 'משפט ששמעת השבוע ולא יוצא לך מהראש.' },
  { wing: 'any', text: 'רעיון שזרקת פעם כי היה "קטן מדי". אולי הוא בגודל הנכון.' },
];

// ---------- the list ----------

// Every idea with its files, pinned first, then the freshest.
export async function listIdeas(env) {
  const d = await db(env);
  const [ideas, files] = await Promise.all([
    d.prepare(`SELECT * FROM entries WHERE kind = 'idea' ORDER BY pinned DESC, updated_at DESC LIMIT 500`).all(),
    d.prepare(`SELECT f.* FROM files f JOIN entries e ON e.id = f.entry_id WHERE e.kind = 'idea' ORDER BY f.created_at`).all(),
  ]);
  const byEntry = new Map();
  for (const f of files.results) {
    if (!byEntry.has(f.entry_id)) byEntry.set(f.entry_id, []);
    byEntry.get(f.entry_id).push(fileInfo(f));
  }
  return json({ ideas: ideas.results.map((r) => ({ ...fromRow(r), files: byEntry.get(r.id) ?? [] })) });
}

// ---------- capture ----------

// One request from the phone: text and/or a file (a recording, a photo),
// optional tags, wing and the spark it answers.
export async function captureIdea(request, env) {
  const form = await request.formData().catch(() => {
    throw new HttpError(400, 'Send the idea as a form.');
  });
  const file = form.get('file');
  const hasFile = file instanceof File && file.size > 0;
  const text = typeof form.get('text') === 'string' ? form.get('text').slice(0, MAX_TEXT) : '';
  const wing = String(form.get('wing') ?? '');
  if (wing && !WING_IDS.includes(wing)) throw new HttpError(400, 'Unknown wing.');
  if (!text.trim() && !hasFile) throw new HttpError(400, 'Write something first, or record it.');
  if (hasFile) checkFile(file);
  const meta = {};
  if (wing) meta.wing = wing;
  const spark = cleanText(form.get('spark'), MAX_SPARK_TEXT);
  if (spark) meta.spark = spark;
  const idea = await createEntry(env, { kind: 'idea', body: text, tags: String(form.get('tags') ?? ''), meta }, 'studio', { allowEmpty: hasFile });
  const files = hasFile ? [await attachFile(env, idea.id, file)] : [];
  return json({ ...idea, files }, 201);
}

// ---------- tending ----------

// Merge idea-only fields: { wing } ('' clears it), { note } appends one,
// { dropNote: at } removes the note written at that time.
export async function updateIdea(request, env, id) {
  const idea = await getEntry(env, id);
  if (!idea || idea.kind !== 'idea') throw new HttpError(404, 'That idea no longer exists.');
  const body = await readJson(request);
  const meta = { ...idea.meta };
  if ('wing' in body) {
    const wing = String(body.wing ?? '');
    if (wing && !WING_IDS.includes(wing)) throw new HttpError(400, 'Unknown wing.');
    if (wing) meta.wing = wing;
    else delete meta.wing;
  }
  const notes = Array.isArray(meta.notes) ? [...meta.notes] : [];
  if ('note' in body) {
    const text = String(body.note ?? '').trim().slice(0, MAX_NOTE);
    if (!text) throw new HttpError(400, 'Write the note first.');
    if (notes.length >= MAX_NOTES) throw new HttpError(400, 'This idea has 100 notes. Time to grow it into a draft.');
    notes.push({ at: new Date().toISOString(), text });
  }
  if ('dropNote' in body) {
    const i = notes.findIndex((n) => n?.at === body.dropNote);
    if (i < 0) throw new HttpError(404, 'That note no longer exists.');
    notes.splice(i, 1);
  }
  if (notes.length) meta.notes = notes;
  else delete meta.notes;
  idea.meta = meta;
  await saveEntry(env, idea);
  return json(idea);
}

// ---------- growing ----------

const MEDIA_LABEL = { audio: 'הקלטה', video: 'סרטון' };

// The idea becomes a draft of `kind` in `spaceId`, keeping its id and files.
// The first line becomes the title when there is none; notes join the body;
// pictures go into the body, recordings become versions and a Cubase
// project or zip joins the item's project files (owner only).
export async function growIdea(request, env, id) {
  const idea = await getEntry(env, id);
  if (!idea || idea.kind !== 'idea') throw new HttpError(404, 'That idea no longer exists.');
  const { spaceId, kind } = await readJson(request);
  if (!KINDS.includes(kind) || kind === 'idea') throw new HttpError(400, 'Unknown kind.');
  const d = await db(env);
  const space = await d.prepare('SELECT id FROM spaces WHERE id = ?').bind(String(spaceId ?? '')).first();
  if (!space) throw new HttpError(400, 'That wing or space does not exist.');

  let title = idea.title;
  let body = idea.body.trim();
  if (!title) {
    const [first, ...rest] = body.split('\n');
    const line = first.replace(/^#+\s*/, '').trim();
    if (line.length <= 120) {
      title = line;
      body = rest.join('\n').trim();
    } else {
      // A long first line stays whole in the body; the title is its start.
      title = `${line.slice(0, 80).replace(/\s+\S*$/, '')}...`;
    }
  }
  const { wing: _wing, spark, notes = [], source: _source, ...meta } = idea.meta;
  const parts = [body, ...notes.map((n) => String(n?.text ?? '').trim())].filter(Boolean);
  const versions = [...(meta.versions ?? [])];
  const projects = [...(meta.projects ?? [])];
  const { results: files } = await d.prepare('SELECT * FROM files WHERE entry_id = ? ORDER BY created_at').bind(id).all();
  for (const f of files) {
    const url = `/files/${f.id}`;
    if (parts.some((p) => p.includes(url))) continue;
    const k = fileKind(f.type);
    const name = f.name.replace(/[[\]]/g, '');
    if (f.type === DOWNLOAD_TYPE) projects.push({ label: f.name.replace(/\.[^.]+$/, '').slice(0, 80), url, kind: downloadKind(f.name) ?? 'other' });
    else if (k === 'audio' || k === 'video') versions.push({ label: MEDIA_LABEL[k], url, kind: k });
    else parts.push(k === 'image' ? `![${name}](${url})` : `[${name}](${url})`);
  }
  // Without any text the recording is the whole item; it still needs a title.
  if (!title) title = files.length ? files[0].name.replace(/\.[^.]+$/, '') : 'בלי כותרת';
  Object.assign(idea, {
    kind,
    spaceId: space.id,
    title,
    body: parts.join('\n\n'),
    pinned: false,
    meta: { ...meta, ...(versions.length ? { versions } : {}), ...(projects.length ? { projects } : {}), idea: { capturedAt: idea.createdAt, ...(spark ? { spark } : {}) } },
  });
  await saveEntry(env, idea);
  return json(idea);
}

// ---------- back to an idea ----------

// The opposite of growing: an item (one that grew from an idea, or any other)
// goes back into the notebook, private, with everything it has. Where it was
// is kept in meta.was, so growing it again starts from the same place.
export async function backToIdea(env, id) {
  const entry = await getEntry(env, id);
  if (!entry) throw new HttpError(404, 'That item no longer exists.');
  if (entry.kind === 'idea') throw new HttpError(400, 'It is already an idea.');
  const d = await db(env);
  const space = entry.spaceId ? await d.prepare('SELECT wing FROM spaces WHERE id = ?').bind(entry.spaceId).first() : null;
  const { idea: origin, ...meta } = entry.meta;
  if (space?.wing && WING_IDS.includes(space.wing)) meta.wing = space.wing;
  if (origin?.spark) meta.spark = origin.spark;
  meta.was = { kind: entry.kind, spaceId: entry.spaceId, slug: entry.slug, status: entry.status, at: new Date().toISOString() };
  Object.assign(entry, { kind: 'idea', spaceId: null, slug: null, status: 'draft', visibility: 'private', communities: [], publishedAt: null, meta });
  await saveEntry(env, entry);
  return json(entry);
}

// ---------- sparks ----------

async function storedSparks(env) {
  const d = await db(env);
  const row = await d.prepare(`SELECT value FROM settings WHERE key = 'sparks'`).first();
  return row ? JSON.parse(row.value) : null;
}

export async function getSparks(env) {
  const own = await storedSparks(env);
  return json({ sparks: own ?? DEFAULT_SPARKS, own: Boolean(own) });
}

// An empty list goes back to the defaults.
export async function saveSparks(request, env) {
  const body = await readJson(request);
  if (!Array.isArray(body.sparks)) throw new HttpError(400, 'Send the sparks as a list.');
  const list = [];
  for (const s of body.sparks.slice(0, MAX_SPARKS)) {
    const text = cleanText(s?.text, MAX_SPARK_TEXT);
    if (!text) continue;
    const wing = s?.wing ? String(s.wing) : 'any';
    if (!SPARK_WINGS.includes(wing)) throw new HttpError(400, `Unknown wing "${wing}".`);
    list.push({ wing, text });
  }
  const d = await db(env);
  if (list.length) {
    await d.prepare(`INSERT INTO settings (key, value) VALUES ('sparks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(list)).run();
  } else {
    await d.prepare(`DELETE FROM settings WHERE key = 'sparks'`).run();
  }
  return json({ sparks: list.length ? list : DEFAULT_SPARKS, own: list.length > 0 });
}
