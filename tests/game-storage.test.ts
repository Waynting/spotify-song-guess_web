import { describe, expect, it } from "vitest";
import {
  clearGameFrom,
  loadGameFrom,
  saveGameTo,
} from "@/lib/game-storage";
import { buildGamePayload, GAME_STORAGE_KEY } from "@/lib/game-session";
import type { Track } from "@/types";

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1",
    name: "Song",
    artists: ["Artist"],
    durationMs: 200_000,
    createdAt: "2026-08-24T00:00:00.000Z",
    ...over,
  };
}

function payload() {
  return buildGamePayload({
    tracks: [track()],
    players: [{ name: "Alice", score: 0 }],
    playlistName: "Party",
    clipDuration: 15,
    playlistSource: "own",
    mode: "party",
  });
}

/** A Storage that works. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/**
 * A Storage that throws on every method, which is what Safari with "Block All
 * Cookies" and several embedded webviews actually do. This is the case no
 * browser on a developer's desk reproduces on demand, and the one that took the
 * game page down.
 */
function blockedStorage(): Storage {
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    length: 0,
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

describe("saveGameTo", () => {
  it("stores the payload under the shared key", () => {
    const store = memoryStorage();
    expect(saveGameTo(store, payload())).toBe(true);
    expect(store.getItem(GAME_STORAGE_KEY)).toContain("Song");
  });

  it("reports false instead of throwing when storage is blocked", () => {
    expect(saveGameTo(blockedStorage(), payload())).toBe(false);
  });

  it("reports false when there is no storage at all", () => {
    expect(saveGameTo(null, payload())).toBe(false);
  });
});

describe("loadGameFrom", () => {
  it("round-trips a payload", () => {
    const store = memoryStorage();
    saveGameTo(store, payload());
    expect(loadGameFrom(store)?.tracks[0].name).toBe("Song");
  });

  it("returns null instead of throwing when storage is blocked", () => {
    // The regression under test: this read lived unguarded in the game page's
    // mount effect, so the throw escaped React and Next replaced the party with
    // "Application error: a client-side exception has occurred".
    expect(() => loadGameFrom(blockedStorage())).not.toThrow();
    expect(loadGameFrom(blockedStorage())).toBeNull();
  });

  it("returns null for an empty store and for junk", () => {
    const store = memoryStorage();
    expect(loadGameFrom(store)).toBeNull();
    store.setItem(GAME_STORAGE_KEY, "{not json");
    expect(loadGameFrom(store)).toBeNull();
  });
});

describe("clearGameFrom", () => {
  it("removes the key", () => {
    const store = memoryStorage();
    saveGameTo(store, payload());
    clearGameFrom(store);
    expect(loadGameFrom(store)).toBeNull();
  });

  it("does not throw when storage is blocked", () => {
    expect(() => clearGameFrom(blockedStorage())).not.toThrow();
    expect(() => clearGameFrom(null)).not.toThrow();
  });
});
