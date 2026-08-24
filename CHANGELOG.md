# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.4] - 2026-08-24

A host wrote in: the site loads, they paste a playlist, they press Start, and
the page becomes

> Application error: a client-side exception has occurred while loading
> www.guessong.app (see the browser console for more information).

Chrome and Safari both. Several different public playlists. They read every
troubleshooting page on the site and found nothing, which is the part worth
sitting with — there was nothing to find, because the message names no cause,
offers no action, and its one instruction is to open a developer console.

`POST /api/playlist` was answering 200 with a valid track list throughout. The
failure was entirely on the client, and the reason it could take the whole page
down is that **`app/` had no error boundary anywhere in it**. Any throw, from
any component or effect, unmounted the tree and fell through to Next's default
screen. Nothing recorded it either: the first anyone heard was the email.

So this release does two things — removes the throws that were reachable on the
path from Start to `/game`, and makes sure the next one that is not reachable
today lands somewhere a host can act on.

### Fixed

- **The game payload is validated on the way out of sessionStorage**
  (`lib/game-session.ts`). `parseGamePayload` cast `d.tracks` with
  `as Track[]` — a blind cast, sitting in a module whose every other field goes
  through a guard. `app/game/page.tsx`'s preview-prefetch effect dereferences
  `t.artists[0]` on mount, so a single entry without an `artists` array was a
  `TypeError` inside an effect with no `try` of its own. Reproduced against the
  production build: it renders exactly the reported sentence.

  `normalizeTrack` now repairs what a game can play without and drops only what
  it cannot. `artists` becomes `[]` and `durationMs` becomes `0`; a track with
  no `id` or no `name` is dropped, because nothing can look up a clip for the
  first and there is no answer to reveal for the second. Players get the same
  treatment — a nameless entry is dropped rather than rendered as a blank
  scoreboard row. The repair-or-drop split is the rule `GAME_MODES` and
  `PLAYLIST_SOURCES` already follow, and for the same reason: a payload sitting
  in a host's sessionStorage at deploy time has to keep playing.

- **Every read and write of the payload is guarded** (`lib/game-storage.ts`,
  new). `sessionStorage` *throws* rather than returning null in a locked-down
  browser — Safari with "Block All Cookies", Chrome with site data disallowed,
  several embedded webviews — and it throws on the property access itself, so
  the `try` has to wrap the access and not just the call. `lib/host-session.ts`
  has documented this since it was written and guards everything it owns; the
  game payload was the one path that did not. `app/game/page.tsx:215` read the
  key bare inside a mount effect.

  `saveGameTo` / `loadGameFrom` / `clearGameFrom` take the store as an argument
  so `tests/game-storage.test.ts` can hand them one that throws, which is the
  case no browser on a developer's desk reproduces on demand.

- **A browser that refuses storage is no longer reported as a bad playlist**
  (`app/page.tsx`, `lib/error-messages.ts`). All three `setItem` call sites sat
  inside the same `try` as the playlist fetch, so a `SecurityError` there came
  out of `describeError` as `playlist_load_failed` — "Couldn't load that
  playlist". That is the same mistake as the message that used to tell
  throttled hosts to check their URL was public, and it produces the same
  behaviour: the host swaps playlists all evening, reads the help page, and
  gets nowhere. Exactly what the report describes.

  New code `storage_blocked` names the browser and says what to change.
  Deliberately *not* in `isDeterministicPlaylistFailure`: the same URL will work
  fine once the setting is changed, so the retry has to stay open.

### Added

- **`app/error.tsx` and `app/global-error.tsx`**, rendering
  `components/crash-screen.tsx`. The route boundary catches everything below the
  root layout; the global one catches the root layout itself and supplies its
  own `<html>`/`<body>`, so nothing it renders may depend on anything the layout
  would have loaded.

  The screen says the site broke rather than the playlist, offers **Start over**
  (clears the stored game, returns to setup — the recovery for the whole class
  of causes, since an unreadable payload is gone the moment it is dropped),
  **Try again** (`reset()`, for the transient half such as a chunk that failed
  to load once), a link to the issue tracker, and Next's error `digest` as a
  reference a bug report can quote. Bilingual through `lib/error-messages.ts`
  like every other player-facing string.

- **The `client_error` analytics event** (`lib/analytics.ts`), fired from the
  boundary and bucketed by which boundary caught it — `route` or `root`. No
  message, no stack, no digest: stack frames carry pasted playlist URLs and
  query strings into GA4, which is the cardinality-and-user-input rule the rest
  of that file already keeps. The digest goes to `console.error` on the device,
  which is where the person reading it already is.

- **The site notice now warns before it refuses** (`lib/service-notice.ts`,
  `lib/playlist-cache.ts`, `types/service-status.ts`,
  `components/service-notice.tsx`). 1.7.2 put a notice in front of the host, but
  only once the allowance was already spent — by which point the only thing left
  to tell them is to come back tomorrow.

  `GET /api/status` now answers with `approachingLimit` as well as `throttled`,
  and the notice has two states with two headlines. `warning` fires at
  `SPOTIFY_BUDGET_WARN_RATIO` (new, default `0.8`) of `SPOTIFY_MAX_LOADS_PER_DAY`
  and says the site still works, which is the whole point: a host reading it at
  eight o'clock can load their playlist while there is allowance for it, or pick
  one that is already cached. `blocked` is the existing refusal notice,
  unchanged.

  Three properties this had to have, all tested:

  - **It costs nothing extra.** `claimDailyBudget` already has the day's `used`
    in hand on every cold load, so the threshold is a conditional `set` on the
    crossing loads and nothing on the rest; `getSpotifyServiceStatus` reads the
    flag as one more key in the `mget` it already spends.
    `tests/playlist-cache.test.ts` counts the reads — summing 24 hourly buckets
    in the status route would have made the notice more expensive than the gate
    it reports on, which is the trap `DAILY_SPENT_KEY` was built to avoid one
    step earlier.
  - **A refusal outranks the warning it grew out of.** `throttled` and
    `approachingLimit` are never both true. "You are about to run out" tells
    someone who already has that the site still works.
  - **The two headlines are different sentences.** "New playlists aren't
    loading" is false during a warning, and a host who reads it walks away from
    a site that would have worked for them — strictly worse than staying quiet.
    Dismissal stays keyed by error code, so waving away `spotify_budget_low` at
    eight does not silence `spotify_daily_budget_spent` at ten.

### Documentation

- `CLAUDE.md` gains two sections: **A client-side throw must never be a dead
  end** (why the boundaries exist, and the three rules on the Start → `/game`
  path) and **The site notice warns before it refuses**.
- `README.md`: new **When the client throws** and **The site notice** sections;
  `/api/status` added to the route table, which had never listed it;
  `SPOTIFY_MAX_LOADS_PER_DAY` added to the environment table, which had never
  listed it either; test and file counts corrected (they said 17 files / 273
  cases against an actual 31 / 567).
- `.env.example`: the three Spotify budget knobs and
  `PREVIEW_MAX_LOOKUPS_PER_MINUTE` documented; dropped the note about "the 3
  built-in trial playlists", which have not existed since 1.5.0.

### Known gaps

- **The reported crash is fixed by construction, not by reproduction.** The
  malformed-track path was reproduced against the production build and produces
  the reported sentence exactly; the storage-blocked path was reproduced with
  `sessionStorage` overridden to throw. Which of the two that host hit is not
  known, and a third cause reaching the same screen is not ruled out — a chunk
  that fails to load mid-navigation would look identical. `client_error` is
  there so the next one is a number rather than an email. That the reporter had
  the same failure in Chrome *and* Safari is consistent with iOS, where both are
  WebKit, and no WebKit engine was available here to test against.
- **`app/error.tsx` cannot catch a throw during a server render**, and neither
  boundary catches an unhandled promise rejection. Neither is reachable on the
  path this release is about, but neither is impossible.
- **The warning threshold has never run against real traffic.** 0.8 of 2,000 is
  1,600 loads, and a normal day is ~2,152 cold loads, so it should trip most
  evenings. If it turns out to trip at lunchtime every day it becomes wallpaper;
  `SPOTIFY_BUDGET_WARN_RATIO` is retunable from Vercel without a deploy for
  exactly that reason.

## [1.7.3] - 2026-08-23

1.7.2 put the notice in front of the host before they paste a link. It said the
site was refusing new playlists, it said the Spotify quota was shared, and it
stopped there. A host who reads only that is left with two readings, and both
are wrong: that nobody is looking after the site, or that somebody could fix
this by paying for it.

Neither is true. GuessSong is free, and Spotify's quota is not something a
project this size can buy more of. So the notice now says that, apologises for
it, and ends on the one door that is actually open.

### Changed

- **`spotify_quota_exhausted` and `spotify_daily_budget_spent`**
  (`lib/error-messages.ts`), in both languages. Each now opens with an apology,
  says the app is free and shares one Spotify quota, says Spotify's policy
  leaves no way to buy a bigger one, and closes by pointing at the source for
  anyone who would rather run their own copy on their own credentials.

  Everything 1.7.2 pinned still holds and is still tested: no `{seconds}` on
  either code, neither blames the host's playlist, both still end on "your
  playlist URL is fine" / 「你的歌單連結沒有問題」, and neither joins
  `isDeterministicPlaylistFailure`. `tests/error-messages.test.ts` adds the new
  half — apology, "free", and "open source" present in *both* languages,
  because a translation is exactly where the awkward second half of a sentence
  gets dropped.

  They remain two codes differing in their first sentence, which is the only
  sentence that should differ: one is Spotify refusing us, the other is us
  refusing ourselves before Spotify does.

- **The notice ends on a link, not a sentence** (`components/service-notice.tsx`;
  `SELF_HOST_URL` and `SERVICE_NOTICE_UI.repo` in `lib/service-notice.ts`).
  "You can run your own copy" is only a remedy if it is reachable. The URL is
  chrome on the popup rather than prose inside the message, because the same
  string is also rendered as plain text under the Start button where nothing is
  clickable. The Chinese label carries no ASCII, which `tests/service-notice.test.ts`
  now pins for `repo` alongside the other three strings.

### Fixed

- **The dialog scrolls when it is taller than the phone.** The body roughly
  doubled in length, and `document.body` is `overflow: hidden` for as long as
  the notice is open — so on a short viewport the end of the message, including
  the line saying the host's playlist is fine, was unreachable. `.sn-card` caps
  the height and scrolls.

  It carries `max-height: calc(100vh - 32px)` and then the same in `dvh`, in
  that order. `dvh` is the correct unit because it excludes the mobile URL bar,
  and Safari below 15.4 drops the whole declaration rather than the one value —
  which would have silently restored the unscrollable card on exactly the old
  phones most likely to be short. Two declarations is also why this moved out of
  the inline style: a React style object cannot hold two values for one property.

- **The self-host link has a focus ring.** The dialog traps Tab, and until now
  there was only one thing to trap. A second focusable with no `:focus-visible`
  style is invisible to a keyboard on `#1a1a1a`.

### Known gaps

- The repo URL is now a fifth hand-written copy of the same literal
  (`app/about`, `app/contact`, `app/zh`, `components/site-footer`, and now
  `lib/service-notice`). Following the existing convention was chosen over
  centralising during a copy change; a shared module that all five import is the
  obvious follow-up, and it touches four files that have nothing else to do with
  this release.
- The link's touch target is about 20px tall, next to a 44px button. Fine on a
  desktop, tight on a phone, and left alone rather than redesigned here.

## [1.7.2] - 2026-08-23

1.7.1 made the refusal message honest. It did not make it *early*: the only way
to learn the site was throttled was still to paste a playlist, press Start, and
be turned away. On the morning this shipped Spotify was refusing the app with
`retry-after: 48925` — 13.6 hours — and every host arriving at the setup page
had to spend a request to find that out.

A hand-written banner was the obvious answer and the wrong one. The quota
clears on Spotify's schedule, usually overnight, so a static notice needs
somebody to remember to take it down the next morning. Every mechanism in this
codebase that has depended on somebody remembering has eventually failed
silently, and a stale "the site is down" banner over a working site is a worse
failure than the one it was put up for.

So the notice reads the same KV key the admission gate writes.

### Added

- **`GET /api/status` and `getSpotifyServiceStatus()`** (`app/api/status/route.ts`,
  `lib/playlist-cache.ts`). One KV read — an `mget` of `spotify:cooldown` and
  `spotify:budget:spent`, the two gates below — with no upstream call, no budget
  claimed and no miss recorded; it is outside the admission path entirely. Rate limited like every other route (`STATUS_LIMIT` 120 /
  10 minutes), which is the two commands per call the limit is protecting.

- **`components/service-notice.tsx`**, mounted on `/`, `/zh` and `/j/[code]` —
  the three places somebody is about to hand the app a playlist URL. Deliberately
  *not* on `/game`: a party mid-round already has its tracks and cannot act on
  the news.

  It takes an optional `locale`, the way `SiteFooter` and `ChangelogModal` do,
  and `/zh` passes `"zh"`. Left to `useErrorLocale()` alone it renders the
  *device* language — correct for an error, since one room is read by several
  phones, and wrong for a page written natively in Chinese, where an English
  string is a visible defect rather than a fallback. Caught by loading `/zh` in
  an `en-US` browser, which is exactly what a Taiwanese host on an English
  phone is.

- **`lib/service-notice.ts`** holds `shouldShowNotice` and the UI strings, in
  `lib/` for the reason `lib/song-count.ts` gives — the suite only reaches
  `lib/`, and vitest cannot import a `.tsx` module here.

### Notes on two things that are easy to undo

- **The notice's code comes from `cooldownError`, not from a second threshold.**
  `getSpotifyServiceStatus` builds the error and reads its `code` off it, so the
  banner and the Start button are rendered from one decision. Re-deriving
  "is this a blip or the daily quota" beside the component would let the two
  surfaces disagree about the same fact, and the reader has no way to tell which
  one is lying. `tests/playlist-cache.test.ts` asserts the two codes are equal.

- **The dismissal is keyed by `AppErrorCode`, not a boolean.** A host who waved
  away a 90-second `spotify_cooldown` has not been told that the day's quota is
  now gone; collapsing those into one flag hides the more serious message behind
  a dismissal of the lesser one. It is `sessionStorage`, not `localStorage`, for
  the matching reason — the next visit may be a different outage.

