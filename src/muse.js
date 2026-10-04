// The muse: Claude helping on the ideas page (the owner picks the model). Three things:
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
// says so and the cron skips. The model is the owner's choice (settings
// 'muse_model', or per request); on the models that have them, server-side
// fallbacks are on, so a declined request is retried on Anthropic's
// recommended fallback model.
import { db } from './db.js';
import { HttpError, json, readJson, cleanText } from './http.js';
import { getEntry, saveEntry, createEntry } from './entries.js';

// Effort and server-side fallbacks exist on all but Haiku.
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'חזק ומאוזן', effort: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'מהיר וזול יותר', effort: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'הכי מהיר וזול', effort: false },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'הכי חזק והכי יקר', effort: true },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';
const modelOf = (id) => MODELS.find((m) => m.id === id);
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

// Each wing's craft: a line that sets the frame, and modes of its own on top
// of the general ones. (Designed with Fable, 2026-10-04.)
const WING_MODES = {
  music: {
    intro: 'זה שיר: מילים ללחן. תחשוב בבתים, פזמון, נשימה של זמר.',
    modes: {
      rhyme: { label: 'חרוז ומשקל', effort: 'medium', ask: 'תבדוק את המילים כמו שבודקים שיר ולא שיר ילדים: איפה החרוז מאולץ או צפוי, איפה מספר ההברות קופץ בין שורות מקבילות, איזו שורה אי אפשר לשיר בנשימה אחת. לכל בעיה: ציטוט השורה, מה הבעיה, ושתי חלופות שמחזיקות את המשמעות. אל תשנה שורה שעובדת.' },
      chorus: { label: 'פזמון', effort: 'high', ask: 'תמצא את השורה החזקה ביותר בטקסט ותבנה ממנה פזמון של 2-4 שורות: קצר, חוזר על עצמו בכוונה, עם מילה אחת שנתפסת. תציע שתי גרסאות הפוכות באופי (אחת שקטה, אחת שעולה) ותגיד אחרי איזה בית הפזמון צריך לבוא.' },
      harmony: { label: 'הרמוניה', effort: 'medium', ask: 'לפי המילים והתחושה, תציע סולם ומהלך אקורדים לבית ולפזמון (סימון אקורדים באנגלית, 4 תיבות בשורה), ונקודה אחת שבה כדאי לשבור: אקורד שאול, מינור במקום מז\'ור, או עצירה. תסביר בשורה אחת מה כל שבירה עושה למילים.' },
    },
  },
  books: {
    intro: 'אתה עורך ספרות שעובד איתי על רומן. זכור את גרגמיץ ודז\'ה וו כשהרעיון נוגע בהם.',
    modes: {
      scene: { label: 'סצנה', effort: 'high', ask: 'תפרוט את הרעיון לסצנה אחת: מי בחדר, מה כל אחד רוצה ולא אומר, מה משתנה בין ההתחלה לסוף. אחר כך כתוב את 6-8 השורות הראשונות של הסצנה בפעולה, לא בתיאור. עצור לפני שקורה הדבר המרכזי.' },
      voice: { label: 'קול הדמות', effort: 'high', ask: 'תבחר את הדמות המרכזית ברעיון וכתוב שלוש שורות דיאלוג שרק היא יכולה לומר: מילים שהיא משתמשת בהן, מה היא נמנעת מלומר, קצב המשפטים. אחר כך שורה אחת של אותו תוכן בפי דמות אחרת מהסיפור, כדי שההבדל ייראה.' },
      holes: { label: 'חורים בעלילה', effort: 'high', ask: 'תקרא את הרעיון כקורא עוין: איפה הגיבור יודע משהו שלא היה יכול לדעת, איפה הפתרון קל מדי, איזה חוק של העולם נשבר. לכל חור: שאלה אחת ישירה, ולפחות תיקון אחד שמשתמש במה שכבר יש בסיפור בלי להוסיף דמות או חפץ חדש.' },
    },
  },
  sketches: {
    intro: 'זה מערכון מבוים. הצחוק נולד מהסלמה, לא ממשפטים חכמים.',
    modes: {
      escalate: { label: 'הסלמה', effort: 'high', ask: 'תגדיר את ההנחה הקומית במשפט אחד ("עולם שבו..."). אחר כך סולם של 5 מדרגות: כל מדרגה דוחפת את אותה הנחה צעד אבסורדי אחד קדימה, בלי להחליף נושא. מדרגה 5 חייבת להיות הכי גדולה ועדיין הגיונית בתוך הכללים.' },
      punch: { label: 'פאנץ\'', effort: 'high', ask: 'תציע ארבעה סיומים למערכון: היפוך (הנורמלי מתברר כמשוגע), חזרה (משפט מההתחלה חוזר בהקשר חדש), חיתוך (הסצנה נקטעת בשיא), והגדלה (דמות מבחוץ נכנסת). לכל אחד: השורה האחרונה בפועל, ולמה היא עובדת או לא עם הסולם של המערכון.' },
      cast: { label: 'דמויות', effort: 'medium', ask: 'מי שתי הדמויות המינימליות שצריך? לכל אחת: מה היא רוצה, מה היא לא מבינה, ומה הטיק הלשוני שלה. תגיד איזו דמות היא ה"נורמלי" שהקהל מזדהה איתו.' },
    },
  },
  humor: {
    intro: 'זה דיבוב לקטע וידאו קיים. הטקסט חייב להתאים לתנועות שפתיים, לקצב ולמה שרואים.',
    modes: {
      lines: { label: 'שורות לקליפ', effort: 'high', ask: 'לפי תיאור הקטע או הרעיון, כתוב תסריט דיבוב בשורות: זמן משוער / מה רואים / השורה. השורות קצרות כמו דיבור, והצחוק נולד מהפער בין מה שרואים למה שאומרים. סמן שורה אחת שהיא העוגן של כל הקטע.' },
      persona: { label: 'קול לדובר', effort: 'medium', ask: 'תן לדובר (אדם, חיה, חפץ) אישיות במשפט אחד ושלושה משפטים בקולו: איך הוא מברך, איך הוא מתלונן, מה הוא אומר כשהוא מפסיד. הקול צריך להישמע ברור גם בלי לראות את הקטע.' },
      tones: { label: 'וריאציות', effort: 'medium', ask: 'כתוב את אותה שורת מפתח בחמישה טונים: חדשות, ריאליטי, דוקו טבע, פרסומת, שיחה בבית. שורה לכל טון. תגיד איזה טון הכי רחוק ממה שרואים בתמונה, כי שם הצחוק.' },
    },
  },
  torah: {
    intro: 'זה דבר תורה. קושיה אמיתית, תירוץ אחד, מסר שקושר. אל תמציא מדרשים: מקור רק אם אתה בטוח, אחרת נסח אותו כשאלה לבדיקה.',
    modes: {
      kushya: { label: 'קושיה ותירוץ', effort: 'high', ask: 'תבנה שלד קלאסי: (א) הפסוק או הפרט והקושי שהוא מעורר, בשאלה חדה אחת; (ב) שתי תשובות אפשריות, אחת מהפרשנים (עם מקור או סימון "לבדוק") ואחת חדשה; (ג) המסר למי שיושב סביב השולחן. עצור לפני המסר ותשאיר לי לכתוב אותו, אבל תגיד לאן הוא צריך להגיע.' },
      sources: { label: 'מקורות קרובים', effort: 'medium', ask: 'תציע 3-4 מקומות בתורה או בחז"ל שאפשר לקשור לרעיון: לכל מקור, איפה הוא, במה הוא דומה ובמה הוא הפוך (ההיפוך הוא הדרש). סמן בבירור מה בטוח ומה דורש בדיקה.' },
      today: { label: 'לחיים של היום', effort: 'medium', ask: 'קח את הרעיון ותחבר אותו למצב קונקרטי שקורה למשפחה בשבוע רגיל: לא מוסר כללי, רגע של דקה אחת. כתוב את הסיפור הקצר (4-5 שורות) שיפתח את הדבר תורה.' },
    },
  },
  articles: {
    intro: 'זה מאמר דעה. הקורא לא מכיר אותי ולא חייב לי כלום.',
    modes: {
      thesis: { label: 'תזה', effort: 'high', ask: 'נסח את הטענה של המאמר במשפט אחד שאפשר להתווכח איתו (לא עובדה, לא "חשוב לדון"). אחר כך שלוש גרסאות: מרוסנת, מוחצנת ומפתיעה. תגיד איזו מהן המאמר יכול להוכיח עם מה שכתוב כאן.' },
      counter: { label: 'הטענה שכנגד', effort: 'high', ask: 'כתוב את התשובה החזקה ביותר של מישהו חכם שלא מסכים איתי, בשתי פסקאות, בלי איש קש. אחר כך: איפה הוא צודק, ואיזה שינוי אחד בטענה שלי מנטרל את הביקורת בלי לוותר עליה.' },
      opening: { label: 'פתיחה', effort: 'medium', ask: 'ארבע שורות פתיחה למאמר, כל אחת בטקטיקה אחרת: סיפור, נתון, שאלה, הצהרה בוטה. בלי "בעידן שבו". תגיד איזו מתאימה לקול שלי לפי מה שכתבתי.' },
    },
  },
  software: {
    intro: 'זה פרויקט תוכנה של אדם אחד. לא רשימת פיצ\'רים, אלא מה אפשר להרים בסוף שבוע.',
    modes: {
      spec: { label: 'אפיון ב-10 שורות', effort: 'high', ask: 'כתוב אפיון מינימלי: למי זה, הבעיה במשפט, מה המשתמש עושה ב-3 צעדים, מה הפלט, ומה לא נכנס לגרסה הראשונה (רשימת "לא"). שורה אחת על אחסון נתונים ושורה אחת על פריסה.' },
      mvp: { label: 'MVP בסוף שבוע', effort: 'high', ask: 'תחתוך את הרעיון לגרסה שאפשר לבנות ולהשתמש בה תוך יומיים: מסך אחד, פעולה אחת. ואז: מה הסיכון הטכני הגדול ביותר, ואיזו הוכחת יכולת של שעה אפשר לעשות קודם.' },
      name: { label: 'שם וכיוון', effort: 'low', ask: 'חמישה שמות לפרויקט (בעברית או באנגלית), ולכל שם משפט תיאור אחד כאילו הוא כבר כתוב ב-README.' },
    },
  },
  videos: {
    intro: 'זה סרטון. הצופה מחליט ב-3 השניות הראשונות.',
    modes: {
      hook: { label: 'הוק', effort: 'high', ask: 'שלושה פתחים של 3 שניות: מה רואים, מה אומרים, מה הכתובית. לכל אחד: איזו שאלה הוא שותל בראש של הצופה. בחר אחד ותגיד מה המשפט שבא מיד אחריו.' },
      shots: { label: 'רשימת שוטים', effort: 'high', ask: 'פרק את הרעיון לרשימת שוטים ממוספרת: מספר / מה רואים / מה שומעים / אורך משוער. בסך הכל לא יותר מדקה. סמן את הקאט שאסור לוותר עליו.' },
      title: { label: 'כותרת ותמונה', effort: 'medium', ask: 'חמש כותרות עד 60 תווים, ושני תיאורים לתמונה הממוזערת (מה בפריים, איזה טקסט). בלי קליקבייט שקרי: מה שבכותרת חייב להופיע בסרטון.' },
    },
  },
};

