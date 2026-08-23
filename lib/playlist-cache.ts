/**
 * Cache and admission control in front of Spotify playlist loads.
 *
 * Spotify's client-credentials quota is per *app*, not per user or per IP.
 * Every rate limiter in this codebase is keyed by IP (lib/rate-limit.ts), so
 * N players from N phones each got a fresh allowance against one shared
 * upstream budget — and nothing anywhere cached a playlist. The same URL
 * re-paginated in full on every submit, every retry, and every player in a
 * room who happened to paste the same link. That is what produced
 * `429 QUOTA_EXCEEDED`.
 *
 * Three layers, cheapest first:
 *
 *   loadPlaylist ─→ KV cache ─────── hit ──→ return (zero upstream calls)
 *                       │ miss
 *                       ├─ in-flight map ── hit ──→ await the existing fetch
 *                       │ miss
 *                       ├─ cooldown gate ── open ─→ throw 429 immediately
 *                       │ closed
 *                       └─ Spotify ─→ store ─→ return
 *
 * The cooldown is the layer that actually lets the quota recover. Without it
 * a throttled window is self-sustaining: every host sees an error, every host
 * retries, and the retries keep the quota pinned. One 429 from Spotify parks
 * *all* uncached loads for the duration it asked for.
 *
 * Every KV call is wrapped. A cache outage must degrade to "slower", never to
 * "broken" — same contract as app/api/preview/route.ts, which this follows.
 */

import { dayBucket, getKvStore, hourBucket } from "@/lib/kv";
import {
  getPlaylistWithTracks,
  isSpotifyEditorial,
  parsePlaylistUrl,
  SpotifyApiError,
} from "@/lib/spotify";
import { stripTrackForStorage } from "@/lib/game-session";
import type { AppErrorCode } from "@/lib/error-messages";
import type { SpotifyServiceStatus } from "@/types/service-status";
import type { Track } from "@/types";

/**
 * Bump when the cached shape changes. Entries are TTL'd rather than migrated,
 * so an old-shape read would otherwise be handed to callers as a valid hit.
 */
const CACHE_VERSION = "v1";

/**
 * Long enough that a party spends zero upstream requests after the first load
 * — including the host reloading, re-pasting, or every player in a room
 * submitting the same popular playlist.
 *
 * Six hours was too short, and the counters said so before the quota did.
 * Parties are a nightly event: a playlist first loaded at 8pm is cold again by
 * 8pm the next day, so the cache only ever held about a fifth of a day's
 * playlists — 406 warm keys against 2,152 cold loads in a day, a 26% hit rate,
 * and every one of those misses spending the app's shared Spotify quota. A day
 * covers tonight-to-tomorrow-night, which is the interval that actually
 * repeats here. The cost is that a host who adds songs this afternoon may not
 * see them tonight; that is a worse trade at six hours than it looks, because
 * the alternative it bought was the whole site being locked out of Spotify.
 */
const HIT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Shorter, for playlists too big to read whole. Those are cached as a *random
 * sample* of MAX_PLAYLIST_TRACKS, so the TTL is also how long everyone is
 * stuck with the same draw. Six hours would mean a 4,000-track playlist plays
 * the same 500 songs all evening, which is the thing sampling exists to avoid;
 * an hour still absorbs a party's worth of retries and reloads.
 */
const SAMPLED_TTL_SECONDS = 60 * 60;

/**
 * Negative caching, deliberately much shorter than the preview cache's.
 * A 404 here usually means "public playlist, wrong link" or "the owner made it
 * private", both of which a host fixes within minutes; caching that for days
 * would keep telling them their fixed playlist is broken. Ten minutes is
 * enough to absorb the burst of retries a bad paste generates.
 */
const NOT_FOUND_TTL_SECONDS = 10 * 60;

const COOLDOWN_KEY = "spotify:cooldown";

/**
 * Proactive ceiling on how many playlist loads the *whole site* sends upstream
 * per minute, shared across lambda instances via KV's atomic incr.
 *
 * The cooldown below is reactive — it only helps once Spotify has already
 * refused something. This is the half that stops us reaching that point: a
 * traffic spike, a scripted client, or a dozen rooms starting at once gets
 * refused here rather than spending the app's quota to find out.
 *
 * The number is in *loads*, not requests. One cold load costs 1 metadata call
 * plus up to MAX_TRACK_PAGES track pages, so the default 40 works out to a
 * ceiling of roughly 240 upstream requests a minute. Cache hits never reach
 * here, so this bounds genuinely-new playlists only. Env-overridable because
 * the right value depends on which quota tier the Spotify app is on, and that
 * is not something the code can find out.
 */
