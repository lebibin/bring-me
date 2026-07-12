// Room-lifetime standings check against `wrangler dev`: two bots play TWO
// quick walk-deliver matches in one room and assert the cumulative `totals`
// (welcome/lobby/matchEnd) carry across games.
// Usage: node server/test/totalsbot.mjs   (exit 0 = pass; ~2 min)
// Prints the room code so a browser can join it and see the lobby scoreboard.
// Needs Node >= 23.6 (type stripping: imports shared/src/*.ts directly).

import {
  DELIVER_PTS,
  GRAB_RADIUS,
  NPC_RADIUS,
  generateWorld,
  placementValid,
} from "../../shared/src/index.ts";

const BASE = process.env.BM_URL ?? "ws://127.0.0.1:8787";
const code = "T" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "0");

const failures = [];
function assert(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}`);
    failures.push(label);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${code}`);
    const bot = { name, ws, id: 0, x: 0, z: 0, yaw: 0, msgs: [], waiters: [] };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", name, v: 2 })));
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

/** Legal pos reports every 66 ms, under the server speed clamp. */
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
const CARRY_STEP = 0.34;

/** One full 2-round match: each bot's object walk-delivered by the other. */
async function playMatch(bots, world, host) {
  const findSpot = (px, pz) => {
    for (let ring = 0; ring < 12; ring++) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = px + Math.cos(a) * ring * 1.5;
        const z = pz + Math.sin(a) * ring * 1.5;
        if (placementValid(world, x, z)) return { x, z };
      }
    }
    throw new Error(`no valid spot near ${px},${pz}`);
  };
  const [A] = bots;
  send(host, { type: "start", settings: { createSecs: 60, roundSecs: 60 } });
  await waitFor(A, (m) => m.type === "phase" && m.name === "CREATE" && !m._seen, "phase CREATE").then((m) => (m._seen = true));
  const placements = { 1: findSpot(10, 10), 2: findSpot(-10, -10) };
  const hues = { 1: 10, 2: 130 };
  for (const b of bots) {
    send(b, { type: "pickObject", archetype: "duck", params: { hue: hues[b.id], scale: 1 } });
    await sleep(50);
    send(b, { type: "placeObject", x: placements[b.id].x, z: placements[b.id].z });
  }
  for (let round = 0; round < bots.length; round++) {
    const reveal = await waitFor(A, (m) => m.type === "reveal" && !m._seen, `reveal round ${round}`, 40000);
    reveal._seen = true;
    const creator = Number(Object.entries(hues).find(([, h]) => h === reveal.params.hue)[0]);
    await waitFor(A, (m) => m.type === "phase" && m.name === "SEEK" && !m._seen, `SEEK round ${round}`, 15000).then((m) => (m._seen = true));
    const runner = bots.find((b) => b.id !== creator);
    const spot = placements[creator];
    await walk(runner, spot.x, spot.z, GRAB_RADIUS * 0.6);
    send(runner, { type: "grab", propId: 100000 + creator });
    await waitFor(runner, (m) => m.type === "grabbed" && m.playerId === runner.id && !m._seen, `grab round ${round}`).then((m) => (m._seen = true));
    await walk(runner, world.npc.x, world.npc.z, NPC_RADIUS * 0.8, CARRY_STEP);
    await waitFor(A, (m) => m.type === "roundEnd" && !m._seen, `roundEnd ${round}`, 40000).then((m) => (m._seen = true));
  }
  const end = await waitFor(A, (m) => m.type === "matchEnd" && !m._seen, "matchEnd", 30000);
  end._seen = true;
  await waitFor(A, (m) => m.type === "phase" && m.name === "LOBBY" && !m._seen, "back to LOBBY").then((m) => (m._seen = true));
  return end;
}

try {
  console.log(`room ${code} @ ${BASE}`);
  const A = await connect("botA");
  const B = await connect("botB");
  const bots = [A, B];
  assert(A.id === 1 && B.id === 2, "two bots joined as 1/2");
  assert(
    A.welcome.totals && Object.keys(A.welcome.totals).length === 0,
    "fresh room: welcome carries empty totals",
  );

  const world = generateWorld(A.seed);
  for (const b of bots) {
    const s = world.spawnPoints[(b.id - 1) % 8];
    b.x = s.x;
    b.z = s.z;
  }

  // ---- game 1 ----
  const end1 = await playMatch(bots, world, A);
  assert(end1.totals !== undefined, "matchEnd carries totals");
  for (const b of bots) {
    assert(
      end1.totals[b.id]?.pts === end1.scores[b.id] && end1.totals[b.id]?.name === b.name,
      `game 1: ${b.name} totals == match scores (${end1.totals[b.id]?.pts})`,
    );
    assert(end1.scores[b.id] >= DELIVER_PTS, `game 1: ${b.name} banked a delivery`);
  }
  const lobbyMsg = await waitFor(A, (m) => m.type === "lobby" && m.totals && Object.keys(m.totals).length > 0, "lobby msg with totals");
  assert(lobbyMsg.totals[A.id].pts === end1.totals[A.id].pts, "lobby broadcast matches matchEnd totals");

  // ---- game 2: totals accumulate ----
  const end2 = await playMatch(bots, world, A);
  for (const b of bots) {
    const expected = end1.scores[b.id] + end2.scores[b.id];
    assert(
      end2.totals[b.id]?.pts === expected,
      `game 2: ${b.name} totals accumulated (${end2.totals[b.id]?.pts} == ${end1.scores[b.id]} + ${end2.scores[b.id]})`,
    );
  }

  for (const b of bots) b.ws.close(1000, "bye");
} catch (e) {
  console.error("FAIL ", e.message);
  failures.push(e.message);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\nroom standings: all checks passed (room ${code} still live for browser checks)`);
process.exit(0);
