import type { Metadata } from "next";

/**
 * The guides index — one entry per article under `/guides`.
 *
 * ## Why the metadata lives here and the prose does not
 *
 * Four things need to agree about every guide: the article route itself, the
 * `/guides` index that lists it, `app/sitemap.ts`, and the "read next" links at
 * the bottom of its siblings. Hand-syncing four copies is the failure mode
 * `lib/loop-links.ts` is shaped to avoid, and it fails quietly here too — a
 * guide missing from the sitemap is simply a page Google never comes back for,
 * with nothing on screen to say so.
 *
 * So the *metadata* is declared once, here, and everything derives from it. The
 * *body* stays as JSX in `app/guides/<slug>/page.tsx`, because prose with
 * links, tables and callouts in it is not data and pretending otherwise means
 * inventing a markup format to escape from. `tests/guides.test.ts` asserts
 * every slug in this list has a directory and vice versa, which is the join
 * these two halves would otherwise be missing.
 */

/** Grouping shown on the index page. Purely presentational. */
export type GuideCategory = "Playing" | "Hosting" | "Troubleshooting";

export interface Guide {
  /** URL segment. Also the directory name under `app/guides/`. */
  slug: string;
  /** The `<h1>` and the index card's title. */
  title: string;
  /** `<title>` and the index card's heading, when the h1 is too long for both. */
  navTitle: string;
  /** Meta description. One sentence, written for a search result. */
  description: string;
  /** The lede under the h1 on the article itself. */
  lede: string;
  category: GuideCategory;
  /** ISO date the article was published. Drives sitemap `lastModified`. */
  published: string;
  /** Rounded reading time in minutes, for the index card. */
  minutes: number;
  /** Slugs of two or three siblings, rendered as "read next". */
  related: string[];
}

