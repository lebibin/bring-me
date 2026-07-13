/**
 * Bot AI — pure decision logic, no I/O and no Durable Object APIs (the room
 * owns sockets/tick/storage; this module only thinks). A quick-game room tops
 * itself up with these virtual players; each tick the room asks every bot for
 * a `BotStep` (a move + at most one discrete action) and executes it through
 * the very same internal handlers a human message would reach.
 *
 * Believability is the whole point: bots carry human names (shared name pool)
 * and their competence is deliberately imperfect — per-bot skill scales speed,
 * reaction time, aim and the chance of a mistake, so they win rounds sometimes
 * without ever playing like a metronome.
 */

import {
  ARCHETYPES,
  BOT_REACT_MAX_MS,
  BOT_REACT_MIN_MS,
  BOT_SKILL_MAX,
  BOT_SKILL_MIN,
  BOT_THROW_RANGE,
  CARRY_HEIGHT,
  CARRY_SPEED,
  GRAB_RADIUS,
  MAP_SIZE,
  PLAYER_SPEED,
  SCALE_MAX,
  SCALE_MIN,
  STUN_RANGE,
  blockedAt,
  mulberry32,
  placementValid,
  randInt,
  randRange,
  stepBallistic,
  stepMove,
  throwVelocity,
  type PhaseName,
  type Rng,
  type World,
} from "@bringme/shared";

// ---------- public shape ----------

export type BotAction =
  | { kind: "grab"; propId: number }
  | { kind: "drop" }
  | { kind: "throw"; dirX: number; dirZ: number; power: number }
  | { kind: "stun" }
  | { kind: "pick"; archetype: string; hue: number; scale: number }
  | { kind: "place"; x: number; z: number };

export interface BotStep {
  /** new position for this tick (already speed/collision limited), or null */
  move: { x: number; z: number; yaw: number } | null;
  /** at most one discrete action to dispatch this tick */
  action: BotAction | null;
}

/** How the room sees any actor (human or bot) for proximity decisions. */
export interface ActorView {
  id: number;
  x: number;
  z: number;
  carry: number;
  stunnedUntil: number;
}

/** The acting bot's own live state (a slice of the room's PlayerState). */
export interface BotSelf {
  id: number;
  x: number;
  z: number;
  yaw: number;
  carry: number;
  stunnedUntil: number;
  stunCdUntil: number;
}

/** The current round's target prop, as the room knows it. */
export interface TargetView {
  propId: number;
  creatorId: number;
  x: number;
  z: number;
  heldBy: number; // 0 = free on the ground
  airborne: boolean;
}

export interface BotContext {
  world: World;
  phase: PhaseName;
  npc: { x: number; z: number };
  /** flow field routing to the NPC (stable per world) */
  npcField: FlowField;
  /** SEEK only: the round target + a field routing to it; null otherwise */
  target: TargetView | null;
  targetField: FlowField | null;
  /** every actor in the room (for stun range + carrier chasing) */
  actors: readonly ActorView[];
  /** current phase deadline (epoch ms; 0 = untimed) — CREATE uses it to place in time */
  phaseEndsAt: number;
  dt: number; // seconds since last tick
}

/** Per-bot volatile AI memory. Re-created fresh on a room wake (see room.ts). */
export interface BotState {
  rng: Rng;
  skill: number; // BOT_SKILL_MIN..MAX
  // CREATE
  create: "fresh" | "picked" | "done";
  hide: { x: number; z: number } | null;
  pick: { archetype: string; hue: number; scale: number } | null;
  actAt: number; // reaction gate before the next deliberate CREATE act
  // SEEK
  seenTarget: number; // propId the reaction timer was armed for
  reactAt: number; // when this bot starts reacting to the reveal
  willThrow: boolean; // decided once per approach whether to throw or walk it in
  decided: boolean; // has willThrow been rolled for this carry?
  // idle wander (any lull phase)
  wander: { x: number; z: number } | null;
  wanderAt: number;
}

// ---------- construction ----------

