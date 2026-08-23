/**
 * Every error a player can be shown, in both languages the site ships.
 *
 * ## Why the server sends a code and not a sentence
 *
 * One room is read by several devices at once — the host's laptop, a phone
 * that scanned the QR from across the table — and nothing about a request tells
 * the server which language the *reader* wants. So the API answers with a
 * stable `code` and each client renders it in its own language. The English
 * string still travels along in `error` as a fallback for logs and for a client
 * older than the code it was sent, but no UI should print it when a code is
 * present.
 *
 * Two further reasons this cannot be done server-side:
 *   - `lib/playlist-cache.ts` caches 404s for a week. Localising on the server
 *     would freeze whichever language lost the race into that cache entry and
 *     serve it to everyone else.
 *   - `/api/playlist` is also called on behalf of *other* people's phones in
 *     Mixed mode, where the host's Accept-Language is the wrong answer twice
 *     over.
 *
 * ## Adding an error
 *
 * Add the code to `AppErrorCode`, then the entry to `ERROR_MESSAGES` — the
 * `Record` type makes a missing entry a compile error rather than a silent
 * English fallback, the same trick `lib/changelog.ts` uses. Keep the English
 * text in the table too, so the two languages sit side by side and drift is
 * visible in one diff. `tests/error-messages.test.ts` enforces the rest.
 *
 * Placeholders are `{name}` and are filled by `errorMessage`'s `params`. Keep
 * the same set in both languages — the test checks that too.
 *
 * This file must stay dependency-free: it is imported by API routes, by client
 * components, and by plain `lib/` modules on both sides of the boundary.
 */

import type { BuzzerErrorCode } from "@/lib/buzzer-protocol";

export type ErrorLocale = "en" | "zh";

export type AppErrorCode =
  // Generic
  | "unknown"
  | "server_error"
  // Playlist loading
  | "missing_playlist_url"
  | "playlist_url_required"
  | "invalid_playlist_url"
  | "playlist_not_found"
  | "playlist_editorial"
  | "playlist_empty"
  | "playlist_load_failed"
  | "mixed_playlists_failed"
  // Spotify's shared quota — never phrased as the host's fault, see below
  | "spotify_rate_limited"
  | "spotify_cooldown"
  | "spotify_quota_exhausted"
  | "spotify_daily_budget_spent"
  | "spotify_busy"
  | "spotify_not_configured"
  | "spotify_auth_failed"
  // Per-IP rate limits
  | "rate_limited"
  | "rate_limited_playlist"
  | "rate_limited_preview"
  | "rate_limited_room_create"
  // Preview lookups
  | "preview_request_invalid"
  // Rooms
  | "room_code_invalid"
  | "room_code_taken"
  | "room_code_unavailable"
  | "room_not_found"
  | "room_expired"
  | "room_already_started"
  | "room_name_taken"
  | "room_full"
  | "room_name_required"
  | "room_missing_fields"
  | "room_busy"
  | "room_not_host"
  | "room_no_submissions"
  | "room_invalid_sample_size"
  | "room_needs_a_job"
  | "room_open_failed"
  | "room_submit_failed"
  | "room_host_submit_failed"
  | "room_status_failed"
  | "room_start_failed"
  // Setup screen validation
  | "players_required"
  | "mixed_min_contributors"
  // Buzzer
  | "buzzer_not_configured"
  | "buzzer_origin_blocked"
  | "buzzer_rate_limited"
  | "buzzer_open_failed"
  | "buzzer_bad_response"
  | "buzzer_bad_message"
  | "buzzer_not_joined";

