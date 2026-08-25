"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Track } from "@/types";
import { trackEvent, type PlaylistSource } from "@/lib/analytics";
import { canInstall, promptInstall } from "@/lib/pwa";
import {
  countRoundsPlayed,
  mergeRoomRoster,
  type GameMode,
  type GamePlayer as Player,
  type BuzzerRoomHandle,
  type MixedPlaylistMeta,
} from "@/lib/game-session";
import { loadGame } from "@/lib/game-storage";
import { fetchPreview, fetchPreviewBatch } from "@/lib/preview-client";
import { createRoundToken } from "@/lib/round-token";
import { isPreviewSettled, type PreviewBatchTrack } from "@/types/preview";
import { BuzzerHostPanel, type BuzzerControls } from "@/components/buzzer-host-panel";
import { LoopQr } from "@/components/loop-qr";
import type { RoundHistoryEntry } from "@/lib/round-history";
import { describeRounds, summarizeRounds } from "@/lib/round-summary";
import { formatMixList } from "@/lib/mix-export";
import { buildTasteCard } from "@/lib/taste-card";
import {
  CARD_FOOTER_HEIGHT,
  createResultCanvas,
  drawCardBackground,
  drawCardHeader,
  drawCardFooter,
  shareOrDownloadCanvas,
  type ShareOutcome,
} from "@/lib/result-image";
import { loopQrDataUrl } from "@/lib/loop-qr";
import { reportLoopImpression } from "@/lib/loop-client";

type Phase = "waiting" | "playing" | "guessing" | "revealed" | "finished";

const ALBUM_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'%3E%3Crect width='400' height='400' fill='%231a1a1a'/%3E%3Ccircle cx='200' cy='200' r='80' fill='%23222'/%3E%3Ccircle cx='200' cy='200' r='20' fill='%23111'/%3E%3C/svg%3E";

function InstallCta({ onInstall }: { onInstall: () => void }) {
  return (
    <div className="install-cta">
      <span className="install-cta-emoji" aria-hidden>
        📲
      </span>
      <span>
        <span className="install-cta-title" style={{ display: "block" }}>
          Install GuessSong
        </span>
        <span className="install-cta-desc" style={{ display: "block" }}>
          Next time, share any playlist from Spotify straight to GuessSong and
          start playing.
        </span>
      </span>
      <button className="install-cta-btn" onClick={onInstall}>
        Install
      </button>
    </div>
  );
}

/**
 * The `share` surface's denominator, which it went without until now.
 *
 * Every other surface is a DOM node, so `components/loop-cta.tsx` and
 * `components/loop-qr.tsx` can report an impression when it renders. This one
 * is a QR painted into a canvas by `drawCardFooter`, so nothing ever fired and
 * `npm run stats` printed `shown=0` against a non-zero `followed` — a rate of
 * `—` for the one arm that reaches people who have never seen a page of ours.
 * `lib/analytics.ts` is explicit that a funnel without a denominator cannot be
 * read; this is that rule applied to the loop's weakest and least visible arm.
 *
 * **Only the outcomes that leave an artifact count.** `dismissed` means the
 * share sheet was opened and backed out of and `failed` means there was never
 * a blob — in both cases no image exists, so no QR entered the world and an
 * impression would be a denominator for a card nobody has. `downloaded` counts
 * alongside `shared` even though `lib/result-image.ts` notes that only the
 * latter can spread on its own: a file in the camera roll still gets forwarded
 * later, and over-counting the denominator understates the rate, which is the
 * safe direction (same reasoning as `lib/loop-client.ts`'s storage fallback).
 *
 * The unit is therefore **a party that produced at least one card**, not a
 * card: `reportLoopImpression` dedupes per tab session, so saving both the
 * scores card and the taste card counts once. That matches how `game_over` is
 * counted and keeps the two QR arms comparable to each other.
 */
function recordCardImpression(outcome: ShareOutcome): void {
  if (outcome === "shared" || outcome === "downloaded") {
    reportLoopImpression("share");
  }
}

