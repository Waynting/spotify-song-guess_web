import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The token cache lives at module scope, so every test re-imports lib/spotify
 * through vi.resetModules() to get a cache that starts cold. Sharing one
 * import across tests would let the first test's cached token silently
 * satisfy the rest, and they'd pass no matter what the code did.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const PLAYLIST_URL = "https://open.spotify.com/playlist/abc123";

interface RouteBehaviour {
  /** HTTP status for the playlist/tracks calls. 200 unless overridden. */
  playlistStatus?: number;
  /** Seconds reported by the token endpoint. */
  expiresIn?: number;
  /**
   * Size of the fake playlist. The tracks endpoint serves it in pages and
   * advertises `next` until it's exhausted, so the pagination loop — and the
   * cap on it — are actually exercised rather than short-circuited by an
   * empty first page.
   */
  totalTracks?: number;
  /** Retry-After header value returned alongside a non-200 status. */
  retryAfter?: string;
  /**
   * Serve the playlist object with an empty `items`, which is what Spotify
   * would do if PLAYLIST_FIELDS ever named the embedded page wrongly. Not an
   * error, just a silently empty playlist — hence the fallback it exercises.
   */
  emptyEmbeddedPage?: boolean;
  /**
   * Serve the embedded page without a `next` cursor. Spotify sends one, but a
   * `fields` projection is a place it could go missing, and the arithmetic
   * fallback in readTrackPage is the only thing standing between that and a
   * playlist silently truncated to its first 100 tracks.
   */
  omitEmbeddedNext?: boolean;
  /**
   * Every entry comes back as `{track: null}` and `next` never terminates —
   * the shape a playlist of local files takes if upstream also miscounts.
   * Nothing filters into `tracks`, so only the page bound can stop the loop.
   */
  allTracksNull?: boolean;
  /**
   * Status for the playlist *metadata* call only, leaving the tracks endpoint
   * healthy — so "a failed head reads no pages" is tested against a tracks
   * endpoint that would happily have served them.
   */
  metadataStatus?: number;
}

/**
 * Only the fields lib/spotify.ts actually reads. Annotating the mock's return
 * type explicitly is required: without it TS tries to infer one union from
 * every branch and hits circular inference on the async json/text members.
 */
interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function noHeaders(): MockResponse["headers"] {
  return { get: () => null };
}

function fakeSpotifyTrack(index: number) {
  return {
    id: `track-${index}`,
    name: `Song ${index}`,
    artists: [{ name: "Artist" }],
    duration_ms: 200000,
    album: { name: "Album", images: [] },
  };
}

/**
 * Routes fetch by URL and counts token mints, which is the thing under test —
 * "did we go back to Spotify for a new token" is not observable any other way.
 * Also counts track-page requests, since "how many times did we hit Spotify to
 * read one playlist" is the number the whole cache exists to hold down.
 */
