// Full scripted match against `wrangler dev`: 3 bots play every mechanic.
//   round A: walk-deliver     round B: stun-steal + throw-deliver
//   round C: nobody grabs -> timer expires, creator's LoS accrual x2
// Usage: node server/test/matchbot.mjs   (exit 0 = pass; ~90s, round C waits
// out a real 30s round timer)
// Needs Node >= 23.6 (type stripping: imports shared/src/*.ts directly).

import {
  CARRY_HEIGHT,
  DELIVER_PTS,
  GRAB_RADIUS,
  NPC_RADIUS,
  STUN_RANGE,
  generateWorld,
  placementValid,
  stepBallistic,
  throwVelocity,
} from "../../shared/src/index.ts";

const BASE = process.env.BM_URL ?? "ws://127.0.0.1:8787";
const code = "M" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "0");

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
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", name, v: 1 })));
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
        resolve(bot);
      }
    });
    ws.addEventListener("error", () => reject(new Error(`${name}: socket error`)));
    setTimeout(() => reject(new Error(`${name}: no welcome after 5s`)), 5000);
  });
}

function waitFor(bot, pred, label, ms = 20000) {
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

/**
 * Walk a bot server-side by legal pos reports every 66 ms. Step must stay
 * under the server clamp: 6*0.066*1.5≈0.59 free, 4.2*0.066*1.5≈0.41 carrying.
 */
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

/** Power whose simulated range best matches dist (same shared ballistics as the server). */
function powerForDistance(dist) {
  let best = 0.5, bestErr = 1e9;
  for (let p = 0.05; p <= 1; p += 0.02) {
    const v = throwVelocity(1, 0, p);
    const b = { x: 0, y: CARRY_HEIGHT, z: 0, vx: v.vx, vy: v.vy, vz: v.vz, resting: false };
    for (let i = 0; i < 300 && !b.resting; i++) stepBallistic(b, 1 / 15);
    const err = Math.abs(b.x - dist);
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return best;
}

try {
  console.log(`room ${code} @ ${BASE}`);
  const bots = [];
  for (const name of ["botA", "botB", "botC"]) bots.push(await connect(name));
  const [A, B, C] = bots;
  assert(A.id === 1 && B.id === 2 && C.id === 3, "three bots joined as 1/2/3");

  const world = generateWorld(A.seed);
  const npc = world.npc;
  for (const b of bots) {
    const s = world.spawnPoints[(b.id - 1) % 8];
    b.x = s.x;
    b.z = s.z;
  }

  // --- CREATE: distinct objects at known spots, distinguishable by hue ---
  send(A, { type: "start", settings: { createSecs: 60, roundSecs: 30 } });
  await waitFor(A, (m) => m.type === "phase" && m.name === "CREATE", "phase CREATE");
  // the yard now has off-limits zones (pool/deck/house/playground) — search
  // outward from each preferred corner for the nearest legal spot
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
  const placements = { 1: findSpot(20, 20), 2: findSpot(-20, 20), 3: findSpot(-20, -20) };
  const hues = { 1: 10, 2: 130, 3: 250 };
  for (const b of bots) {
    send(b, { type: "pickObject", archetype: "duck", params: { hue: hues[b.id], scale: 1 } });
    await sleep(50);
    send(b, { type: "placeObject", x: placements[b.id].x, z: placements[b.id].z });
  }
  await waitFor(A, (m) => m.type === "phase" && m.name === "COUNTDOWN", "CREATE ends early once all placed");
  assert(true, "all placed -> COUNTDOWN starts early");
  const propAdds = A.msgs.filter((m) => m.type === "propAdded");
  assert(propAdds.length === 3, "3 propAdded broadcasts");

  const results = []; // per round: {creator, mode, ...}
  for (let round = 0; round < 3; round++) {
    const reveal = await waitFor(A, (m) => m.type === "reveal" && !m._seen, `reveal round ${round}`, 30000);
    reveal._seen = true;
    const creator = Number(Object.entries(hues).find(([, h]) => h === reveal.params.hue)[0]);
    const spot = placements[creator];
    await waitFor(A, (m) => m.type === "phase" && m.name === "SEEK" && m.round === round, `SEEK round ${round}`, 15000);
    const propId = 100000 + creator;
    console.log(`  round ${round}: target belongs to bot ${creator}`);

    if (round === 0) {
      // WALK-DELIVER by the first non-creator
      const runner = bots.find((b) => b.id !== creator);
      await walk(runner, spot.x, spot.z, GRAB_RADIUS * 0.6);
      send(runner, { type: "grab", propId });
      await waitFor(runner, (m) => m.type === "grabbed" && m.playerId === runner.id, "walk round: grabbed");
      // creator self-grab must be rejected
      const creatorBot = bots.find((b) => b.id === creator);
      send(creatorBot, { type: "grab", propId });
      const selfErr = await waitFor(creatorBot, (m) => m.type === "err" && (m.code === "own" || m.code === "taken"), "self-grab rejected");
      assert(true, `creator self-grab rejected (${selfErr.code})`);
      await walk(runner, npc.x, npc.z, NPC_RADIUS * 0.8, CARRY_STEP);
      const del = await waitFor(A, (m) => m.type === "delivered" && !m._seen, "walk round: delivered", 30000);
      del._seen = true;
      assert(del.byId === runner.id && del.points === DELIVER_PTS, `walk-deliver by bot ${runner.id} (+${del.points})`);
      const re = await waitFor(A, (m) => m.type === "roundEnd" && !m._seen, "roundEnd walk");
      re._seen = true;
      assert(re.found === true, "walk round marked found");
      results.push({ creator, mode: "walk", deliverer: runner.id });
    } else if (round === 1) {
      // STUN-STEAL then THROW-DELIVER
      const [thief, victim] = bots.filter((b) => b.id !== creator);
      // both close in on the hide spot concurrently to fit the round timer
      await Promise.all([
        walk(victim, spot.x, spot.z, GRAB_RADIUS * 0.6),
        walk(thief, spot.x + 3, spot.z + 3, 0.5),
      ]);
      send(victim, { type: "grab", propId });
      await waitFor(victim, (m) => m.type === "grabbed" && m.playerId === victim.id, "steal round: victim grabbed");
      await walk(thief, victim.x, victim.z, STUN_RANGE * 0.6);
      send(thief, { type: "stun" });
      const st = await waitFor(A, (m) => m.type === "stunned", "stunned broadcast");
      assert(st.victimId === victim.id && st.byId === thief.id, `stun hit the carrier (victim ${st.victimId})`);
      const dr = await waitFor(A, (m) => m.type === "dropped" && m.lockedFor === victim.id, "drop with victim lock");
      assert(true, `carrier dropped it (locked for ${dr.lockedFor})`);
      send(thief, { type: "grab", propId });
      await waitFor(thief, (m) => m.type === "grabbed" && m.playerId === thief.id, "thief grabbed the drop");
      // carry to ~5.5m from the NPC, then throw
      const dx = npc.x - thief.x, dz = npc.z - thief.z, d0 = Math.hypot(dx, dz);
      const standoff = 5.5;
      await walk(thief, npc.x - (dx / d0) * standoff, npc.z - (dz / d0) * standoff, 0.4, CARRY_STEP);
      const tdx = npc.x - thief.x, tdz = npc.z - thief.z, dist = Math.hypot(tdx, tdz);
      send(thief, { type: "throw", dirX: tdx / dist, dirZ: tdz / dist, power: powerForDistance(dist) });
      await waitFor(A, (m) => m.type === "thrown", "thrown broadcast");
      const del = await waitFor(A, (m) => m.type === "delivered" && !m._seen, "throw round: delivered", 15000);
      del._seen = true;
      assert(del.byId === thief.id, `throw-deliver credited to the thrower (bot ${thief.id})`);
      const re = await waitFor(A, (m) => m.type === "roundEnd" && !m._seen, "roundEnd throw");
      re._seen = true;
      assert(re.found === true, "throw round marked found");
      results.push({ creator, mode: "throw", deliverer: thief.id });
    } else {
      // TIMEOUT: a non-creator stares at the object (LoS accrual), nobody
      // grabs — the round timer expires and the creator's accrual doubles.
      const watcher = bots.find((b) => b.id !== creator);
      const wdx = spot.x - watcher.x, wdz = spot.z - watcher.z, wd = Math.hypot(wdx, wdz);
      const watchFrom = 8;
      await walk(watcher, spot.x - (wdx / wd) * watchFrom, spot.z - (wdz / wd) * watchFrom, 0.5);
      watcher.yaw = Math.atan2(spot.x - watcher.x, spot.z - watcher.z);
      for (let i = 0; i < 8; i++) {
        send(watcher, { type: "pos", x: watcher.x, z: watcher.z, yaw: watcher.yaw });
        await sleep(150);
      }
      const re = await waitFor(A, (m) => m.type === "roundEnd" && !m._seen, "roundEnd timeout", 40000);
      re._seen = true;
      assert(re.found === false, "timeout round marked unfound");
      assert(re.creatorId === creator, "unfound round credits the right creator");
      assert(re.creatorPoints > 0, `creator earned LoS points x2 (+${re.creatorPoints})`);
      results.push({ creator, mode: "timeout", creatorPoints: re.creatorPoints });
    }
  }

  const end = await waitFor(A, (m) => m.type === "matchEnd", "matchEnd", 20000);
  for (const r of results.filter((r) => r.mode !== "timeout")) {
    assert(end.scores[r.deliverer] >= DELIVER_PTS, `bot ${r.deliverer} banked a delivery award`);
  }
  const timeoutRound = results.find((r) => r.mode === "timeout");
  assert(end.scores[timeoutRound.creator] >= timeoutRound.creatorPoints, "timeout creator's points in final scores");
  await waitFor(A, (m) => m.type === "phase" && m.name === "LOBBY", "back to LOBBY after match");
  assert(true, "room returned to LOBBY for rematch");

  for (const b of bots) b.ws.close(1000, "bye");
} catch (e) {
  console.error("FAIL ", e.message);
  failures.push(e.message);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nfull match: all checks passed");
process.exit(0);
