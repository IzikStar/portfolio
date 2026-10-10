// /notifications: putting the site on the home screen as an app, turning
// notifications on for this device, and choosing what they are about.
// The buttons work in public/app.js; sending is src/push.js.
import { db } from './db.js';
import { escapeHtml as e } from './markdown.js';
import { render } from './site.js';
import { KINDS } from './push.js';
import { ownerMemberId } from './communities.js';

export async function notificationsPage(env, v) {
  const install = `<section class="notify-box">
  <h2>האתר כאפליקציה</h2>
  <p data-installed hidden>האתר פתוח כאפליקציה. אפשר לחזור אליו מהאייקון במסך הבית.</p>
  <div data-ios-install hidden>
    <p>באייפון ובאייפד:</p>
    <ol class="steps">
      <li>פותחים את האתר ב-Safari.</li>
      <li>לוחצים על כפתור השיתוף <span class="share-icon" aria-label="שיתוף">⬆︎</span> בתחתית המסך.</li>
      <li>בוחרים "הוספה למסך הבית" ואז "הוספה".</li>
      <li>פותחים את האתר מהאייקון החדש ונכנסים עם שם המשתמש. מכאן אפשר להפעיל התראות.</li>
    </ol>
  </div>
  <div data-install-other hidden>
    <p>ב-Android ובמחשב אפשר להתקין את האתר ולפתוח אותו כמו כל אפליקציה.</p>
    <p class="actions"><button class="btn accent" type="button" data-install hidden>להתקין את האפליקציה</button></p>
    <p class="hint">אם אין כפתור: בתפריט הדפדפן (⋮) בוחרים "התקנת אפליקציה" או "הוספה למסך הבית".</p>
  </div>
</section>`;

  if (v.role === 'public') {
    const body = `<section class="band"><div class="wrap narrow">
  <h1>התראות</h1>
  <p class="lede">מי שבקהילה מקבל התראה כשיש פוסט חדש, הודעה בצ׳אט או תגובה על מה שכתב.</p>
</div></section>
<div class="wrap narrow block" data-notify-page>
  <p class="actions"><a class="btn accent" href="/login?next=%2Fnotifications">כניסה</a></p>
  ${install}
</div>`;
    return render(env, v, { title: 'התראות', path: '/notifications', body, noindex: true });
  }

  const owner = v.role === 'owner' || v.member?.id === (await ownerMemberId(env));
  const who = owner ? 'owner' : v.member.id;
  const d = await db(env);
  const row = await d.prepare('SELECT prefs FROM push_prefs WHERE who = ?').bind(who).first();
  let prefs = {};
  try {
    prefs = row ? JSON.parse(row.prefs) : {};
  } catch {
    // all on
  }
  const kinds = owner ? KINDS.owner : KINDS.member;
  const body = `<section class="band"><div class="wrap narrow">
  <h1>התראות</h1>
  <p class="lede">${owner ? 'התראה על כל מה שקורה בקהילות: בקשות הצטרפות, חברים חדשים, פוסטים, הודעות ותגובות.' : 'התראה כשיש משהו חדש בקהילות שלך, גם כשהאתר סגור.'}</p>
</div></section>
<div class="wrap narrow block" data-notify-page>
  <section class="notify-box">
    <h2>במכשיר הזה</h2>
    <p data-push-status>בודק…</p>
    <p class="actions"><button class="btn accent" type="button" data-push-toggle>להפעיל התראות</button> <button class="btn small" type="button" data-push-test hidden>לשלוח התראת בדיקה</button></p>
    <p class="msg" role="status" data-push-msg></p>
  </section>
  <section class="notify-box">
    <h2>על מה להתריע</h2>
    <p class="hint">הבחירה נשמרת לכל המכשירים שלך.</p>
    <ul class="notify-kinds">
      ${kinds.map((k) => `<li><label><input type="checkbox" data-kind="${e(k.id)}"${prefs[k.id] === false ? '' : ' checked'}> ${e(k.label)}</label></li>`).join('\n      ')}
    </ul>
  </section>
  ${install}
  <p class="hint">באייפון (iOS 16.4 ומעלה) התראות מגיעות רק כשהאתר מותקן במסך הבית ונפתח משם. ההתראות לא כוללות דברים שאין לך גישה אליהם.</p>
</div>`;
  return render(env, v, { title: 'התראות', path: '/notifications', body, noindex: true });
}
