# Itschak Shteren: portfolio

Personal site of Itschak Shteren: full-stack developer, musician, writer, voice actor and sketch maker. Hebrew and English, with a password-protected admin page that uploads music, voice reels, sketches and writing, and switches each section of the site on or off.

## How it works

- `public/` is the static site: plain HTML, CSS and JS, no build step. `index.html` is the portfolio, `admin.html` is the admin page.
- `src/worker.js` is a Cloudflare Worker. It serves `public/` and a small API:
  - `GET /api/site`: which sections are on, their intro lines, and the visible items
  - `GET /api/file/:id`, `GET /api/cover/:id`: uploaded files and cover images, with HTTP range support so players can seek
  - `/api/admin/*`: login, section switches, upload (file or link), edit, reorder, hide and delete (session cookie, HMAC-signed, HttpOnly, SameSite=Strict, plus an Origin check on writes)
- Files and covers are stored in Workers KV (one value per file, 25 MB max; bigger videos go on YouTube and are added as links). The item list and the settings are one JSON value each.
- The admin password is a Worker secret (`ADMIN_PASSWORD`). Changing it logs out every session.

## Develop

```bash
npm install
echo ADMIN_PASSWORD=devpass > .dev.vars
npm run dev      # http://localhost:8787, admin at /admin
npm test         # API tests (Vitest, in-memory KV)
```

## Deploy

Cloudflare deploys the site straight from this repo (Workers Builds): every push to `main` goes live. One-time setup in the Cloudflare dashboard:

1. Workers & Pages → Create → Import a repository → pick this repo → Deploy.
2. The new worker → Settings → Variables and Secrets → Add → type Secret, name `ADMIN_PASSWORD`.

GitHub Actions runs the tests on every push and pull request.
