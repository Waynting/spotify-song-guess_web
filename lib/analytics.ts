/**
 * GA4 event wrapper — typed funnel events for GuessSong.
 *
 * The gtag script is installed in app/layout.tsx (only when
 * NEXT_PUBLIC_GA_MEASUREMENT_ID is set). This module is safe to call from
 * anywhere: it no-ops outside production, and silently does nothing when
 * window.gtag is unavailable (GA not configured, ad blocker, etc.).
 */

import type { ShareOutcome } from "@/lib/result-image";
// Type-only, so the analytics <-> game-session cycle is erased at compile time
// and never becomes a runtime import cycle.
import type { GameMode } from "@/lib/game-session";
import type { ArrivedFrom, LoopSurface } from "@/lib/loop-links";

export type PlaylistSource = "own" | "mixed";
export type ShareType = "track" | "album" | "artist" | "unknown";
/**
 * Why a round had no audio. `absent` is a property of the recording, which is
 * ours to curate around; `unavailable` is a property of our own throttled
 * egress IP, which is ours to fix. See types/preview.ts.
 */
export type PreviewMissReason = "absent" | "unavailable";
/** Which end-of-game image the player saved. */
export type ResultCardType = "scores" | "taste";
/**
 * What the one room code is doing. Both room-created events carry it because a
 * combined room fires *both*, and without this param GA4 can only tell the two
 * apart by joining events within a session — which the standard reports can't do.
 */
export type RoomJobs = "playlists" | "buzzer" | "both";

/**
 * What a room is being asked to do, as the room-event params report it.
 *
 * Lives here rather than in the panel that calls it because it decides the
 * `room_jobs` param on every room-created and room-open-failed event: get it
 * wrong and the whole room funnel is mislabeled rather than merely missing. A
 * module-private helper inside a component is also unreachable from a test,
 * and this repo's suite covers `lib/` only.
 */
export function roomJobs(collectsPlaylists: boolean, buzzer: boolean): RoomJobs {
  if (collectsPlaylists && buzzer) return "both";
  return collectsPlaylists ? "playlists" : "buzzer";
}
/** Who fed the playlist mailbox. The host can't scan their own QR, so they have
 *  a separate path into it and a separate conversion rate. */
