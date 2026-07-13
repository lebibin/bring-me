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
  QUICK_AUTOSTART_MS,
  QUICK_BOT_JOIN_MAX_MS,
  QUICK_BOT_JOIN_MIN_MS,
  QUICK_BOT_LEAVE_MAX_MS,
  QUICK_BOT_LEAVE_MIN_MS,
  QUICK_CREATE_SECS,
  QUICK_ROUND_SECS,
  QUICK_TARGET_PLAYERS,
  REGISTRY_REFRESH_MS,
  RESUME_TOKENS_MAX,
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
  clampStage,
  clampToMap,
  decodeC2S,
  encode,
  generateWorld,
  groundHeightAt,
  mulberry32,
  placementValid,
  q2,
  randInt,
  randRange,
  randomName,
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
  advanceRound,
  beginRounds,
  createdPropId,
  currentCreator,
  currentTarget,
  newMatch,
  placeObject,
  resolveRound,
  toReveal,
  toSeek,
  type MatchState,
} from "./match.ts";
import {
  FlowField,
  newBot,
  stepBot,
  type ActorView,
  type BotAction,
  type BotContext,
  type BotSelf,
  type BotState,
  type TargetView,
} from "./bots.ts";
import {
  airborneDelivery,
  canGrab,
  canStun,
  carriedDelivery,
  nearestStunVictim,
  type RulePlayer,
  type RuleTarget,
} from "./rules.ts";
import { newBucket, takeToken, type Bucket } from "./bucket.ts";
import { logError, logInfo, logWarn } from "./log.ts";
import type { Env } from "./env.ts";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const HELLO_TIMEOUT_MS = 10_000;
const HALF = MAP_SIZE / 2;
// Party-game pragmatism: 2 players is a valid (if degenerate) match; the
// plan's ≥3 rule matters for fun, not correctness, and 2 keeps testing easy.
const MIN_START_PLAYERS = 2;

interface Attachment {
  playerId: number;
  name: string;
}

/** Pre-hello marker set at accept; replaced by the real Attachment on join. */
interface PendingAttachment {
  pendingSince: number;
}

