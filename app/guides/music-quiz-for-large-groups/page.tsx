import type { Metadata } from "next";
import { GuideShell, guideMetadata } from "@/app/guides/guide-shell";

const SLUG = "music-quiz-for-large-groups";

export const metadata: Metadata = guideMetadata(SLUG);

export default function Page() {
  return (
    <GuideShell slug={SLUG}>
      <p>
        A music quiz that works beautifully for eight people does not scale to thirty by
        adding twenty-two more chairs. It breaks — reliably, in the same three places —
        and the breakages are structural rather than a matter of the host trying harder.
      </p>
      <p>
        The good news is that all three have the same fix, and it is not the one most
        hosts reach for first.
      </p>

      <h2>What actually breaks</h2>
      <p>
        <strong>Nobody can hear who answered.</strong> With eight people, one voice is
        distinguishable from the rest. With twenty-five, four people shout the same title
        within half a second and the host is guessing at the order. Every award becomes a
        small injustice, and after the fourth one the room stops treating the score as
        real.
      </p>
      <p>
        <strong>Most people never answer at all.</strong> This is the killer. In a big
        room, the same five or six confident people take almost everything, and the other
        twenty spend the night as an audience. They are not bored of the music — they are
        bored because they have no route into the game.
      </p>
      <p>
        <strong>The scoreboard becomes admin.</strong> Twenty-five individual scores is a
        spreadsheet, not a party. Reading it aloud takes ninety seconds and nobody can
        hold their own position in their head, so nobody knows whether they are doing
        well, and the whole competitive frame quietly stops working.
      </p>

      <h2>The fix is teams, and it is not close</h2>
      <p>
        Hosts usually try to fix the first problem — buzzers, hands up, a strict
        one-at-a-time rule. It helps a little and does nothing about the other two.
      </p>
      <p>
        Teams fix all three at once. They reduce twenty-five answering voices to five,
        which makes the host’s job possible again. They give the quiet twenty a place to
        contribute where the stakes are a conversation with three people rather than a
        declaration to the entire room. And five scores is a scoreboard a person can hold
        in their head.
      </p>
      <p>The sizing that works:</p>
      <ul>
        <li>
          <strong>13–20 people: teams of three or four.</strong> Four to five teams. Small
          enough that everybody in a team speaks.
        </li>
        <li>
          <strong>20–35 people: teams of four or five.</strong> Five to seven teams. Past
          seven teams you are back to a scoreboard nobody can follow.
        </li>
        <li>
          <strong>35+: teams of five or six, and shorter rounds.</strong> Also a second
          host, purely to watch one half of the room.
        </li>
      </ul>
      <p>
        <strong>Never go above six per team.</strong> At seven, the quietest two stop
        talking even within their own team, which reproduces the original problem one
        level down.
      </p>

      <div className="callout">
        <p className="callout-title">Split people up, do not let them self-select</p>
        <p>
          Teams that form themselves are teams of friends who arrived together, which
          concentrates the music knowledge and defeats the point. Count off around the
          room — one, two, three, four, one, two — and let the arbitrariness do the work.
          It is also the fastest way to get a room of people who half know each other
          talking.
        </p>
      </div>

      <h2>One nominated voice per team</h2>
      <p>
        Each team picks one person who is allowed to call out the answer. Everyone else
        talks to their own table. This is the rule that makes a big room quiet enough to
        run, and it has a second effect worth knowing about: it converts the loudest
        person in each team from an advantage into a job, which is a much better use of
        them.
      </p>
      <p>
        Rotate the nominated voice every few rounds. Otherwise you have rebuilt the
        original problem at team scale — five confident people playing, twenty listening.
      </p>

      <h2>Scoring changes for a big room</h2>
      <p>
        The standard structure — three points for the title, one for the album — still
        works, but two adjustments matter more at scale than they do at a table of eight.
        The reasoning behind the base numbers is in{" "}
        <a href="/guides/music-quiz-scoring-rules">scoring a music quiz</a>.
      </p>
      <ul>
        <li>
          <strong>Announce scores every round, briefly.</strong> Five team totals, ten
          seconds. Not a leaderboard read-out — just enough that every table knows whether
          they are in it. A room that does not know the score is a room that is no longer
          playing.
        </li>
        <li>
          <strong>Keep the gaps small and the rounds many.</strong> Big rooms need more
          frequent scoring events, not bigger ones. Twelve small rounds hold a crowd far
          better than four large ones, because the reset comes often enough that a bad
          patch does not end anybody’s night.
        </li>
      </ul>

      <h2>Two logistics problems that only exist at scale</h2>
      <p>
        <strong>Everyone needs to hear the same thing at the same time.</strong> One
        laptop speaker does not cover thirty people. If you cannot get the audio to the
        back of the room, the back of the room is not playing — and they will be polite
        about it rather than tell you. Test from the furthest seat before you start, not
        from where you are standing.
      </p>
      <p>
        <strong>Sight lines to the host matter more than you think.</strong> The host is
        the judge, so every team needs to be able to see who is being awarded points. A
        long room with the host at one end produces a far-end table that has stopped
        believing in the scoring by round three.
      </p>

      <h2>Rounds that scale, and rounds that do not</h2>
      <p>
        Anything decided by speed gets worse as the room grows, because more people racing
        means more ties and more disputed calls. Anything written gets better, because it
        removes the race entirely.
      </p>
      <table>
        <thead>
          <tr>
            <th>Round</th>
            <th>At 25+ people</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Written answers</strong></td>
            <td>Best format available. Every team plays every song; no ties to arbitrate.</td>
          </tr>
          <tr>
            <td><strong>Finish the lyric</strong></td>
            <td>Excellent. A whole table can work on it together, out loud.</td>
          </tr>
          <tr>
            <td><strong>Whose playlist is it?</strong></td>
            <td>
              Strong, but sample fewer songs per person or the pool gets unwieldy —{" "}
              <a href="/guides/mixed-playlist-mode-guide">see the guide</a>.
            </td>
          </tr>
          <tr>
            <td><strong>First to shout</strong></td>
            <td>Use sparingly, and only with nominated voices. Chaos otherwise.</td>
          </tr>
          <tr>
            <td><strong>Speed round</strong></td>
            <td>Only as a finale, only written. Live shouting at this size is unjudgeable.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Twelve round formats and what each one does to a room are in{" "}
        <a href="/guides/music-quiz-round-ideas">the round ideas guide</a>. If your group
        is at the other end of the scale, the failure modes invert completely —{" "}
        <a href="/guides/party-games-for-small-groups">
          small groups have an elimination problem rather than a participation one
        </a>
        .
      </p>

      <h2>The one thing worth over-preparing</h2>
      <p>
        Have more songs ready than you need, and know which ones you would cut. A big room
        runs faster than a small one — teams answer in parallel, so the same number of
        songs takes less time — and a host who runs out of material at a party of thirty
        cannot quietly improvise the way they could at a table of eight. Prepare for a
        night that is thirty per cent shorter than you planned, and keep the wildcard
        round in your pocket for when it is not.
      </p>
    </GuideShell>
  );
}
