// Join and sign-in pages for community members.
(() => {
  const ERR = {
    'That username is taken.': 'שם המשתמש הזה תפוס. אם הוא שלכם, הסיסמה לא נכונה.',
    'Pick at least one community.': 'סמנו לפחות קהילה אחת.',
    'This invite link is no longer valid.': 'קישור ההזמנה כבר לא בתוקף.',
    'Wrong username or password.': 'שם משתמש או סיסמה שגויים.',
    'Your request is waiting for approval.': 'הבקשה שלכם עוד מחכה לאישור.',
    'This account is not active.': 'החשבון הזה לא פעיל.',
    'Password: at least 8 characters.': 'הסיסמה צריכה להיות לפחות 8 תווים.',
    'Username: 3 to 30 letters, digits, dots, dashes or underscores.': 'שם המשתמש צריך להיות 3 עד 30 אותיות, ספרות, נקודה, מקף או קו תחתון.',
  };
  const say = (id, text, kind = '') => {
    const n = document.getElementById(id);
    n.textContent = text;
    n.className = `msg ${kind}`;
  };
  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(ERR[data.error] || data.error || `שגיאה ${res.status}`);
    return data;
  }
  const params = new URLSearchParams(location.search);
  const next = () => {
    const n = params.get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : '/community';
  };

  const join = document.getElementById('join-form');
  if (join) {
    const code = params.get('code');
    // Came from a community's page or a locked item: that community starts ticked.
    const community = params.get('community');
    let signedIn = false;
    const picked = () => [...join.querySelectorAll('#comm-choices input:checked:not(:disabled)')].map((i) => i.value);

    // Every community that takes requests, as one list of checkboxes.
    const showChoices = (communities) => {
      const open = communities.filter((c) => c.joinMode === 'request' || c.membership);
      if (!open.length) return;
      const STATE = { active: 'אתם כבר בפנים', pending: 'הבקשה כבר מחכה לאישור' };
      document.getElementById('comm-choices').replaceChildren(
        ...open.map((c) => {
          const label = document.createElement('label');
          label.className = 'choice';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = c.id;
          box.checked = Boolean(c.membership) || c.id === community;
          box.disabled = Boolean(c.membership) || c.joinMode !== 'request';
          const title = document.createElement('span');
          title.dir = 'auto';
          title.textContent = c.title;
          const sub = document.createElement('small');
          sub.dir = 'auto';
          sub.textContent = STATE[c.membership] || c.summary || '';
          label.append(box, title, sub);
          return label;
        }),
      );
      document.getElementById('comm-field').hidden = false;
      const c = communities.find((x) => x.id === community);
      if (c && !signedIn) document.getElementById('join-title').textContent = `הצטרפות ל${c.title}`;
    };

    if (code) {
      fetch(`/api/member/invite?code=${encodeURIComponent(code)}`)
        .then((r) => r.json())
        .then(({ valid }) => {
          if (valid) {
            document.getElementById('join-title').textContent = 'הוזמנתם לקהילה';
            document.getElementById('join-lede').textContent = 'בוחרים שם משתמש וסיסמה, ונכנסים.';
            document.getElementById('note-field').hidden = true;
            document.getElementById('again-hint').hidden = true;
          } else {
            say('join-msg', 'קישור ההזמנה כבר לא בתוקף. אפשר עדיין לשלוח בקשת הצטרפות.', 'err');
          }
        })
        .catch(() => {});
    } else {
      // Signed in already: no new account, just tick communities and send.
      fetch('/api/member/me')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((me) => {
          if (me) {
            signedIn = true;
            document.getElementById('account-fields').hidden = true;
            for (const i of document.querySelectorAll('#account-fields input')) i.required = false;
            document.getElementById('join-title').textContent = `שלום ${me.displayName}`;
            document.getElementById('join-lede').textContent = 'מסמנים את הקהילות שרוצים להצטרף אליהן, ושולחים בקשה אחת.';
            document.getElementById('join-done-text').textContent = 'אעבור על זה בקרוב. אחרי שאאשר, הכל ייפתח לכם באותו חשבון.';
          }
          return fetch('/api/communities').then((r) => r.json());
        })
        .then(({ communities }) => showChoices(communities))
        .catch(() => {});
    }
    join.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(join));
      const communities = picked();
      say('join-msg', 'שולח...');
      try {
        if (signedIn) {
          if (!communities.length) throw new Error('סמנו לפחות קהילה אחת.');
          await post('/api/member/communities/join', { communities, note: f.note });
          join.hidden = true;
          document.getElementById('join-done').hidden = false;
          return;
        }
        const { status, existing } = await post('/api/member/join', { ...f, code: code || undefined, communities });
        if (status === 'active') location.href = next();
        else {
          if (existing) document.getElementById('join-done-text').textContent = 'הוספתי את הבקשה לחשבון שכבר פתחתם. אחרי שאאשר, נכנסים איתו.';
          join.hidden = true;
          document.getElementById('join-done').hidden = false;
        }
      } catch (err) {
        say('join-msg', err.message, 'err');
      }
    });
  }

  const login = document.getElementById('login-form');
  if (login) {
    if (params.get('logout')) {
      post('/api/member/logout', {}).then(() => say('login-msg', 'יצאתם מהחשבון.', 'ok'), () => {});
    }
    login.addEventListener('submit', async (e) => {
      e.preventDefault();
      say('login-msg', 'בודק...');
      try {
        await post('/api/member/login', Object.fromEntries(new FormData(login)));
        location.href = next();
      } catch (err) {
        say('login-msg', err.message, 'err');
      }
    });
  }
})();
