"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Track } from "@/types";
import { DEFAULT_SAMPLED_PER_PLAYER, type RoomSubmissionSummary, type RoomPoolResponse } from "@/types/room";
import { trackEvent } from "@/lib/analytics";
import { arrivedFrom } from "@/lib/loop-links";
import { bumpHostGameCount, recallLoopRef, rememberLoopRef } from "@/lib/host-session";
import { reportGameStart } from "@/lib/loop-client";
import type { MixedSubMode } from "@/lib/loop-stats";
import {
  AppError,
  apiError,
  describeError,
  errorMessage,
  shouldRememberAllRejections,
  shouldRememberRejection,
} from "@/lib/error-messages";
import { useErrorLocale } from "@/lib/use-error-locale";
import { ServiceNotice } from "@/components/service-notice";
import { buildGamePayload } from "@/lib/game-session";
import { saveGame } from "@/lib/game-storage";
import { isBuzzerConfigured } from "@/lib/buzzer-client";
import type { OpenRoom } from "@/lib/room-client";
import { RoomPanel } from "@/components/room-panel";
import { SiteFooter } from "@/components/site-footer";
import { getGuide } from "@/lib/guides";
import { InstallBanner } from "@/components/install-banner";
import {
  MixedPlaylistCollector,
  type MixedContribution,
} from "@/components/mixed-playlist-collector";
import { mixedRosterKey, poolContributions } from "@/lib/mixed-playlist";
import {
  SONG_COUNTS,
  MAX_SONG_COUNT,
  DEFAULT_SONG_COUNT_STATE,
  selectPreset,
  typeCustom,
  commitCustom,
  isCustomSelected,
} from "@/lib/song-count";

const CLIP_DURATIONS = [5, 10, 15, 20, 30];
const MIXED_SAMPLE_COUNTS = [5, 8, 10, 12];
const MIXED_MIN_CONTRIBUTORS = 2;

/**
 * How many /api/playlist loads Mixed mode has in flight at once.
 *
 * One Start click fans out to one request per contributor — up to 12 — and
 * each of those pages through a playlist against a Spotify quota shared by the
 * entire site. Firing them all simultaneously is what put three POSTs inside
 * the same second in the production logs. Two at a time keeps the wall-clock
 * respectable while giving the server-side cache a chance to be warm for the
 * later ones, which matters whenever two friends contribute the same playlist.
 */
const MIXED_FETCH_CONCURRENCY = 2;

/**
 * Promise.allSettled with a ceiling on how many run at once. Results stay in
 * input order, because the caller maps rejections back to contributor names by
 * index to build its error message.
 */
async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
  return results;
}

// Rendered on the page *and* emitted as FAQPage JSON-LD below — keep the two
// in sync, Google penalises schema that doesn't match visible content.
// The handful of guides linked from the homepage. Resolved through getGuide
// rather than retyped so the titles here cannot drift from the articles
// themselves; filtered so a retired slug costs a card instead of crashing the
// homepage. This is also the only inbound link a new guide gets from the
// highest-authority page on the site, which is what gets it crawled — so a
// newly published article is worth putting here for a while.
const HOME_GUIDES = [
  "how-to-host-a-music-quiz-night",
  "guess-the-song-game-rules",
  "best-playlists-for-a-guess-the-song-game",
  "spotify-playlist-not-working",
]
  .map((slug) => getGuide(slug))
  .filter((guide): guide is NonNullable<typeof guide> => Boolean(guide));

const FAQS: { q: string; a: string }[] = [
  {
    q: "How do you play the guess the song game?",
    a: "One person hosts on a single screen. Paste a public Spotify playlist, add everyone's names, and the game plays a short clip (5 to 30 seconds) from a random track. Everyone shouts their guess out loud and the host taps whoever got it first: 3 points for the song title, 1 more for the album.",
  },
  {
    q: "Do I need a Spotify account or a login?",
    a: "No. GuessSong never asks anyone to sign in, and there are no accounts to create. It reads the track list from any public playlist link and plays a short preview clip of each song.",
  },
  {
    q: "Is it free?",
    a: "Yes, completely free and open source. There is nothing to install and nothing to pay for — it runs in the browser.",
  },
  {
    q: "How many people can play?",
    a: "As many as fit around one screen. GuessSong is a local party game: the host controls the music and the scoreboard, and everyone else just listens and guesses. You can also turn on Buzzer Mode so players buzz in from their own phones.",
  },
  {
    q: "Can everyone use their own playlist?",
    a: "Yes — that's Mixed Playlist Mode. Everyone submits their own playlist, GuessSong merges them into one pool and removes duplicates, and you get a bonus point for guessing whose playlist a track came from.",
  },
  {
    q: "Why do some songs have no audio?",
    a: "Spotify stopped providing preview clips for many tracks in late 2024, so GuessSong looks the song up on iTunes and Deezer instead. A small number of tracks have no preview anywhere and get skipped — playlists with mainstream music tend to work best.",
  },
];

type SetupMode = "single" | "mixed";