export const ERROR_MESSAGES: Record<AppErrorCode, Record<ErrorLocale, string>> = {
  unknown: {
    en: "Something went wrong. Please try again.",
    zh: "發生了一點問題，請再試一次。",
  },
  server_error: {
    en: "Something went wrong on our end. Please try again.",
    zh: "我們這邊出了點狀況，請再試一次。",
  },

  missing_playlist_url: {
    en: "No playlist link was sent.",
    zh: "沒有收到歌單連結。",
  },
  playlist_url_required: {
    en: "Please enter a Spotify playlist URL.",
    zh: "請貼上 Spotify 歌單連結。",
  },
  invalid_playlist_url: {
    en: "That doesn't look like a Spotify playlist link.",
    zh: "這個連結看起來不是 Spotify 歌單。",
  },
  playlist_not_found: {
    en: "We couldn't open that playlist. Check that it's public, and that it's one you created yourself rather than a Spotify editorial playlist.",
    zh: "找不到這個歌單。請確認：1) 歌單是公開的 2) 歌單是你自己建立的，不是 Spotify 官方編輯歌單。",
  },
  playlist_editorial: {
    en: "Spotify editorial and algorithmic playlists can't be used. Please use a public playlist you created.",
    zh: "Spotify 官方編輯和演算法歌單沒辦法用，請改用你自己建立的公開歌單。",
  },
  playlist_empty: {
    en: "This playlist has no tracks.",
    zh: "這個歌單裡沒有歌曲。",
  },
  playlist_load_failed: {
    en: "Couldn't load that playlist.",
    zh: "讀不到這個歌單。",
  },
  mixed_playlists_failed: {
    en: "Couldn't load a playlist for: {names}. Remove or fix them and try again.",
    zh: "這些人的歌單讀不到：{names}。請移除或修正後再試一次。",
  },

  /**
   * The quota is the app's, not this host's — see lib/spotify.ts. Every string
   * here has to end on "your playlist URL is fine", in both languages: the
   * message this replaced said "make sure the playlist is public", which reads
   * as "your URL is wrong", so hosts edited it and submitted again, spending
   * more of a quota that was already gone.
   */
  spotify_rate_limited: {
    en: "Spotify is rate limiting us right now (too many playlist loads across the whole site). Please wait a minute and try again — your playlist URL is fine.",
    zh: "Spotify 目前正在限制我們的請求（全站同時載入的歌單太多了）。請等一分鐘再試一次 — 你的歌單連結沒有問題。",
  },
  spotify_cooldown: {
    en: "Spotify is rate limiting us right now. Try again in about {seconds}s — your playlist URL is fine.",
    zh: "Spotify 目前正在限制我們的請求。大約 {seconds} 秒後再試一次 — 你的歌單連結沒有問題。",
  },
  /**
   * Deliberately carries no `{seconds}`. This is the code for a wait measured
   * in hours — Spotify's daily app quota, not a burst — and a countdown that
   * long is a promise the app cannot keep: the host waits it out, presses
   * Start, and lands on the same refusal. Says what is true and what still
   * works instead, and like every code in this block it ends by clearing the
   * host's URL, because the failure has nothing to do with it.
   */
  spotify_quota_exhausted: {
    en: "Spotify has cut the whole site off for today — every game here shares one quota with Spotify and it is spent. Playlists that have already been loaded still work; new ones come back once Spotify resets. Your playlist URL is fine.",
    zh: "Spotify 今天已經把整個網站擋下來了 — 這裡所有的遊戲共用同一份 Spotify 配額，而它用完了。已經載入過的歌單還是可以玩，新的歌單要等 Spotify 重置後才會恢復。你的歌單連結沒有問題。",
  },
  /**
   * The self-imposed twin of `spotify_quota_exhausted`, and the distinction is
   * worth a separate code because the two are not the same event: that one is
   * Spotify refusing us, this one is us refusing ourselves *before* Spotify
   * does. Saying "Spotify has cut the whole site off" when it has not would be
   * the same class of untruth as telling a throttled host their playlist is
   * private — technically it produces the same screen, and it teaches the
   * reader something false about who decided.
   *
   * Carries no `{seconds}` for the reason above it: the wait is until enough
   * of the rolling window ages out, which is not a countdown worth watching.
   */
  spotify_daily_budget_spent: {
    en: "This site limits how many new playlists it loads from Spotify in a day, so one busy afternoon can't leave the evening with nothing — and today's allowance is gone. Playlists that have already been loaded still work, and some allowance frees up every hour. Your playlist URL is fine.",
    zh: "這個網站每天會限制向 Spotify 載入新歌單的數量，免得一個下午就把整晚的額度用光 — 今天的額度已經用完了。已經載入過的歌單還是可以玩，每小時也會釋出一些額度。你的歌單連結沒有問題。",
  },
  spotify_busy: {
    en: "Too many new playlists are being loaded across the site right now. Please try again in a minute — your playlist URL is fine.",
    zh: "現在全站同時在載入太多新歌單。請一分鐘後再試一次 — 你的歌單連結沒有問題。",
  },
  spotify_not_configured: {
    en: "This deployment is missing its Spotify credentials.",
    zh: "這個網站的 Spotify 設定不完整。",
  },
  spotify_auth_failed: {
    en: "Couldn't reach Spotify right now. Please try again.",
    zh: "現在連不上 Spotify，請再試一次。",
  },

  rate_limited: {
    en: "Too many attempts, please slow down.",
    zh: "嘗試次數太多了，請慢一點。",
  },
  rate_limited_playlist: {
    en: "Too many playlist loads, please slow down.",
    zh: "載入歌單的次數太多了，請慢一點。",
  },
  /**
   * Never rendered today — the game page treats a preview it cannot fetch as a
   * track with no audio, which is also what an unthrottled miss looks like.
   * Carried anyway so the route answers in the same shape as every other one.
   */
  rate_limited_preview: {
    en: "Too many preview lookups, please slow down.",
    zh: "查詢試聽片段的次數太多了，請慢一點。",
  },
  rate_limited_room_create: {
    en: "Too many rooms created, please slow down.",
    zh: "開了太多房間，請慢一點。",
  },

  /**
   * Like `rate_limited_preview`, never rendered: the game page answers a failed
   * batch by falling back to per-track lookups, which is what it did before
   * batching existed. Carried so the route replies in the same shape as every
   * other one rather than inventing a bare 400.
   */
  preview_request_invalid: {
    en: "That preview request wasn't valid.",
    zh: "這個試聽片段的請求格式不正確。",
  },

  room_code_invalid: {
    en: "That room code isn't valid.",
    zh: "房間代碼不正確。",
  },
  room_code_taken: {
    en: "That room code is already in use.",
    zh: "這個房間代碼已經有人在用了。",
  },
  room_code_unavailable: {
    en: "Couldn't get a free room code, please try again.",
    zh: "找不到可用的房間代碼，請再試一次。",
  },
  room_not_found: {
    en: "This room doesn't exist any more. Check the code, or ask the host for a new one.",
    zh: "找不到這個房間，它可能已經過期了。請確認代碼，或請主持人重開一個。",
  },
  /**
   * Covers two arrivals at the same dead end: the Worker saying the room is
   * gone, and lib/use-buzzer-socket.ts giving up after repeated refused
   * upgrades — which is also what a mistyped code looks like from the phone.
   * Both readings have to be in the sentence.
   */
  room_expired: {
    en: "This room has ended, or the code is wrong. Ask the host for a new one.",
    zh: "這個房間已經結束了，或是代碼不對。請跟主持人拿新的代碼。",
  },
  room_already_started: {
    en: "The host has already started the game.",
    zh: "主持人已經開始遊戲了。",
  },
  room_name_taken: {
    en: "That name is already taken in this room.",
    zh: "這個房間裡已經有人用這個名字了。",
  },
  room_full: {
    en: "This room is full.",
    zh: "這個房間已經滿了。",
  },
  room_name_required: {
    en: "Please enter your name.",
    zh: "請輸入你的名字。",
  },
  room_missing_fields: {
    en: "Please enter your name and a playlist link.",
    zh: "請填寫名字和歌單連結。",
  },
  room_busy: {
    en: "The room is busy right now, please try again.",
    zh: "房間現在有點忙，請再試一次。",
  },
  room_not_host: {
    en: "Only the room's host can start the game.",
    zh: "只有房間的主持人可以開始遊戲。",
  },
  room_no_submissions: {
    en: "Nobody has submitted a playlist yet.",
    zh: "還沒有人交出歌單。",
  },
  room_invalid_sample_size: {
    en: "That number of songs per player isn't valid.",
    zh: "每個人要出的歌曲數量不正確。",
  },
  room_needs_a_job: {
    en: "A room needs at least one job to do.",
    zh: "房間至少要有一項用途。",
  },
  room_open_failed: {
    en: "Couldn't open the room.",
    zh: "開不了房間。",
  },
  room_submit_failed: {
    en: "Couldn't submit your playlist.",
    zh: "沒辦法送出你的歌單。",
  },
  room_host_submit_failed: {
    en: "Couldn't add your playlist.",
    zh: "沒辦法加入你的歌單。",
  },
  room_status_failed: {
    en: "Couldn't load the room.",
    zh: "讀不到房間狀態。",
  },
  room_start_failed: {
    en: "Couldn't start the game.",
    zh: "沒辦法開始遊戲。",
  },

  players_required: {
    en: "Add at least one player.",
    zh: "至少要有一位玩家。",
  },
  mixed_min_contributors: {
    en: "Add at least {count} players' playlists to start.",
    zh: "至少要有 {count} 個人的歌單才能開始。",
  },

  buzzer_not_configured: {
    en: "Buzzer Mode isn't set up on this deployment.",
    zh: "這個網站沒有啟用搶答器模式。",
  },
  buzzer_origin_blocked: {
    en: "The buzzer service refused this site.",
    zh: "搶答器服務不接受這個網站。",
  },
  buzzer_rate_limited: {
    en: "Too many rooms opened from this network — wait a minute and try again.",
    zh: "這個網路開了太多房間，請等一分鐘再試一次。",
  },
  buzzer_open_failed: {
    en: "Couldn't open a buzzer room, please try again.",
    zh: "開不了搶答器房間，請再試一次。",
  },
  buzzer_bad_response: {
    en: "The buzzer service returned something unexpected.",
    zh: "搶答器服務回傳了非預期的內容。",
  },
  buzzer_bad_message: {
    en: "The buzzer didn't understand that. Try reloading the page.",
    zh: "搶答器看不懂這個指令，請重新整理頁面。",
  },
  buzzer_not_joined: {
    en: "You're not in this room yet.",
    zh: "你還沒有加入這個房間。",
  },
};