const GLOBAL_LOAD_WINDOW_SECONDS = 60;
const DEFAULT_GLOBAL_LOAD_LIMIT = 40;
const BUDGET_KEY = "spotify:budget";

/**
 * The same idea over the window that actually cuts us off.
 *
 * The per-minute gate above bounds a *burst*. It has never once fired in
 * production — `spotify:budget` was observed at 0-1 all through the outage of
 * 2026-08-23 — because it is guarding the wrong dimension. Spotify's refusal
 * is a quota over roughly 24 hours, and a day's worth of traffic arriving at
 * an average of one or two loads a minute passes a 40-a-minute ceiling
 * without ever touching it. Both gates are needed: this one cannot stop a QR
 * room's twelve simultaneous submits, and that one cannot stop an ordinary
 * Sunday.
 *
 * **The window is rolling, not a calendar day, and that is not a detail.**
 * Measured 2026-08-23: the app was refused after only 476 cold loads that day,
 * because the previous evening's 2,152 were still inside Spotify's window, and
 * the `Retry-After` pointed at 19:53 UTC rather than any midnight. A
 * `dayBucket` counter reset at 00:00 UTC would have let a busy evening and the
 * following busy morning each pass their own cap while together exceeding
 * anything Spotify would allow — the exact failure it was added to prevent. So
 * the counter is twenty-four hourly buckets, summed.
 *
 * The hourly buckets are also the only record of *when* the day is spent,
 * which is the number the limit below has to be tuned against; `npm run stats`
 * prints them.
 */
const DAILY_WINDOW_HOURS = 24;
const HOUR_BUCKET_TTL_SECONDS = (DAILY_WINDOW_HOURS + 1) * 60 * 60;
const HOUR_BUDGET_PREFIX = "spotify:budget:h";
const HOUR_REFUSED_PREFIX = "spotify:budget:refused";

/**
 * Written when the window is spent, read by `getSpotifyServiceStatus`.
 *
 * The status route is a page-view-rate path and its whole cost claim is "one
 * KV read". Summing twenty-four hourly buckets there to answer a yes/no would
 * quietly make the notice more expensive than the gate it reports on, so the
 * gate leaves a flag behind instead and the notice reads it in the same `mget`
 * it already spends on the cooldown. TTL'd to the hour boundary, which is when
 * the oldest bucket rolls out and the answer can change.
 */
const DAILY_SPENT_KEY = "spotify:budget:spent";

/**
 * Loads allowed upstream per rolling 24h, before we start refusing on
 * Spotify's behalf.
 *
 * Every input to this number is an inference, so it is env-overridable and
 * deliberately easy to find. What is known: Spotify does not publish a figure;
 * the developer dashboard showed ~3,850 requests on the day the quota died;
 * and since 1.7.1 a cold load costs ~1.2 requests rather than ~2.2. 2,000
 * loads is therefore ~2,400 requests — under the wall by a margin, and just
 * under a normal day's 2,152 cold loads, so it will occasionally refuse at the
 * margin.
 *
 * That last part is the trade, stated plainly: refusing perhaps a hundred
 * loads at the edge of a busy day is chosen over Spotify refusing *every*
 * uncached load for 13.4 unconditional hours, which is what it did. Ours is a
 * counter that rolls forward hour by hour; theirs is a penalty box with a
 * fixed sentence.
 */
const DEFAULT_DAILY_LOAD_LIMIT = 2000;

/**
 * Spotify's Retry-After on QUOTA_EXCEEDED is sometimes enormous and sometimes
 * absent. Measured on 2026-08-23: `retry-after: 52531`, `reason:
 * QUOTA_EXCEEDED` — 14.6 hours, because the exhausted thing is a daily app
 * quota rather than a burst window.
 *
 * The old cap was 15 minutes, on the reasoning that the site should never be
 * parked longer than a party would wait. That conflated two separate numbers.
 * How long we back off is one; what we tell the host is the other, and the cap
 * was silently deciding both. Against a 14.6-hour refusal it produced a host
 * being told "try again in about 780s", waiting thirteen minutes, coming back,
 * and being told 780s again — a countdown the app had no way to honour.
 *
 * So the honest figure is what gets stored and reported, and the 15 minutes
 * survives as COOLDOWN_PROBE_SECONDS: the TTL on the key, not the value in it.
 */
