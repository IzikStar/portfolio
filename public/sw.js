// The site's service worker: what lets it install as an app, a page for when
// there is no connection, and the notifications (src/push.js sends them).
// Pages themselves are never cached: they differ by who is signed in.
const CACHE = 'shell-v2';
const OFFLINE = '/offline.html';
const SHELL = [OFFLINE, '/img/app-192.png', '/img/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only page loads go through here, and only to fall back when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      // This device has that page in front of the person (the chat, open):
      // they see it there. Safari wants every push shown, so it gets a quiet one.
      const url = new URL(data.url || '/', self.location.origin).href;
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const looking = wins.some((w) => w.url.split('#')[0] === url && w.visibilityState === 'visible' && w.focused);
      const safari = /safari/i.test(navigator.userAgent) && !/chrome|crios|android/i.test(navigator.userAgent);
      if (looking && !safari) return;
      await self.registration.showNotification(data.title || 'יצחק שטרן', {
        body: data.body || '',
        tag: data.tag || undefined,
        renotify: Boolean(data.tag) && !looking,
        silent: looking,
        icon: '/img/app-192.png',
        badge: '/img/badge-96.png',
        dir: 'rtl',
        lang: 'he',
        data: { url: data.url || '/' },
      });
    })(),
  );
});

// Tapping a notification opens its page, in a window of the site if one is open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const same = wins.find((w) => w.url === url);
      if (same) return same.focus();
      const any = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (any && 'navigate' in any) {
        try {
          const w = await any.navigate(url);
          return (w || any).focus();
        } catch {
          // fall through to a new window
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// The browser replaced the subscription: hand the new one to the site.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const { publicKey } = await (await fetch('/api/push/key')).json();
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    })(),
  );
});