- **`types/service-status.ts` holds the wire type**, not `lib/playlist-cache.ts`,
  so the browser bundle does not pull in `lib/kv.ts` and the Upstash client
  through it. Same split, same reason, as `types/preview.ts`.

- **Everything fails open.** `getSpotifyServiceStatus` returns "not throttled"
  on a KV error and the client returns null on a failed fetch, so a cache outage
  renders no notice rather than a false one.

### The gate the notice reports on

The other half of this release is what decides whether there is anything to put
a notice about.

`SPOTIFY_MAX_LOADS_PER_MINUTE` has never fired in production. `spotify:budget`
was sampled at 0-1 throughout the morning of 2026-08-23 while the site was cut
off, because a day's traffic arriving at one or two loads a minute passes a
40-a-minute ceiling without ever touching it. It bounds a burst — twelve phones
submitting into one QR room — and Spotify meters a day. Nothing bounded the
dimension that actually cuts the app off.

**The window is rolling, not a calendar day.** Measured the same morning: the
app was refused after only 476 cold loads that day, because the previous
evening's 2,152 were still inside Spotify's window, and the `Retry-After`
resolved to 19:53 UTC rather than to any midnight. A `dayBucket` counter reset
at 00:00 UTC would let a busy evening and the following busy morning each pass
their own cap and together exceed anything Spotify allows — the exact failure it
would have been added to prevent. So the counter is twenty-four hourly buckets,
summed on every cold load.

### Added

- **`hourBucket()`** (`lib/kv.ts`), the same clock as `dayBucket` one resolution
  finer, because a rolling window cannot be built out of calendar buckets.

- **`claimDailyBudget()`** (`lib/playlist-cache.ts`) and
  `SPOTIFY_MAX_LOADS_PER_DAY`, default **2000** loads per rolling 24h. Every
  input to that number is an inference — Spotify publishes no figure; the
  dashboard showed ~3,850 requests on the day the quota died; a cold load costs
  ~1.2 requests since 1.7.1 — so 2,000 loads is ~2,400 requests, under the wall
  by a margin and just under a normal day's 2,152 cold loads. It will therefore
  refuse at the margin of a busy day, and that is the trade taken deliberately:
  ours is a counter that rolls forward hour by hour, Spotify's is a penalty box
  with a fixed 13.4-hour sentence.

- **`spotify_daily_budget_spent`** (`lib/error-messages.ts`). Not a reuse of
  `spotify_quota_exhausted`, whose text says Spotify has cut the site off. When
  this gate fires Spotify has done nothing; we refused ourselves. Producing the
  same screen from a false account of who decided is the same class of untruth
  as the message that used to tell throttled hosts to check their playlist was
  public, and it is excluded from `isDeterministicPlaylistFailure` for the same
  reason every other throttling code is.

- **`getDailyBudgetStatus()`**, and an hour-by-hour block in `npm run stats`.
  The limit above is a guess, and the shape of the window is the only evidence
  there is for tuning it — a day spent by lunchtime and a day spent at 11pm need
  opposite changes. `playlist:stats:*:miss` already says how many loads were
  spent; nothing said *when*.

### Changed

- **`getSpotifyServiceStatus` reads both gates**, in the one `mget` it was
  already spending. There are two ways for the playlist path to be shut, and at
  a limit tuned just under a normal day the second is not the rare case — a
  notice blind to it would be confidently wrong on exactly the days it matters.
  Spotify's own refusal outranks ours when both are live: it is the longer wait
  and the one the host can do nothing about.

### Notes on three more things that are easy to undo

- **The daily gate runs after the per-minute one, never before.** A load turned
  away for bursting has not gone upstream, so it must not spend a slot in a
  window that takes a day to give one back; a load turned away by the daily gate
  has spent a minute slot instead, which is back in sixty seconds. Reversing
  them lets one burst permanently shrink the day.

- **It reads, then increments — the opposite of `claimGlobalBudget`.** A minute
  counter that counts its own refusals is self-healing; a 24h one is not.
  Refusals would inflate the very sum that caused them and hold the gate shut
  for a day, so only loads that are actually going upstream may touch
  `spotify:budget:h:*`, and refusals are counted separately under
  `spotify:budget:refused:*`. The cost is that the check is not atomic against
  itself and a burst can overshoot by whatever is in flight — already capped by
  the per-minute gate, and a rounding error against a limit in the thousands.

- **`spotify:budget:spent` exists so the notice does not walk the window.**
  `/api/status` is a page-view-rate path whose whole cost claim is one KV read;
  summing twenty-four buckets there would make the notice more expensive than
  the gate it reports on. The gate leaves a flag with a TTL to the hour
  boundary, which is when the oldest bucket rolls out and the answer can change.

### Known gaps

- **This does not reserve anything for the evening.** It stops the 13.4-hour
  lockout, but a busy afternoon can still fill the window before the parties
  start. Real pacing needs the hourly distribution of traffic, which nothing in
  this repo recorded before today; the `npm run stats` block added here is the
  instrument for deciding it, and it needs a full day of data first.
- **The 2,000 is a guess and should be re-derived from the dashboard.** The
  honest measurement is the request count on a day the quota survives, against
  one where it does not.
- No analytics event. Whether the notice is seen or dismissed is currently
  unmeasured, which is the failure mode this repo keeps rediscovering. Adding
  one means extending the union in `lib/analytics.ts` and registering the params
  as GA4 custom dimensions, and registration is not retroactive.
- `startCooldown` still does not log the `Retry-After` it received, so the logs
  cannot answer "how long did Spotify actually ask for" — diagnosing this on
  2026-08-23 needed a hand-run `curl`.
- The notice is a modal. If throttling turns out to be frequent rather than
  exceptional, an inline banner on the setup form is the less intrusive shape.
- `next dev` cannot render any page in this repo: `tailwind.config.ts:54` calls
  `require("tailwindcss-animate")` under ESM and throws while postcss compiles
  the CSS. API routes still serve, so it fails looking like a component bug —
  no console error, `chrome-error://chromewebdata/`, dev server gone. Unrelated
  to this release; `npm run build && npm run start` is the way to see UI until
  it is fixed.

## [1.7.1] - 2026-08-23

Spotify stopped answering. Not the rolling-window throttle the code was built
for — the daily app quota, spent:

```
HTTP/2 429
retry-after: 52531
{"error":{"status":429,"message":"Too many requests","reason":"QUOTA_EXCEEDED"}}
```

14.6 hours, and reproducible from a laptop on a home IP with the same client
id, which rules out Vercel's shared egress and names the client id as the thing
being throttled. `lib/playlist-cache.ts` clamped that to 900 seconds, and the
clamp was doing two jobs it should never have shared: how long the site backs
off, and what the host is told. Against a 14.6-hour refusal it produced a host
reading "try again in about 780s", waiting thirteen minutes, and being told 780
seconds again — a countdown the app had no way to honour — while one host every
quarter of an hour was spent as a canary re-probing a quota with hours to run.

Why the quota went in the first place is two things, both measurable. The
Spotify dashboard's Endpoints panel showed ~1.75k calls/day to
`/v1/playlists/<id>` against ~2.1k to `/v1/playlists/<id>/tracks`. A ratio of
1.2 pages per playlist means the great majority of playlists fit in one page —
so the metadata call was very nearly pure waste, about 45% of every request the
site made. `GET /playlists/{id}` returns the first 100 tracks embedded in its
own reply; `SpotifyPlaylist` in `lib/spotify.ts` has *declared* `tracks.items`
since the file was written. The app parsed that page, dropped it, and spent a
second request on `/tracks?offset=0` fetching it again.

The other half is the cache. `playlist:stats:*` for 2026-08-22: 1,303 hits
against 2,152 misses, and 413 of those hits were replayed 404s — a real hit
rate of 890/3455, 26%. Only 406 warm keys existed at any moment because
`HIT_TTL_SECONDS` was six hours and parties are nightly, so a playlist first
loaded at 8pm was cold again by 8pm the next day. Neither number was visible
anywhere: `getCacheStats()` had them the whole time and nothing called it.

### Changed

- **`lib/spotify.ts`: the metadata call and page zero are one request.**
  `fetchPlaylistHead` asks `GET /playlists/{id}?fields=id,name,tracks(...)` and
  returns the name *and* the first page; `fetchPlaylistTracks` now takes that
  page instead of fetching it, and starts at page two. Saves exactly one
  upstream call on every cold load — for a sub-100-track playlist that is 2
  calls down to 1.
- **The `Promise.all` and its `AbortController` are gone.** They existed
  because the metadata call and page zero were separate requests for
  overlapping data: `Promise.all` settles on the first rejection while the
  losing half keeps paginating against Spotify long after the response has gone
  out. Merging the two deletes the failure mode instead of managing it — a
  failed head now costs zero track pages, which `tests/spotify.test.ts` pins.
- **`TrackPage.next` became `nextOffset` (plus `rawCount`).** The caller only
  ever asked `next` "is there another page" and then derived the offset from
  `TRACKS_PAGE_LIMIT` — arithmetic that breaks on a page of a different size,
  which is exactly what the embedded first page can be, since there is no
  `limit` to send it. `rawCount` is the page's entry count before nulls are
  filtered, and it is what separates "the page was absent" from "the page was
  100 local files".
- **`HIT_TTL_SECONDS` 6h → 24h.** A day covers tonight-to-tomorrow-night, which
  is the interval that actually repeats here. The cost is that a host who adds
  songs this afternoon may not see them tonight.
- **`MAX_COOLDOWN_SECONDS` 15min → 24h, and the clamp split in two.** The
  honest figure is stored and reported; the old 15 minutes survives as
  `COOLDOWN_PROBE_SECONDS`, which is now the TTL on the key rather than the
  value in it. The gate reopens on schedule, one refused request re-reads a
  fresh `Retry-After` and rewrites the cooldown, and no single bad header can
  park the site for a day.
- **The in-order pagination loop is bounded by `MAX_TRACK_PAGES`, not only by
  `tracks.length`.** Filtered-out entries never grow `tracks`, so on a playlist
  made of local files the only brake left was upstream telling the truth about
  `next`. The 5-call ceiling that comment claims is now enforced.

### Added

- **`spotify_quota_exhausted`** in `lib/error-messages.ts`, deliberately with no
  `{seconds}`. Above `COUNTDOWN_MAX_SECONDS` (10 min) a countdown stops being
  information and becomes a promise; the host gets the facts and the note that
  already-loaded playlists still work. It joins both throttling invariants in
  `tests/error-messages.test.ts` — never blames the playlist, never
  deterministic. `retryAfterSeconds` stays honest, because that is a header.
- **A fallback for a projection that stops working.** If `PLAYLIST_FIELDS` ever
  stops naming the embedded page the way Spotify expects, the reply comes back
  without `items` and no error — every playlist on the site would quietly load
  as empty. `rawCount === 0 && total > 0` catches exactly that, re-fetches page
  zero, and logs which constant to look at. This could not be verified against
  the live API while writing it, because the quota was spent; the fallback is
  the answer to that, not a substitute for checking.
- **`npm run stats` prints the cache table.** Hits, misses and hit rate for the
  playlist and preview caches, with replayed 404s subtracted out of the first
  and `unavailable` broken out of the second — the two subsets that make a
  healthy-looking number and an unhealthy situation read identically. Read by
  constructed key rather than by SCAN: `MATCH` still walks the whole instance,
  and `lib/preview-cache.ts` holds 200k+ keys, so two more namespace scans would
  have been ~400 extra REST round-trips on the one report this project asks
  people to run every session. Both kind sets are closed TypeScript unions, so
  mirroring them is mirroring a compile-checked set.

### Known gaps

- **The `fields` projection is unverified against the live API.** Spotify was
  still refusing every request when this shipped. `fields=name,tracks(total)`
  was confirmed working before the quota went; the `items(track(...))` half was
  not. The fallback above covers it, and the first cold load after the quota
  resets is the real check.
- **`SPOTIFY_MAX_LOADS_PER_MINUTE` is the wrong instrument for a daily quota.**
  A per-minute ceiling cannot stop an evening peak from eating the whole day's
  allowance by 9pm. A daily budget is the shape that matches; this release did
  not add one.
- **Extended Quota Mode has not been applied for.** At ~1,660 games/day the app
  has outgrown Spotify's development-mode allowance, and no amount of caching
  changes that ceiling — it only moves the date.
- **`startCooldown` still does not log the `Retry-After` it was handed.** The
  52531 above came from a manual `curl`; nothing in the logs would have said it.

## [1.7.0] - 2026-08-21

AdSense refused the site under "Low value content" (缺乏價值的內容). This release
is the response: the policy pages the review looks for, and enough editorial
content that the site is something other than a form.

The diagnosis was not subtle. `app/robots.ts` disallows `/game`, `/api`,
`/share`, `/buzz`, `/j` and `/r`, which leaves exactly three indexable URLs —
`/`, `/about`, `/zh`. `/zh` is `/` in another language and `/about` repeats
`/`'s FAQ almost verbatim, so the site's unique indexable surface was closer to
one and a half pages. The homepage's entire prose was the two paragraphs under
"What is GuessSong?" plus six FAQ answers; everything else on it is form
controls. And there was no privacy policy at all, on a site whose
`app/layout.tsx` loads both AdSense and GA4 — that alone is disqualifying, and
it is the item most likely to have triggered the category.

Eight guides is a judgement, not a target: enough that `/guides` reads as a
section rather than a gesture, and few enough that every one of them could be
written from something this project actually knows. Two of them
(`spotify-playlist-not-working`, `why-spotify-previews-disappeared`) are the
measured findings already recorded in this file and in CLAUDE.md — the 0/20
preview result across four markets, the `37i9` 404, the `403`-not-`429`
throttling signal, the `absent`/`unavailable` distinction. That content exists
nowhere else, which is the actual bar the policy is asking about.

### Added

- **`/guides` and eight articles under it.** `app/guides/page.tsx` is the index;
  each article is a real static route at `app/guides/<slug>/page.tsx`. Metadata
  is declared once in `lib/guides.ts` and derived from there by the route, the
  index, `app/sitemap.ts` and the "read next" links — the four-copy hand-sync
  that `lib/loop-links.ts` exists to avoid, and it fails the same silent way
  here (a guide missing from the sitemap is a page Google never returns for).
