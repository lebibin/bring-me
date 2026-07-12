/**
 * Seeded world generation — pure data, identical on client and server.
 * The server sends only the 32-bit seed; both sides call generateWorld(seed).
 *
 * Theme: a suburban backyard. A house facade + wooden deck sit against the
 * wall opposite the party plaza; a pool lies beyond the deck; a playground
 * and a basketball hoop hug the side fences; hedges and garden beds fill the
 * lawn; catalog decoys scatter everywhere a prop can legally sit.
 */

import {
  MAP_SIZE,
  PLAYER_RADIUS,
  SCATTER_CELL,
  SCATTER_FILL,
  MIN_DECOYS_PER_ARCHETYPE,
  PLAZA_KEEPOUT,
  SPAWN_KEEPOUT,
  SPAWN_MIN_GAP,
  SPAWN_RING_RADIUS,
  MAX_PLAYERS,
} from "./constants.ts";
import { ARCHETYPES, SCALE_MIN, SCALE_MAX } from "./catalog.ts";
import { mulberry32, randInt, randRange } from "./rng.ts";

export interface WorldProp {
  propId: number;
  archetype: number; // index into ARCHETYPES
  hue: number;
  scale: number;
  x: number;
  z: number;
  rotY: number;
}

/** Axis-aligned rectangle: center + full size. */
export interface RectZone {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Hedge {
  x: number;
  z: number;
  s: number; // scale
}

export interface GardenBed {
  x: number;
  z: number;
  r: number;
  hue: number; // flower color
}

export interface World {
  seed: number;
  /** index into STAGES — picks the visual theme + fixture-count knobs */
  stage: number;
  props: WorldProp[];
  /** Delivery plaza: jumbotron faces the yard center, NPC stands in front. */
  plaza: { x: number; z: number; facing: number };
  npc: { x: number; z: number };
  spawnPoints: { x: number; z: number }[];
  /** 0=N(-z) 1=E(+x) 2=S(+z) 3=W(-x); the house is opposite the plaza. */
  houseEdge: number;
  house: RectZone;
  deck: RectZone;
  pool: RectZone;
  playground: { x: number; z: number; rot: number };
  hoop: { x: number; z: number; rot: number };
  driveway: RectZone;
  car: { x: number; z: number; rot: number; hue: number };
  car2: { x: number; z: number; rot: number; hue: number };
  shed: { x: number; z: number; rot: number };
  shed2: { x: number; z: number; rot: number };
  sandpit: { x: number; z: number; r: number };
  trampoline: { x: number; z: number };
  bbq: { x: number; z: number; rot: number };
  picnic: { x: number; z: number; rot: number };
  mower: { x: number; z: number; rot: number };
  playground2: { x: number; z: number; rot: number };
  pond: { x: number; z: number; r: number };
  soccer: { x: number; z: number; rot: number };
  doghouse: { x: number; z: number; rot: number };
  birdbath: { x: number; z: number };
  clothesline: { x: number; z: number; rot: number };
  veggie: { x: number; z: number; rot: number };
  benches: { x: number; z: number; rot: number }[];
  clouds: { x: number; y: number; z: number; s: number }[];
  trees: { x: number; z: number; s: number }[];
  hedges: Hedge[];
  beds: GardenBed[];
  /** circle keep-outs for props (one entry per solid fixture, incl. tree trunks) */
  zones: { x: number; z: number; r: number }[];
  /**
   * circle colliders for PLAYER movement — things you can't walk through in
   * real life (cars, sheds, tree trunks, pond water...). The pool and house
   * rects also block; walkable surfaces (deck, driveway, sandpit) don't.
   * `h` > 0 marks a flat standable top at that height (jump on it, place
   * objects on it); h = 0 means unpassable at any height (bushes, water,
   * pitched roofs, poles).
   */
  solids: { x: number; z: number; r: number; h: number }[];
}

const HALF = MAP_SIZE / 2;

/** Wall-center point, inward normal and along-wall tangent for an edge. */
function edgeInfo(e: number): { wx: number; wz: number; nx: number; nz: number; tx: number; tz: number } {
  if (e === 0) return { wx: 0, wz: -HALF, nx: 0, nz: 1, tx: 1, tz: 0 };
  if (e === 1) return { wx: HALF, wz: 0, nx: -1, nz: 0, tx: 0, tz: 1 };
  if (e === 2) return { wx: 0, wz: HALF, nx: 0, nz: -1, tx: 1, tz: 0 };
  return { wx: -HALF, wz: 0, nx: 1, nz: 0, tx: 0, tz: 1 };
}

/** RectZone for something leaning on edge e: `along` meters wide, `depth` deep, centered `inset` from the wall. */
function edgeRect(e: number, lateral: number, inset: number, along: number, depth: number): RectZone {
  const { wx, wz, nx, nz, tx, tz } = edgeInfo(e);
  const cx = wx + nx * inset + tx * lateral;
  const cz = wz + nz * inset + tz * lateral;
  return e % 2 === 0 ? { x: cx, z: cz, w: along, d: depth } : { x: cx, z: cz, w: depth, d: along };
}

export function insideRect(r: RectZone, x: number, z: number, margin = 0): boolean {
  return Math.abs(x - r.x) <= r.w / 2 + margin && Math.abs(z - r.z) <= r.d / 2 + margin;
}

/**
 * Is this spot inside something a player can't walk through? `margin` grows
 * every collider (worldgen uses it to keep spawn points clear of solids, not
 * merely outside them). `y` is the player's feet height: a solid with a
 * standable top stops blocking once you're at/above that top.
 */
export function blockedAt(w: World, x: number, z: number, margin = 0, y = 0): boolean {
  const pr = PLAYER_RADIUS + margin;
  if (insideRect(w.pool, x, z, pr)) return true; // water — no wading, no landing
  if (insideRect(w.house, x, z, pr)) return true;
  for (const s of w.solids) {
    if (Math.hypot(x - s.x, z - s.z) >= s.r + pr) continue;
    if (s.h > 0 && y >= s.h - 0.05) continue; // standing on top of it
    return true;
  }
  return false;
}

/**
 * Height of the surface under (x, z) reachable from feet height `fromY` —
 * standable solid tops and the deck count; everything else is lawn (0).
 * `stepUp` is how much higher than fromY a surface may be and still count
 * (walking up small ledges); pass Infinity to ask "highest surface here".
 */
export function groundHeightAt(w: World, x: number, z: number, fromY: number, stepUp = 0.35): number {
  let best = 0;
  if (insideRect(w.deck, x, z)) best = 0.28; // deck planks are walk-on
  if (Math.hypot(x - w.plaza.x, z - w.plaza.z) < 4) best = Math.max(best, 0.1); // plaza pad
  for (const s of w.solids) {
    if (s.h <= 0 || s.h > best) {
      if (s.h > 0 && s.h <= fromY + stepUp && Math.hypot(x - s.x, z - s.z) < s.r + PLAYER_RADIUS * 0.6) {
        best = Math.max(best, s.h);
      }
    }
  }
  return best;
}

/**
 * Can a prop legally sit / be hidden here? (server validates placements with
 * this too). With `allowTops`, a spot over a STANDABLE solid is legal — the
 * object rides on its top surface (players place things on car roofs etc.);
 * random scatter keeps allowTops=false so decoys stay on the lawn.
 */
export function placementValid(w: World, x: number, z: number, allowTops = false): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (Math.abs(x) > HALF - 1 || Math.abs(z) > HALF - 1) return false;
  if (Math.hypot(x - w.plaza.x, z - w.plaza.z) < PLAZA_KEEPOUT) return false;
  if (insideRect(w.pool, x, z, 0.8)) return false;
  if (insideRect(w.deck, x, z, 0.4) && !allowTops) return false;
  if (insideRect(w.house, x, z, 0.6)) return false;
  for (const zo of w.zones) {
    if (Math.hypot(x - zo.x, z - zo.z) >= zo.r) continue;
    if (allowTops && w.solids.some((s) => s.h > 0 && Math.hypot(x - s.x, z - s.z) < s.r)) continue;
    return false;
  }
  return true;
}