const MIN_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;
const DEFAULT_COOLDOWN_SECONDS = 60;

/**
 * How long the gate stays shut before one wave of requests is allowed upstream
 * to find out whether Spotify has relented.
 *
 * The stored `until` can be hours away, and trusting it blindly would mean one
 * bad Retry-After header locks every uncached playlist out for a day with no
 * way back except deleting the key by hand. Expiring the *key* early instead
 * costs one refused request per interval and is self-correcting: the probe's
 * own 429 carries a fresh Retry-After, which rewrites the cooldown. Cheap
 * against a daily quota, and the alternative is a foot-gun with a 24h fuse.
 */
const COOLDOWN_PROBE_SECONDS = 15 * 60;

/**
 * Above this, a countdown stops being information and becomes a promise.
 *
 * Ten minutes is roughly the point where "try again in Ns" reads as "wait,
 * then it will work" rather than "this is a blip". Past it the host gets the
 * quota message instead: same facts, no number to sit and watch.
 */
const COUNTDOWN_MAX_SECONDS = 10 * 60;

export interface LoadedPlaylist {
  name: string;
  tracks: Track[];
  totalTracks: number;
  /** True when the playlist is longer than MAX_PLAYLIST_TRACKS. */
  truncated: boolean;
}

/**
 * Which caller a load came from, named in the miss log.
 *
 * The log viewer attributes a line to whichever request the instance happened
 * to be serving, and under concurrent invocations that can be an unrelated
 * request — a miss from `POST /api/room/[code]/submit` showing up against a
 * `GET .../pool` that never touches this file. Reading the method off the log
 * row then points at a code path that cannot produce the line, which is a long
 * detour to nowhere. Carry the caller in the message so it stands on its own.
 *
 * `unknown` is the default rather than a required argument: a new caller that
 * forgets should still load, and the literal string `source=unknown` in the
 * logs is a clearer report of that omission than a compile error nobody sees
 * in production.
 */
export type PlaylistLoadSource = "playlist-api" | "room-submit" | "unknown";

type CacheEntry =
  | { kind: "hit"; name: string; tracks: Track[]; truncated: boolean }
  /**
   * `code` is what a replayed 404 is rendered from, so a cached miss is
   * readable in either language — caching a *sentence* would have frozen
   * whichever language wrote the entry into every later reader's screen for
   * the whole TTL. Optional because entries written before this field existed
   * are still live in KV; `readCache` falls back for them.
   */
  | { kind: "missing"; code?: AppErrorCode; message: string; status: number };

function cacheKey(playlistId: string): string {
  return `playlist:${CACHE_VERSION}:${playlistId}`;
}

async function readCache(playlistId: string): Promise<CacheEntry | null> {
  try {
    const store = await getKvStore();
    return await store.get<CacheEntry>(cacheKey(playlistId));
  } catch {
    return null;
  }
}

async function writeCache(
  playlistId: string,
  entry: CacheEntry,
  ttlSeconds: number
): Promise<void> {
  try {
    const store = await getKvStore();
    await store.set(cacheKey(playlistId), entry, ttlSeconds);
  } catch {
    // Swallowed: the caller already has its answer, and failing the request
    // over a cache write would turn a degraded cache into a broken game.
  }
}

async function readCooldownUntil(): Promise<number | null> {
  try {
    const store = await getKvStore();
    const entry = await store.get<{ until: number }>(COOLDOWN_KEY);
    return typeof entry?.until === "number" ? entry.until : null;
  } catch {
    return null;
  }
}

/**
 * Records that Spotify is throttling the app. Stored in KV rather than module
 * scope on purpose — unlike the token cache, this is only useful if every
 * lambda instance sees it. A per-instance cooldown would park one instance
 * while the rest carried on spending the quota it is trying to protect.
 */
