#!/usr/bin/env node
/**
 * Prints the viral-loop counters. `npm run stats`.
 *
 * The counters written by `/r/[surface]` and `/api/pulse` are useless until
 * something reads them, and the thing that reads them cannot be a dashboard:
 * four separate attempts to go and open GA4 did not happen over eight weeks,
 * which makes "and then go look at it" a step with a measured completion rate
 * of zero rather than a step with a cost. A command in this repo is a
 * different proposition — it runs from the terminal that is already open, and
 * a coding agent can run it unprompted at the start of a session, which is the
 * actual delivery mechanism here.
 *
 * ## Keys are discovered, not reconstructed
 *
 * This script does not hold a copy of the metric list. It asks Redis for
 * everything under `loop:stats:` and parses what comes back. Rebuilding the
 * keys from a hardcoded list here would be a second definition of a format
 * that already lives in `lib/loop-stats.ts`, and that class of drift fails
 * silently — the script would read keys nobody writes and print a confident
 * table of zeros. Discovery also means a metric added later shows up here
 * without anyone remembering to update this file — though only as far as the
 * renderers go, which is what the "Other counters" block at the bottom is for.
 *
 * The only shared knowledge is the `loop:stats:` prefix. If that ever changes
 * this prints "no counters found", which is loud rather than wrong.
 *
 * **Discovery uses `SCAN`, not `KEYS`, and that is not a style preference.**
 * `KEYS` matches against every key in the instance rather than every key under
 * the prefix, so this namespace's size was never the relevant number:
 * `lib/preview-cache.ts` writes one key per track and holds positive entries
 * for a year, and when that set crossed Upstash's ceiling the server began
 * refusing the command outright. `npm run stats` then exits 1 and prints
 * nothing, for a reason with no connection to the loop. Anything that walks
 * this namespace must page a cursor.
 *
 * Usage:
 *   npm run stats            # last 7 complete days
 *   npm run stats -- 30      # last 30
 *
 * Credentials come from `.env.local` or `.env` (both gitignored), or from the
 * environment if you would rather export them.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PREFIX = "loop:stats:";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Same files Next reads, so there is one place to keep these.
 *
 * `process.loadEnvFile` is a Node built-in (20.12+) — no dotenv, which would be
 * a dependency added purely to read a file the runtime already parses.
 *
 * **Order is inverted on purpose.** It does not overwrite a variable that is
 * already set, so first writer wins; loading `.env.local` first is what gives
 * it precedence over `.env`, matching Next. Anything exported in the shell was
 * set before either call and still beats both.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(join(repoRoot, file));
  } catch {
    // Absent, or unreadable. Either is fine — the check below is the one that
    // decides whether we actually have what we need.
  }
}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error(
    "Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.\n" +
      "Looked in .env.local, .env, and the environment.\n\n" +
      "These are the production values — the local fallback in lib/kv.ts is an\n" +
      "in-process Map, so there is nothing to read without them. Copy them from\n" +
      "the Vercel project's environment variables."
  );
  process.exit(1);
}

const days = Number.parseInt(process.argv[2] ?? "7", 10);
if (!Number.isInteger(days) || days < 1 || days > 30) {
  console.error("Day count must be 1-30 (counters are held 30 days).");
  process.exit(1);
}

/**
 * One Upstash REST command.
 *
 * Failures are rewritten before they surface. The raw ones are an undici
 * `TypeError: fetch failed` with a stack into Node internals, which says
 * nothing about the two things actually likely to be wrong here — a typo'd URL
 * or a token from the wrong project.
 */
async function redis(command) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
  } catch (cause) {
    throw new Error(
      `Could not reach Upstash at ${url}\n` +
        `  ${cause instanceof Error ? cause.message : String(cause)}\n` +
        "  Check UPSTASH_REDIS_REST_URL — it should be the full https:// REST\n" +
        "  endpoint from the Vercel project, not the redis:// connection string."
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Upstash rejected the token.\n" +
        "  UPSTASH_REDIS_REST_TOKEN does not match UPSTASH_REDIS_REST_URL —\n" +
        "  usually a token copied from a different database."
    );
  }
  if (!res.ok) {
    throw new Error(`Upstash ${res.status}: ${await res.text()}`);
  }
  const { result } = await res.json();
  return result;
}

