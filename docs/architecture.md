# Architecture

The system in pictures. `CLAUDE.md` carries the invariants and the hazards;
this is the shape they sit on.

---

## 1. The whole thing

Two hosts, and the split is not arbitrary. Vercel serves the app and everything
request-shaped. Cloudflare serves the one thing Vercel structurally cannot: a
live room that several phones are connected to at once. See
[decisions.md](decisions.md#d3--buzzer-rooms-run-on-cloudflare-durable-objects).

```
                    ┌───────────────────────────────────────┐
   host's laptop    │            VERCEL (Next.js)           │
   ┌──────────┐     │                                       │
   │  /       │────▶│  POST /api/playlist ──┐               │
   │  /game   │     │  GET  /api/preview    │               │
   └──────────┘     │  POST /api/preview/   │  lib/kv.ts    │      ┌──────────┐
        │           │       batch        ───┼─────────────────────▶│ UPSTASH  │
        │           │  POST /api/room/…     │  (the only    │      │  REDIS   │
        │           │  GET  /r/[surface]    │   server      │      └──────────┘
        │           │  POST /api/pulse   ───┘   state)      │       TTL'd only:
        │           │                                       │       rooms, rate
        │           └──────────┬────────────────────────────┘       limits, caches,
        │                      │                                    loop counters
        │                      ▼
        │       ┌──────────────────────────────┐
        │       │  Spotify  ·  iTunes  ·  Deezer│  all rate limited per app / per IP,
        │       └──────────────────────────────┘  never per user — see §3
        │
        │  WebSocket
        ▼
   ┌─────────────────────────┐        ┌──────────────────────┐
   │   CLOUDFLARE WORKER     │◀──────▶│  players' phones     │
   │   worker/src/           │   WS   │  /buzz/[code]        │
   │   one Durable Object    │        └──────────────────────┘
   │   per room code         │
   └─────────────────────────┘
```

**There are no user accounts and no database.** Everything in Upstash has a TTL
and belongs to a room, an IP, a cached lookup, or a daily counter. Nothing is
keyed to a person. That is a product decision, not an omission — see
[decisions.md](decisions.md#d1--no-accounts-ever).

---

## 2. One game, start to finish

```
SETUP  app/page.tsx
  │
  │  paste playlist URL, add players, pick clip length
  ▼
  POST /api/playlist ──▶ lib/playlist-cache.ts ──▶ lib/spotify.ts ──▶ Spotify
  │                       cache → coalesce → budget → cooldown
  │                       (§3 — all four exist to protect one shared quota)
  ▼
  shuffle, write the whole payload to sessionStorage under `guesssong_game`
  │
  ▼
GAME  app/game/page.tsx
  │
  │  on mount: POST /api/preview/batch for the entire game at once
  │            anything unresolved falls back to GET /api/preview lazily
  │
  │  per track:   waiting → playing → guessing → revealed
  │                                                 │
  │               host awards points by tapping a name  (+3 song, +1 album)
  │               there is no automated answer checking — the host is the judge
  │                                                 │
  └─────────────────── next track ──────────────────┘
                              │
                              ▼
                          finished
```

The state machine lives entirely in React state. A reload loses the game, which
is why `sessionStorage` holds the payload but not the score: recovering a
half-played party would need a server-side game record, and that is the first
step towards accounts.

---

## 3. Three caches, one shape

The single most important thing to understand about this codebase. All three
upstreams throttle on something the app cannot spread out — Spotify on the
**client id**, iTunes and Deezer on the **egress IP** — while every limiter in
`lib/rate-limit.ts` is keyed per visitor IP and therefore hands each new arrival
a fresh allowance. Per-IP limits bound one abusive client. They do nothing about
aggregate load, and aggregate load is the entire problem.

So each cache is four layers, and they read the same way on purpose:

```
     request
        │
        ▼
   ┌─────────┐   hit
   │  CACHE  │────────▶ answer, zero upstream calls
   └────┬────┘
        │ miss
        ▼
   ┌─────────────┐   already in flight
   │ COALESCING  │──────────────────────▶ await the sibling
   └────┬────────┘   (one Mixed-mode Start fans out to N identical loads;
        │             the cache write lands too late to help its own siblings)
        ▼
   ┌──────────────┐   over budget
   │GLOBAL BUDGET │──────────────────────▶ refuse here, before upstream does
   └────┬─────────┘   a KV incr shared across instances
        │
        ▼
   ┌──────────────┐   upstream said 429
   │  COOLDOWN    │──────────────────────▶ park all uncached loads
   └────┬─────────┘   without it a throttled window is self-sustaining:
        │              everyone errors, everyone retries, the quota stays pinned
        ▼
     upstream
```

| | `lib/playlist-cache.ts` | `lib/preview-cache.ts` |
|---|---|---|
| Called once per | playlist | **track** |
| Cold 50-song game | 1 load | **50 lookups, up to 5 calls each** |
| Budget env var | `SPOTIFY_MAX_LOADS_PER_MINUTE` (40) | `PREVIEW_MAX_LOOKUPS_PER_MINUTE` (120) |
| Positive TTL | 24h (1h if sampled) | 1 year |
| Negative TTL | 10 min | 1 week (`absent`) / **90s** (`unavailable`) |

**Every layer fails open.** Losing the safety net must mean "back to how it was",
never "nobody can play".

The third cache is the Spotify token in `lib/spotify.ts`, deliberately at module
scope rather than in KV: a token is the one thing with no fallback, so a KV
outage on that path would take playlist loading down entirely.

### The distinction that keeps getting collapsed

`absent` and `unavailable` are both "no clip", and treating them as one value is
a bug that already shipped once:

- **`absent`** — a fact about the recording. Nothing anywhere has a clip.
  Cached a week.
- **`unavailable`** — a fact about *us*. Throttled, out of budget, or the
  request never got through. Cached **90 seconds**.

A wrong `absent` lasts a week and is invisible. A wrong `unavailable` costs one
retry. Only a clean, complete reply from upstream may produce `absent`.

---

## 4. Buzzer rooms

```
  host's laptop                DURABLE OBJECT               phones
  BuzzerHostPanel              one per room code            /buzz/[code]
       │                              │                          │
       │──── host:open ──────────────▶│                          │
       │                              │───── round:open ────────▶│  buttons live
       │                              │                          │
       │                              │◀──────── buzz ───────────│  ×N, racing
       │                              │                          │
       │                              │  single-threaded: order  │
       │                              │  is decided by arrival,  │
       │                              │  no locks, no CAS        │
       │                              │                          │
       │◀───── state (locked) ────────│──── state (locked) ─────▶│  first name up
       │                              │                          │
       │─ host:verdict / host:reveal ▶│                          │
       │                              │──── round:resolved ─────▶│  phase → idle
       │──── host:next ──────────────▶│  roundIndex += 1         │
       └──────────────────────────────┘                          │
```

`lib/buzzer-protocol.ts` is imported from **both** sides of that boundary — the
Next.js client and the Worker — so it must stay dependency-free. Types and plain
constants only.

**The protocol has no end-of-game signal.** `BuzzerPhase` is
`idle | open | locked`; `ClientMessage` has `host:open`, `host:verdict`,
`host:reveal`, `host:next` and nothing else. Anything on a player's phone that
needs to react to the game finishing would need a protocol change, a Worker
change, and a `wrangler deploy`. This is why the loop's call to action on that
page is gated on "a round has resolved" rather than "the game ended" — see
[viral-loop.md](viral-loop.md#the-buzz-cta-gate).

---

## 5. Where state actually lives

| Where | What | Lifetime |
|---|---|---|
| React state | the running game — phase, scores, current track | until reload |
| `sessionStorage` | the game payload handed from `/` to `/game` | the tab |
| `localStorage` | player id, host name, host game count, last loop ref | the device, until ITP clears it |
| Upstash KV | rooms, rate limits, playlist + preview caches, loop counters | 30s – 1 year, always a TTL |
| Durable Object | one live buzzer room | 3h idle timeout, sliding |
| GA4 | the funnel | Google's retention setting |

Nothing in that table is keyed to a person, and nothing survives being cleared
except the caches, which are keyed to content rather than to anyone.
