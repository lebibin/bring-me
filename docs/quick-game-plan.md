# Quick Game — implementation plan

One-click play: a **quick game** button on the landing screen that (1) gives the
player a believable random name if they haven't picked one, (2) creates a
public room whose Durable Object lands near the player (already guaranteed by
the Worker's `roomLocation()` placement hint), and (3) fills the room with
server-side bots up to **5 total players** who play competitively. As real
players join the public room, bots quietly leave to make room, until the match
is all-human. Bots carry realistic names — never "Bot3" / "CPU".

---

## 1. Architecture decision: bots live in the Durable Object

Bots are **virtual players inside `BringMeRoom`** — entries in `this.players`
with no socket. Not external WebSocket clients (a Worker can't hold long-lived
outbound sockets for hours, and it would double infra) and not host-client
driven (host tab throttling would freeze them; matchbot.mjs already proved the
netcode but is a test harness, not production).

Why this works cheaply:

- `roster()`, snapshots, `match.ts` scoring, and `rules.ts` checks all iterate
  `this.players` / player ids — bots inherit every mechanic for free.
- `broadcast()` iterates `this.sockets`, so bots never receive messages; the
  bot AI runs in-process inside `tick()` and calls the same internal handlers
  (`onGrab`, `onDrop`, `onThrow`, `onStun`, `onPick`, `onPlace`, and a direct
  legal-speed position update) that human messages reach.
- The DO already runs `generateWorld(seed)` and the shared ballistics — bots
  can pathfind and compute throw power server-side with zero new wire traffic.

Bots appear on the wire only as ordinary `PlayerInfo` + snapshot rows. **No
S2C protocol change needed**; other players cannot distinguish them.

## 2. Wire protocol (shared/src/protocol.ts)

- `C2S hello` gains `quick?: boolean` — honored, like `pub`, only on the very
  first hello a brand-new room receives. `quick` implies `pub`.
- Additive optional field → **no PROTOCOL_VERSION bump**. Deploy server before
  client (old server ignores the flag; a quick-game click degrades to a plain
  public room, which is acceptable during rollout).

## 3. Shared package

### 3a. `shared/src/names.ts` (new)

One curated pool used by BOTH the client (randomizing the user's own name) and
the server (bot names) so the two populations are indistinguishable. ~80–120
entries mixing:

- plain first names: `maya`, `Jordan`, `kiko`, `sofie`, `Rohan`, `ella`
- casual handles: `notlucas`, `mika_p`, `dex`, `jm2`, `karlaaa`, `ben10x`

Rules: no "bot/ai/cpu/npc" substrings, no uniform capitalization, ≤16 chars
(server name clamp). Export `randomName(rng, exclude: Set<string>)` — picks
without repeats within a room and skips names already in the roster.

### 3b. `shared/src/constants.ts` — new tunables

```
QUICK_TARGET_PLAYERS = 5      // humans + bots the room tops up to
QUICK_BOT_JOIN_MIN_MS / MAX_MS = 1500 / 5000   // staggered, believable joins
QUICK_BOT_LEAVE_MIN_MS / MAX_MS = 2000 / 6000  // delay before a bot yields a seat
QUICK_AUTOSTART_MS = 12000    // lobby countdown before the match self-starts
QUICK_CREATE_SECS = 60        // snappier preset than the 90s default
QUICK_ROUND_SECS = 90
BOT_DECISION_HZ = 4           // AI decisions; movement still integrates at TICK_HZ
BOT_REACT_MIN_MS / MAX_MS = 1200 / 4500        // post-reveal reaction window
BOT_SKILL_MIN / MAX = 0.45 / 0.9               // per-bot competence scalar
```

### 3c. `shared/src/index.ts` — export the new module.

## 4. Client

### 4a. `client/src/ui/lobby.ts`

- New primary button **“quick game”** on the landing panel (above
  create/browse). Handler contract: `onQuickGame(name: string)`.
- Name flow: if the name input is empty AND `bringme_name` storage is empty,
  call `randomName()` and **write it into the input + storage before joining**
  so the player sees who they are. A typed/saved name is never overridden.
- Room panel: when the room was quick-created, show the auto-start countdown
  on the start button (`starting in 9s… (start now)`), driven by the existing
  `phase`-style lobby updates (see 5e).

### 4b. `client/src/main.ts`

- Wire `onQuickGame` → `join(newCode(), name, { pub: true, quick: true })`
  (extend `join()`'s `pub` boolean into a small options object).

### 4c. `client/src/net/client.ts`

- Constructor takes `quick`; hello sends `...(this.quick ? { quick: true, pub: true } : {})`.

The DO placement hint already pins the new room's DO to the creator's
continent/region — no client work needed for "the user's Cloudflare location".

## 5. Server — `BringMeRoom` bot seats & lifecycle

### 5a. State

```ts
private quick = false;                       // persisted
private readonly bots = new Map<number, BotState>(); // AI state; volatile
private botJoinAt = 0;                       // next staggered bot join (alarm)
private botLeaveAt = 0;                      // pending bot eviction (alarm)
private autoStartAt = 0;                     // quick-lobby self-start (alarm)
```

`Persisted` gains `quick?: boolean` and `botSeats?: { id: number; name: string;
hue: number }[]` so a hibernation wake can re-seat bots (AI state is volatile
and simply re-initializes; mid-round a rewoken bot just re-plans).

### 5b. Fill / evict rules (single function `reconcileBots(now)`)

Called from `onHello`, `dropSocket`, `alarm`, and phase transitions:

- Let `humans = this.sockets.size` (bots never own sockets).
- **Fill**: `quick && humans >= 1 && players.size < QUICK_TARGET_PLAYERS` →
  arm `botJoinAt = now + rand(JOIN_MIN, JOIN_MAX)`; the alarm adds ONE bot per
  firing (staggered joins look human). Adding a bot = allocate `nextId`, pick
  an unused name, `freshPlayer()`, broadcast `playerJoined` + `lobby`, persist
  seats. Bots joining mid-match spectate-wander like any late joiner
  (`isParticipant` already handles it).
- **Evict**: `players.size > QUICK_TARGET_PLAYERS && bots.size > 0` (a human
  joined) → arm `botLeaveAt = now + rand(LEAVE_MIN, LEAVE_MAX)`; on firing
  remove ONE bot via the shared removal path (5c). Repeat until the invariant
  holds. Humans past 5 keep evicting bots down to zero; beyond that the room
  is a normal public room up to `MAX_PLAYERS`.
- **No humans left**: remove ALL bots immediately, then the existing
  empty-room path (stop tick, deregister) runs unchanged. Bots must never keep
  a room alive or listed.
- **Refill after a human leaves**: only while `phase === LOBBY` (keeps the
  room attractive on the browser); never mid-match — a mid-match join couldn't
  play anyway, and roster churn during SEEK reads as weird.

### 5c. Extract `removePlayer(id, reason)` from `dropSocket`

`dropSocket` currently owns leaver logic (force-drop carried prop, host
migration, broadcasts, registry). Extract the id-keyed body so bot eviction
reuses it exactly — a leaving bot drops what it holds and broadcasts
`playerLeft` like any human. Two bot-specific guards:

- **Host migration must skip bots**: `hostId` fallback picks the next *human*
  (`this.sockets.has(id)`). A bot host would deadlock the start button.
- Registry `players` count includes bots (the row is the room's real
  occupancy; it's also what makes the room attractive to browsers).

### 5d. Constructor / wake path

After the stored-state restore: if `quick` and any socket survived, re-seat
`botSeats` into `this.players` with fresh AI state, and `reconcileBots(now)`.
The existing `ensureTick()` call already covers live phases; LOBBY-phase bot
joins ride the alarm (5f), not the tick — the DO may hibernate between them.

### 5e. Auto-start (recommended, see Decisions)

On quick-room creation set `autoStartAt = now + QUICK_AUTOSTART_MS`. Alarm
fires in LOBBY with ≥2 players → run the `onStart` body with the quick preset
settings (`QUICK_CREATE_SECS` / `QUICK_ROUND_SECS`, stage 0) as if the host
pressed start. Host pressing start earlier cancels it; a host `start` also
clears `autoStartAt`. Surface the countdown to clients by adding `startsAt?:
number` to the `lobby` S2C message (optional field, no version bump) so the
lobby button can render it.

### 5f. Alarm multiplexing

`scheduleAlarm()` candidates gain `botJoinAt`, `botLeaveAt`, `autoStartAt`.
`alarm()` handles each the same way it handles the registry heartbeat
(fire → act → re-arm/clear → `scheduleAlarm()`).

## 6. Server — bot AI (`server/src/bots.ts`, new)

Pure decision module per project convention (room owns I/O; bots.ts owns
thinking). Room calls `stepBots(ctx, now)` from `tick()`; decisions run at
`BOT_DECISION_HZ` with per-bot phase jitter, movement integrates every tick.

### 6a. Navigation

Coarse grid (1 m cells over the 60 m map) BFS **flow field** built from
`blockedAt(world, x, z, PLAYER_RADIUS)` — same technique worldcheck.mjs uses
for reachability. Cache per `(seed, stage)`: one field toward the NPC, plus
one on-demand field per SEEK target (invalidated each round). Steering: follow
the field with light per-bot lateral jitter; legal speed = `PLAYER_SPEED` /
`CARRY_SPEED` scaled by the bot's skill (0.85–1.0), positions set directly
(server-authoritative — no clamp round-trip needed, but never exceed the
human speed cap so bots feel fair).

If the target prop sits somewhere ground-unreachable (placed on a standable
top — legal via `placementValid(..., allowTops)`), the bot doesn't attempt
jumping in v1: it switches to **guard/contest** behavior (loiter between the
target and the NPC, stun carriers). Honest fallback, no pathological stalls.

### 6b. Per-phase behavior

- **LOBBY / COUNTDOWN / RESOLVE**: idle wander near spawn (tiny random walks
  so they read as human fidgeting; zero cost when tick isn't running).
- **CREATE**: after `rand(8–25s)`: pick a random archetype/hue/scale via
  `onPick`, walk to a chosen spot (biased away from the plaza, near scatter
  clutter — `placementValid` ring search like matchbot's `findSpot`), then
  `onPlace`. Walking there first matters: everyone can see hiders during
  CREATE, so teleport-placement would out them as bots. Their early placement
  also feeds the existing "everyone placed → skip timer" fast path.
- **REVEAL**: read the target from `currentTarget(match)` but do nothing yet —
  each bot rolls a reaction delay `rand(BOT_REACT_MIN, MAX) / skill`.
- **SEEK** (state machine per bot):
  - *creator of this round's target*: defend — position between own object and
    the plaza, stun (respecting `canStun` + cooldown) anyone carrying it,
    occasionally feint toward decoys.
  - *otherwise*: route to the target (bots legitimately know placements — every
    client received `propAdded` too, so this is the same information a human
    with good memory has). Grab via `onGrab`; on `taken`/race loss, switch to
    chasing the carrier for a stun-steal. Deliver by walking to the NPC;
    within ~6–9 m, skill-check to **throw** instead (power from the shared
    ballistics search, exactly matchbot's `powerForDistance`, precomputed as a
    small lookup table at module init — no per-frame sim loops).
  - Imperfection knobs (all skill-scaled): reaction delay, 10–20% chance of an
    initial wrong-direction wander, waypoint wobble, stun hesitation, and a
    small per-decision idle chance. Goal: bots win rounds sometimes, never
    metronomically.

### 6c. CPU budget

Flow-field build is O(3600 cells) once per round; decisions are 4 Hz × ≤4
bots; movement is a few mul-adds per tick. Negligible against the existing
15 Hz snapshot encode. No storage writes from AI (all volatile).

## 7. Files touched

| File | Change |
|---|---|
| `shared/src/protocol.ts` | `hello.quick`, `lobby.startsAt?` |
| `shared/src/constants.ts` | QUICK_* / BOT_* tunables |
| `shared/src/names.ts` (new) | name pool + `randomName()` |
| `shared/src/index.ts` | export names.ts |
| `server/src/room.ts` | quick flag, bot seats, reconcileBots, removePlayer extraction, alarm slots, auto-start, tick hook, wake re-seed |
| `server/src/bots.ts` (new) | nav grid + per-phase AI decisions (pure) |
| `client/src/ui/lobby.ts` | quick game button, name randomizer, countdown label |
| `client/src/main.ts` | wire onQuickGame |
| `client/src/net/client.ts` | quick flag in hello |
| `server/test/bots.test.ts` (new) | unit: flow field, reachability fallback, decision transitions |
| `server/test/quickgame.mjs` (new) | e2e vs wrangler dev (below) |

## 8. Delivery phases (each gated on `npm run check` + `npm test`)

1. **Shared + client shell** — names.ts, constants, protocol flag, landing
   button + name randomizer. Quick game degrades to "create public room with a
   random name" (fully shippable on its own).
2. **Bot seats, no brains** — join/evict/refill lifecycle, host-migration
   guard, persistence/wake, auto-start. Bots stand at spawn; CREATE auto-pregen
   already covers their objects. Verify with quickgame.mjs lifecycle asserts.
3. **Bot AI** — CREATE place-walk, SEEK navigate/grab/deliver, stun/throw,
   skill scalars. Verify with matchbot-style scripted humans losing/winning
   against bots.
4. **Balance + polish** — countdown UI copy, name pool review, skill tuning
   from real playtests, deploy (server first, then client).

## 9. Test plan

- `server/test/quickgame.mjs` (wrangler dev): human A hellos with
  `quick: true` → assert roster grows to 5 with plausible names and staggered
  `playerJoined`s; human B joins → assert exactly one `playerLeft` (a bot)
  within the eviction window and roster back to 5; A+B leave → GET /lobby no
  longer lists the room. Auto-start: assert `phase CREATE` arrives without any
  `start` being sent. Full-match smoke: one human idles; assert bots place
  objects during CREATE and at least one `delivered` by a bot id lands within
  two rounds.
- Unit (vitest): flow-field reachability matches worldcheck BFS on a seed
  sweep; unreachable-target → guard fallback; eviction picks bots not humans;
  host migration never lands on a bot.
- Browser: quick game click on 5175 → in a lobby with 4 named players, match
  self-starts; second tab joins the room code → one roster name departs.
  Companion.mjs still works as the "real player" joining a quick room.

## 10. Decisions taken (flag if you disagree)

- **Auto-start after 12 s** rather than waiting for the host's start click —
  "quick" means one click to gameplay; the host can still start instantly or
  the countdown gives real players a join window. (Alternative: keep manual
  start, cheaper by one alarm slot + UI label.)
- **Bots refill only in LOBBY**, never mid-match.
- **Registry player count includes bots** — the room really is occupied, and a
  "5/10 in lobby" row is what pulls real players in.
- **No PROTOCOL_VERSION bump** — all wire changes are optional fields; deploy
  server first.
- **Bots are invisible as bots to everyone** including the quick-game creator
  (per the request for believable names). If we ever want disclosure, a
  `PlayerInfo.bot?: true` flag visible only post-match is the cleanest retrofit.

## 11. Risks

- **Hibernation vs. LOBBY bots**: LOBBY has no tick; all lobby-phase bot
  lifecycle must be alarm-driven (it is, per 5f). Wake re-seeds from
  `botSeats`; mid-round AI state loss just means a re-plan (same class of
  recovery as the existing dyn-prop reset on wake).
- **Bot on a standable top / thrown target into weird spots**: guarded by the
  unreachable-fallback; worst case a round times out, which is a legal outcome
  (creator banks UNFOUND_PTS).
- **Believability under scrutiny**: perfectly straight paths and instant grabs
  read robotic; the skill/jitter knobs in 6b are load-bearing, not polish.
- **Two quick rooms**: two players both clicking quick game create two
  half-bot rooms instead of finding each other. Acceptable for v1; a future
  matchmaking pass could check GET /lobby for a joinable quick room before
  creating one.
