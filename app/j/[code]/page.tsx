"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { trackEvent } from "@/lib/analytics";
import { apiError, describeError } from "@/lib/error-messages";
import { useErrorLocale } from "@/lib/use-error-locale";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoopCtaButton, LoopFooter } from "@/components/loop-cta";
import { ServiceNotice } from "@/components/service-notice";

type SubmitStatus = "idle" | "loading" | "done" | "error";

export default function JoinRoomPage() {
  const params = useParams<{ code: string }>();
  const code = (params.code ?? "").toUpperCase();

  const [name, setName] = useState("");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [trackCount, setTrackCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Whoever scanned this QR never chose a language on this site — this page is
  // usually their first and only one — so their phone decides.
  const locale = useErrorLocale();

  const isValidUrl =
    playlistUrl.includes("spotify.com/playlist") || playlistUrl.includes("spotify:playlist:");
  const canSubmit = name.trim().length > 0 && isValidUrl && status !== "loading";

  // The denominator for this page's only conversion. The host's poll counts
  // submissions that landed, so a phone that scanned in and then bounced off the
  // form is indistinguishable from a phone that never scanned at all.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    trackEvent("room_join_opened", { join_page: "j", wants_playlist: true });
  }, []);

  async function handleSubmit() {
    if (!canSubmit) return;
    setStatus("loading");
    setError(null);
    // 410 from the mailbox means the host already started, i.e. this player
    // arrived too late rather than did anything wrong. Read in the catch, where
    // the response is no longer in scope.
    let tooLate = false;
    try {
      const res = await fetch(`/api/room/${code}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: name, playlistUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        tooLate = res.status === 410;
        throw apiError(data, "room_submit_failed");
      }
      setTrackCount(data.trackCount);
      setStatus("done");
      trackEvent("room_submission_sent", {
        submitted_by: "player",
        track_count: data.trackCount,
      });
    } catch (e: unknown) {
      trackEvent("room_submission_failed", {
        submitted_by: "player",
        reason: tooLate ? "too_late" : "other",
      });
      setError(describeError(e, locale, "room_submit_failed"));
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <CardTitle className="text-[#1DB954]">✓ You&apos;re in!</CardTitle>
            <CardDescription>
              Received {trackCount} track{trackCount === 1 ? "" : "s"} from your playlist.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              You can close this page now — the host will start the game once everyone&apos;s in.
              No one else can see your playlist.
            </p>
            {/* This screen used to end here. It is the one moment on this page
                where the player has finished the task, has nothing left to do,
                and is still looking — which makes it the best placement in the
                whole flow and, until now, a dead end. */}
            <LoopCtaButton surface="join_submitted">
              Host your own game →
            </LoopCtaButton>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join Room {code}</CardTitle>
          <CardDescription>
            Add your Spotify playlist — no one else will see it until the game starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Your Name</Label>
            <Input
              id="name"
              placeholder="Player name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="playlist">Your Spotify Playlist</Label>
            <Input
              id="playlist"
              type="url"
              placeholder="https://open.spotify.com/playlist/..."
              value={playlistUrl}
              onChange={(e) => setPlaylistUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {status === "loading" ? "Submitting..." : "Submit Playlist"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <ServiceNotice />
          <LoopFooter surface="join_footer" />
        </CardContent>
      </Card>
    </main>
  );
}
