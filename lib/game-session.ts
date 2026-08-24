/**
 * sessionStorage game payload — shared between the setup page (write)
 * and the game page (read). Pure functions, no browser APIs, so they
 * are unit-testable.
 */

import type { Track } from "@/types";
import type { PlaylistSource } from "@/lib/analytics";
import { DEFAULT_SAMPLED_PER_PLAYER } from "@/types/room";

export const GAME_STORAGE_KEY = "guesssong_game";

/**
 * What the host's socket is called when they haven't named themselves. It is a
 * real player name, not a sentinel — nothing keys off it, so a guest who types
 * "Host" on their phone is just another player with an unimaginative name.
 */
export const DEFAULT_HOST_NAME = "Host";

export type GameMode = "party" | "buzzer";

export interface GamePlayer {
  name: string;
  score: number;
}

/** Mixed Playlist Mode metadata — how the pool was assembled. */
export interface MixedPlaylistMeta {
  contributorNames: string[];
  sampledPerPlayer: number;
}

/**
 * Buzzer Mode's handle on its Cloudflare room. Present only when mode is
 * "buzzer". The host token is a bearer secret for host-only actions (opening a
 * round, awarding points), so it lives in the host's own sessionStorage and is
 * never rendered, shared, or put in the join URL players scan.
 */
export interface BuzzerRoomHandle {
  code: string;
  hostToken: string;
  /**
   * What the host is called inside the room. They buzz like everyone else, so
   * they need a name the scoreboard can award points to — "Host" is only the
   * default, not a special case.
   */
  hostName: string;
}

export interface GamePayload {
  tracks: Track[];
  players: GamePlayer[];
  playlistName: string;
  clipDuration: number;
  totalTracks: number;
  playlistSource: PlaylistSource;
  mode: GameMode;
  mixedPlaylistMeta?: MixedPlaylistMeta;
  buzzerRoom?: BuzzerRoomHandle;
}

const PLAYLIST_SOURCES: PlaylistSource[] = ["own", "mixed"];

function isPlaylistSource(value: unknown): value is PlaylistSource {
  return typeof value === "string" && (PLAYLIST_SOURCES as string[]).includes(value);
}

const GAME_MODES: GameMode[] = ["party", "buzzer"];

/**
 * Allow-list, not a ternary. A ternary that named one mode and sent everything
 * else to "party" is what this replaced: adding a member to GameMode changed
 * behaviour without failing anywhere, so a sessionStorage round-trip quietly
 * downgraded a buzzer game into a party game. Extend GAME_MODES whenever
 * GameMode grows and this stays honest.
 *
 * The fallback is also what retires a mode safely: a game already in
 * sessionStorage under a mode that no longer exists reads back as "party" and
 * keeps playing, rather than failing to parse and dumping the host at /.
 */
function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && (GAME_MODES as string[]).includes(value);
}

/**
 * Strip the bulky Spotify rawJson blob from a track before persisting.
 * Large playlists with rawJson can blow past the ~5MB sessionStorage cap.
 */
export function stripTrackForStorage(track: Track): Track {
  const rest = { ...track };
  delete rest.rawJson;
  return rest;
}

export interface BuildGamePayloadInput {
  tracks: Track[];
  players: GamePlayer[];
  playlistName: string;
  clipDuration: number;
  totalTracks?: number;
  playlistSource: PlaylistSource;
  mode: GameMode;
  mixedPlaylistMeta?: MixedPlaylistMeta;
  buzzerRoom?: BuzzerRoomHandle;
}

export function buildGamePayload(input: BuildGamePayloadInput): GamePayload {
  return {
    tracks: input.tracks.map(stripTrackForStorage),
    players: input.players,
    playlistName: input.playlistName,
    clipDuration: input.clipDuration,
    totalTracks: input.totalTracks ?? input.tracks.length,
    playlistSource: input.playlistSource,
    mode: input.mode,
    ...(input.mixedPlaylistMeta ? { mixedPlaylistMeta: input.mixedPlaylistMeta } : {}),
    ...(input.buzzerRoom ? { buzzerRoom: input.buzzerRoom } : {}),
  };
}

/**
 * Fold the buzzer room's live roster into the scoreboard.
 *
 * Buzzer Mode has no typed-in player list — the room is the roster, so this is
 * what makes a phone that scanned in scoreable at all. Points are awarded by
 * name (`awardPoint`), so a buzzer winner who isn't in `players` silently earns
 * nothing; every name the room reports has to reach this list before the host
 * can tap "Correct".
 *
 * Two rules, both about not punishing a flaky phone:
 *
 * - **Additive only.** A player who locks their screen drops out of the room's
 *   roster, and removing them here would wipe a score they earned fairly. They
 *   keep their seat for the rest of the game.
 * - **Case-insensitive on name.** The room already refuses a second "amy" while
 *   "Amy" is connected, so two spellings are the same human reconnecting, not
 *   two players.
 *
 * Returns the original array reference when nothing is new, so calling this in
 * a `setPlayers` updater on every snapshot can't loop.
 */