interface PlayerState extends RulePlayer {
  name: string;
  /** blob body color (0-359); defaults to a per-id hash until the player picks */
  hue: number;
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
  /** listed on the public lobby browser; decided by the creator's first hello */
  isPublic?: boolean;
  /** quick game: public + bot-filled + auto-start; decided by the creator's first hello */
  quick?: boolean;
  /** bot seats to re-instate on a wake (AI memory is volatile and re-inits) */
  botSeats?: { id: number; name: string; hue: number }[];
  /** own room code, learned from the Worker's X-Room-Code (not derivable from the DO id) */
  code?: string;
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
    stage: 0,
  };
  private totals: RoomTotals = {};
  private resumeTokens: Record<string, { id: number; name: string }> = {};
  private match: MatchState | null = null;
  /** propId -> runtime state for every prop that has been grabbed/moved */
  private readonly dyn = new Map<number, DynProp>();
  private tickHandle: number | null = null;
  private worldCache: World | null = null;
  private isPublic = false;
  /** quick game — public room topped up with bots that yield to real players */
  private quick = false;
  /** virtual players with no socket; their AI runs in tick(). Keyed by playerId. */
  private readonly bots = new Map<number, BotState>();
  /** next staggered bot join / bot eviction / lobby self-start (epoch ms; 0 = unset) */
  private botJoinAt = 0;
  private botLeaveAt = 0;
  private autoStartAt = 0;
  /** bot pathfinding fields, cached per world / per round (volatile) */
  private botNpcField: FlowField | null = null;
  private botFieldWorld: World | null = null;
  private botTargetField: FlowField | null = null;
  private botTargetFieldFor = -1;
  private botTargetGoal = { x: 0, z: 0 };
  private code = "";
  /** which Cloudflare colo this DO landed in — diagnostics only; volatile */
  private colo = "";
  private coloLearn: Promise<void> | null = null;
  /** last row pushed to the registry — skip no-op upserts (phase churn) */
  private lastPublished: { hostName: string; players: number; status: string } | null = null;
  /** next heartbeat republish (keeps lastSeen fresh while idle in a lobby); volatile */
  private registryRefreshAt = 0;
  /** per-socket inbound rate limiting; volatile (buckets refill anyway) */
  private readonly buckets = new Map<WebSocket, Bucket>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
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
        this.settings = { ...stored.settings, stage: clampStage(stored.settings.stage) };
        this.ttlAt = stored.ttlAt;
        this.totals = stored.totals ?? {};
        this.resumeTokens = stored.resumeTokens ?? {};
        this.isPublic = stored.isPublic ?? false;
        this.quick = stored.quick ?? false;
        this.code = stored.code ?? "";
        // re-seat persisted bots with fresh AI memory (it's volatile; a mid-round
        // wake just makes each bot re-plan, same recovery class as dyn-prop reset)
        for (const seat of stored.botSeats ?? []) {
          this.bots.set(seat.id, newBot((Math.random() * 0xffffffff) >>> 0));
          const ps = this.freshPlayer(seat.id, seat.name);
          ps.hue = seat.hue;
          this.players.set(seat.id, ps);
        }
      }
      this.match = (await this.state.storage.get<MatchState>("match")) ?? null;
      for (const ws of this.state.getWebSockets()) {
        const att = this.joined(ws);
        if (!att) continue; // pre-hello socket — the persisted alarm sweeps it
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
      // registryRefreshAt is volatile: any wake of an occupied public room
      // re-registers (self-healing) and re-arms the heartbeat chain
      if (this.isPublic && this.sockets.size > 0) this.publishRegistry(true);
      // quick room: rebalance the bot table for the survivors (removes all bots
      // if no human made it through the wake)
      if (this.quick) this.reconcileBots(Date.now());
      // wake with restored state = a hibernation/eviction cycle happened —
      // the trail for "the round reset under us" reports (dyn is volatile)
      if (stored) {
        logInfo("room_wake", { room: this.code, phase: this.phase(), sockets: this.sockets.size });
      }
    });
  }

  private phase(): PhaseName {
    return this.match?.phase ?? "LOBBY";
  }

  /** The joined-player attachment, or null while the socket is still pre-hello. */
  private joined(ws: WebSocket): Attachment | null {
    const att = ws.deserializeAttachment() as Attachment | PendingAttachment | null;
    return att && "playerId" in att ? att : null;
  }

  private world(): World {
    if (!this.worldCache || this.worldCache.seed !== this.seed || this.worldCache.stage !== this.settings.stage) {
      this.worldCache = generateWorld(this.seed, this.settings.stage);
    }
    return this.worldCache;
  }

  /**
   * Learn (once per wake) which colo this DO runs in, so the client can show
   * "room server: XXX" — turns every far-room latency report into a
   * one-glance diagnosis. The trace subrequest egresses from the DO itself,
   * so its colo IS the DO's location. Fire-and-forget: by the time the first
   * `hello` arrives (a client RTT after the upgrade) it has long resolved.
   */
  private learnColo(): void {
    if (this.colo !== "" || this.coloLearn) return;
    this.coloLearn = fetch("https://cloudflare.com/cdn-cgi/trace")
      .then((res) => res.text())
      .then((text) => {
        this.colo = /^colo=([A-Z]+)$/m.exec(text)?.[1] ?? "";
      })
      .catch(() => {
        this.coloLearn = null; // diagnostics only — retry on the next fetch
      });
  }

  async fetch(request: Request): Promise<Response> {
    this.learnColo();
    // browse-screen latency probe — answered without arming the TTL so
    // probes never resurrect or extend a room
    if (new URL(request.url).pathname.endsWith("/ping")) {
      return new Response(null, {
        status: 204,
        headers: this.colo ? { "X-Room-Colo": this.colo } : undefined,
      });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // Accepted-socket cap: joins are bounded by MAX_PLAYERS, but a socket
    // that never says hello holds no player slot — without this, idlers
    // (distributed past the per-IP limit) accumulate unbounded.
    if (this.state.getWebSockets().length >= MAX_PLAYERS * 2) {
      return new Response("room busy", { status: 503 });
    }
    // the Worker overwrites X-Room-Code on every upgrade forward, so a
    // client can't forge it; the code isn't derivable from our own DO id
    const code = request.headers.get("X-Room-Code") ?? "";
    if (this.code === "" && /^[A-Z0-9]{1,12}$/.test(code)) this.code = code;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    // Stamp the accept time so the alarm chain can evict sockets that never
    // complete the hello handshake (a setTimeout would die with this request
    // context AND with hibernation; attachments + alarms survive both).
    server.serializeAttachment({ pendingSince: Date.now() } satisfies PendingAttachment);
    if (this.ttlAt === 0) {
      this.ttlAt = Date.now() + ROOM_TTL_MS;
      this.persist();
    }
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 4096) return;
    const now = Date.now();
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = newBucket(now);
      this.buckets.set(ws, bucket);
    }
    const verdict = takeToken(bucket, now);
    if (verdict !== "ok") {
      if (verdict === "close") {
        logWarn("ws_rate_limited", { room: this.code, playerId: this.joined(ws)?.playerId });
        ws.close(1008, "rate limit");
      }
      return;
    }
    const msg = decodeC2S(raw);
    if (!msg) return;
    // normally answered by the auto-response pair without reaching us
    if (msg.type === "ping") {
      this.say(ws, { type: "pong" });
      return;
    }
    const att = this.joined(ws);
    if (!att) {
      if (msg.type === "hello") {
        // the welcome is colo's only ride — give the (edge-local, ~ms) trace
        // one capped beat to resolve; a fast hello must never miss it
        this.learnColo();
        if (this.colo === "" && this.coloLearn) {
          await Promise.race([this.coloLearn, new Promise((r) => setTimeout(r, 250))]);
        }
        this.onHello(ws, msg);
      } else this.say(ws, { type: "err", code: "bad_input" });
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
        // decodeC2S only checks `type` — a params-less frame must not throw
        if (typeof msg.params !== "object" || msg.params === null) {
          this.say(ws, { type: "err", code: "bad_input" });
          break;
        }
        this.onPick(p, msg.archetype, msg.params.hue, msg.params.scale);
        break;
      case "placeObject":
        this.onPlace(p, msg.x, msg.z);
        break;
      case "setHue": {
        if (typeof msg.hue !== "number" || !Number.isFinite(msg.hue)) {
          this.say(ws, { type: "err", code: "bad_input" });
          break;
        }
        p.hue = ((Math.round(msg.hue) % 360) + 360) % 360;
        this.broadcast({ type: "hueChanged", playerId: p.id, hue: p.hue });
        break;
      }
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
      logInfo("room_expired", { room: this.code, sockets: this.sockets.size });
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
      this.deregisterRegistry();
      await this.state.storage.deleteAll();
      return;
    }
    const m = this.match;
    if (m && m.phaseEndsAt > 0 && now >= m.phaseEndsAt - 50) {
      this.onPhaseDeadline(now);
    }
    // heartbeat: keep the registry's lastSeen fresh while players idle in a
    // lobby (no membership/status events for minutes on end)
    if (this.registryRefreshAt > 0 && now >= this.registryRefreshAt - 50) {
      this.publishRegistry(true);
    }
    // quick-game bot lifecycle — all lobby-phase, so it must ride the alarm
    // (an idle LOBBY has no tick to hang it on)
    if (this.botJoinAt > 0 && now >= this.botJoinAt - 50) {
      this.botJoinAt = 0;
      if (this.quick && this.phase() === "LOBBY" && this.sockets.size > 0 && this.players.size < QUICK_TARGET_PLAYERS) {
        this.addBot();
      }
      this.reconcileBots(now); // arm the next staggered join if still short
    }
    if (this.botLeaveAt > 0 && now >= this.botLeaveAt - 50) {
      this.botLeaveAt = 0;
      if (this.quick && this.phase() === "LOBBY" && this.players.size > QUICK_TARGET_PLAYERS && this.bots.size > 0) {
        const victim = this.bots.keys().next();
        if (!victim.done) this.removePlayer(victim.value, true);
      }
      this.reconcileBots(now); // keep evicting until the table fits
    }
    if (this.autoStartAt > 0 && now >= this.autoStartAt - 50) {
      this.autoStartAt = 0;
      if (this.quick && this.phase() === "LOBBY" && this.players.size >= MIN_START_PLAYERS) {
        this.beginQuickMatch(now);
      }
    }
    // evict sockets that never completed the hello handshake
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const att = ws.deserializeAttachment() as Attachment | PendingAttachment | null;
      if (att && "pendingSince" in att && now >= att.pendingSince + HELLO_TIMEOUT_MS - 50) {
        try {
          ws.close(1008, "no hello");
        } catch {
          /* already dead */
        }
      }
    }
    await this.scheduleAlarm();
  }

  // ---------- join / leave ----------

  private onHello(ws: WebSocket, msg: Extract<C2S, { type: "hello" }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      // spikes here after a deploy = players on a stale cached client
      logWarn("join_rejected", { room: this.code, reason: "version", clientV: msg.v });
      this.say(ws, { type: "err", code: "version" });
      ws.close(1008, "protocol version mismatch");
      return;
    }
    // A valid resume token reclaims the caller's old seat — same playerId,
    // same scores, still a match participant. Everything else joins fresh.
    // Own-key check: "__proto__"/"constructor" must never resolve through the
    // prototype chain into a truthy bogus seat.
    const resumed =
      msg.resume && Object.prototype.hasOwnProperty.call(this.resumeTokens, msg.resume)
        ? this.resumeTokens[msg.resume]
        : undefined;
    if (!resumed && this.players.size >= MAX_PLAYERS) {
      logWarn("join_rejected", { room: this.code, reason: "full" });
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
      // a brand-new room's creator decides its visibility, once. quick games
      // are always public (they must be joinable off the browser) and add bots.
      if (this.hostId === 0 && this.nextId === 1) {
        this.quick = msg.quick === true;
        this.isPublic = msg.pub === true || this.quick;
      }
      name = String(msg.name).trim().slice(0, 16) || "slop";
      id = this.nextId++;
      token = crypto.randomUUID();
      this.resumeTokens[token] = { id, name };
      // FIFO cap (Records keep insertion order) — a token from 64 joins ago
      // rejoining as a fresh player beats unbounded storage growth
      const keys = Object.keys(this.resumeTokens);
      for (let i = 0; i < keys.length - RESUME_TOKENS_MAX; i++) {
        delete this.resumeTokens[keys[i]];
      }
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
      isPublic: this.isPublic,
      ...(this.colo ? { colo: this.colo } : {}),
    });
    // Late joiners still need every placed object to render the world.
    if (this.match) {
      for (const [creatorId, prop] of Object.entries(this.match.objects)) {
        this.say(ws, { type: "propAdded", prop, creatorId: Number(creatorId) });
      }
      // ...and every displaced resting prop (snapshots carry airborne only);
      // held props reattach via the carrier's snapshot carry field
      for (const d of this.dyn.values()) {
        if (d.heldBy === 0 && !d.airborne && d.moved) {
          this.say(ws, { type: "rested", propId: d.propId, x: q2(d.x), y: q2(d.y), z: q2(d.z) });
        }
      }
      if (this.match.phaseEndsAt > 0) {
        this.say(ws, { type: "phase", name: this.phase(), endsAt: this.match.phaseEndsAt });
      }
    }
    this.broadcast({ type: "playerJoined", player: this.info(this.players.get(id)!) }, id);
    this.broadcastLobby();
    if (this.phase() !== "LOBBY") this.ensureTick();
    this.publishRegistry();
    // quick room: a real player just arrived — top up or start yielding seats
    if (this.quick && !resumed) this.reconcileBots(Date.now());
    logInfo("player_joined", {
      room: this.code,
      playerId: id,
      players: this.players.size,
      resumed: Boolean(resumed),
      phase: this.phase(),
      colo: this.colo,
    });
  }

  private dropSocket(ws: WebSocket): void {
    this.buckets.delete(ws);
    const att = this.joined(ws);
    if (!att) return;
    if (this.sockets.get(att.playerId) !== ws) return;
    this.removePlayer(att.playerId, false);
    // a human came or went — quick rooms may need to drop all bots (last human
    // left) or rebalance the table on the next return to the lobby
    if (this.quick) this.reconcileBots(Date.now());
  }

  /**
   * Remove one player (human leaver or evicted bot) by id: drop what they held,
   * clear their seat, migrate the host to a real player, and tear down an empty
   * room. Shared by the socket-close path and quick-game bot eviction.
   */
  private removePlayer(id: number, isBot: boolean): void {
    const p = this.players.get(id);
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
    this.sockets.delete(id);
    this.players.delete(id);
    this.picks.delete(id);
    if (isBot) this.bots.delete(id);
    if (this.hostId === id) {
      // migrate to the next HUMAN — a bot can't press start, and never a host
      let next = 0;
      for (const cand of this.players.keys()) {
        if (this.sockets.has(cand)) {
          next = cand;
          break;
        }
      }
      this.hostId = next;
      this.persist();
    }
    this.broadcast({ type: "playerLeft", playerId: id });
    this.broadcastLobby();
    if (this.sockets.size === 0) {
      this.stopTick();
      this.deregisterRegistry(); // empty rooms don't belong on the browser
    } else {
      this.publishRegistry();
    }
    logInfo("player_left", {
      room: this.code,
      playerId: id,
      bot: isBot,
      players: this.players.size,
      phase: this.phase(),
    });
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
      stage: clampStage(raw?.stage),
    };
    const now = Date.now();
    this.launchMatch(now);
    await this.scheduleAlarm();
    logInfo("match_started", { room: this.code, players: this.players.size, settings: this.settings });
  }

  /** Quick-game lobby self-start: begin a match with the snappy quick presets. */
  private beginQuickMatch(now: number): void {
    if (this.phase() !== "LOBBY" || this.players.size < MIN_START_PLAYERS) return;
    this.settings = { createSecs: QUICK_CREATE_SECS, roundSecs: QUICK_ROUND_SECS, stage: clampStage(this.settings.stage) };
    this.launchMatch(now);
    void this.scheduleAlarm();
    logInfo("quick_match_started", { room: this.code, players: this.players.size });
  }

  /**
   * Common match-launch body (host start and quick auto-start): snapshot the
   * roster into a fresh match, reset carries/picks, stand down any pending bot
   * lifecycle timers, and broadcast CREATE. `this.settings` must already be set.
   */
  private launchMatch(now: number): void {
    this.match = newMatch(this.seed, this.settings, [...this.players.keys()], now);
    this.dyn.clear();
    for (const pl of this.players.values()) pl.carry = -1;
    this.picks.clear();
    // roster is frozen for the match — stand the bot lifecycle timers down
    this.autoStartAt = 0;
    this.botJoinAt = 0;
    this.botLeaveAt = 0;
    // fresh AI memory so bots re-plan CREATE hiding for the new match
    for (const id of this.bots.keys()) this.bots.set(id, newBot((Math.random() * 0xffffffff) >>> 0));
    this.persist();
    this.persistMatch();
    // settings first: clients must learn the (possibly new) stage and rebuild
    // the world BEFORE the CREATE phase drops them into it
    this.broadcastLobby();
    this.broadcast({ type: "phase", name: "CREATE", endsAt: this.match.phaseEndsAt });
    this.ensureTick();
    this.publishRegistry(); // lobby -> match on the browse screen
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
          logInfo("match_end", { room: this.code, rounds: m.roundOrder.length, scores: m.scores });
          this.match = null;
          this.dyn.clear();
          void this.state.storage.delete("match");
          this.broadcast({ type: "phase", name: "LOBBY", endsAt: 0 });
          this.broadcastLobby();
          this.stopTick();
        } else {
          this.announceRoundPhase();
        }
        break;
      default:
        break;
    }
    this.persistMatch();
    // no-op except on the match-end -> LOBBY transition (skip-if-unchanged)
    this.publishRegistry();
    // one line per transition (a handful per match) — reconstructs the match
    // timeline when a "the game got stuck" report comes in
    logInfo("phase_change", { room: this.code, phase: this.phase(), round: this.match?.round });
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
    logInfo("round_end", {
      room: this.code,
      round: m.round,
      found: result.found,
      ...(result.found ? { deliverer } : {}),
    });
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
    if (!Number.isFinite(dirX) || !Number.isFinite(dirZ) || !Number.isFinite(power) || (dirX === 0 && dirZ === 0)) {
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

    // bots think first so their moves/actions this tick feed the delivery
    // checks and the snapshot built below
    if (this.bots.size > 0 && m) this.stepBots(now);

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
          if (b.resting) {
            d.airborne = false;
            // landing correction: snapshots stream only airborne props, so
            // this is the one message that pins the exact final position
            this.broadcast({ type: "rested", propId: d.propId, x: q2(d.x), y: q2(d.y), z: q2(d.z) });
          }
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
      // airborne only: resting positions ride the dropped/rested broadcasts
      // (and the join-time replay), not every 15 Hz frame forever
      if (d.heldBy === 0 && d.airborne) {
        loose.push({ propId: d.propId, x: q2(d.x), y: q2(d.y), z: q2(d.z) });
      }
    }
    this.broadcast({ type: "snapshot", t: now, players, loose, scores: this.match?.scores ?? {} });
  }

  // ---------- quick-game bots ----------

  /**
   * Keep the quick-room table at QUICK_TARGET_PLAYERS: fill with staggered bot
   * joins, evict bots one at a time as real players overflow the table, and
   * drop every bot the moment the last human leaves. All fill/evict happens in
   * the lobby (roster is frozen mid-match); each transition is armed as an
   * alarm so an idle, tickless lobby still advances.
   */
  private reconcileBots(now: number): void {
    if (!this.quick) return;
    const humans = this.sockets.size;
    // no humans → drop every bot; a bot crew must never keep a room alive/listed
    if (humans === 0) {
      for (const id of [...this.bots.keys()]) this.removePlayer(id, true);
      this.botJoinAt = 0;
      this.botLeaveAt = 0;
      this.autoStartAt = 0;
      return;
    }
    // mid-match: roster frozen — rebalance when we return to the lobby
    if (this.phase() !== "LOBBY") {
      this.botJoinAt = 0;
      this.botLeaveAt = 0;
      return;
    }
    const total = this.players.size;
    if (total < QUICK_TARGET_PLAYERS) {
      if (this.botJoinAt === 0) this.botJoinAt = now + randInt(Math.random, QUICK_BOT_JOIN_MIN_MS, QUICK_BOT_JOIN_MAX_MS);
    } else {
      this.botJoinAt = 0;
    }
    if (total > QUICK_TARGET_PLAYERS && this.bots.size > 0) {
      if (this.botLeaveAt === 0) this.botLeaveAt = now + randInt(Math.random, QUICK_BOT_LEAVE_MIN_MS, QUICK_BOT_LEAVE_MAX_MS);
    } else {
      this.botLeaveAt = 0;
    }
    // Lobby self-start countdown. Hold it while the table is still filling (no
    // countdown shown yet), then arm a fresh, clean window once the table is
    // full (or can't fill further) — so it always begins at exactly the full
    // QUICK_AUTOSTART_MS, never a leftover partial value.
    const prevStart = this.autoStartAt;
    const stillFilling = this.players.size < QUICK_TARGET_PLAYERS && this.botJoinAt > 0;
    if (this.players.size >= MIN_START_PLAYERS && !stillFilling) {
      if (this.autoStartAt === 0) this.autoStartAt = now + QUICK_AUTOSTART_MS;
    } else {
      this.autoStartAt = 0;
    }
    if (this.autoStartAt !== prevStart) this.broadcastLobby();
    void this.scheduleAlarm();
  }

  /** Add one bot: a socket-less player with a human name and fresh AI memory. */
  private addBot(): void {
    const taken = new Set<string>();
    for (const pl of this.players.values()) taken.add(pl.name.toLowerCase());
    const name = randomName(Math.random, taken);
    const id = this.nextId++;
    this.bots.set(id, newBot((Math.random() * 0xffffffff) >>> 0));
    this.players.set(id, this.freshPlayer(id, name));
    this.persist();
    this.broadcast({ type: "playerJoined", player: this.info(this.players.get(id)!) });
    this.broadcastLobby();
    this.publishRegistry();
    logInfo("bot_joined", { room: this.code, botId: id, players: this.players.size });
  }

  /** Drive every bot one tick: move it, then dispatch at most one action. */
  private stepBots(now: number): void {
    const world = this.world();
    if (this.botFieldWorld !== world) {
      this.botFieldWorld = world;
      this.botNpcField = new FlowField(world, world.npc.x, world.npc.z);
      this.botTargetField = null;
      this.botTargetFieldFor = -1;
    }
    const phase = this.phase();
    let target: TargetView | null = null;
    let targetField: FlowField | null = null;
    if (this.match && phase === "SEEK") {
      const tid = this.targetId();
      const d = tid >= 0 ? this.ensureDyn(tid) : null;
      if (d) {
        target = { propId: tid, creatorId: currentCreator(this.match), x: d.x, z: d.z, heldBy: d.heldBy, airborne: d.airborne };
        // (re)build the routing field when the target changes or drifts from its goal
        if (this.botTargetFieldFor !== tid || Math.hypot(this.botTargetGoal.x - d.x, this.botTargetGoal.z - d.z) > 2) {
          this.botTargetField = new FlowField(world, d.x, d.z);
          this.botTargetFieldFor = tid;
          this.botTargetGoal = { x: d.x, z: d.z };
        }
        targetField = this.botTargetField;
      }
    }
    const actors: ActorView[] = [];
    for (const p of this.players.values()) {
      actors.push({ id: p.id, x: p.x, z: p.z, carry: p.carry, stunnedUntil: p.stunnedUntil });
    }
    const ctx: BotContext = {
      world,
      phase,
      npc: world.npc,
      npcField: this.botNpcField!,
      target,
      targetField,
      actors,
      phaseEndsAt: this.match?.phaseEndsAt ?? 0,
      dt: TICK_MS / 1000,
    };
    for (const [id, bot] of this.bots) {
      const p = this.players.get(id);
      if (!p) {
        this.bots.delete(id);
        continue;
      }
      const self: BotSelf = { id: p.id, x: p.x, z: p.z, yaw: p.yaw, carry: p.carry, stunnedUntil: p.stunnedUntil, stunCdUntil: p.stunCdUntil };
      const step = stepBot(bot, self, ctx, now);
      if (step.move && now >= p.stunnedUntil) {
        p.x = step.move.x;
        p.z = step.move.z;
        p.yaw = step.move.yaw;
        p.y = 0;
        p.lastPosMs = now;
      }
      if (step.action) this.dispatchBotAction(p, step.action);
    }
  }

  /** Route a bot's decision through the same internal handlers a human hits. */
  private dispatchBotAction(p: PlayerState, a: BotAction): void {
    switch (a.kind) {
      case "pick":
        this.onPick(p, a.archetype, a.hue, a.scale);
        break;
      case "place":
        this.onPlace(p, a.x, a.z);
        break;
      case "grab":
        this.onGrab(p, a.propId);
        break;
      case "drop":
        this.onDrop(p);
        break;
      case "throw":
        this.onThrow(p, a.dirX, a.dirZ, a.power);
        break;
      case "stun":
        this.onStun(p);
        break;
    }
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
    if (this.registryRefreshAt > 0) candidates.push(this.registryRefreshAt);
    if (this.botJoinAt > 0) candidates.push(this.botJoinAt);
    if (this.botLeaveAt > 0) candidates.push(this.botLeaveAt);
    if (this.autoStartAt > 0) candidates.push(this.autoStartAt);
    for (const ws of this.state.getWebSockets()) {
      // a just-swept socket lingers in getWebSockets() until teardown —
      // skip non-open ones or its stale deadline re-fires the alarm
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const att = ws.deserializeAttachment() as Attachment | PendingAttachment | null;
      if (att && "pendingSince" in att) candidates.push(att.pendingSince + HELLO_TIMEOUT_MS);
    }
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
      hue: (id * 67) % 360, // same hash the client used before hues were pickable
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
    return { id: p.id, name: p.name, isHost: p.id === this.hostId, hue: p.hue };
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
      isPublic: this.isPublic,
      quick: this.quick,
      botSeats: [...this.bots.keys()].map((id) => {
        const p = this.players.get(id)!;
        return { id, name: p.name, hue: p.hue };
      }),
      code: this.code,
    };
    void this.state.storage.put("room", data);
  }

  // ---------- public-lobby registry ----------

  private registry(): { fetch: (url: string, init?: RequestInit) => Promise<Response> } {
    return this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby"));
  }

  /**
   * Push this room's row to the lobby registry. Fire-and-forget: the browse
   * list is best-effort and must never stall or fail game traffic. `force`
   * bypasses skip-if-unchanged for the heartbeat (its point is `lastSeen`).
   */
  private publishRegistry(force = false): void {
    if (!this.isPublic || this.code === "") return;
    // an abandoned room's alarm chain (phase deadlines, heartbeat) must never
    // re-list it — empty means deregistered, whatever the caller
    if (this.players.size === 0) {
      this.deregisterRegistry();
      return;
    }
    const row = {
      code: this.code,
      hostName: this.players.get(this.hostId)?.name ?? "",
      players: this.players.size,
      status: this.phase() === "LOBBY" ? "lobby" : "match",
    };
    const last = this.lastPublished;
    if (!force && last && last.hostName === row.hostName && last.players === row.players && last.status === row.status) {
      return;
    }
    this.lastPublished = { hostName: row.hostName, players: row.players, status: row.status };
    this.registryRefreshAt = this.players.size > 0 ? Date.now() + REGISTRY_REFRESH_MS : 0;
    void this.scheduleAlarm();
    // still fire-and-forget, but a failing registry is now visible instead of
    // silently leaving stale/missing rows on the browse screen
    void this.registry()
      .fetch("https://registry/upsert", { method: "POST", body: JSON.stringify(row) })
      .then((res) => {
        if (!res.ok) logWarn("registry_upsert_rejected", { room: this.code, status: res.status });
      })
      .catch((e: unknown) => logError("registry_upsert_failed", e, { room: this.code }));
  }

  private deregisterRegistry(): void {
    if (!this.isPublic || this.code === "") return;
    this.lastPublished = null;
    this.registryRefreshAt = 0;
    void this.registry()
      .fetch("https://registry/remove", { method: "POST", body: JSON.stringify({ code: this.code }) })
      .catch((e: unknown) => logError("registry_remove_failed", e, { room: this.code }));
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

  /** Broadcast the current lobby roster + settings (with a quick-start countdown if armed). */
  private broadcastLobby(): void {
    this.broadcast({
      type: "lobby",
      players: this.roster(),
      settings: this.settings,
      totals: this.totals,
      ...(this.autoStartAt > 0 ? { startsAt: this.autoStartAt } : {}),
    });
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
