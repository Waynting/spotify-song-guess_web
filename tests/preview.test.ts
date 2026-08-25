// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/preview/route";
import { POST } from "@/app/api/preview/batch/route";
import {
  clampPreviewField,
  PREVIEW_FIELD_MAX,
  type PreviewResult,
  type PreviewStatus,
} from "@/types/preview";

/**
 * Two things every test here is really about.
 *
 * Upstream call *count*, first: a cache that returns the right answer while
 * still hammering iTunes fixes nothing — the reason this cache exists is that
 * shared serverless egress IPs get throttled, and throttling surfaces as "this
 * song has no audio".
 *
 * And the difference between `absent` and `unavailable`, second. The route used
 * to write every failure down as `previewUrl: null` and cache it for a week, so
 * one throttled minute at peak marked a slice of the catalogue silent for seven
 * days. Any test below that asserts a status is guarding that distinction.
 */

const kv = vi.hoisted(() => {
  const mem = new Map<string, { value: unknown; expiresAt: number }>();
  const writes: Array<{ key: string; value: unknown; ttlSeconds: number }> = [];
  const flags = { failReads: false, failWrites: false };
  const counts = { mget: 0 };
  /** Every single-key read, in order — see the cooldown-memo test. */
  const reads: string[] = [];
  return { mem, writes, flags, counts, reads };
});

vi.mock("@/lib/kv", () => {
  const read = (key: string) => {
    if (kv.flags.failReads) throw new Error("kv unavailable");
    const entry = kv.mem.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.value;
  };
  return {
    getKvStore: async () => ({
      async get(key: string) {
        kv.reads.push(key);
        return read(key);
      },
      async mget(keys: string[]) {
        kv.counts.mget++;
        return keys.map(read);
      },
      async set(key: string, value: unknown, ttlSeconds: number) {
        if (kv.flags.failWrites) throw new Error("kv unavailable");
        kv.writes.push({ key, value, ttlSeconds });
        kv.mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      },
      async del(key: string) {
        kv.mem.delete(key);
      },
      // Rate limiting, the global budget and the stats counters all share this
      // store; keep incr working even when the cache paths are told to fail, so
      // a KV-outage test doesn't accidentally become a rate-limit test.
      async incr(key: string, ttlSeconds: number, by = 1) {
        const entry = kv.mem.get(key);
        const now = Date.now();
        if (!entry || now > entry.expiresAt) {
          kv.mem.set(key, { value: by, expiresAt: now + ttlSeconds * 1000 });
          return by;
        }
        const next = (entry.value as number) + by;
        kv.mem.set(key, { value: next, expiresAt: entry.expiresAt });
        return next;
      },
    }),
  };
});

const FOUND_TTL = 365 * 24 * 60 * 60;
const ABSENT_TTL = 7 * 24 * 60 * 60;
const UNAVAILABLE_TTL = 90;

const ITUNES_HIT = {
  results: [
    {
      previewUrl: "https://itunes.example/preview.m4a",
      trackId: 4242,
      trackName: "Song",
      artistName: "Artist",
    },
  ],
};
const ITUNES_REFRESHED = {
  results: [
    {
      previewUrl: "https://itunes.example/fresh.m4a",
      trackId: 4242,
      trackName: "Song",
      artistName: "Artist",
    },
  ],
};
const ITUNES_EMPTY = { results: [] };
const DEEZER_HIT = { data: [{ preview: "https://deezer.example/preview.mp3", id: 77 }] };
const DEEZER_EMPTY = { data: [] };
/** Deezer reports its quota limit in the body of a 200, not as a status. */
const DEEZER_QUOTA = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: boolean;
}

interface UpstreamBehaviour {
  itunes?: Reply;
  /** Defaults to `itunes` — the refresh path hits a different iTunes endpoint. */
  lookup?: Reply;
  deezer?: Reply;
  throwOnFetch?: boolean;
}

function installFetchMock(behaviour: UpstreamBehaviour = {}) {
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      calls.push(href);
      if (behaviour.throwOnFetch) throw new Error("network down");

      const reply: Reply = href.includes("itunes.apple.com/lookup")
        ? behaviour.lookup ?? behaviour.itunes ?? { body: ITUNES_EMPTY }
        : href.includes("itunes.apple.com")
          ? behaviour.itunes ?? { body: ITUNES_EMPTY }
          : behaviour.deezer ?? { body: DEEZER_EMPTY };

      if (reply.throws) throw new Error("network down");
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        headers: new Headers(reply.headers ?? {}),
        json: async (): Promise<unknown> => reply.body,
      };
    })
  );

  return {
    upstreamCalls: () => calls.length,
    itunesCalls: () => calls.filter((c) => c.includes("itunes.apple.com")).length,
    deezerCalls: () => calls.filter((c) => c.includes("deezer")).length,
    calls: () => calls,
  };
}

function request(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString();
  return new NextRequest(`http://127.0.0.1:8000/api/preview?${qs}`);
}

function batchRequest(tracks: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:8000/api/preview/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks }),
  });
}

async function resultOf(res: Response): Promise<PreviewResult> {
  return (await res.json()) as PreviewResult;
}

async function previewUrlFrom(res: Response): Promise<string | null> {
  return (await resultOf(res)).previewUrl ?? null;
}

async function statusOf(res: Response): Promise<PreviewStatus> {
  return (await resultOf(res)).status;
}

function writeFor(key: string) {
  return kv.writes.find((w) => w.key === key);
}

