import type { AppErrorCode } from "@/lib/error-messages";

/**
 * The wire shape of `GET /api/status`, shared by both sides.
 *
 * Separate from lib/playlist-cache.ts for the same reason types/preview.ts is
 * separate from lib/preview-cache.ts: the notice component needs the contract,
 * and that module reaches for lib/kv.ts and through it the Upstash client,
 * none of which belongs in a browser bundle.
 */
export interface SpotifyServiceStatus {
  /** Pressing Start right now would be refused. */
  throttled: boolean;
  /**
   * The day's Spotify allowance is nearly spent, but nothing is refusing yet.
   *
   * Deliberately a second boolean rather than a level or a percentage. A number
   * would invite the notice to render it, and "1,614 of 2,000" is a fact about
   * our KV buckets, not about whether this host's party is at risk — the only
   * question the page is entitled to ask. It also keeps the threshold a server
   * concern, retunable from an env var without shipping a client.
   *
   * Never true at the same time as `throttled`: a live refusal outranks the
   * warning it grew out of, so callers never have to rank two states.
   */
  approachingLimit: boolean;
  /**
   * The exact code a host pressing Start would get right now, so the notice
   * and the error can never contradict each other — or, when only
   * `approachingLimit` is set, `spotify_budget_low`, which is the one code here
   * that describes a level rather than a refusal. Null when nothing is wrong.
   */
  code: AppErrorCode | null;
  /** Honest seconds, straight from the stored `until`. Zero when open. */
  retryAfterSeconds: number;
}