// The modes an idea can ask for: the general ones and its wing's.
const modesFor = (wing) => ({ ...MODES, ...(WING_MODES[wing]?.modes ?? {}) });

export const hasKey = (env) => Boolean(env.ANTHROPIC_API_KEY);

function needKey(env) {
  if (!hasKey(env)) throw new HttpError(503, 'עוזר הכתיבה עוד לא מחובר: צריך להוסיף ב-Cloudflare סוד בשם ANTHROPIC_API_KEY.');
}

// ---------- the API ----------

async function open(env, { system, prompt, effort, model, maxTokens = 16000, stream = true }) {
  const m = modelOf(model) ?? modelOf(await chosenModel(env));
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      ...(m.effort ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: m.id,
      max_tokens: m.effort ? maxTokens : Math.min(maxTokens, 8000),
      stream,
      ...(m.effort ? { fallbacks: 'default', output_config: { effort } } : {}),
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

// ---------- the model ----------

async function chosenModel(env) {
  const id = await getSetting(env, 'muse_model');
  return modelOf(id) ? id : DEFAULT_MODEL;
}

// PUT { model }: the model every call uses unless the request names one.
export async function saveModel(request, env) {
  const { model } = await readJson(request);
  if (!modelOf(model)) throw new HttpError(400, 'Unknown model.');
  await setSetting(env, 'muse_model', model);
  return json({ model });
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
      ? `<earlier>\nמה שכבר הצעת לי על הרעיון הזה (אל תחזור על זה):\n${idea.meta.muse.slice(-3).map((m) => `[${modesFor(idea.meta.wing)[m.mode]?.label ?? m.mode}] ${m.text.slice(0, 1500)}`).join('\n---\n')}\n</earlier>`
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
  const modes = modesFor(idea.meta.wing);
  const mode = modes[body.mode] ? body.mode : 'directions';
  const ask = cleanText(body.ask, MAX_ASK);
  if (mode === 'ask' && !ask) throw new HttpError(400, 'כתוב מה לבקש.');
  const request_ = [modes[mode].ask, ask ? `${mode === 'ask' ? '' : 'ובנוסף: '}${ask}` : ''].filter(Boolean).join('\n');
  const intro = WING_MODES[idea.meta.wing]?.intro;
  const prompt = `${intro ? `${intro}\n\n` : ''}${ideaText(idea)}\n\n${request_}`;
  const model = modelOf(body.model) ? body.model : await chosenModel(env);
  return streamTo(env, { system: WHO, prompt, effort: modes[mode].effort, model }, async (text) => {
    // Read again: the idea may have changed while the answer streamed.
    const fresh = await getEntry(env, id);
    if (!fresh) return;
    const muse = [...(fresh.meta.muse ?? []), { at: new Date().toISOString(), mode, model, ...(ask ? { ask } : {}), text }].slice(-MAX_MUSE);
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
  return json({
    pulse,
    newSince: row.n,
    ready: hasKey(env),
    model: await chosenModel(env),
    models: MODELS.map(({ id, label, note }) => ({ id, label, note })),
    // Button labels: the general modes and each wing's own.
    modes: Object.fromEntries(Object.entries(MODES).filter(([k]) => k !== 'ask').map(([k, m]) => [k, m.label])),
    wingModes: Object.fromEntries(Object.entries(WING_MODES).map(([w, x]) => [w, Object.fromEntries(Object.entries(x.modes).map(([k, m]) => [k, m.label]))])),
  });
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

// Off unless settings 'muse_cron' is true: the owner chose (2026-10-04) to
// have the weekly draft and the pulse written from his Claude project, which
// his subscription covers, so the site spends API credit only on clicks.
export async function museCron(env) {
  if (!hasKey(env) || (await getSetting(env, 'muse_cron')) !== true) return null;
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

