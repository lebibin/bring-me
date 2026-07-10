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

const HALF = MAP_SIZE / 2;

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * Integrate one movement step. dir is a world-space direction (not necessarily
 * normalized; it is normalized here so diagonals aren't faster). Returns the
 * new clamped position.
 */
export function stepMove(pos: Vec2, dir: Vec2, speed: number, dt: number): Vec2 {
  const len = Math.hypot(dir.x, dir.z);
  if (len < 1e-6) return { x: pos.x, z: pos.z };
  const nx = dir.x / len;
  const nz = dir.z / len;
  return {
    x: clampToMap(pos.x + nx * speed * dt),
    z: clampToMap(pos.z + nz * speed * dt),
  };
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
