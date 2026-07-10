import { addComponent, defineQuery, hasComponent, removeComponent } from "bitecs";
import type * as THREE from "three";
import {
  CARRY_FORWARD,
  CARRY_HEIGHT,
  CARRY_SPEED,
  GRAB_RADIUS,
  PLAYER_SPEED,
  PROP_REST_Y,
  stepBallistic,
  stepMove,
  throwVelocity,
} from "@bringme/shared";
import { Airborne, CarriedBy, Carryable, LocalTag, Position, Prop, Yaw } from "./components.ts";
import { world, object3ds } from "./world.ts";
import { input } from "./input.ts";

const localQ = defineQuery([LocalTag, Position, Yaw]);
const carriedQ = defineQuery([Prop, CarriedBy, Position]);
const airborneQ = defineQuery([Prop, Airborne, Position]);
const propsQ = defineQuery([Prop, Carryable, Position]);
const renderQ = defineQuery([Position, Yaw]);

export function localEid(): number {
  const eids = localQ(world);
  return eids.length > 0 ? eids[0] : 0;
}

/** propId of the prop carried by this player, or -1. */
export function carriedPropEid(playerEid: number): number {
  for (const eid of carriedQ(world)) {
    if (CarriedBy.eid[eid] === playerEid) return eid;
  }
  return 0;
}

export function movementSystem(dt: number): void {
  const eid = localEid();
  if (!eid) return;
  const f = input.forward;
  const s = input.strafe;
  if (f === 0 && s === 0) return;
  // forward = (sin yaw, cos yaw); right = fwd x up = (-cos yaw, sin yaw)
  const dirX = Math.sin(input.camYaw) * f - Math.cos(input.camYaw) * s;
  const dirZ = Math.cos(input.camYaw) * f + Math.sin(input.camYaw) * s;
  const speed = carriedPropEid(eid) ? CARRY_SPEED : PLAYER_SPEED;
  const next = stepMove(
    { x: Position.x[eid], z: Position.z[eid] },
    { x: dirX, z: dirZ },
    speed,
    dt,
  );
  Position.x[eid] = next.x;
  Position.z[eid] = next.z;
  Yaw.v[eid] = Math.atan2(dirX, dirZ);
}

export function carrySystem(): void {
  for (const eid of carriedQ(world)) {
    const carrier = CarriedBy.eid[eid];
    // held out in front at chest height, not balanced on the head
    Position.x[eid] = Position.x[carrier] + Math.sin(Yaw.v[carrier]) * CARRY_FORWARD;
    Position.y[eid] = CARRY_HEIGHT;
    Position.z[eid] = Position.z[carrier] + Math.cos(Yaw.v[carrier]) * CARRY_FORWARD;
    Yaw.v[eid] = Yaw.v[carrier];
  }
}

/** eids of every player currently carrying something (for the hold pose). */
export function carrierEids(): Set<number> {
  const out = new Set<number>();
  for (const eid of carriedQ(world)) out.add(CarriedBy.eid[eid]);
  return out;
}

export function ballisticSystem(dt: number): void {
  for (const eid of airborneQ(world)) {
    const b = {
      x: Position.x[eid],
      y: Position.y[eid],
      z: Position.z[eid],
      vx: Airborne.vx[eid],
      vy: Airborne.vy[eid],
      vz: Airborne.vz[eid],
      resting: false,
    };
    stepBallistic(b, dt);
    Position.x[eid] = b.x;
    Position.y[eid] = b.y;
    Position.z[eid] = b.z;
    Airborne.vx[eid] = b.vx;
    Airborne.vy[eid] = b.vy;
    Airborne.vz[eid] = b.vz;
    if (b.resting) removeComponent(world, Airborne, eid);
  }
}

export function cameraSystem(camera: THREE.PerspectiveCamera): void {
  const eid = localEid();
  if (!eid) return;
  const dist = 6.5;
  const h = Math.sin(input.camPitch) * dist + 1;
  const flat = Math.cos(input.camPitch) * dist;
  const px = Position.x[eid];
  const pz = Position.z[eid];
  camera.position.set(px - Math.sin(input.camYaw) * flat, h, pz - Math.cos(input.camYaw) * flat);
  camera.lookAt(px, 1.1, pz);
}

export function renderSyncSystem(): void {
  for (const eid of renderQ(world)) {
    const obj = object3ds.get(eid);
    if (!obj) continue;
    obj.position.set(Position.x[eid], Position.y[eid], Position.z[eid]);
    obj.rotation.y = Yaw.v[eid];
  }
}

// ---------- actions ----------

export let lastThrower = 0;

/** Grab the nearest free prop within GRAB_RADIUS. Returns its eid or 0. */
export function tryGrab(): number {
  const player = localEid();
  if (!player || carriedPropEid(player)) return 0;
  let best = 0;
  let bestD = GRAB_RADIUS;
  for (const eid of propsQ(world)) {
    if (hasComponent(world, CarriedBy, eid)) continue;
    const d = Math.hypot(Position.x[eid] - Position.x[player], Position.z[eid] - Position.z[player]);
    if (d < bestD) {
      bestD = d;
      best = eid;
    }
  }
  if (!best) return 0;
  if (hasComponent(world, Airborne, best)) removeComponent(world, Airborne, best);
  addComponent(world, CarriedBy, best);
  CarriedBy.eid[best] = player;
  return best;
}

export function dropCarried(): void {
  const player = localEid();
  const eid = carriedPropEid(player);
  if (!eid) return;
  removeComponent(world, CarriedBy, eid);
  Position.x[eid] = Position.x[player] + Math.sin(Yaw.v[player]) * 0.7;
  Position.z[eid] = Position.z[player] + Math.cos(Yaw.v[player]) * 0.7;
  Position.y[eid] = PROP_REST_Y;
}

/** Throw the carried prop the way the character is FACING. power in [0,1]. */
export function throwCarried(power: number): number {
  const player = localEid();
  const eid = carriedPropEid(player);
  if (!eid) return 0;
  removeComponent(world, CarriedBy, eid);
  const dirX = Math.sin(Yaw.v[player]);
  const dirZ = Math.cos(Yaw.v[player]);
  const v = throwVelocity(dirX, dirZ, power);
  addComponent(world, Airborne, eid);
  Airborne.vx[eid] = v.vx;
  Airborne.vy[eid] = v.vy;
  Airborne.vz[eid] = v.vz;
  Position.x[eid] = Position.x[player] + dirX * 0.6;
  Position.y[eid] = CARRY_HEIGHT;
  Position.z[eid] = Position.z[player] + dirZ * 0.6;
  lastThrower = player;
  return eid;
}
