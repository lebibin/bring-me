/**
 * BringMeRoom — one Durable Object per room code, the authoritative server.
 *
 * Owns I/O only: sockets (WebSocket Hibernation API), the 15 Hz tick, storage
 * and alarms. Game logic lives in the pure modules match.ts / rules.ts.
 *
 * Hibernation contract: the tick interval runs only while a match is live and
 * sockets are connected (an idle LOBBY hibernates); every phase deadline is a
 * storage alarm (multiplexed with the room TTL); match state is persisted at
 * every transition and restored in the constructor.
 */

import {
  ARCHETYPES,
  CARRY_HEIGHT,
  CREATED_PROP_ID_BASE,
  CARRY_SPEED,
  CREATE_SECS_DEFAULT,
  CREATE_SECS_MAX,
  CREATE_SECS_MIN,
  DROP_LOCK_MS,
  MAP_SIZE,
  MAX_PLAYERS,
  PLAYER_SPEED,
  PROP_REST_Y,
  PROTOCOL_VERSION,
  ROUND_SECS_DEFAULT,
  ROUND_SECS_MAX,
  ROUND_SECS_MIN,
  SCALE_MAX,
  SCALE_MIN,
  SPEED_CLAMP_SLACK,
  STUN_COOLDOWN_MS,
  STUN_DURATION_MS,
  TICK_MS,
  archetypeIndex,
  clampParams,
  clampToMap,
  decodeC2S,
  encode,
  generateWorld,
  groundHeightAt,
  mulberry32,
  placementValid,
  q2,
  randRange,
  stepBallistic,
  throwVelocity,
  type Ballistic,
  type C2S,
  type MatchSettings,
  type PhaseName,
  type PlayerInfo,
  type RoomTotals,
  type S2C,
  type SnapshotLoose,
  type SnapshotPlayer,
  type World,
} from "@bringme/shared";
import {
  accrue,
  advanceRound,
  beginRounds,
  createdPropId,
  currentTarget,
  newMatch,
  placeObject,
  resolveRound,
  toReveal,
  toSeek,
  type MatchState,
} from "./match.ts";
import {
  airborneDelivery,
  canGrab,
  canStun,
  carriedDelivery,
  losActive,
  nearestStunVictim,
  type RulePlayer,
  type RuleTarget,
} from "./rules.ts";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const HALF = MAP_SIZE / 2;
// Party-game pragmatism: 2 players is a valid (if degenerate) match; the
// plan's ≥3 rule matters for fun, not correctness, and 2 keeps testing easy.
const MIN_START_PLAYERS = 2;

interface Attachment {
  playerId: number;
  name: string;
}

interface PlayerState extends RulePlayer {
  name: string;
  y: number; // jump height, client-reported
  lastPosMs: number;
}

/**
 * Runtime state of any displaced prop — the round target OR a decoy someone
 * picked up for chaos. Created lazily on first grab; volatile (on wake,
 * displaced decoys reset to their home spots).
 */
interface DynProp {
  propId: number;
  creatorId: number; // only enforced while this prop is the round target
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  airborne: boolean;
  heldBy: number;
  thrownBy: number;
  lockUntil: number;
  lockedFor: number;
  moved: boolean;
  wrongHit: boolean; // decoy already bonked the NPC once (one "wrong!" per flight)
}

interface Persisted {
  seed: number;
  nextId: number;
  hostId: number;
  settings: MatchSettings;
  ttlAt: number;
  /** cumulative standings across finished games; lives as long as the room */
  totals: RoomTotals;
  /** resume token -> the player it reclaims; lets a dropped socket rejoin as itself */
  resumeTokens: Record<string, { id: number; name: string }>;
}

export class BringMeRoom {
  private readonly players = new Map<number, PlayerState>();
  private readonly sockets = new Map<number, WebSocket>();
  private readonly picks = new Map<number, { archetype: number; hue: number; scale: number }>();
  private seed = 0;
  private nextId = 1;
  private hostId = 0;
  private ttlAt = 0;
  private settings: MatchSettings = {
    createSecs: CREATE_SECS_DEFAULT,
    roundSecs: ROUND_SECS_DEFAULT,
  };
  private totals: RoomTotals = {};
  private resumeTokens: Record<string, { id: number; name: string }> = {};
  private match: MatchState | null = null;
  /** propId -> runtime state for every prop that has been grabbed/moved */
  private readonly dyn = new Map<number, DynProp>();
  private tickHandle: number | null = null;
  private worldCache: World | null = null;

