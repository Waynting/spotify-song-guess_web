import { describe, it, expect } from "vitest";
import { createRoundToken } from "@/lib/round-token";

/**
 * The guard behind app/game/page.tsx's "wrong audio" fix. The component half
 * cannot be tested — vitest's include is tests/**\/*.test.ts and there is no
 * React renderer here — so the rule itself is what gets pinned.
 */
describe("a resolution that lands after the host has moved on is dropped", () => {
  it("rejects a result begun before the round was retired", () => {
    const rounds = createRoundToken();
    const stillMine = rounds.begin();
    rounds.bump();
    expect(stillMine()).toBe(false);
  });

  it("accepts a result whose round is still the one on screen", () => {
    const rounds = createRoundToken();
    expect(rounds.begin()()).toBe(true);
  });

  it("lets only the current round win when two are in flight", () => {
    const rounds = createRoundToken();
    const first = rounds.begin();
    rounds.bump();
    const second = rounds.begin();
    expect([first(), second()]).toEqual([false, true]);
  });

  it("stays rejected however many rounds go by", () => {
    // The comparison is identity, not "is the previous one" — a host who skips
    // four times while one lookup is in flight must not have it come back true.
    const rounds = createRoundToken();
    const stillMine = rounds.begin();
    for (let i = 0; i < 4; i++) rounds.bump();
    expect(stillMine()).toBe(false);
  });

  it("gives each round its own answer", () => {
    const a = createRoundToken();
    const b = createRoundToken();
    const inA = a.begin();
    b.bump();
    expect(inA()).toBe(true);
  });
});
