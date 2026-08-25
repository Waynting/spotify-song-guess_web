# Operations

Deploying, and what to do when something is wrong. `README.md` covers first-time
setup; this is the part you need at 11pm.

---

## 1. Two deploys, and only one is automatic

| | Where | How | When |
|---|---|---|---|
| The app | Vercel | auto-deploys on merge to `main` | every merge |
| The buzzer Worker | Cloudflare | `cd worker && npm run deploy` | **manually, never automatically** |

**The Worker does not deploy itself.** Nothing in CI touches it. A change to
`worker/src/` that is merged and not deployed leaves production running the
previous version, and the symptom is not an error — buzzer rooms simply behave
like the old code.

`lib/buzzer-protocol.ts` is imported by both sides. Changing it means deploying
both, and **the Worker first**: an old Worker talking to a new client fails on
messages it does not recognise, while a new Worker talking to an old client
usually still works, because the protocol only ever gains message types.

```bash
cd worker
npm run typecheck
npm test
npm run deploy
```

## 2. There is no CI

No `.github/workflows`. Nothing runs the suite before a merge. Before opening a
pull request:

```bash
npm test              # 32 files, 591 tests, ~1.5s
npx tsc --noEmit
npx eslint app lib components
npm run build         # see the warning below
```

> **Never run `npm run build` while `npm run dev` is running.** The production
> output overwrites `.next` and the dev server then answers every request with
> `Cannot find module ./331.js`. `rm -rf .next` is not enough — the running
> process still holds the old chunk table in memory, so the dev server has to be
> restarted. Stop dev first.

## 3. Environment variables

Full annotated list in `.env.example`. What actually breaks without each:

| Variable | Missing means |
|---|---|
| `SPOTIFY_CLIENT_ID` / `_SECRET` | no playlist loads at all — every game starts from a pasted URL, so this is total |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | falls back to an in-process `Map`. Fine for `next dev`; **broken on Vercel** — rooms created by one lambda are invisible to another, rate limits reset per instance, caches lose most of their hit rate |
| `NEXT_PUBLIC_BUZZER_WS_URL` | Buzzer Mode reports rooms unavailable rather than failing at connect time |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | no GA4. The KV loop counters still work |
| `NEXT_PUBLIC_BASE_URL` | defaults to `https://www.guessong.app` |
| `SPOTIFY_MAX_LOADS_PER_MINUTE` | defaults to 40 |
| `PREVIEW_MAX_LOOKUPS_PER_MINUTE` | defaults to 120 |

---

## 4. Reading what production is doing

### The loop

```bash
npm run stats
```