/** UTC, matching `dayBucket()` in lib/kv.ts. */
function bucketsFor(count) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function pct(numerator, denominator) {
  if (!denominator) return "     —";
  return `${((numerator / denominator) * 100).toFixed(1).padStart(5)}%`;
}

/**
 * Every key under the prefix, walked with `SCAN` rather than `KEYS`.
 *
 * `KEYS` was correct about this namespace and wrong about the database. The
 * loop counters are a few hundred keys with a 30-day TTL — but `KEYS` matches
 * against *every* key in the instance, and `lib/preview-cache.ts` writes one
 * per track and holds positive entries for a year. That set grows with the
 * catalogue, not with the loop, and when it crossed Upstash's ceiling the
 * server started refusing the command outright:
 *
 *     ERR KEYS command is disabled because total number of keys is too large
 *
 * The failure mode is what makes this worth the extra code. It is not a slow
 * report or a partial one: `npm run stats` exits 1 and prints nothing, and it
 * does so for a reason that has nothing to do with the loop. The one instrument
 * anybody actually reads went dark because a different namespace grew.
 *
 * `SCAN` is O(1) per call and cursor-paged, so it never trips that ceiling.
 * `MATCH` is applied server-side but *after* the per-call sample, so a page may
 * legitimately come back empty while the cursor is still non-zero — stopping on
 * an empty page instead of on cursor 0 is the classic way to read a fraction of
 * a namespace and report it as the whole thing. `COUNT` is a hint, not a limit.
 */
async function scanKeys(match) {
  const found = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis(["SCAN", cursor, "MATCH", match, "COUNT", "1000"]);
    cursor = String(next);
    if (Array.isArray(batch)) found.push(...batch);
  } while (cursor !== "0");
  return found;
}

let keys;
try {
  keys = await scanKeys(`${PREFIX}*`);
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
if (keys.length === 0) {
  console.log(
    `No counters found under "${PREFIX}".\n\n` +
      "Either nothing has been recorded yet, or the key prefix in\n" +
      "lib/loop-stats.ts changed and this script was not updated."
  );
  process.exit(0);
}

/**
 * Chunked because the REST transport puts the whole command in one request, so
 * a single `MGET` over the namespace grows a request body without bound. 30
 * days times the metric count is already a few hundred keys and the metric
 * count only goes up.
 */
async function mgetAll(wanted) {
  const out = [];
  for (let i = 0; i < wanted.length; i += 256) {
    out.push(...((await redis(["MGET", ...wanted.slice(i, i + 256)])) ?? []));
  }
  return out;
}

const values = await mgetAll(keys);
const window = new Set(bucketsFor(days));

/** metric -> total, and the set of days that recorded anything at all. */
const totals = new Map();
const liveDays = new Set();

keys.forEach((key, i) => {
  const rest = key.slice(PREFIX.length);
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) return;
  const day = rest.slice(0, firstColon);
  const metric = rest.slice(firstColon + 1);
  if (!window.has(day)) return;

  const count = Number(values[i] ?? 0);
  if (!Number.isFinite(count)) return;
  if (metric === "live") {
    if (count > 0) liveDays.add(day);
    return;
  }
  totals.set(metric, (totals.get(metric) ?? 0) + count);
});

const get = (metric) => totals.get(metric) ?? 0;

const surfaces = [
  ...new Set(
    [...totals.keys()]
      .filter((m) => m.startsWith("impression:") || m.startsWith("click:"))
      .map((m) => m.slice(m.indexOf(":") + 1))
  ),
].sort();

const games = get("games");
const repeatHost = get("repeat_host");
const throttled = get("throttled");

console.log(`\nGuessSong loop — last ${days} days (UTC)`);
console.log(`Days with any activity: ${liveDays.size}/${days}\n`);

if (liveDays.size === 0) {
  console.log(
    "No day in this window recorded anything. That is a plumbing problem,\n" +
      "not a result — a real zero still bumps the liveness marker.\n"
  );
}

