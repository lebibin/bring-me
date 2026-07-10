import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_MS,
  CREATED_PROP_ID_BASE,
  DELIVER_PTS,
  LOS_PTS_PER_SEC,
  RESOLVE_MS,
  REVEAL_MS,
  UNFOUND_MULT,
} from "@bringme/shared";
import {
  advanceRound,
  accrue,
  beginRounds,
  currentCreator,
  currentTarget,
  newMatch,
  placeObject,
  resolveRound,
  toReveal,
  toSeek,
} from "../src/match.ts";

const SETTINGS = { createSecs: 60, roundSecs: 90 };
const NOW = 1_000_000;

function matchWithObjects(seed = 42, ids = [1, 2, 3]) {
  const m = newMatch(seed, SETTINGS, ids, NOW);
  for (const id of ids) {
    placeObject(m, id, { archetype: id % 12, hue: id * 30, scale: 1, x: id * 5, z: -id * 5 });
  }
  return m;
}

describe("match state machine", () => {
  it("starts in CREATE with the host-configured deadline", () => {
    const m = newMatch(42, SETTINGS, [1, 2], NOW);
    expect(m.phase).toBe("CREATE");
    expect(m.phaseEndsAt).toBe(NOW + 60_000);
    expect(m.scores).toEqual({ 1: 0, 2: 0 });
  });

  it("assigns stable created prop ids", () => {
    const m = matchWithObjects();
    expect(m.objects[2].propId).toBe(CREATED_PROP_ID_BASE + 2);
  });

  it("beginRounds shuffles one round per object, deterministically per seed", () => {
    const a = matchWithObjects(7);
    const b = matchWithObjects(7);
    beginRounds(a, NOW);
    beginRounds(b, NOW);
    expect(a.roundOrder).toEqual(b.roundOrder);
    expect([...a.roundOrder].sort()).toEqual([1, 2, 3]);
    expect(a.phase).toBe("COUNTDOWN");
    expect(a.phaseEndsAt).toBe(NOW + COUNTDOWN_MS);
    expect(a.round).toBe(0);
  });

  it("walks COUNTDOWN -> REVEAL -> SEEK with correct deadlines", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    toReveal(m, NOW + COUNTDOWN_MS);
    expect(m.phase).toBe("REVEAL");
    expect(m.phaseEndsAt).toBe(NOW + COUNTDOWN_MS + REVEAL_MS);
    toSeek(m, NOW);
    expect(m.phase).toBe("SEEK");
    expect(m.phaseEndsAt).toBe(NOW + 90_000); // settings.roundSecs
    expect(currentTarget(m)?.propId).toBe(CREATED_PROP_ID_BASE + currentCreator(m));
  });

  it("unfound round doubles the creator's accrual", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    toReveal(m, NOW);
    toSeek(m, NOW);
    accrue(m, 10_000); // 10s of LoS
    const base = LOS_PTS_PER_SEC * 10;
    const creator = currentCreator(m);
    const r = resolveRound(m, NOW, 0);
    expect(r.found).toBe(false);
    expect(r.creatorPoints).toBe(base * UNFOUND_MULT);
    expect(m.scores[creator]).toBe(base * UNFOUND_MULT);
    expect(m.phase).toBe("RESOLVE");
    expect(m.phaseEndsAt).toBe(NOW + RESOLVE_MS);
  });

  it("delivery awards the deliverer and pays creator accrual unmultiplied", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    toReveal(m, NOW);
    toSeek(m, NOW);
    accrue(m, 4_000);
    const base = LOS_PTS_PER_SEC * 4;
    const creator = currentCreator(m);
    const deliverer = [1, 2, 3].find((id) => id !== creator)!;
    const r = resolveRound(m, NOW, deliverer);
    expect(r.found).toBe(true);
    expect(r.delivererPoints).toBe(DELIVER_PTS);
    expect(m.scores[deliverer]).toBe(DELIVER_PTS);
    expect(m.scores[creator]).toBe(base);
  });

  it("runs exactly one round per object then MATCH_END", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(currentCreator(m));
      toReveal(m, NOW);
      toSeek(m, NOW);
      resolveRound(m, NOW, 0);
      advanceRound(m, NOW);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(m.phase).toBe("MATCH_END");
  });

  it("accrual resets between rounds", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    toReveal(m, NOW);
    toSeek(m, NOW);
    accrue(m, 6_000);
    resolveRound(m, NOW, 0);
    advanceRound(m, NOW);
    expect(m.accrual).toBe(0);
  });
});
