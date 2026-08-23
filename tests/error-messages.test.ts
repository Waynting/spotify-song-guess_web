import { describe, it, expect } from "vitest";
import {
  AppError,
  BUZZER_ERROR_CODES,
  ERROR_MESSAGES,
  apiError,
  describeError,
  detectErrorLocale,
  errorMessage,
  isAppErrorCode,
  isDeterministicPlaylistFailure,
  shouldRememberAllRejections,
  shouldRememberRejection,
  type AppErrorCode,
  type ErrorLocale,
} from "@/lib/error-messages";
import { errorResponse } from "@/lib/api-error";

const CODES = Object.keys(ERROR_MESSAGES) as AppErrorCode[];
const LOCALES: ErrorLocale[] = ["en", "zh"];

/** `{seconds}` etc., in the order they appear. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("the message table", () => {
  it("has every code in every language", () => {
    for (const code of CODES) {
      for (const locale of LOCALES) {
        const text = ERROR_MESSAGES[code][locale];
        expect(text, `${code}.${locale}`).toBeTypeOf("string");
        expect(text.trim(), `${code}.${locale} is empty`).not.toBe("");
      }
    }
  });

  it("never ships the English string as the Chinese one", () => {
    // The same defect tests/changelog.test.ts guards on /zh: a fallback that
    // silently reads as English is worse than a missing translation, because
    // nothing fails until a player sees it.
    for (const code of CODES) {
      expect(ERROR_MESSAGES[code].zh, `${code} is not translated`).not.toBe(
        ERROR_MESSAGES[code].en
      );
    }
  });

  it("keeps the same placeholders in both languages", () => {
    // A translation that drops `{seconds}` loses the only number in the
    // sentence; one that invents `{minutes}` renders the braces literally.
    for (const code of CODES) {
      expect(placeholders(ERROR_MESSAGES[code].zh), `${code}`).toEqual(
        placeholders(ERROR_MESSAGES[code].en)
      );
    }
  });

  /**
   * Guards the other half of the placeholder contract: a code with a
   * placeholder is only correct if every caller passes params, and a caller
   * that forgets prints "{seconds}" at the player. Adding a placeholder to a
   * code outside this list should fail here and make you go find the callers.
   */
  it("has placeholders in exactly the codes whose callers pass params", () => {
    const withParams = CODES.filter((c) => placeholders(ERROR_MESSAGES[c].en).length > 0);
    expect(withParams.sort()).toEqual(
      ["mixed_min_contributors", "mixed_playlists_failed", "spotify_cooldown"].sort()
    );
  });

  it("never blames the host's playlist for the app's spent quota", () => {
    // lib/spotify.ts's hazard, enforced in both languages: telling a throttled
    // host to check their playlist is public sends them back to editing a URL
    // that was always fine, and to retrying into a quota that is already gone.
    for (const code of [
      "spotify_rate_limited",
      "spotify_cooldown",
      "spotify_quota_exhausted",
      "spotify_daily_budget_spent",
      "spotify_busy",
    ] as const) {
      expect(ERROR_MESSAGES[code].en).not.toMatch(/public/i);
      expect(ERROR_MESSAGES[code].zh).not.toMatch(/公開/);
      expect(ERROR_MESSAGES[code].en).toMatch(/your playlist URL is fine/i);
      expect(ERROR_MESSAGES[code].zh).toMatch(/沒有問題/);
    }
  });

  it("covers every code the buzzer Worker can send", () => {
    // The Worker ships its own copy of lib/buzzer-protocol.ts and cannot import
    // this table, so nothing but this test connects the two.
    for (const [wire, code] of Object.entries(BUZZER_ERROR_CODES)) {
      expect(isAppErrorCode(code), `${wire} maps to a code that doesn't exist`).toBe(true);
    }
  });
});

