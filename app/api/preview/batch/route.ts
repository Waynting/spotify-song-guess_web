/**
 * Resolves previews for a whole game in one request.
 *
 * The game page used to fetch one preview at a time, at the moment the host
 * pressed Play. That is 50 round trips per game, 50 Upstash commands to read
 * them, and — worse — it put the upstream lookup on the critical path of every
 * single round, so a throttled minute surfaced as a dead Play button rather
 * than as something the page could have absorbed before the party started.
 *
 * Batching moves the reads to one `mget` (see lib/kv.ts) and lets
 * lib/preview-cache.ts make one admission decision for the whole playlist
 * instead of fifty independent ones. It is an optimisation, not a requirement:
 * anything this route defers or refuses comes back `unavailable`, and the
 * per-track GET picks it up lazily exactly as before.
 */

import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { getPreviews, type PreviewQuery } from "@/lib/preview-cache";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  clampPreviewField,
  PREVIEW_BATCH_MAX,
  type PreviewBatchResponse,
  type PreviewResult,
} from "@/types/preview";

/** One batch per game, plus retries. Nothing legitimate needs many more. */
const BATCH_LIMIT = 20;
const BATCH_WINDOW_SECONDS = 10 * 60;

interface BatchRequestTrack {
  id?: unknown;
  name?: unknown;
  artist?: unknown;
  durationMs?: unknown;
}

/**
 * Returns null for anything malformed rather than skipping bad entries: a
 * partially-honoured batch would leave the client believing the missing ids
 * were resolved and unavailable, when they were never asked about at all.
 */
function parseTracks(body: unknown): PreviewQuery[] | null {
  const tracks = (body as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (tracks.length > PREVIEW_BATCH_MAX) return null;

  const queries: PreviewQuery[] = [];
  for (const raw of tracks as BatchRequestTrack[]) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const name = typeof raw?.name === "string" ? clampPreviewField(raw.name) : "";
    // An id is required here, unlike on the GET: the response is a map keyed by
    // it, so an entry without one has nowhere to be returned to.
    if (!id || !name) return null;
    // Unlike id and name, a bad duration is not worth refusing the batch over:
    // it only sharpens the match, so dropping it costs precision, not a result.
    const duration = typeof raw?.durationMs === "number" ? raw.durationMs : 0;
    queries.push({
      id,
      track: name,
      artist: typeof raw?.artist === "string" ? clampPreviewField(raw.artist) : "",
      ...(Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {}),
    });
  }
  return queries;
}

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(
    req,
    "preview:batch",
    BATCH_LIMIT,
    BATCH_WINDOW_SECONDS,
    "rate_limited_preview"
  );
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("preview_request_invalid", 400);
  }

  const queries = parseTracks(body);
  if (!queries) return errorResponse("preview_request_invalid", 400);

  const resolved = await getPreviews(queries);

  const previews: Record<string, PreviewResult> = {};
  for (const [id, result] of resolved) previews[id] = result;

  return NextResponse.json<PreviewBatchResponse>({ previews });
}