async function startCooldown(retryAfterSeconds?: number): Promise<number> {
  const seconds = Math.min(
    MAX_COOLDOWN_SECONDS,
    Math.max(MIN_COOLDOWN_SECONDS, retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS)
  );
  const until = Date.now() + seconds * 1000;
  try {
    const store = await getKvStore();
    // The value is honest, the TTL is short. See COOLDOWN_PROBE_SECONDS: every
    // reader inside the window is told the real wait, and when the key expires
    // one request goes and checks rather than the site staying parked on a
    // number Spotify sent hours ago.
    await store.set(
      COOLDOWN_KEY,
      { until },
      Math.min(seconds, COOLDOWN_PROBE_SECONDS)
    );
  } catch {
    // Best effort. Losing the cooldown costs us the coordinated backoff, not
    // correctness — each request still fails on its own 429.
  }
  return seconds;
}

function globalLoadLimit(): number {
  const configured = Number(process.env.SPOTIFY_MAX_LOADS_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GLOBAL_LOAD_LIMIT;
}

/**
 * Claims one slot in the current minute's global budget. Returns false when
 * the window is spent.
 *
 * Fails *open* on a KV error: the budget is a safety net, and losing the net
 * has to mean "back to how it was", not "nobody can load a playlist". The
 * cooldown still catches the resulting 429 if we overshoot.
 */
async function claimGlobalBudget(): Promise<boolean> {
  try {
    const store = await getKvStore();
    const used = await store.incr(BUDGET_KEY, GLOBAL_LOAD_WINDOW_SECONDS);
    return used <= globalLoadLimit();
  } catch {
    return true;
  }
}

function dailyLoadLimit(): number {
  const configured = Number(process.env.SPOTIFY_MAX_LOADS_PER_DAY);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_DAILY_LOAD_LIMIT;
}

/** The window, newest hour first, as keys under `prefix`. */
function windowKeys(prefix: string, now: Date): string[] {
  return Array.from({ length: DAILY_WINDOW_HOURS }, (_, i) =>
    `${prefix}:${hourBucket(new Date(now.getTime() - i * 60 * 60 * 1000))}`
  );
}

function sum(counts: Array<number | null>): number {
  return counts.reduce<number>(
    (total, n) => total + (typeof n === "number" && Number.isFinite(n) ? n : 0),
    0
  );
}

/**
 * How long until the oldest hour in the window rolls out and its share of the
 * budget comes back. Reported as a header, never rendered as a countdown —
 * `spotify_daily_budget_spent` carries no `{seconds}`, for the reason
 * lib/error-messages.ts gives.
 */
function secondsToNextHour(now: Date): number {
  return Math.ceil((3600000 - (now.getTime() % 3600000)) / 1000);
}

/**
 * Claims one load against the rolling 24h budget. Returns false when the
 * window is spent.
 *
 * Read-then-increment rather than the increment-then-compare `claimGlobalBudget`
 * uses, and the asymmetry is deliberate in both directions. A minute counter
 * that counts its own refusals is self-healing — the window is gone in sixty
 * seconds. A 24h one is not: refusals would inflate the very sum that caused
 * them and hold the gate shut for a day, so only loads that are actually going
 * upstream may touch it. The cost is that the check is not atomic against
 * itself, so a burst can overshoot by however many requests are in flight at
 * once — which the per-minute gate has already capped at `globalLoadLimit()`,
 * a rounding error against a limit in the thousands.
 *
 * Fails *open*, like every other gate in this file: losing the safety net has
 * to mean "back to how it was", not "nobody can play".
 */
async function claimDailyBudget(now: Date): Promise<boolean> {
  try {
    const store = await getKvStore();
    const used = sum(await store.mget<number>(windowKeys(HOUR_BUDGET_PREFIX, now)));
    if (used >= dailyLoadLimit()) {
      // Counted, not logged per request: a spent window refuses every uncached
      // load for as long as it lasts, and a log line each would be the noisiest
      // output in the app on the day it is least useful to read.
      const frees = secondsToNextHour(now);
      await store.incr(
        `${HOUR_REFUSED_PREFIX}:${hourBucket(now)}`,
        HOUR_BUCKET_TTL_SECONDS
      );
      await store.set(DAILY_SPENT_KEY, { until: now.getTime() + frees * 1000 }, frees);
      return false;
    }
    await store.incr(
      `${HOUR_BUDGET_PREFIX}:${hourBucket(now)}`,
      HOUR_BUCKET_TTL_SECONDS
    );
    return true;
  } catch {
    return true;
  }
}

/**
 * The rolling window as `npm run stats` reads it: the totals, and the shape
 * of the day that produced them.
 *
 * `byHour` is oldest first. It answers the question the limit has to be tuned
 * against and that nothing else in this repo can — not "how many loads did we
 * spend" (`playlist:stats:*:miss` has that) but *when*, and therefore whether
 * a cap is starving the evening to feed the afternoon.
 */
export async function getDailyBudgetStatus(now: Date = new Date()): Promise<{
  used: number;
  refused: number;
  limit: number;
  byHour: Array<{ hour: string; used: number; refused: number }>;
}> {
  const store = await getKvStore();
  const usedKeys = windowKeys(HOUR_BUDGET_PREFIX, now);
  const refusedKeys = windowKeys(HOUR_REFUSED_PREFIX, now);
  const [used, refused] = await Promise.all([
    store.mget<number>(usedKeys),
    store.mget<number>(refusedKeys),
  ]);
  const byHour = usedKeys
    .map((key, i) => ({
      hour: key.slice(HOUR_BUDGET_PREFIX.length + 1),
      used: sum([used[i]]),
      refused: sum([refused[i]]),
    }))
    .reverse();
  return { used: sum(used), refused: sum(refused), limit: dailyLoadLimit(), byHour };
}

/**
 * Hit/miss counters, bucketed by day and held for a week.
 *
 * Without these, "did the cache work" can only be answered by watching for the
 * absence of 429s, which is indistinguishable from a quiet evening. The rate
 * is logged on every miss rather than on every load: misses are the rare case
 * once the cache is doing its job, so the instrumentation gets quieter exactly
 * as things get healthier, and a sudden run of lines is itself the signal.
 */
function statsKey(kind: "hit" | "miss" | "negative"): string {
  return `playlist:stats:${dayBucket()}:${kind}`;
}

const STATS_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `negative` counts the subset of hits that replayed a cached 404. Those are
 * real hits — the question was answered without touching Spotify, which is all
 * `rate` claims to measure — but they are the one kind a *broken* input
 * produces on repeat. A host retrying a playlist they made private pushes the
 * rate up, so counting them silently makes the healthiest-looking number and
 * one of the unhealthiest situations read identically. Kept inside `hits` so
 * the rate keeps its meaning, and reported alongside so it can be subtracted.
 */
async function recordHit(negative = false): Promise<void> {
  try {
    const store = await getKvStore();
    await store.incr(statsKey("hit"), STATS_TTL_SECONDS);
    if (negative) await store.incr(statsKey("negative"), STATS_TTL_SECONDS);
  } catch {
    // Instrumentation must never be able to fail a request.
  }
}

/**
 * `misses=` is the running day total and is free — it is what `incr` returns.
 * The line used to carry `hits=`, `negative=` and a cumulative `rate=` as well,
 * which cost two extra KV reads on every miss to compose a sentence for a log
 * nobody tails. `getCacheStats` answers the cumulative question on demand, for
 * the caller that actually asks it (`npm run stats`), which is where this
 * project has decided numbers are read.
 */
async function recordMiss(
  playlistId: string,
  source: PlaylistLoadSource
): Promise<void> {
  try {
    const store = await getKvStore();
    const misses = await store.incr(statsKey("miss"), STATS_TTL_SECONDS);
    console.log(
      `[playlist-cache] miss id=${playlistId} source=${source} misses=${misses}`
    );
  } catch {
    // Instrumentation must never be able to fail a request.
  }
}

/**
 * Today's counters, for anything that wants to read the rate back. The day
 * bucket is UTC, so a rate read shortly after 00:00 UTC is measuring a handful
 * of loads — every playlist's first load of the day is a miss by definition.
 */
export async function getCacheStats(): Promise<{
  hits: number;
  misses: number;
  /** Hits that replayed a cached 404, already included in `hits`. */
  negativeHits: number;
  hitRate: number;
}> {
  const store = await getKvStore();
  const hits = (await store.get<number>(statsKey("hit"))) ?? 0;
  const misses = (await store.get<number>(statsKey("miss"))) ?? 0;
  const negativeHits = (await store.get<number>(statsKey("negative"))) ?? 0;
  const total = hits + misses;
  return { hits, misses, negativeHits, hitRate: total > 0 ? hits / total : 0 };
}

/**
 * The same fact, phrased for the wait the host is actually facing.
 *
 * A short cooldown is a blip and a countdown is the useful thing to say. A
 * long one is the app's daily Spotify quota being gone, where a countdown is
 * worse than no number at all — it invites the host to wait it out and press
 * Start again into the same refusal. `retryAfterSeconds` stays honest in both
 * cases; it is a header, not a sentence.
 */
function cooldownError(secondsRemaining: number): SpotifyApiError {
  if (secondsRemaining > COUNTDOWN_MAX_SECONDS) {
    return new SpotifyApiError("spotify_quota_exhausted", 429, {
      retryAfterSeconds: secondsRemaining,
    });
  }

  return new SpotifyApiError("spotify_cooldown", 429, {
    retryAfterSeconds: secondsRemaining,
    params: { seconds: secondsRemaining },
  });
}

/**
 * The cooldown as a fact a *page* can render, rather than an error a request
 * had to hit to find out.
 *
 * Read-only, and deliberately outside the admission path: it claims no budget,
 * records no miss and never goes upstream, so asking "is Spotify refusing us
 * right now?" costs one KV read. That is what lets the site notice be live
 * instead of a banner somebody has to remember to take down — the same key
 * that parks the loads clears the notice when it expires.
 *
 * The code comes from `cooldownError`, not from a second threshold written
 * here. A notice that said "throttled, back in ten minutes" while the host's
 * own Start button said "the daily quota is gone" would be worse than no
 * notice: two numbers for one fact, and the reader has to guess which is
 * lying. One function decides, both surfaces read it.
 */
export type { SpotifyServiceStatus };

const OPEN_STATUS: SpotifyServiceStatus = {
  throttled: false,
  code: null,
  retryAfterSeconds: 0,
};

export async function getSpotifyServiceStatus(): Promise<SpotifyServiceStatus> {
  // Both gates in one command, because there are two ways for the playlist
  // path to be shut and a notice that knew about only one would be confidently
  // wrong on the days the other fires — which, at a limit tuned just under a
  // normal day, is not the rare case.
  //
  // Fail-open is the only defensible answer here, for the same reason
  // lib/rate-limit.ts fails open: a KV outage must not put a "we are broken"
  // banner on a site that is, as far as anyone can tell, fine.
  let cooldown: { until: number } | null = null;
  let spent: { until: number } | null = null;
  try {
    const store = await getKvStore();
    [cooldown, spent] = await store.mget<{ until: number }>([
      COOLDOWN_KEY,
      DAILY_SPENT_KEY,
    ]);
  } catch {
    return OPEN_STATUS;
  }

  const remainingOf = (entry: { until: number } | null): number =>
    typeof entry?.until === "number" ? Math.ceil((entry.until - Date.now()) / 1000) : 0;

  // Spotify's own refusal outranks ours. When both are live the host is facing
  // the longer wait, and it is the one they can do nothing about.
  const cooling = remainingOf(cooldown);
  if (cooling > 0) {
    return {
      throttled: true,
      code: cooldownError(cooling).code,
      retryAfterSeconds: cooling,
    };
  }

  const rationed = remainingOf(spent);
  if (rationed > 0) {
    return {
      throttled: true,
      code: "spotify_daily_budget_spent",
      retryAfterSeconds: rationed,
    };
  }

  return OPEN_STATUS;
}

/**
 * Coalesces concurrent loads of the same playlist within one lambda instance.
 *
 * Mixed Playlist Mode fires one request per contributor from a single click,
 * and a QR room gets a burst of submits as everyone scans at once. Duplicated
 * URLs in either of those used to mean duplicated pagination, because the KV
 * write only lands after the first fetch finishes — too late for its own
 * siblings. Per-instance rather than distributed: a cross-instance lock would
 * need a primitive lib/kv.ts doesn't have, for a shrinking share of the win
 * now that results are cached.
 */
const inFlight = new Map<string, Promise<LoadedPlaylist>>();

function toLoaded(entry: Extract<CacheEntry, { kind: "hit" }>): LoadedPlaylist {
  return {
    name: entry.name,
    tracks: entry.tracks,
    totalTracks: entry.tracks.length,
    truncated: entry.truncated,
  };
}

async function fetchAndCache(
  playlistId: string,
  playlistUrl: string,
  source: PlaylistLoadSource
): Promise<LoadedPlaylist> {
  const cooldownUntil = await readCooldownUntil();
  if (cooldownUntil && Date.now() < cooldownUntil) {
    throw cooldownError(Math.ceil((cooldownUntil - Date.now()) / 1000));
  }

  if (!(await claimGlobalBudget())) {
    throw new SpotifyApiError("spotify_busy", 429, {
      retryAfterSeconds: GLOBAL_LOAD_WINDOW_SECONDS,
    });
  }

  // After the per-minute gate, never before it. A load refused for bursting
  // has not gone upstream, so it must not spend a slot in the 24h window that
  // takes a day to give one back; a load refused here has spent a minute slot
  // instead, which is back in sixty seconds.
  const now = new Date();
  if (!(await claimDailyBudget(now))) {
    throw new SpotifyApiError("spotify_daily_budget_spent", 429, {
      retryAfterSeconds: secondsToNextHour(now),
    });
  }

  await recordMiss(playlistId, source);

  try {
    const { playlist, tracks, truncated } = await getPlaylistWithTracks(playlistUrl);

    // rawJson is the entire Spotify track object and nothing reads it — every
    // consumer runs it through stripTrackForStorage before use. Dropping it
    // here keeps cache entries (and the /api/playlist response body) roughly
    // an order of magnitude smaller.
    const stripped = tracks.map(stripTrackForStorage);

    if (stripped.length > 0) {
      await writeCache(
        playlistId,
        { kind: "hit", name: playlist.name, tracks: stripped, truncated },
        truncated ? SAMPLED_TTL_SECONDS : HIT_TTL_SECONDS
      );
    }

    return {
      name: playlist.name,
      tracks: stripped,
      totalTracks: stripped.length,
      truncated,
    };
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 429) {
      const seconds = await startCooldown(err.retryAfterSeconds);
      throw cooldownError(seconds);
    }

    // Only 404 is cached. A 429 is transient by definition and a 5xx is
    // Spotify's problem, not this playlist's — caching either would make a
    // blip look like a broken playlist for as long as the entry lived.
    if (err instanceof SpotifyApiError && err.status === 404) {
      await writeCache(
        playlistId,
        { kind: "missing", code: err.code, message: err.message, status: 404 },
        NOT_FOUND_TTL_SECONDS
      );
    }

    throw err;
  }
}

