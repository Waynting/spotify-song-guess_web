/**
 * Cache and admission control in front of the 30s preview lookups.
 *
 * Spotify stopped populating `preview_url` in Nov 2024 and now returns null for
 * every track on Client Credentials (measured 0/20 across four markets), so
 * every clip a round plays is resolved from iTunes, then Deezer. Both throttle per
 * IP, and a serverless deploy's egress IPs are shared across the whole user
 * base — from iTunes' side the entire site is one very noisy client.
 *
 * This is the same shape of problem lib/playlist-cache.ts solves for Spotify,
 * with the numbers an order of magnitude worse. Spotify is called once per
 * *playlist*; these are called once per *track*, and a cold 50-song game is 50
 * lookups of up to 5 upstream calls each. Per-IP limiting (lib/rate-limit.ts)
 * does nothing about it: every new visitor gets a fresh allowance while the
 * egress IP they all share does not.
 *
 *   getPreview ─→ KV cache ─┬─ hit ────────→ return (zero upstream calls)
 *                           │ miss
 *                           ├─ budget ── spent ──→ unavailable, no upstream
 *                           │ claimed
 *                           └─ per-source cooldown ─→ iTunes ×1-2 ─→ Deezer ×1-3
 *
 * (the title-only query on each source only runs when there is an artist to
 *  verify the answer against — see "Why the title-only queries verify" below)
 *
 * ## Three outcomes, not two
 *
 * The bug this module was extracted to fix: the old route mapped every failure
 * onto `previewUrl: null` and cached it for a week. A 403 from a throttled
 * iTunes, a dropped connection, a 500 — all of them were written down as the
 * fact "this song has no preview anywhere". One throttled minute at peak
 * therefore marked a slice of the catalogue silent for seven days, and it never
 * reproduced locally, because a laptop's own IP is never the one being
 * throttled.
 *
 *   found        a URL. Cached ~forever; recordings do not change.
 *   absent       upstream answered, and it genuinely has no preview. Cached a
 *                week, so a track that gains one later isn't written off.
 *   unavailable  we could not ask. Cached ninety seconds — long enough to stop
 *                a round's worth of retries stampeding, short enough that it is
 *                never mistaken for an answer.
 *
 * Only a clean, complete reply from upstream may produce `absent`. Everything
 * else is `unavailable`. That asymmetry is the whole point: a wrong `absent`
 * lasts a week and is invisible, a wrong `unavailable` costs one retry.
 *
 * ## Why the title-only queries verify the artist and the others do not
 *
 * Each source is asked progressively looser questions, and the last one drops
 * the artist entirely. That query gets ranked by popularity alone, so its top
 * hit is just the best-known song with that title: iTunes answers "Hello" with
 * Pinkfong's nursery rhyme, "Alone" with Heart's 1987 single. Taking one is
 * worse than reporting no audio — it is cached as `found` for a year, refresh
 * only repairs rotted URLs and never re-picks, and at the table the clip plays
 * and then the answer card contradicts it.
 *
 * So the title-only queries require a verified artist and otherwise hand over
 * to the next source. The queries that *did* carry the artist upstream do not,
 * and must not: iTunes returns 小幸運 as "A Little Happiness" by "Hebe Tien"
 * where Spotify says 田馥甄, so a string check applied there would make CJK
 * tracks unplayable across the board. Upstream's own ranking is the artist
 * signal on those; artistMatches is only ever a veto where there was none.
 *
 * ## Why the cache key is not versioned
 *
 * The stored record is a strict superset of the `{previewUrl}` shape that
 * shipped before it, and the key is deliberately unchanged. Bumping a version
 * the way lib/playlist-cache.ts does would cold-start every entry in production
 * simultaneously — precisely the upstream burst this file exists to prevent.
 * Legacy entries read fine; they just carry no source or track ids until the
 * next time they're written.
 */

import { dayBucket, getKvStore, type KvStore } from "@/lib/kv";
import type { PreviewResult, PreviewStatus } from "@/types/preview";

export type { PreviewResult, PreviewStatus };

export type PreviewSource = "itunes" | "deezer";

export interface PreviewQuery {
  /** Spotify track id. Keys the cache when present. */
  id: string;
  track: string;
  artist: string;
  /**
   * Spotify's running time for this track, when the caller knows it. Used only
   * to choose between upstream candidates — it is not part of the cache key,
   * so adding it cold-starts nothing.
   */
  durationMs?: number;
}

/**
 * What lands in KV. Every field beyond `previewUrl` is optional because
 * entries written by the pre-Phase-1 route are still live and must keep
 * reading as valid hits — see the header.
 */
interface PreviewRecord {
  previewUrl: string | null;
  source?: PreviewSource;
  /**
   * Lets a rotted URL be re-resolved with a single `lookup?id=` call instead of
   * the full five-call search fan-out. This is what makes a year-long positive
   * TTL safe: preview URLs sit on a CDN that rotates them, so the entry has to
   * be repairable on demand rather than merely expiring eventually.
   */
  itunesTrackId?: number;
  deezerTrackId?: number;
  /**
   * `false` marks a null that means "we could not ask". Absent on legacy
   * entries, which are therefore read as confirmed — deliberately. Re-resolving
   * every legacy negative at once to purge the poisoned ones would be the same
   * thundering herd that poisoned them; they age out within a week on their
   * own, and nothing new joins them.
   */
  confirmed?: boolean;
  /**
   * With a year-long TTL, an entry with no timestamp is undebuggable: a URL
   * resolved yesterday and one resolved last spring look identical, and "how
   * old are the URLs that stopped playing" is the first question worth asking
   * when they start rotting.
   */
  resolvedAt?: number;
}

