/**
 * Pure gameplay rules — no I/O, no Durable Object APIs, unit-testable.
 * All positions are server-truth (client-reported, already clamped).
 */

import {
  ALLOW_SELF_GRAB,
  GRAB_RADIUS,
  NPC_RADIUS,
  PLAYER_RADIUS,
  STUN_RANGE,
  type ErrCode,
} from "@bringme/shared";

export interface RulePlayer {
  id: number;
  x: number;
  z: number;
  yaw: number;
  carry: number; // propId or -1
  stunnedUntil: number;
  stunCdUntil: number;
}

export interface RuleTarget {
  propId: number;
  creatorId: number;
  x: number;
  z: number;
  heldBy: number; // playerId or 0
  airborne: boolean;
  lockUntil: number;
  lockedFor: number; // playerId barred from grabbing until lockUntil
}

export function canGrab(p: RulePlayer, t: RuleTarget, now: number): ErrCode | null {
  if (now < p.stunnedUntil) return "stunned";
  if (p.carry !== -1) return "carrying";
  if (t.heldBy !== 0) return "taken";
  if (!ALLOW_SELF_GRAB && p.id === t.creatorId) return "own";
  if (p.id === t.lockedFor && now < t.lockUntil) return "locked";
  if (Math.hypot(t.x - p.x, t.z - p.z) > GRAB_RADIUS) return "far";
  return null;
}

/** Nearest other player within stun range, or 0. */
export function nearestStunVictim(players: Iterable<RulePlayer>, by: RulePlayer, now: number): number {
  let best = 0;
  let bestD = STUN_RANGE;
  for (const p of players) {
    if (p.id === by.id) continue;
    if (now < p.stunnedUntil) continue; // no stun-locking a stunned player
    const d = Math.hypot(p.x - by.x, p.z - by.z);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

export function canStun(p: RulePlayer, now: number): ErrCode | null {
  if (now < p.stunnedUntil) return "stunned";
  if (now < p.stunCdUntil) return "cooldown";
  return null;
}

/** Carried delivery: carrier body overlaps the NPC. */
export function carriedDelivery(carrier: RulePlayer, npcX: number, npcZ: number): boolean {
  return Math.hypot(carrier.x - npcX, carrier.z - npcZ) < NPC_RADIUS + PLAYER_RADIUS;
}

/** Thrown delivery: airborne prop passes through the NPC's hit sphere. */
export function airborneDelivery(
  x: number,
  y: number,
  z: number,
  npcX: number,
  npcZ: number,
): boolean {
  return Math.hypot(x - npcX, z - npcZ) < NPC_RADIUS && y >= 0 && y <= 2.2;
}