export function newBot(seed: number): BotState {
  const rng = mulberry32(seed >>> 0);
  return {
    rng,
    skill: randRange(rng, BOT_SKILL_MIN, BOT_SKILL_MAX),
    create: "fresh",
    hide: null,
    pick: null,
    actAt: 0,
    seenTarget: -1,
    reactAt: 0,
    willThrow: false,
    decided: false,
    wander: null,
    wanderAt: 0,
  };
}

// ---------- per-tick decision ----------

export function stepBot(bot: BotState, self: BotSelf, ctx: BotContext, now: number): BotStep {
  // frozen: stuns are real for bots too. No move, no action.
  if (now < self.stunnedUntil) return { move: null, action: null };

  switch (ctx.phase) {
    case "CREATE":
      return stepCreate(bot, self, ctx, now);
    case "SEEK":
      return stepSeek(bot, self, ctx, now);
    default:
      // LOBBY / COUNTDOWN / REVEAL / RESOLVE / MATCH_END: idle fidgeting only
      return { move: idleWander(bot, self, ctx, now), action: null };
  }
}

// ---------- CREATE: pick something, wander over, hide it ----------

function stepCreate(bot: BotState, self: BotSelf, ctx: BotContext, now: number): BotStep {
  if (bot.create === "done") {
    return { move: idleWander(bot, self, ctx, now), action: null };
  }
  // brief think before doing anything, so all bots don't place in lockstep
  if (bot.actAt === 0) bot.actAt = now + randInt(bot.rng, 4000, 18000);

  if (bot.create === "fresh") {
    if (now < bot.actAt) return { move: idleWander(bot, self, ctx, now), action: null };
    bot.hide = chooseHideSpot(bot.rng, ctx.world);
    const arche = ARCHETYPES[randInt(bot.rng, 0, ARCHETYPES.length)].id;
    bot.pick = { archetype: arche, hue: randInt(bot.rng, 0, 360), scale: randRange(bot.rng, SCALE_MIN, SCALE_MAX) };
    bot.create = "picked";
    return { move: null, action: { kind: "pick", ...bot.pick } };
  }

  // picked: walk to the hide spot, then place (or place under time pressure)
  const spot = bot.hide!;
  const move = moveToward(bot, self, ctx, spot.x, spot.z, null, false);
  const close = dist(self.x, self.z, spot.x, spot.z) < 1.5;
  const timePressed = ctx.phaseEndsAt > 0 && now > ctx.phaseEndsAt - 6000;
  if (close || timePressed) {
    bot.create = "done";
    return { move, action: { kind: "place", x: spot.x, z: spot.z } };
  }
  return { move, action: null };
}

// ---------- SEEK: seek / carry / chase / defend ----------

