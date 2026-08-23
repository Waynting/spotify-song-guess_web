// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  NOTICE_DISMISS_KEY,
  SERVICE_NOTICE_UI,
  shouldShowNotice,
} from "@/lib/service-notice";
import type { SpotifyServiceStatus } from "@/types/service-status";

const OPEN: SpotifyServiceStatus = {
  throttled: false,
  code: null,
  retryAfterSeconds: 0,
};
const BLIP: SpotifyServiceStatus = {
  throttled: true,
  code: "spotify_cooldown",
  retryAfterSeconds: 90,
};
const QUOTA: SpotifyServiceStatus = {
  throttled: true,
  code: "spotify_quota_exhausted",
  retryAfterSeconds: 48_513,
};
const RATIONED: SpotifyServiceStatus = {
  throttled: true,
  code: "spotify_daily_budget_spent",
  retryAfterSeconds: 1_800,
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
        { throttled: true, code: null, retryAfterSeconds: 60 },
        null
      )
    ).toBe(false);
  });
});

describe("SERVICE_NOTICE_UI", () => {
  it("carries both languages, and they differ", () => {
    for (const key of ["title", "dismiss", "close"] as const) {
      expect(SERVICE_NOTICE_UI.en[key].trim()).not.toBe("");
      expect(SERVICE_NOTICE_UI.zh[key].trim()).not.toBe("");
      expect(SERVICE_NOTICE_UI.en[key]).not.toBe(SERVICE_NOTICE_UI.zh[key]);
    }
  });

  /**
   * `/zh` is written natively rather than translated, so an English string
   * leaking through there is a visible defect. Same rule tests/site-policy.ts
   * pins for the footer.
   */
  it("keeps the Chinese strings free of ASCII letters", () => {
    for (const key of ["title", "dismiss", "close"] as const) {
      expect(SERVICE_NOTICE_UI.zh[key]).not.toMatch(/[A-Za-z]/);
    }
  });

  it("namespaces the dismissal key like the other session keys", () => {
    expect(NOTICE_DISMISS_KEY.startsWith("guesssong_")).toBe(true);
  });
});