- **`app/guides/guide-shell.tsx`** — wraps every article: title, canonical,
  dateline, `Article` JSON-LD, related links and closing CTA, all from the slug.
  `requireGuide` *throws* on an unknown slug rather than rendering a page with
  holes in it. The slug is written by us in the same file as the prose, so a bad
  one is a typo that should fail the build, never a visitor's 404. That half —
  `requireGuide`, `guideMetadata`, `formatGuideDate` — lives in `lib/guides.ts`
  rather than beside the component, for the reason `lib/song-count.ts` gives:
  the suite only reaches `lib/`, and a `.tsx` module cannot be imported from it.
  What stayed in the shell is the part that is actually JSX.
- **`/privacy`, `/terms`, `/contact`, `/zh/privacy`, `/zh/terms`.** Written
  against what the code actually does — Client Credentials meaning Spotify is
  never told who is asking, title-and-artist being all that reaches iTunes and
  Deezer, room records carrying an expiry from creation, rate-limit counters
  living for the length of one window. A template would have been faster and
  wrong in ways a reviewer can check.
- **`components/site-footer.tsx`** — one footer for the whole site, and the only
  place the policy pages are linked from. Replaces three hand-rolled `<footer>`
  blocks in `app/page.tsx`, `app/about/page.tsx` and `app/zh/page.tsx`.
- **`components/article-shell.tsx`** — shared prose chrome. Server component
  with no client boundary; these pages are static text and a React state import
  would cost a bundle for nothing.
- **`lib/legal.ts`** — the one "last updated" date the four policy pages print.
  A literal, not a build timestamp: it has to mean "the day the wording changed",
  not "the day this deployed".
- **`tests/guides.test.ts`, `tests/site-policy.test.ts`** — 38 assertions over
  the joins that fail silently. Every slug has a directory and vice versa; every
  article's `SLUG` constant matches its own path (a copy-pasted article that kept
  the source's constant renders the wrong canonical under the right URL); every
  guide has at least one inbound sibling link; the sitemap lists all of them;
  both privacy pages name AdSense, Analytics and cookies and carry the opt-out
  link; the `/zh` footer contains no English label; `robots.ts` does not
  disallow any of the new paths.

### Changed

- `app/sitemap.ts` derives the guide entries from `lib/guides.ts` and adds the
  five policy URLs, with `hreflang` declared on both sides of each language pair.
- `app/page.tsx` gains a three-card guides teaser under the FAQ, resolved through
  `getGuide` rather than retyped, and filtered so a retired slug costs a card
  instead of crashing the homepage.
- `app/about/page.tsx` gains a section listing all eight.

### Not done

- **The guides are English only.** `/zh` is written natively rather than
  translated, so eight translated articles under it would be the one seam in the
  thing that page is for. The policy pages are bilingual because those have to
  be readable by the person they bind; the guides can wait for someone to write
  them in Chinese rather than render them in it.
- **No `dateModified` maintenance.** `guide-shell.tsx` emits `dateModified`
  equal to `datePublished`. Correct today, quietly wrong the first time an
  article is edited. It wants a second field in `lib/guides.ts`, not a build
  timestamp.

### Known gaps

- Nothing verifies that a guide's prose is still about what its `description`
  claims. The tests pin the plumbing, not the writing.
- `GUIDE_CATEGORIES` is ordered by hand. A category added to the union but not
  to that array makes its guides unreachable from `/guides`; the partition test
  in `tests/guides.test.ts` is what catches it, not the compiler.
- The `/zh` footer links to `/guides`, which is English. Labelled in Chinese,
  lands in English. Better than hiding the section from Chinese readers, but it
  is a seam.

### Fixed after release (2026-08-21, follow-up PR)

Shipped hours after 1.7.0 merged, no version bump: the defect is invisible to
players, and the repo ties a `package.json` bump to a `lib/changelog.ts` entry
that the footer overlay prints to them. An entry reading "corrected our hreflang
annotations" fails the bar every existing entry meets.

- **The policy pages' language clusters were annotated on one side only.**
  `app/sitemap.ts` gave `/privacy` and `/terms` the full `en`/`zh-TW`/`x-default`
  set and gave `/zh/privacy` and `/zh/terms` nothing at all. That is precisely
  what the comment at the top of the same file warns against — "a one-sided
  declaration is a weaker signal than none" — broken three entries below the
  line that says it, because the two halves were typed out separately.

  The fix is not the missing values. It is `languageCluster()`: a pair is now
  one call that computes the annotation set once and hands it to both halves, so
  writing one side without the other is impossible rather than discouraged. The
  landing pair goes through it too, which removed the hand-kept
  `LANGUAGE_ALTERNATES` constant.

- **The four policy pages declared `en` and `zh-TW` but no `x-default`,** unlike
  `/` and `/zh`. Same cluster, two annotation depths.

- **Both were invisible to the suite, which is the actual finding.**
  `tests/site-policy.test.ts` asserted that the string `"languages"` appeared in
  each page — true of a two-tag set and a three-tag set alike. It now parses the
  block, requires all three tags, and requires both halves of a pair to name
  identical URLs. `tests/guides.test.ts` gained the property from the other
  direction: every alternate a sitemap entry names must itself be in the
  sitemap, carrying an identical set. Both were confirmed to fail against the
  original defect before being kept.

  A rule stated in a comment did not survive contact with the same file it was
  written in. That is the lesson worth keeping, not the hreflang.

## [1.6.0] - 2026-08-15

Mixed Playlist Mode gets an artifact and an instrument, and the loop counters
learn that it exists at all.

The load-bearing finding is that `npm run stats` could not see Mixed mode.
`join_submitted` — the highest-converting surface in the product at 32.6%
(92 shown, 30 followed), against 12.0% for `buzz_cta` and 0.8% for `game_over`
— is rendered only by `app/j/[code]/page.tsx`, and `roomJoinUrl` sends players
to `/buzz/[code]?p=1` whenever the buzzer is on (`lib/room-client.ts:125-127`).
So that number describes *Mixed·QR with the buzzer off* and nothing else: a QR
room with a buzzer, and the entire `phone` sub-mode, wrote to no counter
anywhere. It was being read as "Mixed converts at a third" when its denominator
excluded the ordinary configuration.

The fix is one optional field, not a new event. `recordHostedStart` in
`app/page.tsx` already beacons `game_started` from all three start paths, so a
mixed game was already reaching KV — only the discriminator was missing. A
separate `mixed_pool_built` event was designed and rejected: it would have
described one occurrence twice and cost a mixed game eight KV commands where
this costs five.

### Added

- **`mixed` on the `game_started` pulse** (`lib/pulse.ts`, `lib/loop-stats.ts`)
  — `"room" | "phone"`, absent on a single-playlist game. `MixedSubMode` and
  `MIXED_SUB_MODES` live in `lib/loop-stats.ts` beside `HOST_INDEX_CEILING`,
  because that module owns the `loop:stats:` key space and these two strings
  become the tail of a key. `parsePulse` drops an unrecognised value rather than
  rejecting the body: the game is real either way, and `mixed_pool:${anything}`
  from an unauthenticated endpoint is how a counter namespace becomes a bill.
- **`lib/round-summary.ts`** — `summarizeRounds` / `describeRounds`, the
  per-round tally printed under the final scores. In `lib/` because the suite
  only reaches `lib/`, the same reason `lib/song-count.ts` and
  `lib/room-poll.ts` live there. Counts, never a rate: the denominator is rounds
  *played*, not rounds possible, so a percentage would invite comparison between
  games of different lengths stopped for different reasons.
- **`lib/mix-export.ts`** — `formatMixList`, the merged tracklist as text.
  **The roster is passed in rather than derived from the tracks.** Deriving it
  would be shorter and would silently erase anybody whose playlist was sampled
  down to nothing — `poolContributions` fills to a target and stops, so with
  enough contributors somebody gets zero, and they queued, scanned, and handed
  over their music. Text rather than a Spotify playlist because creating one
  needs user OAuth, and having no accounts is the product's premise.
- **A generic "Other counters" block in `scripts/loop-stats.mjs`.** `KEYS`
  discovery already found every metric, but every renderer was written against
  one key shape, so a newly added counter was read, summed and silently dropped
  — while the file header promised the opposite. The number then looks like a
  zero rather than like a missing renderer, and zero is a real answer here.
  Closing it generically means the next metric never hits this.

### Fixed

- **The taste card drew an `AWARDS` heading over nothing.** `sharedSectionH`
  was guarded, the awards section was not, so a group with no shared songs and
  no popularity data got a heading and blank space — which is precisely the
  cross-culture case the card is most likely to be saved from.
- **`computeMostObscure` crowned whoever the Map saw first on an all-zero tie.**
  Every rate is 0 when nobody places anybody's music, so `rate < best.rate`
  never fired and the award went to whoever submitted earliest. It now breaks
  the tie on contributed-track count, using the `totals` map the function
  already builds — no signature change, no extra data.
- **`mixedPlaylistMeta` had no reader.** Written by both mixed start paths since
  1.2 and consumed nowhere, so a contributor sampled to zero tracks was
  invisible to everyone including themselves. `formatMixList` is its first
  reader.

### Changed

- **`MixedSubMode` is declared once.** `app/page.tsx` had a local copy with the
  same two members; it is now imported. A second copy of a union whose members
  become part of a KV key drifts silently — the toggle keeps working, the
  counter keeps counting, and they count different things.
- **Five files documented a weekly digest that does not exist.** `lib/kv.ts:74`
  named `lib/digest.ts` specifically; the cron digest was dropped in favour of
  `npm run stats` and the comments never followed. Corrected in `lib/kv.ts`,
  `lib/loop-stats.ts`, `lib/loop-client.ts`, `lib/loop-links.ts` and
  `lib/analytics.ts`. This cost two wrong conclusions during the review that
  produced this release.
- **`loopStatsKeys` gains `mixedPool` and an honest docstring.** It is not the
  reader's contract — `scripts/loop-stats.mjs` uses `KEYS` — it is the writer's
  description of itself, held together by one test that asserts with
  `toContain`, so an omission fails nothing.
- **`scripts/loop-stats.mjs` walks the namespace with `SCAN`, not `KEYS`.**
  Found by running `npm run stats` mid-release and getting nothing but
  `ERR KEYS command is disabled because total number of keys is too large`.
  `KEYS` matches against every key in the instance, so this namespace's size was
  never the number that mattered: `lib/preview-cache.ts` writes one key per
  track and holds positive entries for a year, and that set crossing Upstash's
  ceiling took the whole report down. **It had been degrading silently before it
  failed** — the same seven-day window read 5/7 live days, 4918 games and a
  45.2% `join_submitted` rate under `KEYS`, and 7/7, 6740 and 32.6% under
  `SCAN`. Every figure from a `KEYS`-era run is a partial sum and the script
  gave no sign of it. `MGET` is chunked at 256 for the same class of reason: one
  request body that grows with the namespace.

### Known gaps

- **A room is still single-use.** `consumeRoomPool` claims `consumed` and the
  room is dead (`lib/room.ts:427`), and `ROOM_TTL_SECONDS` counts down from
  creation. A second game at the same party needs everyone to re-scan and
  re-submit. Untouched here; likely to be hit in real use before it is fixed.
- **The `+2` source guess still has no buzzer affordance.** It uses the player
  picker even when `buzzerControls` exists, so the most distinctive mechanic in
  the product is the one part the host must referee by hand.
- **`game_over` is where the loop's volume is** — 936 impressions in seven days,
  more than every other surface combined, converting at 0.9%. Its bottleneck is
  modality, not copy: it is a QR on a TV across the room. Moving it to the
  phones already holding a socket needs one new `ServerMessage`, which is a
  Worker deploy. `lib/loop-links.ts:38-41` already documents why `buzz_cta`
  cannot cover the end of a game.
- **`game_over` impressions are undercounted.** `firstTimeThisSession` keys
  sessionStorage by surface alone (`lib/loop-client.ts:39-52`) and `playAgain`
  is a same-tab `router.push("/")`, so the second game in a tab reports a start
  and no impression. The rate is therefore *overstated*: real `game_over`
  conversion is worse than 0.9%. Deliberately deferred — the fix collides with
  the documented `share`/`game_over` dedupe parity at `app/game/page.tsx:83-85`
  and changes what `share` counts, and no decision turns on it.
- **The retreat headcount is unverified.** `ROOM_MAX_SUBMISSIONS` and
  `BUZZER_MAX_PLAYERS` are both 12, and raising the latter is a Worker deploy
  because the constant is shared verbatim with it.

## [1.5.0] - 2026-08-13

A host-facing control and a deletion, which are the same change seen twice: the
setup page now asks how many songs and accepts any answer, and it no longer
offers to play for you. The built-in trial playlists went with the cards, and
"trial" mode went with them — it had exactly one entry point.

The deletion is the larger half. `lib/builtin-playlists-data.json` was 48 baked
tracks shipped in the browser bundle for a path that ended in a single-player
scoreboard, and `app/game/page.tsx` carried a parallel render tree for it:
its own scoring control, its own finished overlay, its own top-bar counter, its
own grid. Removing the entry point without the branches would have left ~90
lines that nothing could reach and a `GameMode` member nothing could produce.

### Added

- **`lib/song-count.ts`** — the Number of Songs control's whole state machine,
  in `lib/` rather than the component because that is what the suite can reach.
  `SongCountState` is `{count, field}`: the count is the answer, the field is
  what has been typed. They are separate because a number input passes through
  states that are not yet a count (`""`, `"-"`, `"1"` on the way to `"150"`),
  and the game must not follow the field there.
  - `typeCustom` runs per keystroke and **rejects** out-of-range input rather
    than clamping it, so a half-typed number cannot commit.
  - `commitCustom` runs on blur and **clamps** instead, so 999 answers 500.
    Rejecting on commit is what the first draft did, and it left the field
    showing 99 — the last in-range prefix, a number nobody typed, from a rule
    nothing on screen states. Caught in the browser, not by a test.
  - `MAX_SONG_COUNT` mirrors `MAX_PLAYLIST_TRACKS` by copy, not import:
    `lib/spotify.ts` is server code and importing it into the setup page would
    pull the Spotify client into the browser bundle.
- `tests/song-count.test.ts` — 26 cases over the pure layer, including the
  clamp regression, blur idempotency, and an invariant sweep asserting the
  control can never land on a count the game cannot honour.

### Removed

- **The "Try it now — no playlist needed" section and its three cards**
  (`app/page.tsx`), plus `handleQuickStart`, the `.trial-*` CSS, and
  `lib/builtin-playlists.ts` / `-data.json` / `scripts/fetch-builtin-playlists.mjs`
  / `tests/builtin-playlists.test.ts`.
