import { NextRequest, NextResponse } from "next/server";
import { getSpotifyServiceStatus } from "@/lib/playlist-cache";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * Whether Spotify is currently refusing this app, phrased for a page rather
 * than for a request that already failed.
 *
 * Exists so a host learns the site is throttled *before* pasting a playlist
 * and pressing Start, instead of after. The alternative that was rejected is a
 * hand-written banner: the quota clears on Spotify's schedule, usually
 * overnight, and a static notice would then need someone to remember to take
 * it down. Everything in this codebase that depends on someone remembering has
 * eventually failed silently, so the notice reads the same KV key the
 * admission gate does and disappears on its own.
 *
 * Costs one KV read, and nothing here can reach Spotify — that is the point.
 * `getSpotifyServiceStatus` fails open, so a KV outage renders no notice
 * rather than a false one.
 */

/**
 * Generous on purpose: the notice fires once per page load per visitor, so the
 * ceiling has to sit above ordinary browsing while still bounding a script
 * that discovers the endpoint. Two KV commands per call (this limiter's incr
 * plus the cooldown read) is what the limit is protecting.
 */
const STATUS_LIMIT = 120;
const STATUS_WINDOW_SECONDS = 10 * 60;

export async function GET(req: NextRequest) {
  const limited = await enforceRateLimit(
    req,
    "service:status",
    STATUS_LIMIT,
    STATUS_WINDOW_SECONDS,
    "rate_limited"
  );
  if (limited) return limited;

  const status = await getSpotifyServiceStatus();
  return NextResponse.json(status);
}
