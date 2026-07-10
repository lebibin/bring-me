// Scripted WebSocket bots against a running `wrangler dev` (ws://127.0.0.1:8787).
// Usage: node server/test/bot.mjs   (exit 0 = pass)
// Needs Node >= 22 (global WebSocket).

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

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${code}`);
    const bot = { name, ws, id: 0, msgs: [], waiters: [] };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", name, v: 1 }));
    });
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
    ws.addEventListener("error", (e) => reject(new Error(`${name}: socket error`)));
    setTimeout(() => reject(new Error(`${name}: no welcome after 5s`)), 5000);
  });
}

function waitFor(bot, pred, label, ms = 5000) {
  const hit = bot.msgs.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting: ${label}`)), ms);
    bot.waiters.push({
      pred,
      resolve: (m) => {
        clearTimeout(t);
        resolve(m);
      },
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`room ${code} @ ${BASE}`);

  const a = await connect("botA");
  assert(a.id === 1, "botA got playerId 1");
  const b = await connect("botB");
  assert(b.id === 2, "botB got playerId 2");
  assert(a.seed === b.seed && a.seed > 0, "both bots share a nonzero seed");

  const lobbyA = await waitFor(a, (m) => m.type === "lobby" && m.players.length === 2, "A sees 2-player lobby");
  assert(lobbyA.players.find((p) => p.id === 1)?.isHost === true, "botA is host");

  // non-host start rejected
  b.ws.send(JSON.stringify({ type: "start", settings: { createSecs: 60, roundSecs: 60 } }));
  await waitFor(b, (m) => m.type === "err" && m.code === "not_host", "non-host start rejected");
  assert(true, "non-host start rejected with err:not_host");

  // host starts
  a.ws.send(JSON.stringify({ type: "start", settings: { createSecs: 60, roundSecs: 60 } }));
  await waitFor(b, (m) => m.type === "phase" && m.name === "CREATE", "phase CREATE broadcast");
  assert(true, "host start broadcasts phase CREATE");

  // B walks: report positions along +x at a legal speed
  const start = { x: 0, z: 0 };
  for (let i = 0; i <= 10; i++) {
    b.ws.send(JSON.stringify({ type: "pos", x: start.x + i * 0.35, z: start.z, yaw: 1.57 }));
    await sleep(66);
  }
  const snapA = await waitFor(
    a,
    (m) => m.type === "snapshot" && m.players.some((p) => p.id === 2 && Math.abs(p.x - 3.5) < 1.2),
    "A's snapshot shows B near x=3.5",
  );
  assert(true, `A sees B at x=${snapA.players.find((p) => p.id === 2).x} (walked ~3.5)`);

  // teleport must be clamped
  b.ws.send(JSON.stringify({ type: "pos", x: 25, z: -20, yaw: 0 }));
  await sleep(200);
  const snap2 = await waitFor(a, (m) => m.type === "snapshot", "snapshot after teleport");
  const bp = snap2.players.find((p) => p.id === 2);
  const jump = Math.hypot(bp.x - 3.5, bp.z - 0);
  assert(jump < 5, `teleport clamped (moved ${jump.toFixed(2)} m, not ~30)`);

  // leave -> playerLeft
  b.ws.close(1000, "bye");
  await waitFor(a, (m) => m.type === "playerLeft" && m.playerId === 2, "A gets playerLeft for B");
  assert(true, "disconnect broadcasts playerLeft");

  a.ws.close(1000, "bye");
} catch (e) {
  console.error("FAIL ", e.message);
  failures.push(e.message);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall bot checks passed");
process.exit(0);
