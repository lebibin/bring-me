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

export function generateWorld(seed: number): World {
  const rng = mulberry32(seed);

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
    // MOST clearance — never dump a fixture on top of another one
    let best = { x: 0, z: 0 };
    let bestClear = -Infinity;
    for (let gx = -HALF + inset; gx <= HALF - inset; gx += 2.5) {
      for (let gz = -HALF + inset; gz <= HALF - inset; gz += 2.5) {
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

  const trees: { x: number; z: number; s: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const spot = pickSpot(4.2);
    trees.push({ ...spot, s: randRange(rng, 0.85, 1.4) });
  }
  const trampoline = pickSpot(3.2);
  const mowerSpot = pickSpot(1.6);
  const mower = { ...mowerSpot, rot: randRange(rng, 0, Math.PI * 2) };

  // second wave of fixtures — recolored duplicates + brand-new backyard gear
  const pondSpot = pickSpot(5.5);
  const pond = { ...pondSpot, r: randRange(rng, 2.6, 3.4) };
  const playground2 = { ...pickSpot(6), rot: randRange(rng, 0, Math.PI * 2) };
  const shed2 = { ...pickSpot(4), rot: randRange(rng, 0, Math.PI * 2) };
  const car2 = { ...pickSpot(3.5), rot: randRange(rng, 0, Math.PI * 2), hue: randRange(rng, 0, 360) };
  const soccer = { ...pickSpot(5), rot: randRange(rng, 0, Math.PI * 2) };
  const birdbath = pickSpot(2);
  const clothesline = { ...pickSpot(3.2), rot: randRange(rng, 0, Math.PI * 2) };
  const veggie = { ...pickSpot(3), rot: randRange(rng, 0, Math.PI * 2) };
  const benches = [
    { ...pickSpot(2), rot: randRange(rng, 0, Math.PI * 2) },
    { ...pickSpot(2), rot: randRange(rng, 0, Math.PI * 2) },
    { ...pickSpot(2), rot: randRange(rng, 0, Math.PI * 2) },
  ];
  // doghouse tucked against the house, past the door end
  const doghouse = {
    x: hInfo.wx + hInfo.nx * 4 + hInfo.tx * (houseLat + 14),
    z: hInfo.wz + hInfo.nz * 4 + hInfo.tz * (houseLat + 14),
    rot: Math.atan2(hInfo.nx, hInfo.nz),
  };
  const clouds: { x: number; y: number; z: number; s: number }[] = [];
  for (let i = 0; i < 6; i++) {
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
  blockers.push({ x: bbq.x, z: bbq.z, r: 2 }, { x: picnic.x, z: picnic.z, r: 3 });

  // one prop keep-out circle per solid fixture
  const zones: { x: number; z: number; r: number }[] = [
    { x: playground.x, z: playground.z, r: 4 },
    { x: hoop.x, z: hoop.z, r: 2 },
    { x: car.x, z: car.z, r: 2.4 },
    { x: car2.x, z: car2.z, r: 2.4 },
    { x: shed.x, z: shed.z, r: 2.4 },
    { x: shed2.x, z: shed2.z, r: 2.2 },
    { x: sandpit.x, z: sandpit.z, r: 1.3 },
    { x: trampoline.x, z: trampoline.z, r: 2.2 },
    { x: bbq.x, z: bbq.z, r: 1 },
    { x: picnic.x, z: picnic.z, r: 1.8 },
    { x: mower.x, z: mower.z, r: 0.9 },
    { x: playground2.x, z: playground2.z, r: 4 },
    { x: pond.x, z: pond.z, r: pond.r + 0.5 },
    { x: soccer.x, z: soccer.z, r: 2.2 },
    { x: doghouse.x, z: doghouse.z, r: 1.3 },
    { x: birdbath.x, z: birdbath.z, r: 0.7 },
    { x: clothesline.x, z: clothesline.z, r: 1.6 },
    { x: veggie.x, z: veggie.z, r: 2 },
    ...benches.map((b) => ({ x: b.x, z: b.z, r: 1 })),
    ...trees.map((t) => ({ x: t.x, z: t.z, r: 0.7 * t.s })),
  ];

  const world: World = {
    seed,
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
      if (Math.hypot(hx - playground.x, hz - playground.z) < 6) continue;
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
    world.hedges.push({
      x: house.x + (houseEdge % 2 === 0 ? off * 12.5 : hInfo.nx * 2.2),
      z: house.z + (houseEdge % 2 === 0 ? hInfo.nz * 2.2 : off * 12.5),
      s: randRange(rng, 0.7, 1.0),
    });
  }

  // Garden beds with flowers.
  for (let i = 0; i < 11; i++) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const bx = randRange(rng, -HALF + 4, HALF - 4);
      const bz = randRange(rng, -HALF + 4, HALF - 4);
      if (!placementValid(world, bx, bz)) continue;
      world.beds.push({ x: bx, z: bz, r: randRange(rng, 1.1, 1.9), hue: randRange(rng, 0, 360) });
      break;
    }
  }

  // Player-blocking colliders (hedges exist by now; pool/house block as
  // rects). h > 0 = flat standable top you can jump onto / place objects on.
  world.solids = [
    { x: car.x, z: car.z, r: 1.6, h: 0.95 },
    { x: car2.x, z: car2.z, r: 1.6, h: 0.95 },
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
  ];

  // Spawn safety: with the full collider set known, no spawn point may sit
  // inside (or touching) anything unpassable — relocate to the nearest clear
  // spot if generation ever crowds one.
  for (const sp of world.spawnPoints) {
    if (!blockedAt(world, sp.x, sp.z, 0.3)) continue;
    let moved = false;
    for (let r = 0.8; r <= 14 && !moved; r += 0.8) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const nx = clampToYard(sp.x + Math.cos(a) * r);
        const nz = clampToYard(sp.z + Math.sin(a) * r);
        if (!blockedAt(world, nx, nz, 0.3)) {
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