export default function GamePage() {
  const router = useRouter();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [playlistName, setPlaylistName] = useState("");
  const [clipDuration, setClipDuration] = useState(15);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [roundWinner, setRoundWinner] = useState<string | null>(null);
  const [albumWinner, setAlbumWinner] = useState<string | null>(null);
  const [sourceWinner, setSourceWinner] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  // The clip is stopped mid-round but resumable. Set when someone buzzes in:
  // the music gets out of the way so the room can hear the answer, and the host
  // decides whether to let it run on.
  const [clipPaused, setClipPaused] = useState(false);
  // Mirrors the <audio> element itself, so the Stop/Resume toggle can't claim
  // the music is running when it isn't. `clipPaused` says "held mid-round";
  // this says "is sound coming out right now", and the clip ending on its own
  // changes the second without the first.
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [scorePulse, setScorePulse] = useState<string | null>(null);
  const [pointsAwarded, setPointsAwarded] = useState(false);
  const [albumPointsAwarded, setAlbumPointsAwarded] = useState(false);
  const [sourcePointsAwarded, setSourcePointsAwarded] = useState(false);
  const [roundHistory, setRoundHistory] = useState<RoundHistoryEntry[]>([]);
  const [albumHintShown, setAlbumHintShown] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [noAudio, setNoAudio] = useState(false);
  const [loadingSkipVisible, setLoadingSkipVisible] = useState(false);
  const [playlistSource, setPlaylistSource] = useState<PlaylistSource>("own");
  const [mixedMeta, setMixedMeta] = useState<MixedPlaylistMeta | null>(null);
  const [mixCopied, setMixCopied] = useState(false);
  const [mixFallback, setMixFallback] = useState<string | null>(null);
  const [mode, setMode] = useState<GameMode>("party");
  const [installCta, setInstallCta] = useState(false);
  // Buzzer Mode only. Null in every other mode, which is also how the panel
  // stays entirely out of the party render path.
  const [buzzerRoom, setBuzzerRoom] = useState<BuzzerRoomHandle | null>(null);
  // Handed up by the panel so this page's existing Reveal / Next / scoring
  // buttons drive the room, instead of the panel growing its own copies.
  const [buzzerControls, setBuzzerControls] = useState<BuzzerControls | null>(null);
  const peakPhonesRef = useRef(0);
  // reveal()/nextTrack() are plain functions recreated each render; reading the
  // controls through a ref keeps them from going stale without threading state
  // through every call site.
  const buzzerControlsRef = useRef<BuzzerControls | null>(null);
  buzzerControlsRef.current = buzzerControls;

  const audioRef = useRef<HTMLAudioElement>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clip time is accounted in segments rather than from one start timestamp,
  // because a pause splits the clip into several. Without this a 15s clip
  // paused for 20s would end the moment it resumed — the deadline was wall
  // clock, not playback.
  const clipElapsedRef = useRef(0);
  const clipSegmentStartRef = useRef(0);
  // Read by the buzz handler, which must not re-subscribe on every phase change.
  const phaseRef = useRef<Phase>("waiting");
  phaseRef.current = phase;
  /**
   * Which round the host is looking at. See lib/round-token.ts for the rule and
   * for why it is not written inline here.
   *
   * playClip renders the "Skip Track" button *during* its own await, 1500ms in,
   * so a host advancing while a preview resolves is the ordinary case rather
   * than a corner one.
   */
  const roundsRef = useRef(createRoundToken());
  /**
   * Only ever holds *settled* answers — a found URL, or a confirmed null for a
   * song nothing has a clip for. An "unavailable" is never written here: it
   * means the server could not ask, and remembering it would turn one throttled
   * moment into a track that stays silent for the rest of the game.
   */
  const previewCache = useRef<Record<string, string | null>>({});
  /** One repair attempt per track, so a genuinely dead URL can't loop. */
  const refreshedTracks = useRef<Set<string>>(new Set());
  const gameStartTimeRef = useRef<number>(Date.now());
  const finishedTrackedRef = useRef(false);

  /**
   * The clip transport, identical in "playing" and "guessing".
   *
   * It has to be the same set in both, because the phase flips underneath the
   * host constantly — a buzz holds the clip, Resume puts it back to "playing",
   * Stop drops it to "guessing", the clip running out does the same. When the
   * two phases rendered different rows, buttons appeared and vanished as a
   * side effect of that churn, and the host lost whichever control they were
   * reaching for. One row, always the same three, until Reveal ends the round.
   */
  function clipControls() {
    return (
      <>
        {audioPlaying ? (
          <button className="btn-ghost" style={{ flex: "0 0 auto" }} onClick={holdClip}>
            Stop
          </button>
        ) : (
          <button className="btn-ghost" style={{ flex: "0 0 auto" }} onClick={resumeClip}>
            Resume
          </button>
        )}
        <button className="btn-ghost" style={{ flex: "0 0 auto" }} onClick={replayClip}>
          Replay
        </button>
        <button className="btn-primary" onClick={reveal}>
          Reveal Answer →
        </button>
      </>
    );
  }

  // Show the PWA install pitch at the high-intent moment: game over.
  useEffect(() => {
    if (phase === "finished") setInstallCta(canInstall());
  }, [phase]);

  async function handleInstall() {
    // Hide regardless of outcome: the deferred prompt is consumed either way,
    // so a second click could never do anything.
    await promptInstall();
    setInstallCta(false);
  }

  useEffect(() => {
    // Guarded, because a browser with site data switched off throws on the
    // read rather than returning null — and this effect has no try of its own,
    // so the throw took the whole page down. See lib/game-storage.ts.
    const data = loadGame();
    if (!data || data.tracks.length === 0) { router.push("/"); return; }
    setTracks(data.tracks);
    setPlayers(data.players);
    setPlaylistName(data.playlistName);
    setClipDuration(data.clipDuration);
    setPlaylistSource(data.playlistSource);
    setMode(data.mode);
    setBuzzerRoom(data.buzzerRoom ?? null);
    // The roster, kept separately from the tracks on purpose. `contributorNames`
    // is the only record of somebody whose playlist was sampled down to nothing:
    // they are absent from every track, so anything derived from `tracks` erases
    // them from an evening they took part in.
    setMixedMeta(data.mixedPlaylistMeta ?? null);
    gameStartTimeRef.current = Date.now();
  }, [router]);

  /**
   * Resolve the whole game's previews in one request, before the first round.
   *
   * Not just a latency win. Resolving lazily put an upstream lookup on the
   * critical path of every round, so a throttled minute reached the host as a
   * dead Play button mid-party — the one moment there is nothing to do about
   * it. Done here, the same throttling costs a few seconds before anyone has
   * pressed anything, and the tracks it couldn't answer for simply fall back to
   * the per-track path as the game reaches them.
   *
   * Deliberately not awaited by anything: the host can start immediately, and
   * playClip reads whatever has landed by then.
   */
  useEffect(() => {
    if (tracks.length === 0) return;
    let cancelled = false;

    const pending: PreviewBatchTrack[] = tracks
      .filter((t) => previewCache.current[t.id] === undefined)
      .map((t) => ({
        id: t.id,
        name: t.name,
        artist: t.artists[0] ?? "",
        durationMs: t.durationMs,
      }));
    if (pending.length === 0) return;

    void fetchPreviewBatch(pending).then((resolved) => {
      if (cancelled) return;
      for (const [id, result] of resolved) {
        if (isPreviewSettled(result.status)) previewCache.current[id] = result.previewUrl;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [tracks]);

  const stopClip = useCallback(() => {
    audioRef.current?.pause();
    if (clipTimeoutRef.current) clearTimeout(clipTimeoutRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    setClipPaused(false);
  }, []);

  /**
   * Hand back the clip the element is holding, so a round cannot inherit the
   * previous round's URL. `handleAudioError` already documented this as
   * something that happens between rounds; until now nothing did it, and the
   * only reason a stale src was never heard is that the replay controls happen
   * not to render outside "playing"/"guessing" — one render condition away from
   * being audible. Round teardown only: reveal() also stops the clip, and replay
   * has to keep working after it.
   *
   * removeAttribute rather than `src = ""`, which resolves against the document
   * and would leave the element holding the page's own URL.
   */
  const releaseClip = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.removeAttribute("src");
    audio.load();
  }, []);

  /**
   * End the round the host is looking at: stop the clip, retire everything
   * still in flight for it, hand the element back, and clear the affordances
   * that belong to a round being loaded.
   *
   * One function rather than three lines at each call site, because the failure
   * mode of forgetting the token bump is precisely the bug this exists to fix,
   * and a fourth round-ending path is exactly the kind of thing that gets added
   * later. Nothing can test that ordering — the guard lives in a component the
   * vitest suite cannot reach — so it has to be impossible to get wrong instead.
   */
  const retireRound = useCallback(() => {
    stopClip();
    roundsRef.current.bump();
    releaseClip();
    setPreviewLoading(false);
    setNoAudio(false);
    setLoadingSkipVisible(false);
  }, [stopClip, releaseClip]);

  /**
   * Start (or restart) the progress bar and the end-of-clip deadline for
   * however much of the clip is left. Called once when a clip starts, and again
   * on every resume.
   */
  const startClipTimers = useCallback(() => {
    const totalMs = clipDuration * 1000;
    clipSegmentStartRef.current = Date.now();
    progressIntervalRef.current = setInterval(() => {
      const elapsed = clipElapsedRef.current + (Date.now() - clipSegmentStartRef.current);
      setProgress(Math.min((elapsed / totalMs) * 100, 100));
    }, 80);
    clipTimeoutRef.current = setTimeout(() => {
      audioRef.current?.pause();
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
      // Bank the whole clip, so a later Resume knows the window is spent and
      // plays on instead of re-arming a countdown that already finished.
      clipElapsedRef.current = totalMs;
      setProgress(100);
      setPhase("guessing");
    }, Math.max(0, totalMs - clipElapsedRef.current));
  }, [clipDuration]);

  /**
   * Hold the music where it is, without ending the round. Someone buzzing in is
   * the usual trigger: the music gets out of the way so the room can hear the
   * answer, and a wrong answer can hand the rest of the clip back.
   *
   * Available for as long as the host is still running the round — through
   * "playing" and on into "guessing", where the clip's own window has elapsed
   * but the host may well still be playing the song while people think. Only
   * revealing the answer ends it.
   */
  const pauseClip = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    if (phaseRef.current !== "playing" && phaseRef.current !== "guessing") return;
    audio.pause();
    clipElapsedRef.current += Date.now() - clipSegmentStartRef.current;
    if (clipTimeoutRef.current) clearTimeout(clipTimeoutRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    setClipPaused(true);
  }, []);

  const resumeClip = useCallback(() => {
    const audio = audioRef.current;
    if (!audio?.src) return;
    audio.play().catch(() => {});
    setClipPaused(false);
    // Only re-arm the end-of-clip deadline if any of the clip is left. Past
    // that the host is deliberately playing on, so there is nothing left to
    // count down to and we stay put rather than snapping the phase around.
    if (clipElapsedRef.current < clipDuration * 1000) {
      startClipTimers();
      setPhase("playing");
    } else {
      clipSegmentStartRef.current = Date.now();
    }
  }, [clipDuration, startClipTimers]);

  /** Stop the music and ask the room. The clip stays resumable. */
  const holdClip = useCallback(() => {
    pauseClip();
    setPhase("guessing");
  }, [pauseClip]);

  /** Start the clip over from the top. */
  const replayClip = useCallback(() => {
    const audio = audioRef.current;
    if (!audio?.src) return;
    if (clipTimeoutRef.current) clearTimeout(clipTimeoutRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    audio.currentTime = 0;
    clipElapsedRef.current = 0;
    audio.play().catch(() => {});
    setClipPaused(false);
    setProgress(0);
    startClipTimers();
    setPhase("playing");
  }, [startClipTimers]);

  async function playClip() {
    const audio = audioRef.current;
    const track = tracks[currentIndex];
    if (!audio || !track) return;
    const stillThisRound = roundsRef.current.begin();

    // Whatever the prefetch resolved. There is no Spotify URL to prefer here:
    // preview_url has been null for every track since Nov 2024, so the clip
    // always comes from iTunes or Deezer via lib/preview-cache.ts.
    const cached = previewCache.current[track.id];
    let previewUrl = cached ?? null;
    let missReason: "absent" | "unavailable" = "absent";

    // `undefined` means nobody has asked yet. A cached `null` is a settled
    // "nothing anywhere has a clip for this", and re-asking it on every press
    // of Play is the load the cache exists to remove.
    if (!previewUrl && cached === undefined) {
      setPreviewLoading(true);
      setLoadingSkipVisible(false);
      // Held in a local rather than a ref on purpose. Two rounds' resolutions
      // can be in flight at once, and a shared ref would already belong to the
      // round that replaced us — clearing it would take the next host's Skip
      // button away instead of our own.
      const skipTimer = setTimeout(() => setLoadingSkipVisible(true), 1500);

      const result = await fetchPreview({
        id: track.id,
        name: track.name,
        artist: track.artists[0] ?? "",
        durationMs: track.durationMs,
      });
      clearTimeout(skipTimer);
      // Keyed by track id, so it is worth keeping whichever round we came back
      // to — the host who skipped past this track may still come back to it.
      // Settled answers only — see previewCache's declaration.
      if (isPreviewSettled(result.status)) previewCache.current[track.id] = result.previewUrl;

      // The host moved on while we were asking. Everything past here writes to
      // state and to an element that now belong to somebody else's round.
      if (!stillThisRound()) return;

      // Past the token check this is still our round, so the loading
      // affordances are ours to put away — including on the reveal path just
      // below, which returns without ever starting a clip. Doing it any earlier
      // would let an abandoned round switch off a *new* round's spinner.
      setLoadingSkipVisible(false);
      setPreviewLoading(false);

      // The round does not have to *end* for the answer to be stale. "Reveal
      // Answer" is rendered by this very loading state, and reveal() only moves
      // the phase — so without this the clip started under the answer card the
      // host had just put up, tearing the scoring buttons off screen. playClip
      // has exactly one caller, the waiting-phase Play button, so a resolution
      // landing in any other phase can never legitimately start a clip.
      if (phaseRef.current !== "waiting") return;

      previewUrl = result.previewUrl;
      missReason = result.status === "unavailable" ? "unavailable" : "absent";
    }

    if (!previewUrl) {
      trackEvent("preview_miss", {
        playlist_source: playlistSource,
        track_name: track.name,
        artist: track.artists[0] ?? "",
        reason: missReason,
      });
      setNoAudio(true);
      return;
    }

    audio.src = previewUrl;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    setPhase("playing");
    setProgress(0);
    clipElapsedRef.current = 0;
    setClipPaused(false);
    startClipTimers();
  }

  /**
   * Repair a preview URL that stopped playing.
   *
   * Preview clips sit on a CDN that rotates its URLs, so a cached hit can go
   * dead long before the server's copy of it expires. That is the trade the
   * year-long positive TTL makes, and this is the other half of it: one
   * `lookup?id=` call re-resolves the track, where letting the entry expire
   * instead would mean re-searching every song in the catalogue on a timer.
   *
   * Once per track per game. A URL that fails twice is not a rotated one.
   */
  async function handleAudioError() {
    const audio = audioRef.current;
    const track = tracks[currentIndex];
    // The element also fires `error` when we clear its src between rounds,
    // which is us tearing the round down, not a URL going bad.
    if (!audio?.src || !track) return;
    if (phaseRef.current !== "playing" && phaseRef.current !== "guessing") return;
    if (refreshedTracks.current.has(track.id)) return;
    refreshedTracks.current.add(track.id);
    const stillThisRound = roundsRef.current.begin();

    const result = await fetchPreview(
      { id: track.id, name: track.name, artist: track.artists[0] ?? "", durationMs: track.durationMs },
      { refresh: true }
    );

    // Same rule as playClip, and the reason the phase guard above is not enough:
    // it was read before the await. A repair that lands after the host has moved
    // on would put the previous round's clip on this round's card.
    if (!stillThisRound()) {
      if (result.previewUrl) previewCache.current[track.id] = result.previewUrl;
      return;
    }
    // The guard above the await is read before it, so it cannot speak for where
    // the host is now. Reveal moves the phase without ending the round, and a
    // repair can land up to UPSTREAM_TIMEOUT_MS later: without this it either
    // starts the clip under the answer card, or — on the failure branch — puts
    // the phase back to "waiting" and takes the whole scoring card with it.
    if (phaseRef.current !== "playing" && phaseRef.current !== "guessing") {
      if (result.previewUrl) previewCache.current[track.id] = result.previewUrl;
      return;
    }

    if (!result.previewUrl) {
      // Nothing left to try. Put the round into the state a track with no clip
      // starts in, rather than leaving a progress bar counting down silence.
      stopClip();
      setNoAudio(true);
      setPhase("waiting");
      return;
    }

    previewCache.current[track.id] = result.previewUrl;
    audio.src = result.previewUrl;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  function reveal() {
    stopClip();
    // Deliberately does NOT resolve the room's round.
    //
    // Revealing is when the host *starts* scoring, not when they finish: the
    // answer goes up, then they say who got it. The room only accepts a verdict
    // while the round is "locked", so resolving here made the Correct and Wrong
    // buttons on the next screen silent no-ops — the queue never advanced and
    // the phones never heard the outcome. The round closes when the host
    // actually calls it: correct(), reveal() on "No one", or next().
    setPhase("revealed");
  }

  /**
   * The scoreboard follows whoever actually joined the room.
   *
   * Two name spaces used to drift apart: names typed at setup (or pulled from
   * Mixed Playlist contributors) fed the scoreboard, while names typed on each
   * phone fed the room. awardPoint matches by name, so anyone whose phone name
   * didn't exactly match their setup name scored nothing, silently.
   *
   * Additive only — a player who drops out keeps the points they earned.
   *
   * The merge itself lives in game-session so it can be unit-tested without a
   * room; it also matches names case-insensitively, which this callback used to
   * get wrong. The room refuses a second "amy" while "Amy" is connected, so the
   * two spellings are one player reconnecting, not two rows on the scoreboard.
   */
  const mergeRoomPlayers = useCallback((names: string[]) => {
    setPlayers((prev) => mergeRoomRoster(prev, names));
  }, []);

  function awardPoint(playerName: string) {
    if (pointsAwarded) return;
    setRoundWinner(playerName);
    setPointsAwarded(true);
    setScorePulse(playerName);
    setPlayers((prev) =>
      prev.map((p) => (p.name === playerName ? { ...p, score: p.score + 3 } : p))
    );
    setTimeout(() => setScorePulse(null), 600);
  }

  function awardAlbumPoint(playerName: string) {
    if (albumPointsAwarded) return;
    setAlbumWinner(playerName);
    setAlbumPointsAwarded(true);
    setScorePulse(playerName);
    setPlayers((prev) =>
      prev.map((p) => (p.name === playerName ? { ...p, score: p.score + 1 } : p))
    );
    setTimeout(() => setScorePulse(null), 600);
  }

  /** Mixed Playlist Mode: +2 for guessing whose playlist the track came from. */
  function awardSourcePoint(playerName: string) {
    if (sourcePointsAwarded) return;
    setSourceWinner(playerName);
    setSourcePointsAwarded(true);
    setScorePulse(playerName);
    setPlayers((prev) =>
      prev.map((p) => (p.name === playerName ? { ...p, score: p.score + 2 } : p))
    );
    setTimeout(() => setScorePulse(null), 600);
  }

  /** Fire game_finished exactly once (guards endGame + nextTrack double entry). */
  function trackGameFinished() {
    if (finishedTrackedRef.current) return;
    finishedTrackedRef.current = true;
    trackEvent("game_finished", {
      rounds_played: countRoundsPlayed(currentIndex, phase),
      total_tracks: tracks.length,
      duration_seconds: Math.round((Date.now() - gameStartTimeRef.current) / 1000),
      playlist_source: playlistSource,
      game_mode: mode,
      // The reach denominator: how many phones this game actually touched.
      // Only meaningful in buzzer mode, so it's omitted elsewhere rather than
      // reported as 0 and dragging the average down.
      ...(buzzerRoom ? { peak_phone_count: peakPhonesRef.current } : {}),
    });
  }

  function nextTrack() {
    retireRound();
    buzzerControlsRef.current?.next();
    trackEvent("round_completed", {
      round_index: currentIndex + 1,
      skipped: phase !== "revealed",
      playlist_source: playlistSource,
    });

    const finishedTrack = tracks[currentIndex];
    if (finishedTrack?.contributors && finishedTrack.contributors.length > 0) {
      setRoundHistory((prev) => [
        ...prev,
        {
          trackId: finishedTrack.id,
          contributors: finishedTrack.contributors!,
          songWinner: roundWinner,
          albumWinner: albumWinner,
          sourceWinner: sourceWinner,
        },
      ]);
    }

    if (currentIndex + 1 >= tracks.length) {
      trackGameFinished();
      setPhase("finished");
    } else {
      setCurrentIndex((i) => i + 1);
      setPhase("waiting");
      setRoundWinner(null);
      setAlbumWinner(null);
      setSourceWinner(null);
      setProgress(0);
      setPointsAwarded(false);
      setAlbumPointsAwarded(false);
      setSourcePointsAwarded(false);
      setAlbumHintShown(false);
    }
  }

  function endGame() {
    retireRound();
    trackGameFinished();
    setPhase("finished");
  }

  function playAgain() {
    router.push("/");
  }

  /**
   * Put the merged tracklist on the clipboard.
   *
   * The failure path shows the text instead of silently doing nothing: clipboard
   * access is refused often enough (insecure context, Safari outside a user
   * gesture, a locked-down work phone) that a button which sometimes no-ops
   * teaches the host it is broken. A selectable block still gets the list to the
   * group chat, which is the whole point of the button.
   */
  async function copyMixList() {
    const text = formatMixList({
      tracks,
      contributorNames: mixedMeta?.contributorNames ?? [],
      playlistName,
    });
    try {
      await navigator.clipboard.writeText(text);
      setMixCopied(true);
      window.setTimeout(() => setMixCopied(false), 2500);
    } catch {
      setMixFallback(text);
    }
  }

  async function downloadResultImage() {
    const W = 640;
    const rowH = 64;
    const headerH = 200;
    const footerH = CARD_FOOTER_HEIGHT;
    const H = headerH + sortedPlayers.length * rowH + footerH;
    const qr = await loopQrDataUrl();
    const { canvas, ctx } = createResultCanvas(W, H);

    drawCardBackground(ctx, W, H);
    drawCardHeader(ctx, {
      width: W,
      kicker: "GUESS SONG",
      title: "Final Scores",
      subtitle: playlistName,
    });

    // Player rows
    sortedPlayers.forEach((p, idx) => {
      const y = headerH + idx * rowH;
      const isWinner = idx === 0 && p.score === maxScore && maxScore > 0;

      // Row background
      if (isWinner) {
        ctx.fillStyle = "rgba(29,185,84,0.08)";
        ctx.fillRect(24, y + 4, W - 48, rowH - 8);
      }

      // Rank
      const rankLabel = String(idx + 1);
      ctx.font = `bold 22px sans-serif`;
      ctx.fillStyle = idx === 0 ? "#1DB954" : idx === 1 ? "#aaaaaa" : idx === 2 ? "#cd7f32" : "#333333";
      ctx.fillText(rankLabel, 44, y + rowH / 2 + 8);

      // Player name
      ctx.font = `${isWinner ? "700" : "500"} 18px sans-serif`;
      ctx.fillStyle = isWinner ? "#ffffff" : "#cccccc";
      const maxNameW = 360;
      let nameText = p.name;
      while (ctx.measureText(nameText).width > maxNameW && nameText.length > 1) {
        nameText = nameText.slice(0, -1);
      }
      if (nameText !== p.name) nameText += "…";
      ctx.fillText(nameText, 90, y + rowH / 2 + 8);

      // Score
      ctx.font = `bold 28px sans-serif`;
      ctx.fillStyle = isWinner ? "#1DB954" : "#555555";
      const scoreStr = String(p.score);
      const scoreW = ctx.measureText(scoreStr).width;
      ctx.fillText(scoreStr, W - 44 - scoreW, y + rowH / 2 + 10);

      // pts label
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "#444";
      ctx.fillText("pts", W - 40, y + rowH / 2 + 10);
    });

    const footerY = headerH + sortedPlayers.length * rowH + 20;
    await drawCardFooter(ctx, W, footerY, qr);
    const outcome = await shareOrDownloadCanvas(
      canvas,
      `guesssong-results-${Date.now()}.png`,
      "GuessSong results"
    );
    recordCardImpression(outcome);
    trackEvent("result_shared", {
      card_type: "scores",
      outcome,
      playlist_source: playlistSource,
    });
  }

  /** Mixed Playlist Mode (v2): the group taste card — shared bangers + awards. */
  async function downloadTasteCard() {
    const tasteCard = buildTasteCard(tracks, roundHistory);
    const W = 640;
    const sharedTracks = tasteCard.sharedTracks.slice(0, 5);
    const sharedRowH = 44;
    const headerH = 200;
    const sharedSectionH =
      sharedTracks.length > 0 ? 40 + sharedTracks.length * sharedRowH + 20 : 0;
    const awardCount = (tasteCard.mostObscure ? 1 : 0) + (tasteCard.mostMainstream ? 1 : 0);
    // Zero awards means zero height, matching how `sharedSectionH` above is
    // computed. Without this the card reserved room for a heading it then drew
    // over nothing: both awards are absent exactly when a room shares no taste
    // and carries no popularity data, which is the cross-culture case this card
    // is most likely to be saved from.
    const awardsSectionH = awardCount > 0 ? 40 + awardCount * 70 + 20 : 0;
    const footerH = CARD_FOOTER_HEIGHT;
    const qr = await loopQrDataUrl();
    const H = headerH + sharedSectionH + awardsSectionH + footerH;
    const { canvas, ctx } = createResultCanvas(W, H);

    drawCardBackground(ctx, W, H);
    drawCardHeader(ctx, {
      width: W,
      kicker: "GUESS SONG",
      title: "Taste Card",
      subtitle: playlistName,
    });

    let y = headerH;

    if (sharedTracks.length > 0) {
      ctx.fillStyle = "#1DB954";
      ctx.font = "bold 13px sans-serif";
      ctx.letterSpacing = "1px";
      ctx.fillText("SHARED BANGERS", 40, y + 24);
      y += 40;

      sharedTracks.forEach((t) => {
        ctx.font = "600 16px sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.letterSpacing = "0px";
        let nameText = t.name;
        const maxNameW = W - 80;
        while (ctx.measureText(nameText).width > maxNameW && nameText.length > 1) {
          nameText = nameText.slice(0, -1);
        }
        if (nameText !== t.name) nameText += "…";
        ctx.fillText(nameText, 40, y + 20);

        ctx.font = "13px sans-serif";
        ctx.fillStyle = "#666666";
        ctx.fillText(t.contributors.join(" & "), 40, y + 38);

        y += sharedRowH;
      });
      y += 20;
    }

    if (awardCount > 0) {
      ctx.fillStyle = "#1DB954";
      ctx.font = "bold 13px sans-serif";
      ctx.letterSpacing = "1px";
      ctx.fillText("AWARDS", 40, y + 24);
      y += 40;
    }

    if (tasteCard.mostObscure) {
      ctx.font = "13px sans-serif";
      ctx.fillStyle = "#666666";
      ctx.letterSpacing = "0px";
      ctx.fillText("MOST OBSCURE TASTE", 40, y + 16);
      ctx.font = "700 24px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(
        `${tasteCard.mostObscure.playerName} — ${Math.round(tasteCard.mostObscure.rate * 100)}% guessed`,
        40,
        y + 46
      );
      y += 70;
    }

    if (tasteCard.mostMainstream) {
      ctx.font = "13px sans-serif";
      ctx.fillStyle = "#666666";
      ctx.fillText("MOST MAINSTREAM", 40, y + 16);
      ctx.font = "700 24px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(
        `${tasteCard.mostMainstream.playerName} — ${Math.round(tasteCard.mostMainstream.averagePopularity)} popularity`,
        40,
        y + 46
      );
      y += 70;
    }

    await drawCardFooter(ctx, W, y + 20, qr);
    const outcome = await shareOrDownloadCanvas(
      canvas,
      `guesssong-taste-card-${Date.now()}.png`,
      "GuessSong taste card"
    );
    recordCardImpression(outcome);
    trackEvent("result_shared", {
      card_type: "taste",
      outcome,
      playlist_source: playlistSource,
    });
  }

  const currentTrack = tracks[currentIndex];
  const albumArt = currentTrack?.albumImageUrl || ALBUM_PLACEHOLDER;
  const isRevealed = phase === "revealed" || phase === "finished";
  const showAlbumArt = isRevealed || albumHintShown;
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
  // Null on an empty history, so an abandoned or non-mixed game renders nothing
  // rather than a sentence made of zeroes.
  const roundSummaryLine = describeRounds(summarizeRounds(roundHistory));
  const maxScore = sortedPlayers[0]?.score ?? 0;

  if (tracks.length === 0) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#111", color: "#555", fontFamily: "Outfit, sans-serif" }}>
        Loading…
      </div>
    );
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@300;400;500;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow: hidden; max-width: 100vw; }
        body { background: #111; color: #f0f0f0; font-family: 'Outfit', sans-serif; }

        /* One corner radius for every button, control and surface on this
           screen. It used to be five values picked per element (8, 10, 12, 14,
           20) plus 999px pills for the player picker, which read as sloppy the
           moment two of them sat side by side — the picker sits directly under
           the Correct/Wrong row, so the mismatch was unmissable.
           Only the circular avatar (50%) and the 2px progress hairline are
           exempt: those are shapes, not corner-radius choices. */
        :root { --radius: 12px; }

        .game-layout {
          display: grid;
          grid-template-rows: 56px 1fr;
          grid-template-columns: 1fr 300px;
          height: 100dvh;
          max-height: 100dvh;
          overflow: hidden;
          background: #111;
        }
        /* Trial mode: no sidebar, main area takes the full width */

        .top-bar {
          grid-column: 1 / -1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 24px;
          background: rgba(17,17,17,0.95);
          border-bottom: 1px solid #222;
          backdrop-filter: blur(8px);
        }

        .round-badge {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          font-weight: 600;
          color: #666;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .round-num {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          color: #1DB954;
          letter-spacing: 0.05em;
        }

        .playlist-name {
          font-size: 13px;
          color: #555;
          font-weight: 400;
          max-width: 300px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* MAIN AREA */
        .main-area {
          position: relative;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 32px;
        }

        /* Ambient background */
        .ambient-bg {
          position: absolute;
          inset: -20px;
          background-size: cover;
          background-position: center;
          filter: blur(60px) saturate(0.6);
          opacity: 0.25;
          transition: opacity 0.8s ease;
          z-index: 0;
        }
        .ambient-bg.revealed { opacity: 0.4; filter: blur(40px) saturate(0.8); }

        /* Content card */
        .game-card {
          position: relative;
          z-index: 1;
          width: 100%;
          max-width: 540px;
          background: rgba(20,20,20,0.92);
          border: 1px solid #2a2a2a;
          border-radius: var(--radius);
          padding: 28px;
          backdrop-filter: blur(20px);
          box-shadow: 0 24px 80px rgba(0,0,0,0.6);
        }

        /* Album art */
        .album-wrap {
          width: 100%;
          aspect-ratio: 1;
          border-radius: var(--radius);
          overflow: hidden;
          position: relative;
          background: #1a1a1a;
          margin-bottom: 20px;
        }
        .album-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: filter 0.7s ease, transform 0.7s ease;
        }
        .album-img.blurred { filter: blur(18px) brightness(0.4) saturate(0.4); transform: scale(1.08); }
        .album-img.revealed { filter: blur(0) brightness(1) saturate(1); transform: scale(1); }
        .album-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: opacity 0.4s;
        }

        /* Play button */
        .play-btn {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          background: #1DB954;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 40px rgba(29,185,84,0.5);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .play-btn:hover { transform: scale(1.06); box-shadow: 0 0 56px rgba(29,185,84,0.7); }
        .play-btn:active { transform: scale(0.97); }
        .play-icon { width: 0; height: 0; border-style: solid; border-width: 14px 0 14px 24px; border-color: transparent transparent transparent #000; margin-left: 4px; }

        /* Progress bar */
        .progress-wrap {
          height: 4px;
          background: #222;
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 20px;
        }
        .progress-fill {
          height: 100%;
          background: #1DB954;
          border-radius: 2px;
          transition: width 0.1s linear;
          box-shadow: 0 0 8px rgba(29,185,84,0.6);
        }

        /* Listening pulse */
        .listening-label {
          text-align: center;
          font-size: 14px;
          color: #1DB954;
          font-weight: 500;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          animation: pulse-opacity 1.2s ease-in-out infinite;
        }
        @keyframes pulse-opacity { 0%,100%{opacity:1} 50%{opacity:0.4} }

        /* Guess input */
        .guess-input {
          width: 100%;
          background: #1e1e1e;
          border: 1.5px solid #2a2a2a;
          border-radius: var(--radius);
          padding: 14px 16px;
          font-size: 16px;
          font-family: 'Outfit', sans-serif;
          color: #f0f0f0;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
          margin-bottom: 10px;
        }
        .guess-input:focus { border-color: #1DB954; box-shadow: 0 0 0 3px rgba(29,185,84,0.12); }
        .guess-input::placeholder { color: #444; }
        .guess-input.shake { animation: shake 0.4s ease; border-color: #ef4444; }
        @keyframes shake {
          0%,100%{transform:translateX(0)} 20%{transform:translateX(-6px)} 40%{transform:translateX(6px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(4px)}
        }

        .btn-row { display: flex; gap: 8px; }

        .btn-primary {
          flex: 1;
          padding: 12px;
          background: #1DB954;
          color: #000;
          font-family: 'Outfit', sans-serif;
          font-size: 15px;
          font-weight: 700;
          border: none;
          border-radius: var(--radius);
          cursor: pointer;
          transition: background 0.15s, transform 0.1s;
        }
        .btn-primary:hover { background: #1ed760; transform: translateY(-1px); }
        .btn-primary:active { transform: translateY(0); }
        .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

        .btn-ghost {
          padding: 12px 16px;
          background: transparent;
          color: #666;
          font-family: 'Outfit', sans-serif;
          font-size: 14px;
          font-weight: 500;
          border: 1.5px solid #2a2a2a;
          border-radius: var(--radius);
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .btn-ghost:hover { border-color: #444; color: #999; }

        /* Revealed state */
        .track-reveal { text-align: center; padding: 4px 0 16px; }
        .track-name {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(28px, 5vw, 48px);
          letter-spacing: 0.03em;
          color: #fff;
          line-height: 1;
          margin-bottom: 6px;
        }
        .track-artist {
          font-size: 15px;
          color: #888;
          font-weight: 400;
        }

        .correct-label {
          text-align: center;
          font-family: 'Bebas Neue', sans-serif;
          font-size: 36px;
          color: #1DB954;
          letter-spacing: 0.06em;
          margin-bottom: 12px;
          text-shadow: 0 0 24px rgba(29,185,84,0.5);
          animation: pop-in 0.3s cubic-bezier(0.175,0.885,0.32,1.275);
        }
        @keyframes pop-in { from{transform:scale(0.6);opacity:0} to{transform:scale(1);opacity:1} }

        .who-scored {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #555;
          margin-bottom: 10px;
          text-align: center;
        }

        .player-picker { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 14px; }
        .player-pick-btn {
          padding: 9px 18px;
          border-radius: var(--radius);
          font-family: 'Outfit', sans-serif;
          font-size: 14px;
          font-weight: 600;
          border: 1.5px solid #2a2a2a;
          background: #1a1a1a;
          color: #ccc;
          cursor: pointer;
          transition: all 0.15s;
        }
        .player-pick-btn:hover { border-color: #1DB954; color: #1DB954; background: rgba(29,185,84,0.08); }
        .player-pick-btn.picked { background: #1DB954; border-color: #1DB954; color: #000; }
        .player-pick-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .no-score-label { text-align: center; color: #555; font-size: 14px; margin-bottom: 14px; padding: 10px; }

        /* SIDEBAR */
        .sidebar {
          border-left: 1px solid #1e1e1e;
          background: #0e0e0e;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .sidebar-header {
          padding: 16px 20px 12px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #444;
          border-bottom: 1px solid #1a1a1a;
        }

        .score-list { flex: 1; overflow-y: auto; padding: 8px 0; }
        .score-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 20px;
          transition: background 0.15s;
          gap: 12px;
        }
        .score-row.leader { background: rgba(29,185,84,0.05); }
        .score-row-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .rank-num { font-size: 11px; color: #333; font-weight: 600; width: 16px; text-align: center; flex-shrink: 0; }
        .rank-num.first { color: #1DB954; }
        .player-name-score {
          font-size: 14px;
          font-weight: 500;
          color: #ccc;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .player-name-score.leader { color: #fff; }
        .score-chip {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 20px;
          color: #555;
          letter-spacing: 0.04em;
          transition: color 0.3s;
          flex-shrink: 0;
        }
        .score-chip.leader { color: #1DB954; }
        .score-chip.pulse { animation: score-pop 0.5s cubic-bezier(0.175,0.885,0.32,1.275); }
        @keyframes score-pop { 0%{transform:scale(1)} 50%{transform:scale(1.5);color:#1DB954} 100%{transform:scale(1)} }

        /* FINISHED STATE */
        .finished-overlay {
          position: fixed;
          inset: 0;
          z-index: 100;
          background: rgba(10,10,10,0.97);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-start;
          padding: 28px 24px 24px;
          animation: fade-in 0.4s ease;
          overflow: hidden;
        }
        @keyframes fade-in { from{opacity:0} to{opacity:1} }

        .finished-header {
          flex-shrink: 0;
          text-align: center;
          width: 100%;
          max-width: 480px;
        }

        .finished-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(36px, 6vw, 72px);
          letter-spacing: 0.04em;
          background: linear-gradient(135deg, #fff 0%, #aaffc8 50%, #1DB954 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          line-height: 1;
          margin-bottom: 4px;
          text-align: center;
        }

        /* Winner hero card — shown above the list */
        .winner-hero {
          flex-shrink: 0;
          width: 100%;
          max-width: 480px;
          background: linear-gradient(135deg, rgba(29,185,84,0.15) 0%, rgba(29,185,84,0.05) 100%);
          border: 1px solid rgba(29,185,84,0.35);
          border-radius: var(--radius);
          padding: 12px 20px;
          display: flex;
          align-items: center;
          gap: 14px;
          margin: 12px 0 8px;
        }
        .winner-trophy { font-size: 28px; line-height: 1; flex-shrink: 0; }
        .winner-hero-name {
          flex: 1;
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(22px, 4vw, 32px);
          letter-spacing: 0.04em;
          color: #1DB954;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .winner-hero-score {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 36px;
          color: #1DB954;
          letter-spacing: 0.03em;
          text-shadow: 0 0 20px rgba(29,185,84,0.5);
          flex-shrink: 0;
        }
        .winner-hero-pts {
          font-size: 11px;
          color: #1DB954;
          opacity: 0.6;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-top: 2px;
          flex-shrink: 0;
        }

        .final-scoreboard {
          width: 100%;
          max-width: 480px;
          background: #161616;
          border: 1px solid #222;
          border-radius: var(--radius);
          overflow-y: auto;
          overflow-x: hidden;
          flex: 1 1 0;
          min-height: 0;
          margin-bottom: 16px;
        }
        /* subtle scrollbar */
        .final-scoreboard::-webkit-scrollbar { width: 4px; }
        .final-scoreboard::-webkit-scrollbar-track { background: transparent; }
        .final-scoreboard::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

        .final-row {
          display: flex;
          align-items: center;
          padding: 9px 20px;
          gap: 12px;
          border-bottom: 1px solid #1e1e1e;
          transition: background 0.2s;
          min-height: 44px;
        }
        .final-row:last-child { border-bottom: none; }

        .final-rank {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 18px;
          width: 24px;
          text-align: center;
          flex-shrink: 0;
          line-height: 1;
        }
        .final-rank.first { color: #1DB954; }
        .final-rank.second { color: #aaa; }
        .final-rank.third { color: #cd7f32; }
        .final-rank.rest { color: #333; }

        .final-name {
          flex: 1;
          font-size: 15px;
          font-weight: 500;
          color: #ccc;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .final-score {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          color: #444;
          letter-spacing: 0.03em;
          flex-shrink: 0;
        }
        .final-score.podium { color: #888; }

        /* Quiet on purpose. This is a description of the evening, not a result,
           and it sits directly under a scoreboard that already has the room's
           attention. */
        .round-summary {
          color: #666;
          font-size: 13px;
          text-align: center;
          margin: 4px 0 0;
          flex-shrink: 0;
          max-width: 480px;
        }

        /* Wraps rather than scrolls horizontally, because the point is to
           select all of it. */
        .mix-fallback {
          width: 100%;
          max-width: 480px;
          height: 160px;
          margin-top: 12px;
          padding: 10px 12px;
          background: #1a1a1a;
          color: #ddd;
          border: 1px solid #333;
          border-radius: 8px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
          line-height: 1.5;
          resize: vertical;
          flex-shrink: 0;
        }

        .finished-btn-row {
          display: flex;
          gap: 12px;
          flex-shrink: 0;
          width: 100%;
          max-width: 480px;
          flex-wrap: wrap;
        }
        .btn-lg {
          flex: 1;
          padding: 13px 24px;
          font-family: 'Outfit', sans-serif;
          font-size: 15px;
          font-weight: 700;
          border-radius: var(--radius);
          cursor: pointer;
          transition: all 0.15s;
          border: none;
          white-space: nowrap;
        }
        .btn-lg.green { background: #1DB954; color: #000; box-shadow: 0 4px 24px rgba(29,185,84,0.3); }
        .btn-lg.green:hover { background: #1ed760; transform: translateY(-1px); box-shadow: 0 4px 32px rgba(29,185,84,0.5); }
        .btn-lg.outline { background: transparent; color: #666; border: 1.5px solid #2a2a2a; }
        .btn-lg.outline:hover { color: #999; border-color: #444; }

        .install-cta {
          width: 100%;
          max-width: 480px;
          display: flex;
          align-items: center;
          gap: 14px;
          background: rgba(29,185,84,0.06);
          border: 1px solid rgba(29,185,84,0.25);
          border-radius: var(--radius);
          padding: 14px 16px;
          margin-bottom: 16px;
          flex-shrink: 0;
          text-align: left;
        }
        .install-cta-emoji { font-size: 24px; flex-shrink: 0; }
        .install-cta-title { font-size: 14px; font-weight: 600; color: #f0f0f0; line-height: 1.3; }
        .install-cta-desc { font-size: 12px; color: #888; margin-top: 3px; line-height: 1.4; }
        .install-cta-btn {
          margin-left: auto;
          flex-shrink: 0;
          padding: 9px 18px;
          background: #1DB954;
          color: #000;
          font-family: 'Outfit', sans-serif;
          font-size: 13px;
          font-weight: 700;
          border: none;
          border-radius: var(--radius);
          cursor: pointer;
          transition: background 0.15s, transform 0.1s;
        }
        .install-cta-btn:hover { background: #1ed760; transform: translateY(-1px); }

        @media (max-width: 768px) {
          .game-layout {
            grid-template-columns: 1fr;
            grid-template-rows: 56px 1fr auto;
          }
          .sidebar { border-left: none; border-top: 1px solid #1e1e1e; max-height: 140px; }
          .end-game-btn { font-size: 10px !important; padding: 4px 8px !important; }
        }
      `}</style>

      <audio
        ref={audioRef}
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onEnded={() => setAudioPlaying(false)}
        onError={handleAudioError}
      />

      <div className="game-layout">
        {/* TOP BAR */}
        <header className="top-bar">
          <div className="round-badge">
            <span>Round</span>
            <span className="round-num">
              {phase === "finished" ? tracks.length : currentIndex + 1}
            </span>
            <span style={{ color: "#333" }}>/</span>
            <span>{tracks.length}</span>
          </div>
          <span className="playlist-name">{playlistName}</span>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {phase !== "finished" && (
              <button
                className="end-game-btn"
                onClick={endGame}
                style={{
                  background: "none",
                  border: "1px solid #2a2a2a",
                  borderRadius: "var(--radius)",
                  color: "#888",
                  fontSize: "12px",
                  fontFamily: "Outfit, sans-serif",
                  fontWeight: 600,
                  padding: "6px 12px",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "#1DB954"; e.currentTarget.style.borderColor = "#1DB954"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#888"; e.currentTarget.style.borderColor = "#2a2a2a"; }}
              >
                End Game
              </button>
            )}
            <button
              onClick={() => { retireRound(); router.push("/"); }}
              style={{
                background: "none",
                border: "1px solid #2a2a2a",
                borderRadius: "var(--radius)",
                color: "#555",
                fontSize: "12px",
                fontFamily: "Outfit, sans-serif",
                fontWeight: 500,
                padding: "6px 12px",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "#ef4444"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#555"; e.currentTarget.style.borderColor = "#2a2a2a"; }}
            >
              Quit
            </button>
          </div>
        </header>

        {/* MAIN AREA */}
        <main className="main-area">
          {/* Ambient background — only when hint shown or revealed */}
          {currentTrack?.albumImageUrl && showAlbumArt && (
            <div
              className={`ambient-bg${isRevealed ? " revealed" : ""}`}
              style={{ backgroundImage: `url(${albumArt})` }}
            />
          )}

          {/* Game card */}
          <div className="game-card">
            {/* Album art */}
            <div className="album-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={showAlbumArt ? albumArt : ALBUM_PLACEHOLDER}
                alt="Album art"
                className={`album-img${isRevealed ? " revealed" : showAlbumArt ? " blurred" : " blurred"}`}
              />
              {/* Play button overlay */}
              {phase === "waiting" && !noAudio && (
                <div className="album-overlay">
                  <button className="play-btn" onClick={playClip} aria-label="Play clip" disabled={previewLoading} style={previewLoading ? { opacity: 0.5, cursor: "not-allowed" } : {}}>
                    {previewLoading ? (
                      <div style={{ width: "24px", height: "24px", border: "3px solid rgba(0,0,0,0.3)", borderTop: "3px solid #000", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    ) : (
                      <div className="play-icon" />
                    )}
                  </button>
                </div>
              )}
              {/* No audio overlay */}
              {phase === "waiting" && noAudio && (
                <div className="album-overlay" style={{ background: "rgba(0,0,0,0.75)", flexDirection: "column", gap: "8px" }}>
                  <p style={{ color: "#999", fontSize: "13px", textAlign: "center", padding: "0 16px" }}>No audio for this track</p>
                </div>
              )}
              {phase === "playing" && (
                <div className="album-overlay" style={{ background: "rgba(0,0,0,0.2)" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ display: "flex", gap: "6px", justifyContent: "center", marginBottom: "12px" }}>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          style={{
                            width: "4px",
                            borderRadius: "2px",
                            background: "#1DB954",
                            animation: `eq-bar 0.8s ease-in-out infinite alternate`,
                            animationDelay: `${i * 0.12}s`,
                            height: "24px",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Progress bar */}
            {(phase === "playing" || phase === "guessing") && (
              <div className="progress-wrap">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            )}

            {/* Buzzer Mode: the room code, the queue, and the host's verdict
                buttons. Rendered above the phase content so the host's eyes and
                thumb stay in one place all game. Absent unless a room was
                created at setup, so party games are untouched. */}
            {buzzerRoom && phase !== "finished" && (
              <BuzzerHostPanel
                roomCode={buzzerRoom.code}
                hostToken={buzzerRoom.hostToken}
                hostName={buzzerRoom.hostName}
                roundIndex={currentIndex}
                gamePhase={phase}
                onControls={setBuzzerControls}
                onBuzz={pauseClip}
                onPlayersChange={mergeRoomPlayers}
                onPeakPlayers={(n) => {
                  peakPhonesRef.current = n;
                }}
              />
            )}

            {/* Phase content */}
            {phase === "waiting" && (
              <div style={{ textAlign: "center" }}>
                {previewLoading ? (
                  <div>
                    <p style={{ color: "#1DB954", fontSize: "13px", letterSpacing: "0.06em", marginBottom: "12px" }}>
                      Finding audio…
                    </p>
                    {loadingSkipVisible && (
                      <div className="btn-row">
                        <button className="btn-primary" onClick={reveal}>
                          Reveal Answer →
                        </button>
                        <button className="btn-ghost" onClick={nextTrack}>
                          Skip Track
                        </button>
                      </div>
                    )}
                  </div>
                ) : noAudio ? (
                  <div>
                    <div className="btn-row">
                      <button className="btn-primary" onClick={reveal}>
                        Reveal Answer →
                      </button>
                      <button className="btn-ghost" onClick={nextTrack}>
                        Skip Track
                      </button>
                    </div>
                  </div>
                ) : (
                  <p style={{ color: "#555", fontSize: "13px", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    Press Play to start the clip
                  </p>
                )}
              </div>
            )}

            {phase === "playing" && (
              <div>
                <p className="listening-label" style={{ marginBottom: "12px" }}>
                  {clipPaused ? "Paused — someone buzzed in" : "Listening…"}
                </p>
                <div className="btn-row" style={{ marginBottom: "8px" }}>
                  {clipControls()}
                </div>
                <button
                  className="btn-ghost"
                  style={{ width: "100%", ...(albumHintShown ? { color: "#1DB954", borderColor: "#1DB954", opacity: 0.7 } : {}) }}
                  onClick={() => setAlbumHintShown(true)}
                  disabled={albumHintShown}
                >
                  {albumHintShown ? "Album Art Shown" : "Show Album Art Hint"}
                </button>
              </div>
            )}

            {phase === "guessing" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <p style={{ textAlign: "center", fontSize: "20px", fontWeight: 600, color: "#f0f0f0", marginBottom: "4px" }}>
                  What&apos;s the song?
                </p>
                <div className="btn-row">{clipControls()}</div>
                {!albumHintShown && currentTrack?.albumImageUrl && (
                  <button className="btn-ghost" onClick={() => setAlbumHintShown(true)}>
                    Show Album Art Hint
                  </button>
                )}
              </div>
            )}

            {phase === "revealed" && (
              <div>
                <div className="track-reveal">
                  <p className="track-name">{currentTrack?.name}</p>
                  <p className="track-artist">{currentTrack?.artists?.join(", ")}</p>
                  {currentTrack?.albumName && (
                    <p style={{ fontSize: "13px", color: "#666", marginTop: "6px" }}>
                      {currentTrack.albumName}
                    </p>
                  )}
                  {currentTrack?.contributors && currentTrack.contributors.length > 0 && (
                    <p style={{ fontSize: "13px", color: "#1DB954", marginTop: "8px", fontWeight: 500 }}>
                      {currentTrack.contributors.length > 1
                        ? `From ${currentTrack.contributors.join(" & ")}'s playlists!`
                        : `From ${currentTrack.contributors[0]}'s playlist`}
                    </p>
                  )}
                </div>

                {/* Song scoring — 3 pts. In Buzzer Mode the room already knows
                    who got there first, so listing every player again would be
                    asking the host to re-answer a question the server settled.
                    Falls back to the full picker when nobody buzzed. */}
                {buzzerControls && buzzerControls.buzzes.length > 0 && !pointsAwarded ? (
                  <>
                    <p className="who-scored">
                      {buzzerControls.buzzes[0].name} buzzed first —{" "}
                      {(buzzerControls.buzzes[0].msSinceOpen / 1000).toFixed(2)}s
                    </p>
                    {/* Centred and content-sized, both of them. .btn-primary is
                        flex:1 by default, so next to a content-sized "Wrong" the
                        Correct button ballooned across the card and read as a
                        different class of control than the verdict beside it. */}
                    <div
                      className="btn-row"
                      style={{ marginBottom: "14px", justifyContent: "center" }}
                    >
                      <button
                        className="btn-primary"
                        style={{ flex: "0 0 auto", padding: "12px 16px" }}
                        onClick={() => {
                          awardPoint(buzzerControls.buzzes[0].name);
                          buzzerControls.correct();
                        }}
                      >
                        Correct +3
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => buzzerControls.wrong()}
                        style={{ flex: "0 0 auto" }}
                      >
                        {buzzerControls.buzzes.length > 1
                          ? `Wrong → ${buzzerControls.buzzes[1].name}`
                          : "Wrong"}
                      </button>
                    </div>
                    {buzzerControls.buzzes.length > 1 && (
                      <p style={{ textAlign: "center", fontSize: "12px", color: "#666", marginBottom: "14px" }}>
                        Queue: {buzzerControls.buzzes.slice(1).map((b) => b.name).join(" → ")}
                      </p>
                    )}
                  </>
                ) : !pointsAwarded ? (
                  <>
                    <p className="who-scored">Who guessed the song? (+3 pts)</p>
                    <div className="player-picker" style={{ marginBottom: "14px" }}>
                      {players.map((p) => (
                        <button key={p.name} className="player-pick-btn" onClick={() => awardPoint(p.name)}>
                          {p.name}
                        </button>
                      ))}
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          // Nobody scored, so the round is over — tell the room
                          // now rather than leaving the phones showing a live
                          // queue until the host gets to Next Track.
                          buzzerControlsRef.current?.reveal();
                          setPointsAwarded(true);
                        }}
                      >
                        No one
                      </button>
                    </div>
                  </>
                ) : (
                  <p style={{ textAlign: "center", color: "#1DB954", fontSize: "13px", marginBottom: "14px" }}>
                    {roundWinner ? `+3 pts → ${roundWinner}` : "No one scored"}
                  </p>
                )}

                {/* Album scoring — 1 pt, only if track has album */}
                {currentTrack?.albumName && (
                  <>
                    <p className="who-scored">Who guessed the album? (+1 pt)</p>
                    {!albumPointsAwarded ? (
                      <div className="player-picker" style={{ marginBottom: "14px" }}>
                        {players.map((p) => (
                          <button key={p.name} className="player-pick-btn" onClick={() => awardAlbumPoint(p.name)}>
                            {p.name}
                          </button>
                        ))}
                        <button className="btn-ghost" onClick={() => setAlbumPointsAwarded(true)}>
                          No one
                        </button>
                      </div>
                    ) : (
                      <p style={{ textAlign: "center", color: "#1DB954", fontSize: "13px", marginBottom: "14px" }}>
                        {albumWinner ? `+1 pt → ${albumWinner}` : "No one scored"}
                      </p>
                    )}
                  </>
                )}

                {/* Source scoring — 2 pts, Mixed Playlist Mode only. Every player is */}
                {/* eligible, including this track's contributor(s) — sampling means a */}
                {/* contributor doesn't know which of their tracks made the pool, so they */}
                {/* may not recognize their own track any faster than anyone else. */}
                {currentTrack?.contributors && currentTrack.contributors.length > 0 && (
                  <>
                    <p className="who-scored">Who guessed whose playlist this is? (+2 pts)</p>
                    {!sourcePointsAwarded ? (
                      <div className="player-picker" style={{ marginBottom: "14px" }}>
                        {players.map((p) => (
                          <button
                            key={p.name}
                            className="player-pick-btn"
                            onClick={() => awardSourcePoint(p.name)}
                          >
                            {p.name}
                          </button>
                        ))}
                        <button className="btn-ghost" onClick={() => setSourcePointsAwarded(true)}>
                          No one
                        </button>
                      </div>
                    ) : (
                      <p style={{ textAlign: "center", color: "#1DB954", fontSize: "13px", marginBottom: "14px" }}>
                        {sourceWinner ? `+2 pts → ${sourceWinner}` : "No one scored"}
                      </p>
                    )}
                  </>
                )}

                <button className="btn-primary" onClick={nextTrack} style={{ flex: "none", display: "block", margin: "0 auto", minWidth: "180px", width: "fit-content" }}>
                  {currentIndex + 1 >= tracks.length ? "See Final Scores →" : "Next Track →"}
                </button>
              </div>
            )}
          </div>

          {/* Finished overlay (full screen inside main) */}
          {phase === "finished" && (
            <div className="finished-overlay">
              {/* Header */}
              <div className="finished-header">
                <p style={{ fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#555", marginBottom: "4px" }}>
                  Game Over
                </p>
                <h1 className="finished-title">Final Scores</h1>
                <p style={{ color: "#444", fontSize: "13px" }}>{playlistName}</p>
              </div>

              {/* Winner hero — only shown when someone scored */}
              {maxScore > 0 && sortedPlayers.length > 0 && (
                <div className="winner-hero">
                  <span className="winner-trophy">🏆</span>
                  <span className="winner-hero-name">{sortedPlayers[0].name}</span>
                  <div style={{ textAlign: "right" }}>
                    <div className="winner-hero-score">{sortedPlayers[0].score}</div>
                    <div className="winner-hero-pts">pts</div>
                  </div>
                </div>
              )}

              {/* Rest of players (2nd place onward) in compact scrollable list */}
              {sortedPlayers.length > 1 && (
                <div className="final-scoreboard">
                  {sortedPlayers.slice(1).map((p, i) => {
                    const idx = i + 1; // actual rank index (0-based = 2nd place onward)
                    const rankClass = idx === 1 ? "second" : idx === 2 ? "third" : "rest";
                    const rankLabel = `${idx + 1}`;
                    const isPodium = idx <= 2;
                    return (
                      <div key={p.name} className="final-row">
                        <span className={`final-rank ${rankClass}`}>{rankLabel}</span>
                        <span className="final-name">{p.name}</span>
                        <span className={`final-score${isPodium ? " podium" : ""}`}>{p.score}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* How the scoring actually went, which the scoreboard cannot
                  show: two rooms reach the same final scores with completely
                  different rounds behind them. Mixed only, because
                  `setRoundHistory` only records mixed rounds — a non-mixed game
                  would render a line built from an empty array. */}
              {playlistSource === "mixed" && roundSummaryLine && (
                <p className="round-summary">{roundSummaryLine}</p>
              )}

              {installCta && <InstallCta onInstall={handleInstall} />}

              {/* Buttons — always visible, pinned at bottom */}
              <div className="finished-btn-row">
                <button className="btn-lg green" onClick={playAgain}>
                  Play Again →
                </button>
                <button className="btn-lg outline" onClick={downloadResultImage}>
                  Save Results
                </button>
                {playlistSource === "mixed" && (
                  <button className="btn-lg outline" onClick={downloadTasteCard}>
                    Save Taste Card
                  </button>
                )}
                {playlistSource === "mixed" && (
                  <button className="btn-lg outline" onClick={copyMixList}>
                    {mixCopied ? "Copied ✓" : "Copy the Mix"}
                  </button>
                )}
              </div>

              {/* Clipboard refused. Showing the text is not a consolation
                  prize — it is the same payload by a route the browser cannot
                  veto. */}
              {mixFallback && (
                <textarea
                  className="mix-fallback"
                  readOnly
                  value={mixFallback}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="The mixed playlist, ready to copy"
                />
              )}

              {/* The room is looking at this screen with their phones already
                  in hand, which is the one moment in the game when a way onward
                  costs the host nothing to offer. */}
              <LoopQr />
            </div>
          )}
        </main>

        {/* SIDEBAR SCOREBOARD */}
        <aside className="sidebar">
          <div className="sidebar-header">Scoreboard</div>
          <div className="score-list">
            {sortedPlayers.map((p, idx) => {
              const isLeader = p.score === maxScore && maxScore > 0;
              return (
                <div key={p.name} className={`score-row${isLeader ? " leader" : ""}`}>
                  <div className="score-row-left">
                    <span className={`rank-num${idx === 0 ? " first" : ""}`}>{idx + 1}</span>
                    <span className={`player-name-score${isLeader ? " leader" : ""}`}>{p.name}</span>
                  </div>
                  <span className={`score-chip${isLeader ? " leader" : ""}${scorePulse === p.name ? " pulse" : ""}`}>
                    {p.score}
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <style>{`
        @keyframes eq-bar {
          from { height: 8px; opacity: 0.5; }
          to { height: 32px; opacity: 1; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
