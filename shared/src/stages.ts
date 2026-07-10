/**
 * Stage roster — every stage runs the SAME generation machinery (blockers,
 * zones, solids, spawn relocation, scatter) so the backyard's safety
 * guarantees hold everywhere; a stage only picks the visual theme and a few
 * fixture-count knobs inside worldgen.
 */

export const STAGES = [
  { id: "backyard", name: "Backyard" },
  { id: "park", name: "City Park" },
  { id: "beach", name: "Beach Cove" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export function clampStage(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(STAGES.length - 1, Math.max(0, n));
}
