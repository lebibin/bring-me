import { describe, expect, it } from "vitest";
import {
  BOT_SKILL_MAX,
  BOT_SKILL_MIN,
  NPC_RADIUS,
  PLAYER_SPEED,
  STAGES,
  generateWorld,
  stepMove,
} from "@bringme/shared";
import { FlowField, newBot } from "../src/bots.ts";

describe("bot flow-field navigation", () => {
  it("routes every spawn point all the way to the NPC", () => {
    // The field must give bots a walkable path from anywhere they can spawn to
    // the delivery NPC — the same guarantee worldcheck asserts for players.
    for (let s = 1; s <= 24; s++) {
      const seed = (s * 2654435761) >>> 0;
      for (let stage = 0; stage < STAGES.length; stage++) {
        const w = generateWorld(seed, stage);
        const field = new FlowField(w, w.npc.x, w.npc.z);
        for (const sp of w.spawnPoints) {
          let pos = { x: sp.x, z: sp.z };
          let arrived = false;
          for (let i = 0; i < 4000; i++) {
            if (Math.hypot(pos.x - w.npc.x, pos.z - w.npc.z) < NPC_RADIUS) {
              arrived = true;
              break;
            }
            const dir = field.dirAt(pos.x, pos.z) ?? { x: w.npc.x - pos.x, z: w.npc.z - pos.z };
            pos = stepMove(pos, dir, PLAYER_SPEED, 1 / 15, w);
          }
          expect(arrived, `seed ${seed} stage ${stage} spawn ${sp.x.toFixed(1)},${sp.z.toFixed(1)}`).toBe(true);
        }
      }
    }
  });

  it("routes a mid-lawn point to an arbitrary target position", () => {
    const w = generateWorld(12345, 0);
    // a legal-ish target somewhere off the plaza
    const goal = { x: 15, z: -15 };
    const field = new FlowField(w, goal.x, goal.z);
    let pos = { x: -18, z: 18 };
    let arrived = false;
    for (let i = 0; i < 4000; i++) {
      if (Math.hypot(pos.x - goal.x, pos.z - goal.z) < 1.5) {
        arrived = true;
        break;
      }
      const dir = field.dirAt(pos.x, pos.z) ?? { x: goal.x - pos.x, z: goal.z - pos.z };
      pos = stepMove(pos, dir, PLAYER_SPEED, 1 / 15, w);
    }
    expect(arrived).toBe(true);
  });
});

describe("bot construction", () => {
  it("assigns a skill inside the configured band", () => {
    for (let i = 0; i < 100; i++) {
      const b = newBot(i * 2654435761);
      expect(b.skill).toBeGreaterThanOrEqual(BOT_SKILL_MIN);
      expect(b.skill).toBeLessThanOrEqual(BOT_SKILL_MAX);
      expect(b.create).toBe("fresh");
    }
  });
});