function installFetchMock(behaviour: RouteBehaviour = {}) {
  const {
    playlistStatus = 200,
    expiresIn = 3600,
    totalTracks = 0,
    retryAfter,
    metadataStatus,
    emptyEmbeddedPage = false,
    omitEmbeddedNext = false,
    allTracksNull = false,
  } = behaviour;
  let tokenRequests = 0;
  let tokenSerial = 0;
  let trackPageRequests = 0;
  let metadataRequests = 0;
  const bearersSeen: string[] = [];
  const offsetsSeen: number[] = [];
  const metadataUrls: string[] = [];

  /**
   * Spotify's paging shape, served identically by the playlist object and by
   * the tracks endpoint — which is the property fetchPlaylistHead relies on.
   * Recording the offset here rather than at the call site is what keeps the
   * embedded page visible as page zero in `offsetsSeen`.
   */
  function pagingObject(offset: number, limit: number) {
    offsetsSeen.push(offset);
    const pageEnd = Math.min(offset + limit, totalTracks);
    const span = allTracksNull ? limit : Math.max(0, pageEnd - offset);
    const items = Array.from({ length: span }, (_, i) => ({
      track: allTracksNull ? null : fakeSpotifyTrack(offset + i),
    }));
    return {
      items,
      total: totalTracks,
      next:
        allTracksNull || pageEnd < totalTracks
          ? `https://api.spotify.com/v1/playlists/abc123/tracks?limit=${limit}&offset=${pageEnd}`
          : null,
    };
  }

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit): Promise<MockResponse> => {
    const href = typeof url === "string" ? url : url.toString();

    if (href === TOKEN_URL) {
      tokenRequests++;
      tokenSerial++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: noHeaders(),
        json: async () => ({ access_token: `token-${tokenSerial}`, expires_in: expiresIn }),
        text: async () => "",
      };
    }

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth) bearersSeen.push(auth.replace("Bearer ", ""));

    if (playlistStatus !== 200) {
      return {
        ok: false,
        status: playlistStatus,
        statusText: "Error",
        headers: { get: (name) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
        json: async () => ({ error: { message: "nope" } }),
        text: async () => "nope",
      };
    }

    if (href.includes("/tracks")) {
      trackPageRequests++;
      const parsed = new URL(href);
      const limit = Number(parsed.searchParams.get("limit") ?? 100);
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const paging = pagingObject(offset, limit);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: noHeaders(),
        json: async () => paging,
        text: async () => "",
      };
    }

    if (metadataStatus !== undefined && metadataStatus !== 200) {
      return {
        ok: false,
        status: metadataStatus,
        statusText: "Error",
        headers: noHeaders(),
        json: async () => ({ error: { message: "metadata failed" } }),
        text: async () => "metadata failed",
      };
    }

    metadataRequests++;
    metadataUrls.push(href);
    // The playlist object carries the first page of tracks. Spotify decides how
    // many — there is no `limit` to send it — and it is 100, the same as
    // TRACKS_PAGE_LIMIT. The old fake returned an empty `items` here, which is
    // what let a second request for the identical page look necessary.
    const embedded = emptyEmbeddedPage
      ? { items: [], total: totalTracks, next: null }
      : pagingObject(0, 100);
    if (omitEmbeddedNext) delete (embedded as { next?: unknown }).next;
    if (emptyEmbeddedPage) offsetsSeen.push(0);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: noHeaders(),
      json: async () => ({ id: "abc123", name: "Test Playlist", tracks: embedded }),
      text: async () => "",
    };
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    tokenRequests: () => tokenRequests,
    bearersSeen: () => bearersSeen,
    trackPageRequests: () => trackPageRequests,
    metadataRequests: () => metadataRequests,
    metadataUrls: () => metadataUrls,
    /** What one cold load actually costs the app's shared Spotify quota. */
    upstreamRequests: () => metadataRequests + trackPageRequests,
    offsetsSeen: () => offsetsSeen,
  };
}

async function freshSpotify() {
  vi.resetModules();
  return import("@/lib/spotify");
}

