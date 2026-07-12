// Disconnect-resilience check against `wrangler dev`: ping/pong keepalive,
// and a mid-round socket drop resumed via the welcome token â€” same playerId,
// still a participant, finishes the delivery.
// Usage: node server/test/reconnectbot.mjs   (exit 0 = pass; ~40s)
// Needs Node >= 23.6 (type stripping: imports shared/src/*.ts directly).

import {
  GRAB_RADIUS,
  NPC_RADIUS,
  generateWorld,
  placementValid,
} from "../../shared/src/index.ts";

const BASE = process.env.BM_URL ?? "ws://127.0.0.1:8787";
const code = "R" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "0");

const failures = [];
function assert(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}`);
    failures.push(label);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, resume) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${code}`);
    const bot = { name, ws, id: 0, x: 0, z: 0, yaw: 0, msgs: [], waiters: [] };
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "hello", name, v: 2, ...(resume ? { resume } : {}) })),
    );
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      bot.msgs.push(m);
      for (const w of [...bot.waiters]) {
        if (w.pred(m)) {
          bot.waiters.splice(bot.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
      if (m.type === "welcome") {
        bot.id = m.playerId;
        bot.seed = m.seed;
        bot.welcome = m;
        resolve(bot);
      }
    });
    ws.addEventListener("error", () => reject(new Error(`${name}: socket error`)));
    setTimeout(() => reject(new Error(`${name}: no welcome after 5s`)), 5000);
  });
}

function waitFor(bot, pred, label, ms = 30000) {
  const hit = bot.msgs.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    bot.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

function send(bot, msg) {
  bot.ws.send(JSON.stringify(msg));
}

async function walk(bot, tx, tz, stopAt = 0.4, step = 0.5) {
  for (let i = 0; i < 500; i++) {
    const dx = tx - bot.x, dz = tz - bot.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    const s = Math.min(step, d);
    bot.x += (dx / d) * s;
    bot.z += (dz / d) * s;
    bot.yaw = Math.atan2(dx, dz);
    send(bot, { type: "pos", x: bot.x, z: bot.z, yaw: bot.yaw });
    await sleep(66);
  }
  return false;
}

try {
  console.log(`room ${code} @ ${BASE}`);
  let A = await connect("botA");
  const B = await connect("botB");
  assert(A.id === 1 && B.id === 2, "two bots joined as 1/2");
  assert(typeof A.welcome.resume === "string" && A.welcome.resume.length > 0, "welcome carries a resume token");

  // keepalive: ping answered (auto-response or fallback)
  send(A, { type: "ping" });
  await waitFor(A, (m) => m.type === "pong", "pong", 5000);
  assert(true, "ping answered with pong");

  const world = generateWorld(A.seed);
  for (const b of [A, B]) {
    const s = world.spawnPoints[(b.id - 1) % 8];
    b.x = s.x;
    b.z = s.z;
  }

  // start a match, place both objects
  const findSpot = (px, pz) => {
    for (let ring = 0; ring < 12; ring++) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = px + Math.cos(a) * ring * 1.5;
        const z = pz + Math.sin(a) * ring * 1.5;
        if (placementValid(world, x, z)) return { x, z };
      }
    }
    throw new Error("no valid spot");
  };
  send(A, { type: "start", settings: { createSecs: 60, roundSecs: 120 } });
  await waitFor(A, (m) => m.type === "phase" && m.name === "CREATE", "phase CREATE");
  const placements = { 1: findSpot(10, 10), 2: findSpot(-10, -10) };
  const hues = { 1: 10, 2: 130 };
  for (const b of [A, B]) {
    send(b, { type: "pickObject", archetype: "duck", params: { hue: hues[b.id], scale: 1 } });
    await sleep(50);
    send(b, { type: "placeObject", x: placements[b.id].x, z: placements[b.id].z });
  }

  const reveal = await waitFor(B, (m) => m.type === "reveal", "reveal round 0", 40000);
  const creator = Number(Object.entries(hues).find(([, h]) => h === reveal.params.hue)[0]);
  await waitFor(B, (m) => m.type === "phase" && m.name === "SEEK", "SEEK round 0", 15000);
  const runner = creator === 1 ? B : A;
  const watcherName = runner === A ? B : A;
  const spot = placements[creator];
  const propId = 100000 + creator;

  // runner grabs the target, then the connection "drops" mid-carry
  await walk(runner, spot.x, spot.z, GRAB_RADIUS * 0.6);
  send(runner, { type: "grab", propId });
  await waitFor(runner, (m) => m.type === "grabbed" && m.playerId === runner.id, "runner grabbed");
  const oldId = runner.id;
  const token = runner.welcome.resume;
  runner.ws.close(); // simulated blip
  const drop = await waitFor(watcherName, (m) => m.type === "dropped" && m.propId === propId, "prop force-dropped on disconnect");
  assert(true, `carrier's drop broadcast at (${drop.x}, ${drop.z})`);
  await waitFor(watcherName, (m) => m.type === "playerLeft" && m.playerId === oldId, "playerLeft broadcast");

  // resume: same seat back
  const revived = await connect(runner.name, token);
  assert(revived.id === oldId, `resume reclaimed playerId ${oldId} (got ${revived.id})`);
  assert(revived.welcome.phase === "SEEK", "resumed straight into the live SEEK phase");
  const s = world.spawnPoints[(revived.id - 1) % 8];
  revived.x = s.x;
  revived.z = s.z;

  // still a participant: re-grab the dropped target and deliver it
  await walk(revived, drop.x, drop.z, GRAB_RADIUS * 0.6);
  send(revived, { type: "grab", propId });
  await waitFor(revived, (m) => m.type === "grabbed" && m.playerId === revived.id, "resumed player re-grabbed the target");
  await walk(revived, world.npc.x, world.npc.z, NPC_RADIUS * 0.8, 0.34);
  const del = await waitFor(watcherName, (m) => m.type === "delivered", "delivered after resume", 40000);
  assert(del.byId === oldId, `delivery credited to the resumed player (${del.byId})`);

  revived.ws.close(1000, "bye");
  B.ws.close(1000, "bye");
  if (A !== revived) A.ws.close?.(1000, "bye");
} catch (e) {
  console.error("FAIL ", e.message);
  failures.push(e.message);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nreconnect/resume: all checks passed");
process.exit(0);
