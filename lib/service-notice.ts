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
 * The two things this notice can be, and nothing else.
 *
 * `blocked` is the original: pressing Start would be refused right now.
 * `warning` fires while the site still works, once the day's Spotify allowance
 * is nearly spent. They are one component and one dismissal because they are
 * one piece of news at two stages, but they are emphatically not one *sentence*
 * — a warning that reads like a refusal sends a host away from a site that
 * would have worked for them, which is worse than not warning at all.
 */
export type NoticeState = "blocked" | "warning";

/**
 * What, if anything, there is to say. Null when the site is simply fine.
 *
 * `throttled` is checked first and `approachingLimit` is never set alongside it
 * (lib/playlist-cache.ts guarantees that), so the ranking here is belt and
 * braces rather than a live decision: a host who is being refused must not be
 * told they are about to be.
 */
export function noticeState(status: SpotifyServiceStatus | null): NoticeState | null {
  if (!status?.code) return null;
  if (status.throttled) return "blocked";
  return status.approachingLimit ? "warning" : null;
}

/**
 * Keyed by the *code*, not a boolean.
 *
 * A dismissal is scoped to the thing that was dismissed. `spotify_cooldown`
 * (a blip, minutes) and `spotify_quota_exhausted` (the daily quota, hours) are
 * materially different news, and a host who waved away the first one has not
 * been told the second. Storing a bare flag would collapse them and hide the
 * more serious message behind a dismissal of the lesser one.
 *
 * The warning joins that scheme for free, and gets the property that matters
 * most from it: dismissing `spotify_budget_low` at eight o'clock does not
 * suppress the refusal at ten, because that is a different code.
 */
export function shouldShowNotice(
  status: SpotifyServiceStatus | null,
  dismissedCode: string | null
): boolean {
  // Read `code` off the argument rather than asserting `status` is non-null
  // after the noticeState call. The assertion was sound only because
  // noticeState returns null on a null status, which is a coupling that would
  // rot silently the first time that function grows a branch.
  const code = status?.code;
  if (!code || !noticeState(status)) return false;
  return code !== dismissedCode;
}

/**
 * Where a host who does not want to wait can go instead.
 *
 * The message this notice renders says the app is free and that Spotify's
 * quota is not something a project this size can buy more of. That is an
 * honest account and a dead end, so the notice ends on the one door that is
 * actually open: the source, and your own Spotify credentials. It is a link
 * rather than a URL inside the sentence because the same sentence is also
 * rendered as plain text under the Start button, where nothing is clickable.
 */
export const SELF_HOST_URL = "https://github.com/Waynting/GuessSong";

/**
 * The title is per state and everything else is not, which is the whole shape
 * of the difference. "New playlists aren't loading" is false during a warning —
 * they are loading, that is the point of warning early — and a host who reads
 * the wrong one of these two headlines makes exactly the wrong decision about
 * their evening.
 */
export const SERVICE_NOTICE_UI: Record<
  ErrorLocale,
  {
    title: Record<NoticeState, string>;
    dismiss: string;
    close: string;
    repo: string;
  }
> = {
  en: {
    title: {
      blocked: "New playlists aren't loading right now",
      warning: "Close to today's playlist allowance",
    },
    dismiss: "Got it",
    close: "Dismiss notice",
    repo: "Run your own copy",
  },
  zh: {
    title: {
      blocked: "現在新歌單載入不了",
      warning: "今天的歌單額度快用完了",
    },
    dismiss: "知道了",
    close: "關閉公告",
    repo: "自己架一站",
  },
};
