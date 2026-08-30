import type { Metadata } from "next";
import { GuideShell, guideMetadata } from "@/app/guides/guide-shell";

const SLUG = "music-quiz-round-ideas";

export const metadata: Metadata = guideMetadata(SLUG);

export default function Page() {
  return (
    <GuideShell slug={SLUG}>
      <p>
        A music quiz made entirely of “name that tune” rounds is the same round played
        eight times. It works for about twenty-five minutes. After that the room has
        learned everything the format can teach them, the same two people are winning, and
        the night is running on politeness.
      </p>
      <p>
        What fixes it is not harder songs. It is rounds that ask a different question, so
        that being good at one of them does not predict being good at the next. Here are
        twelve that need nothing but a playlist and a host, sorted by what they do to the
        room rather than by theme.
      </p>

      <h2>Rounds that change what is being tested</h2>

      <h3>1. Intros only</h3>
      <p>
        Two or three seconds, nothing more. This is not a harder version of the normal
        round — it is a different skill. Very short clips reward production detail: a drum
        sound, a synth patch, the exact reverb on a snare. The person who wins it is
        frequently not the person who knows the most music, which is the entire point of
        putting it in the middle of a night somebody is running away with.
      </p>

      <h3>2. Finish the lyric</h3>
      <p>
        Cut the clip mid-line and let the room complete it. Lyric recall and title recall
        live in different parts of people’s memory, and the gap between them is wide.
        Expect at least one person who has scored nothing all night to win this outright.
      </p>

      <h3>3. Blind decade</h3>
      <p>
        Nobody names anything. Everyone writes down the year they think the song came out
        and the closest guess takes the points. The reason to run it is practical: it makes
        unfamiliar music playable. A playlist that would be dead as a naming round is a
        perfectly good guessing round, which means you can finally use somebody’s obscure
        favourites without stranding the rest of the table.
      </p>

      <h3>4. One-word summary</h3>
      <p>
        The host describes the song in exactly one word, before any music plays. The room
        guesses. If nobody gets it, play the clip. It is a warm-up round rather than a
        scoring one, and it is the single best way to open a night with a group that does
        not know each other, because the laugh comes from the host’s word rather than from
        anyone’s ignorance.
      </p>

      <h3>5. The cover version</h3>
      <p>
        Play a cover and ask for the original artist. Two things make this good: covers
        are usually recognisable to people who do not know the original, and the answer
        rewards a completely different kind of knowledge. Be careful with the search — a
        lot of what is filed as a cover on streaming services is a soundalike recording by
        a tribute act, which is not the same round.
      </p>

      <h2>Rounds that change who can win</h2>

      <h3>6. Whose playlist is it?</h3>
      <p>
        Everyone submits their own music, it is shuffled into one pool, and the question is
        not what the song is but which person in the room put it there. The best round in
        this list, and the only one where knowing less about music is close to costless.
        The reasoning behind it, and what to do with the results, is in{" "}
        <a href="/guides/mixed-playlist-mode-guide">the Mixed Playlist Mode guide</a>.
      </p>

      <h3>7. Handicap round</h3>
      <p>
        Whoever is leading answers last. They get the same clip and the same question, but
        only after everyone else has had a go. Brutally effective, mildly humiliating, and
        far better received than any of the polite alternatives — the room enjoys watching
        the leader squirm much more than it enjoys a scoring adjustment nobody can follow.
      </p>

      <h3>8. Pairs</h3>
      <p>
        Split into pairs for one round, deliberately mismatched: the person who knows the
        most music with the person who knows the least. Answers only count if the pair
        agrees. It is a conversation round disguised as a quiz round, and it is the fastest
        way to get a group who arrived separately talking to each other.
      </p>

      <h3>9. Steal</h3>
      <p>
        If nobody gets a song within the clip, it goes to whoever is in last place for a
        free attempt with a longer clip. Costs nothing, takes ten seconds, and gives the
        bottom of the table a reason to still be listening in the second half.
      </p>

      <h2>Rounds that change the tempo</h2>

      <h3>10. Speed round</h3>
      <p>
        Six to ten songs back to back. Short clips, no album points, no discussion, next
        song the moment someone is right or five seconds have passed. Run it as the finale.
        The purpose is not difficulty — it is that the last ten minutes of the night should
        not feel like the middle forty.
      </p>

      <h3>11. Sing-along round</h3>
      <p>
        Thirty-second clips, everything obvious, scoring almost incidental. Somewhere
        around twenty seconds a room stops competing and starts singing, and that is a
        feature if you deploy it on purpose. Put one in the middle when energy dips, and
        one at the end if the group is more party than quiz.{" "}
        <a href="/guides/clip-length-and-difficulty">
          Why clip length changes the activity and not just the difficulty.
        </a>
      </p>

      <h3>12. The wildcard</h3>
      <p>
        One song, announced in advance, worth triple. Players nominate before it plays
        whether they are in — and a wrong answer on a wildcard costs points. It is the only
        round on this list where someone can lose ground, which is exactly why it works as
        a closer: a night that was decided twenty minutes ago becomes live again.
      </p>

      <div className="callout">
        <p className="callout-title">A running order that works</p>
        <p>
          One-word summary to open, three normal rounds, finish the lyric, whose playlist
          is it, a sing-along when energy dips, intros only, then a speed round and the
          wildcard. Roughly ninety minutes for eight to twelve people, and the shape of it
          — easy, competitive, social, hard, fast — matters more than any individual
          round.
        </p>
      </div>

      <h2>Two rules for assembling a night</h2>
      <p>
        <strong>Never run two rounds of the same kind back to back.</strong> Two hard
        rounds in a row reads to the room as “this game got worse”, even though each one
        would have been fine on its own. Alternate what is being tested and the same
        material feels varied.
      </p>
      <p>
        <strong>Announce the round before the music, every time.</strong> A round whose
        rules arrive after the first clip has already cost somebody the answer they were
        about to give, and that is the one thing a room genuinely resents. Twenty seconds
        of explanation is not dead air — it is the part where everyone gets to decide how
        hard they are about to try.
      </p>
      <p>
        The rest of the mechanics — where people sit, what to do about the person who
        knows everything, how long the whole thing should run — are in{" "}
        <a href="/guides/how-to-host-a-music-quiz-night">how to host a music quiz night</a>
        . If your group is bigger than about fifteen, read{" "}
        <a href="/guides/music-quiz-for-large-groups">the large-group guide</a> first,
        because several of these rounds need reworking before they survive a crowd.
      </p>
    </GuideShell>
  );
}
