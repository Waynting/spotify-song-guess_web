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
  throttled: boolean;
  /**
   * The exact code a host pressing Start would get right now, so the notice
   * and the error can never contradict each other. Null when nothing is wrong.
   */
  code: AppErrorCode | null;
  /** Honest seconds, straight from the stored `until`. Zero when open. */
  retryAfterSeconds: number;
}
