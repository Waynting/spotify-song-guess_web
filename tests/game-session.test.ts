import { describe, it, expect } from "vitest";
import {
  buildGamePayload,
  parseGamePayload,
  stripTrackForStorage,
  countRoundsPlayed,
  GAME_STORAGE_KEY,
} from "@/lib/game-session";
import type { Track } from "@/types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    name: "Song",
    artists: ["Artist"],
    durationMs: 200000,
    albumName: "Album",
    albumImageUrl: "https://img.example/a.jpg",
    rawJson: { huge: "blob", nested: { stuff: [1, 2, 3] } },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GAME_STORAGE_KEY", () => {
  it("stays backward compatible with the existing key", () => {
    expect(GAME_STORAGE_KEY).toBe("guesssong_game");
  });
});

describe("stripTrackForStorage", () => {
  it("removes rawJson and keeps everything else", () => {
    const stripped = stripTrackForStorage(makeTrack());
    expect(stripped).not.toHaveProperty("rawJson");
    expect(stripped.id).toBe("t1");
    expect(stripped.name).toBe("Song");
    expect(stripped.artists).toEqual(["Artist"]);
    expect(stripped.albumImageUrl).toBe("https://img.example/a.jpg");
  });
});

describe("buildGamePayload", () => {
  it("builds an own/party payload with rawJson stripped from every track", () => {
    const payload = buildGamePayload({
      tracks: [makeTrack({ id: "a" }), makeTrack({ id: "b" })],
      players: [
        { name: "Alice", score: 0 },
        { name: "Bob", score: 0 },
      ],
      playlistName: "My Mix",
      clipDuration: 10,
      totalTracks: 2,
      playlistSource: "own",
      mode: "party",
    });

    expect(payload.playlistSource).toBe("own");
    expect(payload.mode).toBe("party");
    expect(payload.playlistName).toBe("My Mix");
    expect(payload.clipDuration).toBe(10);
    expect(payload.totalTracks).toBe(2);
    expect(payload.players).toHaveLength(2);
    expect(payload.tracks).toHaveLength(2);
    for (const t of payload.tracks) {
      expect(t).not.toHaveProperty("rawJson");
    }
    // never persists a playableTracks field (removed legacy field)
    expect(payload).not.toHaveProperty("playableTracks");
  });

  it("defaults totalTracks to tracks.length", () => {
    const payload = buildGamePayload({
      tracks: [makeTrack({ id: "a" }), makeTrack({ id: "b" }), makeTrack({ id: "c" })],
      players: [{ name: "You", score: 0 }],
      playlistName: "Western Classics",
      clipDuration: 15,
      playlistSource: "own",
      mode: "party",
    });

    expect(payload.playlistSource).toBe("own");
    expect(payload.mode).toBe("party");
    expect(payload.totalTracks).toBe(3);
    expect(payload.players).toEqual([{ name: "You", score: 0 }]);
  });

  it("round-trips through JSON + parseGamePayload unchanged", () => {
    const payload = buildGamePayload({
      tracks: [makeTrack()],
      players: [{ name: "You", score: 0 }],
      playlistName: "Mix",
      clipDuration: 5,
      playlistSource: "own",
      mode: "party",
    });
    const parsed = parseGamePayload(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });

  it("builds a mixed/party payload carrying mixedPlaylistMeta", () => {
    const payload = buildGamePayload({
      tracks: [makeTrack({ id: "a", contributors: ["Alice", "Bob"] })],
      players: [
        { name: "Alice", score: 0 },
        { name: "Bob", score: 0 },
      ],
      playlistName: "2-Player Mix",
      clipDuration: 10,
      playlistSource: "mixed",
      mode: "party",
      mixedPlaylistMeta: { contributorNames: ["Alice", "Bob"], sampledPerPlayer: 8 },
    });

    expect(payload.playlistSource).toBe("mixed");
    expect(payload.mixedPlaylistMeta).toEqual({
      contributorNames: ["Alice", "Bob"],
      sampledPerPlayer: 8,
    });
    expect(payload.tracks[0].contributors).toEqual(["Alice", "Bob"]);
  });

  it("round-trips mixedPlaylistMeta through JSON + parseGamePayload", () => {
    const payload = buildGamePayload({
      tracks: [makeTrack({ contributors: ["Alice"] })],
      players: [{ name: "Alice", score: 0 }],
      playlistName: "1-Player Mix",
      clipDuration: 10,
      playlistSource: "mixed",
      mode: "party",
      mixedPlaylistMeta: { contributorNames: ["Alice"], sampledPerPlayer: 8 },
    });
    const parsed = parseGamePayload(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });
});

describe("parseGamePayload", () => {
  it("applies defaults for old payloads without mode/playlistSource", () => {
    const legacy = JSON.stringify({
      tracks: [makeTrack()],
      players: [{ name: "Alice", score: 3 }],
      playlistName: "Old Mix",
      clipDuration: 20,
      totalTracks: 1,
      playableTracks: undefined, // legacy field, ignored
    });

    const parsed = parseGamePayload(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.playlistSource).toBe("own");
    expect(parsed!.mode).toBe("party");
    expect(parsed!.playlistName).toBe("Old Mix");
    expect(parsed!.clipDuration).toBe(20);
    expect(parsed!.tracks).toHaveLength(1);
  });

  it("defaults missing fields on a minimal payload", () => {
    const parsed = parseGamePayload(JSON.stringify({ tracks: [] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.players).toEqual([]);
    expect(parsed!.playlistName).toBe("");
    expect(parsed!.clipDuration).toBe(15);
    expect(parsed!.totalTracks).toBe(0);
    expect(parsed!.playlistSource).toBe("own");
    expect(parsed!.mode).toBe("party");
  });

  it("reads a retired builtin/trial payload back as own/party", () => {
    // The built-in trial playlists were removed, and a game already in
    // sessionStorage when that shipped still has to be playable. The allow-list
    // fallback is what makes retiring a member of either union safe: it lands
    // on the party path rather than failing to parse and dumping the host at /.
    const parsed = parseGamePayload(
      JSON.stringify({ tracks: [], playlistSource: "builtin", mode: "trial" })
    );
    expect(parsed!.playlistSource).toBe("own");
    expect(parsed!.mode).toBe("party");
  });

  it("parses explicit mixed playlistSource", () => {
    const parsed = parseGamePayload(JSON.stringify({ tracks: [], playlistSource: "mixed" }));
    expect(parsed!.playlistSource).toBe("mixed");
  });

  it("falls back to defaults for unknown enum values", () => {
    const parsed = parseGamePayload(
      JSON.stringify({ tracks: [], playlistSource: "weird", mode: "nope" })
    );
    expect(parsed!.playlistSource).toBe("own");
    expect(parsed!.mode).toBe("party");
  });

  it("returns null for invalid JSON", () => {
    expect(parseGamePayload("not json {")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseGamePayload("42")).toBeNull();
    expect(parseGamePayload("null")).toBeNull();
  });

  it("falls back to empty array when tracks is present but not an array", () => {
    const parsed = parseGamePayload(JSON.stringify({ tracks: "oops", players: [] }));
    expect(parsed!.tracks).toEqual([]);
  });
});

// Regression: ISSUE-001 — rounds_played overcounted by 1 when the game ended
// during the "waiting" phase (round not yet started), inflating game_finished
// data.
// Found by /qa on 2026-06-11
// Report: .gstack/qa-reports/qa-report-127-0-0-1-8000-2026-06-11.md
describe("countRoundsPlayed", () => {
  it("does not count the current round when ending during waiting", () => {
    // Played rounds 1-3, ended while round 4 (index 3) was still waiting
    expect(countRoundsPlayed(3, "waiting")).toBe(3);
  });

  it("counts the current round once its clip has started", () => {
    expect(countRoundsPlayed(3, "playing")).toBe(4);
    expect(countRoundsPlayed(3, "guessing")).toBe(4);
    expect(countRoundsPlayed(3, "revealed")).toBe(4);
  });

  it("returns 0 when ending before the first clip ever plays", () => {
    expect(countRoundsPlayed(0, "waiting")).toBe(0);
  });

  it("counts the final round when finishing normally via next-track", () => {
    // Last round (index 15 of 16) finishing from revealed
    expect(countRoundsPlayed(15, "revealed")).toBe(16);
  });
});

/**
 * The track list used to be cast straight out of JSON with `as Track[]`, so
 * anything malformed reached the render. The game page dereferences
 * `t.artists[0]` in its preview-prefetch effect on mount, which made one bad
 * entry a TypeError there — and with no error boundary in `app/` at the time,
 * the whole page became "Application error: a client-side exception has
 * occurred". These pin the repair-or-drop split that replaced the cast.
 */
describe("parseGamePayload track validation", () => {
  const good = {
    id: "t1",
    name: "Song",
    artists: ["Artist"],
    durationMs: 200_000,
    createdAt: "2026-08-24T00:00:00.000Z",
  };

  function parseTracks(tracks: unknown[]) {
    return parseGamePayload(
      JSON.stringify({ tracks, players: [], playlistName: "P", clipDuration: 15 })
    );
  }

  it("repairs a missing artists array rather than dropping the song", () => {
    const parsed = parseTracks([{ ...good, artists: undefined }]);
    expect(parsed?.tracks).toHaveLength(1);
    expect(parsed?.tracks[0].artists).toEqual([]);
    // The exact call the game page makes on mount.
    expect(() => parsed?.tracks.map((t) => t.artists[0] ?? "")).not.toThrow();
  });

  it("drops non-string entries from artists", () => {
    const parsed = parseTracks([{ ...good, artists: ["A", null, 7, "B"] }]);
    expect(parsed?.tracks[0].artists).toEqual(["A", "B"]);
  });

  it("defaults a missing durationMs to 0 rather than undefined", () => {
    const parsed = parseTracks([{ ...good, durationMs: "long" }]);
    expect(parsed?.tracks[0].durationMs).toBe(0);
  });

  it("drops a track with no id or no name — nothing can play or reveal it", () => {
    const parsed = parseTracks([
      { ...good, id: undefined },
      { ...good, name: undefined },
      null,
      "not a track",
      good,
    ]);
    expect(parsed?.tracks).toHaveLength(1);
    expect(parsed?.tracks[0].id).toBe("t1");
  });

  it("keeps the fields it does not police", () => {
    const parsed = parseTracks([{ ...good, albumName: "Album", popularity: 90 }]);
    expect(parsed?.tracks[0].albumName).toBe("Album");
    expect(parsed?.tracks[0].popularity).toBe(90);
  });

  it("drops a malformed player rather than putting a blank row on the scoreboard", () => {
    const parsed = parseGamePayload(
      JSON.stringify({
        tracks: [good],
        players: [{ name: "Alice", score: 3 }, { score: 1 }, null, { name: "Bob" }],
        playlistName: "P",
        clipDuration: 15,
      })
    );
    expect(parsed?.players).toEqual([
      { name: "Alice", score: 3 },
      { name: "Bob", score: 0 },
    ]);
  });
});
