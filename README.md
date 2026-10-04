# Itschak Shteren: portfolio

Personal site of Itschak Shteren: full-stack developer, musician, writer, voice actor and sketch maker. A platform of eight wings with communities, a CV for recruiters at `/cv` (Hebrew and English), and a password-protected studio where the owner runs all of it.

## How it works

- `public/` holds the static files: plain HTML, CSS and JS, no build step (`studio.html` is the owner's studio, `cv.css` and `cv.js` belong to the CV).
- `src/worker.js` is a Cloudflare Worker. It serves `public/`, renders the pages and answers the API. `/api/admin/login`, `/api/admin/logout` and `/api/admin/session` are the owner's sign-in (session cookie, HMAC-signed, HttpOnly, SameSite=Strict, plus an Origin check on writes).
- The CV (`src/cv.js`, `src/cv-page.js`) is rendered on the server at `/cv`, in Hebrew by default and in English at `/cv?lang=en` (the toggle remembers the choice in a cookie; without one the browser's language decides). Its text lives in the `cv` settings row in D1, edited in the studio's CV view (`#cv`): availability line, name and roles, lede, hero buttons, about text, timeline, skills, email and contact links, the footer line, which sections show and in what order, and which entries fill them. Fields left out of the row keep the defaults in `src/cv.js`, which are what the page said before it became editable. Projects come from the software wing (the order is kept on each entry as `meta.cv`, the same flag the project editor sets; until projects are imported the page shows `src/cv-seed.js`); music, voice, sketches and writing list entries the owner picks, and only public, published entries in public spaces show. The page links only outward (and to files on the site), never into the platform unless the owner adds such a link himself. `GET /api/studio/cv`, `PUT /api/studio/cv` and `POST /api/studio/cv/preview` (the unsaved form, rendered for the studio's preview) are owner-only. It has a print stylesheet for a clean A4 copy.
- The old admin page is gone; `/admin` redirects to `/studio#cv`. Its items (KV keys `items`, `settings`, `file:<id>`, `cover:<id>`) are moved into the wings once by `importLegacyOnce` (the first `/cv` visit, the owner opening the studio, or the daily cron, whichever comes first; a `legacy_import` settings row makes sure it runs once). Until the owner picks items himself, the CV shows the moved items in their old sections and order, with the old section switches and intro lines. Nothing in KV is deleted.
- The platform (owner studio at `/studio`: idea notebook, a studio per wing with its spaces, items and join requests, one editor for every kind of item with versions and a chord preview; public pages at `/`, `/<wing>`, `/<wing>/<space>/<item>`) keeps its data in D1 (`src/db.js` creates the tables on first use, so a new database needs no migration step):
  - `/api/studio/*`: owner-only. Ideas and articles (create, edit, autosave with a stale-write check, publish, delete) and a Markdown preview.
  - `GET /api/entries?kind=article`: published entries the visitor may see.
  - Wings and communities (`src/spaces.js`, `src/communities.js`): the site has eight fixed wings (music, books, sketches, dubbing & humor, Torah, articles, software, videos). Inside a wing the owner adds spaces: a book, a series, a genre, a collection. Spaces are structure only. Communities stand apart from the wings: the owner defines them in the studio (`/api/studio/communities`) and opens any item or space to any set of them (`communities` on the entry or space), so "nonsense humor" can hold sketches, dubs and songs alike. A community either takes join requests (`POST /api/member/communities/:id/join`, or `communityId` while signing up) or is by invitation only (an invite link with `communities`, or the owner adds a member directly), and may be hidden: outsiders then never see it, its page (`/community/<slug>`) or a lock on what it holds. Each entry is `private`, `community` (members of its communities), `members` (anyone signed in) or `public`, and a private or community-only space hides everything inside it. `GET /api/communities` lists the communities a visitor may know about and where they stand in each.
  - Comments (`src/comments.js`): an item's community (and the owner) can comment on it, on the whole item or on one paragraph; a paragraph comment keeps the paragraph's opening words so it still reads right after edits. Replies are one level deep. Writers delete their own comments; the owner marks them handled or deletes them from the item page or the studio inbox (`/api/studio/comments`). `meta.comments: false` turns them off for one item. Visitors outside the community see only how to join.
  - Settings (`src/settings.js`): the studio's settings page edits the social links in the footer and on the home page (`PUT /api/studio/settings/socials`, https only), shows when the old admin items were moved, and can run that move again by hand (`POST /api/studio/import-legacy`, idempotent by `meta.legacy.id`): files are copied into the entry's files, shown items stay public, hidden ones become private drafts, and the old copies stay where they were.
  - Community: invite links (`/join?code=…`) let people in at once; without one, `/join` files a request the owner approves in the studio. Members sign in at `/login` (PBKDF2 password hashes, a signed 30-day cookie, and the account is re-checked on every request so suspending someone cuts them off at once). `/community` is the members' feed.
  - Projects (kind `project` or `work`) are edited in the studio's Projects tab. Each can point at a source (a GitHub repo or any web page); "refresh from source" and a daily cron (03:00 UTC) pull the description, topics, languages, homepage and README (or a page's Open Graph tags). Fields the owner fills in win over pulled ones. `GET /api/cv-projects` lists the CV's projects as JSON (public, published, marked for the CV, in the owner's order). `/work` and `/work/:slug` show projects, with a GitHub README's relative links resolved against the repo.
  - GitHub limits unauthenticated calls per IP, and Workers share IPs, so set a `GITHUB_TOKEN` secret (a fine-grained token with read-only access) for reliable syncs and for private repos.
  - Files (images, audio, video, PDF; 25 MB each) are uploaded from the article and project editors and attached to an entry: bytes in KV as `blob:<id>`, a row in the `files` table. `/files/:id` serves a file only to people who may see its entry, and deleting the entry deletes its files.
  - `/writing` and `/writing/:slug` are rendered on the server. Raw HTML in Markdown is shown as text and only http(s), mailto and same-site links survive.
- Uploaded files are stored in Workers KV (one value per file, 25 MB max; bigger videos go on YouTube and are added as links).
- The owner's password is a Worker secret (`ADMIN_PASSWORD`). Changing it logs out every session.

## Develop

```bash
npm install
echo ADMIN_PASSWORD=devpass > .dev.vars
npm run dev      # http://localhost:8787, studio at /studio, CV at /cv
npm test         # API tests (Vitest, in-memory KV, SQLite standing in for D1)
```

## Deploy

Cloudflare deploys the site straight from this repo (Workers Builds): every push to `main` goes live. One-time setup in the Cloudflare dashboard:

1. Workers & Pages → Create → Import a repository → pick this repo → Deploy.
2. The new worker → Settings → Variables and Secrets → Add → type Secret, name `ADMIN_PASSWORD`.

GitHub Actions runs the tests on every push and pull request.
