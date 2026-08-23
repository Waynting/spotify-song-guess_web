import { Track } from "@/types";
import { errorMessage, type AppErrorCode } from "@/lib/error-messages";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

export interface SpotifyApiErrorOptions {
  /**
   * Seconds from Spotify's Retry-After header on a 429. lib/playlist-cache.ts
   * turns this into a global cooldown, so it has to survive the throw rather
   * than being flattened into the message.
   */
  retryAfterSeconds?: number;
  /** Fills the message's placeholders — `{seconds}` on the cooldown codes. */
  params?: Record<string, string | number>;
  /**
   * Upstream detail worth having in the server log and nowhere else: Spotify's
   * own message, the status line. Appended to `message`, never sent to the
   * client, because the client renders `code` in its own language.
   */
  detail?: string;
}

/**
 * Carries the HTTP status and an app error code alongside the message, so
 * callers can react to 401 vs 404 and the client can render the failure in the
 * reader's language (see lib/error-messages.ts).
 *
 * `message` is derived from the code in English and exists for logs. Route
 * handlers must send `code`, not this string.
 */
export class SpotifyApiError extends Error {
  readonly retryAfterSeconds?: number;
  readonly params?: Record<string, string | number>;

  constructor(
    readonly code: AppErrorCode,
    readonly status: number,
    options: SpotifyApiErrorOptions = {}
  ) {
    const english = errorMessage(code, "en", { params: options.params });
    super(options.detail ? `${english} [${options.detail}]` : english);
    this.name = "SpotifyApiError";
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.params = options.params;
  }
}

/**
 * Spotify sends Retry-After (seconds) on a 429. Read defensively: it is absent
 * on every other status, and a malformed value must not turn a real rate-limit
 * error into a NaN cooldown that never expires.
 */
function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * A 429 here is `QUOTA_EXCEEDED` against the *app's* client id, not the
 * caller's IP — every user of the site shares one quota. The old message said
 * "Make sure the playlist is public", which is not just unhelpful but actively
 * harmful: it reads as "your URL is wrong", so the host edits it and submits
 * again, spending more of the quota that is already exhausted. Both
 * translations of this code are written to that constraint — see
 * lib/error-messages.ts.
 */
const RATE_LIMITED_CODE = "spotify_rate_limited" as const;

/**
 * Client-credentials tokens live for an hour, but every call used to mint a
 * fresh one — doubling upstream requests on the hottest path.
 *
 * Cached at module scope, which on Vercel means per lambda instance rather
 * than globally. A shared Upstash cache would cut token requests further but
 * was rejected deliberately: a token is the one thing with no fallback, so a
 * KV outage on this path would take down playlist loading entirely.
 * Warm-instance savings are worth more than the remainder.
 *
 * lib/playlist-cache.ts does put playlists in KV, which is not a reversal of
 * that call — every KV operation there is wrapped so a failure degrades to a
 * cache miss. This module stays a pure Spotify client with no KV import.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Shaved off the reported lifetime so a token that is seconds from expiring
 * is never handed to a caller that is about to make several paginated
 * requests with it.
 */
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

/**
 * Drop the cached token. MUST be called whenever Spotify rejects it (401):
 * without this, a single revoked or clock-skewed token keeps getting replayed
 * by this instance until it expires on its own — up to an hour of every
 * playlist request failing while other instances are fine.
 */
function invalidateClientAccessToken(): void {
  cachedToken = null;
}

/**
 * Get access token using Client Credentials Flow (for public playlists)
 * This doesn't require user authentication
 */