- **`GameMode`'s `"trial"` and `PlaylistSource`'s `"builtin"`**, and every
  branch behind them in `app/game/page.tsx`: `isTrial`, `markTrialCorrect`, the
  Skip button, the "Correct: N" badge, the trial finished overlay, the
  `.game-layout.trial` grid, and the `!isTrial` guard that was hiding the
  sidebar. `correct_count` leaves `game_finished` for the same reason.
- `roundsPlayedRef` in `app/game/page.tsx` — the trial overlay's "You got X / Y"
  was its only reader outside `trackGameFinished`, so it had become a ref that
  carried a value between two adjacent lines.

### Changed

- `parseGamePayload`'s allow-list fallback is now also the retirement path: a
  game sitting in sessionStorage under `mode: "trial"` when this deploys reads
  back as `party` and keeps playing, rather than failing to parse and dumping
  the host at `/`. `tests/game-session.test.ts` pins that.

### Known gaps

- The Number of Songs control is single-playlist only. Mixed mode still offers
  `MIXED_SAMPLE_COUNTS` (5/8/10/12) per player with no custom field; the same
  `lib/song-count.ts` state machine would fit it, and the server-side
  `sampled_per_player_invalid` code already exists to validate the wire value.
- `app/share/unsupported/page.tsx`'s album copy used to point at the built-in
  playlists as the way out. It now suggests opening a playlist instead, which
  is honest but a weaker landing for someone who arrived by sharing an album.

## [1.4.0] - 2026-08-13

Upstash command volume, audited end to end after 1.3.2's outage traced back to
a spent monthly quota. The audit found that rooms were not the main consumer —
they are one of five, and the two largest were an idle browser tab and a log
line. Reviewing the room path for what it actually spent turned up the lost-write
race that `### Fixed` describes, which is the reason this is a minor and not a
patch. Nothing here changes what the app does; a party plays identically.

Rough per-command accounting before and after, for the paths that dominate:

| Path | Before | After |
|---|---|---|
| Roster poll, 30-min lobby, nobody arriving after minute two | 900 | 240 |
| Cold 25-track preview batch, cooldown reads alone | up to 50 | 2 |
| `recordGameStart` (one hosted game) | 6 | 4, then 3 |
| Playlist/preview miss, log line only | 2 extra each | 0 |
| `consumeRoomPool` | 3–15 | 3 |

### Changed

- **The roster poll backs off when nothing is happening** (`pollIntervalMs` in
  `lib/room-poll.ts`). It was a flat 4s for the life of the room, which is two
  Upstash commands a tick whether or not anyone is still scanning — 450 ticks
  over `ROOM_TTL_SECONDS`, almost all of them re-reading a roster that stopped
  changing in minute two. The ladder is 4s → 8s after a minute of silence → 20s
  after five, and **every arrival resets it**, so a room that is filling polls
  exactly as fast as it did before. Returning to a backgrounded tab still polls
  immediately. The existing three bounds (terminal status, deadline, visibility)
  are unchanged; this bounds the *rate* where those bound the total.
- **The per-source preview cooldown is memoized in module scope**
  (`lib/preview-cache.ts`). It is a site-wide, minute-scale signal that
  `askUpstream` consulted once per source *per track*: a cold 25-song game spent
  up to 50 KV reads learning the same two answers, more commands than the
  batch's own writes. A known-future `until` is now trusted without re-reading;
  "not cooling" is held 5s, far below `MIN_COOLDOWN_SECONDS`, because it is the
  answer that spends upstream calls. Concurrent resolutions share one read
  through an in-flight map — without it a batch smaller than `BATCH_CONCURRENCY`
  never benefited at all. `startCooldown` primes the memo, so a 403 parks the
  source for the rest of the batch with no round trip.
- **The loop liveness marker is written once per instance per UTC day**
  (`lib/loop-stats.ts`). Its reader (`scripts/loop-stats.mjs`) only asks whether
  the count is above zero, so bumping it alongside every metric doubled the cost
  of the whole `loop:stats:` namespace — `recordGameStart` spent six commands,
  three of them on the same key. Recorded as written only after the write
  lands, so a single failed request cannot cost the day its marker.
- **Cache miss logs no longer read counters back to compose themselves**
  (`recordMiss`, `recordOutcomes`). Both spent two extra KV reads per miss —
  on the path that is by definition already the expensive one — printing a
  cumulative `rate=` for a log nobody tails. The lines now describe the request
  they belong to; `getCacheStats()` / `getPreviewCacheStats()` / `npm run stats`
  answer the cumulative question when someone asks it. Documented in
  `docs/operations.md` §4 and `CLAUDE.md`.

### Added

- **The `share` surface finally has a denominator.** Every other loop surface is
  a DOM node, so `components/loop-cta.tsx` and `components/loop-qr.tsx` can
  report an impression when it renders. This one is a QR painted into a canvas
  by `drawCardFooter`, so nothing ever fired: `npm run stats` printed `shown=0`
  against a non-zero `followed`, and a rate of `—` for the one arm that reaches
  people who have never seen a page of ours. `recordCardImpression` in
  `app/game/page.tsx` fires it when a card is actually saved. Only `shared` and
  `downloaded` count — a dismissed sheet and a failed render leave no image, so
  no QR entered the world and an impression would be a denominator for a card
  nobody has. The unit is therefore **a party that produced at least one card**,
  not a card, since the per-tab dedup folds the scores card and the taste card
  into one. `docs/viral-loop.md` §2 and §6 now say so, and its troubleshooting
  table gains the `shown=0 but followed>0` row that names this exact shape.

### Fixed

- **Room writes are atomic.** `lib/room.ts` stored the whole room as one JSON
  value, so two players submitting within the same few seconds — the ordinary
  case for a QR everyone scans at once — both read it, both added themselves,
  and the second write dropped the first. There is no CAS on get/set, so the
  code re-read before writing and read *again* afterwards to detect a clobber,
  retrying up to five times: four commands on the happy path, ten under
  contention, and a narrowed window rather than a closed one. A room is now a
  hash and a contribution is a single `hsetnx` on `p:<folded name>` — one
  command that wins or loses, with nothing to verify and nothing to retry.
  `consumeRoomPool` decides its race the same way, on `consumed`.
- **The roster poll no longer carries the pool.** Track lists moved out of the
  room record into `room:v2:<CODE>:t:<folded name>`, so a poll reads names and
  counts instead of dragging every contributor's full playlist across the wire
  every few seconds to render a dozen chips. `consumeRoomPool` collects them
  with one `mget`, once, at kickoff.
- **`createRoom` cannot hand the same code to two hosts.** The check-then-write
  pair became a single `hsetnx` claim. It also deletes the key if the follow-up
  `expire` fails, rather than leaving a room with no TTL holding a code Buzzer
  Mode may be about to reuse.

### Known gaps

- **Rooms open across this deploy will 404.** The key prefix is versioned
  (`room:v2:`) because the old value is a string and every command here is now a
  hash command — an unversioned key would answer `WRONGTYPE`, not a polite 404.
  Old keys are unreachable and age out within `ROOM_TTL_SECONDS`; a host
  mid-lobby at deploy time sees "room not found" and reopens.
- **`ROOM_MAX_SUBMISSIONS` may be exceeded by one under a dead heat.** The cap
  is checked before the playlist fetch and deliberately not re-enforced after
  the claim: rolling a winner back because a simultaneous submit pushed the
  count over would turn away someone who did arrive in time. Thirteen
  contributors instead of twelve is the worse-case outcome, and it is harmless.
- **A cooldown started by another instance is joined up to 5s late.** Bounded by
  `COOLDOWN_MEMO_MS` and far below the 30s floor a cooldown ever lasts, so a
  cooldown is never missed — only entered slightly after it was declared.
- **A submission landing in the same instant as Start may be pooled and still
  told 410.** Claiming `consumed` is what decides the consume race, so it has to
  happen before a simultaneous submit is knowable; if that submit's `hsetnx` won
  first, its tracks are in the pool while its author sees "the game already
  started". The old code had the mirror of this (told 410, *not* pooled) through
  a wider window. Closing it needs a transaction, which get/set/hash cannot
  give; the visible cost is one confusing message on a millisecond boundary.
- **The `share` impression can only ever be a floor.** Its `followed` may arrive
  weeks later from a device that has never seen the site, so numerator and
  denominator are not the same population and the rate is a spread indicator,
  not a conversion. `docs/viral-loop.md` §6 spells this out.

## [1.3.2] - 2026-08-13

A user reported that a public playlist would not load. It loaded fine from
Spotify — the app returned `500` with an empty body on **every** API route, and
the client, having no `code` to render, fell through to `playlist_load_failed`:
"Couldn't load that playlist." The message pointed at the host's URL, so they
re-copied the link from the web player and the desktop app before reporting it.

The cause was Upstash's monthly request cap (500,000 on the free plan) being
spent, which fails every Redis command until the quota rolls over — days, not
the seconds a blip costs. Investigating what spent it turned up a second bug,
and reviewing that turned up a third.

### Fixed

- **`lib/rate-limit.ts` now fails open on a KV error.** It was the only KV
  consumer in the app that did not — `lib/playlist-cache.ts`,
  `lib/preview-cache.ts` and `lib/loop-stats.ts` all wrap their calls, and
  `app/api/pulse/route.ts` even implements the rule locally with a "fail open"
  comment. `enforceRateLimit` runs at the top of all seven API routes *before*
  each handler's own `try`/`catch` (`/api/preview` has no `try` at all), so a
  throwing `incr` escaped the handler and Next answered with a bare 500 and no
  body. A limiter reads like the one place to fail *closed*, which is why this
  survived review; the trade is documented at the callsite and in `CLAUDE.md`.
  Giving up the per-IP ceiling costs little here — the limits mostly blunt
  guessing against `lib/room.ts`'s 4-char code space, and rooms live in the same
  KV that is already unreachable. Failure logging is throttled to one line a
  minute so an exhausted quota is visible without one line per request.
- **`poolContributions` backfills to the length the host asked for.** A song two
  contributors both added spends a slot from each of their quotas, so the pool
  shrank as overlap rose and nothing on the setup screen said so. Measured over
  3,000 pools of two 40-track playlists at 8 per player: 50% overlap returned
  12.5 tracks instead of 16, identical playlists returned 8, and each player's
  *exclusive* tracks fell faster than the total (8 → 4.5 at 50%). The fair pass
  is unchanged and still runs first; `sampledPerPlayer` is now a starting cap
  that rises one notch at a time until the target is met or the pool runs dry,
  raised uniformly so nobody passes `cap` until everyone has reached it. Pool
  size is now exactly `contributors x sampledPerPlayer` at every overlap level,
  bounded by the number of distinct songs — a full-length game that repeats a
  song is worse than an honest short one.
- **The room roster poll can now stop.** `components/room-panel.tsx` ran a bare
  `setInterval` bounded only by the panel staying mounted, at two Upstash
  commands a tick every 4s. A host who opened a room and left the tab parked
  polled at ~15 requests a minute indefinitely, against rooms `ROOM_TTL_SECONDS`
  had already deleted — the 404s were swallowed and retried. That is ~43k
  commands a day per abandoned tab on a 500k-a-month plan. Three bounds now:
  a terminal status (404 gone, 410 already started), a deadline of
  `ROOM_TTL_SECONDS` from mount, and a hidden tab (skips the fetch, polls once
  on return). `setTimeout` replaces `setInterval` so a slow poll cannot stack
  ticks behind it.

### Changed

- **New `lib/room-poll.ts`.** The three bounds above were written inside the
  component, where nothing could test them — `vitest.config.ts` collects only
  `tests/**/*.test.ts` and there is no React testing stack, which is what
  `lib/analytics.ts` means by keeping its param helpers out of the calling
  component. `pollTickAction` and `canPollAgainAfter` are pure and now carry the
  policy; the component keeps only the scheduling. The deadline is checked
  *before* the fetch, so the last tick of a room's life no longer spends a
  request learning what the deadline already knew.

### Known gaps

- The Upstash quota is still spent at the time of this release. The site works,
  but rooms and Mixed Playlist Mode are down until it rolls over, every cache
  misses, and the global Spotify/preview budgets — themselves KV counters that
  fail open — are not enforcing. See `docs/operations.md` §5.
- The scheduling left in `components/room-panel.tsx` (timer wiring, listener
  cleanup) is still untested; only the policy moved to `lib/`.

## [1.3.1] - 2026-08-10

Vercel's Fluid Compute bills Active CPU, and this project was at 79.9% of the
Hobby month's 4 hours. Two things were spending it, and neither was the work the
app exists to do. A two-minute sample of production logs put **42 of 54 billed
invocations (78%) on `POST /api/playlist` returning 404** — one host, one dead
link, tapped over and over. The other 10 were image routes that were supposed to
be built once and were being rendered per request instead.

Neither is visible on the page: the images come out byte-identical, and the
retry loop looked like a working error message. Both are the kind of cost that
only shows up on the bill.

### Fixed

- **The three generated-image routes no longer run per request.** `app/icon.tsx`,
  `app/opengraph-image.tsx` and `app/icons/[size]/route.tsx` each carried
  `export const runtime = "edge"`, which opts a route out of static generation —
  Next says so in a build warning that is easy to read past, and the route table
  showed them as `ƒ` while the logs showed `edge-function` / `cache: MISS`. They
  were satori rasterisations, the most CPU-expensive thing here, and the OG image
  is fetched once per share. Deleting three lines makes them `○`/`●`; the
  prerendered bytes are identical to what production was serving (685 / 125706 /
  3460 / 10094 / 5583). `app/icons/[size]` also gains `generateStaticParams` and
  `dynamicParams = false`, so the three sizes prerender and any other segment
  404s without an invocation at all.
- **A refused playlist is no longer re-requested.** A 404 comes back from
  `lib/playlist-cache.ts`'s negative cache in about 100ms — faster than the Start
  button re-enables — so a host mashing Start produced bursts of fourteen
  identical requests 150–300ms apart, each a billed invocation replaying a
  decision already made. `isDeterministicPlaylistFailure` (`lib/error-messages.ts`)
  names the codes where resubmitting the same URL provably cannot answer
  differently; `app/page.tsx` re-shows the error instead of sending. Measured:
  6 taps → 1 request, and editing the link rearms it.
