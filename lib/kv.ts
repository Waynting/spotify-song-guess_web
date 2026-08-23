/**
 * Minimal KV abstraction for Mixed Playlist Mode's room store. Uses Upstash
 * Redis (via UPSTASH_REDIS_REST_URL/TOKEN) when configured; otherwise falls
 * back to an in-process Map so local dev and tests don't need a real Redis
 * instance. The in-memory fallback only survives within a single Node
 * process — fine for `next dev`/`next start`, but NOT safe for multi-instance
 * serverless deploys, which is why production must set the Upstash env vars.
 */

export interface KvStore {
  get<T>(key: string): Promise<T | null>;
  /**
   * Reads many keys as one command, in the order given, with null for each
   * key that isn't present.
   *
   * Exists for app/api/preview/batch/route.ts, where a 50-track game would
   * otherwise be 50 separate round trips. Upstash bills per command, so that
   * is a 50x difference on the one quota this app actually pays for — and the
   * whole point of the batch route is to make a game cost a fixed, small
   * number of calls rather than a number that scales with the playlist.
   */
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Atomically increments a counter and (re)starts its TTL on the first
   * increment of a window. Used for rate limiting, where a get-then-set
   * pair would race under concurrent requests.
   *
   * `by` lets a caller that already knows it is recording N events spend one
   * command instead of N. Without it the batch route's own hit counter would
   * undo the saving `mget` just made.
   */
  incr(key: string, ttlSeconds: number, by?: number): Promise<number>;

  /**
   * Reads every field of a hash as one command. `{}` for a key that is not
   * there, which is indistinguishable from an empty hash — Redis does not keep
   * those, so the two really are the same state.
   */
  hgetall<T>(key: string): Promise<Record<string, T>>;

  /**
   * Sets a field only if it does not already exist, and says whether it did.
   * Atomic, and the reason the hash primitives exist at all.
   *
   * lib/room.ts's writers used to read the whole room record, edit it, write it
   * back, and then read it *again* to find out whether a concurrent writer had
   * clobbered them — a retry loop around a race that get/set cannot actually
   * close. Claiming one field is a single command that either wins or loses,
   * with nothing to verify and nothing to retry. A QR room is a group of phones
   * submitting within the same few seconds, so this is the ordinary case there,
   * not an edge one.
   *
   * Does **not** touch the key's expiry, in either backend: Redis leaves a TTL
   * alone on a field write, and a caller that reset it on every submit would
   * quietly extend a room past the `expiresAt` it already told its clients.
   * Call `expire` once, when the hash is created.
   */
  hsetnx(key: string, field: string, value: unknown): Promise<boolean>;

  /** Removes one field. Used to roll back a claim that turned out to be too late. */
  hdel(key: string, field: string): Promise<void>;

  /** Sets a key's TTL. Separate from the write, per the note on `hsetnx`. */
  expire(key: string, ttlSeconds: number): Promise<void>;
}

/**
 * The day segment shared by every day-bucketed counter key in the app.
 *
 * It lives here, next to the store, because the writer and the reader are
 * always in different modules — `lib/loop-redirect.ts` increments a bucket that
 * `scripts/loop-stats.mjs` reads back a week later — and the two have to produce a
 * byte-identical string or they address different keys. That failure is silent:
 * nothing errors, the counter simply reads zero forever. Three copies of
 * `new Date().toISOString().slice(0, 10)` were already drifting distance apart
 * before this existed.
 *
 * **UTC, deliberately.** A local-time bucket would move under a server whose
 * region changes and would disagree between a lambda and a laptop, so a day is
 * whatever UTC says it is. The visible cost is that a rate read shortly after
 * 00:00 UTC is measuring almost nothing, which is documented rather than fixed.
 *
 * `at` exists so tests can pin the boundary; production never passes it.
 */
export function dayBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The same clock one resolution finer, for counters that have to add up to a
 * *rolling* window rather than a calendar one.
 *
 * `lib/playlist-cache.ts` needs this because Spotify's quota turned out not to
 * be a calendar day. Measured on production 2026-08-23: a `QUOTA_EXCEEDED`
 * whose `Retry-After` resolved to 19:53 UTC — an instant roughly 24h after the
 * previous evening's burn, not to any midnight. A day bucket against that
 * window lets two busy half-days sit inside one rolling 24h and each pass its
 * own cap; twenty-four of these, summed, is the window itself.
 *
 * UTC, and `at` for tests, for the same reasons `dayBucket` gives.
 */
export function hourBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 13);
}

type MemoryEntry = { value: unknown; expiresAt: number };

declare global {
  // eslint-disable-next-line no-var -- global singleton, see getMemoryMap below
  var __guesssongKvMemoryStore: Map<string, MemoryEntry> | undefined;
}

/**
 * Next.js dev mode compiles each API route file as a separate on-demand
 * bundle — a plain module-scope `Map` ends up as a distinct instance per
 * route the first time it's compiled, so a room created via POST /api/room
 * would be invisible to GET /api/room/[code]/status. Stashing the Map on
 * `globalThis` (the real, single Node.js global) sidesteps that, the same
 * way Prisma's dev-mode client singleton does.
 */
function getMemoryMap(): Map<string, MemoryEntry> {
  if (!globalThis.__guesssongKvMemoryStore) {
    globalThis.__guesssongKvMemoryStore = new Map();
  }
  return globalThis.__guesssongKvMemoryStore;
}