function stepSeek(bot: BotState, self: BotSelf, ctx: BotContext, now: number): BotStep {
  const t = ctx.target;
  if (!t) return { move: idleWander(bot, self, ctx, now), action: null };

  // re-arm the reaction timer whenever a new round's target appears
  if (t.propId !== bot.seenTarget) {
    bot.seenTarget = t.propId;
    bot.reactAt = now + randInt(bot.rng, BOT_REACT_MIN_MS, BOT_REACT_MAX_MS) / bot.skill;
    bot.decided = false;
    bot.willThrow = false;
  }
  if (now < bot.reactAt) return { move: idleWander(bot, self, ctx, now), action: null };

  const iCarryTarget = self.carry === t.propId;

  // --- carrying the target: deliver it (walk in, or throw from range) ---
  if (iCarryTarget) {
    const d = dist(self.x, self.z, ctx.npc.x, ctx.npc.z);
    if (!bot.decided && d < BOT_THROW_RANGE) {
      // higher skill throws more often; a throw is a flourish, walking is safe
      bot.willThrow = d > 4 && bot.rng() < bot.skill * 0.5;
      bot.decided = true;
    }
    if (bot.willThrow && d < BOT_THROW_RANGE && d > 3.5) {
      const dx = ctx.npc.x - self.x;
      const dz = ctx.npc.z - self.z;
      const len = Math.hypot(dx, dz) || 1;
      bot.willThrow = false;
      bot.decided = false; // if it misses, resume walking next approach
      return {
        move: faceOnly(self, dx / len, dz / len),
        action: { kind: "throw", dirX: dx / len, dirZ: dz / len, power: powerForDistance(d) },
      };
    }
    // walk it into the NPC's delivery sphere
    return { move: moveToward(bot, self, ctx, ctx.npc.x, ctx.npc.z, ctx.npcField, true), action: null };
  }

  // --- creator of this round's own object: can't grab it, so deny instead ---
  if (self.id === t.creatorId) {
    return defend(bot, self, ctx, t, now);
  }

  // --- someone else is carrying it: chase them down for a stun-steal ---
  if (t.heldBy !== 0 && t.heldBy !== self.id) {
    const carrier = ctx.actors.find((a) => a.id === t.heldBy);
    if (carrier) {
      const d = dist(self.x, self.z, carrier.x, carrier.z);
      if (d < STUN_RANGE && now >= self.stunCdUntil && bot.rng() < bot.skill) {
        return { move: faceToward(self, carrier.x, carrier.z), action: { kind: "stun" } };
      }
      return { move: moveToward(bot, self, ctx, carrier.x, carrier.z, null, false), action: null };
    }
  }

  // --- target is free: go grab it ---
  const d = dist(self.x, self.z, t.x, t.z);
  if (t.heldBy === 0 && !t.airborne && d <= GRAB_RADIUS && self.carry === -1) {
    return { move: faceToward(self, t.x, t.z), action: { kind: "grab", propId: t.propId } };
  }
  return { move: moveToward(bot, self, ctx, t.x, t.z, ctx.targetField, false), action: null };
}

/** Creator denial: hover between the object and the NPC, stun any carrier. */
function defend(bot: BotState, self: BotSelf, ctx: BotContext, t: TargetView, now: number): BotStep {
  // if someone is hauling it, harass the carrier
  if (t.heldBy !== 0 && t.heldBy !== self.id) {
    const carrier = ctx.actors.find((a) => a.id === t.heldBy);
    if (carrier) {
      const d = dist(self.x, self.z, carrier.x, carrier.z);
      if (d < STUN_RANGE && now >= self.stunCdUntil && bot.rng() < bot.skill) {
        return { move: faceToward(self, carrier.x, carrier.z), action: { kind: "stun" } };
      }
      return { move: moveToward(bot, self, ctx, carrier.x, carrier.z, null, false), action: null };
    }
  }
  // otherwise guard a spot ~40% of the way from the object toward the NPC
  const gx = t.x + (ctx.npc.x - t.x) * 0.4;
  const gz = t.z + (ctx.npc.z - t.z) * 0.4;
  if (dist(self.x, self.z, gx, gz) < 1.5) {
    return { move: idleWander(bot, self, ctx, now), action: null };
  }
  return { move: moveToward(bot, self, ctx, gx, gz, null, false), action: null };
}

// ---------- movement helpers ----------

/** Speed factor from skill: 0.8..1.0 — weak bots are a touch slower, never faster than a human. */
function speedFactor(skill: number): number {
  return 0.8 + ((skill - BOT_SKILL_MIN) / (BOT_SKILL_MAX - BOT_SKILL_MIN)) * 0.2;
}

/**
 * Step toward a goal this tick using the flow field for global routing (falls
 * back to a straight heading when off-field or unreachable), with a touch of
 * lateral jitter so paths don't look laser-straight. Collision + sliding come
 * from the shared stepMove, so bots obey the exact same walls players do.
 */
function moveToward(
  bot: BotState,
  self: BotSelf,
  ctx: BotContext,
  goalX: number,
  goalZ: number,
  field: FlowField | null,
  carrying: boolean,
): { x: number; z: number; yaw: number } {
  let dir = field ? field.dirAt(self.x, self.z) : null;
  if (!dir) {
    const dx = goalX - self.x;
    const dz = goalZ - self.z;
    const len = Math.hypot(dx, dz) || 1;
    dir = { x: dx / len, z: dz / len };
  }
  // small perpendicular wobble (skill-scaled: sloppier bots wander more)
  const jitter = (1 - bot.skill) * 0.25 * (bot.rng() - 0.5);
  const jx = dir.x + -dir.z * jitter;
  const jz = dir.z + dir.x * jitter;
  const speed = (carrying ? CARRY_SPEED : PLAYER_SPEED) * speedFactor(bot.skill);
  const next = stepMove({ x: self.x, z: self.z }, { x: jx, z: jz }, speed, ctx.dt, ctx.world);
  return { x: next.x, z: next.z, yaw: Math.atan2(jx, jz) };
}