/**
 * Per-stage fixture counts. Everything a count places goes through the same
 * blocker/zone/solid machinery, so stages inherit every safety guarantee.
 * Plaza, NPC, spawns and the edge structures are computed BEFORE any knob is
 * consumed — they are identical across stages for the same seed.
 */
const STAGE_KNOBS = [
  { trees: 9, beds: 11, benches: 3, clouds: 6 }, // backyard
  { trees: 13, beds: 8, benches: 5, clouds: 5 }, // city park
  { trees: 6, beds: 4, benches: 2, clouds: 8 }, // beach cove
];

export function generateWorld(seed: number, stage = 0): World {
  const rng = mulberry32(seed);
  const knobs = STAGE_KNOBS[stage] ?? STAGE_KNOBS[0];

  // Party plaza (jumbotron + NPC) at the middle of a seeded edge.
  const edge = randInt(rng, 0, 4);
  const pInfo = edgeInfo(edge);
  const pAlong = randRange(rng, -HALF * 0.4, HALF * 0.4);
  const px = pInfo.wx + pInfo.nx * 3 + pInfo.tx * pAlong;
  const pz = pInfo.wz + pInfo.nz * 3 + pInfo.tz * pAlong;
  const facing = Math.atan2(-px, -pz);
  const npc = { x: px + Math.sin(facing) * 3, z: pz + Math.cos(facing) * 3 };

  const spawnPoints: { x: number; z: number }[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const a = facing + ((i - (MAX_PLAYERS - 1) / 2) / MAX_PLAYERS) * Math.PI;
    spawnPoints.push({
      x: clampToYard(px + Math.sin(a) * SPAWN_RING_RADIUS),
      z: clampToYard(pz + Math.cos(a) * SPAWN_RING_RADIUS),
    });
  }

  // House + deck against the opposite wall, pool beyond the deck.
  const houseEdge = (edge + 2) % 4;
  const hInfo = edgeInfo(houseEdge);
  const houseLat = randRange(rng, -3, 3);
  const house = edgeRect(houseEdge, houseLat, 1.2, 26, 2.4);
  // deck shifts away from the garage side so the driveway lane stays clear
  const deck = edgeRect(houseEdge, houseLat + randRange(rng, 0.5, 3), 2.4 + 3.6, 15, 7.2);
  const poolLat = houseLat + randRange(rng, -2, 6);
  const poolDepthIn = 2.4 + 7.2 + 2 + 4.5 + randRange(rng, 0, 3);
  const pool = edgeRect(houseEdge, poolLat, poolDepthIn, 5.5, 9);
  // driveway runs from the garage doors into the yard, car parked on it
  const driveLat = houseLat - 9.5;
  const driveway = edgeRect(houseEdge, driveLat, 2.4 + 4.5, 4.2, 9);
  const carRot = Math.atan2(hInfo.nx, hInfo.nz);
  const car = {
    x: driveway.x + hInfo.nx * randRange(rng, -1.2, 1.2),
    z: driveway.z + hInfo.nz * randRange(rng, -1.2, 1.2),
    rot: carRot + randRange(rng, -0.06, 0.06),
    hue: randRange(rng, 0, 360),
  };

  // Playground on one side fence, basketball hoop on the other.
  const sideA = (edge + 1) % 4;
  const sideB = (edge + 3) % 4;
  const playSide = rng() < 0.5 ? sideA : sideB;
  const hoopSide = playSide === sideA ? sideB : sideA;
  const pgInfo = edgeInfo(playSide);
  const pgLat = randRange(rng, -HALF * 0.35, HALF * 0.35);
  const playground = {
    x: pgInfo.wx + pgInfo.nx * 6 + pgInfo.tx * pgLat,
    z: pgInfo.wz + pgInfo.nz * 6 + pgInfo.tz * pgLat,
    rot: Math.atan2(pgInfo.nx, pgInfo.nz),
  };
  const hpInfo = edgeInfo(hoopSide);
  const hpLat = randRange(rng, -HALF * 0.35, HALF * 0.35);
  const hoop = {
    x: hpInfo.wx + hpInfo.nx * 3.4 + hpInfo.tx * hpLat,
    z: hpInfo.wz + hpInfo.nz * 3.4 + hpInfo.tz * hpLat,
    rot: Math.atan2(hpInfo.nx, hpInfo.nz),
  };

  // --- extra fixtures, placed with a running blocker list so nothing overlaps ---
  const blockers: { x: number; z: number; r: number }[] = [
    { x: px, z: pz, r: PLAZA_KEEPOUT + 3 },
    { x: pool.x, z: pool.z, r: 7 },
    { x: deck.x, z: deck.z, r: 9 },
    { x: house.x, z: house.z, r: 14 },
    { x: driveway.x, z: driveway.z, r: 6 },
    { x: playground.x, z: playground.z, r: 7 },
    { x: hoop.x, z: hoop.z, r: 5 },
  ];
  const pickSpot = (selfR: number, inset = 6): { x: number; z: number } => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = randRange(rng, -HALF + inset, HALF - inset);
      const z = randRange(rng, -HALF + inset, HALF - inset);
      if (blockers.every((b) => Math.hypot(x - b.x, z - b.z) >= b.r + selfR)) {
        blockers.push({ x, z, r: selfR });
        return { x, z };
      }
    }
    // random sampling exhausted: deterministic sweep for the spot with the
    // MOST clearance — never dump a fixture on top of another one (the grid
    // must be fine enough that clear pockets between blockers are found)
    let best = { x: 0, z: 0 };
    let bestClear = -Infinity;
    for (let gx = -HALF + inset; gx <= HALF - inset; gx += 1.25) {
      for (let gz = -HALF + inset; gz <= HALF - inset; gz += 1.25) {
        let clear = Infinity;
        for (const b of blockers) clear = Math.min(clear, Math.hypot(gx - b.x, gz - b.z) - b.r);
        if (clear > bestClear) {
          bestClear = clear;
          best = { x: gx, z: gz };
        }
      }
    }
    blockers.push({ x: best.x, z: best.z, r: selfR });
    return best;
  };

  // shed in the corner between the house wall and the hoop's fence
  const dir = -Math.sign(hInfo.tx * hpInfo.nx + hInfo.tz * hpInfo.nz) || 1;
  const shed = {
    x: hInfo.wx + hInfo.nx * 3.2 + hInfo.tx * dir * (HALF - 3.6),
    z: hInfo.wz + hInfo.nz * 3.2 + hInfo.tz * dir * (HALF - 3.6),
    rot: 0,
  };
  shed.rot = Math.atan2(-shed.x, -shed.z);
  blockers.push({ x: shed.x, z: shed.z, r: 4 });

  // sandbox with sandcastle beside the playground
  const spDir = pgLat > 0 ? -1 : 1;
  const sandpit = {
    x: playground.x + pgInfo.tx * spDir * 6.2,
    z: playground.z + pgInfo.tz * spDir * 6.2,
    r: 2.1,
  };
  blockers.push({ x: sandpit.x, z: sandpit.z, r: 3.4 });

  // doghouse tucked against the house, past the door end — fixed position, so
  // it must be a blocker BEFORE the pickSpot wave (playground2 once landed on it)
  const doghouse = {
    x: hInfo.wx + hInfo.nx * 4 + hInfo.tx * (houseLat + 14),
    z: hInfo.wz + hInfo.nz * 4 + hInfo.tz * (houseLat + 14),
    rot: Math.atan2(hInfo.nx, hInfo.nz),
  };
  blockers.push({ x: doghouse.x, z: doghouse.z, r: 2 });
  // bbq + picnic land in a house-relative band computed AFTER this wave (their
  // randRanges must keep their place in the RNG stream) — reserve the whole
  // possible band now so no picked fixture can end up under them
  blockers.push({
    x: hInfo.wx + hInfo.nx * 7 + hInfo.tx * (houseLat + 11.25),
    z: hInfo.wz + hInfo.nz * 7 + hInfo.tz * (houseLat + 11.25),
    r: 5, // covers bbq/picnic extents + the planter nudge (worst case 4.81)
  });

  // Picked fixtures, LARGEST footprint first: on crowded stages (the park's
  // 13 trees) a small-first order could exhaust sampling for the playground
  // or pond and fall back onto another fixture — small items always find a
  // pocket, and any residual fallback overlap shrinks with fixture size.
  const playground2 = { ...pickSpot(6), rot: randRange(rng, 0, Math.PI * 2) };
  const pondSpot = pickSpot(5.5);
  const pond = { ...pondSpot, r: randRange(rng, 2.6, 3.4) };
  const soccer = { ...pickSpot(5), rot: randRange(rng, 0, Math.PI * 2) };
  const trees: { x: number; z: number; s: number }[] = [];
  for (let i = 0; i < knobs.trees; i++) {
    const spot = pickSpot(4.2);
    trees.push({ ...spot, s: randRange(rng, 0.85, 1.4) });
  }
  const shed2 = { ...pickSpot(4), rot: randRange(rng, 0, Math.PI * 2) };
  const car2 = { ...pickSpot(3.5), rot: randRange(rng, 0, Math.PI * 2), hue: randRange(rng, 0, 360) };
  const trampoline = pickSpot(3.2);
  const clothesline = { ...pickSpot(3.2), rot: randRange(rng, 0, Math.PI * 2) };
  const veggie = { ...pickSpot(3), rot: randRange(rng, 0, Math.PI * 2) };
  const benches: { x: number; z: number; rot: number }[] = [];
  for (let i = 0; i < knobs.benches; i++) {
    benches.push({ ...pickSpot(2), rot: randRange(rng, 0, Math.PI * 2) });
  }
  const birdbath = pickSpot(2);
  const mowerSpot = pickSpot(1.6);
  const mower = { ...mowerSpot, rot: randRange(rng, 0, Math.PI * 2) };
  const clouds: { x: number; y: number; z: number; s: number }[] = [];
  for (let i = 0; i < knobs.clouds; i++) {
    clouds.push({
      x: randRange(rng, -HALF, HALF),
      y: randRange(rng, 16, 26),
      z: randRange(rng, -HALF, HALF),
      s: randRange(rng, 1.1, 2.4),
    });
  }

  // grill + picnic table on the deck's far side, party-adjacent
  const bbqLat = houseLat + randRange(rng, 10.5, 12);
  const bbq = {
    x: hInfo.wx + hInfo.nx * randRange(rng, 4.5, 6) + hInfo.tx * bbqLat,
    z: hInfo.wz + hInfo.nz * randRange(rng, 4.5, 6) + hInfo.tz * bbqLat,
    rot: Math.atan2(hInfo.nx, hInfo.nz),
  };
  const picnic = {
    x: bbq.x + hInfo.nx * 3.4 + hInfo.tx * randRange(rng, -1, 1),
    z: bbq.z + hInfo.nz * 3.4 + hInfo.tz * randRange(rng, -1, 1),
    rot: randRange(rng, 0, Math.PI * 2),
  };
  // Local offset -> world for a fixture rendered with three.js rotation.y=rot
  // (shared by the prop keep-outs below and the player colliders further down).
  const rotXZ = (cx: number, cz: number, rot: number, lx: number, lz: number): { x: number; z: number } => ({
    x: cx + lx * Math.cos(rot) + lz * Math.sin(rot),
    z: cz - lx * Math.sin(rot) + lz * Math.cos(rot),
  });
  const deckRot = [0, -Math.PI / 2, Math.PI, Math.PI / 2][houseEdge];
  // pool loungers flank the pool on every stage except the park (duck pond)
  const loungerSpots: { x: number; z: number }[] =
    stage === 1
      ? []
      : [-1, 1].flatMap((side) => [-1.6, 0.6].map((dz) => ({ x: pool.x + side * (pool.w / 2 + 1.4), z: pool.z + dz })));
  // the picnic table (collider r1.2) must clear the deck's planter tubs (r0.5)
  // — push it radially away just far enough, never a big blind jump
  for (const lx of [-6.6, 6.6]) {
    const p = rotXZ(deck.x, deck.z, deckRot, lx, 2.9);
    const d = Math.hypot(picnic.x - p.x, picnic.z - p.z);
    if (d < 1.8) {
      const k = (1.8 - d) / Math.max(d, 0.001);
      picnic.x += (picnic.x - p.x) * k;
      picnic.z += (picnic.z - p.z) * k;
    }
  }
  blockers.push({ x: bbq.x, z: bbq.z, r: 2 }, { x: picnic.x, z: picnic.z, r: 3 });

  // one prop keep-out circle per solid fixture
  // prop keep-outs sized to the RENDERED mesh extents + max prop radius, so
  // scattered decoys can never spawn intersecting a fixture (the swing set
  // reaches 5.1m from the playground center, a rotated car's corner 2.24m...)
  const zones: { x: number; z: number; r: number }[] = [
    { x: playground.x, z: playground.z, r: 5.8 }, // swing A-frame solids reach 5.65m
    { x: hoop.x, z: hoop.z, r: 2 },
    { x: car.x, z: car.z, r: 2.8 },
    { x: car2.x, z: car2.z, r: 2.8 },
    { x: shed.x, z: shed.z, r: 2.6 },
    { x: shed2.x, z: shed2.z, r: 2.6 },
    { x: sandpit.x, z: sandpit.z, r: 1.3 },
    { x: trampoline.x, z: trampoline.z, r: 2.3 },
    { x: bbq.x, z: bbq.z, r: 1.1 },
    { x: picnic.x, z: picnic.z, r: 1.8 },
    { x: mower.x, z: mower.z, r: 0.9 },
    { x: playground2.x, z: playground2.z, r: 5.8 },
    { x: pond.x, z: pond.z, r: pond.r + 0.5 },
    { x: soccer.x, z: soccer.z, r: 2.2 },
    { x: doghouse.x, z: doghouse.z, r: 1.5 },
    { x: birdbath.x, z: birdbath.z, r: 0.8 },
    { x: clothesline.x, z: clothesline.z, r: 2.2 },
    { x: veggie.x, z: veggie.z, r: 2.4 },
    ...benches.map((b) => ({ x: b.x, z: b.z, r: 1.4 })),
    ...trees.map((t) => ({ x: t.x, z: t.z, r: 0.7 * t.s })),
    // loungers + deck planters get keep-outs so beds/props never spawn inside them
    ...loungerSpots.map((p) => ({ ...p, r: 1.4 })),
    ...[-6.6, 6.6].map((lx) => ({ ...rotXZ(deck.x, deck.z, deckRot, lx, 2.9), r: 1.0 })),
  ];

  const world: World = {
    seed,
    stage,
    props: [],
    plaza: { x: px, z: pz, facing },
    npc,
    spawnPoints,
    houseEdge,
    house,
    deck,
    pool,
    playground,
    hoop,
    driveway,
    car,
    car2,
    shed,
    shed2,
    sandpit,
    trampoline,
    bbq,
    picnic,
    mower,
    playground2,
    pond,
    soccer,
    doghouse,
    birdbath,
    clothesline,
    veggie,
    benches,
    clouds,
    trees,
    hedges: [],
    beds: [],
    zones,
    solids: [],
  };

  // Hedges (cypress) along the side fences AND the plaza fence, skipping structures.
  for (const side of [sideA, sideB, edge]) {
    const info = edgeInfo(side);
    for (let a = -HALF + 4; a <= HALF - 4; a += randRange(rng, 3.0, 4.4)) {
      const hx = info.wx + info.nx * 1.6 + info.tx * a;
      const hz = info.wz + info.nz * 1.6 + info.tz * a;
      if (Math.hypot(hx - playground.x, hz - playground.z) < 6.5) continue;
      if (Math.hypot(hx - playground2.x, hz - playground2.z) < 6.5) continue;
      if (Math.hypot(hx - hoop.x, hz - hoop.z) < 4) continue;
      if (Math.hypot(hx - px, hz - pz) < PLAZA_KEEPOUT + 1) continue;
      if (Math.hypot(hx - sandpit.x, hz - sandpit.z) < 4) continue;
      if (Math.hypot(hx - shed.x, hz - shed.z) < 4.5) continue;
      // hedges are solid — never let one crowd a spawn point
      if (spawnPoints.some((sp) => Math.hypot(hx - sp.x, hz - sp.z) < 2.4)) continue;
      world.hedges.push({ x: hx, z: hz, s: randRange(rng, 0.8, 1.35) });
    }
  }
  // A few bushes flanking the house — kept at ±12.5 lateral so they clear
  // both the doghouse (lateral +14) and the driveway lane (around -9.5).
  for (const off of [-1, 1]) {
    const bx = house.x + (houseEdge % 2 === 0 ? off * 12.5 : hInfo.nx * 2.2);
    const bz = house.z + (houseEdge % 2 === 0 ? hInfo.nz * 2.2 : off * 12.5);
    // skip a flank bush that generation crowded against a playground's gear
    if (Math.hypot(bx - playground.x, bz - playground.z) < 6.5) continue;
    if (Math.hypot(bx - playground2.x, bz - playground2.z) < 6.5) continue;
    world.hedges.push({ x: bx, z: bz, s: randRange(rng, 0.7, 1.0) });
  }

  // Garden beds with flowers. Their center bush becomes a solid, so the bed
  // must clear every fixture zone, hedge and earlier bed by its own radius —
  // no shrub may spawn intersecting anything else.
  for (let i = 0; i < knobs.beds; i++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const bx = randRange(rng, -HALF + 4, HALF - 4);
      const bz = randRange(rng, -HALF + 4, HALF - 4);
      const br = randRange(rng, 1.1, 1.9);
      if (!placementValid(world, bx, bz)) continue;
      const bushR = 0.55 * br;
      const bushX = bx - br * 0.25; // the solid shrub sits off-center in the bed
      // deck sofas sit up to 0.65m inside the deck edge and aren't zones —
      // keep the whole bush off the deck rect so it can never reach them
      if (insideRect(world.deck, bushX, bz, bushR + 0.2)) continue;
      if (!world.zones.every((zo) => Math.hypot(bushX - zo.x, bz - zo.z) >= zo.r + bushR)) continue;
      if (!world.hedges.every((hg) => Math.hypot(bushX - hg.x, bz - hg.z) >= 0.5 * hg.s + bushR + 0.2)) continue;
      if (!world.beds.every((b2) => Math.hypot(bx - b2.x, bz - b2.z) >= br + b2.r + 0.3)) continue;
      world.beds.push({ x: bx, z: bz, r: br, hue: randRange(rng, 0, 360) });
      break;
    }
  }

  // Player-blocking colliders (hedges exist by now; pool/house block as
  // rects). h > 0 = flat standable top you can jump onto / place objects on.
  // Playground pieces (local coords match scene.ts buildPlayground): swing
  // A-frame ends, slide tower + chute, seesaw. The space under the swing bar
  // stays walkable — you'd duck through the swings in real life too.
  const playgroundSolids = (pg: { x: number; z: number; rot: number }): { x: number; z: number; r: number; h: number }[] => [
    { ...rotXZ(pg.x, pg.z, pg.rot, -5.1, 0), r: 0.55, h: 0 },
    { ...rotXZ(pg.x, pg.z, pg.rot, -1.7, 0), r: 0.55, h: 0 },
    { ...rotXZ(pg.x, pg.z, pg.rot, 2.6, -0.75), r: 0.85, h: 0 },
    { ...rotXZ(pg.x, pg.z, pg.rot, 2.6, 0.9), r: 0.55, h: 0 },
    { ...rotXZ(pg.x, pg.z, pg.rot, 0.2, 2.6), r: 1.1, h: 0 },
  ];
  // Deck furniture (local coords match scene.ts buildDeck; the deck group uses
  // the same per-edge rotation as edgeRect): sofas + coffee table + planters.
  const deckSolids: { x: number; z: number; r: number; h: number }[] = [
    // side sofas at local (±3.6, 0.4), long axis along local z after their ±90° turn
    ...[-3.6, 3.6].flatMap((sx) =>
      [-0.7, 0.7].map((sz) => ({ ...rotXZ(deck.x, deck.z, deckRot, sx, 0.4 + sz), r: 0.6, h: 1.1 }))
    ),
    ...[-0.9, 0.9].map((sx) => ({ ...rotXZ(deck.x, deck.z, deckRot, sx, 2.3), r: 0.65, h: 1.1 })), // long sofa
    { ...rotXZ(deck.x, deck.z, deckRot, 0, 0.2), r: 0.85, h: 0.98 }, // coffee table
    ...[-6.6, 6.6].map((lx) => ({ ...rotXZ(deck.x, deck.z, deckRot, lx, 2.9), r: 0.5, h: 0 })), // planters
  ];
  world.solids = [
    ...playgroundSolids(playground),
    ...playgroundSolids(playground2),
    ...deckSolids,
    ...loungerSpots.map((p) => ({ ...p, r: 0.7, h: 0.5 })),
    // thin poles: soccer posts, hoop pole, clothesline poles, jumbotron posts
    ...[-1.5, 1.5].map((px) => ({ ...rotXZ(soccer.x, soccer.z, soccer.rot, px, 0), r: 0.15, h: 0 })),
    { ...rotXZ(hoop.x, hoop.z, hoop.rot, 0, -0.3), r: 0.2, h: 0 },
    ...[-1.8, 1.8].map((px) => ({ ...rotXZ(clothesline.x, clothesline.z, clothesline.rot, px, 0), r: 0.15, h: 0 })),
    ...[-2.6, 2.6].map((lx) => ({ ...rotXZ(px, pz, facing, lx, 0), r: 0.3, h: 0 })),
    { x: mower.x, z: mower.z, r: 0.5, h: 0 },
    // car collider must cover the rotated body's corners (half-diag ~2.05)
    { x: car.x, z: car.z, r: 2.0, h: 0.95 },
    { x: car2.x, z: car2.z, r: 2.0, h: 0.95 },
    { x: shed.x, z: shed.z, r: 1.9, h: 0 }, // pitched roof — no standing
    { x: shed2.x, z: shed2.z, r: 1.9, h: 0 },
    { x: pond.x, z: pond.z, r: pond.r, h: 0 }, // no wading
    { x: doghouse.x, z: doghouse.z, r: 0.9, h: 0.95 },
    { x: birdbath.x, z: birdbath.z, r: 0.5, h: 0 },
    { x: bbq.x, z: bbq.z, r: 0.55, h: 0 },
    { x: picnic.x, z: picnic.z, r: 1.2, h: 0.78 },
    { x: trampoline.x, z: trampoline.z, r: 1.75, h: 0.85 },
    { x: veggie.x, z: veggie.z, r: 1.8, h: 0.42 },
    ...benches.map((b) => ({ x: b.x, z: b.z, r: 0.8, h: 0.5 })),
    ...trees.map((t) => ({ x: t.x, z: t.z, r: 0.5 * t.s, h: 0 })),
    ...world.hedges.map((h) => ({ x: h.x, z: h.z, r: 0.5 * h.s, h: 0 })),
    // garden-bed bushes are chest-high shrubs — players shouldn't stand in them
    ...world.beds.map((b) => ({ x: b.x - b.r * 0.25, z: b.z, r: 0.55 * b.r, h: 0 })),
  ];

  // NPC-reachability grid: BFS over walkable 0.5m cells from the NPC (the
  // same sweep worldcheck asserts with). Hedge rings + fixtures can fence in
  // a corner — a spawn must never live in such a pocket.
  const RCELL = 0.5;
  const RN = Math.floor(MAP_SIZE / RCELL);
  const rcell = (v: number): number => Math.min(RN - 1, Math.max(0, Math.floor((v + HALF) / RCELL)));
  const seen = new Uint8Array(RN * RN);
  const reach = new Uint8Array(RN * RN);
  {
    const queue: number[] = [rcell(npc.z) * RN + rcell(npc.x)];
    seen[queue[0]] = 1;
    reach[queue[0]] = 1;
    while (queue.length) {
      const idx = queue.pop()!;
      const cx = idx % RN;
      const cz = (idx - cx) / RN;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= RN || nz >= RN) continue;
        const nIdx = nz * RN + nx;
        if (seen[nIdx]) continue;
        seen[nIdx] = 1;
        const wx = -HALF + (nx + 0.5) * RCELL;
        const wz = -HALF + (nz + 0.5) * RCELL;
        if (Math.abs(wx) > HALF - 1 || Math.abs(wz) > HALF - 1) continue;
        if (blockedAt(world, wx, wz)) continue;
        reach[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  // Spawn safety: with the full collider set known, no spawn point may sit
  // inside (or touching) anything unpassable, within SPAWN_MIN_GAP of another
  // spawn (yard clamping and relocation can both pinch neighbours), or in a
  // pocket that can't reach the NPC — relocate to the nearest good spot.
  for (let si = 0; si < world.spawnPoints.length; si++) {
    const sp = world.spawnPoints[si];
    const crowded = (x: number, z: number): boolean =>
      world.spawnPoints.some(
        (o, oi) => oi !== si && Math.hypot(x - o.x, z - o.z) < SPAWN_MIN_GAP,
      );
    const good = (x: number, z: number): boolean =>
      !blockedAt(world, x, z, 0.3) && !crowded(x, z) && reach[rcell(z) * RN + rcell(x)] === 1;
    if (good(sp.x, sp.z)) continue;
    let moved = false;
    for (let r = 0.8; r <= 14 && !moved; r += 0.8) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const nx = clampToYard(sp.x + Math.cos(a) * r);
        const nz = clampToYard(sp.z + Math.sin(a) * r);
        if (good(nx, nz)) {
          sp.x = nx;
          sp.z = nz;
          moved = true;
          break;
        }
      }
    }
  }

  // Decoy scatter: jittered grid over every legal lawn spot.
  let nextId = 0;
  const cells = Math.floor(MAP_SIZE / SCATTER_CELL);
  for (let cx = 0; cx < cells; cx++) {
    for (let cz = 0; cz < cells; cz++) {
      if (rng() >= SCATTER_FILL) continue;
      const x = -HALF + (cx + 0.15 + rng() * 0.7) * SCATTER_CELL;
      const z = -HALF + (cz + 0.15 + rng() * 0.7) * SCATTER_CELL;
      if (!scatterOk(world, x, z)) continue;
      world.props.push(makeProp(nextId++, rng, x, z));
    }
  }

  // Guarantee every archetype has enough decoys for natural cover.
  const counts = new Array<number>(ARCHETYPES.length).fill(0);
  for (const p of world.props) counts[p.archetype]++;
  for (let a = 0; a < ARCHETYPES.length; a++) {
    while (counts[a] < MIN_DECOYS_PER_ARCHETYPE) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const x = randRange(rng, -HALF + 2, HALF - 2);
        const z = randRange(rng, -HALF + 2, HALF - 2);
        if (!scatterOk(world, x, z)) continue;
        const p = makeProp(nextId++, rng, x, z);
        p.archetype = a;
        world.props.push(p);
        break;
      }
      counts[a]++;
    }
  }

  return world;
}

function scatterOk(w: World, x: number, z: number): boolean {
  if (!placementValid(w, x, z)) return false;
  for (const s of w.spawnPoints) {
    if (Math.hypot(x - s.x, z - s.z) < SPAWN_KEEPOUT) return false;
  }
  for (const h of w.hedges) {
    if (Math.hypot(x - h.x, z - h.z) < 1.2) return false;
  }
  for (const b of w.beds) {
    if (Math.hypot(x - b.x, z - b.z) < b.r + 0.4) return false;
  }
  return true;
}

function makeProp(propId: number, rng: () => number, x: number, z: number): WorldProp {
  return {
    propId,
    archetype: randInt(rng, 0, ARCHETYPES.length),
    hue: randRange(rng, 0, 360),
    scale: randRange(rng, SCALE_MIN, SCALE_MAX),
    x,
    z,
    rotY: randRange(rng, 0, Math.PI * 2),
  };
}

function clampToYard(v: number): number {
  return Math.min(HALF - 1, Math.max(-HALF + 1, v));
}
