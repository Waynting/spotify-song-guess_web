import type { Metadata } from "next";
import { GuideShell, guideMetadata } from "@/app/guides/guide-shell";

const SLUG = "songs-with-no-preview-clip";

export const metadata: Metadata = guideMetadata(SLUG);

export default function Page() {
  return (
    <GuideShell slug={SLUG}>
      <p>
        Forty-nine songs in a playlist play fine and one is silent. It looks like a bug in
        whatever you are using, and occasionally it is — but far more often it is a
        structural fact about where preview clips come from, and it is worth understanding
        because it tells you which songs to expect trouble from before you sit down to
        play.
      </p>
      <p>
        This is written from building one of these games. The specifics below are things
        we hit and had to fix, not general advice.
      </p>

      <h2>The clip does not come from Spotify</h2>
      <p>
        Start here, because everything else follows from it. Spotify’s API used to hand
        out a thirty-second <code>preview_url</code> for most tracks. In late 2024 it
        stopped doing so for new applications, and on the credentials a small
        no-login app can obtain, the field now comes back empty for effectively
        everything — we measured zero previews across twenty tracks in four different
        markets before accepting that it was not a configuration mistake.
      </p>
      <p>
        So a Spotify-based guessing game reads the <em>track list</em> from Spotify and
        then goes somewhere else entirely for the audio — in our case the iTunes Search
        API first, then Deezer. Which means the question is never “does Spotify have this
        song”. It is <strong>“can a second catalogue be made to agree that its recording
        is the same recording”</strong>, and that is a much harder question.{" "}
        <a href="/guides/why-spotify-previews-disappeared">
          The full account of what changed and what it broke.
        </a>
      </p>

      <h2>Five reasons a specific song has no clip</h2>

      <h3>1. It genuinely is not in the other catalogue</h3>
      <p>
        Self-released tracks, small-label material, regional releases, podcast episodes
        filed as music, and a surprising amount of very new music. Spotify’s catalogue and
        iTunes’ catalogue are large and overlapping, not identical. Nothing can be done
        about this one.
      </p>

      <h3>2. The title does not match, because of a qualifier</h3>
      <p>
        Spotify stores <code>Karma Police - Remastered 2011</code>. iTunes has the same
        recording as plain <code>Karma Police</code>. An exact comparison matches neither
        thing, so the lookup either fails or — worse — falls through to a looser rule and
        picks a different song by the same artist. This is one of the most common causes
        and it is invisible from the outside: the song is right there in both catalogues,
        under two names.
      </p>
      <p>
        Live versions, radio edits, extended mixes, deluxe-edition re-recordings and
        “(feat.)” credits that one platform includes and the other does not all do the same
        thing.
      </p>

      <h3>3. The artist is credited differently</h3>
      <p>
        Non-Latin catalogues are where this really bites. Spotify credits 小幸運 to 田馥甄;
        iTunes returns it as “A Little Happiness” by “Hebe Tien”. Both are correct, neither
        matches the other, and any matcher strict enough to reject wrong answers will
        reject this one too. Collaborations are the same story in a smaller way — “The
        Beatles” against “Beatles”, or one platform listing three featured artists where
        the other lists one.
      </p>

      <h3>4. There was a clip, and the URL rotted</h3>
      <p>
        Preview clips are files on a content delivery network, and those addresses rotate.
        A song that played last month can be silent today with nothing about the song
        having changed. This is why a well-built game stores enough to re-resolve a clip
        rather than just caching the address — but if you are using something that does
        not, an old cached answer is a permanent one.
      </p>

      <h3>5. Nothing is wrong and you are being rate limited</h3>
      <p>
        The one that matters most and looks least like itself. Clip lookups are per track
        rather than per playlist, so a fifty-song game is fifty separate requests to a
        third-party service — and hosted apps share their outbound addresses, so from the
        catalogue’s side an entire user base looks like one very noisy client.
      </p>
      <p>
        A throttled request and a song with no clip look identical unless the app is
        careful to tell them apart. We shipped a version that did not: every failure was
        cached as “this song has no preview” for a week, so one throttled minute at peak
        marked a slice of the catalogue silent for seven days. It never reproduced in
        testing, because a laptop’s own address is never the one being throttled.
      </p>

      <div className="callout">
        <p className="callout-title">How to tell cause five from the others</p>
        <p>
          If several songs in a row go quiet, it is throttling or a network problem, not
          the catalogue. Catalogue gaps are scattered. A run of consecutive failures is
          almost always the app being refused. Wait a couple of minutes and try again.
        </p>
      </div>

      <h2>The failure that is worse than silence</h2>
      <p>
        A missing clip is obvious and mildly annoying. The genuinely damaging failure is
        the <em>wrong</em> clip — the audio plays, everybody guesses, and the answer card
        says something else.
      </p>
      <p>
        It happens because a search that cannot find an exact match gets progressively
        looser, and the loosest question — the title with no artist attached — is answered
        by popularity. Ask iTunes for “Hello” with no other constraint and you can get
        Pinkfong’s nursery rhyme. Ask for “Alone” and you get Heart. Ask for “Hello Adele”
        and the second result is a tribute act whose track is titled exactly right, which
        is precisely what a popularity-ranked search surfaces.
      </p>
      <p>
        The defence is to require any loosely-matched candidate to agree with the original
        on something the search did not supply — the running time, or a credit that names
        the same acts. A candidate whose duration is fifty seconds off the Spotify track is
        a cover, and the recording you wanted is the one whose clock agrees.
      </p>
      <p>
        If you are playing and a clip clearly does not match the answer, that is what
        happened. Skip it rather than arguing about it, and do not award points for the
        song that actually played.
      </p>

      <h2>What to do as a host</h2>
      <ol>
        <li>
          <strong>Skip and move on.</strong> One silent track costs you fifteen seconds.
          Debugging it mid-party costs you the room.
        </li>
        <li>
          <strong>Try the playlist once before people arrive.</strong> Not the whole thing
          — start a game, click through eight or ten songs, and see whether the silences
          are scattered or clustered. Two minutes, and it tells you which playlist to use.
        </li>
        <li>
          <strong>Prefer well-known studio recordings.</strong> Not for musical reasons:
          they are the recordings most likely to exist in both catalogues under compatible
          names. Remaster-heavy back catalogues, live albums and regional releases are
          where the gaps concentrate.{" "}
          <a href="/guides/best-playlists-for-a-guess-the-song-game">
            More on choosing a playlist that plays well.
          </a>
        </li>
        <li>
          <strong>Have a second playlist ready.</strong> The cheapest insurance there is.
          If the first one turns out to be half silent, you switch instead of ending the
          night.
        </li>
      </ol>
      <p>
        If it is the whole playlist failing rather than individual songs, that is a
        different problem with four common causes, and three of them you can fix from the
        page you are on:{" "}
        <a href="/guides/spotify-playlist-not-working">
          why your Spotify playlist will not load
        </a>
        .
      </p>
    </GuideShell>
  );
}
