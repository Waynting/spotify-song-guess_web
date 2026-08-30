import type { Metadata } from "next";
import { GuideShell, guideMetadata } from "@/app/guides/guide-shell";

const SLUG = "music-quiz-over-video-call";

export const metadata: Metadata = guideMetadata(SLUG);

export default function Page() {
  return (
    <GuideShell slug={SLUG}>
      <p>
        A music quiz over a video call fails in a specific, predictable way, and it is
        almost never the quiz’s fault. It is the audio. The host presses play, the room
        hears something that sounds like a radio underwater, and half the guesses are
        wrong for reasons that have nothing to do with knowing the song.
      </p>
      <p>
        Two things cause it, both fixable in under a minute once you know what they are.
        Then there is a third problem — delay — which is not fixable at all, and which
        means one rule of the in-person game has to be thrown away.
      </p>

      <h2>Problem one: voice processing is destroying the music</h2>
      <p>
        Every video-call platform runs aggressive processing on your microphone by
        default: noise suppression, echo cancellation, automatic gain control. All three
        exist to make a human voice intelligible in a bad room, and all three are actively
        hostile to music.
      </p>
      <p>
        Noise suppression treats sustained non-speech sound as noise, which is a fair
        description of a cymbal, a synth pad or a bassline. Automatic gain control ducks
        the volume the moment anyone speaks. Echo cancellation removes whatever it thinks
        it has heard before, which includes the loop the song is built on.
      </p>
      <p>
        So if you play music into your microphone — phone speaker pointed at a laptop, or
        just the song playing in the room — the platform will systematically dismantle it.
        The music arrives thin, wobbly and missing exactly the parts people recognise
        songs by.
      </p>

      <div className="callout">
        <p className="callout-title">Never hold a phone up to the microphone</p>
        <p>
          It is the first thing everyone tries and the worst available option. It stacks
          every processing artefact on top of room reverb and the phone speaker’s own
          limits. If you take one thing from this page, take this one.
        </p>
      </div>

      <h2>Problem two: you are sharing video, not audio</h2>
      <p>
        Screen sharing does not share sound unless you explicitly tell it to, and the
        checkbox is easy to miss because it appears in the share dialog rather than in
        settings. What each platform calls it:
      </p>
      <table>
        <thead>
          <tr>
            <th>Platform</th>
            <th>What to enable</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Zoom</strong></td>
            <td>
              In the share window: <em>Share sound</em>, then choose <em>High fidelity
              music mode</em> in its dropdown. Also turn on <em>Original sound for
              musicians</em> in audio settings.
            </td>
          </tr>
          <tr>
            <td><strong>Google Meet</strong></td>
            <td>
              Share a <em>Chrome tab</em> rather than a window or the whole screen, and
              tick <em>Also share tab audio</em>. Only tab sharing carries audio.
            </td>
          </tr>
          <tr>
            <td><strong>Discord</strong></td>
            <td>
              Screen share carries application audio on desktop. Raise the server or
              channel bitrate if you can; Discord is the most forgiving of these for
              music.
            </td>
          </tr>
          <tr>
            <td><strong>Teams</strong></td>
            <td>
              <em>Include computer sound</em> in the share tray. It is off by default and
              resets between calls.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Sharing computer sound rather than microphone sound also bypasses problem one
        entirely: the audio never goes through the voice pipeline, so nothing suppresses
        it. This is the whole fix, and it is why browser-based games are much easier to
        run over a call than anything playing out of a speaker in your room.
      </p>

      <h2>Problem three: delay, which you cannot fix</h2>
      <p>
        Everyone on the call hears the clip at a slightly different moment, and the spread
        is not small — comfortably enough to decide a race. Someone on hotel wifi may be
        a second or more behind someone on fibre. Nothing you configure changes this;
        it is the network.
      </p>
      <p>
        Which means <strong>first-to-shout does not work over a video call</strong>. It is
        not slightly unfair, it is measuring connection quality. Any competitive format
        that resolves ties by speed is broken here.
      </p>
      <p>Three formats that survive it:</p>
      <ul>
        <li>
          <strong>Written rounds.</strong> Everyone writes their answers privately —
          paper, notes app, a private message to the host — and they are revealed at the
          end of the round. Nobody is racing anybody, so latency stops mattering
          completely. This is the default for remote play and it should be.
        </li>
        <li>
          <strong>Teams in breakout rooms.</strong> Play the clip to everyone, then send
          teams to breakouts for ninety seconds to agree an answer. Slower, and much more
          social — the discussion is the entertainment, not the guessing.
        </li>
        <li>
          <strong>Second-device buzzers.</strong> Players buzz on their own phone against
          a shared clock rather than through the call. Still imperfect, because the audio
          arrived at different times, but far closer than shouting into a microphone.
        </li>
      </ul>
      <p>
        More on why format choice matters more than difficulty in{" "}
        <a href="/guides/guess-the-song-game-rules">the rules and variants guide</a>.
      </p>

      <h2>A pre-call checklist</h2>
      <ol>
        <li>
          <strong>Test with one person before everyone arrives.</strong> Five minutes
          earlier, one friend, one song. Every problem on this page is obvious within ten
          seconds of a real test and invisible without one.
        </li>
        <li>
          <strong>Ask everyone to use headphones.</strong> Not for their benefit — for
          yours. Speakers mean the song comes back into their microphones and gets
          re-transmitted a beat late, which is what turns a clean clip into a smear.
        </li>
        <li>
          <strong>Mute the room by default.</strong> Guessing happens in the chat or on
          paper. Fifteen open microphones on a call is not a quiz, it is a noise floor.
        </li>
        <li>
          <strong>Use longer clips than you would in person.</strong> Add five to ten
          seconds. Compressed audio over a call is genuinely harder to identify than the
          same clip in a room, and you are compensating for the medium rather than making
          it easier.
        </li>
        <li>
          <strong>Have the answers where you can see them.</strong> You cannot read the
          room over a call, so you cannot tell whether silence means thinking or means
          your audio dropped. Being ready to move on quickly is the substitute.
        </li>
      </ol>

      <h2>What to do when the audio fails mid-game</h2>
      <p>
        It will, once. The recovery is to stop immediately rather than play three more
        songs hoping it settles: re-share, confirm with one person that they can hear it,
        then replay the song you lost. A round played through broken audio is a round
        everybody scores badly on for no reason, and it takes the energy out of the rest
        of the night far more than a two-minute pause does.
      </p>
      <p>
        If the clip itself is missing rather than the audio route being wrong — one song
        silent, the rest fine — that is a different problem with a different fix, covered
        in{" "}
        <a href="/guides/songs-with-no-preview-clip">
          why one song has no clip when the rest of the playlist does
        </a>
        .
      </p>
    </GuideShell>
  );
}
