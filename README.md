<p align="center">
  <img src="client/public/logo.png" alt="BRING ME!" width="440" />
</p>

A 3D multiplayer browser party game based on **Bring Me**, the Filipino party staple — with a
MECCHA CHAMELEON twist. Everyone secretly hides an object in a shared world; each round the
jumbotron flashes one of them and the whole lobby scrambles to find the real one among a hundred
lookalikes and bring it home first.

**▶ Play it now at [bringme.kevdashdev-cloudflare.workers.dev](https://bringme.kevdashdev-cloudflare.workers.dev/)** —
create a room for up to **10 players** and share the invite link, or make it **public** and let
anyone browse in from the lobby (player count, room status and a live latency estimate included).
Friends join straight from their browser, no install.

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
5. **Score.** Party-readable on purpose: deliver someone's object = **1 point**; your own
   object surviving its whole round unfound = **2 points**. Most points after every object has
   had its round wins, and a medal scoreboard keeps cumulative standings across every game the
   room plays.

The host picks the stage and sets the create-phase and per-round timers in the lobby. Matches
need at least two players; rounds equal the number of hidden objects, so nothing is ever
announced twice.

## The trust model

The Durable Object is the single authority for everything contestable — grabs, stuns, throws,
deliveries, phase changes, timers, scores. One DO per room code means every player in a room
talks to the same isolate, so races (two players spamming grab on the same object) resolve by
simple arrival order, with no cross-server consistency questions at all.

Movement is deliberately looser: each client simulates its own character (zero input latency)
and reports position at 15 Hz; the server clamps reported movement to the speed cap, freezes
stunned players, and snapshots everyone back at 15 Hz. Remote players render on a ~160 ms
interpolation buffer with bounded extrapolation. Contested actions apply **optimistically** —
the object is in your hands the frame you press E — and roll back cleanly if the server says
someone else got there first. Drop mid-match and you can rejoin as yourself: every welcome
carries a resume token that reclaims your player, score and seat after a refresh or a flaky
connection.

Abuse gets bounded before it reaches a room: per-IP rate limits on socket upgrades and lobby
traffic, a per-socket message budget (flooders get disconnected), an origin allowlist, and a
hard cap of 10 players per room — broadcasts scale with the square of the room size, so the
cap is what keeps every room cheap and smooth.

Fairness details worth knowing:

- The world is generated from a shared seed on both client and server, and one shared
  `placementValid()` gates *everything* that puts an object on the lawn — the decoy scatter,
  player hiding spots, auto-generated objects for AFK players, even the test bots. You can't
  hide an apple inside the pool where nobody could see it.
- The reveal shows the target's exact look but never who hid it (that's revealed at round end).
- Hiders can't pick up their own object during its round.
- A slap's sound effect is chosen deterministically from the server's stun timestamp, so the
  whole room hears the *same* slap — one of 18, never the same twice in a row.

## The stages

Every room generates a fresh world from its seed on one of three stages the host picks in the
lobby — **Backyard**, **City Park**, or **Beach Cove**. Same bones, different dressing: a house
with garage doors and a deck of patio sofas, a pool with loungers (or a duck pond), picket
fences, cypress hedges, two playgrounds, a basketball hoop, a soccer goal, a fountain pond, a
trampoline, a sandbox with a sandcastle, two sheds, two parked cars, a doghouse, a clothesline,
a veggie garden, shade trees with a tire swing, garden beds, park benches, clouds — and ~100
grabbable decoys scattered over whatever lawn is left. Everything is flat-shaded Three.js
primitives; the fence's ~700 pickets are a single instanced draw call.

Placement is self-validating: fixtures reserve their footprints before anything random lands,
biggest first, and generation flood-fills the map to guarantee every spawn point can actually
reach the party plaza — a CI sweep asserts all of it across hundreds of seeds on every stage.

## The stack

