import { describe, expect, it } from "vitest";
import { DELIVER_PTS, GRAB_RADIUS, NPC_RADIUS, STUN_RANGE, UNFOUND_PTS } from "@bringme/shared";
import {
  airborneDelivery,
  canGrab,
  canStun,
  carriedDelivery,
  nearestStunVictim,
  type RulePlayer,
  type RuleTarget,
} from "../src/rules.ts";

const NOW = 1_000_000;

function player(over: Partial<RulePlayer> = {}): RulePlayer {
  return { id: 1, x: 0, z: 0, yaw: 0, carry: -1, stunnedUntil: 0, stunCdUntil: 0, ...over };
}

function target(over: Partial<RuleTarget> = {}): RuleTarget {
  return { propId: 100001, creatorId: 9, x: 1, z: 1, heldBy: 0, airborne: false, lockUntil: 0, lockedFor: 0, ...over };
}

describe("grab rules", () => {
  it("allows a legal grab", () => {
    expect(canGrab(player(), target(), NOW)).toBeNull();
  });
  it("rejects out of range", () => {
    expect(canGrab(player(), target({ x: GRAB_RADIUS + 2, z: 0 }), NOW)).toBe("far");
  });
  it("rejects a held prop", () => {
    expect(canGrab(player(), target({ heldBy: 5 }), NOW)).toBe("taken");
  });
  it("rejects the creator grabbing their own object", () => {
    expect(canGrab(player({ id: 9 }), target(), NOW)).toBe("own");
  });
  it("rejects while stunned", () => {
    expect(canGrab(player({ stunnedUntil: NOW + 500 }), target(), NOW)).toBe("stunned");
  });
  it("rejects while already carrying", () => {
    expect(canGrab(player({ carry: 100001 }), target(), NOW)).toBe("carrying");
  });
  it("enforces the victim drop-lock, for the victim only", () => {
    const t = target({ lockUntil: NOW + 1000, lockedFor: 1 });
    expect(canGrab(player({ id: 1 }), t, NOW)).toBe("locked");
    expect(canGrab(player({ id: 2 }), t, NOW)).toBeNull();
  });
});

describe("stun rules", () => {
  it("respects cooldown and stun state", () => {
    expect(canStun(player(), NOW)).toBeNull();
    expect(canStun(player({ stunCdUntil: NOW + 1 }), NOW)).toBe("cooldown");
    expect(canStun(player({ stunnedUntil: NOW + 1 }), NOW)).toBe("stunned");
  });
  it("picks the nearest victim in range, skipping already-stunned players", () => {
    const by = player({ id: 1 });
    const near = player({ id: 2, x: 1, z: 0 });
    const nearer = player({ id: 3, x: 0.5, z: 0 });
    const far = player({ id: 4, x: STUN_RANGE + 1, z: 0 });
    expect(nearestStunVictim([by, near, nearer, far], by, NOW)).toBe(3);
    const stunnedNearest = player({ id: 3, x: 0.5, z: 0, stunnedUntil: NOW + 1000 });
    expect(nearestStunVictim([by, near, stunnedNearest, far], by, NOW)).toBe(2);
    expect(nearestStunVictim([by, far], by, NOW)).toBe(0);
  });
});

describe("delivery", () => {
  it("carried: carrier overlapping the NPC delivers", () => {
    expect(carriedDelivery(player({ x: 0.5, z: 0 }), 0, 0)).toBe(true);
    expect(carriedDelivery(player({ x: 5, z: 0 }), 0, 0)).toBe(false);
  });
  it("airborne: prop through the hit sphere delivers, ground rolls past it don't", () => {
    expect(airborneDelivery(0.5, 1.0, 0, 0, 0)).toBe(true);
    expect(airborneDelivery(NPC_RADIUS + 0.5, 1.0, 0, 0, 0)).toBe(false);
    expect(airborneDelivery(0.5, 3.0, 0, 0, 0)).toBe(false); // sailed over
  });
  it("point values follow the design: unfound (2) beats a delivery (1)", () => {
    expect(DELIVER_PTS).toBe(1);
    expect(UNFOUND_PTS).toBe(2);
  });
});
