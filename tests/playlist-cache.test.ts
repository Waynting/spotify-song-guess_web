// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as spotify from "@/lib/spotify";
import { loadPlaylist, getCacheStats, __resetInFlightForTests } from "@/lib/playlist-cache";
import type { Track } from "@/types";

/**
 * Like tests/preview.test.ts, every assertion here is about upstream call
 * *count*. A cache that returns the right tracks while still paginating
 * Spotify on every request fixes nothing — the failure this exists to prevent
 * is `429 QUOTA_EXCEEDED` against a client id shared by the entire user base,
 * and the only thing that moves that number is not making the call.
 */

const kv = vi.hoisted(() => {
  const mem = new Map<string, { value: unknown; expiresAt: number }>();
  const writes: Array<{ key: string; value: unknown; ttlSeconds: number }> = [];
  const flags = { failReads: false, failWrites: false };
  return { mem, writes, flags };
});

vi.mock("@/lib/kv", () => ({
  // `dayBucket` is a pure function over a clock, not a store, so the fake
  // reproduces it rather than stubbing it — a mocked bucket would let the key
  // format drift here without any test noticing.
  dayBucket: (at: Date = new Date()) => at.toISOString().slice(0, 10),
  getKvStore: async () => ({
    async get(key: string) {
      if (kv.flags.failReads) throw new Error("kv unavailable");
      const entry = kv.mem.get(key);
      if (!entry || Date.now() > entry.expiresAt) return null;
      return entry.value;
    },
    async set(key: string, value: unknown, ttlSeconds: number) {
      if (kv.flags.failWrites) throw new Error("kv unavailable");
      kv.writes.push({ key, value, ttlSeconds });
      kv.mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key: string) {
      kv.mem.delete(key);
    },
    async incr(key: string, ttlSeconds: number) {
      const entry = kv.mem.get(key);
      const now = Date.now();
      if (!entry || now > entry.expiresAt) {
        kv.mem.set(key, { value: 1, expiresAt: now + ttlSeconds * 1000 });
        return 1;
      }
      const next = (entry.value as number) + 1;
      kv.mem.set(key, { value: next, expiresAt: entry.expiresAt });
      return next;
    },
  }),
}));

// Only the network-facing entry point is mocked. parsePlaylistUrl,
// isSpotifyEditorial and SpotifyApiError stay real, because the cache's
// routing decisions are built on them.
vi.mock("@/lib/spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/spotify")>();
  return { ...actual, getPlaylistWithTracks: vi.fn() };
});

const URL_A = "https://open.spotify.com/playlist/aaaaaaaaaaaa";
const URL_B = "https://open.spotify.com/playlist/bbbbbbbbbbbb";

function makeTrack(id: string): Track {
  return {
    id,
    name: `Song ${id}`,
    artists: ["Artist"],
    durationMs: 200000,
    createdAt: "2026-01-01T00:00:00.000Z",
    rawJson: { huge: "blob" },
  };
}

function upstreamResult(ids: string[], truncated = false) {
  return {
    playlist: { id: "p", name: "My Playlist", tracks: { items: [], total: ids.length } },
    tracks: ids.map(makeTrack),
    truncated,
  };
}

const upstream = () => vi.mocked(spotify.getPlaylistWithTracks);
const upstreamCalls = () => upstream().mock.calls.length;

beforeEach(() => {
  kv.mem.clear();
  kv.writes.length = 0;
  kv.flags.failReads = false;
  kv.flags.failWrites = false;
  __resetInFlightForTests();
  upstream().mockReset();
  upstream().mockResolvedValue(upstreamResult(["a", "b"]));
});

