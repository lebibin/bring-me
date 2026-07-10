/**
 * Deterministic headless test hook (same pattern as chameleon's __cham):
 * browser tests drive the sim with synthetic input + fixed timesteps, no
 * rendering or real clock involved.
 */

import { CREATED_PROP_ID_BASE, generateWorld, type World } from "@bringme/shared";
import { hasComponent } from "bitecs";
import type { Game } from "../game.ts";
import type { NetClient } from "../net/client.ts";
import { world } from "../ecs/world.ts";
import { CarriedBy, Position, Prop, Yaw } from "../ecs/components.ts";
import { input } from "../ecs/input.ts";
import { localEid } from "../ecs/systems.ts";

export interface BringMeHook {
  pos(): { x: number; z: number };
  yaw(): number;
  setInput(forward: number, strafe: number, camYaw?: number): void;
  step(n: number, dt: number): void;
  /** Manually pump full frames (sim + interp + render) — rAF freezes in hidden tabs. */
  frame(n: number, dt: number): void;
  /** Apply remote-player interpolation only (no render) — cheap in headless checks. */
  interp(): void;
  props(): number;
  nearest(): { propId: number; archetype: number; d: number } | null;
  grab(): number;
  drop(): void;
  throw(power: number): number;
  carry(): number;
  setTarget(propId: number): void;
  target(): number;
  phase(): string;
  simTime(): number;
  world(seed: number): World;
  seed(): number;
  /** Raw Game instance — debug/verification only. */
  raw(): Game;
  npc(): { x: number; z: number };
  plaza(): { x: number; z: number; facing: number };
  createdProps(): { propId: number; x: number; z: number }[];
  net?: {
    /** the live NetClient — reconnect/latency tests reach the socket via this */
    raw(): NetClient;
    myId(): number;
    phase(): string;
    players(): { id: number; name: string; isHost: boolean }[];
    scores(): Record<number, number>;
    remotes(): number;
    remotePos(netId: number): { x: number; z: number } | null;
    start(createSecs?: number, roundSecs?: number): void;
    pick(archetype: string, hue: number, scale: number): void;
    place(): void;
    grab(): void;
    drop(): void;
    throw(power: number): void;
    stun(): void;
  };
}

declare global {
  interface Window {
    __bringme: BringMeHook;
  }
}

export function installHook(game: Game, net?: NetClient): void {
  window.__bringme = {
    pos() {
      const e = localEid();
      return { x: Position.x[e], z: Position.z[e] };
    },
    yaw() {
      return Yaw.v[localEid()];
    },
    setInput(forward, strafe, camYaw) {
      input.forward = forward;
      input.strafe = strafe;
      if (camYaw !== undefined) input.camYaw = camYaw;
    },
    step(n, dt) {
      for (let i = 0; i < n; i++) game.step(dt);
    },
    frame(n, dt) {
      for (let i = 0; i < n; i++) game.frame(dt);
    },
    interp() {
      game.interpolateRemotes(performance.now());
    },
    props() {
      return game.propEidById.size;
    },
    nearest() {
      const e = localEid();
      let best: { propId: number; archetype: number; d: number } | null = null;
      for (const [propId, eid] of game.propEidById) {
        if (hasComponent(world, CarriedBy, eid)) continue;
        const d = Math.hypot(Position.x[eid] - Position.x[e], Position.z[eid] - Position.z[e]);
        if (!best || d < best.d) best = { propId, archetype: Prop.archetype[eid], d };
      }
      return best;
    },
    grab: () => game.grab(),
    drop: () => game.drop(),
    throw: (power) => game.throw(power),
    carry: () => game.carry(),
    setTarget: (propId) => game.startFakeRound(propId),
    target: () => game.targetPropId(),
    phase: () => game.phase,
    simTime: () => game.simTime,
    world: (seed) => generateWorld(seed),
    seed: () => game.data.seed,
    raw: () => game,
    npc: () => ({ x: game.data.npc.x, z: game.data.npc.z }),
    plaza: () => ({ ...game.data.plaza }),
    createdProps() {
      const out: { propId: number; x: number; z: number }[] = [];
      for (const [propId, eid] of game.propEidById) {
        if (propId < CREATED_PROP_ID_BASE) continue;
        out.push({ propId, x: Position.x[eid], z: Position.z[eid] });
      }
      return out;
    },
    ...(net
      ? {
          net: {
            raw: () => net,
            myId: () => net.myId,
            phase: () => net.serverPhase,
            players: () => net.players,
            scores: () => net.scores,
            remotes: () => game.remotePlayerCount(),
            remotePos: (netId: number) => game.remotePos(netId),
            start: (createSecs = 90, roundSecs = 120) => net.start({ createSecs, roundSecs }),
            pick: (archetype: string, hue: number, scale: number) => net.pickAction(archetype, hue, scale),
            place: () => net.placeAction(),
            grab: () => net.grabAction(),
            drop: () => net.dropAction(),
            throw: (power: number) => net.throwAction(power),
            stun: () => net.stunAction(),
          },
        }
      : {}),
  };
}
