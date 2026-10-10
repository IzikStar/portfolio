// On every page: the service worker (the site as an app, notifications),
// the "install" buttons, the notifications page (/notifications) and a small
// one-time offer of notifications to people who are signed in.
(() => {
  const sw = 'serviceWorker' in navigator;
  if (sw) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const canPush = sw && 'PushManager' in window && 'Notification' in window;
  const who = document.body?.dataset.who; // "owner" | "member" | undefined
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const show = (sel, on) => $$(sel).forEach((el) => (el.hidden = !on));

  // ---------- install ----------

  let deferred = null;
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    show('[data-install]', true);
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    show('[data-install]', false);
    show('[data-installed]', true);
  });
  document.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-install]') || !deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
    show('[data-install]', false);
  });

  // ---------- push ----------

  const api = async (path, method = 'GET', body) => {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  };

  async function current() {
    if (!canPush) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  // Ask the browser, then tell the site about this device.
  async function turnOn() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'blocked' : 'dismissed');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
    return sub;
  }

  async function turnOff() {
    const sub = await current();
    if (!sub) return;
    await api('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }

  // ---------- the notifications page ----------

  const page = document.querySelector('[data-notify-page]');
  if (page) {
    const status = page.querySelector('[data-push-status]');
    const toggle = page.querySelector('[data-push-toggle]');
    const testBtn = page.querySelector('[data-push-test]');
    const msg = page.querySelector('[data-push-msg]');
    const say = (text) => (msg.textContent = text);

    show('[data-installed]', standalone);
    show('[data-ios-install]', ios && !standalone);
    show('[data-install-other]', !ios && !standalone);
    if (!who) return; // signed out: only the install part

    async function paint() {
      if (!canPush) {
        status.textContent = ios && !standalone
          ? 'באייפון התראות עובדות רק מהאפליקציה: קודם מוסיפים את האתר למסך הבית (למעלה), פותחים אותו משם ונכנסים שוב.'
          : 'הדפדפן הזה לא תומך בהתראות. אפשר לנסות ב-Chrome, Edge, Firefox או Safari.';
        toggle.hidden = true;
        testBtn.hidden = true;
        return;
      }
      const sub = await current();
      const blocked = Notification.permission === 'denied';
      if (sub) {
        // Make sure the site knows this device (also after a sign-in on it).
        api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() }).catch(() => {});
        status.textContent = 'ההתראות פועלות במכשיר הזה.';
        toggle.textContent = 'לכבות במכשיר הזה';
      } else {
        status.textContent = blocked
          ? 'ההתראות חסומות בדפדפן. כדי להפעיל אותן, פותחים את הגדרות האתר בדפדפן ומאפשרים התראות.'
          : 'ההתראות כבויות במכשיר הזה.';
        toggle.textContent = 'להפעיל התראות';
      }
      toggle.hidden = blocked && !sub;
      testBtn.hidden = !sub;
    }

    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      say('');
      try {
        if (await current()) await turnOff();
        else await turnOn();
      } catch (err) {
        if (err.message === 'blocked') say('הדפדפן חוסם התראות מהאתר. אפשר לשנות את זה בהגדרות האתר בדפדפן.');
        else if (err.message !== 'dismissed') say(err.message);
      }
      toggle.disabled = false;
      paint();
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        const { sent } = await api('/api/push/test', 'POST');
        say(sent ? 'נשלחה התראת בדיקה. היא אמורה לקפוץ עוד רגע.' : 'לא נמצא מכשיר פעיל. נסו לכבות ולהפעיל שוב.');
      } catch (err) {
        say(err.message);
      }
      testBtn.disabled = false;
    });

    // Each kind saves as it is ticked.
    page.querySelectorAll('[data-kind]').forEach((box) =>
      box.addEventListener('change', async () => {
        const prefs = {};
        page.querySelectorAll('[data-kind]').forEach((b) => (prefs[b.dataset.kind] = b.checked));
        try {
          await api('/api/push/prefs', 'PUT', { prefs });
          say('נשמר.');
        } catch (err) {
          say(err.message);
          box.checked = !box.checked;
        }
      }),
    );

    paint();
    return;
  }

  // ---------- a one-time offer ----------

  const NUDGE = 'notify-nudge';
  const later = () => {
    try {
      return Date.now() - Number(localStorage.getItem(NUDGE) || 0) < 14 * 86400 * 1000;
    } catch {
      return true;
    }
  };
  const dismiss = () => {
    try {
      localStorage.setItem(NUDGE, String(Date.now()));
    } catch {
      // private mode: it simply shows again
    }
  };

  async function nudge() {
    if (!who || later() || document.body.dataset.page === 'chat') return;
    const iosNeedsApp = ios && !standalone;
    if (!iosNeedsApp && (!canPush || Notification.permission !== 'default' || (await current()))) return;
    const card = document.createElement('aside');
    card.className = 'notify-nudge';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'התראות');
    card.innerHTML = iosNeedsApp
      ? `<p><b>רוצים התראות על מה שחדש?</b> באייפון מוסיפים את האתר למסך הבית ומקבלים התראות גם כשהוא סגור.</p>
         <div class="row"><a class="btn small accent" href="/notifications">איך עושים את זה</a><button class="link" type="button" data-no>לא עכשיו</button></div>`
      : `<p><b>לקבל התראות?</b> ${who === 'owner' ? 'על בקשות, תגובות והודעות בקהילות' : 'על פוסטים, הודעות ותגובות בקהילות שלך'}, גם כשהאתר סגור.</p>
         <div class="row"><button class="btn small accent" type="button" data-yes>להפעיל</button><button class="link" type="button" data-no>לא עכשיו</button></div>`;
    document.body.append(card);
    card.querySelector('[data-no]').addEventListener('click', () => {
      dismiss();
      card.remove();
    });
    card.querySelector('[data-yes]')?.addEventListener('click', async () => {
      dismiss();
      try {
        await turnOn();
        card.innerHTML = '<p>ההתראות פועלות. אפשר לבחור על מה בדף <a href="/notifications">התראות</a>.</p>';
        setTimeout(() => card.remove(), 5000);
      } catch {
        card.remove();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', nudge);
  else nudge();
})();