/**
 * NOTE: entries written before the artist/duration picker shipped are still
 * served as hits, so this release's fix reaches only tracks nobody has played
 * yet. Upgrading them needs a picker-generation stamp on the record — which was
 * built here and then backed out, because the mechanism has to answer three
 * things this file makes hard, and getting any of them wrong is worse than the
 * stale pick it repairs:
 *
 *   - a re-pick must NOT take the `lookup?id=` shortcut in resolveAndStore, or
 *     it re-confirms the very recording under suspicion and stamps it current;
 *   - re-picks must have their own admission budget, or one warm 25-track game
 *     spends a fifth of PREVIEW_MAX_LOOKUPS_PER_MINUTE re-resolving clips that
 *     already play, and every game does this on deploy day;
 *   - it must converge under throttling. Keeping the old URL without stamping
 *     it means the next request tries again, forever, and the retries are what
 *     sustain the throttling.
 *
 * See CHANGELOG 1.2.0 "Known gaps".
 */

/** Recordings don't change. URL rot is handled by refresh, not by expiry. */
const FOUND_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Shorter, so a track that gains a preview later isn't written off forever. */
const ABSENT_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * Long enough to absorb one round's retries, and past the global budget window
 * below so a retry lands in a fresh minute rather than re-losing the same one.
 * Short enough that nobody plays a whole game against a stale refusal.
 */
const UNAVAILABLE_TTL_SECONDS = 90;

/**
 * Ceiling on ONE upstream call, so a hung socket cannot stall a request
 * indefinitely.
 *
 * It does not bound a whole resolution: five sequential calls at this timeout
 * is 12.5s against BATCH_DEADLINE_MS's 6s, and that deadline only gates when a
 * resolution *starts*. Clipping a track's work to the batch's remaining time
 * needs the deadline threaded into askUpstream, which this does not do.
 */
const UPSTREAM_TIMEOUT_MS = 2500;

/**
 * Proactive ceiling on how many *lookups* the whole site sends upstream per
 * minute, shared across lambda instances via KV's atomic incr. The direct
 * counterpart of SPOTIFY_MAX_LOADS_PER_MINUTE, and it exists for the same
 * reason: the cooldown below is reactive and only helps once iTunes has already
 * refused something.
 *
 * In lookups, not requests — a found track costs one upstream call, one with no
 * preview anywhere costs five. Apple documents roughly 20 calls a minute and in
 * practice allows a good deal more, so the default sits between the two: a
 * couple of simultaneous cold games get through, a scripted client or a spike
 * does not. Env-overridable because the real ceiling is a property of the
 * deploy's egress IPs, which the code cannot find out.
 */
const LOOKUP_WINDOW_SECONDS = 60;
const DEFAULT_MAX_LOOKUPS_PER_MINUTE = 120;
const BUDGET_KEY = "preview:budget";

/** Same clamps, and the same reasoning, as lib/playlist-cache.ts's cooldown. */
const MIN_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 15 * 60;
const DEFAULT_COOLDOWN_SECONDS = 60;

const STATS_TTL_SECONDS = 7 * 24 * 60 * 60;

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/**
 * Track id is the stable identity — the same recording appears under varying
 * name/artist strings across playlists (feat. credits, remaster tags, casing),
 * which would fragment a string-keyed cache. Falls back to a normalised query
 * key so callers without an id still get caching.
 */
export function previewCacheKey(id: string, track: string, artist: string): string {
  if (id) return `preview:id:${id}`;
  // Normalise each part before joining, not the joined string: Spotify track
  // names carry stray leading/trailing whitespace, and trimming only the ends
  // of "track|artist" would leave " song |artist" as a distinct key from
  // "song|artist" — quietly fragmenting the cache for the same recording.
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return `preview:q:${normalize(track)}|${normalize(artist)}`;
}

function cooldownKey(source: PreviewSource): string {
  return `preview:cooldown:${source}`;
}

function statsKey(kind: "hit" | "miss" | "unavailable"): string {
  return `preview:stats:${dayBucket()}:${kind}`;
}

/* ------------------------------------------------------------------ */
/* KV access — every call wrapped, a cache outage means slower not broken */
/* ------------------------------------------------------------------ */

async function store(): Promise<KvStore> {
  return getKvStore();
}

async function readRecords(keys: string[]): Promise<Array<PreviewRecord | null>> {
  try {
    return await (await store()).mget<PreviewRecord>(keys);
  } catch {
    return keys.map(() => null);
  }
}

function ttlFor(status: PreviewStatus): number {
  if (status === "found") return FOUND_TTL_SECONDS;
  return status === "absent" ? ABSENT_TTL_SECONDS : UNAVAILABLE_TTL_SECONDS;
}

async function writeRecord(key: string, record: PreviewRecord, status: PreviewStatus): Promise<void> {
  try {
    await (await store()).set(key, record, ttlFor(status));
  } catch {
    // Swallowed deliberately. An unhandled write failure would turn a request
    // that already has its answer into a 500 and stall the game mid-round.
  }
}

function recordToResult(record: PreviewRecord): PreviewResult {
  if (record.previewUrl) return { previewUrl: record.previewUrl, status: "found" };
  // `confirmed === false` is the only thing that means "we couldn't ask".
  // Legacy entries have no field at all and are read as confirmed.
  return { previewUrl: null, status: record.confirmed === false ? "unavailable" : "absent" };
}

/* ------------------------------------------------------------------ */
/* Admission control                                                   */
/* ------------------------------------------------------------------ */

