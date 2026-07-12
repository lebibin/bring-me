// Public-lobby checks against a running `wrangler dev` (ws://127.0.0.1:8787):
// registry upsert on join/start/leave, private rooms unlisted, latency ping,
// and the per-socket message-rate close.
// Usage: node server/test/lobbybot.mjs   (exit 0 = pass)
// Needs Node >= 22 (global WebSocket + fetch).

const BASE = process.env.BM_URL ?? "ws://127.0.0.1:8787";
const HTTP = BASE.replace(/^ws/, "http");
const newCode = () =>
  "L" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "0");

const failures = [];
function assert(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}`);
    failures.push(label);
  }
}

function connect(code, name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${code}`);
    const bot = { name, ws, id: 0, msgs: [], waiters: [], closeCode: 0 };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", name, v: 2, ...extra }));
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
        bot.isPublic = m.isPublic;
        resolve(bot);
      }
    });
    ws.addEventListener("close", (ev) => {
      bot.closeCode = ev.code;
    });
    ws.addEventListener("error", () => reject(new Error(`${name}: socket error`)));
    setTimeout(() => reject(new Error(`${name}: no welcome after 5s`)), 5000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lobbyList() {
  const res = await fetch(`${HTTP}/lobby`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /lobby -> ${res.status}`);
  return (await res.json()).rooms;
}

/** Poll /lobby until pred(rooms) or timeout — registry pushes are fire-and-forget. */
async function waitLobby(pred, label, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const rooms = await lobbyList();
    if (pred(rooms)) return rooms;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${label}`);
    await sleep(250);
  }
}

try {
  const pubCode = newCode();
  const privCode = newCode();
  console.log(`public ${pubCode}, private ${privCode} @ ${BASE}`);

  // --- registration + welcome flag ---
  const host = await connect(pubCode, "hostbot", { pub: true });
  assert(host.isPublic === true, "welcome carries isPublic for the public room");
  let rooms = await waitLobby(
    (rs) => rs.some((r) => r.code === pubCode && r.players === 1 && r.status === "lobby"),
    "public room listed with 1 player in lobby",
  );
  const row = rooms.find((r) => r.code === pubCode);
  assert(row.hostName === "hostbot", `row carries the host name (${row.hostName})`);

  // --- private rooms never appear ---
  const priv = await connect(privCode, "privbot");
  assert(priv.isPublic === false, "private room's welcome has isPublic=false");
  await sleep(600);
  rooms = await lobbyList();
  assert(!rooms.some((r) => r.code === privCode), "private room absent from /lobby");

  // --- player count updates ---
  const guest = await connect(pubCode, "guestbot");
  await waitLobby(
    (rs) => rs.some((r) => r.code === pubCode && r.players === 2),
    "second joiner bumps the listed count to 2",
  );
  assert(true, "second joiner bumps the listed count to 2");

  // --- start flips status to match ---
  host.ws.send(JSON.stringify({ type: "start", settings: { createSecs: 30, roundSecs: 30, stage: 0 } }));
  await waitLobby(
    (rs) => rs.some((r) => r.code === pubCode && r.status === "match"),
    "match start flips status to match",
  );
  assert(true, "match start flips the listed status to match");

  // --- latency ping ---
  const ping = await fetch(`${HTTP}/room/${pubCode}/ping`, { cache: "no-store" });
  assert(ping.status === 204, `GET /room/CODE/ping -> 204 (got ${ping.status})`);
  const badPing = await fetch(`${HTTP}/room/${"Z".repeat(13)}/ping`);
  assert(badPing.status === 200 && (await badPing.text()).startsWith("bring me"), "overlong code falls through to the banner");

  // --- message-rate flood -> close 1008 ---
  const flooder = await connect(pubCode, "floodbot");
  for (let i = 0; i < 200; i++) {
    flooder.ws.send(JSON.stringify({ type: "pos", x: 0, z: 0, yaw: 0 }));
  }
  await sleep(1200);
  assert(flooder.closeCode === 1008, `flooding closes the socket with 1008 (got ${flooder.closeCode})`);

  // --- all-disconnect deregisters ---
  host.ws.close(1000, "bye");
  guest.ws.close(1000, "bye");
  await waitLobby((rs) => !rs.some((r) => r.code === pubCode), "empty room removed from /lobby");
  assert(true, "empty public room is deregistered");

  priv.ws.close(1000, "bye");
} catch (e) {
  console.error("FAIL ", e.message);
  failures.push(e.message);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall lobby checks passed");
process.exit(0);