console.log("Surface            shown    followed     rate");
console.log("─".repeat(48));
if (surfaces.length === 0) {
  console.log("(nothing recorded)");
} else {
  for (const surface of surfaces) {
    const shown = get(`impression:${surface}`);
    const clicked = get(`click:${surface}`);
    console.log(
      `${surface.padEnd(18)}${String(shown).padStart(5)}` +
        `${String(clicked).padStart(12)}   ${pct(clicked, shown)}`
    );
  }
}

console.log(`\nGames started       ${games}`);
console.log(
  `Repeat hosts        ${repeatHost}   ${pct(repeatHost, games)} of games`
);

const indices = [...totals.keys()]
  .filter((m) => m.startsWith("host_index:"))
  .map((m) => Number(m.slice("host_index:".length)))
  .filter(Number.isFinite)
  .sort((a, b) => a - b);

if (indices.length > 0) {
  console.log("\nGames by host's game number");
  for (const n of indices) {
    const count = get(`host_index:${n}`);
    const bar = "█".repeat(Math.min(40, Math.round((count / games) * 40)));
    console.log(`  ${String(n).padStart(2)}${n === 10 ? "+" : " "} ${String(count).padStart(5)}  ${bar}`);
  }
}

/**
 * Anything discovered under `loop:stats:` that no block above consumed.
 *
 * `KEYS` finds every metric, but every renderer above is written against one
 * specific key shape, so until this existed a newly added counter was read,
 * summed, and then silently dropped — and the header of this file promised the
 * opposite ("a metric added later appears here without anyone editing the
 * script"). It was true of the discovery and false of the output, which is the
 * worst place for that split: the number looks like a zero rather than like a
 * missing renderer, and zero is a real answer here.
 *
 * Printing the leftovers generically costs a few lines and closes the class.
 * A metric that deserves better framing than a raw count gets its own block
 * above and drops out of this one by being consumed.
 */
const RENDERED_EXACT = new Set(["live", "games", "repeat_host", "throttled"]);
const RENDERED_PREFIXES = ["impression:", "click:", "host_index:"];

const leftovers = [...totals.keys()]
  .filter(
    (m) =>
      !RENDERED_EXACT.has(m) && !RENDERED_PREFIXES.some((p) => m.startsWith(p))
  )
  .sort();

if (leftovers.length > 0) {
  console.log("\nOther counters");
  for (const metric of leftovers) {
    console.log(`  ${metric.padEnd(24)}${String(get(metric)).padStart(6)}`);
  }
}

if (throttled > 0) {
  console.log(
    `\n⚠  ${throttled} click(s) were dropped by the rate limiter and are NOT in\n` +
      "   the numbers above, so every rate here is understated by that much.\n" +
      "   A party is a dozen phones behind one IP, so this is expected rather\n" +
      "   than hostile."
  );
}

/**
 * Upstream cache health — the other half of "can this keep running".
 *
 * The loop counters say whether the product spreads. These say whether it can
 * afford to. Every playlist miss is a call against Spotify's quota, which is
 * per *app* rather than per visitor, and every preview miss is up to five
 * against iTunes and Deezer, which throttle a serverless deploy's shared
 * egress IPs as one very noisy client. Neither budget grows with the audience.
 *
 * They are printed here for the reason in this file's header. On 2026-08-23
 * Spotify cut the whole app off for fourteen hours — `retry-after: 52531`,
 * `reason: QUOTA_EXCEEDED` — and the playlist hit rate had been sitting at 26%
 * for days beforehand, because a 6h TTL aged out faster than parties recur.
 * `getCacheStats()` had that number the entire time. Nothing called it, so the
 * first anyone knew was the outage.
 *
 * `negative` and `unavailable` are subsets of the columns above them, not
 * extra rows. A replayed 404 is a genuine hit — it answered without going
 * upstream, which is all the rate claims — and an `unavailable` is a genuine
 * miss. They are broken out because each is the case that makes a
 * healthy-looking number and an unhealthy situation read identically: a host
 * hammering a dead link pushes the hit rate *up*.
 *
 * Read by constructed key rather than by SCAN, which is the one place this
 * file departs from its own discovery rule — deliberately.
 *
 * `MATCH` is applied server-side but the scan still walks the whole instance,
 * and lib/preview-cache.ts holds one key per track for a year: 200k+ keys, so
 * a single namespace scan is ~200 REST round-trips. Two more of those on every
 * `npm run stats` would triple the command cost of the one report this project
 * asks people to run at the start of every session — on a KV plan where the
 * roster poll's backoff ladder already exists to protect the same budget.
 *
 * Discovery earns its cost above because loop surface names are open-ended
 * (lib/loop-links.ts adds them). These kinds are not: both are closed unions
 * in TypeScript — `"hit" | "miss" | "negative"` in lib/playlist-cache.ts and
 * `"hit" | "miss" | "unavailable"` in lib/preview-cache.ts — so mirroring them
 * is mirroring a compile-checked set, and widening one without adding it here
 * is the one drift this trades for two commands instead of four hundred.
 */