/** Idle drift near a periodically re-chosen nearby point (human fidgeting). */
function idleWander(bot: BotState, self: BotSelf, ctx: BotContext, now: number): { x: number; z: number; yaw: number } | null {
  if (!bot.wander || now >= bot.wanderAt) {
    const a = bot.rng() * Math.PI * 2;
    const r = randRange(bot.rng, 1, 4);
    bot.wander = { x: clamp(self.x + Math.cos(a) * r), z: clamp(self.z + Math.sin(a) * r) };
    bot.wanderAt = now + randInt(bot.rng, 1500, 4000);
  }
  const d = dist(self.x, self.z, bot.wander.x, bot.wander.z);
  if (d < 0.4) return null;
  return moveToward(bot, self, ctx, bot.wander.x, bot.wander.z, null, false);
}

/** Turn to face a world point without moving (delivery throw, point-blank stun). */
function faceToward(self: BotSelf, x: number, z: number): { x: number; z: number; yaw: number } {
  return { x: self.x, z: self.z, yaw: Math.atan2(x - self.x, z - self.z) };
}

function faceOnly(self: BotSelf, dirX: number, dirZ: number): { x: number; z: number; yaw: number } {
  return { x: self.x, z: self.z, yaw: Math.atan2(dirX, dirZ) };
}

function chooseHideSpot(rng: Rng, world: World): { x: number; z: number } {
  const HALF = MAP_SIZE / 2;
  for (let i = 0; i < 60; i++) {
    const x = randRange(rng, -HALF + 3, HALF - 3);
    const z = randRange(rng, -HALF + 3, HALF - 3);
    if (dist(x, z, world.plaza.x, world.plaza.z) < 12) continue; // hide away from the party
    if (placementValid(world, x, z) && !blockedAt(world, x, z)) return { x, z };
  }
  // fallback: a ring search out from a random lawn point (mirrors matchbot)
  const px = randRange(rng, -HALF + 6, HALF - 6);
  const pz = randRange(rng, -HALF + 6, HALF - 6);
  for (let ring = 0; ring < 14; ring++) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = px + Math.cos(a) * ring * 1.4;
      const z = pz + Math.sin(a) * ring * 1.4;
      if (placementValid(world, x, z)) return { x, z };
    }
  }
  return { x: px, z: pz };
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function clamp(v: number): number {
  const lim = MAP_SIZE / 2 - 1;
  return Math.min(lim, Math.max(-lim, v));
}

// ---------- flow-field navigation ----------

// 0.5 m cells, matching the worldcheck reachability BFS — a coarser grid could
// miss a gap a player-radius body can actually squeeze through.
const CELL = 0.5;
const GRID = Math.floor(MAP_SIZE / CELL); // 120x120
const HALF = MAP_SIZE / 2;

/**
 * A breadth-first distance field over walkable 1 m cells toward one goal.
 * `dirAt` returns a unit heading down the gradient — robust routing around the
 * pool / house / playground pockets that straight steering would trap a bot in.
 * Pure function of (world, goal): the room caches instances per world/round.
 */
export class FlowField {
  private readonly dist: Int32Array;
  constructor(
    world: World,
    private readonly goalX: number,
    private readonly goalZ: number,
  ) {
    this.dist = buildDistField(world, goalX, goalZ);
  }