describe("playlist cache", () => {
  it("returns the playlist and its tracks on a cold load", async () => {
    const result = await loadPlaylist(URL_A);

    expect(result.name).toBe("My Playlist");
    expect(result.tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.totalTracks).toBe(2);
    expect(result.truncated).toBe(false);
    expect(upstreamCalls()).toBe(1);
  });

  it("serves a repeat load from cache with zero upstream calls", async () => {
    await loadPlaylist(URL_A);
    const second = await loadPlaylist(URL_A);

    expect(second.tracks.map((t) => t.id)).toEqual(["a", "b"]);
    // This is the whole fix: the same playlist used to re-paginate every time.
    expect(upstreamCalls()).toBe(1);
  });

  it("keys the cache by playlist id, so a different playlist still loads", async () => {
    await loadPlaylist(URL_A);
    upstream().mockResolvedValue(upstreamResult(["c"]));
    const other = await loadPlaylist(URL_B);

    expect(other.tracks.map((t) => t.id)).toEqual(["c"]);
    expect(upstreamCalls()).toBe(2);
  });

  it("hits the same cache entry for the URI form of the same playlist", async () => {
    await loadPlaylist(URL_A);
    await loadPlaylist("spotify:playlist:aaaaaaaaaaaa");

    expect(upstreamCalls()).toBe(1);
  });

  it("strips rawJson before caching, so entries stay small", async () => {
    const result = await loadPlaylist(URL_A);

    expect(result.tracks[0]).not.toHaveProperty("rawJson");
    const entry = kv.writes[0].value as { tracks: Track[] };
    expect(entry.tracks[0]).not.toHaveProperty("rawJson");
  });

  it("preserves the truncated flag through the cache", async () => {
    upstream().mockResolvedValue(upstreamResult(["a"], true));

    expect((await loadPlaylist(URL_A)).truncated).toBe(true);
    expect((await loadPlaylist(URL_A)).truncated).toBe(true);
    expect(upstreamCalls()).toBe(1);
  });

  it("does not cache an empty playlist", async () => {
    upstream().mockResolvedValue(upstreamResult([]));

    await loadPlaylist(URL_A);
    await loadPlaylist(URL_A);

    // A playlist the host is still filling shouldn't be remembered as empty
    // for six hours.
    expect(upstreamCalls()).toBe(2);
  });

  it("rejects an unparseable URL without calling Spotify", async () => {
    await expect(loadPlaylist("https://example.com/not-a-playlist")).rejects.toMatchObject({
      status: 400,
    });
    expect(upstreamCalls()).toBe(0);
  });

  it("rejects an editorial playlist without calling Spotify", async () => {
    await expect(
      loadPlaylist("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")
    ).rejects.toThrow(/editorial/i);
    expect(upstreamCalls()).toBe(0);
  });
});

describe("in-flight coalescing", () => {
  it("collapses concurrent loads of the same playlist into one upstream fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream().mockImplementation(async () => {
      await gate;
      return upstreamResult(["a"]);
    });

    // Mixed mode fires one request per contributor from a single click, and a
    // QR room gets a burst of submits — duplicate URLs in either used to mean
    // duplicate pagination, because the cache write lands too late to help
    // its own siblings.
    const all = Promise.all([loadPlaylist(URL_A), loadPlaylist(URL_A), loadPlaylist(URL_A)]);
    release();
    const results = await all;

    expect(upstreamCalls()).toBe(1);
    expect(results.every((r) => r.tracks.length === 1)).toBe(true);
  });

  it("does not coalesce different playlists", async () => {
    await Promise.all([loadPlaylist(URL_A), loadPlaylist(URL_B)]);
    expect(upstreamCalls()).toBe(2);
  });

  it("clears the in-flight entry after a failure, so a later retry is not stuck", async () => {
    upstream().mockRejectedValueOnce(new spotify.SpotifyApiError("playlist_load_failed", 500));
    await expect(loadPlaylist(URL_A)).rejects.toMatchObject({ status: 500 });

    upstream().mockResolvedValue(upstreamResult(["a"]));
    await expect(loadPlaylist(URL_A)).resolves.toMatchObject({ totalTracks: 1 });
  });
});

