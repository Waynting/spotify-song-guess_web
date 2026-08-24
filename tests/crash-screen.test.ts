// @vitest-environment node
import { describe, it, expect } from "vitest";
import { CRASH_REPORT_URL, CRASH_SCREEN_UI } from "@/lib/crash-screen";
import { SELF_HOST_URL } from "@/lib/service-notice";
import { ERROR_MESSAGES } from "@/lib/error-messages";

/**
 * The screen a host sees when everything else has failed. It is the last place
 * a broken string should be able to hide, and the hardest to notice by hand:
 * nobody visits it on purpose.
 */
describe("CRASH_SCREEN_UI", () => {
  const KEYS = ["title", "retry", "restart", "report"] as const;

  it("carries both languages, and they differ", () => {
    for (const key of KEYS) {
      expect(CRASH_SCREEN_UI.en[key].trim()).not.toBe("");
      expect(CRASH_SCREEN_UI.zh[key].trim()).not.toBe("");
      expect(CRASH_SCREEN_UI.en[key]).not.toBe(CRASH_SCREEN_UI.zh[key]);
    }
  });

  /**
   * `/zh` is written natively rather than translated, so an English string
   * leaking through is a visible defect. Same rule tests/service-notice.test.ts
   * and tests/site-policy.test.ts pin.
   */
  it("keeps the Chinese strings free of ASCII letters", () => {
    for (const key of KEYS) {
      expect(CRASH_SCREEN_UI.zh[key]).not.toMatch(/[A-Za-z]/);
    }
  });

  /**
   * The two buttons do different things — one clears the stored game and goes
   * home, the other re-renders in place — so they must not read as the same
   * offer. A host who cannot tell them apart retries the broken thing forever.
   */
  it("does not let the two actions read as the same button", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(CRASH_SCREEN_UI[locale].restart).not.toBe(CRASH_SCREEN_UI[locale].retry);
    }
  });
});

describe("CRASH_REPORT_URL", () => {
  /**
   * A wrong href fails silently: the screen still renders, the link still looks
   * like a link, and it lands on a 404 — for the one reader motivated enough to
   * tell us something broke. It shipped wrong once, pointing at
   * `Waynting/spotify_guess_web` (the local directory name) rather than the
   * actual repo, so this pins it against the URL that is already known good.
   */
  it("points at the same repo as the self-host link", () => {
    expect(CRASH_REPORT_URL.startsWith(SELF_HOST_URL)).toBe(true);
    expect(CRASH_REPORT_URL).toBe("https://github.com/Waynting/GuessSong/issues");
  });
});

describe("the crash screen's message", () => {
  /**
   * The screen renders `client_error` as its body. Pinned here as well as in
   * tests/error-messages.test.ts because this is the callsite: a code renamed
   * out from under the component would still typecheck against a different
   * member of the union and quietly print the wrong sentence.
   */
  it("has a body in both languages", () => {
    expect(ERROR_MESSAGES.client_error.en.trim()).not.toBe("");
    expect(ERROR_MESSAGES.client_error.zh.trim()).not.toBe("");
  });

  /**
   * The host is looking at a blank-page failure with a room waiting. The one
   * thing the message has to do is tell them the way out, and the button is
   * labelled with `restart` — so the sentence has to describe that action.
   */
  it("tells the host that starting over is the way out", () => {
    expect(ERROR_MESSAGES.client_error.en).toMatch(/starting over/i);
    expect(ERROR_MESSAGES.client_error.zh).toMatch(/重新開始/);
  });
});