  constructor(private readonly state: DurableObjectState) {
    // keepalive: the edge/NATs kill idle WebSockets (lobbies send nothing for
    // minutes) — answer pings in the runtime without ever waking the DO
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(encode({ type: "ping" }), encode({ type: "pong" })),
    );
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Persisted>("room");
      if (stored) {
        this.seed = stored.seed;
        this.nextId = stored.nextId;
        this.hostId = stored.hostId;
        this.settings = stored.settings;
        this.ttlAt = stored.ttlAt;
        this.totals = stored.totals ?? {};
        this.resumeTokens = stored.resumeTokens ?? {};
      }
      this.match = (await this.state.storage.get<MatchState>("match")) ?? null;
      for (const ws of this.state.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (!att) continue;
        this.sockets.set(att.playerId, ws);
        this.players.set(att.playerId, this.freshPlayer(att.playerId, att.name));
      }
      // Waking mid-round: the target's runtime state was volatile; restore it
      // at its placed position (a held/thrown prop resets — recoverable, not
      // match-destroying).
      if (this.match && (this.match.phase === "SEEK" || this.match.phase === "REVEAL")) {
        this.initDyn();
      }
      if (this.phase() !== "LOBBY" && this.sockets.size > 0) this.ensureTick();
    });
  }

  private phase(): PhaseName {
    return this.match?.phase ?? "LOBBY";
  }

  private world(): World {
    if (!this.worldCache || this.worldCache.seed !== this.seed) {
      this.worldCache = generateWorld(this.seed);
    }
    return this.worldCache;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    if (this.ttlAt === 0) {
      this.ttlAt = Date.now() + ROOM_TTL_MS;
      this.persist();
      await this.scheduleAlarm();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 4096) return;
    const msg = decodeC2S(raw);
    if (!msg) return;
    // normally answered by the auto-response pair without reaching us
    if (msg.type === "ping") {
      this.say(ws, { type: "pong" });
      return;
    }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) {
      if (msg.type === "hello") this.onHello(ws, msg);
      else this.say(ws, { type: "err", code: "bad_input" });
      return;
    }
    const p = this.players.get(att.playerId);
    if (!p) return;
    switch (msg.type) {
      case "start":
        await this.onStart(p, msg.settings);
        break;
      case "pos":
        this.onPos(p, msg.x, msg.z, msg.yaw, msg.y ?? 0);
        break;
      case "pickObject":
        this.onPick(p, msg.archetype, msg.params.hue, msg.params.scale);
        break;
      case "placeObject":
        this.onPlace(p, msg.x, msg.z);
        break;
      case "grab":
        this.onGrab(p, msg.propId);
        break;
      case "drop":
        this.onDrop(p);
        break;
      case "throw":
        this.onThrow(p, msg.dirX, msg.dirZ, msg.power);
        break;
      case "stun":
        this.onStun(p);
        break;
      case "leave":
        ws.close(1000, "left");
        break;
      case "hello":
        break; // already joined
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.dropSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.dropSocket(ws);
  }

  /** Multiplexed alarm: room TTL or the current phase deadline. */
  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.ttlAt > 0 && now >= this.ttlAt) {
      for (const ws of this.sockets.values()) {
        try {
          ws.close(1000, "room expired");
        } catch {
          /* dead socket */
        }
      }
      this.sockets.clear();
      this.players.clear();
      this.stopTick();
      await this.state.storage.deleteAll();
      return;
    }
    const m = this.match;
    if (m && m.phaseEndsAt > 0 && now >= m.phaseEndsAt - 50) {
      this.onPhaseDeadline(now);
    }
    await this.scheduleAlarm();
  }

  // ---------- join / leave ----------

  private onHello(ws: WebSocket, msg: Extract<C2S, { type: "hello" }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.say(ws, { type: "err", code: "version" });
      ws.close(1008, "protocol version mismatch");
      return;
    }
    // A valid resume token reclaims the caller's old seat — same playerId,
    // same scores, still a match participant. Everything else joins fresh.
    const resumed = msg.resume ? this.resumeTokens[msg.resume] : undefined;
    if (!resumed && this.players.size >= MAX_PLAYERS) {
      this.say(ws, { type: "err", code: "full" });
      ws.close(1008, "room full");
      return;
    }
    let id: number;
    let name: string;
    let token: string;
    if (resumed) {
      id = resumed.id;
      name = resumed.name;
      token = msg.resume!;
      // a half-open zombie socket may still hold the seat — supersede it
      const old = this.sockets.get(id);
      if (old && old !== ws) {
        try {
          old.close(1000, "superseded by reconnect");
        } catch {
          /* already dead */
        }
        this.sockets.delete(id);
      }
    } else {
      name = String(msg.name).trim().slice(0, 16) || "slop";
      id = this.nextId++;
      token = crypto.randomUUID();
      this.resumeTokens[token] = { id, name };
    }
    if (this.hostId === 0) this.hostId = id;
    if (this.seed === 0) this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.persist();

    ws.serializeAttachment({ playerId: id, name } satisfies Attachment);
    this.sockets.set(id, ws);
    // keep live state (position, carry) when superseding; respawn otherwise
    if (!this.players.has(id)) this.players.set(id, this.freshPlayer(id, name));

    this.say(ws, {
      type: "welcome",
      playerId: id,
      seed: this.seed,
      phase: this.phase(),
      players: this.roster(),
      settings: this.settings,
      scores: this.match?.scores ?? {},
      totals: this.totals,
      resume: token,
    });
    // Late joiners still need every placed object to render the world.
    if (this.match) {
      for (const [creatorId, prop] of Object.entries(this.match.objects)) {
        this.say(ws, { type: "propAdded", prop, creatorId: Number(creatorId) });
      }
      if (this.match.phaseEndsAt > 0) {
        this.say(ws, { type: "phase", name: this.phase(), endsAt: this.match.phaseEndsAt });
      }
    }
    this.broadcast({ type: "playerJoined", player: this.info(this.players.get(id)!) }, id);
    this.broadcast({ type: "lobby", players: this.roster(), settings: this.settings, totals: this.totals });
    if (this.phase() !== "LOBBY") this.ensureTick();
  }

  private dropSocket(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (this.sockets.get(att.playerId) !== ws) return;
    const p = this.players.get(att.playerId);
    // A leaver holding anything drops it in place.
    const held = p && p.carry >= 0 ? this.dyn.get(p.carry) : undefined;
    if (p && held && held.heldBy === p.id) {
      held.heldBy = 0;
      held.x = p.x;
      held.z = p.z;
      held.y = groundHeightAt(this.world(), p.x, p.z, Math.max(p.y, 0), 0.05) + PROP_REST_Y;
      held.moved = true;
      this.broadcast({ type: "dropped", propId: held.propId, x: q2(p.x), z: q2(p.z), lockUntil: 0, lockedFor: 0 });
    }
    this.sockets.delete(att.playerId);
    this.players.delete(att.playerId);
    this.picks.delete(att.playerId);
    if (this.hostId === att.playerId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? 0 : next.value;
      this.persist();
    }
    this.broadcast({ type: "playerLeft", playerId: att.playerId });
    this.broadcast({ type: "lobby", players: this.roster(), settings: this.settings, totals: this.totals });
    if (this.sockets.size === 0) this.stopTick();
  }

  // ---------- lobby / create ----------

  private async onStart(p: PlayerState, raw: MatchSettings): Promise<void> {
    if (p.id !== this.hostId) {
      this.sayTo(p.id, { type: "err", code: "not_host" });
      return;
    }
    if (this.phase() !== "LOBBY") {
      this.sayTo(p.id, { type: "err", code: "bad_phase" });
      return;
    }
    if (this.players.size < MIN_START_PLAYERS) {
      this.sayTo(p.id, { type: "err", code: "bad_input" });
      return;
    }
    this.settings = {
      createSecs: clampInt(raw?.createSecs, CREATE_SECS_MIN, CREATE_SECS_MAX, CREATE_SECS_DEFAULT),
      roundSecs: clampInt(raw?.roundSecs, ROUND_SECS_MIN, ROUND_SECS_MAX, ROUND_SECS_DEFAULT),
    };
    const now = Date.now();
    this.match = newMatch(this.seed, this.settings, [...this.players.keys()], now);
    this.dyn.clear();
    for (const pl of this.players.values()) pl.carry = -1;
    this.picks.clear();
    this.persist();
    this.persistMatch();
    this.broadcast({ type: "phase", name: "CREATE", endsAt: this.match.phaseEndsAt });
    this.ensureTick();
    await this.scheduleAlarm();
  }

  private onPick(p: PlayerState, archetype: string, hue: number, scale: number): void {
    if (this.phase() !== "CREATE" || !this.isParticipant(p.id)) {
      this.sayTo(p.id, { type: "err", code: "bad_phase" });
      return;
    }
    const idx = archetypeIndex(archetype);
    if (idx < 0) {
      this.sayTo(p.id, { type: "err", code: "bad_input" });
      return;
    }
    const params = clampParams({ hue, scale });
    this.picks.set(p.id, { archetype: idx, hue: params.hue, scale: params.scale });
  }

  private onPlace(p: PlayerState, x: number, z: number): void {
    const m = this.match;
    if (!m || m.phase !== "CREATE" || !this.isParticipant(p.id)) {
      this.sayTo(p.id, { type: "err", code: "bad_phase" });
      return;
    }
    const pick = this.picks.get(p.id);
    if (!pick) {
      this.sayTo(p.id, { type: "err", code: "bad_input" });
      return;
    }
    // bounds, plaza keep-out, off-limits zones — standable tops ARE legal
    if (!placementValid(this.world(), x, z, true)) {
      this.sayTo(p.id, { type: "err", code: "bad_input" });
      return;
    }
    const prop = placeObject(m, p.id, { archetype: pick.archetype, hue: pick.hue, scale: pick.scale, x, z });
    this.persistMatch();
    this.broadcast({ type: "propAdded", prop, creatorId: p.id });
    // Everyone placed? No reason to sit out the rest of the CREATE timer.
    if (Object.keys(m.scores).every((id) => m.objects[Number(id)])) {
      this.onPhaseDeadline(Date.now());
      void this.scheduleAlarm();
    }
  }

  /** Anyone unplaced when CREATE ends gets a seeded auto object ("pre-generate"). */
  private autoPregen(): void {
    const m = this.match;
    if (!m) return;
    const w = this.world();
    for (const id of Object.keys(m.scores).map(Number)) {
      if (m.objects[id]) continue;
      const rng = mulberry32((this.seed ^ (id * 0x85ebca6b)) >>> 0);
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 40; attempt++) {
        x = randRange(rng, -HALF + 2, HALF - 2);
        z = randRange(rng, -HALF + 2, HALF - 2);
        if (placementValid(w, x, z) && Math.hypot(x - w.plaza.x, z - w.plaza.z) >= 15) break;
      }
      const prop = placeObject(m, id, {
        archetype: Math.floor(rng() * ARCHETYPES.length),
        hue: randRange(rng, 0, 360),
        scale: randRange(rng, SCALE_MIN, SCALE_MAX),
        x,
        z,
      });
      this.broadcast({ type: "propAdded", prop, creatorId: id });
    }
  }

  // ---------- phase engine ----------

  private onPhaseDeadline(now: number): void {
    const m = this.match;
    if (!m) return;
    switch (m.phase) {
      case "CREATE":
        this.autoPregen();
        beginRounds(m, now);
        this.announceRoundPhase();
        break;
      case "COUNTDOWN": {
        toReveal(m, now);
        this.initDyn();
        const t = currentTarget(m);
        if (t) {
          this.broadcast({ type: "phase", name: "REVEAL", endsAt: m.phaseEndsAt, round: m.round, totalRounds: m.roundOrder.length });
          this.broadcast({
            type: "reveal",
            archetype: ARCHETYPES[t.archetype].id,
            params: { hue: t.hue, scale: t.scale },
            name: ARCHETYPES[t.archetype].name,
          });
        }
        break;
      }
      case "REVEAL":
        toSeek(m, now);
        this.broadcast({ type: "phase", name: "SEEK", endsAt: m.phaseEndsAt, round: m.round, totalRounds: m.roundOrder.length });
        break;
      case "SEEK":
        this.endRound(0, now); // timer ran out — unfound, creator's accrual doubles
        break;
      case "RESOLVE":
        if (advanceRound(m, now) === "end") {
          // fold this game into the room's running standings before the
          // match state is discarded — the lobby scoreboard shows these
          for (const [idStr, pts] of Object.entries(m.scores)) {
            const id = Number(idStr);
            const prev = this.totals[id];
            const tokenName = Object.values(this.resumeTokens).find((t) => t.id === id)?.name;
            this.totals[id] = {
              name: this.players.get(id)?.name ?? prev?.name ?? tokenName ?? `player ${id}`,
              pts: (prev?.pts ?? 0) + pts,
            };
          }
          this.persist();
          this.broadcast({ type: "matchEnd", scores: m.scores, totals: this.totals });
          this.match = null;
          this.dyn.clear();
          void this.state.storage.delete("match");
          this.broadcast({ type: "phase", name: "LOBBY", endsAt: 0 });
          this.broadcast({ type: "lobby", players: this.roster(), settings: this.settings, totals: this.totals });
          this.stopTick();
        } else {
          this.announceRoundPhase();
        }
        break;
      default:
        break;
    }
    this.persistMatch();
  }

  private announceRoundPhase(): void {
    const m = this.match;
    if (!m) return;
    this.broadcast({
      type: "phase",
      name: "COUNTDOWN",
      endsAt: m.phaseEndsAt,
      round: m.round,
      totalRounds: m.roundOrder.length,
    });
  }

  /** The current round's target propId, or -1 outside a round. */
  private targetId(): number {
    const t = this.match ? currentTarget(this.match) : null;
    return t ? t.propId : -1;
  }

  /** A prop's home position/creator: created objects from the match, decoys from worldgen. */
  private propHome(propId: number): { x: number; z: number; scale: number; creatorId: number } | null {
    const m = this.match;
    if (propId >= CREATED_PROP_ID_BASE) {
      const creatorId = propId - CREATED_PROP_ID_BASE;
      const obj = m?.objects[creatorId];
      return obj ? { x: obj.x, z: obj.z, scale: obj.scale, creatorId } : null;
    }
    const w = this.world();
    const prop = w.props[propId]?.propId === propId ? w.props[propId] : w.props.find((p) => p.propId === propId);
    return prop ? { x: prop.x, z: prop.z, scale: prop.scale, creatorId: 0 } : null;
  }

  /** Get or lazily create the runtime state for a prop, seeded at its home spot. */
  private ensureDyn(propId: number): DynProp | null {
    const existing = this.dyn.get(propId);
    if (existing) return existing;
    const home = this.propHome(propId);
    if (!home) return null;
    const d: DynProp = {
      propId,
      creatorId: home.creatorId,
      x: home.x,
      // created objects may be placed ON standable fixture tops
      y: groundHeightAt(this.world(), home.x, home.z, 99, 0.05) + PROP_REST_Y * home.scale,
      z: home.z,
      vx: 0,
      vy: 0,
      vz: 0,
      airborne: false,
      heldBy: 0,
      thrownBy: 0,
      lockUntil: 0,
      lockedFor: 0,
      moved: false,
      wrongHit: false,
    };
    this.dyn.set(propId, d);
    return d;
  }

  /** Round start: the target must be free — force-drop it if someone was hauling it around as a decoy. */
  private initDyn(): void {
    const target = this.targetId();
    if (target < 0) return;
    const d = this.ensureDyn(target);
    if (!d) return;
    d.wrongHit = false;
    if (d.heldBy !== 0) {
      const holder = this.players.get(d.heldBy);
      if (holder) holder.carry = -1;
      d.heldBy = 0;
      d.y = PROP_REST_Y;
      d.moved = true;
      this.broadcast({ type: "dropped", propId: d.propId, x: q2(d.x), z: q2(d.z), lockUntil: 0, lockedFor: 0 });
    }
  }

  private endRound(deliverer: number, now: number): void {
    const m = this.match;
    if (!m || m.phase !== "SEEK") return;
    const result = resolveRound(m, now, deliverer);
    // round over: EVERY hand empties — each held prop drops in place with a
    // broadcast, so no client can end the round out of sync on carry state
    const w = this.world();
    for (const p of this.players.values()) {
      if (p.carry < 0) continue;
      const d = this.dyn.get(p.carry);
      p.carry = -1;
      if (!d) continue;
      d.heldBy = 0;
      d.airborne = false;
      d.x = p.x;
      d.z = p.z;
      d.y = groundHeightAt(w, p.x, p.z, Math.max(p.y, 0), 0.05) + PROP_REST_Y;
      d.moved = true;
      this.broadcast({ type: "dropped", propId: d.propId, x: q2(d.x), z: q2(d.z), lockUntil: 0, lockedFor: 0 });
    }
    if (result.found) {
      this.broadcast({ type: "delivered", byId: deliverer, propId: createdPropId(result.creatorId), points: result.delivererPoints });
    }
    this.broadcast({
      type: "roundEnd",
      found: result.found,
      creatorId: result.creatorId,
      creatorPoints: result.creatorPoints,
      ...(result.found ? { deliverer } : {}),
      scores: m.scores,
    });
    this.broadcast({ type: "phase", name: "RESOLVE", endsAt: m.phaseEndsAt, round: m.round, totalRounds: m.roundOrder.length });
    this.persistMatch();
    void this.scheduleAlarm();
  }

  // ---------- seek actions ----------

  private onGrab(p: PlayerState, propId: number): void {
    if (this.phase() !== "SEEK" || !this.isParticipant(p.id)) {
      this.sayTo(p.id, { type: "err", code: "bad_phase" });
      return;
    }
    // ANY catalog prop can be picked up (chaos rule); only the target scores
    const d = this.ensureDyn(propId);
    if (!d) {
      this.sayTo(p.id, { type: "err", code: "wrong" });
      return;
    }
    const err = canGrab(p, this.ruleTarget(d), Date.now());
    if (err) {
      this.sayTo(p.id, { type: "err", code: err });
      return;
    }
    d.heldBy = p.id;
    d.airborne = false;
    d.moved = true;
    p.carry = d.propId;
    this.broadcast({ type: "grabbed", playerId: p.id, propId: d.propId });
  }

  private onDrop(p: PlayerState): void {
    const d = p.carry >= 0 ? this.dyn.get(p.carry) : undefined;
    if (!d || d.heldBy !== p.id) return;
    d.heldBy = 0;
    d.x = p.x;
    d.z = p.z;
    d.y = groundHeightAt(this.world(), p.x, p.z, Math.max(p.y, 0), 0.05) + PROP_REST_Y;
    d.moved = true;
    p.carry = -1;
    this.broadcast({ type: "dropped", propId: d.propId, x: q2(d.x), z: q2(d.z), lockUntil: 0, lockedFor: 0 });
  }

  private onThrow(p: PlayerState, dirX: number, dirZ: number, power: number): void {
    const d = p.carry >= 0 ? this.dyn.get(p.carry) : undefined;
    const now = Date.now();
    if (!d || d.heldBy !== p.id) return;
    if (now < p.stunnedUntil) {
      this.sayTo(p.id, { type: "err", code: "stunned" });
      return;
    }
    if (!Number.isFinite(dirX) || !Number.isFinite(dirZ) || (dirX === 0 && dirZ === 0)) {
      this.sayTo(p.id, { type: "err", code: "bad_input" });
      return;
    }
    const v = throwVelocity(dirX, dirZ, power);
    const len = Math.hypot(dirX, dirZ);
    d.heldBy = 0;
    d.airborne = true;
    d.moved = true;
    d.wrongHit = false; // a fresh flight may bonk the NPC once more
    d.thrownBy = p.id;
    d.x = p.x + (dirX / len) * 0.6;
    d.y = CARRY_HEIGHT;
    d.z = p.z + (dirZ / len) * 0.6;
    d.vx = v.vx;
    d.vy = v.vy;
    d.vz = v.vz;
    p.carry = -1;
    this.broadcast({
      type: "thrown",
      propId: d.propId,
      byId: p.id,
      x: q2(d.x),
      y: q2(d.y),
      z: q2(d.z),
      vx: q2(d.vx),
      vy: q2(d.vy),
      vz: q2(d.vz),
    });
  }

  private onStun(p: PlayerState): void {
    const now = Date.now();
    if (this.phase() !== "SEEK" || !this.isParticipant(p.id)) {
      this.sayTo(p.id, { type: "err", code: "bad_phase" });
      return;
    }
    const err = canStun(p, now);
    if (err) {
      this.sayTo(p.id, { type: "err", code: err });
      return;
    }
    const victimId = nearestStunVictim(this.players.values(), p, now);
    if (!victimId) {
      this.sayTo(p.id, { type: "err", code: "far" });
      return;
    }
    const victim = this.players.get(victimId)!;
    victim.stunnedUntil = now + STUN_DURATION_MS;
    p.stunCdUntil = now + STUN_COOLDOWN_MS;
    this.broadcast({ type: "stunned", victimId, byId: p.id, until: victim.stunnedUntil });
    const d = victim.carry >= 0 ? this.dyn.get(victim.carry) : undefined;
    if (d && d.heldBy === victimId) {
      d.heldBy = 0;
      d.x = victim.x;
      d.z = victim.z;
      d.y = groundHeightAt(this.world(), victim.x, victim.z, Math.max(victim.y, 0), 0.05) + PROP_REST_Y;
      d.moved = true;
      d.lockUntil = now + DROP_LOCK_MS;
      d.lockedFor = victimId;
      victim.carry = -1;
      this.broadcast({
        type: "dropped",
        propId: d.propId,
        x: q2(d.x),
        z: q2(d.z),
        lockUntil: d.lockUntil,
        lockedFor: victimId,
      });
    }
  }

  private onPos(p: PlayerState, x: number, z: number, yaw: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;
    p.y = Number.isFinite(y) ? Math.min(4, Math.max(0, y)) : 0;
    const now = Date.now();
    if (now < p.stunnedUntil) return; // frozen — stuns are real, not cosmetic
    let nx = clampToMap(x);
    let nz = clampToMap(z);
    if (p.lastPosMs > 0) {
      const dtSec = Math.min(1, (now - p.lastPosMs) / 1000);
      const speedCap = p.carry !== -1 ? CARRY_SPEED : PLAYER_SPEED;
      const maxD = speedCap * dtSec * SPEED_CLAMP_SLACK + 0.01;
      const dx = nx - p.x;
      const dz = nz - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > maxD) {
        nx = p.x + (dx / dist) * maxD;
        nz = p.z + (dz / dist) * maxD;
      }
    }
    p.x = nx;
    p.z = nz;
    p.yaw = yaw;
    p.lastPosMs = now;
  }

  // ---------- tick ----------

  private tick(): void {
    if (this.sockets.size === 0) return;
    const m = this.match;
    const now = Date.now();

    const target = this.targetId();
    if (m && m.phase === "SEEK") {
      const w = this.world();
      for (const d of this.dyn.values()) {
        // thrown-prop flight, shared ballistics
        if (d.airborne) {
          const b: Ballistic = { x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, resting: false };
          stepBallistic(b, TICK_MS / 1000, w);
          d.x = b.x;
          d.y = b.y;
          d.z = b.z;
          d.vx = b.vx;
          d.vy = b.vy;
          d.vz = b.vz;
          if (b.resting) d.airborne = false;
        }
        // NPC contact
        if (d.propId === target) {
          if (d.heldBy !== 0) {
            const carrier = this.players.get(d.heldBy);
            if (carrier && carriedDelivery(carrier, w.npc.x, w.npc.z)) {
              this.endRound(carrier.id, now);
              break; // round is over; snapshot below reflects the new phase
            }
          } else if (d.airborne && airborneDelivery(d.x, d.y, d.z, w.npc.x, w.npc.z)) {
            this.endRound(d.thrownBy, now);
            break;
          }
        } else if (d.airborne && !d.wrongHit && airborneDelivery(d.x, d.y, d.z, w.npc.x, w.npc.z)) {
          // a decoy bonked the NPC — tell the thrower it's the wrong one
          d.wrongHit = true;
          this.sayTo(d.thrownBy, { type: "err", code: "wrong" });
        }
      }
      // hide-in-plain-sight accrual (target may still be untouched at home)
      if (this.match && this.match.phase === "SEEK" && target >= 0) {
        const td = this.ensureDyn(target);
        if (td && losActive(this.ruleTarget(td), this.players.values())) {
          accrue(m, TICK_MS);
        }
      }
    }

    const players: SnapshotPlayer[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        x: q2(p.x),
        y: q2(p.y),
        z: q2(p.z),
        yaw: q2(p.yaw),
        carry: p.carry,
        stun: now < p.stunnedUntil ? 1 : 0,
      });
    }
    const loose: SnapshotLoose[] = [];
    for (const d of this.dyn.values()) {
      if (d.heldBy === 0 && (d.moved || d.airborne)) {
        loose.push({ propId: d.propId, x: q2(d.x), y: q2(d.y), z: q2(d.z) });
      }
    }
    this.broadcast({ type: "snapshot", t: now, players, loose, scores: this.match?.scores ?? {} });
  }

  // ---------- helpers ----------

  private ruleTarget(d: DynProp): RuleTarget {
    return {
      propId: d.propId,
      // the can't-grab-your-own rule only applies to the round's target —
      // hauling your own creation around as a decoy is fair chaos
      creatorId: d.propId === this.targetId() ? d.creatorId : 0,
      x: d.x,
      z: d.z,
      heldBy: d.heldBy,
      airborne: d.airborne,
      lockUntil: d.lockUntil,
      lockedFor: d.lockedFor,
    };
  }

  /** Mid-match joiners spectate: they can roam but not act. */
  private isParticipant(id: number): boolean {
    return !this.match || id in this.match.scores;
  }

  private async scheduleAlarm(): Promise<void> {
    const candidates = [this.ttlAt];
    if (this.match && this.match.phaseEndsAt > 0) candidates.push(this.match.phaseEndsAt);
    const next = Math.min(...candidates.filter((t) => t > 0));
    if (Number.isFinite(next)) await this.state.storage.setAlarm(next);
  }

  private ensureTick(): void {
    if (this.tickHandle !== null) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS) as unknown as number;
  }

  private stopTick(): void {
    if (this.tickHandle === null) return;
    clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  private freshPlayer(id: number, name: string): PlayerState {
    const spawn = this.world().spawnPoints[(id - 1) % MAX_PLAYERS];
    return {
      id,
      name,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: 0,
      carry: -1,
      stunnedUntil: 0,
      stunCdUntil: 0,
      lastPosMs: 0,
    };
  }

  private roster(): PlayerInfo[] {
    return [...this.players.values()].map((p) => this.info(p));
  }

  private info(p: PlayerState): PlayerInfo {
    return { id: p.id, name: p.name, isHost: p.id === this.hostId };
  }

  private persist(): void {
    const data: Persisted = {
      seed: this.seed,
      nextId: this.nextId,
      hostId: this.hostId,
      settings: this.settings,
      ttlAt: this.ttlAt,
      totals: this.totals,
      resumeTokens: this.resumeTokens,
    };
    void this.state.storage.put("room", data);
  }

  private persistMatch(): void {
    if (this.match) void this.state.storage.put("match", this.match);
  }

  private broadcast(msg: S2C, exceptId?: number): void {
    const text = encode(msg);
    for (const [id, ws] of this.sockets) {
      if (id === exceptId) continue;
      try {
        ws.send(text);
      } catch {
        /* dead socket; close handler cleans up */
      }
    }
  }

  private sayTo(id: number, msg: S2C): void {
    const ws = this.sockets.get(id);
    if (ws) this.say(ws, msg);
  }

  private say(ws: WebSocket, msg: S2C): void {
    try {
      ws.send(encode(msg));
    } catch {
      /* dead socket */
    }
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}