describe("isDeterministicPlaylistFailure", () => {
  it("suppresses a retry only for failures the URL itself decides", () => {
    // The whole set, not a sample. A member dropped from it silently restores
    // the retry storm this exists to stop, and nothing else would catch that.
    for (const code of [
      "missing_playlist_url",
      "playlist_url_required",
      "invalid_playlist_url",
      "playlist_not_found",
      "playlist_editorial",
      "playlist_empty",
    ] as const) {
      expect(isDeterministicPlaylistFailure(code), code).toBe(true);
    }
  });

  it("holds every other code retryable", () => {
    // The complement, derived rather than listed: a code added to the union
    // later defaults to retryable, and if someone makes it deterministic they
    // have to come here and say so deliberately.
    const deterministic = new Set([
      "missing_playlist_url",
      "playlist_url_required",
      "invalid_playlist_url",
      "playlist_not_found",
      "playlist_editorial",
      "playlist_empty",
    ]);
    for (const code of CODES) {
      if (deterministic.has(code)) continue;
      expect(isDeterministicPlaylistFailure(code), code).toBe(false);
    }
  });

  it("never suppresses a retry after throttling", () => {
    // The counterpart of "never blames the host's playlist" above, and the same
    // hazard one step later: a spent quota clears by itself, so a host whose
    // link was always fine has to be able to press Start again and succeed.
    // Listing any of these as deterministic would strand them on a dead button.
    for (const code of [
      "spotify_rate_limited",
      "spotify_cooldown",
      "spotify_quota_exhausted",
      "spotify_daily_budget_spent",
      "spotify_busy",
      "rate_limited",
      "rate_limited_playlist",
    ] as const) {
      expect(isDeterministicPlaylistFailure(code), code).toBe(false);
    }
  });

  it("never suppresses a retry after a failure of unknown cause", () => {
    // "We don't know what happened" must not harden into "don't bother asking".
    for (const code of ["playlist_load_failed", "unknown", "server_error"] as const) {
      expect(isDeterministicPlaylistFailure(code), code).toBe(false);
    }
  });

  it("says no to anything that isn't a code at all", () => {
    for (const value of [undefined, null, "", "not_a_code", 7]) {
      expect(isDeterministicPlaylistFailure(value)).toBe(false);
    }
  });
});