/**
 * The Worker's wire codes, mapped onto app codes.
 *
 * Deliberately a mapping rather than a second copy of these strings: a phone
 * that is refused by the Durable Object because the room is full and a phone
 * refused by the mailbox for the same reason are the same sentence to the
 * player, and keeping one entry means they cannot drift into two translations
 * of the same thing. `lib/buzzer-protocol.ts` stays free of any of this — it is
 * shared verbatim with the Worker and must stay dependency-free.
 */
export const BUZZER_ERROR_CODES: Record<BuzzerErrorCode, AppErrorCode> = {
  room_full: "room_full",
  name_taken: "room_name_taken",
  not_host: "room_not_host",
  bad_message: "buzzer_bad_message",
  not_joined: "buzzer_not_joined",
  room_expired: "room_expired",
};

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && value in ERROR_MESSAGES;
}

/**
 * Which language to render errors in.
 *
 * Read from the device rather than from the page: `/zh` is a landing page with
 * no error surfaces, and every screen that *can* fail (setup, `/j/`, `/buzz/`)
 * is reached by a phone whose owner never chose a language on this site. A
 * Taiwanese guest scanning an English host's QR should still be able to read
 * why their playlist was refused.
 *
 * Takes the tag as an argument so it is testable and so callers can override
 * it; falls back to English anywhere `navigator` doesn't exist, which includes
 * every server render.
 */