- **Mixed Playlist Mode gets the same guard, keyed on the whole roster**
  (`mixedRosterKey`, `lib/mixed-playlist.ts`), where a mash cost one request per
  contributor. Measured: 6 taps on a two-contributor roster → 2 requests, and
  swapping a contributor rearms it. `mixed_playlists_failed` is an aggregate and
  is *not* treated as final on its own — `shouldRememberAllRejections` requires
  every individual rejection to be deterministic, so one contributor's transient
  500 cannot write off the whole party.

### Changed

- `/icons/<anything-else>` now returns Next's 404 page rather than a plain-text
  "Not found" body. Same status, no invocation, and nothing reads that body —
  `public/manifest.json` only ever requests the three real sizes.

### Known gaps

- Throttling codes are deliberately excluded from the deterministic set, so a
  host throttled by Spotify's shared quota can still retry. `tests/error-messages.test.ts`
  pins that in both directions, including a complement test that defaults any
  newly added `AppErrorCode` to retryable.
- `app/j/[code]` and `app/buzz/[code]` are still `ƒ` — pure client components
  paying an SSR invocation per QR scan. They did not appear once in the sampled
  logs, and making them static risks rendering the wrong room code before
  hydration, so they were left alone.
- The 78% figure is one two-minute sample, not a 30-day average.

## [1.3.0] - 2026-08-09

Buzzer Mode has been putting a phone in every hand for weeks, and none of those
phones were ever told what they were holding. `app/buzz/[code]/page.tsx` was 264
lines containing zero `<a>` tags and not one occurrence of the string
"GuessSong"; `app/j/[code]/page.tsx` ended at a confirmation card with nowhere
to go; `lib/result-image.ts` printed "Played with GuessSong" on the one artifact
that leaves the party, with no address on it. The expensive half of a viral loop
— rooms, live sockets, share cards — already shipped. This release is the cheap
half nobody had written.

### Added

- **A way back to the product from every player-facing surface.** Five of them,
  each named once in `lib/loop-links.ts` and derived from there everywhere else.
  The name is needed in three places at once — the link's `href`, the analytics
  param, and the server-side validator — and hand-syncing them fails *silently*:
  a renamed href against a stale validator still redirects, the counter just
  stops incrementing, and that arm reads as "nobody clicked it". You would then
  correctly conclude the CTA was useless and delete one that was working. Same
  single-union trick `lib/buzzer-protocol.ts` uses across the Worker boundary.
  - `buzz_footer` on all three of the buzzer page's return paths, including the
    pre-join form — the calmest screen on that phone, and the only moment there
    that is not competing with a song.
  - `buzz_cta`, a full-width button on the live buzzer screen, shown only
    between rounds and never before the first has resolved. Gated on
    `snapshot.roundIndex >= 1 && phase === "idle"`, **not** on a `locked → idle`
    transition: `handleResolve` in `worker/src/buzzer-room.ts` reaches `idle`
    from both `open` and `locked`, so a round nobody buzzed at is
    indistinguishable from one that was answered. `roundIndex` advances only on
    `host:next`, which is exactly "a round finished", and reading it off the
    snapshot means it survives a reconnect where the snapshot is adopted whole.
    Rendered always and hidden when inactive, so appearing between rounds cannot
    shove the buzz button down the screen under someone's thumb.
  - `join_submitted` on the Mixed Playlist confirmation screen, which was a dead
    end and is the one moment on that page where the player has finished the
    task and is still looking.
  - `game_over`, a QR on the host's Game Over screen. The highest-attention
    surface the product has and the only one it never used: the music has
    stopped, every person in the room is looking at a television, and they all
    still have the phone they spent the last half hour buzzing with. The trial
    overlay has shipped "Start a Party Game →" since launch; the party path, the
    one with five other people in it, had nothing.
  - `share`, a QR drawn into the result card itself.
- **`POST /api/pulse`**, for the two facts the browser knows and no existing
  request carries: that a loop surface was rendered, and that a hosted game
  started with the device's game index. Sent with `navigator.sendBeacon`,
  because both fire immediately before a navigation and an in-flight `fetch` is
  cancelled as the document tears down — the measurement would be lost exactly
  in the cases worth measuring, and lost silently. Body validated field by field
  in `lib/pulse.ts`: it is unauthenticated by necessity (the people it measures
  have no accounts), so the body is as trustworthy as a query string, and one of
  its values becomes part of a KV key.
- **`host_game_index`**, a per-device count of hosted games in `localStorage`
  (`lib/host-session.ts`). `>= 2` is the number this whole line of work is
  waiting on — proof that someone came back — and it is deliberately reported as
  a **floor**: iOS evicts script-writable storage after seven days without a
  visit, which is precisely the gap between two parties, private windows start
  empty, and a laptop passed around a room is several hosts wearing one
  identity. Raw integer in GA4, not a bucket: CLAUDE.md's bucketing rule is
  about *failure* params, where the value comes from an upstream string; every
  count param already there (`round_index`, `player_count`, `rounds_played`) is
  raw, and bucketing at collection freezes the boundaries before the
  distribution is known.
- **`arrived_from` on `game_started`**, credited to the last loop touch within
  60 days rather than to the visit that carried the `?ref=`. The conversion is
  not same-session — somebody taps a CTA on a friend's sofa and hosts their own
  party a fortnight later — so attributing only within the pageview would record
  almost every real conversion as organic and report a working loop as dead.
- **Server-side counters** in `lib/loop-stats.ts`, held 30 days rather than the
  7 `lib/playlist-cache.ts` uses. A weekly digest whose window ends a couple of
  days back would expire the oldest day of every report right before reading it,
  and an expired key is indistinguishable from one never written. Also carries a
  **liveness marker**, bumped unconditionally alongside every other counter,
  because `mget` returns null for a key that was never created and that is what
  a genuine zero looks like too — without it, "the CTA does nothing", the single
  most important negative result available here, would render as "no data yet"
  forever.
- **`npm run stats`** (`scripts/loop-stats.mjs`), which prints the counters as a
  table: shown/followed/rate per surface, games started, repeat hosts, the
  distribution by host game number, and how many clicks the limiter dropped.
  Keys are **discovered** (`KEYS loop:stats:*`) rather than rebuilt from a
  hardcoded list, so this file holds no second copy of the metric names — that
  drift would be silent, printing a confident table of zeros for keys nobody
  writes, and discovery also means a metric added later appears here on its own.
  The output leads with the caveats, because every number in it is a floor and
  the failure mode is reading a low one as "the CTA does not work" rather than
  as "we could not see that it did".
- **`dayBucket()` in `lib/kv.ts`**, replacing the copies that had accumulated in
  `lib/playlist-cache.ts` and `lib/preview-cache.ts`. The writer and the reader
  of a day-bucketed counter always live in different modules, so the exact
  string is the contract between them; a divergence throws nothing and simply
  addresses a different key. UTC, so a lambda and a laptop agree. Pinned by a
  test asserting the literal.

### Changed

- **The loop link is a real navigation to `/r/[surface]`, not a click handler.**
  The click being measured is the click that leaves the page, so a background
  report fired at that moment is the report most likely to be cancelled. Routing
  through the server makes the navigation itself the measurement — there is
  nothing left to cancel. Plain `<a>` rather than `next/link`, because
  prefetching a counting endpoint would inflate it with hits nobody made, and
  `/r` is disallowed in `app/robots.ts` for the same reason.
  - **The visitor always reaches the setup page.** Unknown segment, spent rate
    limit, KV unavailable: every branch still redirects, and only the count is
    allowed to be lost. The person clicking is precisely the person the feature
    exists to reach; refusing them to protect an integer would be an own goal.
    Same fail-open contract as `lib/playlist-cache.ts`'s global budget.
  - The limiter is sized for a household rather than a person (120/hour), since
    it is keyed by IP and a party is a dozen phones behind one Wi-Fi address —
    `app/api/room/[code]/status` is the standing lesson on what a per-device
    budget does to a whole room. Throttled clicks are counted separately so the
    undercount appears in the digest instead of quietly depressing the rate.
  - `Cache-Control: no-store`, or an intermediary caches the 302 and every later
    click from that network is served without reaching the counter: the redirect
    would keep working while the measurement silently stopped.
- **The result card footer is a QR, not a line of text.** It used to read
  "Played with GuessSong" — a brand with no address — so anyone who saw it in a
  group chat had to already know the name, which is the audience it does not
  need to reach. Printing the URL as text is barely better; nobody retypes a URL
  off a screenshot. `drawCardFooter` is now async and takes the code, and
  `CARD_FOOTER_HEIGHT` is exported so the two callers that size the canvas
  cannot drift from what the footer draws.
  - **The URL is deliberately not also added to the `navigator.share` payload.**
    iOS drops `url` when a file is attached, and several Android targets drop
    the *file* when a `url` is present. Risking the image, which is the entire
    payload, to add a link one platform throws away is a bad trade.
- `?ref=` is read from `window.location.search` in an effect, **not**
  `useSearchParams`. `app/page.tsx` is a client component that is still
  statically prerendered, carries the FAQ structured data, and takes
  essentially all of the site's traffic; an unsuspended `useSearchParams` either
  fails the Next 15 build or opts the page out of prerendering, and there is no
  Suspense boundary anywhere in this app. Verified against `next build`: `/`
  remains `○ (Static)`.
- `?ref=` is validated through `isLoopSurface` before it can reach a GA4 param.
  `/?ref=` is a public URL, and CLAUDE.md's analytics rule against user input in
  params is the same hazard by a shorter path. Anything unrecognised is
  `organic`.
- Impressions are counted once per surface per tab. `room_join_opened` fires per
  page load — a phone that drops Wi-Fi and reloads counts twice, as this file
  already noted in 1.0.0 — which makes it a floor rather than a denominator.

### Known gaps

- **`arrived_from: "organic"` is a catch-all.** Every lost attribution lands
  there: a PWA launched from the home screen, a stripped query string, a URL
  retyped without its path. Since organic is already effectively all of the
  traffic, the loop's share of starts is a floor and a low number cannot be read
  as "the CTA does not work" without ruling out "we could not see it".
- **The `share` arm is the weakest link and stays that way.** It now depends on
  someone scanning a QR out of a forwarded image rather than typing an address,
  which is a large improvement over nothing but still the only surface whose hit
  does not originate on a page of ours.
- **`npm run stats` is the only reader, and it is a manual command.** A
  scheduled push was designed and then dropped on the maintainer's call, which
  was the right call: a webhook adds a deploy surface, three environment
  variables and another feed to read, and the variable that actually predicts
  whether a number gets looked at is not push-versus-pull but whether reading
  it requires leaving the editor. What makes the command work is the line in
  CLAUDE.md telling an agent to run it — delivery moved from a human habit with
  a 0/4 record to something that happens at the start of a session. If that
  line gets deleted, this reverts to the same defect every release before it
  had.
- `host_game_index` is capped at 10 in KV to bound the key space. Fine for the
  question being asked; it would need revisiting before anyone studies the tail.
- The buzzer wire protocol still has no end-of-game signal (`BuzzerPhase` is
  `idle | open | locked`, `ClientMessage` has no `host:end`), so the player's
  phone cannot react to the game finishing. `buzz_cta` uses "a round has
  resolved" as the nearest available proxy. If its conversion comes in clearly
  below `join_submitted`, that gap is the signal that the protocol change is
  worth making.
- Route handlers still have no unit tests anywhere in this repo. The two added
  here are shells over `lib/loop-redirect.ts` and `lib/pulse.ts`, which are
  tested, but the 302 status, the `Location` header and the `Cache-Control` are
  verified only by reading them.

## [1.2.0] - 2026-08-09

### Fixed

