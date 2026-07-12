import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_MS,
  CREATED_PROP_ID_BASE,
  DELIVER_PTS,
  RESOLVE_MS,
  REVEAL_MS,
  UNFOUND_PTS,
} from "@bringme/shared";
import {
  advanceRound,
  beginRounds,
  currentCreator,
  currentTarget,
  newMatch,
  placeObject,
  resolveRound,
  toReveal,
  toSeek,
} from "../src/match.ts";

const SETTINGS = { createSecs: 60, roundSecs: 90, stage: 0 };
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

  it("unfound round pays the creator UNFOUND_PTS", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    toReveal(m, NOW);
    toSeek(m, NOW);
    const creator = currentCreator(m);
    const r = resolveRound(m, NOW, 0);
    expect(r.found).toBe(false);
    expect(r.creatorPoints).toBe(UNFOUND_PTS);
    expect(r.delivererPoints).toBe(0);
    expect(m.scores[creator]).toBe(UNFOUND_PTS);
    expect(m.phase).toBe("RESOLVE");
    expect(m.phaseEndsAt).toBe(NOW + RESOLVE_MS);
  });

  it("delivery pays the deliverer DELIVER_PTS and the creator nothing", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    toReveal(m, NOW);
    toSeek(m, NOW);
    const creator = currentCreator(m);
    const deliverer = [1, 2, 3].find((id) => id !== creator)!;
    const r = resolveRound(m, NOW, deliverer);
    expect(r.found).toBe(true);
    expect(r.delivererPoints).toBe(DELIVER_PTS);
    expect(r.creatorPoints).toBe(0);
    expect(m.scores[deliverer]).toBe(DELIVER_PTS);
    expect(m.scores[creator]).toBe(0);
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

  it("scores accumulate across rounds", () => {
    const m = matchWithObjects();
    beginRounds(m, NOW);
    // round 1: unfound; round 2: delivered by whoever isn't that round's creator
    toReveal(m, NOW);
    toSeek(m, NOW);
    const creator1 = currentCreator(m);
    resolveRound(m, NOW, 0);
    advanceRound(m, NOW);
    toReveal(m, NOW);
    toSeek(m, NOW);
    const deliverer = [1, 2, 3].find((id) => id !== currentCreator(m))!;
    resolveRound(m, NOW, deliverer);
    const expected = (id: number) =>
      (id === creator1 ? UNFOUND_PTS : 0) + (id === deliverer ? DELIVER_PTS : 0);
    for (const id of [1, 2, 3]) expect(m.scores[id]).toBe(expected(id));
  });
});
