// The muse: Claude (Fable) helping on the ideas page. Three things:
//
//   museIdea   on one idea: open new directions, write the next part with
//              him, or ask the questions that move it. Streams the answer to
//              the studio as plain text and keeps it on the idea (meta.muse).
//   pulse      "what is new in your head": reads the ideas captured since the
//              last pulse against the older ones and names the new creative
//              directions. Daily from the cron when there are new ideas, or on
//              demand. Kept in settings ('muse_pulse').
//   weekly     each week a draft about the week's parasha lands in the
//              notebook, pinned, half written, asking him to finish it.
//
// Calls go straight to the Messages API with fetch (the Worker has no
// Anthropic SDK). Needs the ANTHROPIC_API_KEY secret; without it the studio
// says so and the cron skips. Server-side fallbacks are on, so a request the
// model declines is retried on Anthropic's recommended fallback model.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { getEntry, saveEntry, createEntry } from './entries.js';

export const MODEL = 'claude-fable-5-1';
const API = 'https://api.anthropic.com/v1/messages';
const MAX_MUSE = 20;
const MAX_ASK = 1000;

const WING_NAME = {
  music: 'מוזיקה (שירים, לחנים, עיבודים)',
  books: 'ספרים (בין השאר סדרת הפנטזיה גרגמיץ והספר דז\'ה וו)',
  sketches: 'מערכונים',
  humor: 'דיבובים והומור',
  torah: 'דברי תורה',
  articles: 'מאמרים',
  software: 'תוכנה',
  videos: 'סרטונים',
};

const WHO = `אתה שותף כתיבה ויצירה של יצחק שטרן, יוצר ישראלי שכותב שירים ומלחין, כותב ספרים (סדרת פנטזיה בשם גרגמיץ, הספר דז'ה וו), מערכונים, דיבובים הומוריסטיים, דברי תורה ומאמרים, ובונה תוכנה.
אתה עובד בתוך מחברת הרעיונות הפרטית שלו באתר שלו. אתה כותב לו בעברית, בגובה העיניים, כמו חבר יוצר חד ולא כמו עוזר. אין הקדמות, אין סיכומים, אין מחמאות ריקות.
הקול שלו הוא שלו: כשאתה כותב בשבילו, כתוב כטיוטה שהוא ימשיך, לא כטקסט גמור. העדף רעיון מפתיע ומדויק על פני רשימה ארוכה של רעיונות סבירים.
כתוב טקסט פשוט: פסקאות ושורות קצרות, בלי טבלאות ובלי כותרות Markdown. מותר להשתמש ב"- " לרשימה.`;

const MODES = {
  directions: {
    label: 'כיוונים חדשים',
    effort: 'high',
    ask: 'תפתח לי כיוונים חדשים לרעיון הזה: שלושה או ארבעה כיוונים שונים זה מזה באמת (בז\'אנר, בנקודת מבט, בצורה, בטון). לכל כיוון: שורה שמסבירה אותו, ומשפט או שניים שמראים איך הוא היה מתחיל בפועל. בסוף, שורה אחת: איזה כיוון אתה הכי היית הולך עליו ולמה.',
  },
  write: {
    label: 'תכתוב איתי',
    effort: 'high',
    ask: 'תמשיך לכתוב איתי מהנקודה שבה הרעיון נמצא עכשיו: כתוב את הקטע הבא (בצורה שמתאימה לו: בתים לשיר, סצנה לספר או למערכון, פסקאות למאמר או לדבר תורה). אל תסיים את היצירה. עצור בנקודה שמשאירה לי החלטה, וכתוב בשורה אחרונה מה ההחלטה שמחכה לי.',
  },
  questions: {
    label: 'שאלות שיקדמו',
    effort: 'medium',
    ask: 'תשאל אותי חמש שאלות שיקדמו את הרעיון הזה. לא שאלות כלליות: כל שאלה צריכה להיות על משהו ספציפי ברעיון שעוד לא החלטתי, ושהתשובה עליה תשנה את מה שאני כותב.',
  },
  ask: { label: 'בקשה משלי', effort: 'high', ask: '' },
};

export const hasKey = (env) => Boolean(env.ANTHROPIC_API_KEY);

function needKey(env) {
  if (!hasKey(env)) throw new HttpError(503, 'עוזר הכתיבה עוד לא מחובר: צריך להוסיף ב-Cloudflare סוד בשם ANTHROPIC_API_KEY.');
}

// ---------- the API ----------

async function open(env, { system, prompt, effort, maxTokens = 16000, stream = true }) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      stream,
      fallbacks: 'default',
      output_config: { effort },
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('muse api', res.status, detail.slice(0, 500));
    throw new HttpError(502, res.status === 401 ? 'המפתח ANTHROPIC_API_KEY לא תקין.' : `עוזר הכתיבה לא ענה (${res.status}).`);
  }
  return res;
}