  /** Unit vector toward the goal from (x,z), or null if unreachable/off-grid. */
  dirAt(x: number, z: number): { x: number; z: number } | null {
    const cx = cellOf(x);
    const cz = cellOf(z);
    // in (or adjacent to) the goal cell: steer straight at the exact goal point
    if (this.dist[cz * GRID + cx] >= 0 && this.dist[cz * GRID + cx] <= 1) {
      const dx = this.goalX - x;
      const dz = this.goalZ - z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: dx / len, z: dz / len };
    }
    let best = -1;
    let bestCx = cx;
    let bestCz = cz;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
        const d = this.dist[nz * GRID + nx];
        if (d < 0) continue;
        if (best < 0 || d < best) {
          best = d;
          bestCx = nx;
          bestCz = nz;
        }
      }
    }
    if (best < 0) return null; // stranded — caller falls back to straight steering
    const tx = -HALF + (bestCx + 0.5) * CELL - x;
    const tz = -HALF + (bestCz + 0.5) * CELL - z;
    const len = Math.hypot(tx, tz) || 1;
    return { x: tx / len, z: tz / len };
  }
}

function cellOf(v: number): number {
  return Math.min(GRID - 1, Math.max(0, Math.floor((v + HALF) / CELL)));
}

function cellWalkable(world: World, cx: number, cz: number): boolean {
  const wx = -HALF + (cx + 0.5) * CELL;
  const wz = -HALF + (cz + 0.5) * CELL;
  if (Math.abs(wx) > HALF - 1 || Math.abs(wz) > HALF - 1) return false;
  return !blockedAt(world, wx, wz, 0.1);
}

/** 4-neighbor BFS from the goal cell over walkable cells; -1 = unreachable. */
function buildDistField(world: World, goalX: number, goalZ: number): Int32Array {
  const dist = new Int32Array(GRID * GRID).fill(-1);
  // seed from the goal cell, or its nearest walkable neighbor if it sits in a solid
  let gx = cellOf(goalX);
  let gz = cellOf(goalZ);
  if (!cellWalkable(world, gx, gz)) {
    let found = false;
    for (let r = 1; r <= 3 && !found; r++) {
      for (let dz = -r; dz <= r && !found; dz++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
          if (cellWalkable(world, nx, nz)) {
            gx = nx;
            gz = nz;
            found = true;
          }
        }
      }
    }
    if (!found) return dist; // goal fully walled off (shouldn't happen)
  }
  const queue: number[] = [gz * GRID + gx];
  dist[gz * GRID + gx] = 0;
  const dirs = [1, -1, GRID, -GRID];
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const cx = idx % GRID;
    const cz = (idx / GRID) | 0;
    const d = dist[idx];
    for (let k = 0; k < 4; k++) {
      const nx = k < 2 ? cx + dirs[k] : cx;
      const nz = k < 2 ? cz : cz + (k === 2 ? 1 : -1);
      if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
      const nIdx = nz * GRID + nx;
      if (dist[nIdx] >= 0) continue;
      if (!cellWalkable(world, nx, nz)) continue;
      dist[nIdx] = d + 1;
      queue.push(nIdx);
    }
  }
  return dist;
}

// ---------- throw calibration ----------

// Precomputed distance -> power table using the SAME ballistics the server
// integrates, so a bot's thrown arc lands where it aimed. Built once at load
// (flat ground, matching matchbot's powerForDistance); ~48 samples.
const THROW_TABLE: { dist: number; power: number }[] = (() => {
  const table: { dist: number; power: number }[] = [];
  for (let p = 0.05; p <= 1.0001; p += 0.02) {
    const v = throwVelocity(1, 0, p);
    const b = { x: 0, y: CARRY_HEIGHT, z: 0, vx: v.vx, vy: v.vy, vz: v.vz, resting: false };
    for (let i = 0; i < 300 && !b.resting; i++) stepBallistic(b, 1 / 15);
    table.push({ dist: b.x, power: p });
  }
  return table;
})();

function powerForDistance(d: number): number {
  let best = THROW_TABLE[0].power;
  let bestErr = Infinity;
  for (const e of THROW_TABLE) {
    const err = Math.abs(e.dist - d);
    if (err < bestErr) {
      bestErr = err;
      best = e.power;
    }
  }
  return best;
}
