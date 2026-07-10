import { defineComponent, Types } from "bitecs";

// bitECS = SoA typed-array storage (the data-oriented core). Numbers only —
// Object3D refs live in the object3ds side-table in world.ts.

export const Position = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32 });
export const Yaw = defineComponent({ v: Types.f32 });

export const PlayerTag = defineComponent();
export const LocalTag = defineComponent();
export const NpcTag = defineComponent();
/** Network player id (M1+); also set locally so snapshots can map ids→eids. */
export const NetId = defineComponent({ v: Types.ui32 });

export const Prop = defineComponent({ archetype: Types.ui8, propId: Types.ui32 });
export const Carryable = defineComponent();
/** eid of the carrying player; only present while carried. */
export const CarriedBy = defineComponent({ eid: Types.eid });
/** In-flight thrown prop. */
export const Airborne = defineComponent({ vx: Types.f32, vy: Types.f32, vz: Types.f32 });

export const Stunned = defineComponent({ until: Types.f64 });
export const StunCooldown = defineComponent({ until: Types.f64 });

/** Marks entities mirrored by an Object3D in the side-table. */
export const RenderRef = defineComponent();