// Text deltas out of the SSE stream; the last value is { stop } with the
// final stop reason. Thinking and fallback marker blocks carry no text.
export async function* textOf(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let stop = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data) continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield ev.delta.text;
      else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
    }
  }
  yield { stop };
}

// Run a prompt to the end and return the text (for the cron).
export async function complete(env, opts) {
  const res = await open(env, opts);
  let text = '';
  let stop = null;
  for await (const part of textOf(res.body)) {
    if (typeof part === 'string') text += part;
    else stop = part.stop;
  }
  if (stop === 'refusal') return { text: '', stop };
  return { text: text.trim(), stop };
}

// Stream a prompt to the browser as plain text, then hand the whole text to
// `done` (which saves it). A refusal or a cut stream ends with a marker line
// the studio understands.
function streamTo(env, opts, done) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  (async () => {
    let text = '';
    let stop = null;
    try {
      const res = await open(env, opts);
      for await (const part of textOf(res.body)) {
        if (typeof part === 'string') {
          text += part;
          await writer.write(enc.encode(part));
        } else stop = part.stop;
      }
      if (stop === 'refusal') await writer.write(enc.encode('\n\n⟂refusal'));
      else if (text.trim()) await done(text.trim(), stop);
      if (stop === 'max_tokens') await writer.write(enc.encode('\n\n⟂cut'));
    } catch (err) {
      await writer.write(enc.encode(`\n\n⟂error ${err instanceof HttpError ? err.message : 'עוזר הכתיבה נתקע באמצע.'}`)).catch(() => {});
      if (!(err instanceof HttpError)) console.error('muse stream', err);
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

// ---------- one idea ----------

function ideaText(idea) {
  const notes = (idea.meta.notes ?? []).map((n) => `- ${n.text}`).join('\n');
  return [
    idea.meta.wing ? `האגף שהרעיון נוטה אליו: ${WING_NAME[idea.meta.wing] ?? idea.meta.wing}` : 'עוד לא ברור לאיזה אגף הוא שייך.',
    idea.meta.spark ? `הניצוץ שממנו הוא התחיל: ${idea.meta.spark}` : '',
    idea.tags.length ? `תגיות: ${idea.tags.join(', ')}` : '',
    `<idea>\n${idea.title ? `${idea.title}\n\n` : ''}${idea.body.trim() || '(אין טקסט, רק קובץ מצורף)'}\n</idea>`,
    notes ? `<notes>\nמחשבות שהוספתי אחר כך:\n${notes}\n</notes>` : '',
    (idea.meta.muse ?? []).length
      ? `<earlier>\nמה שכבר הצעת לי על הרעיון הזה (אל תחזור על זה):\n${idea.meta.muse.slice(-3).map((m) => `[${MODES[m.mode]?.label ?? m.mode}] ${m.text.slice(0, 1500)}`).join('\n---\n')}\n</earlier>`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function museIdea(request, env, id) {
  needKey(env);
  const idea = await getEntry(env, id);
  if (!idea || idea.kind !== 'idea') throw new HttpError(404, 'That idea no longer exists.');
  const body = await readJson(request);
  const mode = MODES[body.mode] ? body.mode : 'directions';
  const ask = cleanText(body.ask, MAX_ASK);
  if (mode === 'ask' && !ask) throw new HttpError(400, 'כתוב מה לבקש.');
  const request_ = [MODES[mode].ask, ask ? `${mode === 'ask' ? '' : 'ובנוסף: '}${ask}` : ''].filter(Boolean).join('\n');
  const prompt = `${ideaText(idea)}\n\n${request_}`;
  return streamTo(env, { system: WHO, prompt, effort: MODES[mode].effort }, async (text) => {
    // Read again: the idea may have changed while the answer streamed.
    const fresh = await getEntry(env, id);
    if (!fresh) return;
    const muse = [...(fresh.meta.muse ?? []), { at: new Date().toISOString(), mode, ...(ask ? { ask } : {}), text }].slice(-MAX_MUSE);
    fresh.meta = { ...fresh.meta, muse };
    await saveEntry(env, fresh);
  });
}

// Drop one saved answer: { at }.
export async function dropMuse(request, env, id) {
  const idea = await getEntry(env, id);
  if (!idea || idea.kind !== 'idea') throw new HttpError(404, 'That idea no longer exists.');
  const { at } = await readJson(request);
  const muse = (idea.meta.muse ?? []).filter((m) => m.at !== at);
  if (muse.length) idea.meta.muse = muse;
  else delete idea.meta.muse;
  await saveEntry(env, idea);
  return json(idea);
}

// ---------- new directions (the pulse) ----------

async function getSetting(env, key) {
  const d = await db(env);
  const row = await d.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function setSetting(env, key, value) {
  const d = await db(env);
  await d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
}

const line = (r, n) => `${r.title ? `${r.title}: ` : ''}${r.body}`.replace(/\s+/g, ' ').trim().slice(0, n);

// What the pulse reads: his ideas (not the weekly drafts) since `since` in
// full (up to 40), the rest as one line each, and the titles of what already became real work.
async function pulseInput(env, since) {
  const d = await db(env);
  const [fresh, older, work] = await Promise.all([
    d.prepare(`SELECT title, body, meta, created_at FROM entries WHERE kind = 'idea' AND json_extract(meta, '$.weekly') IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 40`).bind(since).all(),
    d.prepare(`SELECT title, body FROM entries WHERE kind = 'idea' AND json_extract(meta, '$.weekly') IS NULL AND created_at <= ? ORDER BY created_at DESC LIMIT 150`).bind(since).all(),
    d.prepare(`SELECT title, kind FROM entries WHERE kind != 'idea' AND title != '' ORDER BY updated_at DESC LIMIT 120`).all(),
  ]);
  return { fresh: fresh.results, older: older.results, work: work.results };
}

function pulsePrompt({ fresh, older, work }) {
  const wingOf = (r) => JSON.parse(r.meta || '{}').wing;
  return [
    `<new_ideas>\nהרעיונות שנכנסו למחברת מאז הפעם הקודמת:\n${fresh.map((r) => `- [${WING_NAME[wingOf(r)] ?? 'בלי אגף'}] ${line(r, 600)}`).join('\n')}\n</new_ideas>`,
    older.length ? `<older_ideas>\nרעיונות מלפני כן, בשורה אחת כל אחד:\n${older.map((r) => `- ${line(r, 110)}`).join('\n')}\n</older_ideas>` : '',
    work.length ? `<existing_work>\nדברים שכבר קיימים באתר שלו:\n${work.map((r) => `- ${r.title}`).join('\n')}\n</existing_work>` : '',
    `תקרא את הרעיונות החדשים מול כל מה שהיה לפני כן, ותגיד לי אם אני פותח כיוונים יצירתיים חדשים: נושא, צורה, טון, אגף או חיבור בין תחומים שלא היו לי קודם, או חוט שחוזר שוב ושוב ושווה להפוך ליצירה.
אם יש: לכל כיוון, שורת כותרת קצרה ואחריה שניים-שלושה משפטים: מה החדש, באילו רעיונות ראית אותו, ומה הצעד הראשון הקטן שאפשר לעשות איתו השבוע.
אם אין כיוון חדש באמת, תגיד את זה במשפט אחד, ותציין רעיון אחד מהחדשים ששווה לפתח עכשיו ולמה. אל תמציא חידוש שאין.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function getPulse(env) {
  const [pulse, d] = await Promise.all([getSetting(env, 'muse_pulse'), db(env)]);
  const since = pulse?.at ?? '1970-01-01T00:00:00.000Z';
  const row = await d.prepare(`SELECT COUNT(*) AS n FROM entries WHERE kind = 'idea' AND json_extract(meta, '$.weekly') IS NULL AND created_at > ?`).bind(since).first();
  return json({ pulse, newSince: row.n, ready: hasKey(env) });
}

async function savePulse(env, text, count) {
  await setSetting(env, 'muse_pulse', { at: new Date().toISOString(), text, count, seen: false });
}

// On demand from the studio: from the last pulse, or from the last 30 days
// when that leaves nothing new.
export async function runPulse(env) {
  needKey(env);
  const pulse = await getSetting(env, 'muse_pulse');
  let input = await pulseInput(env, pulse?.at ?? '1970-01-01T00:00:00.000Z');
  if (!input.fresh.length) input = await pulseInput(env, new Date(Date.now() - 30 * 86_400_000).toISOString());
  if (!input.fresh.length) throw new HttpError(400, 'אין רעיונות חדשים לקרוא. תזרוק כמה ונחזור לזה.');
  const count = input.fresh.length;
  return streamTo(env, { system: WHO, prompt: pulsePrompt(input), effort: 'high' }, (text) => savePulse(env, text, count));
}

export async function seePulse(env) {
  const pulse = await getSetting(env, 'muse_pulse');
  if (pulse) await setSetting(env, 'muse_pulse', { ...pulse, seen: true });
  return json({ ok: true });
}

// Cron: once a day at most, and only when something new came in.
async function pulseCron(env) {
  const pulse = await getSetting(env, 'muse_pulse');
  if (pulse && Date.now() - Date.parse(pulse.at) < 20 * 3_600_000) return null;
  const input = await pulseInput(env, pulse?.at ?? new Date(Date.now() - 30 * 86_400_000).toISOString());
  if (!input.fresh.length) return null;
  const { text } = await complete(env, { system: WHO, prompt: pulsePrompt(input), effort: 'high', stream: true });
  if (!text) return null;
  await savePulse(env, text, input.fresh.length);
  return { pulse: input.fresh.length };
}

// ---------- the week's parasha ----------

const ymd = (t) => new Date(t).toISOString().slice(0, 10);

// This week's parasha (Israel reading), from Hebcal. Null in a week a
// festival takes the Shabbat.
export async function thisParasha(now = Date.now()) {
  const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&s=on&i=on&maj=off&min=off&mod=off&nx=off&ss=off&mf=off&c=off&start=${ymd(now)}&end=${ymd(now + 6 * 86_400_000)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`hebcal ${res.status}`);
  const { items = [] } = await res.json();
  const p = items.find((i) => i.category === 'parashat');
  return p ? { id: p.title, hebrew: p.hebrew, date: p.date } : null;
}

// Once per Shabbat, remembered in settings, so a draft he deleted stays deleted.
const weeklyKey = (p) => `${p.id}@${p.date}`;

async function torahTitles(env) {
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT title FROM entries WHERE title != '' AND json_extract(meta, '$.weekly') IS NULL AND (space_id = 'torah' OR space_id IN (SELECT id FROM spaces WHERE wing = 'torah')) ORDER BY updated_at DESC LIMIT 30`)
    .all()
    .catch(() => ({ results: [] }));
  return results.map((r) => r.title);
}

function weeklyPrompt(p, titles) {
  return [
    titles.length ? `<my_torah>\nדברי תורה שכבר כתבתי או התחלתי:\n${titles.map((t) => `- ${t}`).join('\n')}\n</my_torah>` : '',
    `השבוע קוראים את ${p.hebrew}. כתוב לי טיוטה למאמר דבר תורה על הפרשה, שתחכה לי במחברת ותזמין אותי להשלים אותה. המבנה:
1. סיכום הפרשה: שלוש-ארבע פסקאות קצרות, מה קורה בה לפי הסדר, עם ציון פרקים.
2. שלושה פתחים: לכל פתח, פסוק או פרט מהפרשה (עם מקור), הקושי או השאלה שהוא מעורר, ומשפט אחד על כיוון אפשרי. לפחות פתח אחד שקשור לחיים של היום, ולפחות אחד שמתחבר למה שכבר כתבתי אם יש חיבור כזה.
3. התחלה של מאמר: פסקת פתיחה אחת שכתובה בקול אישי, ואחריה שלוש שורות שמתחילות ב"✎" ומסמנות מה אני צריך לכתוב בכל חלק (לא לכתוב אותו בשבילי).
אל תמציא מדרשים או ציטוטים: כשאתה מביא מקור, שיהיה מקור שאתה בטוח בו, ואם אתה לא בטוח, תנסח את זה כשאלה שלי לבדוק.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Cron: the draft for this week, once. Kept as an idea leaning to the torah
// wing, pinned; growing it turns it into a real draft in the wing.
async function weeklyCron(env, now = Date.now()) {
  const p = await thisParasha(now);
  if (!p || (await getSetting(env, 'muse_weekly')) === weeklyKey(p)) return null;
  const { text } = await complete(env, { system: WHO, prompt: weeklyPrompt(p, await torahTitles(env)), effort: 'high', stream: true });
  if (!text) return null;
  const idea = await createEntry(
    env,
    {
      kind: 'idea',
      title: `${p.hebrew}: טיוטה שמחכה לך`,
      body: text,
      tags: 'פרשת שבוע',
      pinned: true,
      meta: { wing: 'torah', weekly: { parasha: p.id, hebrew: p.hebrew, date: p.date } },
    },
    'studio',
  );
  await setSetting(env, 'muse_weekly', weeklyKey(p));
  return { weekly: p.id, id: idea.id };
}

export async function museCron(env) {
  if (!hasKey(env)) return null;
  const out = {};
  for (const [name, job] of [
    ['weekly', weeklyCron],
    ['pulse', pulseCron],
  ]) {
    try {
      out[name] = await job(env);
    } catch (err) {
      console.error(`muse ${name}`, err);
      out[name] = 'failed';
    }
  }
  return out;
}

// On demand from the studio (the button next to the weekly draft).
export async function runWeekly(env) {
  needKey(env);
  const made = await weeklyCron(env);
  if (!made) throw new HttpError(409, 'הטיוטה של השבוע כבר במחברת (או שהשבת הזאת היא חג).');
  return json(await getEntry(env, made.id), 201);
}

export const MUSE_MODES = Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, m.label]));
