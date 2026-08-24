// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  NOTICE_DISMISS_KEY,
  noticeState,
  SELF_HOST_URL,
  SERVICE_NOTICE_UI,
  shouldShowNotice,
} from "@/lib/service-notice";
import type { SpotifyServiceStatus } from "@/types/service-status";

const OPEN: SpotifyServiceStatus = {
  throttled: false,
  approachingLimit: false,
  code: null,
  retryAfterSeconds: 0,
};
const BLIP: SpotifyServiceStatus = {
  throttled: true,
  approachingLimit: false,
  code: "spotify_cooldown",
  retryAfterSeconds: 90,
};
const QUOTA: SpotifyServiceStatus = {
  throttled: true,
  approachingLimit: false,
  code: "spotify_quota_exhausted",
  retryAfterSeconds: 48_513,
};
const RATIONED: SpotifyServiceStatus = {
  throttled: true,
  approachingLimit: false,
  code: "spotify_daily_budget_spent",
  retryAfterSeconds: 1_800,
};
/** Nothing is refusing yet — the day's allowance is just running down. */
const NEAR: SpotifyServiceStatus = {
  throttled: false,
  approachingLimit: true,
  code: "spotify_budget_low",
  retryAfterSeconds: 0,
};

describe("shouldShowNotice", () => {
  it("stays hidden before the status has arrived", () => {
    expect(shouldShowNotice(null, null)).toBe(false);
  });

  it("stays hidden when Spotify is not refusing us", () => {
    expect(shouldShowNotice(OPEN, null)).toBe(false);
  });

  it("shows when throttled and nothing has been dismissed", () => {
    expect(shouldShowNotice(BLIP, null)).toBe(true);
    expect(shouldShowNotice(QUOTA, null)).toBe(true);
  });

  it("stays hidden once that same code has been dismissed", () => {
    expect(shouldShowNotice(QUOTA, "spotify_quota_exhausted")).toBe(false);
  });

  /**
   * The reason the dismissal is keyed by code rather than a bare flag. A host
   * who waved away a 90-second blip has not been told that the day's quota is
   * now gone, and those are materially different pieces of news — one is worth
   * waiting out at the Start button, the other is not.
   */
  it("shows again when a worse code replaces a dismissed one", () => {
    expect(shouldShowNotice(QUOTA, "spotify_cooldown")).toBe(true);
  });

  /**
   * The seam between the two gates. `spotify_daily_budget_spent` is us
   * refusing ourselves before Spotify does, `spotify_quota_exhausted` is
   * Spotify refusing us, and a host who dismissed the first has not been told
   * the second — which is the more serious news, and the one they can do
   * nothing about. Keyed dismissal is what keeps those separate.
   */
  it("shows our own rationing, and does not let it mask Spotify's refusal", () => {
    expect(shouldShowNotice(RATIONED, null)).toBe(true);
    expect(shouldShowNotice(RATIONED, "spotify_daily_budget_spent")).toBe(false);
    expect(shouldShowNotice(QUOTA, "spotify_daily_budget_spent")).toBe(true);
  });

  it("stays hidden if throttled is set without a code", () => {
    expect(
      shouldShowNotice(
        { throttled: true, approachingLimit: false, code: null, retryAfterSeconds: 60 },
        null
      )
    ).toBe(false);
  });

  /**
   * The warning fires while the site still works, which is the entire point:
   * told only at the refusal, a host has already lost the choice of loading
   * their playlist while there was allowance for it.
   */
  it("shows the warning before anything is refusing", () => {
    expect(shouldShowNotice(NEAR, null)).toBe(true);
    expect(noticeState(NEAR)).toBe("warning");
  });

  /**
   * Dismissal is keyed by code, so waving away the eight o'clock warning does
   * not silence the ten o'clock refusal. Getting this wrong would make the
   * warning strictly worse than not warning at all.
   */
  it("does not let a dismissed warning mask the refusal it predicted", () => {
    expect(shouldShowNotice(NEAR, "spotify_budget_low")).toBe(false);
    expect(shouldShowNotice(RATIONED, "spotify_budget_low")).toBe(true);
    expect(shouldShowNotice(QUOTA, "spotify_budget_low")).toBe(true);
  });

  it("stays hidden when approachingLimit is set without a code", () => {
    expect(
      shouldShowNotice(
        { throttled: false, approachingLimit: true, code: null, retryAfterSeconds: 0 },
        null
      )
    ).toBe(false);
  });
});

describe("noticeState", () => {
  it("is null when there is nothing to say", () => {
    expect(noticeState(null)).toBeNull();
    expect(noticeState(OPEN)).toBeNull();
  });

  it("calls every refusal blocked, whatever refused", () => {
    expect(noticeState(BLIP)).toBe("blocked");
    expect(noticeState(QUOTA)).toBe("blocked");
    expect(noticeState(RATIONED)).toBe("blocked");
  });

  /**
   * A live refusal outranks the warning it grew out of. "You are about to run
   * out" is the wrong headline for someone who already has, and it would tell
   * them the site still works when it does not.
   */
  it("prefers blocked when a status somehow claims both", () => {
    expect(
      noticeState({ ...RATIONED, approachingLimit: true })
    ).toBe("blocked");
  });
});

describe("SERVICE_NOTICE_UI", () => {
  const LABELS = ["dismiss", "close", "repo"] as const;
  const STATES = ["blocked", "warning"] as const;

  it("carries both languages, and they differ", () => {
    for (const key of LABELS) {
      expect(SERVICE_NOTICE_UI.en[key].trim()).not.toBe("");
      expect(SERVICE_NOTICE_UI.zh[key].trim()).not.toBe("");
      expect(SERVICE_NOTICE_UI.en[key]).not.toBe(SERVICE_NOTICE_UI.zh[key]);
    }
    for (const state of STATES) {
      expect(SERVICE_NOTICE_UI.en.title[state].trim()).not.toBe("");
      expect(SERVICE_NOTICE_UI.zh.title[state].trim()).not.toBe("");
      expect(SERVICE_NOTICE_UI.en.title[state]).not.toBe(
        SERVICE_NOTICE_UI.zh.title[state]
      );
    }
  });

  /**
   * The two headlines have to be different sentences, not one reused. "New
   * playlists aren't loading" is false during a warning — they are loading,
   * which is why there is still time to act — and a host who reads it walks
   * away from a site that would have worked for them.
   */
  it("does not reuse the refusal headline for the warning", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(SERVICE_NOTICE_UI[locale].title.warning).not.toBe(
        SERVICE_NOTICE_UI[locale].title.blocked
      );
    }
  });

  /**
   * `/zh` is written natively rather than translated, so an English string
   * leaking through there is a visible defect. Same rule tests/site-policy.ts
   * pins for the footer.
   */
  it("keeps the Chinese strings free of ASCII letters", () => {
    for (const key of LABELS) {
      expect(SERVICE_NOTICE_UI.zh[key]).not.toMatch(/[A-Za-z]/);
    }
    for (const state of STATES) {
      expect(SERVICE_NOTICE_UI.zh.title[state]).not.toMatch(/[A-Za-z]/);
    }
  });

  /**
   * The label is the only part of this a reader sees, so a wrong href fails
   * silently: the notice still renders, the link still looks like a link, and
   * it lands nowhere. It is the one remedy the message offers.
   */
  it("points the self-host link at the repo", () => {
    expect(SELF_HOST_URL).toBe("https://github.com/Waynting/GuessSong");
  });

  it("namespaces the dismissal key like the other session keys", () => {
    expect(NOTICE_DISMISS_KEY.startsWith("guesssong_")).toBe(true);
  });
});
