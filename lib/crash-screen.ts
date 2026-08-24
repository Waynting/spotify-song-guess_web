/**
 * The crash screen's strings and its one link.
 *
 * In `lib/` rather than beside `components/crash-screen.tsx` for the reason
 * `lib/song-count.ts`, `lib/guides.ts` and `lib/service-notice.ts` all give: the
 * suite only reaches `lib/`, and vitest cannot import a `.tsx` module in this
 * project. Leaving these in the component puts the one screen a host sees when
 * everything else has failed outside test range — which is the last place that
 * should be true.
 */

import type { ErrorLocale } from "@/lib/error-messages";

/**
 * Where a host can say this happened to them.
 *
 * The label is the only part a reader sees, so a wrong href fails silently: the
 * screen still renders and the link still looks like a link. Same hazard
 * `SELF_HOST_URL` carries, and pinned the same way.
 */
export const CRASH_REPORT_URL = "https://github.com/Waynting/GuessSong/issues";

export const CRASH_SCREEN_UI: Record<
  ErrorLocale,
  { title: string; retry: string; restart: string; report: string }
> = {
  en: {
    title: "The game stopped",
    retry: "Try again",
    restart: "Start over",
    report: "Report this",
  },
  zh: {
    title: "遊戲中斷了",
    retry: "再試一次",
    restart: "重新開始",
    report: "回報問題",
  },
};
