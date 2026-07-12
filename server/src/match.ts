/**
 * Pure match state machine — no I/O, no timers, no sockets. The room feeds
 * it `now` timestamps; deadlines come back as epoch-ms in `phaseEndsAt` for
 * the room to turn into storage alarms. Unit-tested in server/test.
 *
 *   CREATE ─▶ per round (one per created object, seeded shuffle):
 *     COUNTDOWN ─▶ REVEAL ─▶ SEEK ─▶ RESOLVE ─▶ next round | MATCH_END
 */

import {
  COUNTDOWN_MS,
  CREATED_PROP_ID_BASE,
  DELIVER_PTS,
  RESOLVE_MS,
  REVEAL_MS,
  UNFOUND_PTS,
  mulberry32,
  shuffle,
  type MatchSettings,
  type NetProp,
  type PhaseName,
} from "@bringme/shared";

export interface MatchState {
  phase: PhaseName;
  settings: MatchSettings;
  seed: number;
  /** creatorId -> their hidden object (propId = CREATED_PROP_ID_BASE + creatorId) */
  objects: Record<number, NetProp>;
  roundOrder: number[]; // creator ids, seeded shuffle at beginRounds
  round: number; // index into roundOrder
  scores: Record<number, number>;
  found: boolean;
  deliverer: number;
  phaseEndsAt: number; // epoch ms; 0 = untimed
}

export function newMatch(seed: number, settings: MatchSettings, playerIds: number[], now: number): MatchState {
  const scores: Record<number, number> = {};
  for (const id of playerIds) scores[id] = 0;
  return {
    phase: "CREATE",
    settings,
    seed,
    objects: {},
    roundOrder: [],
    round: -1,
    scores,
    found: false,
    deliverer: 0,
    phaseEndsAt: now + settings.createSecs * 1000,
  };
}

export function createdPropId(creatorId: number): number {
  return CREATED_PROP_ID_BASE + creatorId;
}

export function placeObject(m: MatchState, creatorId: number, prop: Omit<NetProp, "propId">): NetProp {
  const full: NetProp = { ...prop, propId: createdPropId(creatorId) };
  m.objects[creatorId] = full;
  return full;
}

/** Shuffle round order and enter the first COUNTDOWN. Call after CREATE ends. */
export function beginRounds(m: MatchState, now: number): void {
  const rng = mulberry32(m.seed ^ 0x9e3779b9);
  m.roundOrder = shuffle(rng, Object.keys(m.objects).map(Number));
  m.round = -1;
  advanceRound(m, now);
}

/** Move to the next round's COUNTDOWN, or MATCH_END when exhausted. */
export function advanceRound(m: MatchState, now: number): "round" | "end" {
  m.round += 1;
  m.found = false;
  m.deliverer = 0;
  if (m.round >= m.roundOrder.length) {
    m.phase = "MATCH_END";
    m.phaseEndsAt = 0;
    return "end";
  }
  m.phase = "COUNTDOWN";
  m.phaseEndsAt = now + COUNTDOWN_MS;
  return "round";
}

export function currentCreator(m: MatchState): number {
  return m.roundOrder[m.round] ?? 0;
}

export function currentTarget(m: MatchState): NetProp | null {
  const c = currentCreator(m);
  return c ? (m.objects[c] ?? null) : null;
}

export function toReveal(m: MatchState, now: number): void {
  m.phase = "REVEAL";
  m.phaseEndsAt = now + REVEAL_MS;
}

export function toSeek(m: MatchState, now: number): void {
  m.phase = "SEEK";
  m.phaseEndsAt = now + m.settings.roundSecs * 1000;
}

export interface RoundResult {
  found: boolean;
  creatorId: number;
  creatorPoints: number;
  deliverer: number;
  delivererPoints: number;
}

/** End the round (delivery or timeout), apply scores, enter RESOLVE. */
export function resolveRound(m: MatchState, now: number, deliverer: number): RoundResult {
  const creatorId = currentCreator(m);
  m.found = deliverer !== 0;
  m.deliverer = deliverer;
  const creatorPoints = m.found ? 0 : UNFOUND_PTS;
  const delivererPoints = m.found ? DELIVER_PTS : 0;
  m.scores[creatorId] = (m.scores[creatorId] ?? 0) + creatorPoints;
  if (m.found) m.scores[deliverer] = (m.scores[deliverer] ?? 0) + delivererPoints;
  m.phase = "RESOLVE";
  m.phaseEndsAt = now + RESOLVE_MS;
  return { found: m.found, creatorId, creatorPoints, deliverer, delivererPoints };
}