/**
 * Load a playlist's tracks, going upstream only when it isn't already known.
 *
 * Drop-in replacement for calling getPlaylistWithTracks directly — every
 * caller should use this instead, since a single uncached path is enough to
 * put the shared quota back at risk.
 */
export async function loadPlaylist(
  playlistUrl: string,
  source: PlaylistLoadSource = "unknown"
): Promise<LoadedPlaylist> {
  const playlistId = parsePlaylistUrl(playlistUrl);
  if (!playlistId) {
    throw new SpotifyApiError("invalid_playlist_url", 400);
  }

  // Checked here as well as inside getPlaylistWithTracks so it stays true
  // during a cooldown: an editorial playlist is permanently unsupported, and
  // telling that host "we're rate limited, try again in 60s" would send them
  // back to a URL that is never going to work.
  if (isSpotifyEditorial(playlistId)) {
    throw new SpotifyApiError("playlist_editorial", 404);
  }

  const cached = await readCache(playlistId);
  if (cached?.kind === "hit") {
    await recordHit();
    return toLoaded(cached);
  }
  if (cached?.kind === "missing") {
    // A cached 404 is a cache hit too — it is a question answered without
    // touching Spotify, which is the only thing the rate measures. Counted
    // separately as well, so a spammed dead link can't quietly inflate it.
    await recordHit(true);
    // Entries written before `code` existed carry only a message, and the only
    // thing cached here is a 404, so that is what they replay as.
    throw new SpotifyApiError(cached.code ?? "playlist_not_found", cached.status, {
      detail: cached.code ? undefined : cached.message,
    });
  }

  const existing = inFlight.get(playlistId);
  if (existing) return existing;

  // The source recorded is the one that *started* the fetch — a coalesced
  // sibling joins a load already in progress and never reaches recordMiss,
  // which is correct: the line describes the upstream call, not the request.
  const pending = fetchAndCache(playlistId, playlistUrl, source);
  inFlight.set(playlistId, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(playlistId);
  }
}

/** Test seam: the in-flight map is module state that outlives a single test. */
export function __resetInFlightForTests(): void {
  inFlight.clear();
}