export const GUIDES: Guide[] = [
  {
    slug: "how-to-host-a-music-quiz-night",
    title: "How to Host a Music Quiz Night That People Actually Enjoy",
    navTitle: "How to host a music quiz night",
    description:
      "A practical guide to running a music quiz for friends: how long a round should be, how to seat the room, what to do about the person who knows every song, and the five mistakes that flatten a good night.",
    lede: "Most music quizzes fail for reasons that have nothing to do with the music. Here is what actually decides whether the room stays in it.",
    category: "Hosting",
    published: "2026-08-21",
    minutes: 8,
    related: [
      "music-quiz-round-ideas",
      "music-quiz-scoring-rules",
      "best-playlists-for-a-guess-the-song-game",
    ],
  },
  {
    slug: "best-playlists-for-a-guess-the-song-game",
    title: "How to Pick a Playlist That Makes a Good Guessing Game",
    navTitle: "Picking a playlist that plays well",
    description:
      "Not every playlist works as a quiz. How to choose one by era, spread and recognisability — and why the playlist you love most is often the worst one to play.",
    lede: "A great playlist and a great quiz playlist are different objects. The difference is measurable, and you can check it before anyone sits down.",
    category: "Playing",
    published: "2026-08-21",
    minutes: 7,
    related: [
      "clip-length-and-difficulty",
      "guess-the-song-game-rules",
      "spotify-playlist-not-working",
    ],
  },
  {
    slug: "clip-length-and-difficulty",
    title: "Five Seconds or Thirty? How Clip Length Changes the Game",
    navTitle: "Clip length and difficulty",
    description:
      "Clip length is the difficulty dial in a guess the song game. What each setting does to the room, why the intro is the hardest part of a song, and how to pick a length for the group in front of you.",
    lede: "It is the only setting that changes the game rather than the content, and it is the one most hosts leave on the default.",
    category: "Playing",
    published: "2026-08-21",
    minutes: 6,
    related: [
      "music-quiz-scoring-rules",
      "guess-the-song-game-rules",
      "best-playlists-for-a-guess-the-song-game",
    ],
  },
  {
    slug: "music-quiz-scoring-rules",
    title: "Scoring a Music Quiz: Rules That Keep It Close",
    navTitle: "Scoring rules that keep it close",
    description:
      "Why 3 points for the title and 1 for the album, what a runaway leader does to a room, and five scoring variants — comeback rounds, steals, wagers — you can run without any extra equipment.",
    lede: "Scoring is not bookkeeping. It is the mechanism that decides whether the last third of the night is worth playing.",
    category: "Playing",
    published: "2026-08-21",
    minutes: 7,
    related: [
      "guess-the-song-game-rules",
      "how-to-host-a-music-quiz-night",
      "clip-length-and-difficulty",
    ],
  },
  {
    slug: "mixed-playlist-mode-guide",
    title: "Mixed Playlist Mode: When Everyone Brings Their Own Music",
    navTitle: "Mixed Playlist Mode explained",
    description:
      "How to run a round where every player submits their own playlist: the two ways to collect them, why guessing whose song it is beats guessing the title, and how to read the Taste Card at the end.",
    lede: "The best question a music game can ask is not “what is this song”. It is “who in this room put it on a playlist”.",
    category: "Playing",
    published: "2026-08-21",
    minutes: 7,
    related: [
      "music-quiz-for-large-groups",
      "music-quiz-scoring-rules",
      "party-games-for-small-groups",
    ],
  },
  {
    slug: "spotify-playlist-not-working",
    title: "Why Your Spotify Playlist Will Not Load, and How to Fix It",
    navTitle: "Playlist will not load",
    description:
      "Four causes account for nearly every playlist that fails to load in a Spotify-based game: editorial playlists, private playlists, the wrong kind of link, and rate limiting. How to tell them apart in seconds.",
    lede: "Almost every failed playlist is one of four things, and three of them you can fix without leaving the page.",
    category: "Troubleshooting",
    published: "2026-08-21",
    minutes: 7,
    related: [
      "songs-with-no-preview-clip",
      "why-spotify-previews-disappeared",
      "best-playlists-for-a-guess-the-song-game",
    ],
  },
  {
    slug: "why-spotify-previews-disappeared",
    title: "Spotify's Preview Clips Disappeared. Here Is What We Measured",
    navTitle: "Where the preview clips went",
    description:
      "In late 2024 Spotify stopped returning 30-second preview URLs to new API applications. What we measured, what broke, and how a music game finds clips now that the obvious source is gone.",
    lede: "Zero previews out of twenty tracks, across four markets. This is what a whole category of music apps quietly worked around.",
    category: "Troubleshooting",
    published: "2026-08-21",
    minutes: 8,
    related: [
      "songs-with-no-preview-clip",
      "music-quiz-licensing-and-previews",
      "spotify-playlist-not-working",
    ],
  },
  {
    slug: "party-games-for-small-groups",
    title: "Party Games for Small Groups Where Nobody Ends Up Sitting Out",
    navTitle: "Party games for small groups",
    description:
      "Games for four to twelve people, chosen by the one property that matters at that size: everyone stays in every round. Includes what to do when the group is too small, too loud, or does not know each other.",
    lede: "At four to twelve people, the failure mode is not boredom. It is elimination — the person knocked out first has nothing to do for forty minutes.",
    category: "Hosting",
    published: "2026-08-21",
    minutes: 7,
    related: [
      "music-quiz-for-large-groups",
      "how-to-host-a-music-quiz-night",
      "mixed-playlist-mode-guide",
    ],
  },
  {
    slug: "guess-the-song-game-rules",
    title: "Guess the Song: The Rules, and Nine Variants Worth Knowing",
    navTitle: "Guess the song: rules and variants",
    description:
      "The base rules of a guess the song game written out properly, nine variants that each change one thing about it, and the four house rules that stop the arguments before they start.",
    lede: "Every argument at a quiz night is really about one of three questions: who may answer, when, and what counts as an answer.",
    category: "Playing",
    published: "2026-08-30",
    minutes: 8,
    related: [
      "music-quiz-scoring-rules",
      "clip-length-and-difficulty",
      "music-quiz-round-ideas",
    ],
  },
  {
    slug: "music-quiz-round-ideas",
    title: "Twelve Music Quiz Rounds That Are Not “Name That Tune”",
    navTitle: "Music quiz round ideas",
    description:
      "Twelve rounds that need nothing but a playlist and a host, sorted by what they do to a room: what each one tests, who it lets win, and where it belongs in a running order.",
    lede: "A quiz made entirely of name-that-tune rounds is one round played eight times. It works for about twenty-five minutes.",
    category: "Hosting",
    published: "2026-08-30",
    minutes: 7,
    related: [
      "how-to-host-a-music-quiz-night",
      "guess-the-song-game-rules",
      "music-quiz-for-large-groups",
    ],
  },
  {
    slug: "music-quiz-over-video-call",
    title: "Running a Music Quiz Over Zoom, Meet or Discord",
    navTitle: "Music quiz over video call",
    description:
      "Why music sounds destroyed over a video call, the exact setting to enable on each platform, and the one rule of the in-person game that has to be thrown away because audio delay makes it meaningless.",
    lede: "A remote music quiz fails in a specific, predictable way, and it is almost never the quiz’s fault. It is the audio.",
    category: "Hosting",
    published: "2026-08-30",
    minutes: 6,
    related: [
      "how-to-host-a-music-quiz-night",
      "songs-with-no-preview-clip",
      "music-quiz-round-ideas",
    ],
  },
  {
    slug: "music-quiz-for-large-groups",
    title: "Running a Music Quiz for Twenty People or More",
    navTitle: "Music quiz for large groups",
    description:
      "A quiz built for eight does not scale to thirty by adding chairs. The three things that break at size, why teams fix all of them at once, and which rounds survive a crowd.",
    lede: "At twenty-five people the same six confident players take everything and the rest are an audience. That is structural, not a matter of trying harder.",
    category: "Hosting",
    published: "2026-08-30",
    minutes: 7,
    related: [
      "how-to-host-a-music-quiz-night",
      "party-games-for-small-groups",
      "music-quiz-scoring-rules",
    ],
  },
  {
    slug: "songs-with-no-preview-clip",
    title: "Why One Song Has No Clip When the Rest of the Playlist Does",
    navTitle: "When a song has no clip",
    description:
      "Five reasons a single track goes silent in a Spotify-based music game — remaster suffixes, differently credited artists, rotated URLs, catalogue gaps and throttling — and how to tell which one you are looking at.",
    lede: "Forty-nine songs play and one is silent. It looks like a bug, and it is usually a structural fact about where preview clips come from.",
    category: "Troubleshooting",
    published: "2026-08-30",
    minutes: 6,
    related: [
      "why-spotify-previews-disappeared",
      "spotify-playlist-not-working",
      "best-playlists-for-a-guess-the-song-game",
    ],
  },
  {
    slug: "music-quiz-licensing-and-previews",
    title: "Music Licensing and Quiz Nights: What Actually Applies",
    navTitle: "Licensing and quiz nights",
    description:
      "The three separate questions people collapse into one: whether it is a public performance, who already holds the licence, and what a thirty-second preview clip does and does not permit.",
    lede: "Nobody running a quiz in their living room needs this page. Anyone running one in a pub, a school or a hired hall probably does.",
    category: "Troubleshooting",
    published: "2026-08-30",
    minutes: 6,
    related: [
      "why-spotify-previews-disappeared",
      "music-quiz-over-video-call",
      "how-to-host-a-music-quiz-night",
    ],
  },
];

