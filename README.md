# Bring Me 🎉

A 3D multiplayer browser party game based on **Bring Me**, the Filipino party staple — with a
MECCHA CHAMELEON twist. Everyone secretly hides an object in a shared backyard; each round the
jumbotron flashes one of them and the whole lobby scrambles to find the real one among a hundred
lookalikes and bring it home first.

**▶ Play it now at [bringme.kevdashdev-cloudflare.workers.dev](https://bringme.kevdashdev-cloudflare.workers.dev/)** —
create a room and share the invite link; friends join straight from their browser, no install.

Built with **TypeScript + Three.js + bitECS** on the client and an authoritative
**Cloudflare Worker + Durable Object** room server. No engine, no heavy assets — every model in
the game is composed from primitives at runtime, and the entire world ships as a 4-byte seed.

---

## How a match plays

1. **Create & hide.** When the host starts, everyone picks an object from the catalog
   (basketball, garden gnome, rubber duck, watering can…), tints and sizes it, and plants it
   somewhere in the yard — in plain sight, ideally, since the world is already littered with
   procedurally scattered lookalikes. Everyone can watch everyone else hide. That's the game.
2. **BRING ME!** Rounds run one per hidden object, in seeded-random order. The in-world
   jumbotron counts down and flashes a **photo of the actual object** — not a name, not a color
   swatch — and every player's camera pans to the screen so nobody misses it.
3. **Scramble.** Find the one true object among the decoys (exact color and size matter), grab
   it with **E**, and get it to the NPC at the party plaza — walk it over, or hold **F** to
   charge a throw and lob it the way you're facing.
4. **Slap.** **Q** stuns a nearby player. Stun a carrier and they drop the goods for anyone to
   steal — one object, one winner per round.
5. **Score.**
   - The **finder** banks a delivery award the moment the object touches the NPC.
   - The **hider** earns passive points every second their object sits inside someone's view
     without being recognized — and **double** everything if the round timer runs out unfound.
   - Most points after every object has had its round wins.

The host sets the create-phase and per-round timers in the lobby. Matches need at least two
players; rounds equal the number of hidden objects, so nothing is ever announced twice.

## The trust model

The Durable Object is the single authority for everything contestable — grabs, stuns, throws,
deliveries, phase changes, timers, scores. One DO per room code means every player in a room
talks to the same isolate, so races (two players spamming grab on the same object) resolve by
simple arrival order, with no cross-server consistency questions at all.

Movement is deliberately looser: each client simulates its own character (zero input latency)
and reports position at 15 Hz; the server clamps reported movement to the speed cap, freezes
stunned players, and snapshots everyone back at 15 Hz. Remote players render on a ~100 ms
interpolation buffer. Contested actions apply **optimistically** — the object is in your hands
the frame you press E — and roll back cleanly if the server says someone else got there first.

Fairness details worth knowing:

- The world is generated from a shared seed on both client and server, and one shared
  `placementValid()` gates *everything* that puts an object on the lawn — the decoy scatter,
  player hiding spots, auto-generated objects for AFK players, even the test bots. You can't
  hide an apple inside the pool where nobody could see it.
- The reveal shows the target's exact look but never who hid it (that's revealed at round end).
- Hiders can't pick up their own object during its round.
- A slap's sound effect is chosen deterministically from the server's stun timestamp, so all
  eight players hear the *same* slap — one of 18, never the same twice in a row.

## The backyard

Every room generates a fresh suburban backyard from its seed: a house with garage doors and a
deck of navy patio sofas, a pool with loungers and a ladder, picket fences, cypress hedges, a
playground (swings, slide, seesaw) plus a second one in different colors, a basketball hoop
with a half-court pad, a soccer goal, a pond with a fountain, a trampoline, a sandbox with a
sandcastle, two sheds, two parked cars, a doghouse, a clothesline, a veggie garden, shade trees
with a tire swing, garden beds, park benches, clouds — and ~100 grabbable decoys scattered over
whatever lawn is left. Everything is flat-shaded Three.js primitives; the fence's ~700 pickets
are a single instanced draw call.

## The stack