export type SubmittedBy = "player" | "host";
/** The join page a scanned phone actually landed on. See roomJoinUrl(). */
export type JoinPage = "buzz" | "j";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/** The funnel + PWA events. Union type locks event names + param shapes. */
export type AnalyticsEvent =
  | {
      name: "playlist_submitted";
      params: { playlist_source: PlaylistSource };
    }
  | {
      name: "game_started";
      params: {
        player_count: number;
        clip_duration: number;
        song_count?: number;
        playlist_source: PlaylistSource;
        /**
         * Optional so every existing caller keeps compiling. Without it the
         * buzzer funnel can't be separated from the party funnel, and the
         * round-by-round drop-off curves of the two modes get averaged into
         * one meaningless line.
         */
        game_mode?: GameMode;
        /**
         * Which loop surface this host came in through, or `organic`.
         *
         * Last loop touch within `LOOP_REF_TTL_MS`, not same-pageview: the
         * conversion happens at a *later* party, so crediting only the visit
         * that carried the `?ref=` would record almost every real conversion
         * as organic and report a working loop as dead.
         *
         * Always produced by `arrivedFrom()`, never read straight off the URL
         * — `/?ref=` is public and this is a GA4 param.
         */
        arrived_from?: ArrivedFrom;
        /**
         * How many games this device has hosted, this one included. 1 for a
         * first-time host.
         *
         * A raw integer, not a bucket: CLAUDE.md's bucketing rule is about
         * *failure* params, where the value comes from an upstream string and
         * the hazard is cardinality and user input. Every count param already
         * here (`round_index`, `player_count`, `rounds_played`) is raw, and
         * bucketing at collection time would freeze the boundaries before the
         * distribution is known. The KV counter caps its own key space
         * separately, where the cardinality actually matters.
         */
        host_game_index?: number;
      };
    }
  | {
      name: "round_completed";
      params: {
        round_index: number; // 1-based
        skipped: boolean;
        playlist_source: PlaylistSource;
      };
    }
  | {
      name: "game_finished";
      params: {
        rounds_played: number;
        total_tracks: number;
        duration_seconds: number;
        playlist_source: PlaylistSource;
        game_mode?: GameMode;
        /** Buzzer mode only: most phones connected at once. The reach denominator. */
        peak_phone_count?: number;
      };
    }
  | {
      name: "preview_miss";
      params: {
        playlist_source: PlaylistSource;
        track_name?: string;
        artist?: string;
        /**
         * Which kind of silence this was. Without it the two are one number,
         * and they call for opposite responses: `absent` is a catalogue gap and
         * the honest answer is to curate around it, while `unavailable` means
         * iTunes throttled our shared egress IP and the song is fine. Reading
         * the second as the first is what sent us hunting for missing songs
         * that were never missing.
         *
         * Optional so existing callers keep compiling; a bucketed enum, never a
         * raw upstream message, per this file's header.
         */
        reason?: PreviewMissReason;
      };
    }
  | {
      name: "mixed_pool_built";
      params: {
        contributor_count: number;
        unique_tracks: number;
        total_raw_tracks: number;
        overlap_count: number;
      };
    }
  /*
   * The room funnel. One code, two halves (mailbox + buzzer socket), and three
   * places a party can silently fall out of it:
   *
   *   room_created / buzz_room_created   host opened a room
   *   room_open_failed                   ...or couldn't. Worker down = the whole
   *                                      buzzer funnel vanishes, and without this
   *                                      event it looks like nobody tried.
   *   room_join_opened                   a phone landed on the join page. This is
   *                                      the DENOMINATOR: room_submission_received
   *                                      alone can't distinguish one scan that
   *                                      submitted from eight where seven bounced.
   *   room_submission_sent / _failed     the phone's own view of submitting, which
   *                                      the host's poll cannot see — a player who
   *                                      hit an error never reaches the mailbox, so
   *                                      host-side counting reads it as "no scan".
   *   room_submission_received           host's poll saw the mailbox grow
   *   room_started / room_start_failed   host consumed the pool and kicked off
   */
  | {
      name: "room_created";
      params: { room_jobs: RoomJobs };
    }
  | {
      name: "room_open_failed";
      params: {
        room_jobs: RoomJobs;
        /**
         * Bucketed, never the raw error message: messages come from upstream and
         * from user input, so sending them would blow up cardinality and could
         * carry a pasted URL into GA4.
         */
        reason: "buzzer_unavailable" | "other";
      };
    }
  | {
      name: "room_join_opened";
      params: { join_page: JoinPage; wants_playlist: boolean };
    }
  | {
      name: "room_submission_sent";
      params: { submitted_by: SubmittedBy; track_count: number };
    }
  | {
      name: "room_submission_failed";
      params: {
        submitted_by: SubmittedBy;
        /**
         * "too_late" is a 410 — the host already built the pool, so this phone
         * scanned after kickoff. Worth separating from a real error: it says the
         * mailbox closes before people finish arriving, which is a design
         * question, not a bug.
         */
        reason: "too_late" | "other";
      };
    }
  | {
      name: "room_submission_received";
      params: { total: number };
    }
  | {
      name: "room_started";
      params: { contributor_count: number; unique_tracks: number };
    }
  | {
      name: "room_start_failed";
      params: { contributor_count: number };
    }
  /*
   * Buzzer Mode events. These exist to answer five questions that no amount of
   * watching one's own parties can answer, because they need n=4000 rather than
   * n=1:
   *
   *   1. How many phones actually join a game?        buzz_player_joined
   *   2. Which round do people stop pressing?         buzz_received.round_index
   *   3. Is the clip the right length?                buzz_received.ms_since_round_open
   *      (first-buzz latency: if everyone buzzes at 2s, 15s clips are too long)
   *   4. Are the songs too hard?                      buzz_round_resolved.verdict
   *   5. How often does nobody know it?               buzz_round_resolved.buzz_count === 0
   *
   * Drop any of these and Buzzer Mode ships as a feature rather than as an
   * instrument, which was the whole reason for choosing this scope.
   */
  | {
      name: "buzz_room_created";
      params: { room_jobs: RoomJobs };
    }
  | {
      name: "buzz_player_joined";
      /** Running count of distinct phones in the room, not a per-join id. */
      params: { player_count: number };
    }
  | {
      name: "buzz_received";
      params: {
        round_index: number; // 1-based, matches round_completed
        /** 1 = won the round. Higher values are the queue behind the winner. */
        buzz_order: number;
        /** Reaction time as the room measured it, not as the phone claims. */
        ms_since_round_open: number;
      };
    }
  | {
      name: "buzz_round_resolved";
      params: {
        round_index: number;
        /** "revealed" means the host gave up on it — nobody got there. */
        verdict: "correct" | "wrong" | "revealed";
        /** 0 means the round opened and nobody pressed at all. */
        buzz_count: number;
      };
    }
  | {
      /**
       * End-of-game image save. The share buttons shipped long before this
       * event did, so until now the loop was unmeasurable — we knew the
       * feature existed but not whether anyone used it.
       *
       * `outcome` is the load-bearing param: only "shared" leaves the device
       * through the share sheet. Counting taps alone would overstate reach,
       * since a download or a dismissed sheet spreads nothing.
       */
      name: "result_shared";
      params: {
        card_type: ResultCardType;
        outcome: ShareOutcome;
        playlist_source: PlaylistSource;
      };
    }
  | {
      name: "pwa_install_prompt";
      params: { outcome: "accepted" | "dismissed" };
    }
  | {
      name: "share_unsupported";
      params: { share_type: ShareType };
    }
  | {
      /** Footer "What's new" overlay. `version` is the newest entry shown, so a
       *  release can be checked against how many people actually read it. */
      name: "changelog_opened";
      params: { version: string };
    }
  | {
      /**
       * A loop surface was rendered to someone. The denominator.
       *
       * Without it a click count cannot be read at all: twelve out of fifteen
       * is a working call to action and twelve out of nine thousand is a dead
       * one, and the two call for opposite responses. Deliberately not reusing
       * `room_join_opened`, which fires per page load rather than per person
       * (a phone that drops Wi-Fi and reloads counts twice) and so is a floor
       * rather than a denominator.
       */
      name: "loop_surface_shown";
      params: { surface: LoopSurface };
    }
  | {
      /**
       * Someone followed a loop link back to the setup page.
       *
       * The GA4 copy of a number the server also counts on `/r/[surface]`.
       * Both exist on purpose and they will disagree: an ad blocker kills this
       * one and not the redirect, a spent rate-limit window drops the redirect's
       * count and not this one. **KV is authoritative**; this
       * half is here for cohorting and for the questions nobody has thought of
       * yet — and the gap between the two is itself a reading of how much of
       * this audience blocks analytics.
       *
       * Fired with the navigation, so it must be sent in a way that survives
       * the page tearing down. See `lib/pulse-client.ts`.
       */
      name: "player_to_host_click";
      params: { surface: LoopSurface };
    }
  | {
      /**
       * A client-side exception reached an error boundary.
       *
       * Until `app/error.tsx` existed there was no boundary at all, so a throw
       * anywhere in the tree replaced the party with Next's default
       * "Application error" screen — and nothing anywhere recorded that it had
       * happened. The one crash we know about arrived as an email, weeks later,
       * from a host who had already given up.
       *
       * `boundary` is where it was caught, not what threw: `route` is the
       * segment boundary (a page or one of its effects), `root` is
       * `global-error.tsx`, which only fires when the root layout itself is the
       * thing that broke. Deliberately no message, stack or digest — the
       * convention this file keeps is bucketed enums, never upstream strings,
       * and a stack frame carries pasted playlist names and query params into
       * GA4. The digest goes to `console.error` on the device instead, which is
       * where the person reading it already is.
       */
      name: "client_error";
      params: { boundary: "route" | "root" };
    };

export type AnalyticsEventName = AnalyticsEvent["name"];

type ParamsFor<N extends AnalyticsEventName> = Extract<
  AnalyticsEvent,
  { name: N }
>["params"];

export function trackEvent<N extends AnalyticsEventName>(
  name: N,
  params: ParamsFor<N>
): void {
  if (process.env.NODE_ENV !== "production") {
    // Dev / test: never send to GA4, log for local verification instead.
    console.debug("[analytics]", name, params);
    return;
  }
  if (typeof window === "undefined" || typeof window.gtag !== "function") {
    return;
  }
  window.gtag("event", name, params);
}