async function getClientAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new SpotifyApiError("spotify_not_configured", 500, {
      detail: "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are unset",
    });
  }

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    console.error("Spotify token error:", response.status, errorText);
    // Leave the cache untouched on failure — an existing (possibly still
    // valid) entry is more useful than clearing it because a refresh blipped.
    throw new SpotifyApiError(
      response.status === 429 ? RATE_LIMITED_CODE : "spotify_auth_failed",
      response.status,
      {
        retryAfterSeconds: parseRetryAfter(response),
        detail: `token endpoint: ${response.status} ${errorText}`,
      }
    );
  }

  const data = await response.json();
  // Spotify reports expires_in in seconds; fall back to the documented 1h
  // default if it's ever missing so we never cache with a NaN expiry.
  const lifetimeSeconds =
    typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedToken = {
    value: data.access_token,
    expiresAt:
      Date.now() + Math.max(0, lifetimeSeconds - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000,
  };
  return cachedToken.value;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  duration_ms: number;
  // No preview_url. Spotify deprecated it in Nov 2024 and it comes back null
  // for every track on Client Credentials — measured 0/20 across four markets.
  // Clips come from lib/preview-cache.ts (iTunes, then Deezer) instead.
  popularity?: number; // 0-100, used by the Mixed Playlist Mode taste card
  album: {
    name: string;
    images: Array<{ url: string }>;
  };
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner?: {
    id: string;
    display_name?: string;
  };
  tracks: {
    items: Array<{
      track: SpotifyTrack | null;
    }>;
    total: number;
    /**
     * Spotify returns the first page of tracks inside the playlist object, as
     * a full paging object. Declared here because fetchPlaylistHead reads it
     * instead of spending a second request re-fetching the same page.
     */
    next?: string | null;
  };
}

/**
 * Check if playlist ID is a Spotify editorial/algorithm playlist
 * Spotify editorial playlists have IDs starting with "37i9"
 * These playlists return 404 for new/development apps after Nov 2024
 */
export function isSpotifyEditorial(playlistId: string): boolean {
  return playlistId.startsWith("37i9");
}

/**
 * Parse Spotify playlist URL to extract playlist ID
 */