- **Client:** [Three.js](https://threejs.org) rendering, [bitECS](https://github.com/NateTheGreatt/bitECS)
  for data-oriented game state (struct-of-arrays components — the "DOTS of the web"), Vite,
  strict TypeScript. Characters are smooth capsule blobs with a procedural walk cycle, carry
  pose, and slap animation. UI font is [Baloo 2](https://fonts.google.com/specimen/Baloo+2).
- **Server:** one Cloudflare **Durable Object per room** over the WebSocket Hibernation API.
  The 15 Hz tick runs only during live phases; every phase deadline is a storage alarm; match
  state persists across hibernation. Idle rooms cost nothing.
- **Shared:** protocol types, constants, the seeded world generator and the movement/ballistics
  sim live in one workspace package compiled from source by both bundlers — the throw arc you
  see is the same math the server resolves.
- **Match logic** (`match.ts`, `rules.ts`) is pure and unit-tested; the DO owns only I/O.

## Project structure

```
bringme/
├── .github/workflows/deploy.yml   # CI: check + test, deploy to Cloudflare, release on tags
├── shared/src/                    # protocol, constants, seeded worldgen, movement/ballistics
├── client/
│   ├── public/hits/               # the 18 slap sounds
│   └── src/
│       ├── ecs/                   # bitECS components, systems, input-as-data
│       ├── render/                # scene/backyard, prop meshes, character, jumbotron, product shots
│       ├── net/                   # socket, room client (optimistic actions + reconciliation)
│       ├── ui/                    # lobby, HUD, create panel
│       └── dev/hook.ts            # window.__bringme — deterministic headless test hook
└── server/
    ├── src/
    │   ├── index.ts               # Worker router + origin check
    │   ├── room.ts                # the Durable Object: sockets, tick, alarms, persistence
    │   ├── match.ts               # pure phase state machine
    │   └── rules.ts               # pure grab/stun/throw/LoS/delivery rules
    └── test/                      # scripted WebSocket bots (full-match integration tests)
```

## Running it locally

Needs Node ≥ 23.6 (the test bots import shared TypeScript directly).

```
npm install
npm run dev:server    # wrangler dev — the room server on ws://127.0.0.1:8787
npm run dev:client    # vite — the game on http://localhost:5175
```

Open two browser tabs on `http://localhost:5175`, create a room in one, and open the copied
invite link in the other. `#/sandbox` skips multiplayer entirely: free roam with a practice
round on **T**.

**Controls:** WASD move · drag to orbit · **E** grab · **G** drop · **F** hold-release throw ·
**Q** slap · **P** place (during create).

## Testing

```
npm run check                    # strict tsc across all three packages — the gate
npm test                         # vitest: the pure match/rules state machine
node server/test/bot.mjs         # presence, speed-clamp and lobby checks vs wrangler dev
node server/test/matchbot.mjs    # three bots play a full match: walk-deliver,
                                 # stun-steal + throw-deliver, and a timeout round (~90s)
```

Browser checks drive `window.__bringme` — a hook that steps the simulation deterministically
(fixed timesteps, synthetic input), so gameplay is scriptable headlessly. The two-player page
`client/test/harness.html` puts two clients in one room side by side.

## Deployment

The whole game deploys as **one Cloudflare Worker**: the built client is served as static
assets and `/room/*` upgrades to the Durable Object — same origin, so the page's own host is
the WebSocket host and no CORS or allowlist config exists at all.

```
npm run build -w @bringme/client
cd server && npx wrangler deploy --env production
```

CI does this automatically: every push to `main` runs checks + tests and deploys; pushing a
`v*` tag also cuts a GitHub Release. Full plan, options considered, and one-time setup:
[DEPLOY.md](DEPLOY.md).

## Roadmap

- [x] Seeded backyard world, identical on client and server
- [x] Rooms with shareable invite links (Durable Object per room, hibernation-friendly)
- [x] Full match loop: create & hide → reveal → scramble → score, with host-set timers
- [x] Optimistic grab/throw/drop with server rollback; own-position reconciliation
- [x] Slap stun with full-body animation and synchronized sound effects
- [x] Product-shot reveals (a photo of the actual object, not a name)
- [x] Public deploy — one Cloudflare Worker serving client + rooms
- [ ] Custom domain (bringme.bibin.dev)
- [ ] Reconnect-with-token (rejoin a live match after a refresh)
- [ ] Freeform object builder for hiders (compose from primitives)
- [ ] Occlusion-aware hidden-in-plain-sight scoring
- [ ] Mobile touch controls
- [ ] Audio beyond the slaps: music, ambience, delivery stingers