async function cacheTotals(namespace, kinds, buckets) {
  const wanted = buckets.flatMap((day) =>
    kinds.map((kind) => `${namespace}:stats:${day}:${kind}`)
  );
  const counts = await mgetAll(wanted);

  const byKind = new Map();
  wanted.forEach((key, i) => {
    const kind = key.split(":")[3];
    const count = Number(counts[i] ?? 0);
    if (!Number.isFinite(count)) return;
    byKind.set(kind, (byKind.get(kind) ?? 0) + count);
  });
  return byKind;
}

const caches = [
  { name: "playlist", upstream: "Spotify", subset: "negative", kinds: ["hit", "miss", "negative"] },
  { name: "preview", upstream: "iTunes/Deezer", subset: "unavailable", kinds: ["hit", "miss", "unavailable"] },
];

const windowDays = bucketsFor(days);
const cacheRows = [];
for (const cache of caches) {
  const byKind = await cacheTotals(cache.name, cache.kinds, windowDays);
  const hits = byKind.get("hit") ?? 0;
  const misses = byKind.get("miss") ?? 0;
  if (hits + misses === 0) continue;
  cacheRows.push({ ...cache, hits, misses, subset: byKind.get(cache.subset) ?? 0 });
}

if (cacheRows.length > 0) {
  // Header and rows share the widths so they cannot drift apart.
  const row = (a, b, c, d, e) =>
    `${a.padEnd(13)}${b.padEnd(15)}${c.padStart(8)}${d.padStart(10)}${e.padStart(9)}`;
  console.log("\nUpstream cache — every miss is a call somebody else meters");
  console.log(row("Cache", "upstream", "hits", "misses", "rate"));
  console.log("─".repeat(55));
  for (const c of cacheRows) {
    console.log(
      row(c.name, c.upstream, String(c.hits), String(c.misses), pct(c.hits, c.hits + c.misses).trim())
    );
  }
  for (const c of cacheRows) {
    if (c.subset === 0) continue;
    if (c.name === "playlist") {
      // Subtracted rather than merely reported: a host retrying a playlist
      // they made private is the one input that inflates this rate, and it
      // inflates it in exactly the situation you would want it to fall.
      console.log(
        `\n  playlist: ${c.subset} of those hits replayed a cached 404 — ` +
          `real rate ${pct(c.hits - c.subset, c.hits + c.misses).trim()}`
      );
    } else {
      // The distinction lib/preview-cache.ts is built around: `absent` is a
      // fact about the recording and lasts a week, `unavailable` is a fact
      // about us being throttled or out of budget and lasts 90 seconds.
      console.log(
        `  preview:  ${c.subset} of those misses were us, not the catalogue ` +
          "(throttled or out of budget)"
      );
    }
  }
}

console.log(
  "\nRead these as floors, not measurements:\n" +
    "  · Repeat hosts are undercounted — iOS clears localStorage after 7 days\n" +
    "    idle, which is exactly the gap between two parties.\n" +
    "  · Followed counts miss anyone whose click never reached the server.\n" +
    "  · A low number can mean the CTA does not work, or that we could not see\n" +
    "    that it did. Only the direction over time is trustworthy.\n" +
    "  · The cache table is the exception. Those counters are incremented on\n" +
    "    the server, on the path itself, so nothing can drop one — read them\n" +
    "    as the measurement the loop numbers are not.\n"
);