function lookupLimit(): number {
  const configured = Number(process.env.PREVIEW_MAX_LOOKUPS_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_LOOKUPS_PER_MINUTE;
}

/**
 * Claims `count` slots in the current minute's global budget. All-or-nothing,
 * so a batch either gets its whole fan-out or defers cleanly rather than
 * stopping halfway through a game.
 *
 * Fails *open* on a KV error, exactly like lib/playlist-cache.ts: losing the
 * safety net has to mean "back to how it was", not "nobody hears any music".
 */
async function claimLookupBudget(count = 1): Promise<boolean> {
  if (count <= 0) return true;
  try {
    const used = await (await store()).incr(BUDGET_KEY, LOOKUP_WINDOW_SECONDS, count);
    return used <= lookupLimit();
  } catch {
    return true;
  }
}

/**
 * The cooldown is asked about once per source *per track*, so a cold 25-song
 * batch spent up to 50 KV reads discovering the same two answers — more
 * commands than the writes the batch actually performs, on the one quota this
 * app pays for. It is a coarse, site-wide, minute-scale signal being polled at
 * per-track resolution.
 *
 * Two memos, with different lifetimes, because the two answers are not equally
 * safe to hold:
 *
 * - **"cooling until T"** is trusted until T with no re-read at all. A cooldown
 *   is only ever *started*, never cancelled early, so the worst a stale one
 *   costs is skipping a source slightly longer than KV would have said — and
 *   the whole point of the cooldown is to not ask.
 * - **"not cooling"** is held for `COOLDOWN_MEMO_MS` only, because it is the
 *   answer that spends upstream calls. That window is the one thing this trades
 *   away: a cooldown another instance starts is invisible here for up to that
 *   long. It is deliberately far below `MIN_COOLDOWN_SECONDS`, so a cooldown is
 *   never missed entirely — only joined late.
 *
 * Within one instance there is no delay at all: `startCooldown` primes the memo
 * on the way past, so the request that discovers a 403 parks the source for
 * every later track in the same batch without a round trip.
 */
const COOLDOWN_MEMO_MS = 5000;

interface CooldownMemo {
  /** Epoch ms the source is parked until. 0 when it is not parked. */
  until: number;
  /** When this was learned, for ageing out the "not cooling" answer. */
  readAt: number;
}

const cooldownMemo = new Map<PreviewSource, CooldownMemo>();

/**
 * A batch resolves several tracks at once, so without this every worker in the
 * first wave asks KV before any of them has an answer to memoize — the memo
 * only starts paying from the *second* wave, and a batch smaller than
 * `BATCH_CONCURRENCY` never benefits at all. Same shape, and the same reason,
 * as lib/playlist-cache.ts's in-flight map.
 */
const cooldownInFlight = new Map<PreviewSource, Promise<CooldownMemo>>();

function readCooldown(source: PreviewSource): Promise<CooldownMemo> {
  const existing = cooldownInFlight.get(source);
  if (existing) return existing;

  const pending = (async () => {
    const entry = await (await store()).get<{ until: number }>(cooldownKey(source));
    const memo: CooldownMemo = {
      until: typeof entry?.until === "number" ? entry.until : 0,
      readAt: Date.now(),
    };
    cooldownMemo.set(source, memo);
    return memo;
  })();
  // Cleared on rejection too, so one failed read does not park the source's
  // lookups behind a permanently broken promise. Every caller — including this
  // one — gets the tracked promise rather than the raw one, so a rejection is
  // never left unhandled on a branch nobody awaited.
  const tracked = pending.finally(() => cooldownInFlight.delete(source));
  cooldownInFlight.set(source, tracked);
  return tracked;
}

async function isCoolingDown(source: PreviewSource): Promise<boolean> {
  const now = Date.now();
  const memo = cooldownMemo.get(source);
  if (memo) {
    if (now < memo.until) return true;
    if (now - memo.readAt < COOLDOWN_MEMO_MS) return false;
  }
  try {
    const fresh = await readCooldown(source);
    return Date.now() < fresh.until;
  } catch {
    // Not memoized: a KV failure is not an answer about the source, and
    // remembering it as "not cooling" would suppress the next real read.
    return false;
  }
}

/**
 * Parks one source after it has explicitly refused us.
 *
 * In KV rather than module scope, for lib/playlist-cache.ts's reason: a
 * per-instance cooldown would sit out one lambda while the rest carried on
 * spending the allowance it is trying to protect.
 */
async function startCooldown(source: PreviewSource, retryAfterSeconds?: number): Promise<void> {
  const seconds = Math.min(
    MAX_COOLDOWN_SECONDS,
    Math.max(MIN_COOLDOWN_SECONDS, retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS)
  );
  const until = Date.now() + seconds * 1000;
  // Primed before the write, and kept even if the write throws: this instance
  // has just been refused by this source, which is reason enough to stop asking
  // regardless of whether the rest of the fleet can be told about it.
  cooldownMemo.set(source, { until, readAt: Date.now() });
  try {
    await (await store()).set(cooldownKey(source), { until }, seconds);
    console.warn(`[preview-cache] ${source} throttled us; pausing it for ${seconds}s`);
  } catch {
    // Best effort — losing the coordinated backoff costs us the shared signal,
    // not correctness. Each request still fails on its own.
  }
}

/**
 * Test seam. The memo is module state that outlives a single test, and a
 * cooldown left primed by one case would silently skip the source in the next.
 */
export function __resetPreviewMemoForTests(): void {
  cooldownMemo.clear();
  cooldownInFlight.clear();
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

interface Outcomes {
  hits: number;
  misses: number;
  /** Misses that could not be answered. Not a subset of `misses`. */
  unavailable: number;
}

/**
 * Bucketed by UTC day and held a week, mirroring lib/playlist-cache.ts.
 *
 * Logged on misses only: once the cache is doing its job misses are the rare
 * case, so the instrumentation goes quiet exactly as things get healthier and a
 * sudden run of lines is itself the signal. `unavailable=` is the one to watch
 * — it rising while `misses` stays flat is throttling, and it is the number
 * that used to be silently recorded as a catalogue gap instead.
 *
 * **The line reports this call, not the running day totals.** It used to read
 * `hit` and `unavailable` back out of KV so it could print a cumulative rate,
 * which cost two extra commands on every miss — the path that is by definition
 * already spending the most — to compose a sentence for a log nobody tails.
 * `getPreviewCacheStats` still answers the cumulative question, on demand, for
 * the one caller that actually asks it (`npm run stats`). What a log line is
 * good for is the shape of a single request, and that needs no read at all.
 */
async function recordOutcomes(counts: Outcomes): Promise<void> {
  try {
    const kv = await store();
    if (counts.hits > 0) await kv.incr(statsKey("hit"), STATS_TTL_SECONDS, counts.hits);
    if (counts.unavailable > 0) {
      await kv.incr(statsKey("unavailable"), STATS_TTL_SECONDS, counts.unavailable);
    }
    if (counts.misses <= 0) return;

    await kv.incr(statsKey("miss"), STATS_TTL_SECONDS, counts.misses);
    console.log(
      `[preview-cache] miss hits=${counts.hits} misses=${counts.misses} unavailable=${counts.unavailable}`
    );
  } catch {
    // Instrumentation must never be able to fail a request.
  }
}

/**
 * Today's counters. The day bucket is UTC, so a read shortly after 00:00 UTC is
 * measuring almost nothing — every track's first lookup of the day is a miss.
 */
export async function getPreviewCacheStats(): Promise<
  Outcomes & { hitRate: number }
> {
  const kv = await store();
  const hits = (await kv.get<number>(statsKey("hit"))) ?? 0;
  const misses = (await kv.get<number>(statsKey("miss"))) ?? 0;
  const unavailable = (await kv.get<number>(statsKey("unavailable"))) ?? 0;
  const total = hits + misses;
  return { hits, misses, unavailable, hitRate: total > 0 ? hits / total : 0 };
}

/* ------------------------------------------------------------------ */
/* Upstream                                                            */
/* ------------------------------------------------------------------ */

type SourceOutcome =
  | { kind: "found"; previewUrl: string; trackId?: number }
  /** Upstream answered, and it has nothing. The only path to a cached `absent`. */
  | { kind: "empty" }
  | {
      kind: "unavailable";
      /**
       * True only when upstream explicitly refused (403/429, or Deezer's quota
       * error body). A dropped connection is unavailable too, but must not park
       * the source for everyone — one flaky socket is not a rate limit.
       */
      throttled: boolean;
      retryAfterSeconds?: number;
    };

function retryAfterFrom(res: { headers: Headers }): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Maps a response's status onto an outcome, before any body parsing.
 *
 * Note that iTunes signals throttling with **403**, not 429. Reading only 429
 * is the same mistake as reading only the happy path: the refusal arrives, gets
 * classified as "no result", and becomes a fact about the song.
 */
function statusOutcome(res: { ok: boolean; status: number; headers: Headers }): SourceOutcome | null {
  if (res.status === 403 || res.status === 429) {
    return { kind: "unavailable", throttled: true, retryAfterSeconds: retryAfterFrom(res) };
  }
  // Any other non-OK is "we could not ask" as well. Nothing upstream can say
  // with a 5xx, or a 400 we didn't expect, is evidence about the recording.
  if (!res.ok) return { kind: "unavailable", throttled: false };
  return null;
}

/**
 * The subset of an upstream result this module actually decides on. iTunes and
 * Deezer disagree about field names and nesting, but the picking rules are the
 * same for both, so each is mapped onto this before any of them apply.
 */
interface Candidate {
  previewUrl?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  /** Normalised to milliseconds: iTunes reports `trackTimeMillis`, Deezer whole seconds. */
  durationMs?: number;
}

/**
 * How close two running times must be to be the same recording.
 *
 * Measured against live data: the true match agrees with Spotify to within a
 * millisecond or two, because both carry the same mastered length. The window
 * is wider than that only to absorb Deezer, which reports whole seconds.
 *
 * Still wide enough to admit a *different* song by the same artist — 小幸運 and
 * Hebe Tien's Forever Love are 768ms apart — so duration ranks candidates
 * rather than selecting one, and the closest wins.
 */
const DURATION_TOLERANCE_MS = 2000;

/** Everything a pick is decided on. Never the track id — that keys the cache, not the search. */
type QueryTarget = Pick<PreviewQuery, "track" | "artist" | "durationMs">;

/** One attempt against one source. `requireVerified` is passed through to pickCandidate. */
interface SourceQuery {
  q: string;
  requireVerified?: boolean;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * How both platforms bill a collaboration. Splitting on these is what tells a
 * guest credit apart from a longer name that merely contains the one asked for:
 * "Marshmello & Noah Cyrus" names Marshmello, "Hello Adele Tribute" does not
 * name Adele. Alphabetic separators need whole-word boundaries, or "Charli XCX"
 * splits on its own x.
 */
const CREDIT_SEPARATOR = /\s*(?:[&,/+;×·]|\b(?:feat|ft|featuring|with|vs|versus|and|x)\b\.?)\s*/i;

/**
 * The acts one credit string names, normalised.
 *
 * A leading "the" comes off because the two platforms disagree about it —
 * iTunes bills "The Beatles" where Spotify says "Beatles" — and that disagreement
 * used to be absorbed by the containment this replaces.
 */
function creditParts(value: string): string[] {
  const parts = value
    // Collapsed first, and not only for tidiness: CREDIT_SEPARATOR is `\s*…\s*`
    // around a group that cannot match a space, so a run of n spaces makes the
    // engine restart at every offset — O(n²). The routes clamp the input too;
    // this makes the function safe on its own terms.
    .replace(/\s+/g, " ")
    .split(CREDIT_SEPARATOR)
    .map((part) => normalizeName(part).replace(/^the /, ""))
    .filter(Boolean);
  return parts.length > 0 ? parts : [normalizeName(value)].filter(Boolean);
}

/**
 * Whether two credit strings name the same act.
 *
 * Loose in one direction on purpose: iTunes credits "Marshmello & Noah Cyrus"
 * where Spotify's first artist is just "Marshmello", so one credit naming every
 * act the other does counts. It compares the acts rather than the raw strings,
 * because plain containment also let "Hello Adele Tribute" pass as Adele — and
 * a tribute band is exactly what a popularity-ranked search surfaces, titled
 * exactly right, landing in the *strongest* tier. Confirmed live: that credit
 * is the second result iTunes returns for "Hello Adele". CJK keeps the plain
 * substring, having no spaces to anchor on.
 *
 * What it cannot do is see through translation: Spotify's 田馥甄 is iTunes'
 * "Hebe Tien", and no string comparison bridges that. That limit is the whole
 * reason this is only ever a *requirement* on title-only queries, never a
 * filter on the ones that already carried the artist upstream.
 */
function artistMatches(
  candidate: string | undefined,
  wanted: string,
  /** The `wanted` side, already split. Invariant across a pick — see pickCandidate. */
  askedCredits?: string[]
): boolean {
  const a = normalizeName(candidate ?? "");
  const b = normalizeName(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  if (CJK.test(a) || CJK.test(b)) return a.includes(b) || b.includes(a);
  const credited = creditParts(candidate ?? "");
  const asked = askedCredits ?? creditParts(wanted);
  const names = (billing: string[], acts: string[]) => acts.every((act) => billing.includes(act));
  return names(credited, asked) || names(asked, credited);
}

const FEAT_PARENTHETICAL = /[([]feat\.?[^)\]]*[)\]]/gi;

/** Tags a platform appends to a title without changing which recording it is. */
const QUALIFIER = "remaster(?:ed)?|live|version|edit|mix|mono|stereo|deluxe|explicit";

/**
 * Either a trailing " - Qualifier…", which is how Spotify writes it, or a
 * bracketed group containing one, which is how iTunes does.
 *
 * Anchored far more tightly than it first appears to need, because the loose
 * form was wrong in the one direction that mattered. `[-([]` followed by `.*?`
 * reaching for the keyword truncates at the *first* hyphen in the title, so
 * "Hip-Hop Is Dead (Remastered)" stripped to "Hip" — and with the loose tier
 * sitting above the artist tier, that collapse outranked a candidate whose
 * running time agreed to the millisecond. A new wrong-clip path, opened by the
 * fix for wrong clips. The \b around the alternation is the same story one
 * size down: without it "live" fires inside "Alive" and "mix" inside "Remix".
 */
const QUALIFIER_SUFFIX = new RegExp(
  `\\s+[-–—]\\s+[^()\\[\\]]*\\b(?:${QUALIFIER})\\b.*$` +
    `|\\s*[([][^)\\]]*\\b(?:${QUALIFIER})\\b[^)\\]]*[)\\]]`,
  "gi"
);

/**
 * The title with the qualifiers one platform adds and the other does not.
 *
 * Spotify stores "Karma Police - Remastered" where iTunes has "Karma Police
 * (Remastered)" and, for the same recording, plain "Karma Police". An exact
 * comparison drops all of those out of the tier that already knows the artist,
 * which leaves the pick to the clock — and the clock cannot tell a remaster
 * from the sibling album track next to it.
 *
 * Close to lib/mixed-playlist.ts's fingerprint() and deliberately not shared
 * with it, in two ways that matter. It strips `explicit`, which that one does
 * not; and it normalises through normalizeName's Unicode alphabet rather than
 * fingerprint's `[^a-z0-9]`, because the ASCII form takes "小幸運" to the empty
 * string — which would turn the tier below off for the exact catalogue it was
 * added to protect. Syncing the two by hand is how that gets undone.
 */
function looseName(value: string): string {
  return normalizeName(value.replace(FEAT_PARENTHETICAL, "").replace(QUALIFIER_SUFFIX, ""));
}

interface PickOptions {
  /**
   * Reject anything that cannot be tied to the track we were asked for, by
   * either its credit or its running time.
   *
   * Set on the title-only queries, and only on those. There the search term
   * carried no artist at all, so upstream had nothing to rank by and the top
   * result is just the most popular song with that title: searching "Hello"
   * returns Pinkfong's nursery-rhyme cover rather than Adele's, "Alone" returns
   * Heart's 1987 single rather than Marshmello's. Accepting one of those writes
   * the wrong recording into KV as `found`, which is held for a year and which
   * the refresh path will never revisit — it repairs rotted URLs, not wrong
   * songs. For a guessing game that is worse than silence: the clip plays, and
   * then the answer card contradicts it.
   */
  requireVerified?: boolean;
}

/**
 * Chooses which upstream result to play, strongest evidence first.
 *
 * Three signals, none of which survives every case alone. The credit is the
 * obvious one but is routinely translated — iTunes calls 盧廣仲 "Crowd Lu". The
 * running time is translated by nobody and matches the original to the
 * millisecond, which is exactly what a cover does not do. The title sits
 * between them, and its two directions are NOT symmetric, which is the whole
 * reason this is a tier list rather than a weighted score:
 *
 *   a title MATCH is strong evidence  — few unrelated recordings share a title
 *   a title MISS is weak evidence     — it usually just means "translated"
 *
 * So the ranking flips on whether the artist is verified. With the artist
 * confirmed, a title miss means "different song by the same artist" and the
 * title outranks the clock. With the artist unverifiable, a title match means
 * "someone else's cover of it" and the clock outranks the title. Collapsing
 * those two into one rule is how an earlier cut of this function picked a
 * same-artist song 500ms away over the exact title 3s away — a remaster is
 * further off the clock than a sibling track is, so a correct pick became a
 * wrong one.
 *
 * Ties inside a tier go to the closest running time, then to upstream's own
 * ranking.
 */
function pickCandidate(
  candidates: Candidate[] | undefined,
  query: QueryTarget,
  options: PickOptions = {}
): SourceOutcome {
  if (!Array.isArray(candidates)) return { kind: "unavailable", throttled: false };

  const { track, artist, durationMs } = query;
  const playable = candidates.filter((c) => c.previewUrl);
  // Normalised the same way credits are. Comparing raw lowercase would let a
  // typographic apostrophe ("Don't" vs "Don’t") or a stray double space defeat
  // the strongest signal in the list, in a way the artist check is immune to.
  const wantedTitle = normalizeName(track);
  const wantedLoose = looseName(track);
  // Split once. It is the same string for every candidate, and this runs inside
  // a filter that the tier loop may walk several times.
  const askedCredits = creditParts(artist);

  // Each candidate is judged once and carries its own verdicts from there. The
  // tier loop below re-filters the list per tier, and the same three questions
  // appear in more than one tier — asking upstream's strings again each time is
  // regex work on the hottest path in the app, for an answer that cannot change.
  // The empty guard on `looseOk` matters: a title made entirely of qualifiers
  // strips to "", and without it every candidate that did would match all others.
  const scored = playable.map((c) => ({
    c,
    artistOk: artistMatches(c.artistName, artist, askedCredits),
    titleOk: normalizeName(c.trackName ?? "") === wantedTitle,
    looseOk: wantedLoose.length > 0 && looseName(c.trackName ?? "") === wantedLoose,
    drift: durationMs && c.durationMs ? Math.abs(c.durationMs - durationMs) : Infinity,
  }));
  type Scored = (typeof scored)[number];

  // No "…and the running time agrees" tier above any of these: its members
  // would all sit inside the tolerance while every other member of the tier
  // below sat outside it, so the closest-drift tie-break already elects the
  // same candidate. A *title* refinement is not redundant that way, because
  // drift is what breaks the tie and drift knows nothing about titles.
  const tiers: Array<(s: Scored) => boolean> = [
    (s) => s.artistOk && s.titleOk,
    // The right artist, and the right title once the qualifiers are off. Above
    // the artist alone because otherwise a remaster-tagged title matches no
    // tier at all and the clock chooses among an artist's own album tracks —
    // which is how "Karma Police - Remastered" resolves to Lucky.
    (s) => s.artistOk && s.looseOk,
    (s) => s.artistOk,
    // Artist unverifiable — a translated credit. The clock is all that is left,
    // and it is the tier that rescues CJK tracks from their own covers. It
    // stays *above* the bare title on purpose: an exact title whose running
    // time is 52s out is a cover, and the recording asked for is the one whose
    // clock agrees. tests/preview.test.ts pins that ordering.
    (s) => s.drift <= DURATION_TOLERANCE_MS,
    // Below here nothing ties the result to what was asked for, which is what
    // `requireVerified` refuses on a query that carried no artist upstream.
    ...(options.requireVerified
      ? []
      : [(s: Scored) => s.titleOk, (s: Scored) => s.looseOk, () => true]),
  ];

  let match: Candidate | undefined;
  for (const inTier of tiers) {
    const members = scored.filter(inTier);
    if (members.length === 0) continue;
    // `<` keeps the earlier candidate on a tie, so an all-unknown tier falls
    // back to the order upstream ranked them in.
    match = members.reduce((best, s) => (s.drift < best.drift ? s : best)).c;
    break;
  }

  if (match?.previewUrl) {
    return { kind: "found", previewUrl: match.previewUrl, trackId: match.trackId };
  }
  // No usable result. `empty` covers both "upstream has no clip for this" and
  // "it offered one but it isn't our song": either way upstream answered
  // cleanly, so the next source gets its turn and nothing gets recorded as a
  // fact about us rather than about the recording.
  return { kind: "empty" };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<
  { ok: true; res: Response; body: unknown } | { ok: false; outcome: SourceOutcome }
> {
  let res: Response;
  try {
    // A batch gates only the *start* of each resolution against its deadline,
    // so one stalled upstream call can carry the whole function past the
    // platform's wall-clock limit — and a batch that dies returns nothing at
    // all, which is strictly worse than returning what it had. Bounding each
    // call keeps the overrun to one timeout rather than one hung socket.
    res = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    // Covers the abort too: a timeout is "we could not ask", never "no clip".
    return { ok: false, outcome: { kind: "unavailable", throttled: false } };
  }

  const bad = statusOutcome(res);
  if (bad) {
    // Nothing reads the body on this path, and an undici response holds its
    // connection until the body is consumed or cancelled. This is the 403/429
    // branch — the highest-volume one during exactly the throttling event where
    // socket pressure is least affordable.
    void res.body?.cancel().catch(() => {});
    return { ok: false, outcome: bad };
  }

  try {
    return { ok: true, res, body: await res.json() };
  } catch {
    // A 200 we can't parse is not an answer either.
    return { ok: false, outcome: { kind: "unavailable", throttled: false } };
  }
}

interface ItunesResult {
  previewUrl?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  trackTimeMillis?: number;
}

const fromItunes = (r: ItunesResult): Candidate => ({
  previewUrl: r.previewUrl,
  trackId: r.trackId,
  trackName: r.trackName,
  artistName: r.artistName,
  durationMs: r.trackTimeMillis,
});

async function queryItunes(
  term: string,
  query: QueryTarget,
  options: PickOptions = {}
): Promise<SourceOutcome> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
    term
  )}&media=music&entity=musicTrack&limit=10`;
  const got = await fetchJson(url, { Accept: "application/json" });
  if (!got.ok) return got.outcome;
  // `?.map` keeps a missing array as undefined, which pickCandidate reads as
  // "upstream did not answer" rather than "it answered with nothing".
  const results = (got.body as { results?: ItunesResult[] })?.results;
  return pickCandidate(results?.map(fromItunes), query, options);
}

/**
 * The cheap repair path: one call, no searching, when we already know the id.
 *
 * Never requires the artist. An id names exactly one recording, so whatever
 * comes back is by construction the track that was resolved last time — there
 * is no ranking here for a wrong song to win.
 */
async function lookupItunes(trackId: number, query: QueryTarget): Promise<SourceOutcome> {
  const got = await fetchJson(`https://itunes.apple.com/lookup?id=${trackId}`, {
    Accept: "application/json",
  });
  if (!got.ok) return got.outcome;
  const results = (got.body as { results?: ItunesResult[] })?.results;
  return pickCandidate(results?.map(fromItunes), query);
}

