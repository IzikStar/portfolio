# Itschak Shteren: portfolio

Personal site of Itschak Shteren: full-stack developer, musician and writer. Hebrew and English, with a password-protected admin page for uploading music.

## How it works

- `public/` is the static site: plain HTML, CSS and JS, no build step. `index.html` is the portfolio, `admin.html` is the music admin page.
- `src/worker.js` is a Cloudflare Worker. It serves `public/` and a small API:
  - `GET /api/tracks`: the public track list
  - `GET /api/audio/:id`, `GET /api/cover/:id`: audio and cover images, with HTTP range support so the player can seek
  - `/api/admin/*`: login, upload, edit, reorder, hide and delete (session cookie, HMAC-signed, HttpOnly, SameSite=Strict, plus an Origin check on writes)
- Audio and covers are stored in Workers KV (one value per file, 25 MB max per track), the track list as one JSON value.
- The admin password is a Worker secret (`ADMIN_PASSWORD`). Changing it logs out every session.

## Develop

```bash
npm install
echo ADMIN_PASSWORD=devpass > .dev.vars
npm run dev      # http://localhost:8787, admin at /admin
npm test         # API tests (Vitest, in-memory KV)
```

## Deploy

Every push to `main` runs the tests and deploys with Wrangler. The repo needs three Actions secrets: `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers"), `CLOUDFLARE_ACCOUNT_ID` and `ADMIN_PASSWORD`.
