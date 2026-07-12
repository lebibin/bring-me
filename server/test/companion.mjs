// Companion bot for browser e2e checks: joins an existing room, places its
// object at a deterministic spot (plaza + facing*12), and autonomously plays
// any round that is NOT its own (walk-delivers the target). Exits on matchEnd.
// Usage: node server/test/companion.mjs <ROOMCODE>

import { generateWorld, placementValid } from "../../shared/src/index.ts";

const BASE = process.env.BM_URL ?? "ws://127.0.0.1:8787";
const code = process.argv[2];
if (!code) {
  console.error("usage: node companion.mjs <ROOMCODE>");
  process.exit(2);
}

const MY_HUE = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`${BASE}/room/${code}`);
const bot = { id: 0, x: 0, z: 0, yaw: 0 };
let world = null;
const objectSpots = new Map(); // creatorId -> {x,z}
let acting = false;

function send(msg) {
  ws.send(JSON.stringify(msg));
}

async function walk(tx, tz, stopAt = 0.4, step = 0.5) {
  for (let i = 0; i < 600; i++) {
    const dx = tx - bot.x, dz = tz - bot.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    const s = Math.min(step, d);
    bot.x += (dx / d) * s;
    bot.z += (dz / d) * s;
    bot.yaw = Math.atan2(dx, dz);
    send({ type: "pos", x: bot.x, z: bot.z, yaw: bot.yaw });
    await sleep(66);
  }
  return false;
}

function mySpot() {
  const p = world.plaza;
  for (let d = 12; d < 30; d += 1.5) {
    const x = p.x + Math.sin(p.facing) * d;
    const z = p.z + Math.cos(p.facing) * d;
    if (placementValid(world, x, z)) return { x, z };
  }
  return { x: 0, z: 0 };
}

ws.addEventListener("open", () => send({ type: "hello", name: "companion", v: 2 }));
ws.addEventListener("message", async (ev) => {
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case "welcome": {
      bot.id = m.playerId;
      world = generateWorld(m.seed);
      const s = world.spawnPoints[(bot.id - 1) % 8];
      bot.x = s.x;
      bot.z = s.z;
      console.log(`companion joined as ${bot.id}`);
      break;
    }
    case "phase":
      if (m.name === "CREATE") {
        send({ type: "pickObject", archetype: "ball", params: { hue: MY_HUE, scale: 1 } });
        await sleep(100);
        const spot = mySpot();
        send({ type: "placeObject", x: spot.x, z: spot.z });
        console.log(`companion placed ball at ${spot.x.toFixed(1)},${spot.z.toFixed(1)}`);
      }
      break;
    case "propAdded":
      objectSpots.set(m.creatorId, { x: m.prop.x, z: m.prop.z });
      break;
    case "reveal":
      if (m.params.hue === MY_HUE) {
        console.log("round: my own object â€” idling, the browser should deliver it");
        acting = false;
      } else {
        acting = true;
        const creator = [...objectSpots.keys()].find((id) => id !== bot.id);
        const spot = objectSpots.get(creator);
        if (!spot) break;
        console.log("round: browser's object â€” companion delivering");
        await sleep(3500); // let REVEAL end, SEEK begin
        if (!acting) break;
        await walk(spot.x, spot.z, 1.2);
        send({ type: "grab", propId: 100000 + creator });
        await sleep(300);
        await walk(world.npc.x, world.npc.z, 1.1, 0.34);
      }
      break;
    case "matchEnd":
      console.log(`matchEnd scores: ${JSON.stringify(m.scores)}`);
      ws.close(1000, "done");
      process.exit(0);
      break;
    default:
      break;
  }
});
ws.addEventListener("close", () => process.exit(0));
setTimeout(() => {
  console.error("companion: 5 min safety timeout");
  process.exit(1);
}, 300000);