/** Deezer's field syntax delimits with double quotes and offers no escape for one. */
const stripQuotes = (value: string) => value.replace(/"/g, " ").trim();

interface DeezerResult {
  preview?: string;
  id?: number;
  title?: string;
  artist?: { name?: string };
  /** Whole seconds, where iTunes reports milliseconds. */
  duration?: number;
}

const fromDeezer = (r: DeezerResult): Candidate => ({
  previewUrl: r.preview,
  trackId: r.id,
  trackName: r.title,
  artistName: r.artist?.name,
  durationMs: typeof r.duration === "number" ? r.duration * 1000 : undefined,
});

async function queryDeezer(
  q: string,
  query: QueryTarget,
  options: PickOptions = {}
): Promise<SourceOutcome> {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`;
  const got = await fetchJson(url, {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
  });
  if (!got.ok) return got.outcome;

  // Deezer reports its quota limit in the *body* of a 200, so a status-only
  // check reads "quota exceeded" as "no such song".
  const body = got.body as { data?: DeezerResult[]; error?: { code?: number } };
  if (body?.error) {
    return { kind: "unavailable", throttled: true, retryAfterSeconds: retryAfterFrom(got.res) };
  }
  if (!Array.isArray(body?.data)) return { kind: "unavailable", throttled: false };

  return pickCandidate(body.data.map(fromDeezer), query, options);
}

interface Resolution {
  status: PreviewStatus;
  previewUrl: string | null;
  source?: PreviewSource;
  itunesTrackId?: number;
  deezerTrackId?: number;
}

const UNRESOLVED: Resolution = { status: "unavailable", previewUrl: null };

/**
 * Asks iTunes then Deezer, skipping either while it is cooling down.
 *
 * Returns `absent` only if every source we asked gave a clean, complete reply
 * and none of them had a clip. If any source was skipped, refused us, or failed
 * mid-question, the answer is `unavailable` — we do not know, and saying
 * otherwise for a week is the defect this module exists to prevent.
 */
async function askUpstream(query: QueryTarget): Promise<Resolution> {
  const { track, artist } = query;
  let blocked = false;

  const ask = async (
    source: PreviewSource,
    attempts: SourceQuery[],
    // Named `attempt`, not `query`: `query` is askUpstream's QueryTarget, and a
    // callback moved inside `ask` would otherwise silently rebind to the
    // per-attempt one with no type error to show for it.
    run: (attempt: SourceQuery) => Promise<SourceOutcome>
  ): Promise<Resolution | null> => {
    if (await isCoolingDown(source)) {
      blocked = true;
      return null;
    }
    for (const attempt of attempts) {
      const outcome = await run(attempt);
      if (outcome.kind === "found") {
        return {
          status: "found",
          previewUrl: outcome.previewUrl,
          source,
          ...(source === "itunes"
            ? { itunesTrackId: outcome.trackId }
            : { deezerTrackId: outcome.trackId }),
        };
      }
      if (outcome.kind === "unavailable") {
        blocked = true;
        if (outcome.throttled) await startCooldown(source, outcome.retryAfterSeconds);
        // Stop asking this source. A second query against a host that just
        // refused us spends a call to be refused again.
        return null;
      }
    }
    return null;
  };

  const withArtist = `${track} ${artist}`.trim();

  // The title-only follow-up is appended only when there is an artist to check
  // the answer against. Without one it is also byte-identical to the query
  // above it, so the old flat list spent a second upstream call re-asking a
  // question it had just had answered.
  // With no artist, the query above has already degraded to the bare title and
  // the guarded follow-up is skipped as a duplicate — which quietly left the
  // *unguarded* half as the only thing that ran, so a title-only search took
  // upstream's best-ranked answer with nothing tying it to the request at all.
  // The clock is the one check still available. Demand it when the caller sent
  // one; when they did not, keep the old behaviour rather than manufacturing a
  // week-long `absent` for a track that may well have a clip.
  const titleOnly: SourceQuery = { q: track, requireVerified: Boolean(query.durationMs) };

  const viaItunes = await ask(
    "itunes",
    artist ? [{ q: withArtist }, { q: track, requireVerified: true }] : [titleOnly],
    ({ q, requireVerified }) => queryItunes(q, query, { requireVerified })
  );
  if (viaItunes) return viaItunes;

  const viaDeezer = await ask(
    "deezer",
    artist
      ? [
          // Deezer's field syntax is the most precise question either source
          // accepts, which is what makes handing over an iTunes result that
          // failed its checks worth the extra call rather than giving up.
          //
          // Quotes are stripped rather than escaped: a track name containing
          // one would otherwise close the field early and let the rest of the
          // title read as Deezer search operators. Nothing is gained by that
          // today — the bare-term queries below already let a caller search
          // freely — but the escaping burden is invisible to the next edit.
          { q: `track:"${stripQuotes(track)}" artist:"${stripQuotes(artist)}"` },
          { q: withArtist },
          { q: track, requireVerified: true },
        ]
      : [titleOnly],
    ({ q, requireVerified }) => queryDeezer(q, query, { requireVerified })
  );
  if (viaDeezer) return viaDeezer;

  return blocked ? UNRESOLVED : { status: "absent", previewUrl: null };
}

function toRecord(resolution: Resolution): PreviewRecord {
  return {
    previewUrl: resolution.previewUrl,
    ...(resolution.source ? { source: resolution.source } : {}),
    ...(resolution.itunesTrackId ? { itunesTrackId: resolution.itunesTrackId } : {}),
    ...(resolution.deezerTrackId ? { deezerTrackId: resolution.deezerTrackId } : {}),
    ...(resolution.status === "unavailable" ? { confirmed: false } : {}),
    resolvedAt: Date.now(),
  };
}

/**
 * Resolves one track upstream and stores the outcome. Assumes the caller has
 * already claimed budget for it.
 *
 * `existing` carries the ids from a previous resolution, so a refresh costs one
 * `lookup?id=` call rather than the full search fan-out.
 */
async function resolveAndStore(
  query: PreviewQuery,
  key: string,
  existing: PreviewRecord | null
): Promise<PreviewResult> {
  let resolution: Resolution | null = null;

  if (existing?.itunesTrackId && !(await isCoolingDown("itunes"))) {
    const outcome = await lookupItunes(existing.itunesTrackId, query);
    if (outcome.kind === "found") {
      resolution = {
        status: "found",
        previewUrl: outcome.previewUrl,
        source: "itunes",
        itunesTrackId: outcome.trackId ?? existing.itunesTrackId,
      };
    }
    // An empty or failed lookup falls through to a full search: the id may have
    // been retired from the store entirely, which a search can still route
    // around by finding the re-release.
  }

  resolution ??= await askUpstream(query);

  await writeRecord(key, toRecord(resolution), resolution.status);
  return { previewUrl: resolution.previewUrl, status: resolution.status };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface GetPreviewOptions {
  /**
   * Ignore a cached hit and re-resolve. For a URL that stopped playing — the
   * CDN rotates them — which is the failure a long positive TTL trades for the
   * upstream calls it saves.
   */
  refresh?: boolean;
}

export async function getPreview(
  query: PreviewQuery,
  options: GetPreviewOptions = {}
): Promise<PreviewResult> {
  const key = previewCacheKey(query.id, query.track, query.artist);
  const [existing] = await readRecords([key]);

  if (existing && !options.refresh) {
    await recordOutcomes({ hits: 1, misses: 0, unavailable: 0 });
    return recordToResult(existing);
  }

  if (!(await claimLookupBudget())) {
    // Deliberately not cached. The claim is already one cheap atomic op and is
    // self-limiting, where writing a marker would spend a KV write per track
    // during exactly the spike we are trying to ride out.
    await recordOutcomes({ hits: 0, misses: 0, unavailable: 1 });
    return { previewUrl: null, status: "unavailable" };
  }

  const result = await resolveAndStore(query, key, existing);
  await recordOutcomes({
    hits: 0,
    misses: 1,
    unavailable: result.status === "unavailable" ? 1 : 0,
  });
  return result;
}

/**
 * How many tracks one batch may resolve upstream.
 *
 * A cap rather than "all of them" so a single 50-song cold start cannot eat the
 * whole minute's global budget and starve every other party on the site. The
 * remainder come back `unavailable`, which the game page resolves lazily as it
 * reaches them — the same path it used before batching existed.
 */
const DEFAULT_MAX_UPSTREAM_PER_BATCH = 25;

/**
 * How long a batch may keep starting new resolutions.
 *
 * Serverless functions have a hard wall-clock limit, and a batch that hits it
 * returns nothing at all — strictly worse than returning what it had. Tracks
 * not started by the deadline come back `unavailable` and are picked up lazily.
 */
const BATCH_DEADLINE_MS = 6000;

/** Concurrent upstream resolutions. Enough to be quick, not enough to look like an attack. */
const BATCH_CONCURRENCY = 5;

export interface GetPreviewsOptions {
  maxUpstream?: number;
  deadlineMs?: number;
}

/**
 * Resolves many tracks in one pass, keyed by the id each caller sent.
 *
 * The reason this exists is the KV bill, not the upstream one: reading a
 * 50-track game one key at a time is 50 Upstash commands and 50 round trips,
 * where `mget` is one of each. Upstream work is still bounded by the same
 * budget and cooldowns a single lookup goes through.
 */
export async function getPreviews(
  queries: PreviewQuery[],
  options: GetPreviewsOptions = {}
): Promise<Map<string, PreviewResult>> {
  const results = new Map<string, PreviewResult>();
  if (queries.length === 0) return results;

  // Several tracks can share a cache key (the same recording under two ids is
  // rare, but two id-less entries with the same name are not), so resolve each
  // key once and fan the answer back out.
  const keyed = queries.map((q) => ({
    query: q,
    key: previewCacheKey(q.id, q.track, q.artist),
  }));
  const uniqueKeys = [...new Set(keyed.map((k) => k.key))];
  const records = await readRecords(uniqueKeys);
  const byKey = new Map<string, PreviewRecord | null>(
    uniqueKeys.map((key, i) => [key, records[i]])
  );

  const resolved = new Map<string, PreviewResult>();
  const pending: Array<{ query: PreviewQuery; key: string }> = [];
  const seen = new Set<string>();
  // Counted per query rather than per key: two tracks sharing a key are two
  // questions the cache answered, and the hit rate is about questions.
  let hitCount = 0;

  for (const entry of keyed) {
    const record = byKey.get(entry.key);
    if (record) {
      resolved.set(entry.key, recordToResult(record));
      hitCount++;
    } else if (!seen.has(entry.key)) {
      seen.add(entry.key);
      pending.push(entry);
    }
  }

  const maxUpstream = options.maxUpstream ?? DEFAULT_MAX_UPSTREAM_PER_BATCH;
  const toResolve = pending.slice(0, Math.max(0, maxUpstream));
  const deferred = pending.slice(toResolve.length);

  // Claimed for the whole batch up front, so it either gets its fan-out or
  // defers cleanly instead of stopping halfway through a playlist.
  const allowed = toResolve.length > 0 && (await claimLookupBudget(toResolve.length));

  let unavailableCount = deferred.length;
  let missCount = 0;

  if (allowed) {
    const deadline = Date.now() + (options.deadlineMs ?? BATCH_DEADLINE_MS);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, toResolve.length) }, async () => {
        while (next < toResolve.length) {
          const entry = toResolve[next++];
          if (Date.now() > deadline) {
            resolved.set(entry.key, { previewUrl: null, status: "unavailable" });
            unavailableCount++;
            continue;
          }
          const result = await resolveAndStore(entry.query, entry.key, byKey.get(entry.key) ?? null);
          resolved.set(entry.key, result);
          missCount++;
          if (result.status === "unavailable") unavailableCount++;
        }
      })
    );
  } else {
    for (const entry of toResolve) {
      resolved.set(entry.key, { previewUrl: null, status: "unavailable" });
      unavailableCount++;
    }
  }

  // Deferred tracks are not written to KV: nothing refused them, we simply did
  // not ask, and a 90s marker would suppress the lazy lookup that is meant to
  // pick them up.
  for (const entry of deferred) {
    resolved.set(entry.key, { previewUrl: null, status: "unavailable" });
  }

  await recordOutcomes({ hits: hitCount, misses: missCount, unavailable: unavailableCount });

  for (const entry of keyed) {
    results.set(
      entry.query.id,
      resolved.get(entry.key) ?? { previewUrl: null, status: "unavailable" }
    );
  }
  return results;
}
