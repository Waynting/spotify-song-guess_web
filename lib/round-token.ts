/**
 * The rule that stops one round's async work from landing on the next round.
 *
 * It lives here rather than in `app/game/page.tsx` for the reason
 * `lib/room-poll.ts` and `lib/song-count.ts` do: the suite reaches `lib/` and
 * cannot import a `.tsx` module, so a rule left in the component is a rule with
 * no test. This one was written there first, under a comment conceding exactly
 * that — which is the argument for moving it, not for keeping it.
 *
 * The game page holds one `<audio>` element and one set of phase state across
 * every round. Anything that awaits mid-round — resolving a preview, repairing
 * a rotted URL — can come back after the host has pressed Skip Track or Reveal
 * Answer, and whatever it writes then belongs to a round that is no longer on
 * screen. That is round N's clip playing under round N+1's card, which is the
 * bug this exists to prevent.
 *
 * `begin()` is called before the await and hands back the predicate that
 * answers it. Capture-then-compare is a two-step rule and either step can be
 * forgotten independently; returning the compare from the capture means a
 * caller that remembered one has necessarily got the other.
 */
export interface RoundToken {
  /** Retire the round on screen. Everything begun before this is now stale. */
  bump(): void;
  /** Call before an await. The result reports whether the round still owns it. */
  begin(): () => boolean;
}

export function createRoundToken(): RoundToken {
  let current = 0;
  return {
    bump() {
      current += 1;
    },
    begin() {
      const mine = current;
      return () => mine === current;
    },
  };
}
