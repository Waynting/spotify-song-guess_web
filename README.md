# GuessSong

A local party music guessing game powered by Spotify playlists. Live at **[guessong.app](https://www.guessong.app)**.

No login, no accounts. The host pastes a public Spotify playlist URL, everyone guesses out loud, and the host awards points.

Current version: **1.1.0** — see [CHANGELOG.md](./CHANGELOG.md).

## How It Works

1. **Setup** — Paste a public Spotify playlist URL, add player names, choose a clip length and song count, hit Start
2. **Play** — A short audio clip plays; everyone guesses the song
3. **Score** — The host taps whoever got it right
4. **Finish** — Final scoreboard with a shareable results image

Clip lengths are `5 / 10 / 15 / 20 / 30` seconds; song counts are `10 / 20 / 30 / 50 / all`.

### Scoring

The host is the judge — there's no automated answer checking.

| Award | Points | Where |
|---|---|---|
| Correct song | +3 | Party & Buzzer modes |
| Correct album | +1 | Party & Buzzer modes |
| Correct "whose playlist is this?" | +2 | Mixed Playlist Mode only |
| Correct guess | +1 | Trial mode (solo) |

One award of each type per round.

## Game Modes

Two orthogonal choices: **how you play** and **where the songs come from**.

### How you play

| Mode | What it is |
|---|---|
| **Party** (default) | Host types the player names, plays clips, and manually awards points. |
| **Trial** | Zero-setup demo — tap one of the three bundled playlists and play solo, +1 per round. Never calls Spotify. |
| **Buzzer** | Everyone scans one QR code and gets a full-screen buzzer on their own phone. A Cloudflare Durable Object decides who pressed first, so the host can stop refereeing and actually play. Only offered when `NEXT_PUBLIC_BUZZER_WS_URL` is set. |

### Where the songs come from

| Source | What it is |
|---|---|
| **Own playlist** | The host pastes one public Spotify playlist URL. |
| **Built-in** | Three bundled, preview-verified playlists (華語金曲, Western Classics, 2010s Pop Hits — 16 tracks each). No Spotify credentials needed. |
| **Mixed Playlist Mode** | Merge everyone's playlists into one pool. Either a **QR room** (players scan and submit their own playlist URL from their phone) or **phone mode** (pass one phone around). Tracks are deduped with provenance and fair-sampled per contributor, and a round-scoring history feeds a shareable "group taste card" at the end — most obscure picks, most mainstream picks, most shared tracks. |

Buzzer Mode and Mixed Playlist Mode share a single room code and QR: the host claims the buzzer room first, then opens the playlist mailbox under the same code.

## Features

- Spotify playlist import via Client Credentials — no user auth, players never see a Spotify sign-in
- Three game modes and three playlist sources (above)
- 30s audio previews resolved from the **iTunes Search API**, falling back to **Deezer** — both keyless, so there is nothing to sign up for
- Blurred album art hint system, live progress bar + countdown, replay from the guessing phase
- Export the final scoreboard (and the Mixed-mode taste card) as a PNG
- Fully **bilingual** — English and Traditional Chinese landing pages (`/`, `/zh`), plus every user-facing error string in both languages, picked by device locale
- In-app "What's new" release notes overlay
- Installable as a PWA, with Android Web Share Target support — share a Spotify playlist link straight into the app
- GA4 analytics behind a typed event union (opt-in via env var)
- Mobile-first layout

## Stack

- **[Next.js 15](https://nextjs.org/)** App Router, React 18, TypeScript
- **Tailwind CSS** + [shadcn/ui](https://ui.shadcn.com/) primitives (the setup and game pages use inline styles instead)
- **Spotify Web API** (Client Credentials) for playlists
- **iTunes Search API** → **Deezer** for audio previews — both are public, unauthenticated endpoints: no key, no account, nothing in `.env`
- **[Upstash Redis](https://upstash.com/)** for rooms, rate limiting, and the playlist/preview caches (falls back to an in-process `Map` locally)
- **[Cloudflare Workers](https://workers.cloudflare.com/) + Durable Objects** for live buzzer rooms (`worker/`)
- **[Vitest](https://vitest.dev/)** for both suites; `zod` for request validation, `qrcode` for room QR codes

This is a **two-deployment project**: the Next.js app on Vercel, the buzzer Worker on Cloudflare. Everything except Buzzer Mode works with just the first.

## Getting Started

### 1. Clone & install

```bash
git clone https://github.com/Waynting/GuessSong.git
cd GuessSong
npm install
```

### 2. Environment variables

```bash
cp .env.example .env.local
```

| Variable | Required? | Notes |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | Yes | App-level Client Credentials, not user login — no redirect URI. Get them at [developer.spotify.com](https://developer.spotify.com/dashboard). Every playlist comes from Spotify, so nothing loads without these. |
| `SPOTIFY_CLIENT_SECRET` | ⤴ | |
| `UPSTASH_REDIS_REST_URL` | Production | Backs rooms, rate limits, and both caches (`lib/kv.ts`). Unset locally → in-process `Map`, which is fine for one `next dev` process but **not** for multi-instance serverless. Free tier at [upstash.com](https://upstash.com). |
| `UPSTASH_REDIS_REST_TOKEN` | ⤴ | |
| `NEXT_PUBLIC_BUZZER_WS_URL` | Buzzer Mode only | `ws://127.0.0.1:8787` locally, `wss://guesssong-buzzer.<subdomain>.workers.dev` in production. Unset → the Buzzer Mode toggle is hidden. |
| `NEXT_PUBLIC_BASE_URL` | Optional | Defaults to `https://www.guessong.app`. |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Optional | Injects GA4 when set. Events no-op outside production regardless. |
| `SPOTIFY_MAX_LOADS_PER_MINUTE` | Optional | Global ceiling on uncached Spotify playlist loads, per minute. Default `40`. |
| `SPOTIFY_MAX_LOADS_PER_DAY` | Optional | Global ceiling per rolling 24h, counted in hourly buckets. Default `2000`. This is the one that stops Spotify's daily app quota being spent in an afternoon — see [Caching and admission control](#caching-and-admission-control). |
| `SPOTIFY_BUDGET_WARN_RATIO` | Optional | How much of the daily ceiling has to be gone before hosts see the heads-up popup. Default `0.8`. Raise it to warn later and less often. |
| `PREVIEW_MAX_LOOKUPS_PER_MINUTE` | Optional | Global ceiling on iTunes/Deezer lookups. Default `120`. |
| `DEV_ORIGINS` | Optional, dev only | Comma-separated LAN hostnames (no scheme, no port) added to `allowedDevOrigins`. Needed to test from a phone. |

**Nothing above configures the audio lookup, and nothing needs to.** The iTunes Search API and Deezer's public search are unauthenticated — there is no key to obtain and no variable to set, which is why they appear neither in this table nor in `.env.example`. Every 30s clip the game plays comes from one of them. `PREVIEW_MAX_LOOKUPS_PER_MINUTE` is the only related knob and it is a ceiling we impose on ourselves, not a credential: Apple rate-limits by IP rather than by key, and a serverless deploy's egress IPs are shared across the whole user base — see [Caching and admission control](#caching-and-admission-control).

### 3. Run the dev server

```bash
npm run dev
```

Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)**.

> Use `127.0.0.1:8000` specifically — the Spotify app is configured for this origin.

### 4. Buzzer Mode locally (optional)

Buzzer Mode needs the Cloudflare Worker running alongside Next.js:

```bash
cd worker
cp .dev.vars.example .dev.vars   # then add your LAN IP to ALLOWED_ORIGINS
npm install
npm run dev                       # wrangler dev on :8787
```

Then set `NEXT_PUBLIC_BUZZER_WS_URL=ws://127.0.0.1:8787` in `.env.local`.

**Testing with real phones is where this trips people up.** Phones on your Wi-Fi hit the dev server by LAN IP, not `127.0.0.1`, and that LAN origin has to be allowed in *two* places:

```bash
ipconfig getifaddr en0            # macOS Wi-Fi — e.g. 10.107.0.98
```

- `.env.local` → `DEV_ORIGINS=10.107.0.98` (hostname only — Next.js refuses cross-origin `/_next/*` otherwise)
- `worker/.dev.vars` → add `http://10.107.0.98:8000` to `ALLOWED_ORIGINS` (full origin — the browser sends this on the WebSocket upgrade)

## Scripts

**Root (Next.js app)**

| Command | Description |
|---|---|
| `npm run dev` | Dev server on port 8000 |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npm test` | Vitest suite in `tests/` — does **not** include the Worker tests |

**`worker/` (Cloudflare buzzer Worker)**

| Command | Description |
|---|---|
| `npm run dev` | `wrangler dev --ip 0.0.0.0` on port 8787 |
| `npm run deploy` | `wrangler deploy` |
| `npm run test` | Durable Object tests, run inside workerd via `@cloudflare/vitest-pool-workers` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run types` | Regenerate `worker-configuration.d.ts` |

## Project Layout

```
app/
  page.tsx                   Setup — playlist, players, clip length, mode selection
  game/page.tsx              The game — phase machine, playback, scoring, result images
  about/                     "How to play" page
  zh/                        Traditional-Chinese landing page (written natively, not translated)
  guides/                    Guides index + eight articles (metadata declared in lib/guides.ts)
  privacy/, terms/, contact/ Policy pages; zh/privacy and zh/terms are the Chinese halves
  j/[code]/                  Mixed Playlist Mode join page
  buzz/[code]/               Buzzer Mode player page (holds the live WebSocket)
  share/                     Web Share Target handler + /share/unsupported explainer
  icons/[size]/              PWA icons, prerendered at build (never per request)
  api/                       See the table below
  error.tsx, global-error.tsx  Error boundaries — see "When the client throws" below
  icon.tsx, opengraph-image.tsx, robots.ts, sitemap.ts
components/                  Buzzer button + host panel, room panel, mixed collector,
                             install banner, changelog modal, service notice,
                             crash screen, ui/ (shadcn primitives)
lib/                         All shared logic — see "Architecture" below
worker/                      Cloudflare Worker + BuzzerRoom Durable Object
tests/                       31 Vitest files, 567 cases
types/                       Track, room, preview, and service-status wire types
```

## API Routes

Every route is IP rate limited (`lib/rate-limit.ts`) with a fixed window; limits below are per IP.

| Route | Method | Purpose | Limit |
|---|---|---|---|
| `/api/playlist` | POST | `{url}` → playlist name + tracks, via Spotify Client Credentials. Editorial playlists (IDs starting `37i9`) are rejected — they 404 for new apps. | 30 / 10 min |
| `/api/preview` | GET | `?track=&artist=&id=` → `{previewUrl, status}` where status is `found` / `absent` / `unavailable`. `&refresh=1` re-resolves a URL that stopped playing. | 300 / 10 min (refresh: 30) |
| `/api/preview/batch` | POST | `{tracks:[{id,name,artist}]}` (max 60) → previews for a whole game in one request. | 20 / 10 min |
| `/api/room` | POST | Optional `{code}` → `{roomCode, hostToken, expiresAt}`. Creates the Mixed Playlist mailbox. | 10 / 10 min |
| `/api/room/[code]/submit` | POST | `{playerName, playlistUrl}` → `{ok, trackCount}`. | 20 / 10 min |
| `/api/room/[code]/status` | GET | Who has submitted so far (host polls every 4s). | 200 / 10 min |
| `/api/room/[code]/pool` | GET | `?sampledPerPlayer=N` + `x-host-token` header → the sampled, deduped pool. One-shot consume. | 20 / 10 min |
| `/api/status` | GET | `{throttled, approachingLimit, code, retryAfterSeconds}` — how much of the shared Spotify allowance is left. One KV read, never touches Spotify. Drives the site notice. | 120 / 10 min |
| `/share` | GET | Web Share Target — extracts a playlist from shared text and redirects to `/?playlist=…`. | — |
| `/icons/[size]` | GET | Generated PWA icons (`192`, `512`, `maskable`). | — |

**Worker** (separate Cloudflare origin): `POST /rooms` → `{code, hostToken, expiresAt}`, `GET /rooms/:code/ws` → WebSocket upgrade.

## Architecture Notes

### Audio previews

Spotify deprecated `preview_url` in Nov 2024 and now returns `null` for **every** track on Client Credentials — measured 0/20 across four markets — so `Track` carries no `previewUrl` field at all and every clip the game plays is resolved by this app. On mount the game page prefetches the whole game with one `POST /api/preview/batch`; anything unresolved falls back to `GET /api/preview` lazily when the host presses Play. Both search the iTunes Search API first, then Deezer, and neither needs credentials.

Choosing *which* result to play takes two signals, because neither survives every case on its own. Credits are routinely translated — iTunes returns 盧廣仲 as "Crowd Lu", 小幸運 as "A Little Happiness" — while a cover shares the original's title by definition, so on a CJK track the only string that lines up often belongs to the wrong recording. Running time is translated by nobody and agrees with Spotify to within a millisecond or two, which is exactly what a re-recording does not do. So the two check each other, and the loosest queries — the title-only ones, where upstream was handed no artist to rank by and answers "Hello" with Pinkfong's nursery rhyme rather than Adele's — are only accepted when one of them verifies. Everything else is handed to the next source.

Preview results are three-way, not two-way: `found`, `absent` (nothing has a clip — cached a week), and `unavailable` (we were throttled or the request never got through — cached 90 seconds). Collapsing those two nulls is a real bug that shipped once: one throttled minute marked a slice of the catalogue silent for a week.

### Caching and admission control

Spotify throttles per **client ID**, so every visitor shares one budget — per-IP rate limits bound one abusive client but do nothing about aggregate load. iTunes and Deezer throttle per IP, and a serverless deploy's egress IPs are shared, so the whole user base looks like one very noisy client. Both `lib/playlist-cache.ts` and `lib/preview-cache.ts` therefore run the same three layers, all fail-open, all in KV so every instance sees them:

1. **Cache** — a repeat playlist or track costs zero upstream calls
2. **Global budget** — a shared counter that refuses new work before upstream does
3. **Cooldown** — when upstream returns 429, uncached loads are parked for `Retry-After`; cached content keeps serving, so a party mid-game is unaffected

`lib/playlist-cache.ts` also coalesces concurrent loads of the same playlist into one fetch, which matters because a QR room produces a burst of simultaneous submits from one click.

### Buzzer rooms

Vercel pins WebSocket connections to a single function instance with no guarantee a second connection lands on the same one — there's nothing to broadcast a room to. So live rooms run on Cloudflare instead. The host `POST`s to the Worker's `/rooms`, which generates a 4-character code from an ambiguity-free alphabet and claims a Durable Object by that name; the DO *is* the registry, so a non-null return is the collision check. Players connect to `/rooms/:code/ws`, and ordering is decided by the DO's single-threaded execution — no locks, no CAS. Verdicts stay human: the room decides *who* was first, a person decides *whether* they were right. Max 12 players, 3h idle timeout.

### When the client throws

The app had no error boundary anywhere in `app/`, which meant any uncaught client-side error — a mount effect, a chunk that failed to load, a stored payload that could not be read — replaced the whole page with Next's default: *"Application error: a client-side exception has occurred (see the browser console for more information)."* For a host with a room full of people waiting, that sentence names no cause, offers no action, and its only instruction is to open a developer console. It also reported nothing, so the first anyone heard of a crash was an email weeks later.

`app/error.tsx` and `app/global-error.tsx` now catch both levels and render `components/crash-screen.tsx`: a bilingual message saying the site broke rather than the playlist, a **Start over** button that clears the stored game and returns to setup, a **Try again** that re-runs the render, and Next's error `digest` printed as a reference a bug report can quote. Every catch fires the `client_error` analytics event, bucketed by which boundary caught it — never the message or the stack, which would carry pasted playlist URLs into GA4.

Two hardenings sit underneath, both on the path from Start to `/game`:

- **The stored game is validated, not cast.** `parseGamePayload` used to `as Track[]` whatever JSON came back, so one malformed entry reached the render and threw. It now repairs what it can (a missing `artists` becomes `[]`, a missing `durationMs` becomes `0`) and drops only what nothing can play — no `id`, no `name`. The repair-or-drop split is the same rule the `GAME_MODES` guard follows: a game already sitting in a host's sessionStorage has to keep playing across a deploy.
- **Storage is guarded on both sides.** `sessionStorage` *throws* rather than returning null in a locked-down browser (Safari with "Block All Cookies", several embedded webviews), and the throw is on the property access itself. `lib/game-storage.ts` is now the only way the payload is written and read. A refused write is reported as `storage_blocked` — it used to sit inside the same `try` as the playlist fetch and surface as "Couldn't load that playlist", which sent hosts off to swap links that were never the problem.

### The site notice

`components/service-notice.tsx` is a one-time popup about the shared Spotify allowance, shown before a host pastes a link rather than after they press Start. It has two states, and the earlier one is the point:

- **warning** — the day's allowance is nearly spent and everything still works. Fires at `SPOTIFY_BUDGET_WARN_RATIO` (default 0.8). A host reading this at eight can load their playlist while there is allowance for it; told at ten, when the refusal lands, they have no move left.
- **blocked** — new playlists are not loading, because Spotify is refusing us or we are rationing ourselves.

Both read `GET /api/status`, which reads the same KV keys the admission gate writes — so the notice appears and disappears on its own, with nobody remembering to take a banner down. The threshold is evaluated on the pass `claimDailyBudget` was already making, and the status route still costs exactly one KV read; summing 24 hourly buckets there would have made the notice more expensive than the gate it reports on. Dismissal is keyed by error code, not a flag, so waving away the warning does not silence the refusal it predicted.

### Error messages

`lib/error-messages.ts` is the only place a user-visible error string exists — one code union and one `{en, zh}` table, so a missing translation is a compile error. The server sends `{error, code}` and the client picks the language from the device locale. Localising server-side would be wrong: one room is read by several devices, and cached 404s would freeze one language into the cache for everyone.

### Release notes

Two hand-written changelogs, and a release updates both: [`CHANGELOG.md`](./CHANGELOG.md) is the maintainer's technical record, `lib/changelog.ts` is the plain-language bilingual copy players read in the footer overlay. `tests/changelog.test.ts` pins `LATEST_VERSION` to `package.json`'s version, so bumping one without the other fails the suite.

## Testing

```bash
npm test              # 31 files, 567 cases — vitest, jsdom
cd worker && npm test # Durable Object tests inside workerd
```

The root suite covers the pure logic (pooling, taste card, share-target parsing, game-session round-trips) and the parts most likely to regress expensively: `tests/playlist-cache.test.ts` asserts upstream **call counts** for cache hits, coalescing, cooldowns and budgets, and `tests/preview.test.ts` drives the real route handlers to pin found/absent/unavailable classification. There's no CI workflow in this repo — run both suites before shipping.

## Gameplay Notes

- **Playlists** — use public playlists you created. Spotify editorial playlists (Discover Weekly, Today's Top Hits, …) are not supported: those IDs return 404 for new apps.
- **Previews** — a small number of tracks have no 30s clip on either iTunes or Deezer and will show a "no audio" state.
- **Scoring** — the host is the judge. No automated answer checking.
- **Found a bug?** — use the "Report a problem" link in the footer.

## Docs

This README gets you running. [`docs/`](docs/README.md) explains the parts that
need more than a paragraph:

- [**architecture**](docs/architecture.md) — the system in diagrams: the
  Vercel/Cloudflare split, one game end to end, and the four-layer shape shared
  by all three caches
- [**viral-loop**](docs/viral-loop.md) — the five loop surfaces, and how to run
  and read `npm run stats` without drawing the wrong conclusion
- [**operations**](docs/operations.md) — deploying (the Worker is manual),
  reading the cache logs, and symptom-by-symptom troubleshooting
- [**decisions**](docs/decisions.md) — why there are no accounts, why buzzer
  rooms are Durable Objects, and what was considered and rejected

`CLAUDE.md` is the other half: the invariants and hazards, written for whoever
or whatever edits this next.

## License

[MIT](./LICENSE) — fork it, remix it, host your own.