describe("shouldRememberRejection", () => {
  it("remembers a playlist that the link itself dooms", () => {
    expect(shouldRememberRejection(new AppError("playlist_not_found"))).toBe(true);
    expect(shouldRememberRejection(new AppError("playlist_editorial"))).toBe(true);
  });

  it("forgets a throttling refusal, so the host can try again", () => {
    expect(shouldRememberRejection(new AppError("spotify_rate_limited"))).toBe(false);
    expect(shouldRememberRejection(new AppError("spotify_cooldown"))).toBe(false);
    expect(shouldRememberRejection(new AppError("rate_limited_playlist"))).toBe(false);
  });

  it("forgets anything that isn't an AppError", () => {
    // The case with no symptom in development: a dropped connection throws a
    // TypeError with no `code`, and remembering it would leave the host tapping
    // a button that had quietly stopped sending anything.
    expect(shouldRememberRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(shouldRememberRejection(new Error("boom"))).toBe(false);
    expect(shouldRememberRejection(undefined)).toBe(false);
    expect(shouldRememberRejection({ code: "playlist_not_found" })).toBe(false);
  });
});

describe("shouldRememberAllRejections", () => {
  it("writes off a roster only when every contributor is finally doomed", () => {
    expect(
      shouldRememberAllRejections([
        new AppError("playlist_not_found"),
        new AppError("playlist_editorial"),
      ])
    ).toBe(true);
  });

  it("keeps the whole roster retryable if even one failure was transient", () => {
    // The reason the aggregate code cannot be trusted: four private links and
    // one dropped socket still reads as `mixed_playlists_failed`, and writing
    // that off would strand the party on the one contributor who was fine.
    expect(
      shouldRememberAllRejections([
        new AppError("playlist_not_found"),
        new TypeError("Failed to fetch"),
      ])
    ).toBe(false);
    expect(
      shouldRememberAllRejections([
        new AppError("playlist_not_found"),
        new AppError("spotify_rate_limited"),
      ])
    ).toBe(false);
  });

  it("treats no rejections as nothing to write off", () => {
    // `[].every()` is true, so without the length guard a clean run would
    // arm the memo and block the next start outright.
    expect(shouldRememberAllRejections([])).toBe(false);
  });
});


describe("detectErrorLocale", () => {
  it("reads Chinese from any of its tags", () => {
    for (const tag of ["zh", "zh-TW", "zh-Hant-TW", "zh-CN", "ZH-tw"]) {
      expect(detectErrorLocale(tag), tag).toBe("zh");
    }
  });

  it("falls back to English for everything else, including no tag at all", () => {
    for (const tag of ["en", "en-US", "ja", "", "not-a-tag"]) {
      expect(detectErrorLocale(tag), tag).toBe("en");
    }
    // Server render: `navigator` is undefined and this must not throw.
    expect(detectErrorLocale()).toBe("en");
  });
});

describe("errorMessage", () => {
  it("fills placeholders", () => {
    expect(errorMessage("spotify_cooldown", "en", { params: { seconds: 45 } })).toContain("45");
    expect(errorMessage("spotify_cooldown", "zh", { params: { seconds: 45 } })).toContain("45");
  });

  it("leaves an unfilled placeholder visible rather than printing 'undefined'", () => {
    expect(errorMessage("spotify_cooldown", "en")).toContain("{seconds}");
  });

  it("prefers the server's English text over a generic message for a code it doesn't know", () => {
    // A server deployed ahead of the page: the sentence is at least accurate,
    // where "something went wrong" would throw away what the server knew.
    expect(errorMessage("code_from_the_future", "zh", { fallback: "Upstream said no" })).toBe(
      "Upstream said no"
    );
    expect(errorMessage("code_from_the_future", "zh")).toBe(ERROR_MESSAGES.unknown.zh);
    expect(errorMessage(undefined, "en")).toBe(ERROR_MESSAGES.unknown.en);
  });
});

describe("apiError", () => {
  it("reads the code the route sent", () => {
    const err = apiError({ error: "This room is full.", code: "room_full" }, "room_submit_failed");
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("room_full");
    expect(describeError(err, "zh")).toBe(ERROR_MESSAGES.room_full.zh);
  });

  it("turns retryAfter into the {seconds} the message needs", () => {
    const err = apiError({ error: "…", code: "spotify_cooldown", retryAfter: 42.2 }, "unknown");
    expect(describeError(err, "zh")).toContain("43");
  });

  it("falls back to the caller's code for a body with none", () => {
    // An HTML error page from a proxy, or a route that predates codes. The
    // player still gets a sentence about what they were doing.
    expect(apiError(undefined, "room_submit_failed").code).toBe("room_submit_failed");
    expect(apiError("<html>502</html>", "room_open_failed").code).toBe("room_open_failed");
  });
});

describe("describeError", () => {
  it("never leaks a browser's English string into a Chinese UI", () => {
    // What a dropped connection throws. It has no code, so it must not be
    // shown verbatim the way an AppError's message can be.
    const rendered = describeError(new TypeError("Failed to fetch"), "zh", "playlist_load_failed");
    expect(rendered).toBe(ERROR_MESSAGES.playlist_load_failed.zh);
    expect(rendered).not.toContain("fetch");
  });

  it("defaults to the generic code when the caller names none", () => {
    expect(describeError({ not: "an error" }, "en")).toBe(ERROR_MESSAGES.unknown.en);
  });
});

describe("errorResponse", () => {
  it("sends the code, and English text for the logs", async () => {
    const res = errorResponse("room_full", 409);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: ERROR_MESSAGES.room_full.en, code: "room_full" });
  });

  it("keeps Retry-After and the sentence's {seconds} in agreement", async () => {
    const res = errorResponse("spotify_cooldown", 429, { retryAfter: 61.4 });
    const body = await res.json();

    expect(res.headers.get("Retry-After")).toBe("62");
    expect(body.retryAfter).toBe(62);
    expect(body.error).toContain("62");
  });

  it("localises nothing — the language is the reader's to choose", async () => {
    const body = await errorResponse("playlist_not_found", 404).json();
    expect(body.error).toBe(ERROR_MESSAGES.playlist_not_found.en);
    expect(body.error).not.toBe(ERROR_MESSAGES.playlist_not_found.zh);
  });
});
