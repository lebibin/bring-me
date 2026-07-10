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
import { insideRect, type World } from "./worldgen.ts";

const HALF = MAP_SIZE / 2;

export interface Vec2 {
  x: number;
  z: number;
}

/** Is this spot inside something a player can't walk through? */
export function blockedAt(w: World, x: number, z: number): boolean {
  if (insideRect(w.pool, x, z, PLAYER_RADIUS)) return true;
  if (insideRect(w.house, x, z, PLAYER_RADIUS)) return true;
  for (const s of w.solids) {
    if (Math.hypot(x - s.x, z - s.z) < s.r + PLAYER_RADIUS) return true;
  }
  return false;
}

/**
 * Integrate one movement step. dir is a world-space direction (not necessarily
 * normalized; it is normalized here so diagonals aren't faster). With a world,
 * solid fixtures block — resolved per-axis so you slide along obstacles
 * instead of sticking to them.
 */
export function stepMove(pos: Vec2, dir: Vec2, speed: number, dt: number, world?: World): Vec2 {
  const len = Math.hypot(dir.x, dir.z);
  if (len < 1e-6) return { x: pos.x, z: pos.z };
  const nx = dir.x / len;
  const nz = dir.z / len;
  let x = clampToMap(pos.x + nx * speed * dt);
  let z = clampToMap(pos.z + nz * speed * dt);
  if (world) {
    if (blockedAt(world, x, pos.z)) x = pos.x;
    if (blockedAt(world, x, z)) z = pos.z;
    // movement fully blocked by a round obstacle: axis separation alone
    // sticks, so deflect along the circle's tangent (whichever side matches
    // intent). Probe the REJECTED destination — the contact can be beside the
    // heading (sliding past the equator), not ahead of it.
    if (Math.abs(x - pos.x) < 1e-4 && Math.abs(z - pos.z) < 1e-4) {
      const probeX = pos.x + nx * speed * dt;
      const probeZ = pos.z + nz * speed * dt;
      for (const s of world.solids) {
        if (Math.hypot(probeX - s.x, probeZ - s.z) >= s.r + PLAYER_RADIUS) continue;
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
        if (!blockedAt(world, sx, sz)) {
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

/** Step a thrown prop by dt. Mutates and returns b. Stops on ground contact. */
export function stepBallistic(b: Ballistic, dt: number): Ballistic {
  if (b.resting) return b;
  b.vy -= GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  if (b.y <= PROP_REST_Y && b.vy < 0) {
    b.y = PROP_REST_Y;
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