export function parsePlaylistUrl(url: string): string | null {
  // Support formats:
  // https://open.spotify.com/playlist/{id}
  // spotify:playlist:{id}
  const patterns = [
    /playlist\/([a-zA-Z0-9]+)/,
    /spotify:playlist:([a-zA-Z0-9]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Spotify allows up to 100 items per page here. This asked for 50, which meant
 * every playlist cost exactly twice the upstream requests it needed to — the
 * single cheapest thing to change when the app's shared quota is the bottleneck.
 */
const TRACKS_PAGE_LIMIT = 100;

/**
 * Hard stop on how deep we paginate. The loop used to follow Spotify's `next`
 * cursor with no bound at all, so one 4,000-track playlist was 40 upstream
 * requests — for a game that then shuffles and plays at most 50 of them
 * (SONG_COUNTS in app/page.tsx), or samples 8 per player in Mixed mode.
 *
 * 500 covers "All" for any playlist a party would realistically use while
 * bounding the worst case at 5 upstream calls — the merged head is one of
 * them, so the whole read is 5, not 5 plus a metadata call. Beyond it we take
 * the first 500 and report `truncated`, rather than silently pretending we
 * read the whole thing.
 */
export const MAX_PLAYLIST_TRACKS = 500;

/** How many pages MAX_PLAYLIST_TRACKS works out to. */
const MAX_TRACK_PAGES = Math.ceil(MAX_PLAYLIST_TRACKS / TRACKS_PAGE_LIMIT);

/**
 * What we ask Spotify to serialise for one page of tracks.
 *
 * Everything listed is read by convertSpotifyTrack or by lib/playlist-cache.ts.
 * Anything not listed is bytes we parse and drop, and on a 500-track playlist
 * the default response is mostly fields nothing here has ever looked at.
 */
const TRACK_PAGE_FIELDS =
  "total,next,items(track(id,name,duration_ms,popularity,artists(name),album(name,images(url))))";

/**
 * The same projection, reached through the playlist object.
 *
 * `GET /playlists/{id}` returns the first page of tracks embedded in its reply
 * whether we ask for it or not. The app used to fetch that, parse it, throw it
 * away, and then spend a second request on `/playlists/{id}/tracks?offset=0`
 * for the identical page. On the Spotify dashboard that duplicate was ~45% of
 * every request the site made: ~1.75k metadata calls against ~2.1k track
 * pages, i.e. about 1.2 pages per playlist, so for the great majority of
 * playlists the embedded page was the whole job and the second request bought
 * nothing. Naming `tracks` here is what lets fetchPlaylistTracks start at page
 * two, and it saves exactly one upstream call on every cold load.
 */
const PLAYLIST_FIELDS = `id,name,tracks(${TRACK_PAGE_FIELDS})`;

interface TrackPage {
  tracks: SpotifyTrack[];
  /** Length of the whole playlist, not of this page. */
  total: number;
  /**
   * Offset to read next, or null when this was the last page.
   *
   * This used to be Spotify's raw `next` URL, but the only question the caller
   * ever asked it was "is there another page" — it then derived the offset
   * itself from TRACKS_PAGE_LIMIT. That arithmetic is wrong the moment a page
   * comes back a different size than the constant says, which is exactly what
   * the embedded first page can do: it arrives with the playlist object and
   * there is no `limit` to send it. Derive the offset from the page we were
   * actually handed.
   */
  nextOffset: number | null;
  /**
   * Entries Spotify sent on this page, before nulls were filtered out of
   * `tracks`. Zero means the page itself was absent, which is a different
   * thing from a page whose every entry was a local file — and the only
   * signal that separates them.
   */
  rawCount: number;
}

/**
 * Reads Spotify's paging shape, which is identical on the playlist object and
 * on the tracks endpoint — so the merged first page and every page after it
 * are interpreted by the same code rather than by two rules that can drift.
 */
function readTrackPage(
  paging:
    | {
        items?: Array<{ track: SpotifyTrack | null }> | null;
        total?: number;
        next?: string | null;
      }
    | null
    | undefined,
  offset: number
): TrackPage {
  const rawItems = Array.isArray(paging?.items) ? paging.items : [];
  const tracks = rawItems
    .map((item) => item?.track)
    .filter((track): track is SpotifyTrack => track != null);
  const total =
    typeof paging?.total === "number" ? paging.total : offset + rawItems.length;
  const consumed = offset + rawItems.length;

  // `next` decides it whenever Spotify sends one. The arithmetic is a fallback
  // rather than the rule because `total` counts entries — local files and
  // unavailable tracks included — that get filtered out of `tracks` above, so
  // comparing it against what we kept would read pages that aren't there.
  // Against the *raw* page length it is exact, and erring towards one extra
  // request is the right way round: stopping early shortens someone's game and
  // says nothing about it.
  const hasMore =
    rawItems.length > 0 && (paging?.next != null || consumed < total);

  return {
    tracks,
    total,
    nextOffset: hasMore ? consumed : null,
    rawCount: rawItems.length,
  };
}

/** One page of playlist tracks. All the upstream error handling lives here. */
async function fetchTrackPage(
  playlistId: string,
  accessToken: string,
  offset: number
): Promise<TrackPage> {
  // Don't specify market when using user token - let Spotify use user's country
  const url = `${SPOTIFY_API_BASE}/playlists/${playlistId}/tracks?limit=${TRACKS_PAGE_LIMIT}&offset=${offset}&fields=${TRACK_PAGE_FIELDS}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
    console.error("Spotify tracks fetch error:", response.status, errorData, "URL:", url);

    if (response.status === 404) {
      throw new SpotifyApiError("playlist_not_found", 404);
    }

    if (response.status === 429) {
      throw new SpotifyApiError(RATE_LIMITED_CODE, 429, {
        retryAfterSeconds: parseRetryAfter(response),
      });
    }

    throw new SpotifyApiError("playlist_load_failed", response.status, {
      detail: `tracks: ${response.status} ${errorData.error?.message || response.statusText}`,
    });
  }

  return readTrackPage(await response.json(), offset);
}

/**
 * The playlist's name and its first page of tracks, in one request.
 *
 * This is the call that used to be two. See PLAYLIST_FIELDS for the measured
 * cost of the duplicate; the shape here is the fix. Errors are handled exactly
 * as fetchTrackPage handles them, because from a caller's point of view this
 * *is* the first track page — it just brings the playlist name with it.
 */
export async function fetchPlaylistHead(
  playlistId: string,
  accessToken: string
): Promise<{ playlist: SpotifyPlaylist; firstPage: TrackPage }> {
  const response = await fetch(
    `${SPOTIFY_API_BASE}/playlists/${playlistId}?fields=${PLAYLIST_FIELDS}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response
      .json()
      .catch(() => ({ error: { message: response.statusText } }));
    console.error("Spotify playlist fetch error:", response.status, errorData);

    if (response.status === 404) {
      throw new SpotifyApiError("playlist_not_found", 404);
    }

    if (response.status === 429) {
      throw new SpotifyApiError(RATE_LIMITED_CODE, 429, {
        retryAfterSeconds: parseRetryAfter(response),
      });
    }

    throw new SpotifyApiError("playlist_load_failed", response.status, {
      detail: `playlist: ${response.status} ${errorData.error?.message || response.statusText}`,
    });
  }

  const playlist = (await response.json()) as SpotifyPlaylist;
  return { playlist, firstPage: readTrackPage(playlist.tracks, 0) };
}

/** Fisher-Yates. Array#sort with a random comparator is not a uniform shuffle. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** `count` distinct values drawn from [min, max] without replacement. */
function samplePageIndices(min: number, max: number, count: number): number[] {
  const available = [];
  for (let i = min; i <= max; i++) available.push(i);
  return shuffle(available).slice(0, count);
}

/**
 * Fetch tracks from a playlist, reading at most MAX_PLAYLIST_TRACKS of them.
 *
 * Playlists that fit are read in full, in order. Playlists that don't are
 * *sampled*: the first page tells us the real length, and the rest of the
 * budget goes on randomly chosen pages spread across the playlist rather than
 * on pages 2-5. Taking the first 500 of a 4,000-track playlist would mean the
 * same songs every single game, and whatever the owner happened to add first.
 *
 * The sample is by page, not by track — a page is what a request buys, so
 * sampling any finer would cost more requests, which is the one thing this
 * whole change exists to avoid. Page 0 is always among the candidates because
 * reading it is how we learn the length, so the first 100 tracks are slightly
 * over-represented; everything after them is uniform.
 *
 * Takes the first page rather than fetching it: it arrives with the playlist
 * object (see PLAYLIST_FIELDS), so page zero costs nothing here. That also
 * deleted the AbortSignal this function used to thread through every page.
 * The signal existed because this ran concurrently with the metadata call
 * under a Promise.all, which rejects on the *first* failure while the losing
 * half keeps paginating against Spotify long after the HTTP response has gone
 * out. There is no second half to lose now — a failed head means pagination
 * never starts — so the failure mode is gone rather than managed.
 */
export async function fetchPlaylistTracks(
  playlistId: string,
  accessToken: string,
  firstPage: TrackPage
): Promise<{ tracks: SpotifyTrack[]; truncated: boolean }> {
  // Insurance on the one thing this file cannot check for itself: that
  // PLAYLIST_FIELDS still names the embedded page the way Spotify expects. A
  // projection Spotify doesn't recognise doesn't error — it answers without
  // `items`, and every playlist on the site would quietly load as empty.
  //
  // `rawCount` rather than `tracks.length` is what makes this exact. A
  // hundred-track playlist of nothing but local files also yields zero
  // usable tracks, and testing for that would spend an extra request and log
  // a message pointing at the wrong thing — the kind of false lead this
  // file's comments exist to prevent. An absent page has no entries at all.
  let head = firstPage;
  if (head.rawCount === 0 && head.total > 0) {
    console.error(
      "[spotify] playlist object carried no embedded track page — check PLAYLIST_FIELDS"
    );
    head = await fetchTrackPage(playlistId, accessToken, 0);
  }

  if (head.total <= MAX_PLAYLIST_TRACKS) {
    const tracks = [...head.tracks];
    let offset = head.nextOffset;

    // Bounded by page count, not just by `tracks.length`. Filtered-out entries
    // (local files, unavailable tracks) never grow `tracks`, so on a playlist
    // made of them the only brake left is upstream telling the truth about
    // `next` — and MAX_TRACK_PAGES is a promise this module makes about the
    // quota, not a hope about Spotify. The head is page one, so the loop gets
    // the rest. A legitimate 500-track playlist needs exactly this many.
    let pagesLeft = MAX_TRACK_PAGES - 1;
    while (offset !== null && pagesLeft > 0 && tracks.length < MAX_PLAYLIST_TRACKS) {
      const page = await fetchTrackPage(playlistId, accessToken, offset);
      tracks.push(...page.tracks);
      offset = page.nextOffset;
      pagesLeft -= 1;
    }

    return {
      tracks: tracks.slice(0, MAX_PLAYLIST_TRACKS),
      truncated: tracks.length > MAX_PLAYLIST_TRACKS,
    };
  }

  const lastPageIndex = Math.ceil(head.total / TRACKS_PAGE_LIMIT) - 1;
  const sampledPages = samplePageIndices(1, lastPageIndex, MAX_TRACK_PAGES - 1);

  const tracks = [...head.tracks];
  for (const pageIndex of sampledPages) {
    const page = await fetchTrackPage(
      playlistId,
      accessToken,
      pageIndex * TRACKS_PAGE_LIMIT
    );
    tracks.push(...page.tracks);
  }

  // Shuffled before slicing so the cap doesn't systematically favour whichever
  // sampled page happened to be fetched first.
  return { tracks: shuffle(tracks).slice(0, MAX_PLAYLIST_TRACKS), truncated: true };
}

/**
 * Convert Spotify track to our Track format
 */
export function convertSpotifyTrack(spotifyTrack: SpotifyTrack): Track {
  return {
    id: spotifyTrack.id,
    name: spotifyTrack.name,
    artists: spotifyTrack.artists.map((artist) => artist.name),
    durationMs: spotifyTrack.duration_ms,
    albumName: spotifyTrack.album.name,
    albumImageUrl: spotifyTrack.album.images[0]?.url,
    popularity: spotifyTrack.popularity,
    rawJson: spotifyTrack as unknown as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Get full playlist info including tracks using Client Credentials (no user login required)
 */
export async function getPlaylistWithTracks(
  playlistUrl: string
): Promise<{ playlist: SpotifyPlaylist; tracks: Track[]; truncated: boolean }> {
  const playlistId = parsePlaylistUrl(playlistUrl);
  if (!playlistId) {
    throw new SpotifyApiError("invalid_playlist_url", 400);
  }

  if (isSpotifyEditorial(playlistId)) {
    throw new SpotifyApiError("playlist_editorial", 404);
  }

  // Two attempts: a cached token can be rejected mid-flight (revoked, clock
  // skew, or expiring between the buffer check and Spotify's own clock). That
  // is transparently recoverable, so drop the bad entry and mint a fresh one
  // rather than surfacing an error the user can do nothing about. Only 401
  // retries — a 404 means the playlist genuinely isn't reachable, and a 429
  // means the quota is spent, where retrying is what caused the problem.
  for (let attempt = 0; ; attempt++) {
    const token = await getClientAccessToken();

    try {
      // Sequential, and that is the whole point. These two used to go out
      // together under a Promise.all with an AbortController threaded into
      // every page, because the metadata call and page zero were separate
      // requests for overlapping data. They are one request now, so the head
      // both costs less and gates the rest: nothing paginates until we know
      // the playlist is readable, and a failed head spends zero track pages.
      const { playlist, firstPage } = await fetchPlaylistHead(playlistId, token);
      const trackPage = await fetchPlaylistTracks(playlistId, token, firstPage);

      const tracks = trackPage.tracks.map(convertSpotifyTrack);

      return { playlist, tracks, truncated: trackPage.truncated };
    } catch (err) {
      const isAuthFailure = err instanceof SpotifyApiError && err.status === 401;
      if (!isAuthFailure) throw err;

      invalidateClientAccessToken();
      if (attempt > 0) throw err;
    }
  }
}


