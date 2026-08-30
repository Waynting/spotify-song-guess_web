import type { Metadata } from "next";
import { GuideShell, guideMetadata } from "@/app/guides/guide-shell";

const SLUG = "guess-the-song-game-rules";

export const metadata: Metadata = guideMetadata(SLUG);

export default function Page() {
  return (
    <GuideShell slug={SLUG}>
      <p>
        “Guess the song” is not one game. It is a family of games that share a clip of
        music and disagree about everything else — who is allowed to answer, when they are
        allowed to answer, and what counts as having answered. Most arguments at a quiz
        night are not about music. They are about one of those three questions, asked for
        the first time in the middle of a round.
      </p>
      <p>
        So here is the base game written out properly, then the nine variants worth
        knowing, then the four house rules that stop the arguments before they start.
      </p>

      <h2>The base game</h2>
      <p>
        One person hosts and does not play. Everyone else sits where they can hear. The
        host plays a short clip from a random song — five to thirty seconds, chosen in
        advance — and the room shouts the title. First correct answer takes the points.
        The host is the judge and the judge is final.
      </p>
      <p>That is genuinely all of it. The scoring most groups converge on:</p>
      <ul>
        <li>
          <strong>3 points for the title.</strong> This is the game. It should be worth
          enough that nothing else can overtake it.
        </li>
        <li>
          <strong>1 point for the album.</strong> A bonus for the person who knows the
          record rather than the single. Awarded on top of the title point, to whoever
          says it first — not necessarily the same person.
        </li>
        <li>
          <strong>Nothing for the artist.</strong> Counter-intuitive, and the single most
          common house-rule addition. It is worth resisting: the artist is usually easier
          than the title, so paying for it rewards the guess people were going to make
          anyway and slows the round down while everyone lists names.
        </li>
      </ul>
      <p>
        More on why those particular numbers, and what happens to a room when they are
        wrong, in{" "}
        <a href="/guides/music-quiz-scoring-rules">scoring a music quiz</a>.
      </p>

      <h2>Why shouting beats typing</h2>
      <p>
        Almost every digital version of this game asks players to type the answer. It is
        the obvious design and it is worse than shouting, for three reasons that only show
        up once real people are playing.
      </p>
      <p>
        Typing turns a social game into fourteen people looking at their own phones.
        Autocorrect converts near-misses into wrong answers and correct answers into
        nonsense. And exact string matching cannot tell that “Bohemian Rhapsody”,
        “bohemian rapsody” and “the Bohemian Rhapsody one” are the same answer, so the
        game either rejects people who knew it or accepts people who did not.
      </p>
      <p>
        A human host resolves all three instantly and for free. The cost is that you need
        a host, which is why the base game has one.
      </p>

      <h2>Nine variants</h2>
      <p>
        Each of these changes exactly one of the three questions — who answers, when, or
        what counts. Mixing two at once usually produces a mess, so introduce them one at
        a time.
      </p>

      <h3>1. Buzzers</h3>
      <p>
        Instead of shouting, players buzz and the first buzz gets the floor. Fixes the
        chronic problem of the base game: in a loud room, the loudest voice wins ties, and
        the loudest voice is a personality trait rather than a skill. Costs you the
        overlapping chaos that makes shouting fun. Best for competitive groups and for any
        game where the result is meant to be taken seriously.
      </p>

      <h3>2. Written rounds</h3>
      <p>
        Everyone writes their answer down and they are all revealed at the end of the
        round. Nobody is knocked out by being slow, so a room of very unequal knowledge
        stays engaged. It is also the only variant that works reliably over a{" "}
        <a href="/guides/music-quiz-over-video-call">video call</a>, where audio delay
        makes “first to answer” meaningless. Slower, and much less loud.
      </p>

      <h3>3. Teams</h3>
      <p>
        Two to five people per team, one nominated shouter. Halves the number of
        answering units, which is what makes a large room workable at all — see{" "}
        <a href="/guides/music-quiz-for-large-groups">running a quiz for twenty people or
        more</a>. Also quietly solves the confidence problem: people who would never shout
        alone will happily tell their team.
      </p>

      <h3>4. Finish the lyric</h3>
      <p>
        The host stops the clip mid-line and the room completes it. Tests a completely
        different kind of knowledge from title recall — people who are bad at names are
        often excellent at this — so it is the best single round to add if one player
        keeps winning everything.
      </p>

      <h3>5. Speed round</h3>
      <p>
        Very short clips, no album points, no discussion, next song the instant someone is
        right or five seconds pass. Run six or eight of these back to back as a finale.
        The point is not difficulty, it is tempo: it makes the end of the night feel
        different from the middle of it.
      </p>

      <h3>6. Whose playlist is it?</h3>
      <p>
        Every player submits their own music, the pool is shuffled together, and the
        question becomes “who in this room put this on a playlist”. The best variant in
        the family, because the answer is about the people in the room rather than about
        pop music, so knowing less music costs you almost nothing.{" "}
        <a href="/guides/mixed-playlist-mode-guide">How to run it, and how to read the
        results.</a>
      </p>

      <h3>7. Humming and a cappella</h3>
      <p>
        No recording at all: one player hums or sings a song and the rest guess.
        Requires nothing, works in a car, and is the only variant on this list that
        survives a dead phone battery. Also much harder than it sounds — most people
        cannot hum a song they know perfectly well.
      </p>

      <h3>8. Song association</h3>
      <p>
        The host says a word and players take turns singing a line containing it. No
        repeats, no hesitating; last person still going wins. Barely a quiz, closer to a
        party game, and unusually good with a group where some people know nothing about
        current music — everyone has a few hundred song lines in them.
      </p>

      <h3>9. Blind decade</h3>
      <p>
        Nobody names the song. Everyone writes down the year, or the decade, and the
        closest guess scores. Turns unfamiliar music into a playable round, which means
        you can finally use the playlist nobody in the room knows.
      </p>

      <div className="callout">
        <p className="callout-title">Adding a variant mid-game</p>
        <p>
          Announce it before the clip, not after. A rule introduced after a song has
          played is a rule that changes who won that song, and the room will notice even
          if nobody says anything.
        </p>
      </div>

      <h2>The four house rules worth deciding in advance</h2>
      <p>
        These are the actual sources of every argument. Deciding them takes thirty seconds
        at the start and saves you the same conversation four times.
      </p>
      <ol>
        <li>
          <strong>Partial titles.</strong> Does “Bohemian” get “Bohemian Rhapsody”? The
          workable rule is that a partial counts if it could not be any other song, and
          the host decides on the spot. Most groups are far more generous than they expect
          to be, and the game is better for it.
        </li>
        <li>
          <strong>Phones.</strong> Either everyone can look things up or nobody can. The
          middle position — technically banned, quietly tolerated — is the worst one,
          because it punishes the honest. Most groups ban them; a group with a big
          knowledge gap sometimes plays with them on for everyone.
        </li>
        <li>
          <strong>Shouting over the clip.</strong> Decide whether the music stops on the
          first answer or plays out. Stopping is faster and more competitive. Playing out
          means the person who was two seconds behind still gets to enjoy the song, which
          matters more than it sounds at a party.
        </li>
        <li>
          <strong>The host.</strong> One person, all night, not playing — or rotating
          every ten songs so everyone gets to play. Rotating is fairer and slower.
          Whichever you choose, say so at the start, because a host who was expecting to
          rotate and does not will spend the evening feeling like the help.
        </li>
      </ol>

      <h2>What the rules cannot fix</h2>
      <p>
        A game where one person wins every round is not a rules problem, and no scoring
        variant will rescue it. It is almost always a playlist problem — the music is from
        one person’s era, or one person’s genre, and everyone else is guessing.{" "}
        <a href="/guides/best-playlists-for-a-guess-the-song-game">
          Choosing a playlist that spreads the knowledge around
        </a>{" "}
        does more for a close game than every rule on this page put together.
      </p>
      <p>
        The second most common failure is a difficulty setting nobody adjusted.{" "}
        <a href="/guides/clip-length-and-difficulty">
          Clip length is the dial for that
        </a>
        , and it is meant to be moved during the night rather than chosen once.
      </p>
    </GuideShell>
  );
}