describe("404 negative caching", () => {
  it("remembers a missing playlist so a retry burst costs one upstream call", async () => {
    upstream().mockRejectedValue(new spotify.SpotifyApiError("playlist_not_found", 404));

    await expect(loadPlaylist(URL_A)).rejects.toMatchObject({ code: "playlist_not_found" });
    await expect(loadPlaylist(URL_A)).rejects.toMatchObject({ status: 404 });
    await expect(loadPlaylist(URL_A)).rejects.toMatchObject({ status: 404 });

    expect(upstreamCalls()).toBe(1);
  });

  it("holds a 404 for far less time than a successful load", async () => {
    upstream().mockRejectedValue(new spotify.SpotifyApiError("playlist_not_found", 404));
    await expect(loadPlaylist(URL_A)).rejects.toThrow();
    const missTtl = kv.writes.at(-1)!.ttlSeconds;

    kv.mem.clear();
    upstream().mockResolvedValue(upstreamResult(["a"]));
    await loadPlaylist(URL_A);
    const hitTtl = kv.writes.at(-1)!.ttlSeconds;

    // A host who fixes their playlist's visibility must not keep being told
    // it's broken.
    expect(missTtl).toBeLessThan(hitTtl);
  });

  it("holds a loaded playlist long enough to cover tomorrow night", async () => {
    await loadPlaylist(URL_A);

    // Parties are nightly, so six hours meant a playlist first loaded at 8pm
    // was cold again by 8pm the next day: 406 warm keys against 2,152 cold
    // loads in a day, every miss spending the app's shared Spotify quota.
    const write = kv.writes.find((w) => w.key.startsWith("playlist:"))!;
    expect(write.ttlSeconds).toBe(24 * 60 * 60);
  });

  it("does not cache a 5xx — that is Spotify's problem, not the playlist's", async () => {
    upstream().mockRejectedValue(new spotify.SpotifyApiError("playlist_load_failed", 503));

    await expect(loadPlaylist(URL_A)).rejects.toThrow();
    await expect(loadPlaylist(URL_A)).rejects.toThrow();

    expect(upstreamCalls()).toBe(2);
  });
});

