/**
 * The wire shape of a preview lookup, shared by both sides.
 *
 * Separate from lib/preview-cache.ts so the game page can import the contract
 * without importing the implementation — that module reaches for lib/kv.ts and
 * through it the Upstash client, none of which belongs in a browser bundle.
 * Same reason types/room.ts holds ROOM_TTL_SECONDS.
 */

/**
 * `absent` is a fact about the recording — nobody has a clip for it. Only a
 * clean, complete answer from upstream produces one, and it is cached for a
 * week.
 *
 * `unavailable` is a fact about *us*: throttled, out of budget, or the request
 * never got through. It is cached for ninety seconds and means "ask again",
 * which is the whole reason it is not spelled `absent`. Collapsing the two is
 * what marked a slice of the catalogue silent for a week every time iTunes
 * throttled our shared egress IP.
 */
export type PreviewStatus = "found" | "absent" | "unavailable";

export interface PreviewResult {
  previewUrl: string | null;
  status: PreviewStatus;
}

/** Worth remembering. An `unavailable` must never be cached as "no audio". */
export function isPreviewSettled(status: PreviewStatus): boolean {
  return status === "found" || status === "absent";
}

export interface PreviewBatchTrack {
  id: string;
  name: string;
  artist: string;
  /**
   * Spotify's running time, used to tell the recording apart from a cover.
   * The only matching signal that survives translation: iTunes returns 盧廣仲
   * as "Crowd Lu", but 320165ms is 320165ms. Optional so an older client still
   * resolves — it just falls back to matching on names alone.
   */
  durationMs?: number;
}

export interface PreviewBatchRequest {
  tracks: PreviewBatchTrack[];
}

export interface PreviewBatchResponse {
  previews: Record<string, PreviewResult>;
}

/**
 * Ceiling on one batch. A game plays at most 50 songs; the headroom covers a
 * host who asked for more. Enforced on the server and respected by the client,
 * which lets anything past it resolve lazily rather than sending a request it
 * knows will be refused.
 */
export const PREVIEW_BATCH_MAX = 60;

/**
 * Ceiling on one `track` or `artist` string.
 *
 * Spotify's own fields sit far under this, so nothing real is truncated. It is
 * here because lib/preview-cache.ts matches on these strings with regexes that
 * are super-linear on pathological input — a run of spaces costs the credit
 * splitter O(n²), measured at 141ms for 16k of them — and both preview routes
 * take them straight off the wire. Bounding the input is the cheap half; the
 * regexes are the expensive half to reason about, and the string is the part
 * a caller controls. Same idea as PREVIEW_BATCH_MAX one line up: a cap at the
 * boundary rather than a defence in every consumer.
 */
export const PREVIEW_FIELD_MAX = 300;

/**
 * Trim, then clamp. Both routes must agree, or one key holds two answers.
 *
 * By code point, not by `slice`. UTF-16 units cut a surrogate pair in half, and
 * a lone high surrogate makes `encodeURIComponent` throw `URIError` — which in
 * lib/preview-cache.ts happens inside the batch's `Promise.all`, so one emoji
 * landing on the boundary cost all sixty tracks their previews and answered the
 * bare 500 with no `code` that this project has been bitten by before.
 */
export function clampPreviewField(value: string): string {
  return Array.from(value.trim()).slice(0, PREVIEW_FIELD_MAX).join("");
}