// `MixedSubMode` is imported rather than redeclared here. It was a local copy
// with the same two members until the KV counters started keying off it, and a
// second copy of a union whose members become part of a key is the shape that
// drifts silently: the toggle would keep working, the counter would keep
// counting, and they would be counting different things. Same reason
// `lib/loop-links.ts` declares its surfaces once.

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function WaveformBg() {
  const bars = Array.from({ length: 60 }, (_, i) => i);
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
      <div className="absolute bottom-0 left-0 right-0 h-64 flex items-end justify-center gap-[3px] opacity-[0.06]">
        {bars.map((i) => (
          <div
            key={i}
            className="waveform-bar bg-[#1DB954] rounded-t-sm"
            style={{
              width: "3px",
              height: `${(20 + Math.sin(i * 0.4) * 15 + Math.sin(i * 0.9) * 20 + Math.cos(i * 0.7) * 15).toFixed(2)}%`,
              animationDelay: `${(i * 0.05) % 2}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const [setupMode, setSetupMode] = useState<SetupMode>("single");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [players, setPlayers] = useState<string[]>(["", ""]);
  const [clipDuration, setClipDuration] = useState(15);
  // Selected count + the custom field's text, moved together so the transitions
  // between them stay in lib/song-count.ts where the suite can reach them.
  const [songCount, setSongCount] = useState(DEFAULT_SONG_COUNT_STATE);
  // Buzzer Mode is opt-in per game, and only offered when the deployment has a
  // Worker to talk to — no point showing a toggle that can only fail.
  const [buzzerEnabled, setBuzzerEnabled] = useState(false);
  // One room, opened BEFORE the game starts so players have time to scan in,
  // and carrying whichever backends the chosen modes need. Null until the host
  // opens it, and never opened at all for the flows that need no phones.
  const [openedRoom, setOpenedRoom] = useState<OpenRoom | null>(null);
  const [buzzerPlayerCount, setBuzzerPlayerCount] = useState(0);
  const [mixedContributions, setMixedContributions] = useState<MixedContribution[]>([]);
  const [sampledPerPlayer, setSampledPerPlayer] = useState(DEFAULT_SAMPLED_PER_PLAYER);
  const [mixedSubMode, setMixedSubMode] = useState<MixedSubMode>("room");
  const [roomSubmissions, setRoomSubmissions] = useState<RoomSubmissionSummary[]>([]);
  const [roomStarting, setRoomStarting] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const locale = useErrorLocale();
  const firstInputRef = useRef<HTMLInputElement>(null);

  /**
   * The last submission that failed in a way the submission itself determines,
   * and the sentence the host was shown for it.
   *
   * Start is already disabled while a load is in flight, but a refused playlist
   * comes back from the negative cache in about 100ms, so the button re-enables
   * between mashes and every extra tap is another billed invocation that can
   * only replay the same refusal. Keyed on what was submitted — the URL for a
   * single playlist, the whole roster for a mix — so changing it needs no
   * explicit reset: the key simply stops matching.
   *
   * One ref rather than one per mode: the modes share a Start button, and a
   * host who switches mode has changed the question, so losing the other
   * mode's memo costs at most one request.
   */
  const lastRejectedRef = useRef<{ key: string; message: string } | null>(null);

  // What the one room has to do, given the modes picked above. Pass-the-phone
  // with the buzzer off needs no room at all, and never opens one.
  const collectsPlaylists = setupMode === "mixed" && mixedSubMode === "room";
  const needsRoom = collectsPlaylists || buzzerEnabled;

  function addMixedContribution(c: MixedContribution) {
    setMixedContributions((prev) => [...prev, c]);
  }

  function removeMixedContribution(idx: number) {
    setMixedContributions((prev) => prev.filter((_, i) => i !== idx));
  }

  /**
   * Discard a room whose jobs no longer match the chosen modes. Switching from
   * Mixed·QR to Single after opening a room would otherwise leave a mailbox
   * handle around that the new mode never reads, and — worse in the other
   * direction — a buzzer-only room in a mixed game whose code has no mailbox
   * behind it, so every scan lands on a form that cannot submit.
   */
  function resetRoom() {
    setOpenedRoom(null);
    setRoomSubmissions([]);
    setBuzzerPlayerCount(0);
    setRoomError(null);
  }

  async function handleRoomStart() {
    if (!openedRoom?.playlistHostToken) return;
    setRoomError(null);
    setRoomStarting(true);
    try {
      const res = await fetch(
        `/api/room/${openedRoom.code}/pool?sampledPerPlayer=${sampledPerPlayer}`,
        { headers: { "x-host-token": openedRoom.playlistHostToken } }
      );
      const data: RoomPoolResponse & { error?: string } = await res.json();
      if (!res.ok) throw apiError(data, "room_start_failed");

      // Already open, and sharing this room's single code — the host claimed the
      // Durable Object before the code was ever shown, so there was nothing for
      // a guest to race for. See lib/room-client.ts.
      const room = openedRoom.buzzer;

      const payload = buildGamePayload({
        tracks: data.tracks,
        players: data.players.map((name) => ({ name, score: 0 })),
        playlistName: `${data.players.length}-Player Mix`,
        clipDuration,
        totalTracks: data.tracks.length,
        playlistSource: "mixed",
        mode: room ? "buzzer" : "party",
        mixedPlaylistMeta: {
          contributorNames: data.players,
          sampledPerPlayer: data.sampledPerPlayer,
        },
        ...(room ? { buzzerRoom: room } : {}),
      });
      // A browser that refuses to store this has not refused the playlist, and
      // must not be told it did. See lib/game-storage.ts.
      if (!saveGame(payload)) throw new AppError("storage_blocked");
      trackEvent("game_started", {
        player_count: data.players.length,
        clip_duration: clipDuration,
        song_count: data.tracks.length,
        playlist_source: "mixed",
        game_mode: room ? "buzzer" : "party",
        ...recordHostedStart("room"),
      });
      trackEvent("room_started", {
        contributor_count: data.players.length,
        unique_tracks: data.tracks.length,
      });
      router.push("/game");
    } catch (e: unknown) {
      // The last step of the room funnel, and the one where a full room can still
      // end in no game at all — every playlist submitted and the pool refused.
      trackEvent("room_start_failed", { contributor_count: roomSubmissions.length });
      setRoomError(describeError(e, locale, "room_start_failed"));
    } finally {
      setRoomStarting(false);
    }
  }

  useEffect(() => {
    setMounted(true);
    // Read straight off `window.location`, not `useSearchParams`. This page is
    // a client component that is still statically prerendered — it carries the
    // FAQ structured data and takes essentially all of the site's traffic — and
    // an unsuspended `useSearchParams` would either fail the build or opt the
    // whole page out of prerendering. There is no Suspense boundary anywhere in
    // this app, and this is not the page to introduce one on.
    const query = new URLSearchParams(window.location.search);

    // Prefill from the share target redirect (/share → /?playlist=...).
    const shared = query.get("playlist");
    if (shared) setPlaylistUrl(shared);

    // Attribution from /r/[surface]. Stored rather than used immediately: the
    // person who just followed a call to action at someone else's party is not
    // about to host one tonight, so the game this credits is weeks away.
    const ref = query.get("ref");
    if (ref) rememberLoopRef(ref);
  }, []);

  /**
   * Everything a hosted start owes the funnel, in one place.
   *
   * Called by the three paths that begin a real party — own playlist, mixed
   * pool, and the room variant. Any future path that is one person trying the
   * app rather than hosting for a room must stay out of it: counting those
   * would inflate the single number that answers whether anyone comes back.
   *
   * Has side effects: it advances the device's game counter and beacons the
   * new index to `/api/pulse`, which is the only path by which that number
   * reaches `npm run stats`. GA4 gets the same value as a param below.
   *
   * `mixed` names which route collected the playlists, and the two mixed
   * callers must pass it. It is the only way either of them appears in KV at
   * all: the `join_submitted` surface is rendered by `/j/[code]`, but
   * `roomJoinUrl` sends players to `/buzz/[code]` as soon as the buzzer is on,
   * and the phone route never shows a join page to anybody. Both were therefore
   * invisible to every counter, which is not the same as unused — and a
   * question `npm run stats` cannot answer is one nobody will answer.
   */
  function recordHostedStart(mixed?: MixedSubMode) {
    const hostGameIndex = bumpHostGameCount();
    reportGameStart(hostGameIndex, mixed);
    return {
      host_game_index: hostGameIndex,
      arrived_from: arrivedFrom(recallLoopRef()),
    };
  }

  const isValidSpotifyUrl = playlistUrl.includes("spotify.com/playlist") || playlistUrl.includes("spotify:playlist:");
  const isEditorial = playlistUrl.includes("37i9");

  function addPlayer() {
    setPlayers((p) => [...p, ""]);
  }

  function removePlayer(idx: number) {
    setPlayers((p) => p.filter((_, i) => i !== idx));
  }

  function updatePlayer(idx: number, val: string) {
    setPlayers((p) => p.map((v, i) => (i === idx ? val : v)));
  }

  async function handleStart() {
    setError(null);
    const validPlayers = players.filter((p) => p.trim());
    if (!playlistUrl.trim()) {
      setError(errorMessage("playlist_url_required", locale));
      return;
    }
    // Buzzer Mode has no manual roster to check — players name themselves as
    // they scan in, and the scoreboard fills from the room. Blocking on an
    // empty list here would make "Start Game" unreachable in the exact mode
    // that hides the list.
    if (!buzzerEnabled && validPlayers.length < 1) {
      setError(errorMessage("players_required", locale));
      return;
    }
    // Same link, same refusal. Re-show it rather than spending a request to be
    // told the identical thing — see `lastRejectedRef`. Deliberately silent
    // about the shortcut: from the host's side this is the error they are
    // already looking at, and the fix is still to change the link.
    const submissionKey = `own:${playlistUrl}`;
    const rejected = lastRejectedRef.current;
    if (rejected && rejected.key === submissionKey) {
      setError(rejected.message);
      return;
    }
    setLoading(true);
    trackEvent("playlist_submitted", { playlist_source: "own" });
    try {
      const res = await fetch("/api/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: playlistUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw apiError(data, "playlist_load_failed");

      const shuffled = [...data.tracks].sort(() => Math.random() - 0.5);
      const limited =
        songCount.count === "all" ? shuffled : shuffled.slice(0, songCount.count);

      // Opened from the room step before we got here, so players have already
      // had time to scan in. `undefined` when Buzzer Mode is off.
      const room = buzzerEnabled ? openedRoom?.buzzer : undefined;

      const payload = buildGamePayload({
        tracks: limited,
        // Empty in Buzzer Mode, even if the inputs still hold something. A host
        // who typed two names and then turned the toggle on would otherwise ship
        // rows nobody can claim: the section is hidden, so those names are
        // invisible, but they'd sit on the scoreboard all game next to the real
        // players the room reports.
        players: room ? [] : validPlayers.map((name) => ({ name, score: 0 })),
        playlistName: data.name,
        clipDuration,
        totalTracks: data.totalTracks,
        playlistSource: "own",
        mode: room ? "buzzer" : "party",
        ...(room ? { buzzerRoom: room } : {}),
      });
      // A browser that refuses to store this has not refused the playlist, and
      // must not be told it did. See lib/game-storage.ts.
      if (!saveGame(payload)) throw new AppError("storage_blocked");
      trackEvent("game_started", {
        // Phones that scanned in, plus the host, who buzzes from the game
        // screen. The typed count is 0 for every buzzer game, so reporting it
        // would quietly zero out the metric for the mode we care most about.
        player_count: room ? buzzerPlayerCount + 1 : validPlayers.length,
        clip_duration: clipDuration,
        song_count: limited.length,
        playlist_source: "own",
        game_mode: room ? "buzzer" : "party",
        ...recordHostedStart(),
      });
      router.push("/game");
    } catch (e: unknown) {
      const message = describeError(e, locale, "playlist_load_failed");
      // Only failures the URL itself determines are remembered. A throttled or
      // unknown one has to stay retryable — the host's link may be perfect and
      // the next attempt may well be the one that works.
      lastRejectedRef.current = shouldRememberRejection(e)
        ? { key: submissionKey, message }
        : null;
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleMixedStart() {
    setError(null);
    if (mixedContributions.length < MIXED_MIN_CONTRIBUTORS) {
      setError(
        errorMessage("mixed_min_contributors", locale, {
          params: { count: MIXED_MIN_CONTRIBUTORS },
        })
      );
      return;
    }
    // Same roster, same refusal — the single-playlist reasoning one flow over,
    // except a mash here re-fires one request per contributor rather than one.
    const submissionKey = `mixed:${mixedRosterKey(
      mixedContributions.map((c) => c.playlistUrl)
    )}`;
    const rejected = lastRejectedRef.current;
    if (rejected && rejected.key === submissionKey) {
      setError(rejected.message);
      return;
    }
    /**
     * Whether every contributor that failed did so for a reason the link
     * itself decides. Computed inside the try, where the individual reasons
     * are still in scope, and read in the catch, where only the aggregate
     * `mixed_playlists_failed` survives — and that code is not evidence of
     * anything permanent on its own. See `shouldRememberAllRejections`.
     */
    let allFailuresFinal = false;
    setLoading(true);
    trackEvent("playlist_submitted", { playlist_source: "mixed" });
    try {
      const results = await settleWithConcurrency(
        mixedContributions,
        MIXED_FETCH_CONCURRENCY,
        async (c) => {
          const res = await fetch("/api/playlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: c.playlistUrl }),
          });
          const data = await res.json();
          if (!res.ok) {
            const err = apiError(data, "playlist_load_failed");
            // Carried so the summary below can tell "this playlist is broken"
            // apart from "Spotify is throttling the whole site".
            (err as AppError & { status?: number }).status = res.status;
            throw err;
          }
          return { playerName: c.name, tracks: data.tracks as Track[] };
        }
      );

      // A 429 is not the contributor's fault, and telling someone to "remove
      // or fix" a perfectly good playlist sends them straight back to retrying,
      // which is what keeps the shared quota spent. Surface the wait instead.
      const throttled = results.find(
        (r): r is PromiseRejectedResult =>
          r.status === "rejected" &&
          (r.reason as { status?: number } | undefined)?.status === 429
      );
      if (throttled) {
        // Rethrown whole rather than re-wrapped: the original carries the code
        // and its `{seconds}`, so the host reads the same wait their own
        // single-playlist start would have shown them, in their own language.
        throw throttled.reason instanceof AppError
          ? throttled.reason
          : new AppError("spotify_rate_limited");
      }

      const failedNames = results
        .map((r, i) => (r.status === "rejected" ? mixedContributions[i].name : null))
        .filter((n): n is string => n !== null);
      if (failedNames.length > 0) {
        allFailuresFinal = shouldRememberAllRejections(
          results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => r.reason)
        );
        throw new AppError("mixed_playlists_failed", { names: failedNames.join(", ") });
      }

      const contributions = (
        results as PromiseFulfilledResult<{ playerName: string; tracks: Track[] }>[]
      ).map((r) => r.value);
      const totalRawTracks = contributions.reduce((sum, c) => sum + c.tracks.length, 0);
      const pooled = poolContributions(contributions, sampledPerPlayer);
      const overlapCount = pooled.filter((t) => t.contributors.length > 1).length;

      // Pass-the-phone collects its players here on this screen, so the only
      // reason it opens a room at all is the buzzer.
      const room = buzzerEnabled ? openedRoom?.buzzer : undefined;

      const payload = buildGamePayload({
        tracks: pooled,
        players: mixedContributions.map((c) => ({ name: c.name, score: 0 })),
        playlistName: `${mixedContributions.length}-Player Mix`,
        clipDuration,
        totalTracks: pooled.length,
        playlistSource: "mixed",
        mode: room ? "buzzer" : "party",
        mixedPlaylistMeta: {
          contributorNames: mixedContributions.map((c) => c.name),
          sampledPerPlayer,
        },
        ...(room ? { buzzerRoom: room } : {}),
      });
      // A browser that refuses to store this has not refused the playlist, and
      // must not be told it did. See lib/game-storage.ts.
      if (!saveGame(payload)) throw new AppError("storage_blocked");
      trackEvent("game_started", {
        player_count: mixedContributions.length,
        clip_duration: clipDuration,
        song_count: pooled.length,
        playlist_source: "mixed",
        game_mode: room ? "buzzer" : "party",
        ...recordHostedStart("phone"),
      });
      trackEvent("mixed_pool_built", {
        contributor_count: mixedContributions.length,
        unique_tracks: pooled.length,
        total_raw_tracks: totalRawTracks,
        overlap_count: overlapCount,
      });
      router.push("/game");
    } catch (e: unknown) {
      const message = describeError(e, locale, "playlist_load_failed");
      // `allFailuresFinal` stays false for the throttled rethrow above and for
      // anything that failed before the per-contributor loop, so both remain
      // retryable — a shared quota clears on its own.
      lastRejectedRef.current = allFailuresFinal ? { key: submissionKey, message } : null;
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: FAQS.map((faq) => ({
              "@type": "Question",
              name: faq.q,
              acceptedAnswer: { "@type": "Answer", text: faq.a },
            })),
          }),
        }}
      />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@300;400;500;600;700&display=swap');

        :root {
          --green: #1DB954;
          --green-dim: #169c44;
          --bg: #111111;
          --surface: #1a1a1a;
          --surface2: #222222;
          --border: #2a2a2a;
          --text: #f0f0f0;
          --muted: #777;
        }

        body { background: var(--bg); font-family: 'Outfit', sans-serif; color: var(--text); }

        .hero-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(2.8rem, 8vw, 6rem);
          letter-spacing: 0.02em;
          line-height: 0.9;
          background: linear-gradient(135deg, #ffffff 0%, #aaffc8 40%, #1DB954 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          text-shadow: none;
        }

        .card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 16px;
        }

        .url-input {
          width: 100%;
          background: var(--surface2);
          border: 1.5px solid var(--border);
          border-radius: 10px;
          padding: 14px 48px 14px 16px;
          font-size: 15px;
          font-family: 'Outfit', sans-serif;
          color: var(--text);
          transition: border-color 0.2s, box-shadow 0.2s;
          outline: none;
        }
        .url-input:focus {
          border-color: var(--green);
          box-shadow: 0 0 0 3px rgba(29,185,84,0.12);
        }
        .url-input.valid { border-color: var(--green); }
        .url-input::placeholder { color: var(--muted); }

        .player-input {
          flex: 1;
          background: var(--surface2);
          border: 1.5px solid var(--border);
          border-radius: 8px;
          padding: 11px 14px;
          font-size: 14px;
          font-family: 'Outfit', sans-serif;
          color: var(--text);
          outline: none;
          transition: border-color 0.2s;
        }
        .player-input:focus { border-color: var(--green); }
        .player-input::placeholder { color: var(--muted); }

        .pill {
          padding: 8px 12px;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 600;
          border: 1.5px solid var(--border);
          background: var(--surface2);
          color: var(--muted);
          cursor: pointer;
          transition: all 0.15s;
          font-family: 'Outfit', sans-serif;
        }
        .pill:hover { border-color: #444; color: var(--text); }
        .pill.active {
          background: var(--green);
          border-color: var(--green);
          color: #000;
          box-shadow: 0 0 16px rgba(29,185,84,0.4);
        }

        /* Same pill, but a field. The spinners are hidden because they are the
           wrong affordance at this size and clip the text inside the radius. */
        .count-input {
          width: 92px;
          text-align: center;
          color: var(--text);
          -moz-appearance: textfield;
        }
        .count-input::-webkit-outer-spin-button,
        .count-input::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .count-input:focus {
          outline: none;
          border-color: var(--green);
        }
        .count-input::placeholder { color: var(--muted); font-weight: 600; }
        /* Selected reads the same here as on a pill. Without it a committed
           custom count is dark text in a dark field while every preset lights
           up green, so the row looks like nothing is chosen. */
        .count-input.active { color: #000; }
        .count-input.active::placeholder { color: rgba(0,0,0,0.45); }

        .link-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          border-radius: 999px;
          border: 1.5px solid rgba(29,185,84,0.35);
          background: rgba(29,185,84,0.06);
          color: var(--green);
          font-family: 'Outfit', sans-serif;
          font-size: 13px;
          font-weight: 600;
          text-decoration: none;
          /* The footer's "What's new" is a <button> in the same row as the
             mailto <a>. Buttons don't inherit either of these. */
          cursor: pointer;
          line-height: 1.2;
          transition: border-color 0.15s, background 0.15s, transform 0.1s;
        }
        .link-btn:hover {
          border-color: var(--green);
          background: rgba(29,185,84,0.12);
          transform: translateY(-1px);
        }

        .start-btn {
          width: 100%;
          padding: 16px;
          background: var(--green);
          color: #000;
          font-family: 'Outfit', sans-serif;
          font-size: 18px;
          font-weight: 700;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          letter-spacing: 0.03em;
          transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
          box-shadow: 0 4px 24px rgba(29,185,84,0.3);
        }
        .start-btn:hover:not(:disabled) {
          background: #1ed760;
          box-shadow: 0 4px 32px rgba(29,185,84,0.5);
          transform: translateY(-1px);
        }
        .start-btn:active:not(:disabled) { transform: translateY(0); }
        .start-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        .add-player-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 14px;
          font-weight: 500;
          color: var(--green);
          background: none;
          border: 1.5px dashed rgba(29,185,84,0.4);
          border-radius: 8px;
          padding: 9px 16px;
          cursor: pointer;
          transition: all 0.15s;
          font-family: 'Outfit', sans-serif;
          width: 100%;
          justify-content: center;
        }
        .add-player-btn:hover {
          border-color: var(--green);
          background: rgba(29,185,84,0.05);
        }

        .remove-btn {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--surface2);
          border: 1px solid var(--border);
          color: var(--muted);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .remove-btn:hover { background: #3a1a1a; border-color: #662222; color: #ef4444; }

        .section-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 10px;
        }

        /* Crawlable prose. The setup form above is almost entirely UI chrome,
           so without this the homepage has nothing for Google to match a
           query like "guess the song game" against. */
        .seo-section { margin-top: 44px; }
        .seo-h2 {
          font-size: 15px;
          font-weight: 600;
          color: #999;
          margin-bottom: 10px;
        }
        .seo-p {
          font-size: 13px;
          font-weight: 300;
          line-height: 1.7;
          color: #666;
        }
        .seo-p + .seo-p { margin-top: 10px; }
        .guide-links {
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 10px;
        }
        .guide-link {
          display: block;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 10px;
          padding: 14px 16px;
          text-decoration: none;
          transition: border-color 0.15s ease;
        }
        .guide-link:hover { border-color: #1DB954; }
        .guide-link-title {
          color: #f0f0f0;
          font-size: 14.5px;
          font-weight: 600;
          line-height: 1.4;
          margin-bottom: 4px;
        }
        .guide-link-desc {
          color: #888;
          font-size: 12.5px;
          font-weight: 300;
          line-height: 1.5;
        }
        .faq-list { margin-top: 12px; display: flex; flex-direction: column; gap: 14px; }
        .faq-q {
          font-size: 13px;
          font-weight: 500;
          color: #999;
          margin-bottom: 4px;
        }
        .faq-a {
          font-size: 13px;
          font-weight: 300;
          line-height: 1.7;
          color: #666;
        }
        .faq-a a { color: #1DB954; }
        .faq-a a:hover { text-decoration: underline; }

        .waveform-bar {
          animation: waveform 2.4s ease-in-out infinite alternate;
        }
        @keyframes waveform {
          from { transform: scaleY(0.4); }
          to { transform: scaleY(1); }
        }

        .fade-in {
          opacity: 0;
          transform: translateY(16px);
          animation: fadeUp 0.5s ease forwards;
        }
        .fade-in-1 { animation-delay: 0.05s; }
        .fade-in-2 { animation-delay: 0.15s; }
        .fade-in-3 { animation-delay: 0.25s; }
        .fade-in-4 { animation-delay: 0.35s; }
        .fade-in-5 { animation-delay: 0.45s; }
        @keyframes fadeUp {
          to { opacity: 1; transform: translateY(0); }
        }

        .dot-pulse::after {
          content: '...';
          animation: dots 1.2s steps(4, end) infinite;
        }
        @keyframes dots {
          0%, 20% { content: ''; }
          40% { content: '.'; }
          60% { content: '..'; }
          80%, 100% { content: '...'; }
        }

        .spinner {
          width: 20px; height: 20px;
          border: 2.5px solid rgba(0,0,0,0.3);
          border-top-color: #000;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          display: inline-block;
          vertical-align: middle;
          margin-right: 8px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .noise-overlay {
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
          opacity: 0.025;
        }
      `}</style>

      <div className="noise-overlay" aria-hidden />
      <WaveformBg />

      {/* Radial glow top-center */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          top: "-20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "600px",
          height: "400px",
          background: "radial-gradient(ellipse at center, rgba(29,185,84,0.08) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 20px",
          position: "relative",
        }}
      >
        <div style={{ width: "100%", maxWidth: "480px" }}>
          {/* Header */}
          <div className={`text-center mb-8 ${mounted ? "fade-in fade-in-1" : ""}`}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginBottom: "8px" }}>
              <div style={{ color: "#1DB954" }}>
                <SpotifyIcon />
              </div>
              <span style={{ fontSize: "13px", fontWeight: 500, color: "#777", letterSpacing: "0.08em" }}>
                PARTY GAME
              </span>
            </div>
            <h1 className="hero-title">GuessSong</h1>
            {/* This is an <h2>, not a <p>, so crawlers see the generic phrase
                people actually search for — the H1 is brand-only. */}
            <h2 style={{ color: "#666", fontSize: "15px", marginTop: "12px", fontWeight: 300 }}>
              Play a clip. Guess the song. Compete.
            </h2>
            <p style={{ color: "#555", fontSize: "12px", marginTop: "8px" }}>
              The free music guessing game for any Spotify playlist — no login required
            </p>
            {/* Crawl path to /zh with Chinese anchor text — that anchor is the
                signal, so keep the keyword in the link, not around it. */}
            <p style={{ color: "#555", fontSize: "12px", marginTop: "4px" }}>
              <a
                href="/zh"
                hrefLang="zh-TW"
                style={{ color: "#666", textDecoration: "underline", textUnderlineOffset: "3px" }}
              >
                猜歌遊戲・派對音樂猜謎，適合朋友聚會
              </a>
            </p>
            <p style={{ marginTop: "10px" }}>
              <a href="/about" className="link-btn">How to play →</a>
            </p>
            <p style={{ color: "#555", fontSize: "13px", marginTop: "8px", fontWeight: 300, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
              If you like, give me a star
              <a href="https://github.com/Waynting/GuessSong" target="_blank" rel="noopener noreferrer" style={{ color: "#555", display: "inline-flex", transition: "color 0.15s" }} onMouseEnter={e => (e.currentTarget.style.color = "#f0f0f0")} onMouseLeave={e => (e.currentTarget.style.color = "#555")}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-label="GitHub">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
                </svg>
              </a>
            </p>
          </div>

          {/* Install pitch — shown before the setup form */}
          <div className={mounted ? "fade-in fade-in-2" : ""}>
            <InstallBanner />
          </div>

          {/* Card */}
          <div className={`card ${mounted ? "fade-in fade-in-2" : ""}`} style={{ padding: "28px", display: "flex", flexDirection: "column", gap: "24px" }}>

            {/* Game Mode */}
            <div>
              <p className="section-label">Game Mode</p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  className={`pill${setupMode === "single" ? " active" : ""}`}
                  onClick={() => {
                    setSetupMode("single");
                    resetRoom();
                  }}
                >
                  Single Playlist
                </button>
                <button
                  className={`pill${setupMode === "mixed" ? " active" : ""}`}
                  onClick={() => {
                    setSetupMode("mixed");
                    resetRoom();
                  }}
                >
                  Mixed Playlist 🔀
                </button>
              </div>
              {setupMode === "mixed" && (
                <p style={{ marginTop: "8px", fontSize: "12px", color: "#666" }}>
                  Pass this phone around — everyone adds their own playlist, then we mix them together.
                </p>
              )}
            </div>

            {setupMode === "single" ? (
              <>
                {/* Playlist URL */}
                <div>
                  <p className="section-label">Spotify Playlist</p>
                  <div style={{ position: "relative" }}>
                    <input
                      ref={firstInputRef}
                      type="url"
                      className={`url-input${isValidSpotifyUrl ? " valid" : ""}`}
                      placeholder="https://open.spotify.com/playlist/..."
                      value={playlistUrl}
                      onChange={(e) => setPlaylistUrl(e.target.value)}
                      spellCheck={false}
                    />
                    {isValidSpotifyUrl && (
                      <span
                        style={{
                          position: "absolute",
                          right: "14px",
                          top: "50%",
                          transform: "translateY(-50%)",
                          color: "#1DB954",
                        }}
                      >
                        <CheckIcon />
                      </span>
                    )}
                  </div>
                  {isEditorial && (
                    <p
                      style={{
                        marginTop: "8px",
                        fontSize: "12px",
                        color: "#f59e0b",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span>⚠</span> Editorial playlists (Discover Weekly, etc.) may not work
                    </p>
                  )}
                </div>

              </>
            ) : (
              <>
                {/* Collection sub-mode */}
                <div>
                  <p className="section-label">How to Collect</p>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button
                      className={`pill${mixedSubMode === "room" ? " active" : ""}`}
                      onClick={() => {
                        setMixedSubMode("room");
                        resetRoom();
                      }}
                    >
                      QR Code
                    </button>
                    <button
                      className={`pill${mixedSubMode === "phone" ? " active" : ""}`}
                      onClick={() => {
                        setMixedSubMode("phone");
                        resetRoom();
                      }}
                    >
                      Pass This Phone
                    </button>
                  </div>
                </div>

                {/* Pass-the-phone collects playlists right here. The QR flow
                    collects them in the room step at the bottom instead, so
                    there is nothing to show for it this far up. */}
                {mixedSubMode === "phone" && (
                  <div>
                    <p className="section-label">Collect Playlists</p>
                    <MixedPlaylistCollector
                      contributions={mixedContributions}
                      onAdd={addMixedContribution}
                      onRemove={removeMixedContribution}
                    />
                  </div>
                )}

                {/* Songs per Player */}
                <div>
                  <p className="section-label">Songs Per Player</p>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {MIXED_SAMPLE_COUNTS.map((c) => (
                      <button
                        key={c}
                        className={`pill${sampledPerPlayer === c ? " active" : ""}`}
                        onClick={() => setSampledPerPlayer(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <p style={{ marginTop: "8px", fontSize: "12px", color: "#666" }}>
                    Caps how many tracks each player&apos;s playlist contributes, after duplicates are merged.
                  </p>
                </div>
              </>
            )}

            {/* Buzzer Mode — the reason the host gets to play too. Hidden
                entirely when NEXT_PUBLIC_BUZZER_WS_URL is unset, because
                without a Worker there is no room to open. */}
            {isBuzzerConfigured() && (
              <div>
                <p className="section-label">Buzzer Mode</p>
                {/* Label says what the tap does, colour says what the state is.
                    A grey button reading "Off" was reporting status where a
                    control belongs — you couldn't tell whether it meant "it is
                    off" or "tap to turn it off". */}
                <button
                  className={`pill${buzzerEnabled ? " active" : ""}`}
                  onClick={() => {
                    setBuzzerEnabled((v) => !v);
                    resetRoom();
                  }}
                  aria-pressed={buzzerEnabled}
                >
                  {buzzerEnabled ? "✓ On" : "Turn on"}
                </button>
                <p style={{ marginTop: "8px", fontSize: "12px", color: "#666" }}>
                  {buzzerEnabled
                    ? "Everyone scans in and gets a buzzer on their phone. The server decides who was first, so you can stop refereeing and actually play."
                    : "Turn this on to give every player a buzzer on their phone."}
                </p>
              </div>
            )}

            {/* Clip Duration */}
            <div>
              <p className="section-label">Clip Duration</p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {CLIP_DURATIONS.map((d) => (
                  <button
                    key={d}
                    className={`pill${clipDuration === d ? " active" : ""}`}
                    onClick={() => setClipDuration(d)}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </div>

            {/* Number of Songs — single-playlist mode only; mixed mode uses per-player sampling instead */}
            {setupMode === "single" && (
              <div>
                <p className="section-label">Number of Songs</p>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  {SONG_COUNTS.map((c) => (
                    <button
                      key={c}
                      className={`pill${songCount.count === c ? " active" : ""}`}
                      onClick={() => setSongCount(selectPreset(c))}
                    >
                      {c === "all" ? "All" : c}
                    </button>
                  ))}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_SONG_COUNT}
                    className={`pill count-input${isCustomSelected(songCount) ? " active" : ""}`}
                    placeholder="Custom"
                    aria-label={`Custom number of songs, 1 to ${MAX_SONG_COUNT}`}
                    value={songCount.field}
                    onChange={(e) => {
                      // Read the value out before the updater, which React runs
                      // later: `e.target` is the live input, so a second
                      // keystroke landing first would make the callback read a
                      // different value than the event carried.
                      const raw = e.target.value;
                      setSongCount((s) => typeCustom(s, raw));
                    }}
                    onBlur={() => setSongCount(commitCustom)}
                  />
                </div>
                <p style={{ marginTop: "8px", fontSize: "12px", color: "#666" }}>
                  How many tracks to play from the shuffled playlist. Type any number up
                  to {MAX_SONG_COUNT} — a shorter playlist just plays every track it has.
                </p>
              </div>
            )}

            {/* Players — the manual roster, and only when phones are not
                supplying one. Buzzer Mode makes this redundant: everyone types
                their own name as they scan in, and asking the host to type the
                same names again is how the two lists drifted apart and points
                went to players who did not exist. Mixed mode takes its roster
                from the contributors instead. */}
            {setupMode === "single" && !buzzerEnabled && (
                  <div>
                    <p className="section-label">Players</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {players.map((name, idx) => (
                        <div key={idx} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input
                            type="text"
                            className="player-input"
                            placeholder={`Player ${idx + 1}`}
                            value={name}
                            onChange={(e) => updatePlayer(idx, e.target.value)}
                            maxLength={24}
                          />
                          {players.length > 1 && (
                            <button
                              className="remove-btn"
                              onClick={() => removePlayer(idx)}
                              aria-label={`Remove player ${idx + 1}`}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                      <button className="add-player-btn" onClick={addPlayer}>
                        <span style={{ fontSize: "18px", lineHeight: 1, fontWeight: 300 }}>+</span>
                        Add Player
                      </button>
                    </div>
                  </div>
            )}

            {/* The room — one code, one QR, doing whichever jobs the settings
                above ask for. Deliberately last: the code is what turns a
                configured game into a gathering, and printing it before the
                clip length was even picked meant people scanned into a room
                whose settings were still moving. Pass-the-phone with the
                buzzer off needs no room and shows nothing here. */}
            {needsRoom && (
              <div>
                <p className="section-label">Room</p>
                <RoomPanel
                  collectsPlaylists={collectsPlaylists}
                  buzzer={buzzerEnabled}
                  room={openedRoom}
                  onOpened={setOpenedRoom}
                  onPhoneCountChange={setBuzzerPlayerCount}
                  onSubmissionsChange={setRoomSubmissions}
                />
                {roomError && (
                  <p style={{ marginTop: "10px", fontSize: "12px", color: "#fca5a5" }}>
                    {roomError}
                  </p>
                )}
              </div>
            )}

            {/* Start Button */}
            <div>
              {(() => {
                const isMixedPhone = setupMode === "mixed" && mixedSubMode === "phone";
                const isMixedRoom = collectsPlaylists;
                const phoneShort = MIXED_MIN_CONTRIBUTORS - mixedContributions.length;
                const roomShort = MIXED_MIN_CONTRIBUTORS - roomSubmissions.length;
                const busy = loading || roomStarting;
                // Every flow that needs phones needs its one room open first.
                // Not a minimum player count for the buzzer though: latecomers
                // can scan in mid-game, and blocking on an arbitrary number
                // would strand a host whose friends are still finding the QR.
                // Mixed·QR is the exception — its pool is built from what the
                // mailbox has when Start is tapped, so it does need people.
                const roomNotReady = needsRoom && !openedRoom;
                const disabled =
                  busy ||
                  roomNotReady ||
                  (isMixedPhone && mixedContributions.length < MIXED_MIN_CONTRIBUTORS) ||
                  (isMixedRoom && roomSubmissions.length < MIXED_MIN_CONTRIBUTORS);
                const onClick = setupMode === "single"
                  ? handleStart
                  : isMixedPhone
                  ? handleMixedStart
                  : handleRoomStart;

                let label: ReactNode = "Start Game →";
                if (busy) {
                  label = (
                    <>
                      <span className="spinner" />
                      Loading playlist
                      <span className="dot-pulse" />
                    </>
                  );
                } else if (isMixedPhone && phoneShort > 0) {
                  label = `Add ${phoneShort} more player${phoneShort === 1 ? "" : "s"} to start`;
                } else if (roomNotReady) {
                  label = "Open the room first";
                } else if (isMixedRoom && roomShort > 0) {
                  // Playlists, not players. The host is a player too but scans
                  // nothing, so counting people here read as "wait for another
                  // guest" when what was actually missing was the host's own
                  // playlist — which they add from the room card.
                  label = `Waiting for ${roomShort} more playlist${roomShort === 1 ? "" : "s"}`;
                } else if (buzzerEnabled) {
                  label =
                    buzzerPlayerCount > 0
                      ? `Start Game — ${buzzerPlayerCount} phone${buzzerPlayerCount === 1 ? "" : "s"} ready →`
                      : "Start Game (nobody scanned yet) →";
                }

                return (
                  <button className="start-btn" onClick={onClick} disabled={disabled}>
                    {label}
                  </button>
                );
              })()}

              {error && (
                <div
                  style={{
                    marginTop: "12px",
                    padding: "12px 16px",
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: "8px",
                    fontSize: "13px",
                    color: "#fca5a5",
                    lineHeight: 1.5,
                  }}
                >
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Prose for search engines and first-time visitors alike. */}
          <section className="seo-section">
            <h2 className="seo-h2">What is GuessSong?</h2>
            <p className="seo-p">
              GuessSong is a free guess the song game for parties. The host pastes any
              public Spotify playlist, the game plays a short clip from a random track,
              and everyone races to name it out loud. No login, no app to install, no
              accounts — one screen and a room full of people is all you need.
            </p>
            <p className="seo-p">
              It works as a music quiz for game nights, road trips, classrooms and office
              parties. Want everyone&apos;s taste in the mix? Mixed Playlist Mode merges
              every player&apos;s playlist into one round.
            </p>
            <p style={{ marginTop: "14px" }}>
              <a href="/about" className="link-btn">See how to play →</a>
            </p>
          </section>

          <section className="seo-section">
            <h2 className="seo-h2">Frequently asked questions</h2>
            <div className="faq-list">
              {FAQS.map((faq) => (
                <div key={faq.q}>
                  <h3 className="faq-q">{faq.q}</h3>
                  <p className="faq-a">{faq.a}</p>
                </div>
              ))}
            </div>
          </section>

          {/* A few of the guides, deliberately not all of them — this is a
              teaser under a form, not a second index. HOME_GUIDES names which;
              the copy comes from lib/guides.ts so a retitled guide is retitled
              here too. (The count used to be written into this comment, and it
              went stale the first time a guide was added.) */}
          <section className="seo-section">
            <h2 className="seo-h2">Guides</h2>
            <p className="seo-p">
              Longer pieces on running one of these evenings — what to put on, how hard to
              make it, and what to do when Spotify refuses your link.
            </p>
            <div className="guide-links">
              {HOME_GUIDES.map((guide) => (
                <a key={guide.slug} href={`/guides/${guide.slug}`} className="guide-link">
                  <span className="guide-link-title">{guide.navTitle}</span>
                  <span className="guide-link-desc">{guide.description}</span>
                </a>
              ))}
            </div>
            <p style={{ marginTop: "14px" }}>
              <a href="/guides" className="link-btn">All guides →</a>
            </p>
          </section>

          <ServiceNotice />
          <SiteFooter />

        </div>
      </main>
    </>
  );
}