describe("429 cooldown", () => {
  it("parks further uncached loads after Spotify reports a 429", async () => {
    upstream().mockRejectedValueOnce(new spotify.SpotifyApiError("spotify_rate_limited", 429, { retryAfterSeconds: 45 }));
    await expect(loadPlaylist(URL_A)).rejects.toMatchObject({ status: 429 });

    // A different playlist, and the upstream mock is healthy again — but the
    // quota is per app, so going back out would just spend more of it.
    upstream().mockResolvedValue(upstreamResult(["c"]));
    await expect(loadPlaylist(URL_B)).rejects.toMatchObject({ status: 429 });

    expect(upstreamCalls()).toBe(1);
  });

  it("still serves cached playlists during a cooldown", async () => {
    await loadPlaylist(URL_A);

    upstream().mockRejectedValueOnce(new spotify.SpotifyApiError("spotify_rate_limited", 429));
    await expect(loadPlaylist(URL_B)).rejects.toMatchObject({ status: 429 });

    // The party already holding a loaded playlist must not be taken down by
    // someone else's throttling.
    await expect(loadPlaylist(URL_A)).resolves.toMatchObject({ totalTracks: 2 });
  });

  it("stores the real wait but lets the key expire early enough to re-check", async () => {
    // Production, 2026-08-23: `retry-after: 52531`, `reason: QUOTA_EXCEEDED`.
    // The two numbers here used to be one, and the single number got both
    // jobs wrong — a 15-minute clamp told the host a wait the app could not
    // honour, and re-opened the gate on a quota that had 14 hours left to run.
    const before = Date.now();
    upstream().mockRejectedValueOnce(
      new spotify.SpotifyApiError("spotify_rate_limited", 429, { retryAfterSeconds: 52531 })
    );
    await expect(loadPlaylist(URL_A)).rejects.toThrow();

    const cooldown = kv.writes.find((w) => w.key === "spotify:cooldown")!;

    // The value is what the host is told: the truth, hours and all.
    const until = (cooldown.value as { until: number }).until;
    expect(until - before).toBeGreaterThanOrEqual(52530 * 1000);

    // The TTL is when we go and ask again, so one bad header cannot lock the
    // site out for a day with no way back.
    expect(cooldown.ttlSeconds).toBe(15 * 60);
  });

  it("drops the countdown once the wait is measured in hours", async () => {
    upstream().mockRejectedValueOnce(
      new spotify.SpotifyApiError("spotify_rate_limited", 429, { retryAfterSeconds: 52531 })
    );
    const err = await loadPlaylist(URL_A).catch((e) => e);

    // "Try again in about 52531s" is not a wait, it is a dismissal. The host
    // gets told what is actually true instead, and the header keeps the number.
    expect(err.code).toBe("spotify_quota_exhausted");
    expect(err.params).toBeUndefined();
    expect(err.retryAfterSeconds).toBeGreaterThan(52000);
  });

  it("keeps the countdown when the wait is short enough to sit through", async () => {
    upstream().mockRejectedValueOnce(
      new spotify.SpotifyApiError("spotify_rate_limited", 429, { retryAfterSeconds: 45 })
    );
    const err = await loadPlaylist(URL_A).catch((e) => e);

    expect(err.code).toBe("spotify_cooldown");
    expect(err.params).toMatchObject({ seconds: 45 });
  });

  it("caps an absurd Retry-After at a day rather than trusting it", async () => {
    // The stored value is what the host is told, so it follows Spotify — but
    // only so far. A malformed or hostile header must not be able to park every
    // uncached playlist for a week; a day is past any real quota window.
    const before = Date.now();
    upstream().mockRejectedValueOnce(
      new spotify.SpotifyApiError("spotify_rate_limited", 429, { retryAfterSeconds: 30 * 86400 })
    );
    await expect(loadPlaylist(URL_A)).rejects.toThrow();

    const cooldown = kv.writes.find((w) => w.key === "spotify:cooldown")!;
    const until = (cooldown.value as { until: number }).until;
    expect(until - before).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    expect(until - before).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("applies a floor when Spotify sends no Retry-After at all", async () => {
    upstream().mockRejectedValueOnce(new spotify.SpotifyApiError("spotify_rate_limited", 429));
    await expect(loadPlaylist(URL_A)).rejects.toThrow();

    const cooldown = kv.writes.find((w) => w.key === "spotify:cooldown");
    expect(cooldown!.ttlSeconds).toBeGreaterThanOrEqual(30);
  });

  it("tells the user to wait rather than to fix their URL", async () => {
    upstream().mockRejectedValueOnce(new spotify.SpotifyApiError("spotify_rate_limited", 429, { retryAfterSeconds: 60 }));
    const err = await loadPlaylist(URL_A).catch((e) => e);

    expect(err.message).toMatch(/rate limit/i);
    expect(err.message).not.toMatch(/public/i);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("global upstream budget", () => {
  beforeEach(() => {
    process.env.SPOTIFY_MAX_LOADS_PER_MINUTE = "3";
  });

  afterEach(() => {
    delete process.env.SPOTIFY_MAX_LOADS_PER_MINUTE;
  });

  it("refuses new playlists past the per-minute ceiling before Spotify does", async () => {
    for (let i = 0; i < 3; i++) {
      upstream().mockResolvedValue(upstreamResult([`t${i}`]));
      await loadPlaylist(`https://open.spotify.com/playlist/pl${i}aaaaaaaaa`);
    }
    expect(upstreamCalls()).toBe(3);

    await expect(
      loadPlaylist("https://open.spotify.com/playlist/pl9aaaaaaaaa")
    ).rejects.toMatchObject({ status: 429 });

    // The point is that the 4th never left the building.
    expect(upstreamCalls()).toBe(3);
  });

  it("does not spend budget on cached playlists", async () => {
    await loadPlaylist(URL_A);

    // Ten more reads of an already-known playlist, against a ceiling of 3.
    for (let i = 0; i < 10; i++) {
      await expect(loadPlaylist(URL_A)).resolves.toMatchObject({ totalTracks: 2 });
    }
    expect(upstreamCalls()).toBe(1);
  });

  it("tells the user to wait rather than to fix their URL", async () => {
    for (let i = 0; i < 3; i++) {
      await loadPlaylist(`https://open.spotify.com/playlist/pl${i}aaaaaaaaa`);
    }

    const err = await loadPlaylist("https://open.spotify.com/playlist/pl9aaaaaaaaa").catch(
      (e) => e
    );
    expect(err.message).toMatch(/try again/i);
    expect(err.message).not.toMatch(/public/i);
  });

  it("fails open when KV is unavailable, rather than blocking every load", async () => {
    kv.flags.failReads = true;
    kv.flags.failWrites = true;

    // A budget that can't be read must not become a budget of zero.
    await expect(loadPlaylist(URL_A)).resolves.toMatchObject({ totalTracks: 2 });
  });
});

describe("cache hit-rate stats", () => {
  it("counts a cold load as a miss and a repeat as a hit", async () => {
    await loadPlaylist(URL_A);
    await loadPlaylist(URL_A);
    await loadPlaylist(URL_A);

    const stats = await getCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it("counts a cached 404 as a hit — it answered without touching Spotify", async () => {
    upstream().mockRejectedValue(new spotify.SpotifyApiError("playlist_not_found", 404));
    await expect(loadPlaylist(URL_A)).rejects.toThrow();
    await expect(loadPlaylist(URL_A)).rejects.toThrow();

    const stats = await getCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it("reports replayed 404s separately, so a dead link can't inflate the rate", async () => {
    // Two loads of a good playlist (1 miss, 1 hit) and three retries of a dead
    // one. The raw rate reads 0.800, which without this breakdown is
    // indistinguishable from a cache doing genuinely well.
    await loadPlaylist(URL_A);
    await loadPlaylist(URL_A);

    upstream().mockRejectedValue(new spotify.SpotifyApiError("playlist_not_found", 404));
    await expect(loadPlaylist(URL_B)).rejects.toThrow();
    await expect(loadPlaylist(URL_B)).rejects.toThrow();
    await expect(loadPlaylist(URL_B)).rejects.toThrow();

    const stats = await getCacheStats();
    expect(stats.hits).toBe(3);
    expect(stats.negativeHits).toBe(2);
    // Subtracting them leaves the rate that actually describes real playlists.
    expect(stats.hits - stats.negativeHits).toBe(1);
  });

  it("reports a zero rate rather than NaN before anything has loaded", async () => {
    expect((await getCacheStats()).hitRate).toBe(0);
    expect((await getCacheStats()).negativeHits).toBe(0);
  });
});

describe("miss log", () => {
  /**
   * The log viewer attributes a line to whichever request the instance was
   * serving, which under concurrent invocations can be a route that never
   * calls this file. The line has to identify its own caller, or reading the
   * method off the log row points at a code path that cannot produce it.
   */
  it("names the caller that triggered the upstream load", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await loadPlaylist(URL_A, "room-submit");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("source=room-submit"));
    log.mockRestore();
  });

  it("says so when a caller does not identify itself", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await loadPlaylist(URL_A);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("source=unknown"));
    log.mockRestore();
  });
});

describe("sampled playlists", () => {
  it("caches a truncated playlist for less time than a complete one", async () => {
    upstream().mockResolvedValue(upstreamResult(["a"], true));
    await loadPlaylist(URL_A);
    const sampledTtl = kv.writes.find((w) => w.key.startsWith("playlist:"))!.ttlSeconds;

    kv.mem.clear();
    kv.writes.length = 0;
    __resetInFlightForTests();
    upstream().mockResolvedValue(upstreamResult(["a"], false));
    await loadPlaylist(URL_A);
    const fullTtl = kv.writes.find((w) => w.key.startsWith("playlist:"))!.ttlSeconds;

    // A truncated entry is one random draw of 500. Holding it as long as a
    // complete playlist would mean the same 500 songs all evening, which is
    // the thing sampling exists to avoid.
    expect(sampledTtl).toBeLessThan(fullTtl);
  });
});

describe("KV degradation", () => {
  it("still loads when the cache cannot be read", async () => {
    kv.flags.failReads = true;

    await expect(loadPlaylist(URL_A)).resolves.toMatchObject({ totalTracks: 2 });
  });

  it("still loads when the cache cannot be written", async () => {
    kv.flags.failWrites = true;

    await expect(loadPlaylist(URL_A)).resolves.toMatchObject({ totalTracks: 2 });
  });
});
