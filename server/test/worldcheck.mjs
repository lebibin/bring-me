// World-generation safety sweep: across many seeds, assert that
//   1. no spawn point is inside (or touching) an unpassable collider, and
//   2. every spawn can REACH the NPC (grid BFS) — i.e. no player can be
//      born into a walled-off pocket.
// Usage: node server/test/worldcheck.mjs [seedCount]   (exit 0 = pass)

import { generateWorld, blockedAt, MAP_SIZE, STAGES } from "../../shared/src/index.ts";

const SEEDS = Number(process.argv[2]) || 120;
const CELL = 0.5;
const HALF = MAP_SIZE / 2;
const N = Math.floor(MAP_SIZE / CELL);

function cellOf(v) {
  return Math.min(N - 1, Math.max(0, Math.floor((v + HALF) / CELL)));
}

function reachable(world, fromX, fromZ) {
  // BFS over walkable cells starting at (fromX, fromZ)
  const seen = new Uint8Array(N * N);
  const queue = [[cellOf(fromX), cellOf(fromZ)]];
  seen[queue[0][1] * N + queue[0][0]] = 1;
  const out = new Set();
  while (queue.length) {
    const [cx, cz] = queue.pop();
    out.add(cz * N + cx);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const idx = nz * N + nx;
      if (seen[idx]) continue;
      seen[idx] = 1;
      const wx = -HALF + (nx + 0.5) * CELL;
      const wz = -HALF + (nz + 0.5) * CELL;
      if (Math.abs(wx) > HALF - 1 || Math.abs(wz) > HALF - 1) continue;
      if (blockedAt(world, wx, wz)) continue;
      queue.push([nx, nz]);
    }
  }
  return out;
}

let failures = 0;
for (let s = 1; s <= SEEDS; s++) {
  const seed = (s * 2654435761) >>> 0;
  for (let stage = 0; stage < STAGES.length; stage++) {
    const w = generateWorld(seed, stage);
    const tag = `seed ${seed} stage ${STAGES[stage].id}`;
    // no two solid fixtures may overlap (objects spawning inside each other)
    for (let i = 0; i < w.solids.length; i++) {
      for (let j = i + 1; j < w.solids.length; j++) {
        const a = w.solids[i];
        const b = w.solids[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < a.r + b.r - 0.05) {
          console.error(`FAIL ${tag}: solids ${i} and ${j} overlap by ${(a.r + b.r - d).toFixed(2)}m`);
          failures++;
        }
      }
    }
    // spawns must stay pairwise distinct — yard clamping near corners could
    // pinch ring neighbours together (players born inside each other)
    for (let i = 0; i < w.spawnPoints.length; i++) {
      for (let j = i + 1; j < w.spawnPoints.length; j++) {
        const a = w.spawnPoints[i];
        const b = w.spawnPoints[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < 1) {
          console.error(`FAIL ${tag}: spawns ${i} and ${j} only ${d.toFixed(2)}m apart`);
          failures++;
        }
      }
    }
    const region = reachable(w, w.npc.x, w.npc.z);
    for (let i = 0; i < w.spawnPoints.length; i++) {
      const sp = w.spawnPoints[i];
      if (blockedAt(w, sp.x, sp.z, 0.25)) {
        console.error(`FAIL ${tag}: spawn ${i} inside a collider at ${sp.x.toFixed(1)},${sp.z.toFixed(1)}`);
        failures++;
      }
      if (!region.has(cellOf(sp.z) * N + cellOf(sp.x))) {
        console.error(`FAIL ${tag}: spawn ${i} cannot reach the NPC (pocketed) at ${sp.x.toFixed(1)},${sp.z.toFixed(1)}`);
        failures++;
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s) across ${SEEDS} seeds x ${STAGES.length} stages`);
  process.exit(1);
}
console.log(`worldcheck: ${SEEDS} seeds x ${STAGES.length} stages — spawns clear, all reach the NPC, no overlapping solids`);
process.exit(0);