/** The entry for `key` if it exists and has not expired; otherwise undefined. */
function liveEntry(key: string): MemoryEntry | undefined {
  const map = getMemoryMap();
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return entry;
}

/**
 * A hash's fields live in a Map under the same entry shape as everything else,
 * so TTL handling is shared.
 *
 * Throws on a key that already holds a plain value, which is what Redis does
 * (`WRONGTYPE`) and therefore what dev has to do too — the whole point of the
 * fallback store is that `next dev` behaves like production. Quietly replacing
 * the value would hide exactly the mistake that made lib/room.ts's key prefix
 * need a version bump, and hide it only until deploy.
 */
function liveHash(key: string): Map<string, unknown> | undefined {
  const entry = liveEntry(key);
  if (!entry) return undefined;
  if (!(entry.value instanceof Map)) {
    throw new Error(`WRONGTYPE: ${key} holds a plain value, not a hash`);
  }
  return entry.value;
}

function createMemoryStore(): KvStore {
  const store: KvStore = {
    async get<T>(key: string) {
      const entry = liveEntry(key);
      return entry ? (entry.value as T) : null;
    },
    async mget<T>(keys: string[]) {
      return Promise.all(keys.map((key) => store.get<T>(key)));
    },
    async set(key, value, ttlSeconds) {
      getMemoryMap().set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      getMemoryMap().delete(key);
    },
    async incr(key, ttlSeconds, by = 1) {
      const map = getMemoryMap();
      const entry = map.get(key);
      const now = Date.now();
      if (!entry || now > entry.expiresAt) {
        map.set(key, { value: by, expiresAt: now + ttlSeconds * 1000 });
        return by;
      }
      const next = (entry.value as number) + by;
      map.set(key, { value: next, expiresAt: entry.expiresAt });
      return next;
    },
    async hgetall<T>(key: string) {
      const hash = liveHash(key);
      return hash ? (Object.fromEntries(hash) as Record<string, T>) : {};
    },
    async hsetnx(key, field, value) {
      let hash = liveHash(key);
      if (!hash) {
        hash = new Map<string, unknown>();
        // No expiry until `expire` sets one, exactly as Redis behaves for a key
        // created by HSETNX. lib/room.ts is what makes sure that call follows.
        getMemoryMap().set(key, { value: hash, expiresAt: Number.POSITIVE_INFINITY });
      }
      if (hash.has(field)) return false;
      hash.set(field, value);
      return true;
    },
    async hdel(key, field) {
      liveHash(key)?.delete(field);
    },
    async expire(key, ttlSeconds) {
      const entry = liveEntry(key);
      if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
    },
  };
  return store;
}

function decodeField<T>(value: unknown): T {
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function hasUpstashEnv(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

let upstashStore: KvStore | null = null;

async function getUpstashStore(): Promise<KvStore> {
  if (!upstashStore) {
    const { Redis } = await import("@upstash/redis");
    const redis = Redis.fromEnv();
    upstashStore = {
      async get<T>(key: string) {
        return (await redis.get<T>(key)) ?? null;
      },
      async mget<T>(keys: string[]) {
        // Redis errors on MGET with no keys, and a caller with nothing to look
        // up is normal here (a batch where every track was already resolved
        // in this session).
        if (keys.length === 0) return [];
        const values = await redis.mget<Array<T | null>>(...keys);
        // Upstash returns a sparse-free array, but a shorter one would silently
        // misalign results with the keys the caller sent — pad rather than let
        // that become a wrong preview URL on the wrong track.
        return keys.map((_, i) => values?.[i] ?? null);
      },
      async set(key, value, ttlSeconds) {
        await redis.set(key, value, { ex: ttlSeconds });
      },
      async del(key) {
        await redis.del(key);
      },
      async incr(key, ttlSeconds, by = 1) {
        const count = by === 1 ? await redis.incr(key) : await redis.incrby(key, by);
        // Only the request that started this window sets its expiry, so
        // later increments don't keep pushing the TTL back. `count === by`
        // rather than `=== 1`: a batch that opens a window with +12 is still
        // the first increment of it.
        if (count === by) await redis.expire(key, ttlSeconds);
        return count;
      },
      async hgetall<T>(key: string) {
        const raw = await redis.hgetall<Record<string, unknown>>(key);
        if (!raw) return {};
        // The client parses JSON values on the way out, but hands back anything
        // that is not JSON as the raw string — a bare uuid, for instance. Decode
        // defensively rather than assuming one or the other, because the two
        // shapes differ only at runtime and a wrong guess is a crash in the
        // middle of somebody's party.
        const out: Record<string, T> = {};
        for (const [field, value] of Object.entries(raw)) {
          out[field] = decodeField<T>(value);
        }
        return out;
      },
      async hsetnx(key, field, value) {
        return (await redis.hsetnx(key, field, value)) === 1;
      },
      async hdel(key, field) {
        await redis.hdel(key, field);
      },
      async expire(key, ttlSeconds) {
        await redis.expire(key, ttlSeconds);
      },
    };
  }
  return upstashStore;
}

const memoryStore = createMemoryStore();

/** Returns the Upstash-backed store when configured, else the in-memory fallback. */
export async function getKvStore(): Promise<KvStore> {
  return hasUpstashEnv() ? getUpstashStore() : memoryStore;
}
