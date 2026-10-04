// Join and sign-in pages for community members.
(() => {
  const ERR = {
    'That username is taken.': 'שם המשתמש הזה תפוס.',
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
    // Came from a wing or a book: the request covers that community too.
    const space = params.get('space');
    if (space && !code) {
      fetch('/api/spaces')
        .then((r) => r.json())
        .then(({ spaces }) => {
          const s = spaces.find((x) => x.id === space);
          if (!s) return;
          document.getElementById('join-title').textContent = s.kind === 'book' ? `הצטרפות לקוראי הבטא של ${s.title}` : `הצטרפות ל${s.parentId ? s.title : `קהילת ה${s.title}`}`;
        })
        .catch(() => {});
    }
    if (code) {
      fetch(`/api/member/invite?code=${encodeURIComponent(code)}`)
        .then((r) => r.json())
        .then(({ valid }) => {
          if (valid) {
            document.getElementById('join-title').textContent = 'הוזמנתם לקהילה';
            document.getElementById('join-lede').textContent = 'בוחרים שם משתמש וסיסמה, ונכנסים.';
            document.getElementById('note-field').hidden = true;
          } else {
            say('join-msg', 'קישור ההזמנה כבר לא בתוקף. אפשר עדיין לשלוח בקשת הצטרפות.', 'err');
          }
        })
        .catch(() => {});
    }
    join.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(join));
      say('join-msg', 'שולח...');
      try {
        const { status } = await post('/api/member/join', { ...f, code: code || undefined, spaceId: space || undefined });
        if (status === 'active') location.href = next();
        else {
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
