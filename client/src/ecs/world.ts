import { addComponent, addEntity, createWorld, type IWorld } from "bitecs";
import type * as THREE from "three";
import {
  Position,
  Yaw,
  PlayerTag,
  LocalTag,
  NpcTag,
  NetId,
  Prop,
  Carryable,
  RenderRef,
} from "./components.ts";

export type GameWorld = IWorld;

export const world: GameWorld = createWorld();

/**
 * bitECS hands out eid 0 to the first entity, but the codebase uses 0 as
 * "no entity" (CarriedBy.eid, localEid(), targetEid...). Burn eid 0 on a
 * componentless placeholder so every real entity gets a truthy id.
 */
export const NULL_EID = addEntity(world);

/** eid -> Object3D side-table (bitECS stores numbers only). */
export const object3ds = new Map<number, THREE.Object3D>();

export function spawnPlayer(
  x: number,
  z: number,
  yaw: number,
  netId: number,
  local: boolean,
  obj: THREE.Object3D,
): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, Yaw, eid);
  addComponent(world, PlayerTag, eid);
  addComponent(world, NetId, eid);
  addComponent(world, RenderRef, eid);
  if (local) addComponent(world, LocalTag, eid);
  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;
  Yaw.v[eid] = yaw;
  NetId.v[eid] = netId;
  object3ds.set(eid, obj);
  return eid;
}

export function spawnProp(
  propId: number,
  archetype: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  obj: THREE.Object3D,
): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, Yaw, eid);
  addComponent(world, Prop, eid);
  addComponent(world, Carryable, eid);
  addComponent(world, RenderRef, eid);
  Position.x[eid] = x;
  Position.y[eid] = y;
  Position.z[eid] = z;
  Yaw.v[eid] = yaw;
  Prop.propId[eid] = propId;
  Prop.archetype[eid] = archetype;
  object3ds.set(eid, obj);
  return eid;
}

export function spawnNpc(x: number, z: number, yaw: number, obj: THREE.Object3D): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, Yaw, eid);
  addComponent(world, NpcTag, eid);
  addComponent(world, RenderRef, eid);
  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;
  Yaw.v[eid] = yaw;
  object3ds.set(eid, obj);
  return eid;
}
