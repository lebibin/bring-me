// Quick-game checks against a running `wrangler dev` (ws://127.0.0.1:8787):
// a single human quick-joins, the room fills with believably-named bots to a
// full table, self-starts without anyone pressing start, the bots hide their
// own objects during CREATE, a real joiner makes a bot yield its seat, and an
// emptied room is deregistered.
// Usage: node server/test/quickgame.mjs   (exit 0 = pass; ~40s)
// Needs Node >= 22 (global WebSocket + fetch) with type stripping for the
// shared .ts import.

import { NAME_POOL, QUICK_TARGET_PLAYERS } from "../../shared/src/index.ts";

const BASE = process.env.BM_URL ?? "ws://127.0.0.1:8787";
const HTTP = BASE.replace(/^ws/, "http");
const newCode = () =>
  "Q" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "0");

const failures = [];
function assert(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}`);
    failures.push(label);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poolLower = new Set(NAME_POOL.map((n) => n.toLowerCase()));

function connect(code, name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${code}`);
    const bot = { name, ws, id: 0, msgs: [], waiters: [], roster: [], closeCode: 0 };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", name, v: 2, ...extra })));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      bot.msgs.push(m);
      if (m.type === "welcome") {
        bot.id = m.playerId;
        bot.isPublic = m.isPublic;
        bot.roster = m.players;
        resolve(bot);
      }
      if ((m.type === "lobby" || m.type === "welcome") && Array.isArray(m.players)) bot.roster = m.players;
      for (const w of [...bot.waiters]) {
        if (w.pred(m)) {
          bot.waiters.splice(bot.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    ws.addEventListener("close", (ev) => (bot.closeCode = ev.code));
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

/** Poll a bot's latest roster until pred, or timeout. */
async function waitRoster(bot, pred, label, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    if (pred(bot.roster)) return bot.roster;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting roster: ${label} (last: ${bot.roster.length})`);
    await sleep(200);
  }
}

async function lobbyList() {
  const res = await fetch(`${HTTP}/lobby`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /lobby -> ${res.status}`);
  return (await res.json()).rooms;
}

try {
  const code = newCode();
  console.log(`quick room ${code} @ ${BASE}`);

  // --- one human quick-joins; the room fills to a full table with bots ---
  const me = await connect(code, "realkev", { quick: true });
  assert(me.isPublic === true, "quick room's welcome carries isPublic=true");
  await waitRoster(me, (r) => r.length === QUICK_TARGET_PLAYERS, `roster fills to ${QUICK_TARGET_PLAYERS}`);
  assert(me.roster.length === QUICK_TARGET_PLAYERS, `roster reached ${QUICK_TARGET_PLAYERS} players`);

  // --- the added players carry believable (pool) names, none bot-ish ---
  const bots = me.roster.filter((p) => p.id !== me.id);
  assert(bots.length === QUICK_TARGET_PLAYERS - 1, `${QUICK_TARGET_PLAYERS - 1} bots joined`);
  const botish = bots.filter((p) => /\b(bot|cpu|ai|npc|comp)\b|bot|cpu/i.test(p.name));
  assert(botish.length === 0, `no bot-ish names (${bots.map((b) => b.name).join(", ")})`);
  const fromPool = bots.every((p) => poolLower.has(p.name.toLowerCase()));
  assert(fromPool, "every bot name comes from the shared name pool");
  const uniqueNames = new Set(me.roster.map((p) => p.name.toLowerCase())).size === me.roster.length;
  assert(uniqueNames, "all names in the room are distinct");

  // --- the room is listed publicly with the full count ---
  const rooms = await lobbyList();
  const row = rooms.find((r) => r.code === code);
  assert(row && row.players === QUICK_TARGET_PLAYERS, `browser lists the room with ${QUICK_TARGET_PLAYERS} players`);

  // --- it self-starts: CREATE arrives though we never sent `start` ---
  const create = await waitFor(me, (m) => m.type === "phase" && m.name === "CREATE", "auto-start to CREATE", 25000);
  assert(create.name === "CREATE", "quick room auto-started into CREATE with no start pressed");
  assert(!me.msgs.some((m) => m.type === "err"), "no server errors up to auto-start");

  // --- bots hide their own objects during CREATE (creator ids that aren't us) ---
  await waitFor(
    me,
    () => new Set(me.msgs.filter((m) => m.type === "propAdded" && m.creatorId !== me.id).map((m) => m.creatorId)).size >= 3,
    "bots place objects during CREATE",
    40000,
  );
  const hidden = new Set(me.msgs.filter((m) => m.type === "propAdded" && m.creatorId !== me.id).map((m) => m.creatorId));
  assert(hidden.size >= 3, `at least 3 bots hid an object during CREATE (${hidden.size})`);

  me.ws.close(1000, "bye");

  // ---- eviction: a real joiner makes a bot yield its seat (fresh lobby) ----
  const code2 = newCode();
  console.log(`eviction room ${code2}`);
  const h1 = await connect(code2, "kevin", { quick: true });
  await waitRoster(h1, (r) => r.length === QUICK_TARGET_PLAYERS, "second room fills to full");
  const preBotIds = new Set(h1.roster.filter((p) => p.id !== h1.id).map((p) => p.id));

  // a real player joins the full table — total exceeds the target, a bot leaves
  const h2 = await connect(code2, "guest", {});
  const left = await waitFor(h1, (m) => m.type === "playerLeft" && preBotIds.has(m.playerId), "a bot yields to the human", 12000);
  assert(preBotIds.has(left.playerId), `an existing bot (id ${left.playerId}) left when the human joined`);
  await waitRoster(h1, (r) => r.length === QUICK_TARGET_PLAYERS, "table settles back to the target size");
  const humanIds = new Set([h1.id, h2.id]);
  const stillBots = h1.roster.filter((p) => !humanIds.has(p.id)).length;
  assert(h1.roster.length === QUICK_TARGET_PLAYERS && stillBots === QUICK_TARGET_PLAYERS - 2, "room is 2 humans + (target-2) bots");

  h1.ws.close(1000, "bye");
  h2.ws.close(1000, "bye");

  // ---- cleanup: with no humans left, the room drops its bots and delists ----
  const t0 = Date.now();
  for (;;) {
    const rs = await lobbyList();
    if (!rs.some((r) => r.code === code2)) break;
    if (Date.now() - t0 > 8000) throw new Error("emptied quick room still listed");
    await sleep(300);
  }
  assert(true, "emptied quick room is deregistered (no bot-only rooms linger)");
} catch (e) {
  console.error("FAIL ", e.message);
  failures.push(e.message);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall quick-game checks passed");
process.exit(0);
