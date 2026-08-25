/**
 * Resolves a 30s preview clip for one track, since Spotify stopped populating
 * preview_url in Nov 2024 and now returns null for every track on Client
 * Credentials — measured 0/20 across four markets.
 *
 * All of the interesting behaviour — caching, the three-way found/absent/
 * unavailable outcome, the global lookup budget, the per-source cooldowns —
 * lives in lib/preview-cache.ts, which POST /api/preview/batch shares. This
 * route is the per-track entry point: the lazy fallback for a track the batch
 * prefetch deferred, and the repair path for a URL that stopped playing.
 *
 * `status` is the field callers should branch on. `previewUrl` stays in the
 * body unchanged so a client older than this deploy keeps working — it just
 * cannot tell "there is no clip" from "we couldn't reach anyone", which is the
 * distinction the whole change is about.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPreview } from "@/lib/preview-cache";
import { enforceRateLimit } from "@/lib/rate-limit";
import { clampPreviewField, type PreviewResult } from "@/types/preview";

/** Roughly one lookup per unique track; the client also caches per session. */
const PREVIEW_LIMIT = 300;
const PREVIEW_WINDOW_SECONDS = 10 * 60;

/**
 * Much tighter than the read limit. A refresh deliberately bypasses the cache,
 * so it is the one parameter here that can be turned into an upstream
 * amplifier; a client should only ever send one after a clip actually failed to
 * play. The global budget in lib/preview-cache.ts bounds it too, but a client
 * looping on refresh would otherwise spend everyone else's allowance.
 */
const REFRESH_LIMIT = 30;
const REFRESH_WINDOW_SECONDS = 10 * 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // Trimmed to match POST /api/preview/batch. Untrimmed, the same track through
  // the two routes can pick different recordings and write both under one key.
  const track = clampPreviewField(searchParams.get("track") ?? "");
  const artist = clampPreviewField(searchParams.get("artist") ?? "");
  const id = searchParams.get("id") ?? "";
  const refresh = searchParams.get("refresh") === "1";
  const duration = Number(searchParams.get("durationMs"));
  const durationMs = Number.isFinite(duration) && duration > 0 ? duration : undefined;

  if (!track) {
    return NextResponse.json<PreviewResult>({ previewUrl: null, status: "absent" });
  }

  const limited = await enforceRateLimit(
    req,
    refresh ? "preview:refresh" : "preview",
    refresh ? REFRESH_LIMIT : PREVIEW_LIMIT,
    refresh ? REFRESH_WINDOW_SECONDS : PREVIEW_WINDOW_SECONDS,
    "rate_limited_preview"
  );
  if (limited) return limited;

  const result = await getPreview({ id, track, artist, durationMs }, { refresh });
  return NextResponse.json<PreviewResult>(result);
}