- **Client:** [Three.js](https://threejs.org) rendering, [bitECS](https://github.com/NateTheGreatt/bitECS)
  for data-oriented game state (struct-of-arrays components — the "DOTS of the web"), Vite,
  strict TypeScript. Characters are smooth capsule blobs — pick your own color — with a
  procedural walk cycle, carry pose, and slap animation. UI font is
  [Baloo 2](https://fonts.google.com/specimen/Baloo+2).
- **Server:** one Cloudflare **Durable Object per room** over the WebSocket Hibernation API.
  The 15 Hz tick runs only during live phases; every phase deadline is a storage alarm; match
  state persists across hibernation. Idle rooms cost nothing. A single **LobbyRegistry** DO
  holds the public-room list — rooms report in over an internal binding (unreachable from the
  public internet, so listings can't be spoofed) and the browse screen polls `GET /lobby`.
- **Shared:** protocol types, constants, the seeded world generator and the movement/ballistics
  sim live in one workspace package compiled from source by both bundlers — the throw arc you
  see is the same math the server resolves.
- **Match logic** (`match.ts`, `rules.ts`) is pure and unit-tested; the DO owns only I/O.

## Project structure

```
bringme/
├── .github/workflows/deploy.yml   # CI: check + test, deploy to Cloudflare, release + itch on tags
├── shared/src/                    # protocol, constants, seeded worldgen, movement/ballistics
├── client/
│   ├── public/hits/               # the 18 slap sounds
│   └── src/
│       ├── ecs/                   # bitECS components, systems, input-as-data
│       ├── render/                # scene/stages, prop meshes, character, jumbotron, product shots
│       ├── net/                   # socket, room client (optimistic actions), lobby browse API
│       ├── ui/                    # lobby (landing + room browser), HUD, create panel
│       └── dev/hook.ts            # window.__bringme — deterministic headless test hook
└── server/
    ├── src/
    │   ├── index.ts               # Worker router: rooms, lobby list, latency pings, rate limits
    │   ├── room.ts                # the Durable Object: sockets, tick, alarms, persistence
    │   ├── registry.ts            # the LobbyRegistry Durable Object (public-room list)
    │   ├── origins.ts             # origin allowlist (same-origin, localhost, itch.io iframe)
    │   ├── bucket.ts              # per-socket message-rate token bucket
    │   ├── match.ts               # pure phase state machine
    │   └── rules.ts               # pure grab/stun/throw/delivery rules
    └── test/                      # vitest units + scripted WebSocket bots
```

## Running it locally

Needs Node ≥ 23.6 (the test bots import shared TypeScript directly).

```
npm install
npm run dev:server    # wrangler dev — the room server on ws://127.0.0.1:8787
npm run dev:client    # vite — the game on http://localhost:5175
```

Open two browser tabs on `http://localhost:5175`, create a room in one (tick "public room"
to see it appear in the other tab's room browser), and join from the browse list or the
copied invite link. `#/sandbox` skips multiplayer entirely: free roam with a practice round
on **T**, and `?stage=N` previews any stage.

**Controls:** WASD move · **Space** jump · drag to orbit · **E** grab · **G** drop ·
**F** hold-release throw · **Q** slap · **R** place (during create).

## Testing

```
npm run check                      # strict tsc across all three packages — the gate
npm test                           # vitest: match/rules state machine, origin allowlist,
                                   # message-rate token bucket
node server/test/worldcheck.mjs    # world-gen safety sweep: spawns clear, spaced, and
                                   # NPC-reachable, no overlapping solids (seeds × 3 stages)
node server/test/bot.mjs           # presence + speed-clamp checks vs wrangler dev
node server/test/matchbot.mjs      # three bots play a full match: walk-deliver,
                                   # stun-steal + throw-deliver, and a timeout round (~90s)
node server/test/lobbybot.mjs      # public-room registry lifecycle, latency ping, flood close
node server/test/reconnectbot.mjs  # resume-token rejoin mid-match
node server/test/totalsbot.mjs     # cross-game standings accumulate
```

Browser checks drive `window.__bringme` — a hook that steps the simulation deterministically
(fixed timesteps, synthetic input), so gameplay is scriptable headlessly. The two-player page
`client/test/harness.html` puts two clients in one room side by side.

## Deployment

The whole game deploys as **one Cloudflare Worker**: the built client is served as static
assets and `/room/*` upgrades to the Durable Object — same origin, so the web build needs no
CORS or server-URL config at all.

```
npm run build -w @bringme/client
cd server && npx wrangler deploy --env production
```

There's also an **itch.io channel**: `npm run build:itch` produces a relative-base build with
the production Worker baked in (itch serves games cross-origin from its CDN, which is what the
origin allowlist and CORS handling exist for).

CI does all of it: every push to `main` runs checks + tests and deploys the Worker; pushing a
`v*` tag also cuts a GitHub Release and butler-pushes the itch channel. Full plan, options
considered, and one-time setup: [DEPLOY.md](DEPLOY.md).

## Roadmap

- [x] Seeded world, identical on client and server — three stages (Backyard, City Park, Beach Cove)
- [x] Rooms with shareable invite links (Durable Object per room, hibernation-friendly)
- [x] Full match loop: create & hide → reveal → scramble → score, with host-set timers
- [x] Optimistic grab/throw/drop with server rollback; own-position reconciliation
- [x] Slap stun with full-body animation and synchronized sound effects; jumping
- [x] Product-shot reveals (a photo of the actual object, not a name)
- [x] Public deploy — one Cloudflare Worker serving client + rooms
- [x] Reconnect-with-token (rejoin a live match after a refresh) + cross-game standings
- [x] Public rooms + lobby browser with player counts and latency estimates (10-player rooms)
- [x] Launch guardrails: origin allowlist, per-IP and per-socket rate limits
- [x] itch.io channel via butler in CI
- [x] Round SFX: countdown tick, start fanfare, win jingle (+ the 18 slaps)
- [ ] Custom domain (bringme.bibin.dev)
- [ ] Freeform object builder for hiders (compose from primitives)
- [ ] Occlusion-aware hidden-in-plain-sight scoring
- [ ] Mobile touch controls
- [ ] Music and ambience
