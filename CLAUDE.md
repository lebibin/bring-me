# Bring Me — project conventions

3D multiplayer browser party game based on the Filipino party game "Bring Me".
Players (identical low-poly blobs, "slops") each create + hide one catalog
object in a seeded world; each round a jumbotron announces one object and
everyone races to deliver it to the NPC blob (walk into him or throw it).
Full design + milestones: see the approved plan (scoring: creator accrues
line-of-sight points, x2 if unfound; deliverer gets a fixed award).

## Architecture

npm workspaces monorepo:

- `shared/` — protocol types, constants/tunables, seeded RNG, catalog data,
  worldgen, movement/ballistics sim. **Never import Three.js here** — the
  server loads this package. Consumed as raw TS source by both bundlers.
- `client/` — Vite (port **5175** — 5174 belongs to the chameleon project),
  Three.js rendering, bitECS game state (SoA, data-oriented — the "DOTS"
  requirement). Object meshes are built from primitives in
  `src/render/propMeshes.ts`, keyed by archetype ids from `shared/catalog.ts`.
- `server/` — Cloudflare Worker + Durable Object (`BringMeRoom`), authoritative
  for outcomes (grab/stun/throw/deliver/phases/scores); movement is
  client-simulated + server-clamped. WebSocket Hibernation API; phase deadlines
  live on `storage.setAlarm`, the 15 Hz tick interval runs only in live phases.

Netcode feel (client, `net/client.ts` + `game.ts`): own movement is predicted
locally (never waits); remote players interpolate on a 100 ms receive-time
buffer; grab/drop/throw apply **optimistically** the instant the key is
pressed — the DO's broadcast confirms (idempotent re-apply) and an `err` rolls
back to the recorded pre-action state (`NetClient.pending` +
`Game.forceDetach`); own position **reconciles** against snapshots
(`reconcileOwnPos`: dead zone < 0.9 m, blend to 3 m, snap beyond — constants in
shared). The DO stays the single authority for every contested event.

The world is never sent over the wire — both sides run
`generateWorld(seed)` from `shared/src/worldgen.ts` with the seed from
`welcome`.

## Commands

- `npm run check` — tsc --noEmit across all three packages. **The gate for
  every change.**
- `npm run dev:client` — Vite at http://localhost:5175
- `npm run dev:server` — wrangler dev at ws://127.0.0.1:8787
- `npm test` — vitest (pure match.ts/rules.ts unit tests)
- `node server/test/bot.mjs` — M1 presence/clamp bot checks against wrangler dev
- `node server/test/matchbot.mjs` — full scripted 3-bot match (walk-deliver,
  stun-steal + throw-deliver, LoS-timeout round; ~90 s, needs wrangler dev)
- `node server/test/companion.mjs <CODE>` — autonomous second player for
  browser e2e sessions (joins, places, delivers rounds that aren't its own)

## Verifying

Browser checks drive the deterministic test hook `window.__bringme`
(step(n,dt), pos(), grab(), throw(), world(seed), net.* actions...) — same
pattern as chameleon's `__cham`. Multiplayer checks: two tabs/iframes on one
room link, or the bot scripts.

Headless-tab gotchas (bots are the source of truth for netcode): rAF is
frozen (pump via `__bringme.frame(n,dt)` / `interp()`), and setTimeout/
setInterval throttle to 1/s then 1/min — the 15 Hz pos sender starves, so
walking "works" locally but the server sees stale positions. Range-checked
actions flush a fresh pos report first (NetClient.sendPosNow) to soften this.

## Conventions

- Strict TS everywhere; discriminated-union messages in `shared/src/protocol.ts`;
  all gameplay tunables live in `shared/src/constants.ts`, never inline.
- bitECS components hold numbers only; Object3D refs live in a
  `Map<eid, Object3D>` side-table keyed via `RenderRef`.
- Server game logic stays pure and unit-testable in `match.ts`/`rules.ts`;
  `room.ts` owns I/O (sockets, alarms, storage).