export function mergeRoomRoster(players: GamePlayer[], roster: string[]): GamePlayer[] {
  const seen = new Set(players.map((p) => p.name.toLowerCase()));
  const additions: GamePlayer[] = [];
  for (const raw of roster) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ name, score: 0 });
  }
  return additions.length ? [...players, ...additions] : players;
}

/**
 * Number of rounds actually played when a game ends. A round counts only
 * once its clip has started; ending during "waiting" means the current
 * round was never played. Keeps game_finished's rounds_played consistent
 * with the number of round_completed events.
 */
export function countRoundsPlayed(currentIndex: number, phase: string): number {
  return currentIndex + (phase === "waiting" ? 0 : 1);
}

/**
 * Read one entry of `tracks` back, repairing what can be repaired and dropping
 * what cannot.
 *
 * This replaces a blind `as Track[]` cast, and the cast is what took the site
 * down: the game page reads `t.artists[0]` in its preview-prefetch effect on
 * mount, so a single entry without an `artists` array threw a TypeError there,
 * and — with no error boundary anywhere in `app/` — React unmounted the whole
 * tree and Next replaced the party with "Application error: a client-side
 * exception has occurred". The host had done nothing wrong and had nothing to
 * click.
 *
 * The split between repairing and dropping follows the same rule as the
 * `GAME_MODES` / `PLAYLIST_SOURCES` guards above: a payload already sitting in
 * a host's sessionStorage must keep playing across a deploy rather than fail to
 * parse mid-party.
 *
 * - `id` and `name` are dropped when missing. Nothing can look up a clip for a
 *   track with no id, and a round with no title has no answer to reveal.
 * - `artists` and `durationMs` are repaired. An unnamed credit still plays, and
 *   `durationMs` is only ever a matching signal for lib/preview-cache.ts, so
 *   losing it costs one song's cover-detection rather than the song.
 */
function normalizeTrack(value: unknown): Track | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== "string" || typeof t.name !== "string") return null;

  const artists = Array.isArray(t.artists)
    ? t.artists.filter((a): a is string => typeof a === "string")
    : [];
  const contributors = Array.isArray(t.contributors)
    ? t.contributors.filter((c): c is string => typeof c === "string")
    : undefined;

  return {
    ...(t as unknown as Track),
    id: t.id,
    name: t.name,
    artists,
    durationMs: typeof t.durationMs === "number" ? t.durationMs : 0,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
    ...(contributors ? { contributors } : {}),
  };
}

/**
 * Parse a raw sessionStorage string into a GamePayload.
 * Returns null when the JSON is invalid or has no usable track list.
 * Old payloads (pre playlistSource/mode) get backward-compatible defaults.
 */
export function parseGamePayload(raw: string): GamePayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const d = data as Record<string, unknown>;
  const tracks = Array.isArray(d.tracks)
    ? d.tracks.map(normalizeTrack).filter((t): t is Track => t !== null)
    : [];
  const players = Array.isArray(d.players)
    ? d.players
        .filter((p): p is GamePlayer => typeof p === "object" && p !== null)
        .map((p) => ({
          name: typeof p.name === "string" ? p.name : "",
          score: typeof p.score === "number" ? p.score : 0,
        }))
        .filter((p) => p.name !== "")
    : [];

  const rawMeta = d.mixedPlaylistMeta as Record<string, unknown> | undefined;
  const mixedPlaylistMeta: MixedPlaylistMeta | undefined =
    rawMeta && typeof rawMeta === "object" && Array.isArray(rawMeta.contributorNames)
      ? {
          contributorNames: rawMeta.contributorNames as string[],
          sampledPerPlayer:
            typeof rawMeta.sampledPerPlayer === "number"
              ? rawMeta.sampledPerPlayer
              : DEFAULT_SAMPLED_PER_PLAYER,
        }
      : undefined;

  const rawRoom = d.buzzerRoom as Record<string, unknown> | undefined;
  const buzzerRoom: BuzzerRoomHandle | undefined =
    rawRoom &&
    typeof rawRoom === "object" &&
    typeof rawRoom.code === "string" &&
    typeof rawRoom.hostToken === "string"
      ? {
          code: rawRoom.code,
          hostToken: rawRoom.hostToken,
          // Rooms created before hostName existed round-trip as "Host" rather
          // than dropping the whole handle and stranding a live game. Blank
          // names take the same path: the room rejects an empty join outright,
          // so an unnamed host would otherwise never connect at all.
          hostName:
            typeof rawRoom.hostName === "string" && rawRoom.hostName.trim()
              ? rawRoom.hostName.trim()
              : DEFAULT_HOST_NAME,
        }
      : undefined;

  return {
    tracks,
    players,
    playlistName: typeof d.playlistName === "string" ? d.playlistName : "",
    clipDuration: typeof d.clipDuration === "number" ? d.clipDuration : 15,
    totalTracks: typeof d.totalTracks === "number" ? d.totalTracks : tracks.length,
    playlistSource: isPlaylistSource(d.playlistSource) ? d.playlistSource : "own",
    mode: isGameMode(d.mode) ? d.mode : "party",
    ...(mixedPlaylistMeta ? { mixedPlaylistMeta } : {}),
    ...(buzzerRoom ? { buzzerRoom } : {}),
  };
}
