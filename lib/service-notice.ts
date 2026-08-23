import type { ErrorLocale } from "@/lib/error-messages";
import type { SpotifyServiceStatus } from "@/types/service-status";

/**
 * The site notice that tells a host the playlist path is down *before* they
 * paste a link, rather than after they press Start.
 *
 * The logic lives here rather than beside the component for the reason
 * lib/song-count.ts and lib/guides.ts give: the suite only reaches lib/, and
 * vitest cannot import a .tsx module in this project. The component keeps the
 * JSX and nothing else.
 */

/**
 * Per-tab, not persistent. A host who dismisses this is saying "I have read
 * it", not "never show me this again" — the next visit may be a different
 * outage, and localStorage would silence it. sessionStorage forgets when the
 * tab closes, which is the same lifetime as the game payload it sits next to.
 */
export const NOTICE_DISMISS_KEY = "guesssong_notice_dismissed";

/**
 * Keyed by the *code*, not a boolean.
 *
 * A dismissal is scoped to the thing that was dismissed. `spotify_cooldown`
 * (a blip, minutes) and `spotify_quota_exhausted` (the daily quota, hours) are
 * materially different news, and a host who waved away the first one has not
 * been told the second. Storing a bare flag would collapse them and hide the
 * more serious message behind a dismissal of the lesser one.
 */
export function shouldShowNotice(
  status: SpotifyServiceStatus | null,
  dismissedCode: string | null
): boolean {
  if (!status?.throttled || !status.code) return false;
  return status.code !== dismissedCode;
}

export const SERVICE_NOTICE_UI: Record<
  ErrorLocale,
  { title: string; dismiss: string; close: string }
> = {
  en: {
    title: "New playlists aren't loading right now",
    dismiss: "Got it",
    close: "Dismiss notice",
  },
  zh: {
    title: "現在新歌單載入不了",
    dismiss: "知道了",
    close: "關閉公告",
  },
};
