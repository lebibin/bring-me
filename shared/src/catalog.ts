/**
 * Object catalog — pure data, NO Three.js imports (the server loads this file).
 * Mesh construction for each archetype lives client-side in render/propMeshes.ts,
 * keyed by these same ids.
 */

export interface PropParams {
  hue: number; // 0..360
  scale: number; // 0.7..1.4
}

export interface Archetype {
  id: string;
  name: string; // display name used in "Bring me ___!"
  /** Base hue used for scattered decoys when no player-picked hue applies. */
  baseHue: number;
}

// Top 10 backyard objects — a tight, distinct set so the create panel stays
// compact and every silhouette is recognizable at a glance.
export const ARCHETYPES: readonly Archetype[] = [
  { id: "basketball", name: "Basketball", baseHue: 24 },
  { id: "ball", name: "Ball", baseHue: 25 },
  { id: "frisbee", name: "Frisbee", baseHue: 320 },
  { id: "duck", name: "Rubber Duck", baseHue: 48 },
  { id: "gnome", name: "Garden Gnome", baseHue: 0 },
  { id: "flowerpot", name: "Flower Pot", baseHue: 16 },
  { id: "wateringcan", name: "Watering Can", baseHue: 200 },
  { id: "cone", name: "Traffic Cone", baseHue: 20 },
  { id: "boot", name: "Boot", baseHue: 30 },
  { id: "umbrella", name: "Umbrella", baseHue: 210 },
];

export const HUE_MIN = 0;
export const HUE_MAX = 360;
export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.4;

export function archetypeIndex(id: string): number {
  return ARCHETYPES.findIndex((a) => a.id === id);
}

export function isArchetypeId(id: string): boolean {
  return archetypeIndex(id) >= 0;
}

export function clampParams(p: PropParams): PropParams {
  const hue = ((p.hue % HUE_MAX) + HUE_MAX) % HUE_MAX;
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, p.scale));
  return {
    hue: Number.isFinite(hue) ? hue : 0,
    scale: Number.isFinite(scale) ? scale : 1,
  };
}