export function detectErrorLocale(language?: string): ErrorLocale {
  const tag =
    language ?? (typeof navigator === "undefined" ? "" : navigator.language ?? "");
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export interface ErrorMessageOptions {
  /** Fills `{name}` placeholders. Numbers are stringified as-is. */
  params?: Record<string, string | number>;
  /**
   * Shown when the code is unknown to this build — i.e. a server that is newer
   * than the page. The server's English `error` string goes here, so a client
   * that has not been redeployed yet degrades to English rather than to
   * "something went wrong".
   */
  fallback?: string;
}

export function errorMessage(
  code: unknown,
  locale: ErrorLocale,
  options: ErrorMessageOptions = {}
): string {
  if (!isAppErrorCode(code)) {
    return options.fallback?.trim() || ERROR_MESSAGES.unknown[locale];
  }
  const template = ERROR_MESSAGES[code][locale];
  if (!options.params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = options.params?.[key];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Codes that describe the *link*, not the moment.
 *
 * Resubmitting a byte-identical URL after one of these cannot produce a
 * different answer: `lib/playlist-cache.ts` caches the 404 for
 * NOT_FOUND_TTL_SECONDS (10 minutes), so for that whole window the server is
 * replaying a decision it has already made, and the ones that never reach
 * Spotify at all are pure string checks on the URL.
 *
 * This exists because of what the production logs actually show. A host who
 * pastes a private playlist gets a 404 back in ~100ms — fast enough that the
 * Start button re-enables between mashes — and the observed result is bursts of
 * fourteen identical `POST /api/playlist` calls 150-300ms apart. Every one is a
 * billed function invocation spent re-reading the same cached refusal, and they
 * were 78% of all billed invocations in a two-minute sample.
 *
 * ## What must never be listed here
 *
 * Only failures that are a fact about the URL. Every throttling code is
 * excluded, and must stay excluded: `spotify_rate_limited`, `spotify_cooldown`,
 * `spotify_quota_exhausted`, `spotify_daily_budget_spent` and `spotify_busy`
 * are facts about a shared quota
 * that clears on its own, so
 * suppressing the retry would strand a host whose playlist was always fine —
 * the same class of mistake as the message that used to tell throttled hosts to
 * check their URL was public. `playlist_load_failed`, `unknown` and
 * `server_error` are excluded for the opposite reason: we do not know what went
 * wrong, and "we don't know" must never harden into "don't bother asking".
 *
 * `tests/error-messages.test.ts` pins both halves of that.
 */
const DETERMINISTIC_PLAYLIST_CODES = new Set<AppErrorCode>([
  "missing_playlist_url",
  "playlist_url_required",
  "invalid_playlist_url",
  "playlist_not_found",
  "playlist_editorial",
  "playlist_empty",
]);

/**
 * Whether resubmitting the same playlist URL is guaranteed to fail the same
 * way. Callers use it to re-show the error they already have instead of
 * spending a request to be told it again — see the set above.
 */
export function isDeterministicPlaylistFailure(code: unknown): boolean {
  return isAppErrorCode(code) && DETERMINISTIC_PLAYLIST_CODES.has(code);
}

/**
 * An error that already knows which message it is. Thrown by the client-side
 * helpers (`lib/room-client.ts`, `lib/buzzer-client.ts`) and by every `fetch`
 * wrapper, so a `catch` block can localise without re-deriving what went wrong
 * from an English sentence.
 *
 * `message` stays English on purpose: it is what lands in logs and in
 * `console.error`, and it is never what the UI prints — `describeError` is.
 */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly params?: Record<string, string | number>,
    /** Server-supplied English text, when it sent something we can't map. */
    readonly fallbackMessage?: string
  ) {
    super(fallbackMessage ?? errorMessage(code, "en", { params }));
    this.name = "AppError";
  }
}

/** The shape every API route's error response has. */
export interface ApiErrorBody {
  /** English, for logs and for clients older than `code`. Never rendered when `code` maps. */
  error: string;
  code: AppErrorCode;
  /** Seconds to wait, on the throttling codes that carry one. */
  retryAfter?: number;
}

/**
 * Turn a failed `fetch` response body into an `AppError`.
 *
 * `fallback` is the code to use when the body has none — an HTML error page
 * from a proxy, a route that hasn't been migrated, a network-level failure the
 * caller already caught. It should be the "this call failed" code for the
 * calling screen, not `unknown`, so the player still gets a sentence about the
 * thing they were doing.
 */
export function apiError(body: unknown, fallback: AppErrorCode): AppError {
  const data = (body ?? {}) as Partial<ApiErrorBody>;
  const code = isAppErrorCode(data.code) ? data.code : fallback;
  const params =
    typeof data.retryAfter === "number" && Number.isFinite(data.retryAfter)
      ? { seconds: Math.ceil(data.retryAfter) }
      : undefined;
  return new AppError(code, params, typeof data.error === "string" ? data.error : undefined);
}

/**
 * What to put on screen for anything a `catch` block caught. Non-`AppError`
 * throws (a dropped connection, a JSON parse failure) have no code to read, so
 * they become `fallback` rather than leaking a browser-generated English
 * string like "Failed to fetch" into a Chinese UI.
 */
export function describeError(
  err: unknown,
  locale: ErrorLocale,
  fallback: AppErrorCode = "unknown"
): string {
  if (err instanceof AppError) {
    return errorMessage(err.code, locale, {
      params: err.params,
      fallback: err.fallbackMessage,
    });
  }
  return errorMessage(fallback, locale);
}

/**
 * Whether a failed playlist submit should be remembered, so that resubmitting
 * the identical URL re-shows the error instead of spending another request.
 *
 * Lives here rather than at the call site for the reason `roomJobs()` does: the
 * suite only reaches `lib/`, and this is the half worth protecting. It is two
 * conditions, and dropping either one is a bug with no symptom in development —
 * lose the `AppError` check and a dropped connection (a `TypeError`, no `code`
 * at all) starts being remembered as though the link were bad, stranding a host
 * behind a button that has stopped asking; lose the code check and every
 * failure is remembered, throttling included.
 */
export function shouldRememberRejection(err: unknown): boolean {
  return err instanceof AppError && isDeterministicPlaylistFailure(err.code);
}

/**
 * The same question for a batch: may this whole submission be written off?
 *
 * Mixed Playlist Mode loads every contributor's playlist at once and reports
 * them as one `mixed_playlists_failed`, which is emphatically NOT a
 * deterministic code — it aggregates whatever went wrong, and a single 500 or
 * dropped socket lands in it alongside genuinely private links. Reading the
 * aggregate as final would strand a whole party on one contributor's transient
 * blip, so the decision has to be made from the individual reasons instead.
 *
 * Requires at least one reason, because `[].every()` is `true` and "nothing
 * failed" must never be read as "everything failed permanently".
 */
export function shouldRememberAllRejections(reasons: unknown[]): boolean {
  return reasons.length > 0 && reasons.every(shouldRememberRejection);
}