describe("Spotify client-credentials token cache", () => {
  beforeEach(() => {
    process.env.SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints a token on the first playlist load", async () => {
    const probe = installFetchMock();
    const { getPlaylistWithTracks } = await freshSpotify();

    await getPlaylistWithTracks(PLAYLIST_URL);

    expect(probe.tokenRequests()).toBe(1);
  });

  it("reuses the cached token across playlist loads instead of re-minting", async () => {
    const probe = installFetchMock();
    const { getPlaylistWithTracks } = await freshSpotify();

    await getPlaylistWithTracks(PLAYLIST_URL);
    await getPlaylistWithTracks(PLAYLIST_URL);
    await getPlaylistWithTracks(PLAYLIST_URL);

    // Without the cache this would be 3 — one mint per load.
    expect(probe.tokenRequests()).toBe(1);
    expect(new Set(probe.bearersSeen())).toEqual(new Set(["token-1"]));
  });

  it("treats a token inside the expiry buffer as already expired", async () => {
    // expires_in equals the 60s safety buffer, so the usable lifetime is zero
    // and the second load must go back for a fresh token rather than hand out
    // one that could die mid-pagination.
    const probe = installFetchMock({ expiresIn: 60 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await getPlaylistWithTracks(PLAYLIST_URL);
    await getPlaylistWithTracks(PLAYLIST_URL);

    expect(probe.tokenRequests()).toBe(2);
  });

  it("does not cache across module instances (guards the test isolation itself)", async () => {
    const first = installFetchMock();
    const a = await freshSpotify();
    await a.getPlaylistWithTracks(PLAYLIST_URL);
    expect(first.tokenRequests()).toBe(1);

    const second = installFetchMock();
    const b = await freshSpotify();
    await b.getPlaylistWithTracks(PLAYLIST_URL);
    expect(second.tokenRequests()).toBe(1);
  });
});

describe("Spotify token invalidation on 401", () => {
  beforeEach(() => {
    process.env.SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears the cache and retries once with a fresh token", async () => {
    // Critical gap from the eng review: a rejected token left in the cache
    // would be replayed by this instance until it expired on its own.
    const probe = installFetchMock({ playlistStatus: 401 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await expect(getPlaylistWithTracks(PLAYLIST_URL)).rejects.toThrow();

    // Two mints: the original, plus one after the 401 invalidated it.
    expect(probe.tokenRequests()).toBe(2);
    expect(probe.bearersSeen()).toContain("token-1");
    expect(probe.bearersSeen()).toContain("token-2");
  });

  it("gives up after the single retry rather than looping forever", async () => {
    const probe = installFetchMock({ playlistStatus: 401 });
    const { getPlaylistWithTracks, SpotifyApiError } = await freshSpotify();

    await expect(getPlaylistWithTracks(PLAYLIST_URL)).rejects.toBeInstanceOf(SpotifyApiError);

    expect(probe.tokenRequests()).toBe(2);
  });

  it("does not retry or invalidate on a 404 — the playlist is simply unreachable", async () => {
    const probe = installFetchMock({ playlistStatus: 404 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await expect(getPlaylistWithTracks(PLAYLIST_URL)).rejects.toThrow();

    expect(probe.tokenRequests()).toBe(1);
  });

  it("keeps a usable cached token when a later load 404s", async () => {
    const probe = installFetchMock();
    const { getPlaylistWithTracks } = await freshSpotify();
    await getPlaylistWithTracks(PLAYLIST_URL);

    // Same module instance, now failing with 404.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL): Promise<MockResponse> => {
        const href = typeof url === "string" ? url : url.toString();
        if (href === TOKEN_URL) throw new Error("should not re-mint on 404");
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: noHeaders(),
          json: async () => ({ error: { message: "no" } }),
          text: async () => "no",
        };
      })
    );

    await expect(getPlaylistWithTracks(PLAYLIST_URL)).rejects.toThrow();
    expect(probe.tokenRequests()).toBe(1);
  });
});

describe("SpotifyApiError", () => {
  it("carries the upstream status so callers can distinguish 401 from 404", async () => {
    const { SpotifyApiError } = await freshSpotify();
    const err = new SpotifyApiError("playlist_load_failed", 401);

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.code).toBe("playlist_load_failed");
  });

  it("keeps the log message English, and the upstream detail out of the code", async () => {
    const { SpotifyApiError } = await freshSpotify();
    const err = new SpotifyApiError("playlist_not_found", 404, {
      detail: "404 Not Found",
    });

    // The sentence a player reads is rendered from `code` on their own device
    // (lib/error-messages.ts). This string is for the server log, so it stays
    // English and is allowed to carry upstream noise the client never sees.
    expect(err.message).toContain("404 Not Found");
    expect(err.code).toBe("playlist_not_found");
  });
});

/**
 * Upstream request *count* per playlist load is the number that decides whether
 * the app's shared Spotify quota survives a busy evening, and nothing used to
 * assert it. These lock it down.
 */
describe("playlist pagination cost", () => {
  beforeEach(() => {
    process.env.SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads 100 tracks per page, not 50", async () => {
    const probe = installFetchMock({ totalTracks: 100 });
    const { getPlaylistWithTracks } = await freshSpotify();

    const { tracks } = await getPlaylistWithTracks(PLAYLIST_URL);

    expect(tracks).toHaveLength(100);
    // At limit=50 this same playlist would have cost two pages. It now costs
    // no track-endpoint call at all: the one page it needs rides along with
    // the playlist object.
    expect(probe.trackPageRequests()).toBe(0);
    expect(probe.upstreamRequests()).toBe(1);
  });

  it("never fetches the first page twice", async () => {
    const probe = installFetchMock({ totalTracks: 40 });
    const { getPlaylistWithTracks } = await freshSpotify();

    const { tracks } = await getPlaylistWithTracks(PLAYLIST_URL);

    // The metadata call already carried these 40 tracks, and the app used to
    // parse them, drop them, and spend a second request on /tracks?offset=0
    // for the identical page. On the Spotify dashboard that duplicate was
    // ~45% of every request the site made.
    expect(tracks).toHaveLength(40);
    expect(probe.upstreamRequests()).toBe(1);
    expect(probe.offsetsSeen()).toEqual([0]);
  });

  it("falls back to the tracks endpoint if the embedded page ever stops arriving", async () => {
    // The whole saving rests on PLAYLIST_FIELDS naming the embedded page in a
    // way Spotify still honours. If that ever stops being true it does not
    // error — the response just comes back without `items`, and every playlist
    // on the site loads as empty. One extra request is the right price for not
    // having that be the failure mode.
    const probe = installFetchMock({ totalTracks: 120, emptyEmbeddedPage: true });
    const { getPlaylistWithTracks } = await freshSpotify();

    const { tracks } = await getPlaylistWithTracks(PLAYLIST_URL);

    expect(tracks).toHaveLength(120);
    expect(probe.offsetsSeen()).toEqual([0, 0, 100]);
  });

  it("stops at MAX_TRACK_PAGES even if upstream keeps offering a next page", async () => {
    // `tracks.length` is the wrong brake on its own: entries filtered out as
    // local or unavailable never grow it, so a playlist of nothing but those
    // plus a `next` that never ends would page forever against the shared
    // quota. The head is page one, so at most MAX_PLAYLIST_TRACKS/100 calls total.
    const probe = installFetchMock({ totalTracks: 400, allTracksNull: true });
    const { getPlaylistWithTracks, MAX_PLAYLIST_TRACKS } = await freshSpotify();

    const { tracks } = await getPlaylistWithTracks(PLAYLIST_URL);

    expect(tracks).toHaveLength(0);
    expect(probe.upstreamRequests()).toBeLessThanOrEqual(MAX_PLAYLIST_TRACKS / 100);
  });

  it("keeps paginating when the embedded page arrives without a `next`", async () => {
    // `next` is what the loop normally steers by, and the embedded page is the
    // one page we cannot ask Spotify for a `limit` on — so if a projection ever
    // drops the cursor, arithmetic against `total` is all that stops the game
    // being silently cut to its first 100 tracks. Silent truncation is the
    // failure this guards: no error, just a shorter playlist than the host has.
    const probe = installFetchMock({ totalTracks: 250, omitEmbeddedNext: true });
    const { getPlaylistWithTracks } = await freshSpotify();

    const { tracks, truncated } = await getPlaylistWithTracks(PLAYLIST_URL);

    expect(tracks).toHaveLength(250);
    expect(truncated).toBe(false);
    expect(probe.offsetsSeen()).toEqual([0, 100, 200]);
  });

  it("asks Spotify to send the first page with the playlist", async () => {
    const probe = installFetchMock({ totalTracks: 10 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await getPlaylistWithTracks(PLAYLIST_URL);

    // Drop `tracks(...)` from the projection and Spotify answers without the
    // embedded page: no error, every playlist just quietly reads as empty.
    const [metadataUrl] = probe.metadataUrls();
    expect(metadataUrl).toContain("fields=");
    expect(metadataUrl).toContain("items(track(");
  });

  it("stops at MAX_PLAYLIST_TRACKS instead of following `next` forever", async () => {
    const probe = installFetchMock({ totalTracks: 5000 });
    const { getPlaylistWithTracks, MAX_PLAYLIST_TRACKS } = await freshSpotify();

    const { tracks, truncated } = await getPlaylistWithTracks(PLAYLIST_URL);

    expect(tracks).toHaveLength(MAX_PLAYLIST_TRACKS);
    expect(truncated).toBe(true);
    // Uncapped, a 5,000-track playlist was 50 requests against a quota shared
    // by every user of the site. Counted end to end, head included, so the
    // merge cannot quietly move a request out of this budget and into another.
    expect(probe.upstreamRequests()).toBe(MAX_PLAYLIST_TRACKS / 100);
  });

  it("samples an oversized playlist across its whole length, not just the front", async () => {
    const probe = installFetchMock({ totalTracks: 5000 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await getPlaylistWithTracks(PLAYLIST_URL);

    // Taking the first 500 would read offsets 0,100,200,300,400 every time —
    // the same songs every game, and whatever the owner happened to add first.
    const offsets = probe.offsetsSeen();
    expect(offsets).toContain(0); // page 0 is how we learn the length
    expect(Math.max(...offsets)).toBeGreaterThan(400);
    expect(new Set(offsets).size).toBe(offsets.length); // no page read twice
  });

  it("draws a different sample on a later load of the same big playlist", async () => {
    const { getPlaylistWithTracks } = await freshSpotify();

    // Ten draws of 4 pages from ~49 candidates. Identical results every time
    // would mean the sampling is not actually random.
    const draws = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const probe = installFetchMock({ totalTracks: 5000 });
      await getPlaylistWithTracks(PLAYLIST_URL);
      draws.add(probe.offsetsSeen().slice().sort((a, b) => a - b).join(","));
    }

    expect(draws.size).toBeGreaterThan(1);
  });

  it("reads a playlist that fits in full and in order", async () => {
    const probe = installFetchMock({ totalTracks: 250 });
    const { getPlaylistWithTracks } = await freshSpotify();

    const { tracks, truncated } = await getPlaylistWithTracks(PLAYLIST_URL);

    // Under the cap nothing is sampled or shuffled — the host's ordering is
    // preserved, and the game page does its own shuffling downstream.
    expect(truncated).toBe(false);
    expect(tracks).toHaveLength(250);
    expect(tracks[0].id).toBe("track-0");
    expect(tracks[249].id).toBe("track-249");
    // Offset 0 is the embedded page, so three pages still cost three calls —
    // the saving is the metadata call that used to sit on top of them.
    expect(probe.offsetsSeen()).toEqual([0, 100, 200]);
    expect(probe.upstreamRequests()).toBe(3);
  });

  it("reports truncated=false for a playlist that fits", async () => {
    installFetchMock({ totalTracks: 120 });
    const { getPlaylistWithTracks } = await freshSpotify();

    const { tracks, truncated } = await getPlaylistWithTracks(PLAYLIST_URL);

    expect(tracks).toHaveLength(120);
    expect(truncated).toBe(false);
  });

  it("spends no track pages at all when the playlist call fails", async () => {
    // These two used to run under one Promise.all, so a metadata failure
    // returned while the pagination loop was still walking — quota spent on a
    // response nobody was waiting for, and a console.error with no request
    // context, which is why "Spotify tracks fetch error" surfaced in
    // /api/preview's logs. An AbortController cut it down to whatever was
    // already in flight. Merging the head into one request removed the
    // concurrency instead of managing it, so the floor is now zero: the tracks
    // endpoint here is healthy and never gets asked.
    const probe = installFetchMock({ totalTracks: 5000, metadataStatus: 500 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await expect(getPlaylistWithTracks(PLAYLIST_URL)).rejects.toThrow();

    // Settle long enough that a loop still running in the background would
    // have walked several pages by now.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(probe.trackPageRequests()).toBe(0);
  });
});

describe("Spotify 429 handling", () => {
  beforeEach(() => {
    process.env.SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the Retry-After seconds rather than flattening them into the message", async () => {
    installFetchMock({ playlistStatus: 429, retryAfter: "42" });
    const { getPlaylistWithTracks, SpotifyApiError } = await freshSpotify();

    const err = await getPlaylistWithTracks(PLAYLIST_URL).catch((e) => e);

    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(42);
  });

  it("never blames the user's playlist for a quota error", async () => {
    installFetchMock({ playlistStatus: 429 });
    const { getPlaylistWithTracks } = await freshSpotify();

    const err = await getPlaylistWithTracks(PLAYLIST_URL).catch((e) => e);

    // The old message told throttled hosts to check their URL was public,
    // which sent them straight back into retrying against a spent quota.
    expect(err.message).not.toMatch(/public/i);
    expect(err.message).toMatch(/rate limit/i);
  });

  it("does not retry a 429 — retrying is what exhausted the quota", async () => {
    const probe = installFetchMock({ playlistStatus: 429 });
    const { getPlaylistWithTracks } = await freshSpotify();

    await expect(getPlaylistWithTracks(PLAYLIST_URL)).rejects.toThrow();

    expect(probe.tokenRequests()).toBe(1);
  });

  it("ignores a malformed Retry-After instead of producing a NaN cooldown", async () => {
    installFetchMock({ playlistStatus: 429, retryAfter: "soon" });
    const { getPlaylistWithTracks } = await freshSpotify();

    const err = await getPlaylistWithTracks(PLAYLIST_URL).catch((e) => e);

    expect(err.retryAfterSeconds).toBeUndefined();
  });
});