/** Lookup by slug. Returns undefined for an unknown one — callers 404. */
export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/**
 * Resolve a guide's `related` slugs to entries, dropping any that no longer
 * exist. A retired guide should cost its siblings a link, not a crash.
 */
export function relatedGuides(slug: string): Guide[] {
  const guide = getGuide(slug);
  if (!guide) return [];
  return guide.related
    .map((s) => getGuide(s))
    .filter((g): g is Guide => Boolean(g) && g!.slug !== slug);
}

/** The order the index page renders its groups in. */
export const GUIDE_CATEGORIES: GuideCategory[] = [
  "Playing",
  "Hosting",
  "Troubleshooting",
];

export function guidesByCategory(category: GuideCategory): Guide[] {
  return GUIDES.filter((g) => g.category === category);
}

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://www.guessong.app";

/**
 * Look a guide up, or throw.
 *
 * The route files call this with a slug written by us, in the same file as the
 * prose, so an unknown one is a typo that should fail the build — never a
 * visitor's blank <title> or a page rendered with holes in it. `getGuide` stays
 * the forgiving version for callers that legitimately might not find one (the
 * homepage teaser filters its picks).
 */
export function requireGuide(slug: string): Guide {
  const guide = getGuide(slug);
  if (!guide) {
    throw new Error(
      `Unknown guide slug "${slug}". Every article under app/guides/ needs a matching entry in lib/guides.ts.`
    );
  }
  return guide;
}

/**
 * Build a guide route's `metadata` export from the index.
 *
 * Lives here rather than beside the component that consumes it for the reason
 * `lib/song-count.ts` gives: the test suite only reaches `lib/`. This is pure
 * data derivation with no JSX in it, and it is the half worth pinning — the
 * half that decides what a search result says.
 */
export function guideMetadata(slug: string): Metadata {
  const guide = requireGuide(slug);
  const url = `${BASE_URL}/guides/${guide.slug}`;
  return {
    title: guide.navTitle,
    description: guide.description,
    alternates: { canonical: `/guides/${guide.slug}` },
    openGraph: {
      type: "article",
      url,
      title: guide.title,
      description: guide.description,
      publishedTime: guide.published,
    },
    twitter: {
      card: "summary_large_image",
      title: guide.title,
      description: guide.description,
    },
  };
}

/** Formats an ISO day the same way on the server and the client. */
export function formatGuideDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${day} ${months[month - 1]} ${year}`;
}