Full guide: [viral-loop.md](viral-loop.md#5-running-npm-run-stats). Every number
it prints is a floor — §6 there explains why that matters more than it sounds.

### The caches

No endpoint, by design; an endpoint would need an auth story for what is a
two-line grep. In the Vercel logs:

```
[playlist-cache] miss id=… source=… misses=…
[preview-cache]  miss hits=… misses=… unavailable=…
```

Both log **only on a miss**, so the instrumentation gets quieter as things get
healthier and a sudden run of lines is itself the signal.

**The lines describe one request, not the day.** They used to carry a cumulative
`rate=`, which meant reading two more counters back out of KV on every miss — on
the path that is by definition already the expensive one — to compose a sentence
for a log nobody tails. The cumulative view moved to where it is actually read:

```bash
npm run stats            # the loop counters
```

…and, for the caches, `getCacheStats()` / `getPreviewCacheStats()`, which answer
on demand rather than on every miss. `misses=` in the playlist line is still the
running day total, because it is what `incr` returns and so costs nothing.

Two traps in reading those lines, both of which have cost a debugging detour:

- **Trust `source=`, not the log row's method.** Only `POST /api/playlist` and
  `POST /api/room/[code]/submit` can emit the line, but Vercel attributes it to
  whichever request the instance happened to be serving, so it frequently
  appears against an unrelated `GET`.
- **A replayed 404 counts as a hit** in `getCacheStats()`. Correctly — it
  answered without touching Spotify — so a host retrying a dead link pushes the
  rate *up*. `negativeHits` is that subset; `hits - negativeHits` is the part
  describing real playlists. The bucket is a **UTC** day, so a rate read just
  after 00:00 UTC is measuring almost nothing.

---

## 5. Symptoms

### "Every route returns 500 with an empty body"

Check the Upstash request quota first. The free plan allows 500,000 commands a
month, and once it is spent **every** Redis command fails with
`ERR max requests limit exceeded` until the quota rolls over — days, not the
seconds a network blip costs.

The signature is a `500` with `content-length: 0` and no `code` in the body,
on every route at once including `/api/playlist` and `/api/preview`, while `/`
itself still serves `200` because the static pages touch no KV:

```
curl -i -X POST https://www.guessong.app/api/playlist \
  -H 'Content-Type: application/json' -d '{"url":"<any public playlist>"}'
```

An empty body is the tell. Every handled failure in this app answers with
`{error, code}` — see `lib/api-error.ts` — so a response with neither did not
come from a handler at all. What the host sees is the generic "couldn't load
the playlist", which points at their URL and is actively misleading: the
playlist is usually fine, and they will re-copy the link and retry instead of
reporting an outage.

This used to be a total outage rather than a degradation, because
`enforceRateLimit` runs at the top of all seven API routes *before* their own
`try`/`catch`, and `lib/rate-limit.ts` was the one KV consumer that did not
fail open. It does now, so an exhausted quota costs the per-IP ceiling and the
KV-backed features instead of the site. What still degrades while the quota is
spent:

- **Rooms and Mixed Playlist Mode stop**, cleanly — `room_open_failed` rather
  than a bare 500. They *are* the KV, so there is nothing to fall back to.
- **Every cache misses**, so each playlist load reaches Spotify and each track
  reaches iTunes/Deezer. The site works and is slower.
- **The global budgets and the 429 cooldown are gone too**, since they are KV
  counters that also fail open. This is the accepted trade — losing the safety
  net means "back to how it was", not "nobody can play" — but it does mean the
  shared Spotify quota is running unprotected. Restore Upstash before assuming
  a Spotify 429 is a separate incident.
- **The loop counters stop**, so `npm run stats` under-reports that window.
  The liveness marker (see `docs/viral-loop.md`) is what keeps this readable as
  a gap rather than a genuine zero.

Sustained command volume is worth a look before raising the plan, and the room
panel's roster poll is the first place to look, because it was how this quota
was spent. `/api/room/[code]/status` runs every 4s and costs two commands a
tick — the route's rate-limit `incr`, then the room read. It used to be a bare
`setInterval` bounded only by the panel staying mounted, so a host who opened a
room and left the tab parked kept polling at ~15 requests a minute forever,
against rooms that `ROOM_TTL_SECONDS` had already deleted; the 404s were
swallowed and retried. That is ~43k commands a day per abandoned tab, on a
budget of 500k a *month*, buying nothing.

`components/room-panel.tsx` now stops on all three: a terminal status (404
gone, 410 already started), a deadline of `ROOM_TTL_SECONDS` from mount, and a
hidden tab (which skips the fetch and polls once on return). If that loop is
ever refactored back toward `setInterval`, all three have to survive it — none
of them is visible in the UI, and the cost of losing them shows up weeks later
as this symptom.

### "Songs have no audio"

First distinguish the two causes, because they call for opposite responses:

- `absent` — nothing anywhere has a clip for that recording. A catalogue gap.
  Curate around it.
- `unavailable` — **our** problem: throttled, out of budget, or the request did
  not get through.

`preview_miss` in GA4 carries this as a bucketed `reason`, and
`[preview-cache] … unavailable=` rising while `misses=` stays flat is the
throttling signature. Reading the second as the first is how a previous
investigation went hunting for songs that were never missing.

Note that iTunes signals throttling with **403**, not 429, and Deezer returns
its quota error in the body of a **200**.

### "Vercel says the CPU budget is nearly spent"

Fluid Compute bills **Active CPU** — time your code actually runs. Waiting on
Spotify, iTunes or Upstash is free, so the bill is not a story about slow
upstreams. It is a story about how many function invocations happen at all, and
how expensive each one is. Hobby is 4 CPU-hours a month; going over does not
cost money, it suspends the project until you deal with it.

Do not reason about this from the code. Get the distribution first:

```bash
vercel logs <production-deployment-url> --json > /tmp/logs.jsonl
```

Then count by `source` and `requestPath`. Only `source: "serverless"` and
`source: "edge-function"` are billed; `source: "static"` is served from the CDN
and costs nothing. That one command is what turned a guess into an answer here —
the two things that had been quietly dominating the bill were:

- **Routes that should have been static and were not.** A page or route handler
  carrying `export const runtime = "edge"` is opted out of static generation, so
  it runs per request. Next prints a warning at build time and it is easy to
  read past. The reliable check is the route table from `npm run build`: `○` and
  `●` cost nothing, `ƒ` runs every time. Three image routes were `ƒ` for months
  and nothing on the page looked wrong, because the bytes are identical either
  way.
- **A client retrying something that can never succeed.** A cached 404 answers
  in ~100ms, which is faster than a button re-enables, so a host tapping Start on
  a dead playlist generated bursts of fourteen billed invocations that all
  replayed the same cached refusal. Per-IP rate limiting does not catch this —
  the bursts sit well inside the allowance. See CLAUDE.md's
  `isDeterministicPlaylistFailure` note for why only some failures may be
  written off this way.

The general shape: an expensive-looking route with a good cache is usually fine,
and a cheap route invoked in a loop is usually the problem.

### "Spotify says 429"

The cooldown in `lib/playlist-cache.ts` parks all *uncached* loads for the
`Retry-After` duration (clamped 30s–15min), shared across instances via KV.
Cached playlists keep serving throughout, so a party already mid-game is
unaffected.

If it is persistent rather than a spike, lower `SPOTIFY_MAX_LOADS_PER_MINUTE`.
Its default of 40 is a guess — the right value depends on which quota tier the
Spotify app is on, which the code cannot discover, which is why it is an env
var. Watch the hit-rate log for a week and tune.

**Never flatten an upstream 429 into a generic 400.** The client has to be able
to tell "your playlist is wrong" from "we are throttled"; an earlier version
told throttled hosts to check their URL was public, which sent them straight
back into retrying against a spent quota.

### "The buzzer room will not connect"

In order of likelihood:

1. `NEXT_PUBLIC_BUZZER_WS_URL` unset or pointing at a dead Worker
2. The Worker was not deployed after a merge (see §1)
3. The room expired — the DO has a **3h idle timeout**, and it slides on host
   activity

A room that does not exist is refused at the WebSocket upgrade, which means the
client can never receive an app-level error — there is no socket to send one
over. `lib/use-buzzer-socket.ts` therefore counts consecutive never-opened
attempts and gives up at three. The threshold cannot be one: a phone waking on a
flaky network legitimately fails the first attempt or two.

### "The room disappeared mid-game"

Mixed Playlist rooms use `ROOM_TTL_SECONDS = 30 * 60`, counted from **creation**
and deliberately not extended by activity (`types/room.ts`, `lib/room.ts`). That
is correct for a one-shot playlist mailbox and wrong for anything that must
outlive a full game. Buzzer rooms are a different system with a sliding timeout.

### "A clip plays but the answer card disagrees"

Two causes, and they are told apart by whether it is reproducible. Ask the host
whether they skipped or revealed while it said "Finding audio…".

**If it only happened once, on a round they advanced past:** the preview
resolved after the host had moved on and landed on the round in front of it.
`lib/round-token.ts` stamps a generation before every await and
`retireRound()` bumps it, so this is fixed as of 1.7.5 — but a round-ending
path added later that forgets to call `retireRound()` brings it straight back,
and nothing in the suite can catch that (the guard lives in
`app/game/page.tsx`, which vitest cannot import). Check the call sites first.

**If the same track is wrong every time:** a wrong recording was cached as
correct. Positive preview entries are held a **year**, and `&refresh=1` repairs
rotted URLs, not wrong songs — worse, a wrong-but-playable URL never fires the
`<audio>` error that triggers refresh at all. The matching rules are in
`lib/preview-cache.ts`; the 1.2.0 changelog entry has the original tier
reasoning and 1.7.5 has the three corrections layered on it (credits compared as
acts, a qualifier-stripped title tier, artist-less lookups held to the running
time). Fixing one means invalidating that track's key, not bumping the cache
version: a version bump cold-starts every entry in production simultaneously,
which is the upstream stampede the module exists to prevent.

---

## 6. Release

Both changelogs, always. `tests/changelog.test.ts` fails if `package.json`'s
version moves without a matching entry in `lib/changelog.ts`.

1. `CHANGELOG.md` — the maintainer's record. Technical, names files and
   functions, carries a "Known gaps" list.
2. `lib/changelog.ts` — what players read in the footer overlay. Plain language
   and **bilingual**: every entry needs `text`/`textZh` and
   `headline`/`headlineZh`. `/zh` is written natively, so an English string
   leaking through is a visible defect.
3. `package.json` version.

Purely internal changes — a script, a doc, a refactor with no user-visible
effect — take no version bump and no `lib/changelog.ts` entry.
