/**
 * The one way the game payload reaches sessionStorage and comes back.
 *
 * ## Why this is not three inline `sessionStorage` calls
 *
 * Storage *throws* in a locked-down browser rather than returning null —
 * Safari with "Block All Cookies", Chrome with site data disallowed, several
 * embedded webviews — and the throw is on the property access itself, before
 * any method is called. `lib/host-session.ts` says so in its own header and
 * guards every path it owns; this payload was the one that did not.
 *
 * That cost the site a bug report of exactly the shape the guard exists to
 * prevent. `app/game/page.tsx` read the key unguarded inside a mount effect, so
 * a browser that refuses storage did not bounce the host back to setup — it
 * threw, and with no error boundary in `app/` the whole page became "Application
 * error: a client-side exception has occurred". Meanwhile the setup page's
 * write sat inside the same `try` as the playlist fetch, so the *other* half of
 * the same browser setting was reported as `playlist_load_failed` and sent the
 * host off to check a playlist that was never the problem.
 *
 * Both halves now answer honestly: a refused write is `false` (the caller
 * raises `storage_blocked`), and a refused read is `null` (the caller sends the
 * host back to setup, which is where a game that was never stored has to start).
 *
 * The `*From`/`*To` pair is the test seam — `tests/game-storage.test.ts` hands
 * them a Storage that throws, which is the case no real browser here will
 * reproduce on demand.
 */

import {
  GAME_STORAGE_KEY,
  parseGamePayload,
  type GamePayload,
} from "@/lib/game-session";

/**
 * `window.sessionStorage` when it can be touched at all, null otherwise.
 *
 * The `try` wraps the property access and not just the call: reading the
 * property is itself what throws a SecurityError when a browser has site data
 * switched off.
 */
function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to keep it. Never throws. */
export function saveGameTo(storage: Storage | null, payload: GamePayload): boolean {
  if (!storage) return false;
  try {
    storage.setItem(GAME_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // Blocked, or over quota. Either way there is no game to navigate to, and
    // the caller has to say so instead of pushing /game at an empty key.
    return false;
  }
}

/** Null for "no game here", including when the browser won't say. Never throws. */
export function loadGameFrom(storage: Storage | null): GamePayload | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(GAME_STORAGE_KEY);
  } catch {
    return null;
  }
  return raw ? parseGamePayload(raw) : null;
}

/** Forget the stored game. Used by the error boundary's "Start over". */
export function clearGameFrom(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(GAME_STORAGE_KEY);
  } catch {
    // Nothing to do about it, and nothing depends on it having worked: the
    // setup page overwrites the key on the next Start.
  }
}

export function saveGame(payload: GamePayload): boolean {
  return saveGameTo(sessionStore(), payload);
}

export function loadGame(): GamePayload | null {
  return loadGameFrom(sessionStore());
}

export function clearGame(): void {
  clearGameFrom(sessionStore());
}
