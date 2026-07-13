/**
 * Shared movement + throw ballistics. The client integrates its own blob with
 * stepMove; the server uses the same constants to clamp reported positions and
 * runs the same ballistic step so thrown arcs match on both sides.
 */

import {
  MAP_SIZE,
  PLAYER_RADIUS,
  GRAVITY,
  PROP_REST_Y,
  THROW_MIN_SPEED,
  THROW_MAX_SPEED,
  THROW_UP_RATIO,
} from "./constants.ts";
import { blockedAt, groundHeightAt, type World } from "./worldgen.ts";

const HALF = MAP_SIZE / 2;

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * Integrate one movement step. dir is a world-space direction (not necessarily
 * normalized; it is normalized here so diagonals aren't faster). With a world,
 * solid fixtures block — resolved per-axis so you slide along obstacles
 * instead of sticking to them.
 */
export function stepMove(pos: Vec2, dir: Vec2, speed: number, dt: number, world?: World, y = 0): Vec2 {
  const len = Math.hypot(dir.x, dir.z);
  if (len < 1e-6) return { x: pos.x, z: pos.z };
  const nx = dir.x / len;
  const nz = dir.z / len;
  let x = clampToMap(pos.x + nx * speed * dt);
  let z = clampToMap(pos.z + nz * speed * dt);
  if (world) {
    // safety net: if we're somehow ALREADY inside a collider (bad spawn, old
    // save, future bug), collision must never cage us — move freely until out
    if (blockedAt(world, pos.x, pos.z, 0, y)) return { x, z };
    if (blockedAt(world, x, pos.z, 0, y)) x = pos.x;
    if (blockedAt(world, x, z, 0, y)) z = pos.z;
    // movement fully blocked by a round obstacle: axis separation alone
    // sticks, so deflect along the circle's tangent (whichever side matches
    // intent). Probe the REJECTED destination — the contact can be beside the
    // heading (sliding past the equator), not ahead of it.
    if (Math.abs(x - pos.x) < 1e-4 && Math.abs(z - pos.z) < 1e-4) {
      const probeX = pos.x + nx * speed * dt;
      const probeZ = pos.z + nz * speed * dt;
      for (const s of world.solids) {
        if (Math.hypot(probeX - s.x, probeZ - s.z) >= s.r + PLAYER_RADIUS) continue;
        if (s.h > 0 && y >= s.h - 0.05) continue; // we're on top of it
        const rx = pos.x - s.x;
        const rz = pos.z - s.z;
        const rl = Math.hypot(rx, rz) || 1;
        let tx = -rz / rl;
        let tz = rx / rl;
        if (tx * nx + tz * nz < 0) {
          tx = -tx;
          tz = -tz;
        }
        const sx = clampToMap(pos.x + tx * speed * dt);
        const sz = clampToMap(pos.z + tz * speed * dt);
        if (!blockedAt(world, sx, sz, 0, y)) {
          x = sx;
          z = sz;
        }
        break;
      }
    }
  }
  return { x, z };
}

export function clampToMap(v: number): number {
  const lim = HALF - PLAYER_RADIUS;
  return Math.min(lim, Math.max(-lim, v));
}

export interface Ballistic {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** true once the prop has landed and stopped */
  resting: boolean;
}

/** Initial velocity for a throw. dir is horizontal, power in [0,1]. */
export function throwVelocity(dirX: number, dirZ: number, power: number): { vx: number; vy: number; vz: number } {
  const p = Math.min(1, Math.max(0, power));
  const speed = THROW_MIN_SPEED + (THROW_MAX_SPEED - THROW_MIN_SPEED) * p;
  const len = Math.hypot(dirX, dirZ) || 1;
  return {
    vx: (dirX / len) * speed,
    vy: speed * THROW_UP_RATIO,
    vz: (dirZ / len) * speed,
  };
}

/**
 * Step a thrown prop by dt. Mutates and returns b. Stops on ground contact —
 * with a world, that includes standable fixture tops (a throw can land on a
 * car roof).
 */
export function stepBallistic(b: Ballistic, dt: number, world?: World): Ballistic {
  if (b.resting) return b;
  b.vy -= GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  let ground = world ? groundHeightAt(world, b.x, b.z, Math.max(b.y, 0), 0.05) : 0;
  if (b.y <= ground + PROP_REST_Y && b.vy < 0) {
    if (world) {
      // Never rest INSIDE a solid fixture (a thrown can perched through the
      // mower's engine): unless the prop landed on the solid's own top, nudge
      // it out to the fixture's edge, then re-read the surface there. Swept
      // a few times — in clusters (playground) one push can enter a neighbour.
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (const s of world.solids) {
          if (s.h > 0 && ground >= s.h - 0.01) continue; // resting on its top
          const min = s.r + 0.25;
          const d = Math.hypot(b.x - s.x, b.z - s.z) || 0.001;
          if (d >= min) continue;
          b.x = s.x + ((b.x - s.x) / d) * min;
          b.z = s.z + ((b.z - s.z) / d) * min;
          moved = true;
        }
        if (!moved) break;
      }
      ground = groundHeightAt(world, b.x, b.z, Math.max(b.y, 0), 0.05);
    }
    b.y = ground + PROP_REST_Y;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.resting = true;
  }
  // Walls stop throws dead (no bounce, keeps server/client trivially in sync).
  const lim = HALF - 0.2;
  if (Math.abs(b.x) > lim || Math.abs(b.z) > lim) {
    b.x = Math.min(lim, Math.max(-lim, b.x));
    b.z = Math.min(lim, Math.max(-lim, b.z));
    b.vx = 0;
    b.vz = 0;
  }
  return b;
}
