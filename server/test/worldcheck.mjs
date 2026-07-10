// World-generation safety sweep: across many seeds, assert that
//   1. no spawn point is inside (or touching) an unpassable collider, and
//   2. every spawn can REACH the NPC (grid BFS) — i.e. no player can be
//      born into a walled-off pocket.
// Usage: node server/test/worldcheck.mjs [seedCount]   (exit 0 = pass)

import { generateWorld, blockedAt, MAP_SIZE } from "../../shared/src/index.ts";

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
  const w = generateWorld(seed);
  const region = reachable(w, w.npc.x, w.npc.z);
  for (let i = 0; i < w.spawnPoints.length; i++) {
    const sp = w.spawnPoints[i];
    if (blockedAt(w, sp.x, sp.z, 0.25)) {
      console.error(`FAIL seed ${seed}: spawn ${i} inside a collider at ${sp.x.toFixed(1)},${sp.z.toFixed(1)}`);
      failures++;
    }
    if (!region.has(cellOf(sp.z) * N + cellOf(sp.x))) {
      console.error(`FAIL seed ${seed}: spawn ${i} cannot reach the NPC (pocketed) at ${sp.x.toFixed(1)},${sp.z.toFixed(1)}`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s) across ${SEEDS} seeds`);
  process.exit(1);
}
console.log(`worldcheck: ${SEEDS} seeds x 8 spawns — all clear and all reach the NPC`);
process.exit(0);
