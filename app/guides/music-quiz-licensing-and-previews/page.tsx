import type { Metadata } from "next";
import { GuideShell, guideMetadata } from "@/app/guides/guide-shell";

const SLUG = "music-quiz-licensing-and-previews";

export const metadata: Metadata = guideMetadata(SLUG);

export default function Page() {
  return (
    <GuideShell slug={SLUG}>
      <p>
        Almost nobody running a music quiz in their living room needs to think about
        licensing. Almost everybody running one in a pub, a classroom, an office or a
        club already has the question answered for them by somebody else. The awkward
        cases sit between those two, and the useful thing is knowing which one you are in
        before you plan a night around it.
      </p>

      <div className="callout">
        <p className="callout-title">This is orientation, not legal advice</p>
        <p>
          Music licensing is national law plus private contract, and both differ by
          country and change over time. What follows is a map of the questions and who
          answers them, so you know what to ask. For anything with money or a venue
          attached, ask the venue and the relevant collecting society in your country.
        </p>
      </div>

      <h2>The three separate questions</h2>
      <p>
        People collapse these into one and then get confused, because the answers point in
        different directions.
      </p>
      <ol>
        <li>
          <strong>Is this a public performance?</strong> Playing recorded music to a
          gathering that is not your household or close social circle is generally treated
          as a public performance in most jurisdictions, and public performance is
          licensed.
        </li>
        <li>
          <strong>Who holds that licence?</strong> Almost always the venue, not you. Pubs,
          bars, restaurants, hotels, schools, gyms and most workplaces hold blanket
          licences from collecting societies precisely so that the people inside them do
          not have to think about this.
        </li>
        <li>
          <strong>Do the terms of the service you are using allow it?</strong> A separate
          question, governed by a contract rather than by copyright law, and the one people
          almost never check.
        </li>
      </ol>
      <p>
        Question three is the one worth reading the rest of this page for, because it is
        where the answer is least intuitive.
      </p>

      <h2>Where the collecting societies come in</h2>
      <p>
        Recorded music generally carries two rights that need clearing for public
        performance: the composition and the recording. In most countries one or two
        organisations collect for these on behalf of rights holders and sell blanket
        licences that cover a venue’s whole catalogue use.
      </p>
      <table>
        <thead>
          <tr>
            <th>Where</th>
            <th>Who to ask</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>United Kingdom</strong></td>
            <td>PPL PRS (a joint licence covering both rights)</td>
          </tr>
          <tr>
            <td><strong>United States</strong></td>
            <td>ASCAP, BMI, SESAC, GMR — compositions; recordings differ by use</td>
          </tr>
          <tr>
            <td><strong>Elsewhere</strong></td>
            <td>
              Nearly every country has an equivalent. Search for your country plus
              “performing rights organisation”.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        The practical shape of this: <strong>if you are a guest in a licensed venue, the
        licence is theirs and you are covered by it.</strong> If you are the venue — you
        are running a quiz night in a space you operate, or charging admission — the
        question is yours and you should be talking to the society directly rather than
        reading a page like this one.
      </p>

      <h2>Private gatherings</h2>
      <p>
        A quiz at home for friends is the case everybody actually has, and it is the
        uncontroversial one: playing music at a private social gathering in your own home
        is not what public performance licensing is aimed at. Nobody is coming for your
        living room.
      </p>
      <p>
        The edges get blurrier as the gathering gets less private — a large party in a
        rented hall, a charity fundraiser, a public event advertised to strangers. The
        useful test is not headcount, it is whether the group is meaningfully a private
        social circle. If you are advertising it, charging for it, or holding it in a
        space you booked, treat it as public and ask the venue what they hold.
      </p>

      <h2>What a thirty-second preview actually is</h2>
      <p>
        Here is the part that is specific to how these apps work, and where the common
        assumption is wrong in both directions.
      </p>
      <p>
        Music services publish short promotional clips through their public search APIs —
        Apple and Deezer both do, and Spotify used to. These exist to let you preview
        something before deciding to listen to it, and the API terms typically permit
        using them for that <em>promotional</em> purpose, often with conditions attached:
        attribution, links back to the store, no downloading or redistributing the file,
        no building something that substitutes for the service itself.
      </p>
      <p>
        Two things follow, and they are the useful ones:
      </p>
      <ul>
        <li>
          <strong>A preview clip is not a licence to perform the song publicly.</strong>{" "}
          The API terms and the performance right are unrelated questions. Using a legally
          obtained clip in a licensed venue is fine; using one at a public event with no
          licence is not made fine by the clip having come from an official API.
        </li>
        <li>
          <strong>Nor is a short clip automatically fair use or fair dealing.</strong>{" "}
          “Under thirty seconds is allowed” is folklore. There is no duration below which
          use is automatically permitted, in any major jurisdiction. Short clips are
          usually fine in practice for reasons that have nothing to do with a magic number.
        </li>
      </ul>
      <p>
        The reason games are built on preview APIs rather than on full tracks is more
        mundane than either: previews are what a service will actually hand to an
        application without a user login and a commercial agreement.{" "}
        <a href="/guides/why-spotify-previews-disappeared">
          What happened when one of them stopped.
        </a>
      </p>

      <h2>Three situations, three answers</h2>
      <table>
        <thead>
          <tr>
            <th>You are</th>
            <th>What to do</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>At home with friends</strong></td>
            <td>Nothing. Play the game.</td>
          </tr>
          <tr>
            <td><strong>In a pub, office, school or gym</strong></td>
            <td>
              Ask whoever runs the space whether they hold a music licence. They almost
              certainly do, and it is a thirty-second conversation.
            </td>
          </tr>
          <tr>
            <td><strong>Running a public or ticketed event</strong></td>
            <td>
              Contact the collecting society for your country before you plan the night.
              This is the case where getting it wrong has a cost.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Two things that are not the same as licensing</h2>
      <p>
        <strong>Streaming service terms of use.</strong> Consumer subscriptions are
        generally personal-use only, which is a contractual restriction between you and
        the service. Businesses playing music are usually expected to use a commercial
        background-music service instead. This is separate from performance licensing and
        both can apply at once.
      </p>
      <p>
        <strong>Recording or streaming your quiz.</strong> A quiz night posted to a video
        platform is a different use again, with its own rules, and it is where automated
        content matching will find you regardless of anything on this page. If you are
        recording, assume the music in it is a problem and plan around that.
      </p>
      <p>
        With the paperwork question parked, the rest is just running a good night —{" "}
        <a href="/guides/how-to-host-a-music-quiz-night">how to host a music quiz night</a>{" "}
        covers the mechanics, and if your quiz is remote rather than in a room,{" "}
        <a href="/guides/music-quiz-over-video-call">
          the video-call guide
        </a>{" "}
        deals with a completely different set of problems.
      </p>
    </GuideShell>
  );
}