- **A cover, a nursery rhyme, or an unrelated song sharing the title could be played instead of the track on the answer card — and cached as correct for a year.** `pickItunes` took `(results, track)`: the artist was never passed in, let alone checked. Its "exact match" compared `trackName` only, and its fallback was `results.find(r => r.previewUrl)` — literally the first playable result. That fallback is reached constantly, because `askUpstream`'s second iTunes query is the bare title with the artist deliberately stripped, so upstream ranks by popularity alone. Measured against the live API: `Hello` returns Pinkfong's nursery rhyme rather than Adele's, `Alone` returns Heart's 1987 single rather than Marshmello's, `小幸運` returns a cover. The pick was then written to KV as `found` and held for `FOUND_TTL_SECONDS` — a year — and never revisited, since `&refresh=1` repairs rotted URLs, not wrong songs. For a guessing game this is worse than reporting no audio: the clip plays, and then the answer card contradicts it.
  - **`pickCandidate` (replacing `pickItunes`) decides on three signals arranged as a tier list**, because none of them survives every case. Credits are routinely translated — iTunes returns 盧廣仲 as "Crowd Lu" and 田馥甄 as "Hebe Tien" — while a cover shares the original's title by definition, so on a CJK track the only string that lines up frequently belongs to the wrong recording. Running time is translated by nobody: measured against live data the true match agrees with Spotify to within 0–6ms, which is exactly what a re-recording does not do.
    - **The title's two directions are not symmetric**, which is why this is a tier list and not a weighted score. A title *match* is strong evidence (few unrelated recordings share one); a title *miss* is weak evidence (it usually just means "translated"). So the ranking flips on whether the credit is verified: with the artist confirmed a title miss means "different song by the same artist" and the title outranks the clock; with the artist unverifiable a title match means "someone else's cover" and the clock outranks the title. Four tiers, in order: artist+title, artist, duration, then (only when not `requireVerified`) title, then upstream's own first pick. Ties inside a tier go to the closest running time, then to upstream's ranking — which is why a finer "…and the duration agrees" tier above each of the first two would be unreachable code rather than a stricter rule.
    - An earlier cut of this ranked duration above an artist+title match unconditionally, which **regressed 1.1.0**: a remaster sits further off Spotify's clock than a sibling album track does, so asking for `Karma Police` (3s off, exact title) against `Lucky` (500ms off, same artist) played `Lucky`. Caught by the ship coverage audit, pinned by `keeps an exact title outside the window over a sibling track inside it`.
  - **`requireVerified` gates the title-only queries, and only those.** Applying the same check to the queries that already carried the artist upstream looks like an obvious tightening and is a catalogue-wide outage for CJK, where no string matches at all — those rely on upstream's own ranking, which was given the artist. A rejected result is `empty`, not `absent`, so the next source gets its turn and nothing is recorded as a fact about the recording.
  - **`artistMatches` compares on whole-token boundaries**, so "Marshmello" matches iTunes' "Marshmello & Noah Cyrus" but "Sia" does not match "Sian Evans". CJK has no spaces to anchor on and falls back to a plain substring.
  - **`durationMs` is threaded from `Track` through `PreviewBatchTrack`, both preview routes and `PreviewQuery`.** Optional the whole way: an older client, or a track whose length is unknown, matches on names alone exactly as before. It is *not* part of the cache key, so nothing cold-starts. `DURATION_TOLERANCE_MS` is 2s — far wider than the real agreement, to absorb Deezer reporting whole seconds — and therefore wide enough to admit a different song by the same artist (小幸運 and Hebe Tien's Forever Love are 768ms apart), which is why candidates are sorted by drift and the closest wins rather than the first inside the window.
  - **Deezer is picked the same way.** `queryDeezer` previously did `data.find(r => r.preview)` with no title or artist check at all; it now maps onto the same `Candidate` shape (`duration` × 1000) and goes through `pickCandidate`.

- **Every upstream call is bounded by `UPSTREAM_TIMEOUT_MS` (2.5s).** `getPreviews` gates only the *start* of each resolution against its deadline and `fetch` carried no signal, so one stalled socket could take the whole function past the platform limit — and a batch that dies returns nothing at all, dropping every track onto the lazy path. More likely since `requireVerified` makes the iTunes-to-Deezer handover more common.

### Changed

- **iTunes is asked once, not twice, when a track has no artist.** `askUpstream`'s query list was `[\`${track} ${artist}\`.trim(), track]`, and with an empty artist those two strings are byte-identical — every such lookup spent a second upstream call re-asking a question it had just had answered. The title-only follow-up is now appended only when there is an artist to verify the answer against, which is the same condition that makes it safe.

### Removed

- **`Track.previewUrl`, and the three places that read it.** Spotify deprecated `preview_url` in Nov 2024; measured against this app's Client Credentials it is `null` for **0/20** tracks across four markets (none, US, TW, JP). So `convertSpotifyTrack` was writing a permanently-null field into every payload — sessionStorage, the KV playlist cache, `/api/playlist` responses, and 48 baked entries in `lib/builtin-playlists-data.json` — while `app/game/page.tsx` carried two branches that could never be taken: a `.filter(t => !t.previewUrl)` that never filtered anything and a `track.previewUrl ?? cached` whose left side was always null. Removed together with `preview_url` on the `SpotifyTrack` interface. The dead branch was also actively misleading: it reads as though Spotify still supplies the audio, when in fact every clip the app plays comes from iTunes or Deezer.

### Known gaps

- **This fix reaches only tracks nobody has played yet, and that is the largest gap in the release.** `recordToResult` returns `found` for any record holding a URL, positive entries are held a year, the cache key is deliberately unversioned, and `&refresh=1` re-confirms the stored `itunesTrackId` rather than re-picking — so every wrong clip the 1.1.0 picker wrote keeps being served for up to a year. Production was logging `hits=536 misses=505` when this shipped: about half of all preview questions are answered from exactly those entries.
  - A picker-generation stamp on `PreviewRecord` was built during this release's ship review and **backed out**, because an adversarial pass reproduced three ways it made things worse than the stale pick it repaired. Recorded here as the spec for doing it properly:
    1. **A re-pick must not take `resolveAndStore`'s `lookup?id=` shortcut.** Wiring it to `options.refresh` alone means the first `<audio>` error on a pre-1.2.0 track re-confirms the very recording under suspicion and stamps it current — permanently laundering the bug, in the one code path most likely to hit the oldest entries.
    2. **Re-picks need their own admission budget, separate from cold misses.** Superseding the whole positive corpus at once turns a fully-cached 25-track game from 0 upstream calls into 25 budget slots and up to 125 calls. Against `PREVIEW_MAX_LOOKUPS_PER_MINUTE`'s 120 that is under five warm games a minute, site-wide, on deploy day.
    3. **It has to converge under throttling.** Keeping the old URL without stamping it means the next request retries, forever — and the retries are what sustain the throttling.
  - Related and unfixed: a caller with no `durationMs` (an old bundle mid-rollout) writes its weaker name-only pick under the same shared key with the same year-long TTL.

- **A result rejected on verification is cached as `absent`, for a week.** When every candidate fails both checks, `pickCandidate` returns `empty`, which becomes `absent` with `ABSENT_TTL_SECONDS`. But `absent` is documented in this module as a fact about the *recording* — "nothing anywhere has a clip" — and here a clip demonstrably exists; we declined it. That is a new class of week-long false `absent`, and it is invisible in exactly the way the 1.1.0 bug was. Kept deliberately for now: mapping it to `unavailable`'s 90s would re-query, forever and every 90 seconds, every track whose only upstream match is a cover — which is the upstream drain this module exists to prevent. The honest fix is a fourth outcome (`rejected`, cached for hours rather than a week), not a TTL swap.
- `DURATION_TOLERANCE_MS = 2000` is sized for Deezer's whole-second granularity, not for how close the real matches are (0–6ms). A cover mastered to within two seconds of the original still wins if it also outranks the original *and* the credit cannot be verified — rare, and now needs both failures at once rather than either.
- `scripts/fetch-builtin-playlists.mjs` vets bundled tracks with its own stricter artist gate rather than the runtime's `pickCandidate`, and has no Spotify duration on that path to compare against. Comments now say so; the divergence itself is unaddressed.
- **`artistMatches` admits a superset credit, which is the tribute-band naming convention.** Whole-token containment makes `artistMatches("Queen Tribute Band", "Queen")` true, and it is the title-only queries — ranked by popularity, where tribute recordings surface — that rely on the check. Duration does not save it: the clock is only ever a tie-break inside a tier, never a veto, so a single candidate with a wildly wrong running time is accepted unopposed. Closing this wants a credit-separator boundary (`&`, `feat`, `,`, `with`) plus a gross-drift veto.
- **Every admission layer fails open on the same dependency.** `readRecords`, `claimLookupBudget` and `isCoolingDown` each degrade to "allow" on a KV error — individually correct, collectively meaning an Upstash outage removes the cache, the global budget and both cooldowns at the same instant, leaving only per-IP limits against a full five-call fan-out per request. A module-scope fallback counter would blunt it.
- Tracks reaching `/api/preview` without a `durationMs` — an older cached client, or any caller that doesn't pass it — fall back to name matching alone, i.e. to the 1.1.0 behaviour minus the title-only hole.
- `artistMatches` cannot see through translation and is not meant to; the duration signal is what covers that case. A track that is *both* credited under a translated name and has no known duration gets neither signal, and falls through to upstream's ranking.
- The daily counters still record a `&refresh=1` as a miss, so the logged hit rate understates the cache — a refresh is the cheapest upstream path there is (one `lookup?id=`) and is only possible *because* the cache stored the id. Splitting it into its own counter would make `rate=` mean "cold lookups" and give URL rot its own number.

## [1.1.0] - 2026-08-03

### Fixed

- **A throttled preview lookup was cached as "this song has no audio" for a week.** `resolveFromUpstream` in `app/api/preview/route.ts` mapped every failure onto `previewUrl: null` — a 403 from a throttled iTunes, a dropped connection, a 500, all of them — and `writeCache` then stored that for `MISS_TTL_SECONDS`. So one throttled minute at peak marked a slice of the catalogue silent for seven days, on a path where every visitor shares the deploy's egress IP. It never reproduced locally, because a laptop's own IP is never the one being throttled, and it presented as a catalogue gap rather than as throttling — the exact misreading the file's own header comment warned about, reintroduced by the cache write below it.
  - **`lib/preview-cache.ts` (new)** — the resolution and caching logic, extracted from the route so `POST /api/preview/batch` shares it, with three outcomes instead of two. `found` is cached a year, `absent` (upstream answered and has nothing) a week, `unavailable` (we could not ask) **90 seconds**. Only a clean, complete reply may produce `absent`; a source that was skipped, refused us, or failed mid-question makes the whole lookup `unavailable`. The asymmetry is the point: a wrong `absent` lasts a week and is invisible, a wrong `unavailable` costs one retry.
  - **iTunes signals throttling with `403`, not 429**, and **Deezer reports a spent quota in the body of a `200`** (`{error:{code:4}}`). Checking only 429, or only the status, is how the refusal got classified as an empty result set to begin with. A non-OK status of any kind is now `unavailable` too: nothing upstream can say with a 5xx is evidence about a recording.
  - **The client half has the same rule.** `lib/preview-client.ts` (new) resolves every network failure to `unavailable`, never `absent`, and the game page's `previewCache` ref now stores *settled* answers only — it used to write whatever came back, so a failed fetch mid-party left that track silent for the rest of the game.
  - **The cache key is deliberately not versioned.** The stored record is a strict superset of the old `{previewUrl}` shape, so live entries keep reading as hits; bumping a version the way `lib/playlist-cache.ts` does would cold-start every entry in production at once, which is the upstream burst this module exists to prevent. Legacy nulls are read as `absent` for the same reason — some are poisoned by this bug, but re-resolving all of them at once is the stampede that poisoned them, and they age out within the week.

- **`429 QUOTA_EXCEEDED` from Spotify on `/api/playlist`.** Nothing anywhere cached a playlist: `getPlaylistWithTracks` went to the network on every single call, so the same URL re-paginated in full on every host retry, every room submit, and for every player in a room who pasted the same link. Meanwhile Spotify's quota is per *client id* — one budget shared by the whole user base — while every limiter in `lib/rate-limit.ts` is keyed by IP, so N phones each got a fresh allowance against it. Five compounding causes, fixed together:
  - **`lib/playlist-cache.ts` (new)** — KV cache keyed by playlist id, 6h on a hit. A repeat load now costs zero upstream calls. Reads and writes are wrapped so a KV outage degrades to "slower", never "broken", the same contract `app/api/preview/route.ts` follows. This is not a reversal of the token cache's deliberate no-KV decision (`lib/spotify.ts`): a token has no fallback, a playlist does.
  - **In-flight coalescing** in the same module. One Mixed-mode Start fires a request per contributor and a QR room gets a burst of simultaneous submits; duplicate URLs in either used to mean duplicate pagination, because the cache write lands too late to help its own siblings.
  - **A 429 cooldown**, in KV so every lambda instance sees it. Without it a throttled window is self-sustaining — every host sees an error, every host retries, the retries keep the quota pinned. One 429 now parks all *uncached* loads for the duration Spotify asked for (clamped to 30s–15min); cached playlists keep serving, so a party already mid-game is unaffected by someone else's throttling.
  - **A proactive global budget** (`SPOTIFY_MAX_LOADS_PER_MINUTE`, default 40), a KV `incr` counter shared across instances. The cooldown above is reactive — it only helps once Spotify has already refused something. This is the half that stops us getting there: a spike, a scripted client, or a dozen rooms starting at once is refused here rather than spending the quota to find out. Counted in *loads*, not requests; one cold load is 1 metadata call plus up to 5 track pages, so the default works out to roughly 240 upstream requests a minute. Fails **open** on a KV error — losing the safety net has to mean "back to how it was", not "nobody can play".
  - **`limit=50` → `limit=100`** in `fetchPlaylistTracks`, Spotify's documented maximum. Every playlist was costing exactly twice the requests it needed to.
  - **`MAX_PLAYLIST_TRACKS = 500`**, replacing an unbounded `while (data.next)` loop. A 4,000-track playlist was 40 upstream requests for a game that then plays at most 50 of them.

### Added

- **Admission control in front of iTunes and Deezer**, mirroring what `lib/playlist-cache.ts` already does for Spotify, because previews are the hotter path: Spotify is called once per *playlist*, these are called once per *track*, so a cold 50-song game is 50 lookups of up to 5 upstream calls each. Nothing bounded that before — `enforceRateLimit` is per-IP, and every visitor got a fresh allowance against the one egress IP they all share.
  - **A global lookup budget** (`PREVIEW_MAX_LOOKUPS_PER_MINUTE`, default 120), a KV `incr` counter shared across instances. Counted in lookups, not requests: a found track costs one upstream call, one with no preview anywhere costs five. Apple documents roughly 20 calls a minute and in practice allows a good deal more, so the default sits between the two. Fails **open** on a KV error — losing the safety net has to mean "back to how it was", not "nobody hears any music". A refused lookup is *not* cached: the claim is already one cheap atomic op and self-limiting, where a marker per track would spend a KV write during the exact spike being ridden out.
  - **A per-source cooldown**, in KV so every instance sees it, started only when a source *explicitly* refuses us (403/429, or Deezer's quota body). While iTunes is parked the lookup goes straight to Deezer and vice versa, so the saving is the call never made. A dropped connection is `unavailable` but does **not** park the source — one flaky socket is not a rate limit, and parking the better source over it would turn a blip into a site-wide outage.
  - **Daily hit/miss/unavailable counters**, logged on misses only (`[preview-cache] miss hits=… misses=… unavailable=… rate=…`) and readable via `getPreviewCacheStats()`. `unavailable` rising while `misses` stays flat is throttling — the number that used to be silently recorded as a catalogue gap instead.

- **`POST /api/preview/batch`** — resolves a whole game's previews in one request, prefetched by the game page on mount. The reason is the KV bill as much as the upstream one: reading 50 tracks one key at a time is 50 Upstash commands and 50 round trips, where the new `KvStore.mget` is one of each. It also moves the lookup *off* the critical path of every round — resolving lazily meant a throttled minute reached the host as a dead Play button mid-party, the one moment there is nothing to be done about it. Strictly an optimisation: anything the batch defers or is refused comes back `unavailable`, and the per-track `GET` picks it up exactly as before.
  - Bounded three ways, so one cold 50-song start cannot starve every other party on the site: at most 25 tracks resolved upstream per batch, a 6s wall-clock deadline (a serverless function that hits its hard limit returns *nothing*, which is strictly worse than returning what it had), and the same global budget, claimed all-or-nothing so a game defers cleanly rather than stopping halfway through its own playlist. Deferred tracks are not written to KV — nothing refused them, and a marker would suppress the lazy lookup meant to pick them up.
  - `KvStore` gains `mget` and an optional `by` count on `incr`. The second exists so the batch's own stats and budget claims don't spend one command per track and undo the saving the first just made.

- **`&refresh=1` on `GET /api/preview`**, and the `<audio>` `error` handler that fires it. Preview clips sit on a CDN that rotates its URLs, so a cached hit can go dead long before it expires — which is the trade the year-long positive TTL makes, and this is the other half of it. The stored `itunesTrackId` makes the repair one `lookup?id=` call instead of the five-call search fan-out, falling back to a full search if the id has been retired. Once per track per game (a URL that fails twice is not a rotated one), and on its own much tighter rate-limit bucket, since bypassing the cache is the one parameter here that can be turned into an upstream amplifier.

- **Bilingual error messages, everywhere a player can be shown one.** Until now every failure was an English sentence built at the point it was thrown — except the Spotify 404, which was hardcoded *Traditional Chinese* and shown to everyone, so the two languages were already mixed and both were wrong for half the audience. `lib/error-messages.ts` (new) is now the only place an error string exists: one `AppErrorCode` union, one `Record<AppErrorCode, {en, zh}>` table, so a missing translation is a compile error rather than a silent English fallback — the same trick `lib/changelog.ts` uses.
  - **The server sends a code, never a sentence.** A room is read by several devices at once and nothing in a request says what language the *reader* wants: `/api/playlist` is called on behalf of other people's phones in Mixed mode, and `lib/playlist-cache.ts` caches 404s for ten minutes, so localising server-side would freeze whichever language wrote the entry into everyone else's screen. Each client renders the code itself. The English string still rides along in `error` for logs and for any client older than the code it was sent.
  - **The reader's device picks the language** (`detectErrorLocale`, `useErrorLocale`). `/zh` is a landing page with no error surfaces, while every screen that *can* fail is reached by scanning someone else's QR — a Taiwanese guest joining an English host's room still has to be able to read why their playlist was refused. Detected in an effect, not during render, so the server-rendered join pages don't hydrate against a different string.
  - `tests/error-messages.test.ts` enforces what a type cannot: both languages present and different, the same `{placeholders}` in both, placeholders only on the codes whose callers actually pass params, every `BuzzerErrorCode` mapped to a code that exists, and — in both languages — that none of the throttling messages tells the host to check their playlist is public.
- **Random sampling for oversized playlists.** A playlist longer than `MAX_PLAYLIST_TRACKS` is no longer read front-to-back: the first page reports the real length, and the rest of the page budget goes on randomly chosen pages spread across the whole playlist. Taking the first 500 of a 4,000-track playlist would mean the same songs every single game, and whatever the owner happened to add first. Sampling is by *page* rather than by track, because a page is what a request buys and sampling finer would cost more requests — the one thing this whole change exists to avoid. Page 0 is always among the candidates, since reading it is how the length is discovered, so the first 100 tracks are slightly over-represented; everything after them is uniform. Playlists that fit are still read whole and in order.
  - Sampled entries cache for 1h rather than 6h. The TTL is also how long everyone is stuck with the same draw, and six hours of it would undo the point of sampling.
  - `shuffle()` is Fisher-Yates. `Array#sort` with a random comparator, which the setup page still uses for its own shuffle, is not a uniform permutation.
- **Cache hit-rate instrumentation.** Hit/miss counters in KV, bucketed by day, held a week, readable via `getCacheStats()`. The running rate is logged on every *miss* rather than every load: once the cache is working, misses are the rare case, so the instrumentation gets quieter exactly as things get healthier and a sudden run of lines is itself the signal. Previously "did this work" could only be answered by the absence of 429s, which is indistinguishable from a quiet evening.
  - The line names its own caller (`source=playlist-api` / `source=room-submit`, threaded through `loadPlaylist`). Vercel attributes a log line to whichever request its instance happened to be serving, so a miss from `POST /api/room/[code]/submit` can surface against a concurrent `GET .../pool` — a route that never touches this file. Reading the method off the log row then points at a code path that cannot produce the line. `source=unknown` is the default, so a future caller that forgets says so in the logs instead of loading anonymously.
  - Replayed 404s are counted separately (`negative=`) as well as inside `hits`. They are real hits — answered without touching Spotify, which is all the rate claims to measure — but they are the one kind a *broken* input produces on repeat, so a host retrying a playlist they made private used to push the rate up. `hits - negativeHits` is the number that describes real playlists.

### Changed

- `/api/preview` answers `{previewUrl, status}` rather than `{previewUrl}` alone. `previewUrl` is unchanged so an older client keeps working; it just cannot tell "there is no clip" from "we couldn't reach anyone", which is the whole distinction. `preview_miss` in `lib/analytics.ts` carries the same split as a bucketed `reason` param — the two call for opposite responses (curate around a catalogue gap; fix our own throttling), and reading the second as the first is what sent us hunting for songs that were never missing. Needs registering as a GA4 custom dimension before it appears in reports.
- The game page no longer re-asks for a track it already knows has no clip. `previewCache.current[id] ?? track.previewUrl` treated a cached `null` as "not asked", so every press of Play on a silent track re-ran the whole lookup; `undefined` now means "never asked" and `null` means settled.
- `getPlaylistWithTracks` ties its two concurrent calls to an `AbortController`. `Promise.all` rejects on the first failure and the route returns, but the losing half used to keep paginating afterwards — spending quota on a request nobody was waiting for, and emitting `console.error` with no request context. That is the whole explanation for "Spotify tracks fetch error" appearing under `/api/preview` in the production logs; `/api/preview` never called Spotify at all.
- `/api/playlist` returns **429 and 404 as themselves** instead of flattening every upstream failure into `400 + message`, and sets `Retry-After` on a 429. The client could not previously tell "your playlist is wrong" from "we are throttled", so the UI told throttled hosts to check their URL was public — sending them straight back into retrying against a spent quota. The 429 message now says the URL is fine and gives a wait.
- `submitToRoom` runs the duplicate-name and room-full checks against the record it already holds *before* fetching the playlist. Those rejections used to cost a full pagination and then answer 409. The authoritative re-check inside the write loop is unchanged; both now share `assertCanJoin`.
- Mixed mode's Start button loads contributor playlists two at a time (`MIXED_FETCH_CONCURRENCY`) instead of all 12 at once, and reports a 429 as a wait rather than as "remove or fix" the contributor's playlist.
- Every API route answers a failure as `{ error, code }` (and `retryAfter` where there is a wait) through one helper, `errorResponse` in `lib/api-error.ts`. `SpotifyApiError`, `RoomError` and `BuzzerUnavailableError` are constructed from a code rather than a message; their `message` is now the English rendering, kept for `console.error` and never for the UI. `enforceRateLimit` takes a code instead of a sentence.
- `submitToRoom` carries an upstream failure's code and status through instead of flattening every one into `422 + message`. A player submitting during a Spotify cooldown was being told their playlist was the problem — the same mistake `/api/playlist` was fixed for above, in the one place it was still being made.
- `/api/playlist` responses no longer carry `rawJson`. Every consumer already dropped it via `stripTrackForStorage`; keeping it made cache entries and response bodies roughly an order of magnitude larger than they needed to be.

### Known gaps

- `SPOTIFY_MAX_LOADS_PER_MINUTE`'s default of 40 is a guess. The right value depends on which quota tier the Spotify app is on, which the code cannot find out — hence the env var. Watch the hit-rate log for a week and tune.
- The global budget is a fixed window, so it can pass up to 2× the limit across a window boundary, same caveat as `lib/rate-limit.ts`. Acceptable: the cooldown catches the overshoot.
- `MAX_PLAYLIST_TRACKS` makes "All" mean "a random 500". Invisible for any playlist a party would realistically use, but it is a real behaviour change, and `truncated` is returned but not yet surfaced anywhere in the UI — a host with a 4,000-track playlist gets no indication they're playing a sample.
- Hit rate is logged and readable in-process but has no endpoint, so checking it means grepping Vercel logs. Deliberate: an endpoint would need an auth story for what is currently a two-line grep.
- Only *errors* are bilingual. The setup page, the game page and both join pages are still English, so a Chinese-speaking player now reads a Chinese error inside an English screen. That is the right order to do it in — an error is the one string that appears when someone is already stuck — but the rest of the UI is the obvious next piece.
- The language is read from `navigator.language` with no way to override it. Fine while only errors are translated; a real language switcher wants a stored preference, and `detectErrorLocale` takes its tag as an argument so that can be added without touching call sites.
- The buzzer Worker still sends an English `message` alongside its code. Harmless — the client renders the code and uses the message only for a code it doesn't recognise — but it means the Worker's strings are not covered by the translation test, since `lib/buzzer-protocol.ts` is shared verbatim with the Worker and must stay dependency-free.

## [1.0.0] - 2026-07-30

The 1.0 line is drawn here rather than at a feature: the party game, Buzzer Mode,
Mixed Playlist Mode, the PWA and the bilingual site are all shipped and stable,
and this release makes the two things a 1.0 needs — release notes a player can
read, and enough instrumentation to know whether the newest feature actually
works for people who are not us.

### Added

- **Room funnel telemetry.** The room feature shipped in 0.3.0 with only the host side instrumented, which left the funnel without a denominator: `room_submission_received` counts submissions that *landed*, so a room with one submission was indistinguishable from one scan that worked and eight that bounced. The player side had no events at all — `app/j/[code]/page.tsx` did not import `trackEvent`. Six events close it:
  - `room_join_opened` (`join_page`, `wants_playlist`) — fires on every landing at `/buzz/[code]` and `/j/[code]`, including the ones that go no further. This is the denominator; `buzz_player_joined` only ever counted phones that made it.
  - `room_submission_sent` (`submitted_by`, `track_count`) and `room_submission_failed` (`submitted_by`, `reason`) — the phone's own view of submitting, which the host's poll cannot see: a player who hits an error never reaches the mailbox, so host-side counting reads it as "never scanned". `reason: "too_late"` is the 410 specifically, i.e. arrived after the host built the pool — a design question about when the mailbox closes, not a bug, and worth separating from real errors.
  - `room_open_failed` (`room_jobs`, `reason`) — a room that never opens is the one failure the funnel cannot infer, because the host gives up and every downstream event simply never happens. `reason: "buzzer_unavailable"` is split out because it means the Worker is down for everyone rather than that this host did something wrong.
  - `room_start_failed` (`contributor_count`) — a full room whose pool was refused: every playlist in, still no game.
  - `changelog_opened` (`version`) — reads of the panel below, attributed to the release being read.
- **A "What's new" overlay** in the footer of `/`, `/about` and `/zh`, replacing nothing — there was previously no way for a player to find out what changed. An overlay rather than a `/changelog` route on purpose: release notes are a detour, not a destination, and a navigation would discard the half-configured setup form, whose state lives in React. It would also want indexing, sitemap and `hreflang` entries for content with no search value.
  - Content lives in `lib/changelog.ts`, hand-written and deliberately *not* generated from this file. This one is a maintainer's record and includes a todo list; that one is for someone who came to play a party game.
  - Every entry is bilingual, as parallel `text`/`textZh` fields on one object rather than two lists. `/zh` is written natively rather than translated and its footer says 回報問題, so an English-only panel opening off it would undo the one thing that page is for. Parallel fields make a missing translation a type error instead of a silent English fallback.
  - Renders through a portal into `document.body`. The homepage footer sits inside `.fade-in` containers whose finished animation leaves a non-`none` transform behind, which makes them the containing block for `position: fixed` — an inline overlay was clipped to the footer.
  - Escape, backdrop click, body scroll lock, Tab trapped inside the dialog, focus restored to the trigger on close.

### Changed

- `room_created` and `buzz_room_created` now carry `room_jobs` (`"playlists" | "buzzer" | "both"`), previously `Record<string, never>`. A combined room fires *both* events, and without the param GA4's standard reports cannot tell that pair from two unrelated rooms opened in one session.
- Failure reasons on the new events are bucketed enums, never the raw error message. Messages come from upstream APIs and from pasted user input, so forwarding them verbatim would both blow up parameter cardinality and risk carrying a playlist URL into GA4. A test asserts the bucketing.
- `roomJobs()` moved from a module-private helper in `components/room-panel.tsx` to an export of `lib/analytics.ts`, beside the `RoomJobs` type it returns. It decides `room_jobs` on every room-created and room-open-failed event, so getting it wrong mislabels the whole funnel rather than merely dropping an event — and a private function inside a component is unreachable from a suite that covers `lib/` only. Now has tests for all three branches.
- `.link-btn` gained `cursor: pointer` and an explicit `line-height` in all three page styles, since it is now applied to a `<button>` as well as an `<a>` and buttons inherit neither.

### Known gaps

- Every new parameter needs registering as a GA4 custom dimension (event-scoped) before it appears in anything but Realtime and DebugView, and registration is not retroactive. `track_count` wants to be a custom *metric*, not a dimension.
- `trackEvent` no-ops when `NODE_ENV !== "production"`, so none of this can be verified against `next dev` in GA4 itself — only via the `console.debug` line it falls back to. Confirming the real pipeline means deploying and using DebugView.
- `room_join_opened` fires per page load, not per person. A player whose phone drops Wi-Fi and reloads counts twice, so the scan-to-submit rate is a floor rather than an exact figure.
- The overlay's release list is hand-maintained alongside this file. Nothing enforces that a release updates both; the tests only check ordering, non-emptiness and that both languages are present for whatever is there.

## [0.4.0] - 2026-07-29

### Added

- **Traditional Chinese landing page at `/zh`.** The site only ranked for the brand string "guessong" — a query nobody types unless they already know us. English head terms ("guess the song", "guess song") are a red ocean of Heardle clones, but the Chinese equivalents are not, and the audience is already here: the homepage hero has carried a Chinese line since launch. `/zh` is written natively rather than translated, and its `<h1>` is the keyword itself (`猜歌遊戲`) rather than the brand, because unlike `/` it has no brand identity to protect. Carries its own `HowTo` and `FAQPage` JSON-LD in `zh-TW`, and the homepage's Chinese hero line is now the crawl path into it, so the anchor text is the keyword instead of sitting next to it.
- **`hreflang` annotations** across `/` and `/zh` (`en`, `zh-TW`, `x-default`), emitted both as `<link rel="alternate">` tags and in `sitemap.xml`. Both URLs carry the full annotation set — a one-sided declaration is a weaker signal than none — and the visible language switcher on `/zh` points at `/` to match what the annotation claims.
- **`FAQPage` structured data on the homepage** and **`HowTo` on `/about`**, the latter generated from the existing `STEPS` array so the schema cannot drift from what the page actually renders.

### Changed

- **The homepage now has content for a search engine to read.** It was a setup form and roughly 50 words of prose, which left Google nothing to match "guess the song game" against except the brand string. Added a "What is GuessSong?" section and six FAQs — 588 words, all of it useful to a first-time visitor too, not keyword filler. The hero tagline ("Play a clip. Guess the song. Compete.") became an `<h2>` so the phrase people actually search for is a heading; the `<h1>` stays `GuessSong` and the hero is visually unchanged.
- Titles and descriptions across `/` and `/about` lead with the generic phrase instead of the brand. `/about` is now "How to Play the Guess the Song Game".
- Trimmed `keywords` from 22 entries to 11. Google has ignored the tag since 2009; the list is kept only because Bing still weighs it slightly, and a focused list is worth more there than a long one.
- Added an explicit canonical for the homepage. It's a client component and can't export its own metadata, so it lives in the root layout.

### Fixed

- `/buzz` and `/j` are now disallowed in `robots.txt`. They're ephemeral room codes that 404 once the room's TTL expires, so crawling them spent budget on pages guaranteed to rot.

### Known gaps

- The root layout owns `<html lang="en">` and Next.js only lets the root layout render `<html>`, so `/zh` scopes its language with `lang="zh-Hant-TW"` on its `<main>` instead. `hreflang` is what Google keys off, so ranking is unaffected, but a screen reader that only checks the root element will read the page with an English voice. Fixing it properly means moving every route into a `(lang)` route group with per-locale root layouts.
- Only `/` and `/zh` form an `hreflang` cluster. `/about` has no Chinese counterpart of its own — `/zh` covers that content — so it is deliberately left out rather than pointed at a page that isn't its translation.
- `/zh` duplicates about 200 lines of CSS from `app/about/page.tsx`. That matches the project's per-page `<style>` block convention, but a third page in this style is the point where the shared rules should be extracted.

## [0.3.0] - 2026-07-29

### Added

- **Buzzer Mode** — every player gets a buzzer on their own phone, so the host can stop refereeing "who said it first" and play too. Opt-in per game, and only offered when `NEXT_PUBLIC_BUZZER_WS_URL` is set, so merging this ships it dark.
  - Runs as a **Cloudflare Worker + Durable Object** (`worker/`), separate from the Next.js app on Vercel. The whole game hinges on "who pressed first" being one atomic server-side decision; a DO is single-threaded and addressed by room code, so every phone in a party reaches the same instance and the buzz handler runs to completion without another buzz interleaving. No lock, no CAS, no retry loop. Vercel can't host this itself — its WebSocket connections aren't guaranteed to land on the same function instance, so there'd be nothing to broadcast a room to. Reverses Premise 3 ("no realtime layer") of `dev_docs`' 2026-07-29 design doc.
  - Player page at `/buzz/[code]`: live socket, buzz button, queue position. Identity is a `playerId` in localStorage rather than the socket, so a phone that locks, drops Wi-Fi, or backgrounds reconnects into the same seat.
  - The host buzzes too, from the game screen, with **space** as their buzzer — they're already at the keyboard running clips, and making them pick up a second device was the thing this feature exists to stop.
  - Wrong answers pass the question down the buzz queue instead of ending the round.
  - The scoreboard is driven by whoever actually joined the room (`mergeRoomRoster`), additive only, so a player who drops out keeps the points they earned.
  - New telemetry shaped to answer questions that need n≈4000 rather than n=1: `buzz_received`, `buzz_round_resolved`, `buzz_player_joined`, and `peak_phone_count` on `game_finished`.
  - New modules: `lib/buzzer-protocol.ts` (wire types, imported verbatim by both sides of the network boundary), `lib/buzzer-client.ts`, `lib/use-buzzer-socket.ts`, `components/buzzer-button.tsx`, `components/buzzer-host-panel.tsx`.
- **One room, one code, one QR.** Buzzer Mode and Mixed Playlist Mode were two independent room systems, and a game could end up using both — players scanned twice, for two different codes, on two different pages. They now share a single code.
  - Sharing was rejected earlier for a real reason: the playlist code is shown to every player, and the Worker hands its host token to whoever POSTs a code first, so any guest could have claimed the buzzers. That dies if the host claims the Durable Object **first**, opens the Upstash mailbox under that same code second, and only then shows it — the code is never public before the host holds the DO. That ordering lives in `lib/room-client.ts` and a test asserts the call order, not just the result.
  - `createRoom()` takes an optional requested code; a code already in use is a `409`, never a silent join into someone else's mailbox.
  - The join link routes to `/buzz/[code]` when there is a buzzer, with `?p=1` when the room also collects playlists — a hint for the form, not a permission. `/j/[code]` still serves Mixed-without-buzzer unchanged.
  - `components/room-panel.tsx` replaces both former lobbies and merges its roster from the live socket and the mailbox poll.
- **The host can add their own playlist** in Mixed Playlist Mode's QR flow. Everyone else contributes by scanning the code on the host's screen, which the host cannot do — they *are* the screen. Missing since the mode shipped; they either sat out of their own party's pool or had to open the join link on a second device.
- **A clip transport for the host**: buzzing in pauses the music so the room can hear the answer, and `Resume` / `Stop` / `Replay` stay available until `Reveal Answer` ends the round.

### Changed

- The room step moved to the **bottom** of the setup page, after every setting. The code is what turns a configured game into a gathering, and printing it before the clip length was even picked meant people scanned into a room whose settings were still moving.
- Mixed Playlist Mode's start gate counts **playlists**, not players, and the host's own contribution counts toward it — so one guest plus the host is a startable 2-player mix. "Waiting for 1 more player" read as "wait for another guest" when what was missing was the host's own playlist.
- The game page uses **one corner radius** (`--radius`, 12px) for every rectangular surface and control; it had been five values picked per element plus Tailwind's `rounded`/`lg`/`xl`/`2xl` in the host panel. Only the circular avatar and the 2px progress hairline are exempt.
- The buzzer verdict buttons are content-sized and centred. `Correct +3` was `flex: 1`, so beside a content-sized `Wrong` it ballooned across the card and read as a different class of control.
- The early-buzz penalty was removed rather than made reachable — the buzzer is disabled while the round is idle, so it could never fire.

### Fixed

- `parseGamePayload` rewrote any unrecognised `GameMode` to `"party"`, so a buzzer game silently downgraded to a party game on sessionStorage round-trip with no error anywhere. Replaced with an `isGameMode()` allow-list, matching the `isPlaylistSource()` pattern one line above.
- The host held **two** WebSockets and double-counted every buzz. A "closed" flag shared across effect runs raced on remount; the room deduped the sockets by `playerId` so the phone count looked right, while every analytics event fired twice. All three telemetry curves would have been inflated ~2× and looked plausible enough to act on.
- A wrong room code hung on "connecting" forever. Unknown rooms are refused at the WebSocket upgrade (404), so the socket never opens and the server's `room_expired` message has no transport to arrive on. Never-opened closes are now counted instead.
- `reveal()` resolved the room's round, and the room only accepts a verdict while `locked` — so the exact moment the host started scoring was the moment `Correct` and `Wrong` became silent no-ops.
- `Wrong` left the eliminated player on screen: the reducer treated a known buzz entry that isn't at the head as a duplicate replay rather than a queue advance.
- Buzzer players scored nothing. Names typed at setup fed the scoreboard while names typed on each phone fed the room, and `awardPoint` matches by name — two name spaces that silently drifted apart. They now merge, case-insensitively, since the room already refuses a second "amy" while "Amy" is connected.
- `snapshot?.buzzes ?? []` in a hook dependency minted a fresh array every render, an infinite loop in the first second of every buzzer game. Now `useMemo`.
- The join URL was built from `NEXT_PUBLIC_BASE_URL`, which points at production — so a Vercel preview printed a QR code sending every player to a deployment where the room, and on a feature branch the whole route, doesn't exist. Now `window.location.origin`.
- The end-of-clip deadline was a single `setTimeout` against wall clock, so pausing a 15s clip at 8s would have ended it while still paused and resuming would have finished it instantly. Clip time is now accounted in segments.
- `Replay` didn't clear the running timers before restarting, so a replayed clip could be cut short by the deadline from the run before it.
- The clip transport lost buttons as the phase flipped: `Replay` existed only in `guessing`, so resuming took it away, and the clip running out took `Resume`/`Stop` away. Both phases now render one identical row.
- The Worker refused Vercel preview origins. `ALLOWED_ORIGINS` supports `*` globs, anchored at both ends, where `*` cannot span a `/` — so `https://guesssong-*.vercel.app` can't be widened into `https://guesssong-x.vercel.app.evil.com` by a crafted `Origin` header.
- Neither Worker endpoint was rate limited; the `Origin` check was the only thing in front of them, and that is trivially satisfied by a script running on a page the Worker already allows. The WebSocket upgrade was therefore an unmetered oracle for "does this room code exist", and a 4-character code from a 31-character alphabet is only ~923k combinations. Both endpoints now throttle per `CF-Connecting-IP` (Cloudflare's own header, which a client can't forge, unlike `X-Forwarded-For`) via Workers' `ratelimits` bindings: 60 joins/min, enough for a whole party arriving at once behind one Wi-Fi NAT plus reconnect backoff, and 15 room creations/min. The upgrade is checked *before* `getByName()`, so a code-guessing sweep can't instantiate a Durable Object per guess on its way to being refused.

### Known gaps

- **Buzzer Mode has never been tested on a real phone.** The entire value is on phones; `onPointerDown` timing, `navigator.vibrate`, and iOS long-press suppression have only ever been exercised with synthetic pointer events. No game has been played through to the finish screen with buzzers either.
- Host and player on the *same device* share one `playerId` and collide. Harmless in the real setup (host on a laptop, players on their own phones), but a host who opens the player page to test will break their own session.
- The host's space-bar buzzer is ignored while a button has focus, because space is that button's own activation. A host who clicks `Resume` with the mouse and then reaches for space will press `Stop` instead of buzzing.
- Room codes stay 4 characters from a 31-character alphabet (~923k combinations), chosen so a code is still shoutable across a room. Collisions are detected and retried on both backends, and enumeration is now metered per IP rather than lengthened — but a determined attacker with many IPs still has a smaller space to walk here than a 6-character code would give.
- The host's room state still lives only in React state — a page reload before starting the game orphans the room, now including the buzzer half.

## [0.2.0] - 2026-07-12

### Added

- **Mixed Playlist Mode** (v0–v2 of `dev_docs/guessong-mixed-playlist-spec.md`; v3 async quiz mode not started):
  - **v0 — Pass This Phone**: zero-backend flow where players take turns entering their name + Spotify playlist URL on the host's device, with a masked "✓ added" confirmation between turns. Capped at 12 contributors with duplicate-name rejection, matching the server room's limits.
  - **v1 — QR Code / Share Link room**: host creates a room (`POST /api/room`), players submit playlists via `/j/[code]` by scanning a QR code or receiving a shared link (`Share Join Link` button — same URL either way), host polls submission status and pulls the pooled tracks to start (`GET /api/room/[code]/pool`). Rooms are TTL'd (30 min) and gated behind at least 2 contributors. Backed by Upstash Redis in production, in-memory fallback for local dev. All four room routes are rate-limited per IP.
  - **v1.5 — Guess-the-source scoring**: host scoring panel gained a third dimension, "+2 for guessing whose playlist a track came from." Every player is eligible, including the track's own contributor(s) — sampling means a contributor doesn't know which of their tracks made the pool, so they may not recognize their own track any faster than anyone else.
  - **v2 — Group taste card**: a downloadable "Save Taste Card" image (alongside the existing "Save Results") showing shared tracks across playlists, "Most Obscure Taste," and "Most Mainstream" awards.
  - New shared modules: `lib/mixed-playlist.ts` (cross-playlist fingerprint dedupe + fair per-contributor sampling), `lib/room.ts` + `lib/kv.ts` (room lifecycle + KV abstraction), `lib/rate-limit.ts`, `lib/round-history.ts`, `lib/taste-card.ts`, `lib/result-image.ts` (shared canvas card rendering).
  - `Track.contributors` and `Track.popularity` added to the shared track shape; `GamePayload.mixedPlaylistMeta` added for pool provenance.

### Fixed

- `parseGamePayload`'s `playlistSource` fallback used a binary ternary (`"builtin" : "own"`) that would have silently misclassified the new `"mixed"` source as `"own"` on sessionStorage round-trip; replaced with an allow-list check.
- `submitToRoom`/`consumeRoomPool` read-modify-wrote the whole room record with no atomicity — two players submitting close together could silently clobber each other, and a submission racing a host's "Start" could un-consume an already-started room. Both now re-read the record immediately before writing and retry on a lost write instead of failing silently.
- `GET /api/room/[code]/status` and `GET /api/room/[code]/pool` had no rate limiting, unlike the other two room routes — an unthrottled client could enumerate the ~1M possible 4-char room codes and read active rooms' player names. Both now rate-limit per IP.
- Room submissions stored the full raw Spotify API blob (`Track.rawJson`) per track; a full room could approach Upstash's per-value size limit and made every submission's write cost grow with room size. Submissions are now stripped before storage via the same `stripTrackForStorage` helper already used for sessionStorage.
- `computeMostObscure` credited every contributor of a shared (multi-contributor) track whenever any correct source guess was made, even though the game has no record of which specific contributor was named — inflating the "Most Obscure Taste" stat for tracks that appear in multiple playlists. Now only single-contributor tracks count toward this award.
- `downloadTasteCard`'s canvas height was hardcoded assuming both taste-card awards always render; when only one (or neither) applies, the shared image left unexplained blank space. Height now reflects the actual award count.
- Room-full submissions returned `429` (rate-limit's status code) instead of `409` (conflict), making the two failure modes indistinguishable to a client.
- Host-token comparison in `consumeRoomPool` used `!==` instead of a constant-time comparison.

### Known gaps

- The spec's fourth taste-card award, "most often mistaken for someone else," is not implemented — the host-scoring UI only records whether a source guess was *correct*, never who was guessed instead when it was wrong. Would need a new scoring-UI step to compute.
- Manual "add track via search" fallback for non-Spotify users (KKBOX / YT Music / Apple Music) is deferred past v1's initial scope.
- `getClientIp` trusts the client-supplied `X-Forwarded-For` header verbatim; on a deployment where the edge doesn't strip/overwrite it, rate limits could be bypassed by rotating the header per request.
- The host's room state (`roomCode`/`hostToken`) lives only in React state — a page reload before starting the game orphans the room and any submissions already received.