beforeEach(async () => {
  kv.mem.clear();
  kv.writes.length = 0;
  kv.flags.failReads = false;
  kv.flags.failWrites = false;
  kv.counts.mget = 0;
  kv.reads.length = 0;
  // The per-source cooldown is memoized in module scope, so a case that parks
  // iTunes would otherwise keep it parked for every case after it.
  const { __resetPreviewMemoForTests } = await import("@/lib/preview-cache");
  __resetPreviewMemoForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("preview lookup", () => {
  it("resolves from iTunes on a cold cache", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(await resultOf(res)).toEqual({
      previewUrl: "https://itunes.example/preview.m4a",
      status: "found",
    });
    expect(probe.upstreamCalls()).toBe(1);
  });

  it("falls back to Deezer when iTunes has nothing", async () => {
    const probe = installFetchMock({ deezer: { body: DEEZER_HIT } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp2" }));

    expect(await previewUrlFrom(res)).toBe("https://deezer.example/preview.mp3");
    // Both iTunes queries exhausted, then the first Deezer query hits.
    expect(probe.upstreamCalls()).toBe(3);
  });

  it("reports absent when both sources answer and neither has a preview", async () => {
    const probe = installFetchMock();

    const res = await GET(request({ track: "Nothing", artist: "Nobody", id: "sp3" }));

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
    // The full fan-out this cache exists to prevent: 2 iTunes + 3 Deezer.
    expect(probe.upstreamCalls()).toBe(5);
  });

  it("skips upstream entirely when no track name is supplied", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    const res = await GET(request({ artist: "Artist" }));

    expect(await previewUrlFrom(res)).toBeNull();
    expect(probe.upstreamCalls()).toBe(0);
  });
});

/**
 * Routes replies by search *term*, which installFetchMock cannot do — every
 * case below turns on the first query (artist included) and the second (title
 * only) being answered differently.
 */
function installTermMock(replies: {
  itunes?: Record<string, unknown>;
  deezer?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const termOf = (href: string) => {
    const params = new URL(href).searchParams;
    return params.get("term") ?? params.get("q") ?? "";
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      calls.push(href);
      const itunes = href.includes("itunes.apple.com");
      const body =
        (itunes ? replies.itunes : replies.deezer)?.[termOf(href)] ??
        (itunes ? ITUNES_EMPTY : DEEZER_EMPTY);
      return {
        ok: true,
        status: 200,
        statusText: "",
        headers: new Headers(),
        json: async (): Promise<unknown> => body,
      };
    })
  );

  const termsFor = (host: string) =>
    calls.filter((c) => c.includes(host)).map((c) => termOf(c));
  return {
    itunesTerms: () => termsFor("itunes.apple.com"),
    deezerTerms: () => termsFor("deezer"),
  };
}

interface FakeItunesTrack {
  trackName: string;
  artistName: string;
  previewUrl: string;
  /** iTunes' own field name. Left off to model a result with no running time. */
  trackTimeMillis?: number;
}

const itunesResults = (...tracks: FakeItunesTrack[]) => ({
  results: tracks.map((t, i) => ({ trackId: i + 1, ...t })),
});

const itunesResult = (trackName: string, artistName: string, previewUrl: string) =>
  itunesResults({ trackName, artistName, previewUrl });

/**
 * The title-only query is the one with no artist in it, so upstream ranks by
 * popularity alone and the top hit is simply the best-known song with that
 * title. Measured against the real iTunes API: "Hello" returns Pinkfong's
 * nursery rhyme, "Alone" returns Heart's 1987 single, "小幸運" returns a cover.
 *
 * Accepting one of those is worse than silence here. It is cached as `found`
 * for a year, the refresh path only repairs rotted URLs and never re-picks, and
 * at the table the clip plays and then the answer card contradicts it.
 */
describe("a wrong recording is never accepted for a right title", () => {
  it("rejects a title-only match by another artist and hands over to Deezer", async () => {
    const probe = installTermMock({
      itunes: {
        // Nothing under the full credit, so the title-only query runs...
        "Hello Adele": ITUNES_EMPTY,
        // ...and this is what it really comes back with.
        Hello: itunesResult("Hello", "Pinkfong", "https://itunes.example/pinkfong.m4a"),
      },
      deezer: {
        'track:"Hello" artist:"Adele"': {
          data: [
            {
              preview: "https://deezer.example/adele.mp3",
              id: 9,
              title: "Hello",
              artist: { name: "Adele" },
            },
          ],
        },
      },
    });

    const res = await GET(request({ track: "Hello", artist: "Adele", id: "artist-1" }));

    expect(await previewUrlFrom(res)).toBe("https://deezer.example/adele.mp3");
    expect(probe.itunesTerms()).toEqual(["Hello Adele", "Hello"]);
  });

  it("reports absent rather than playing the wrong artist from either source", async () => {
    installTermMock({
      itunes: { Alone: itunesResult("Alone", "Heart", "https://itunes.example/heart.m4a") },
      deezer: {
        Alone: {
          data: [
            {
              preview: "https://deezer.example/heart.mp3",
              id: 8,
              title: "Alone",
              artist: { name: "Heart" },
            },
          ],
        },
      },
    });

    const res = await GET(request({ track: "Alone", artist: "Marshmello", id: "artist-2" }));

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
  });

  it("still accepts a translated title when the artist is the one asked for", async () => {
    // Artist is weighed before title on purpose: iTunes returns 小幸運 as
    // "A Little Happiness", so a title mismatch is weak evidence of anything.
    installTermMock({
      itunes: {
        "小幸運 Hebe Tien": itunesResult(
          "A Little Happiness",
          "Hebe Tien",
          "https://itunes.example/hebe.m4a"
        ),
      },
    });

    const res = await GET(request({ track: "小幸運", artist: "Hebe Tien", id: "artist-3" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/hebe.m4a");
  });

  it("does not require the artist on the query that already carried it upstream", async () => {
    // The limit of string matching: Spotify's 田馥甄 is iTunes' "Hebe Tien" and
    // nothing bridges that. Filtering the artist-carrying query on it would
    // make every CJK track unplayable, which is why only the title-only query
    // is gated.
    installTermMock({
      itunes: {
        "小幸運 田馥甄": itunesResult(
          "A Little Happiness",
          "Hebe Tien",
          "https://itunes.example/hebe.m4a"
        ),
      },
    });

    const res = await GET(request({ track: "小幸運", artist: "田馥甄", id: "artist-4" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/hebe.m4a");
  });

  it("counts a featured credit as the same artist", async () => {
    installTermMock({
      itunes: {
        Alone: itunesResult(
          "Alone",
          "Marshmello & Noah Cyrus",
          "https://itunes.example/marshmello.m4a"
        ),
      },
    });

    const res = await GET(request({ track: "Alone", artist: "Marshmello", id: "artist-5" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/marshmello.m4a");
  });

  it("does not treat a name that merely starts the same as the same artist", async () => {
    // Containment on whole tokens only, or "Sia" swallows "Sian Evans".
    installTermMock({
      itunes: { Alone: itunesResult("Alone", "Sian Evans", "https://itunes.example/sian.m4a") },
    });

    const res = await GET(request({ track: "Alone", artist: "Sia", id: "artist-6" }));

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
  });

  it("asks iTunes once, not twice, when there is no artist to search with", async () => {
    // `${track} ${artist}`.trim() collapses to the bare title, so the old flat
    // query list spent a second upstream call re-asking an identical question.
    const probe = installTermMock({});

    const res = await GET(request({ track: "Song", id: "artist-7" }));

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
    expect(probe.itunesTerms()).toEqual(["Song"]);
    expect(probe.deezerTerms()).toEqual(["Song"]);
  });
});

/**
 * The two ways a candidate got tied to the request by a string that did not
 * actually name it, both measured against the live iTunes API.
 */
describe("a credit has to name the act, not merely contain it", () => {
  it("does not count a tribute act as the artist it is imitating", async () => {
    // "Hello Adele Tribute" is the second result the real API returns for
    // "Hello Adele". Whole-token containment read it as Adele, which put a
    // tribute recording in the *strongest* tier holding the exact title — and
    // the closest-drift tie-break then handed it the round.
    installTermMock({
      itunes: {
        "Hello Adele": itunesResults(
          {
            trackName: "Hello",
            artistName: "Hello Adele Tribute",
            previewUrl: "https://itunes.example/tribute.m4a",
            trackTimeMillis: 295502,
          },
          {
            trackName: "Hello",
            artistName: "Adele",
            previewUrl: "https://itunes.example/adele.m4a",
            trackTimeMillis: 296000,
          }
        ),
      },
    });

    const res = await GET(
      request({ track: "Hello", artist: "Adele", durationMs: "295502", id: "tribute-1" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/adele.m4a");
  });

  it("still counts a comma-billed collaborator as the same artist", async () => {
    // The guest credit the check has to keep letting through, in the separator
    // that is easiest to lose when containment is replaced by act matching.
    installTermMock({
      itunes: {
        "One Kiss Calvin Harris": itunesResult(
          "One Kiss",
          "Calvin Harris, Dua Lipa",
          "https://itunes.example/onekiss.m4a"
        ),
      },
    });

    const res = await GET(request({ track: "One Kiss", artist: "Calvin Harris", id: "credit-1" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/onekiss.m4a");
  });

  it("ignores a leading The, which the two platforms disagree about", async () => {
    installTermMock({
      itunes: {
        "Come Together Beatles": itunesResult(
          "Come Together",
          "The Beatles",
          "https://itunes.example/beatles.m4a"
        ),
      },
    });

    const res = await GET(request({ track: "Come Together", artist: "Beatles", id: "credit-2" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/beatles.m4a");
  });

  it("does not split an artist name on a separator letter of its own", async () => {
    // The word boundaries on the alphabetic separators, which are the whole
    // reason "x" is safe to treat as one. Drop them and "Charli XCX" becomes
    // ["charli", "c"], which a tribute credit is then a superset of — the exact
    // false positive this describe block exists to close, reintroduced.
    installTermMock({
      itunes: {
        "Boom Clap Charli XCX": itunesResults(
          {
            trackName: "Boom Clap",
            artistName: "Charli XCX Tribute",
            previewUrl: "https://itunes.example/trib.m4a",
            trackTimeMillis: 169000,
          },
          {
            trackName: "Boom Clap",
            artistName: "Charli XCX",
            previewUrl: "https://itunes.example/real.m4a",
            trackTimeMillis: 170000,
          }
        ),
      },
    });

    const res = await GET(
      request({ track: "Boom Clap", artist: "Charli XCX", durationMs: "169000", id: "sep-x" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/real.m4a");
  });

  it("counts a feat.-billed credit as the same artist", async () => {
    // Both candidates carry the title, so the credit is what decides rather
    // than the bare-title tier underneath it.
    installTermMock({
      itunes: {
        "Work Rihanna": itunesResults(
          {
            trackName: "Work",
            artistName: "Work Song Karaoke",
            previewUrl: "https://itunes.example/karaoke.m4a",
          },
          {
            trackName: "Work",
            artistName: "Rihanna feat. Drake",
            previewUrl: "https://itunes.example/work.m4a",
          }
        ),
      },
    });

    const res = await GET(request({ track: "Work", artist: "Rihanna", id: "sep-feat" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/work.m4a");
  });

  it("does not let a credit made only of separators match every artist", async () => {
    // Artists named "X" exist. It splits to nothing, and `[].every(...)` is
    // true — so without creditParts' fallback this candidate is billed as
    // whoever you asked for, and its better running time wins the top tier.
    installTermMock({
      itunes: {
        "Hello Adele": itunesResults(
          {
            trackName: "Hello",
            artistName: "X",
            previewUrl: "https://itunes.example/x.m4a",
            trackTimeMillis: 295502,
          },
          {
            trackName: "Hello",
            artistName: "Adele",
            previewUrl: "https://itunes.example/adele.m4a",
            trackTimeMillis: 296502,
          }
        ),
      },
    });

    const res = await GET(
      request({ track: "Hello", artist: "Adele", durationMs: "295502", id: "sep-empty" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/adele.m4a");
  });
});

describe("a qualifier one platform adds is not a different recording", () => {
  it("keeps a remaster with its own song instead of leaving it to the clock", async () => {
    // Spotify stores the remaster tag; iTunes returns the same recording under
    // the plain title. The exact comparison then matched nothing, the pick fell
    // through to the artist tier, and running time alone cannot tell a remaster
    // from the album track sitting next to it.
    installTermMock({
      itunes: {
        "Karma Police - Remastered 2011 Radiohead": itunesResults(
          {
            trackName: "Lucky",
            artistName: "Radiohead",
            previewUrl: "https://itunes.example/lucky.m4a",
            trackTimeMillis: 262500, // 500ms out — inside the window
          },
          {
            trackName: "Karma Police",
            artistName: "Radiohead",
            previewUrl: "https://itunes.example/karma.m4a",
            trackTimeMillis: 261000, // 2s out — further away, and the right song
          }
        ),
      },
    });

    const res = await GET(
      request({
        track: "Karma Police - Remastered 2011",
        artist: "Radiohead",
        durationMs: "263000",
        id: "loose-1",
      })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/karma.m4a");
  });

  it("strips a feat. parenthetical the other platform leaves off", async () => {
    // The higher-traffic of looseName's two passes: Spotify stores the credit
    // in the title where iTunes returns the plain one. The right answer carries
    // the *worse* running time, so the loose title is what elects it.
    installTermMock({
      itunes: {
        "Sunflower (feat. Swae Lee) Post Malone": itunesResults(
          {
            trackName: "Circles",
            artistName: "Post Malone",
            previewUrl: "https://itunes.example/circles.m4a",
            trackTimeMillis: 158100,
          },
          {
            trackName: "Sunflower",
            artistName: "Post Malone",
            previewUrl: "https://itunes.example/sunflower.m4a",
            trackTimeMillis: 155000,
          }
        ),
      },
    });

    const res = await GET(
      request({
        track: "Sunflower (feat. Swae Lee)",
        artist: "Post Malone",
        durationMs: "158000",
        id: "loose-feat",
      })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/sunflower.m4a");
  });

  it("strips only at a qualifier, never at the first hyphen in the title", async () => {
    // "Hip-Hop Is Dead (Remastered)" once stripped to "Hip", which then matched
    // any other Hip-something by the same artist — and because the loose tier
    // outranks the artist tier, that beat the candidate whose running time
    // agreed exactly. A wrong clip introduced by the fix for wrong clips.
    installTermMock({
      itunes: {
        "Hip-Hop Is Dead - Remastered Nas": itunesResults(
          {
            trackName: "Hip-Hop (Live)",
            artistName: "Nas",
            previewUrl: "https://itunes.example/hiphop-live.m4a",
            trackTimeMillis: 190000,
          },
          {
            trackName: "Hip-Hop Is Dead",
            artistName: "Nas",
            previewUrl: "https://itunes.example/hiphop-is-dead.m4a",
            trackTimeMillis: 240000,
          }
        ),
      },
    });

    const res = await GET(
      request({
        track: "Hip-Hop Is Dead - Remastered",
        artist: "Nas",
        durationMs: "240000",
        id: "loose-hyphen",
      })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/hiphop-is-dead.m4a");
  });

  it("does not match two titles that both strip to nothing", async () => {
    // looseName("(Live)") is "", and so is looseName("(Remastered)"). Without
    // the empty guard the remaster joins the loose tier and wins outright, a
    // hundred seconds of drift notwithstanding.
    installTermMock({
      itunes: {
        "(Live) Foo": itunesResults(
          {
            trackName: "(Remastered)",
            artistName: "Foo",
            previewUrl: "https://itunes.example/rem.m4a",
            trackTimeMillis: 100000,
          },
          {
            trackName: "Something Else",
            artistName: "Foo",
            previewUrl: "https://itunes.example/else.m4a",
            trackTimeMillis: 199900,
          }
        ),
      },
    });

    const res = await GET(
      request({ track: "(Live)", artist: "Foo", durationMs: "200000", id: "loose-empty" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/else.m4a");
  });
});

describe("an artist-less lookup still answers to something", () => {
  it("holds it to the clock, which is the only check it has left", async () => {
    // Nothing carried an artist upstream and nothing can check the answer
    // against one, so this query used to take whatever upstream ranked first —
    // and cache it as `found` for a year.
    installTermMock({
      itunes: {
        Hello: itunesResults({
          trackName: "Hello",
          artistName: "Pinkfong",
          previewUrl: "https://itunes.example/pinkfong.m4a",
          trackTimeMillis: 96000,
        }),
      },
    });

    const res = await GET(request({ track: "Hello", durationMs: "295502", id: "noartist-1" }));

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
  });

  it("resolves when the running time does agree", async () => {
    installTermMock({
      itunes: {
        Hello: itunesResults({
          trackName: "Hello",
          artistName: "Adele",
          previewUrl: "https://itunes.example/adele.m4a",
          trackTimeMillis: 295502,
        }),
      },
    });

    const res = await GET(request({ track: "Hello", durationMs: "295502", id: "noartist-2" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/adele.m4a");
  });

  it("still answers when no running time was sent either", async () => {
    // Nothing to verify against in either direction. Refusing here would
    // manufacture a week-long `absent` for a track that may well have a clip,
    // which is the more expensive of the two mistakes and the harder to see.
    installTermMock({
      itunes: { Hello: itunesResult("Hello", "Pinkfong", "https://itunes.example/pinkfong.m4a") },
    });

    const res = await GET(request({ track: "Hello", id: "noartist-3" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/pinkfong.m4a");
  });

  it("holds a Deezer answer to the clock too, not just an iTunes one", async () => {
    // Deezer is the last source before the answer settles as `absent` for a
    // week, and its arm of the artist-less query is a separate line of code.
    installTermMock({
      deezer: {
        Hello: {
          data: [
            {
              preview: "https://deezer.example/pinkfong.mp3",
              id: 1,
              title: "Hello",
              artist: { name: "Pinkfong" },
              duration: 96,
            },
          ],
        },
      },
    });

    const res = await GET(request({ track: "Hello", durationMs: "295502", id: "dz-noartist-1" }));

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
  });

  it("accepts a Deezer answer whose whole-second clock agrees", async () => {
    // Deezer reports seconds, so 295 against 295502ms is 502ms of quantisation
    // drift. Inside the tolerance, and it must not read as a mismatch.
    installTermMock({
      deezer: {
        Hello: {
          data: [
            {
              preview: "https://deezer.example/adele.mp3",
              id: 2,
              title: "Hello",
              artist: { name: "Adele" },
              duration: 295,
            },
          ],
        },
      },
    });

    const res = await GET(request({ track: "Hello", durationMs: "295502", id: "dz-noartist-2" }));

    expect(await previewUrlFrom(res)).toBe("https://deezer.example/adele.mp3");
  });
});

/**
 * lib/preview-cache.ts matches on these strings with regexes that are
 * super-linear on pathological input, and both routes take them straight off
 * the wire from an unauthenticated caller. enforceRateLimit fails open by
 * design, so it is not a second line of defence here.
 */
describe("a field the caller controls is clamped before it reaches a regex", () => {
  const pathological = "a" + " ".repeat(16000) + "b";

  it("caps a field at PREVIEW_FIELD_MAX", () => {
    expect(clampPreviewField("  " + "a".repeat(5000) + "  ")).toHaveLength(PREVIEW_FIELD_MAX);
  });

  it("clamps what the GET route sends upstream", async () => {
    const probe = installTermMock({});

    await GET(request({ track: pathological, artist: "Artist", id: "clamp-1" }));

    expect(probe.itunesTerms().length).toBeGreaterThan(0);
    for (const term of probe.itunesTerms()) {
      expect(term.length).toBeLessThanOrEqual(PREVIEW_FIELD_MAX * 2 + 1);
    }
  });

  it("does not cut a surrogate pair in half", async () => {
    // A lone high surrogate makes encodeURIComponent throw, and the throw is
    // inside the batch's Promise.all — one emoji on the boundary took all sixty
    // tracks down with it, as a bare 500.
    installTermMock({});

    const res = await POST(
      batchRequest([{ id: "clamp-3", name: "a".repeat(PREVIEW_FIELD_MAX - 1) + "😀", artist: "A" }])
    );

    expect(res.status).toBe(200);
  });

  it("clamps the batch route the same way, or one key holds two answers", async () => {
    const probe = installTermMock({});

    await POST(batchRequest([{ id: "clamp-2", name: pathological, artist: "Artist" }]));

    expect(probe.itunesTerms().length).toBeGreaterThan(0);
    for (const term of probe.itunesTerms()) {
      expect(term.length).toBeLessThanOrEqual(PREVIEW_FIELD_MAX * 2 + 1);
    }
  });
});

/**
 * The half of the problem artist matching cannot reach.
 *
 * A credit gets translated — iTunes returns 盧廣仲 as "Crowd Lu" — and a cover
 * shares the original's title by definition, so on a CJK track the only string
 * that lines up belongs to the wrong recording. Running time is translated by
 * nobody and agrees with Spotify to the millisecond, which is precisely what a
 * re-recording does not do.
 */
describe("running time separates a recording from its cover", () => {
  const ENGRAVED = () =>
    itunesResults(
      {
        trackName: "刻在我心底的名字",
        artistName: "佳其",
        previewUrl: "https://itunes.example/cover.m4a",
        trackTimeMillis: 268000,
      },
      {
        trackName: 'Your Name Engraved Herein',
        artistName: "Crowd Lu",
        previewUrl: "https://itunes.example/crowdlu.m4a",
        trackTimeMillis: 320166,
      }
    );

  it("takes the matching running time over a cover that shares the title", async () => {
    installTermMock({ itunes: { "刻在我心底的名字 盧廣仲": ENGRAVED() } });

    const res = await GET(
      request({
        track: "刻在我心底的名字",
        artist: "盧廣仲",
        durationMs: "320165",
        id: "dur-1",
      })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/crowdlu.m4a");
  });

  it("falls back to the title match when the caller sent no running time", async () => {
    // durationMs is optional on the wire, so a client older than this deploy
    // must still resolve — just less precisely, exactly as it did before.
    installTermMock({ itunes: { "刻在我心底的名字 盧廣仲": ENGRAVED() } });

    const res = await GET(request({ track: "刻在我心底的名字", artist: "盧廣仲", id: "dur-2" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/cover.m4a");
  });

  it("picks the closest when the artist has another song of nearly equal length", async () => {
    // Hebe Tien's Forever Love is 768ms from 小幸運 — inside the tolerance, so
    // the window alone decides nothing and the smallest drift has to win.
    installTermMock({
      itunes: {
        "小幸運 Hebe Tien": itunesResults(
          {
            trackName: "Forever Love",
            artistName: "Hebe Tien",
            previewUrl: "https://itunes.example/forever.m4a",
            trackTimeMillis: 266289,
          },
          {
            trackName: "A Little Happiness",
            artistName: "Hebe Tien",
            previewUrl: "https://itunes.example/happiness.m4a",
            trackTimeMillis: 265522,
          }
        ),
      },
    });

    const res = await GET(
      request({ track: "小幸運", artist: "Hebe Tien", durationMs: "265521", id: "dur-3" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/happiness.m4a");
  });

  it("lets a matching running time stand in for a credit it cannot verify", async () => {
    // The title-only query normally demands a verified artist. 星野源 comes back
    // as "Gen Hoshino", so the string never lines up — but 253333ms does, and
    // that is evidence of the same strength.
    installTermMock({
      itunes: {
        "恋 星野源": ITUNES_EMPTY,
        恋: itunesResults({
          trackName: "Koi",
          artistName: "Gen Hoshino",
          previewUrl: "https://itunes.example/koi.m4a",
          trackTimeMillis: 253333,
        }),
      },
    });

    const res = await GET(
      request({ track: "恋", artist: "星野源", durationMs: "253333", id: "dur-4" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/koi.m4a");
  });

  it("still rejects a title-only match whose running time disagrees", async () => {
    installTermMock({
      itunes: {
        "Hello Adele": ITUNES_EMPTY,
        Hello: itunesResults({
          trackName: "Hello",
          artistName: "Pinkfong",
          previewUrl: "https://itunes.example/pinkfong.m4a",
          trackTimeMillis: 96000,
        }),
      },
    });

    const res = await GET(
      request({ track: "Hello", artist: "Adele", durationMs: "295502", id: "dur-5" })
    );

    expect(await resultOf(res)).toEqual({ previewUrl: null, status: "absent" });
  });

  it("keeps an exact title outside the window over a sibling track inside it", async () => {
    // The ranking bug the tier list exists to prevent, and a real regression
    // against 1.1.0. A remaster sits further off Spotify's clock than a sibling
    // album track does, so ranking the clock above an artist+title match turned
    // a previously correct pick into a different song entirely.
    installTermMock({
      itunes: {
        "Karma Police Radiohead": itunesResults(
          {
            trackName: "Lucky",
            artistName: "Radiohead",
            previewUrl: "https://itunes.example/lucky.m4a",
            trackTimeMillis: 260500, // 500ms out — inside the window
          },
          {
            trackName: "Karma Police",
            artistName: "Radiohead",
            previewUrl: "https://itunes.example/karma.m4a",
            trackTimeMillis: 257000, // 3s out — outside it
          }
        ),
      },
    });

    const res = await GET(
      request({ track: "Karma Police", artist: "Radiohead", durationMs: "260000", id: "dur-6" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/karma.m4a");
  });

  it("treats the tolerance as inclusive, and rejects one millisecond past it", async () => {
    // Asserted on the title-only query, where a verified running time is the
    // only thing that can get a result accepted at all.
    const withDrift = (ms: number) =>
      installTermMock({
        itunes: {
          "Koi Gen Hoshino": ITUNES_EMPTY,
          Koi: itunesResults({
            trackName: "Koi",
            artistName: "星野源",
            previewUrl: "https://itunes.example/koi.m4a",
            trackTimeMillis: 253333 + ms,
          }),
        },
      });

    withDrift(2000);
    expect(
      await previewUrlFrom(
        await GET(request({ track: "Koi", artist: "Gen Hoshino", durationMs: "253333", id: "tol-1" }))
      )
    ).toBe("https://itunes.example/koi.m4a");

    withDrift(2001);
    expect(
      await resultOf(
        await GET(request({ track: "Koi", artist: "Gen Hoshino", durationMs: "253333", id: "tol-2" }))
      )
    ).toEqual({ previewUrl: null, status: "absent" });
  });

  it("matches a CJK credit with no separator to break on", async () => {
    // artistMatches falls back to a plain substring when either side is CJK,
    // because there are no spaces to anchor whole-token matching to. iTunes
    // does return concatenated billings like this, and the 48 bundled Mandarin
    // tracks are what depends on the branch. Asserted on the title-only query
    // so nothing but a verified credit can accept the result.
    installTermMock({
      itunes: {
        "千里之外 周杰倫": ITUNES_EMPTY,
        千里之外: itunesResults({
          trackName: "千里之外",
          artistName: "周杰倫Jay Chou",
          previewUrl: "https://itunes.example/jay.m4a",
        }),
      },
    });

    const res = await GET(request({ track: "千里之外", artist: "周杰倫", id: "cjk-1" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/jay.m4a");
  });

  it("reads Deezer's running time as seconds, not milliseconds", async () => {
    // Deezer reports whole seconds where iTunes reports milliseconds. Drop the
    // x1000 and every Deezer track silently loses its duration signal — the
    // suite stays green while translated credits fall through to a cover.
    installTermMock({
      deezer: {
        'track:"泡沫" artist:"鄧紫棋"': {
          data: [
            {
              preview: "https://deezer.example/cover.mp3",
              id: 1,
              title: "泡沫",
              artist: { name: "翻唱歌手" },
              duration: 210,
            },
            {
              preview: "https://deezer.example/gem.mp3",
              id: 2,
              title: "Bubble",
              artist: { name: "G.E.M." },
              duration: 259,
            },
          ],
        },
      },
    });

    const res = await GET(
      request({ track: "泡沫", artist: "鄧紫棋", durationMs: "258865", id: "dz-1" })
    );

    expect(await previewUrlFrom(res)).toBe("https://deezer.example/gem.mp3");
  });

  it("ignores a malformed running time rather than refusing the lookup", async () => {
    installTermMock({
      itunes: {
        "Song Artist": itunesResults({
          trackName: "Song",
          artistName: "Artist",
          previewUrl: "https://itunes.example/ok.m4a",
        }),
      },
    });

    for (const [i, bad] of ["abc", "-1", "0", "Infinity", ""].entries()) {
      const res = await GET(
        request({ track: "Song", artist: "Artist", durationMs: bad, id: `bad-${i}` })
      );
      expect(await previewUrlFrom(res), `durationMs=${bad}`).toBe("https://itunes.example/ok.m4a");
    }
  });
});

/**
 * The regression this module was extracted to fix. Each case is a way of being
 * refused that the old route recorded as a fact about the recording.
 */
describe("a refusal is never mistaken for a missing song", () => {
  it("does not cache a throttled iTunes as 'this song has no preview'", async () => {
    // 403, not 429 — that is how iTunes says no. Reading only 429 leaves the
    // refusal to fall through as an empty result set.
    const probe = installFetchMock({ itunes: { status: 403 }, deezer: { body: DEEZER_EMPTY } });

    const first = await GET(request({ track: "Song", artist: "Artist", id: "hot" }));
    expect(await statusOf(first)).toBe("unavailable");

    const entry = writeFor("preview:id:hot");
    expect(entry?.value).toMatchObject({ previewUrl: null, confirmed: false });
    // Ninety seconds, not seven days. This is the whole bug in one number.
    expect(entry?.ttlSeconds).toBe(UNAVAILABLE_TTL);
  });

  it("re-asks once the short-lived refusal has expired, and then finds the song", async () => {
    vi.useFakeTimers();
    try {
      installFetchMock({ itunes: { status: 403 } });
      await GET(request({ track: "Song", artist: "Artist", id: "hot" }));

      vi.advanceTimersByTime((UNAVAILABLE_TTL + 1) * 1000);
      vi.unstubAllGlobals();
      // Past the cooldown too, so iTunes is asked again rather than skipped.
      const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

      const res = await GET(request({ track: "Song", artist: "Artist", id: "hot" }));
      expect(await previewUrlFrom(res)).toBe("https://itunes.example/preview.m4a");
      expect(probe.itunesCalls()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a dropped connection as unavailable, not as an answer", async () => {
    installFetchMock({ throwOnFetch: true });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp4" }));

    expect(res.status).toBe(200);
    expect(await statusOf(res)).toBe("unavailable");
    expect(writeFor("preview:id:sp4")?.ttlSeconds).toBe(UNAVAILABLE_TTL);
  });

  it("reads Deezer's quota error out of the body of a 200", async () => {
    // Deezer answers a spent quota with HTTP 200 and an `error` object, so a
    // status-only check reads "quota exceeded" as "no such song".
    installFetchMock({ deezer: { body: DEEZER_QUOTA } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "dz" }));

    expect(await statusOf(res)).toBe("unavailable");
  });

  it("treats a 5xx as unavailable rather than as an empty catalogue", async () => {
    installFetchMock({ itunes: { status: 503 }, deezer: { status: 500 } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "down" }));

    expect(await statusOf(res)).toBe("unavailable");
  });

  it("still says absent when a source answers cleanly with an empty result set", async () => {
    // The other half of the contract: this one *is* evidence, and caching it
    // for a week is the point of caching misses at all.
    installFetchMock();

    const res = await GET(request({ track: "Nothing", artist: "Nobody", id: "gone" }));

    expect(await statusOf(res)).toBe("absent");
    expect(writeFor("preview:id:gone")?.ttlSeconds).toBe(ABSENT_TTL);
  });

  it("stops asking a source that just refused, instead of spending a second call", async () => {
    const probe = installFetchMock({ itunes: { status: 429 }, deezer: { body: DEEZER_HIT } });

    await GET(request({ track: "Song", artist: "Artist", id: "one-shot" }));

    // One iTunes query, not two: a second against a host that just said no
    // buys another no.
    expect(probe.itunesCalls()).toBe(1);
  });
});

describe("per-source cooldown", () => {
  it("parks iTunes site-wide after it throttles us, and asks Deezer alone", async () => {
    installFetchMock({ itunes: { status: 403 }, deezer: { body: DEEZER_EMPTY } });
    await GET(request({ track: "Song", artist: "Artist", id: "a" }));

    vi.unstubAllGlobals();
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT }, deezer: { body: DEEZER_HIT } });
    const res = await GET(request({ track: "Song", artist: "Artist", id: "b" }));

    // iTunes is skipped entirely — the saving is the call we never make.
    expect(probe.itunesCalls()).toBe(0);
    expect(await previewUrlFrom(res)).toBe("https://deezer.example/preview.mp3");
  });

  it("honours Retry-After, clamped to a sane floor", async () => {
    installFetchMock({ itunes: { status: 429, headers: { "retry-after": "600" } } });
    await GET(request({ track: "Song", artist: "Artist", id: "a" }));

    expect(writeFor("preview:cooldown:itunes")?.ttlSeconds).toBe(600);
  });

  it("asks KV about a cooldown once per source, not once per track", async () => {
    // The cooldown is a site-wide, minute-scale signal, and it used to be read
    // per source *per track* — a cold 25-song game spent 50 KV reads learning
    // the same two answers, more commands than the batch's own writes. There is
    // nothing on screen to notice if this regresses; Upstash's monthly bill is
    // the only symptom, which is why it is pinned here.
    installFetchMock({ itunes: { body: ITUNES_EMPTY }, deezer: { body: DEEZER_EMPTY } });

    const tracks = Array.from({ length: 8 }, (_, n) => ({
      id: `cool${n}`,
      name: `Song ${n}`,
      artist: "Artist",
    }));
    await POST(batchRequest(tracks));

    const cooldownReads = kv.reads.filter((k) => k.startsWith("preview:cooldown:"));
    expect(cooldownReads).toHaveLength(2); // one iTunes, one Deezer
  });

  it("does not park a source over a dropped connection", async () => {
    // One flaky socket is not a rate limit, and parking iTunes for everyone
    // over it would turn a blip into a site-wide outage of the better source.
    installFetchMock({ throwOnFetch: true });
    await GET(request({ track: "Song", artist: "Artist", id: "a" }));

    expect(writeFor("preview:cooldown:itunes")).toBeUndefined();
    expect(writeFor("preview:cooldown:deezer")).toBeUndefined();
  });
});

describe("the global lookup budget", () => {
  it("refuses a cold lookup without touching upstream once the minute is spent", async () => {
    vi.stubEnv("PREVIEW_MAX_LOOKUPS_PER_MINUTE", "2");
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    await GET(request({ track: "A", artist: "Artist", id: "1" }));
    await GET(request({ track: "B", artist: "Artist", id: "2" }));
    const spent = probe.upstreamCalls();

    const res = await GET(request({ track: "C", artist: "Artist", id: "3" }));

    expect(await statusOf(res)).toBe("unavailable");
    expect(probe.upstreamCalls()).toBe(spent);
    // Not cached: the budget claim is already cheap and self-limiting, and a
    // marker per track would spend a KV write during the exact spike we are
    // trying to ride out.
    expect(writeFor("preview:id:3")).toBeUndefined();
  });

  it("still serves cached tracks while the budget is spent", async () => {
    vi.stubEnv("PREVIEW_MAX_LOOKUPS_PER_MINUTE", "1");
    installFetchMock({ itunes: { body: ITUNES_HIT } });

    await GET(request({ track: "A", artist: "Artist", id: "1" }));
    const res = await GET(request({ track: "A", artist: "Artist", id: "1" }));

    // A party mid-game is unaffected by someone else's spike.
    expect(await statusOf(res)).toBe("found");
  });

  it("fails open when KV is unreachable", async () => {
    // Losing the safety net has to mean "back to how it was", not "nobody
    // hears any music".
    kv.flags.failReads = true;
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(await statusOf(res)).toBe("found");
    expect(probe.upstreamCalls()).toBeGreaterThan(0);
  });
});

describe("preview cache", () => {
  it("serves a repeat hit with zero upstream calls", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));
    const callsAfterFirst = probe.upstreamCalls();
    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/preview.m4a");
    expect(probe.upstreamCalls()).toBe(callsAfterFirst);
  });

  it("caches confirmed misses too, so a track with no preview stops costing 5 calls", async () => {
    // Tracks that genuinely have no preview anywhere are the ones queried most
    // repeatedly; without a negative entry each replay burns the full fan-out.
    const probe = installFetchMock();

    await GET(request({ track: "Nothing", artist: "Nobody", id: "sp3" }));
    expect(probe.upstreamCalls()).toBe(5);

    const res = await GET(request({ track: "Nothing", artist: "Nobody", id: "sp3" }));

    expect(await statusOf(res)).toBe("absent");
    expect(probe.upstreamCalls()).toBe(5);
  });

  it("holds found URLs far longer than misses, and refusals barely at all", async () => {
    installFetchMock({ itunes: { body: ITUNES_HIT } });
    await GET(request({ track: "Song", artist: "Artist", id: "hit" }));

    vi.unstubAllGlobals();
    installFetchMock();
    await GET(request({ track: "Nothing", artist: "Nobody", id: "miss" }));

    // A recording does not change. URL rot is repaired by refresh, not waited
    // out — which is what lets this be a year rather than a month.
    expect(writeFor("preview:id:hit")?.ttlSeconds).toBe(FOUND_TTL);
    expect(writeFor("preview:id:miss")?.ttlSeconds).toBe(ABSENT_TTL);
  });

  it("stores the iTunes track id, so a rotted URL can be repaired cheaply", async () => {
    installFetchMock({ itunes: { body: ITUNES_HIT } });

    await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(writeFor("preview:id:sp1")?.value).toMatchObject({
      source: "itunes",
      itunesTrackId: 4242,
    });
  });

  it("keys on track id, so the same name under a different id is a separate entry", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    await GET(request({ track: "Song", artist: "Artist", id: "sp-a" }));
    const afterFirst = probe.upstreamCalls();
    await GET(request({ track: "Song", artist: "Artist", id: "sp-b" }));

    expect(probe.upstreamCalls()).toBeGreaterThan(afterFirst);
    expect(kv.writes.map((w) => w.key)).toEqual(["preview:id:sp-a", "preview:id:sp-b"]);
  });

  it("still caches when the caller sends no id, keyed on a normalised query", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    await GET(request({ track: "  Song  ", artist: "Artist" }));
    const afterFirst = probe.upstreamCalls();
    // Different whitespace and casing must land on the same key.
    const res = await GET(request({ track: "SONG", artist: "artist" }));

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/preview.m4a");
    expect(probe.upstreamCalls()).toBe(afterFirst);
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0].key).toBe("preview:q:song|artist");
  });

  it("reads entries written before this shape existed", async () => {
    // Production is full of bare `{previewUrl}` records and the key was left
    // unversioned on purpose: bumping it would cold-start every entry at once,
    // which is precisely the upstream burst this module exists to prevent.
    //
    // The cost is that 1.2.0's picker fix does not reach them — a URL chosen by
    // the old picker keeps being served for up to a year. Upgrading them needs
    // a generation stamp on the record, which is deliberately not in this
    // release; see CHANGELOG 1.2.0 "Known gaps" for why the mechanism is harder
    // than it looks.
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });
    kv.mem.set("preview:id:old-hit", {
      value: { previewUrl: "https://legacy.example/clip.m4a" },
      expiresAt: Date.now() + 60_000,
    });
    kv.mem.set("preview:id:old-miss", {
      value: { previewUrl: null },
      expiresAt: Date.now() + 60_000,
    });

    const hit = await GET(request({ track: "Song", artist: "Artist", id: "old-hit" }));
    const miss = await GET(request({ track: "Song", artist: "Artist", id: "old-miss" }));

    expect(await resultOf(hit)).toEqual({
      previewUrl: "https://legacy.example/clip.m4a",
      status: "found",
    });
    // A legacy null has no `confirmed` flag and is read as settled. Some of
    // them are poisoned by the old bug, but re-resolving every one of them at
    // once is the same stampede that poisoned them — they age out within a week.
    expect(await statusOf(miss)).toBe("absent");
    expect(probe.upstreamCalls()).toBe(0);
  });
});

describe("refresh", () => {
  it("repairs a rotted URL with one lookup instead of a full search", async () => {
    installFetchMock({ itunes: { body: ITUNES_HIT } });
    await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    vi.unstubAllGlobals();
    const probe = installFetchMock({ lookup: { body: ITUNES_REFRESHED } });
    const res = await GET(
      request({ track: "Song", artist: "Artist", id: "sp1", refresh: "1" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/fresh.m4a");
    expect(probe.upstreamCalls()).toBe(1);
    expect(probe.calls()[0]).toContain("/lookup?id=4242");
  });

  it("falls back to a full search when the stored id no longer resolves", async () => {
    installFetchMock({ itunes: { body: ITUNES_HIT } });
    await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    vi.unstubAllGlobals();
    // The id was retired from the store; a search can still route around it.
    const probe = installFetchMock({
      lookup: { body: ITUNES_EMPTY },
      itunes: { body: ITUNES_REFRESHED },
    });
    const res = await GET(
      request({ track: "Song", artist: "Artist", id: "sp1", refresh: "1" })
    );

    expect(await previewUrlFrom(res)).toBe("https://itunes.example/fresh.m4a");
    expect(probe.upstreamCalls()).toBeGreaterThan(1);
  });

  it("has its own, much tighter rate limit bucket", async () => {
    // It bypasses the cache by design, so it is the one parameter here that
    // can be turned into an upstream amplifier.
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });
    kv.mem.set("ratelimit:preview:refresh:unknown", {
      value: 100_000,
      expiresAt: Date.now() + 600_000,
    });

    const refused = await GET(
      request({ track: "Song", artist: "Artist", id: "sp1", refresh: "1" })
    );
    expect(refused.status).toBe(429);

    // The ordinary read path is untouched by a spent refresh budget.
    const ok = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));
    expect(ok.status).toBe(200);
    expect(probe.upstreamCalls()).toBeGreaterThan(0);
  });
});

describe("preview cache failure modes", () => {
  it("degrades to upstream when the cache read throws", async () => {
    kv.flags.failReads = true;
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(res.status).toBe(200);
    expect(await previewUrlFrom(res)).toBe("https://itunes.example/preview.m4a");
    expect(probe.upstreamCalls()).toBeGreaterThan(0);
  });

  it("still answers when the cache write throws", async () => {
    // An unhandled write failure would turn a request that already has its
    // answer into a 500 and stall the round.
    kv.flags.failWrites = true;
    installFetchMock({ itunes: { body: ITUNES_HIT } });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(res.status).toBe(200);
    expect(await previewUrlFrom(res)).toBe("https://itunes.example/preview.m4a");
  });
});

describe("preview rate limiting", () => {
  it("returns 429 once the window is spent, without touching upstream", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });
    // getClientIp falls back to "unknown" when no proxy headers are present.
    kv.mem.set("ratelimit:preview:unknown", {
      value: 100_000,
      expiresAt: Date.now() + 600_000,
    });

    const res = await GET(request({ track: "Song", artist: "Artist", id: "sp1" }));

    expect(res.status).toBe(429);
    expect(probe.upstreamCalls()).toBe(0);
  });
});

describe("batch lookups", () => {
  const track = (n: number) => ({ id: `sp${n}`, name: `Song ${n}`, artist: "Artist" });

  async function previewsFrom(res: Response): Promise<Record<string, PreviewResult>> {
    const body = (await res.json()) as { previews: Record<string, PreviewResult> };
    return body.previews;
  }

  it("threads each track's running time through to the pick", async () => {
    // The game page's primary path is one batch for the whole game, so if the
    // wire drops durationMs here every party silently falls back to matching on
    // names alone — which is what puts a cover on the answer card.
    installTermMock({
      itunes: {
        "刻在我心底的名字 盧廣仲": itunesResults(
          {
            trackName: "刻在我心底的名字",
            artistName: "佳其",
            previewUrl: "https://itunes.example/cover.m4a",
            trackTimeMillis: 268000,
          },
          {
            trackName: "Your Name Engraved Herein",
            artistName: "Crowd Lu",
            previewUrl: "https://itunes.example/crowdlu.m4a",
            trackTimeMillis: 320166,
          }
        ),
      },
    });

    const res = await POST(
      batchRequest([
        { id: "b1", name: "刻在我心底的名字", artist: "盧廣仲", durationMs: 320165 },
      ])
    );

    // Without the duration the exact title wins and this is the cover.
    expect((await previewsFrom(res)).b1.previewUrl).toBe("https://itunes.example/crowdlu.m4a");
  });

  it("drops a malformed running time instead of refusing the whole batch", async () => {
    // Unlike id and name, a bad duration only costs precision. Refusing the
    // batch over it would take every well-formed track down with it.
    installTermMock({
      itunes: {
        "Song 1 Artist": itunesResults({
          trackName: "Song 1",
          artistName: "Artist",
          previewUrl: "https://itunes.example/ok.m4a",
        }),
      },
    });

    const res = await POST(
      batchRequest([{ id: "sp1", name: "Song 1", artist: "Artist", durationMs: "not-a-number" }])
    );

    expect(res.status).toBe(200);
    expect((await previewsFrom(res)).sp1.previewUrl).toBe("https://itunes.example/ok.m4a");
  });

  it("reads the whole game with a single mget", async () => {
    // The reason this route exists is the KV bill: one command for fifty
    // tracks rather than fifty. Reading them one at a time still works — it
    // just costs 50x on the one quota this app actually pays for.
    installFetchMock({ itunes: { body: ITUNES_HIT } });

    const res = await POST(batchRequest([track(1), track(2), track(3)]));

    expect(res.status).toBe(200);
    expect(kv.counts.mget).toBe(1);
    expect(Object.keys(await previewsFrom(res))).toEqual(["sp1", "sp2", "sp3"]);
  });

  it("answers a warm cache with no upstream calls at all", async () => {
    installFetchMock({ itunes: { body: ITUNES_HIT } });
    await POST(batchRequest([track(1), track(2)]));

    vi.unstubAllGlobals();
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });
    const res = await POST(batchRequest([track(1), track(2)]));

    expect(probe.upstreamCalls()).toBe(0);
    expect((await previewsFrom(res)).sp1.previewUrl).toBe("https://itunes.example/preview.m4a");
  });

  it("reports each track's own status rather than one verdict for the batch", async () => {
    // A game is a mix: some tracks resolve, some genuinely have no clip. One
    // status for the request would make the second look like the first.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        const hit = href.includes("Song%201");
        return {
          ok: true,
          status: 200,
          statusText: "",
          headers: new Headers(),
          json: async () =>
            href.includes("itunes")
              ? hit
                ? ITUNES_HIT
                : ITUNES_EMPTY
              : DEEZER_EMPTY,
        };
      })
    );

    const previews = await previewsFrom(await POST(batchRequest([track(1), track(2)])));

    expect(previews.sp1.status).toBe("found");
    expect(previews.sp2.status).toBe("absent");
  });

  it("defers the tail of an oversized game instead of eating the global budget", async () => {
    // 25 resolved, the rest handed back as unavailable so the per-track path
    // picks them up lazily — one cold 50-song start must not starve every
    // other party on the site.
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });
    const tracks = Array.from({ length: 30 }, (_, i) => track(i));

    const previews = await previewsFrom(await POST(batchRequest(tracks)));

    expect(probe.upstreamCalls()).toBe(25);
    const deferred = Object.values(previews).filter((p) => p.status === "unavailable");
    expect(deferred).toHaveLength(5);
    // Deferred tracks are not written to KV: nothing refused them, and a
    // marker would suppress the lazy lookup meant to pick them up.
    expect(kv.writes.filter((w) => w.ttlSeconds === UNAVAILABLE_TTL)).toHaveLength(0);
  });

  it("defers everything when the global budget can't cover the batch", async () => {
    vi.stubEnv("PREVIEW_MAX_LOOKUPS_PER_MINUTE", "2");
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });

    const previews = await previewsFrom(await POST(batchRequest([track(1), track(2), track(3)])));

    // All-or-nothing, so a game defers cleanly rather than stopping halfway
    // through its own playlist.
    expect(probe.upstreamCalls()).toBe(0);
    expect(Object.values(previews).every((p) => p.status === "unavailable")).toBe(true);
  });

  it("refuses a malformed or oversized body with a code, not a bare 400", async () => {
    installFetchMock();

    for (const body of [
      [],
      [{ name: "No id" }],
      [{ id: "sp1" }],
      Array.from({ length: 61 }, (_, i) => track(i)),
    ]) {
      const res = await POST(batchRequest(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("preview_request_invalid");
    }
  });

  it("returns 429 once the window is spent, without touching upstream", async () => {
    const probe = installFetchMock({ itunes: { body: ITUNES_HIT } });
    kv.mem.set("ratelimit:preview:batch:unknown", {
      value: 100_000,
      expiresAt: Date.now() + 600_000,
    });

    const res = await POST(batchRequest([track(1)]));

    expect(res.status).toBe(429);
    expect(probe.upstreamCalls()).toBe(0);
  });
});
