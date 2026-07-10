/**
 * Room client: owns the socket, creates the Game when `welcome` arrives
 * (world seed comes from the server), keeps the roster in sync, feeds
 * snapshots into remote-player interpolation, applies authoritative match
 * events to the ECS, and reports local position at POS_SEND_HZ during live
 * phases. All outcome-y actions (grab/stun/throw/place) are just messages —
 * the server decides.
 */

import {
  CARRY_HEIGHT,
  POS_SEND_HZ,
  PROTOCOL_VERSION,
  STUN_COOLDOWN_MS,
  archetypeIndex,
  q2,
  throwVelocity,
  type MatchSettings,
  type PhaseName,
  type PlayerInfo,
  type RoomTotals,
  type S2C,
} from "@bringme/shared";
import { Game } from "../game.ts";
import { Position, Yaw } from "../ecs/components.ts";
import { RoomSocket } from "./socket.ts";
import { initSlapSounds, playSlapSound } from "../audio.ts";
import { CreatePanel } from "../ui/createPanel.ts";
import { setPing, setScores, setStunCooldown, toast } from "../ui/hud.ts";
import type { LobbyUI } from "../ui/lobby.ts";

export class NetClient {
  game: Game | null = null;
  myId = 0;
  serverPhase: PhaseName = "LOBBY";
  players: PlayerInfo[] = [];
  scores: Record<number, number> = {};
  /** cumulative points across every game this room has finished */
  totals: RoomTotals = {};
  private socket: RoomSocket | null = null;
  private posTimer: number | null = null;
  private stunCdUntil = 0;
  private panel: CreatePanel | null = null;
  /** token that reclaims our playerId after a drop; survives reloads too */
  private resume: string | null = null;
  private pingTimer: number | null = null;
  private pingSentAt = 0; // performance.now() of the probe in flight; 0 = none
  /**
   * One optimistic action in flight at a time. Applied locally the instant
   * the key is pressed; the server's broadcast confirms it (idempotent
   * re-apply) and an err rolls it back to the recorded state. The DO stays
   * the single authority — this only hides the round trip.
   */
  private pending:
    | { action: "grab" | "throw"; propId: number; x: number; y: number; z: number }
    | null = null;

  constructor(
    private readonly container: HTMLElement,
    readonly code: string,
    private readonly name: string,
    private readonly ui: LobbyUI,
    private readonly onGameReady: (game: Game) => void,
  ) {}

  connect(): void {
    this.ui.setStatus("connecting…");
    try {
      this.resume = sessionStorage.getItem(`bringme_resume_${this.code}`);
    } catch {
      /* storage blocked — resume only survives within this page's lifetime */
    }
    this.socket = new RoomSocket(this.code, {
      onOpen: () => {
        this.socket?.send({
          type: "hello",
          name: this.name,
          v: PROTOCOL_VERSION,
          ...(this.resume ? { resume: this.resume } : {}),
        });
      },
      onMsg: (m) => this.onMsg(m),
      onReconnecting: (attempt) => {
        this.stopPosSender();
        this.pingSentAt = 0;
        setPing(-1);
        if (attempt === 1) toast("connection lost — reconnecting…", 2400);
        this.ui.setStatus(`reconnecting… (try ${attempt})`);
      },
    });
    this.startPingLoop();
  }

  isHost(): boolean {
    return this.players.some((p) => p.id === this.myId && p.isHost);
  }

  start(settings: MatchSettings): void {
    this.socket?.send({ type: "start", settings });
  }

  // ---- actions (server-authoritative; these only send) ----

  /**
   * Range-checked actions ride on the server's view of our position, which
   * can be a report stale by up to one send interval (worse in throttled
   * background tabs). Flushing a fresh report first keeps grab/stun range
   * checks honest.
   */
  private sendPosNow(): void {
    const g = this.game;
    if (!g) return;
    this.socket?.send({
      type: "pos",
      x: q2(Position.x[g.playerEid]),
      y: q2(Position.y[g.playerEid]),
      z: q2(Position.z[g.playerEid]),
      yaw: q2(Yaw.v[g.playerEid]),
    });
  }

  grabAction(): void {
    const g = this.game;
    if (!g) return;
    const propId = g.nearestGrabbablePropId();
    if (propId < 0) return;
    this.sendPosNow();
    // optimistic: it's in your hands the moment you press E
    const prev = g.propPosition(propId);
    if (prev && this.serverPhase === "SEEK") {
      g.applyGrabbed(this.myId, propId);
      this.pending = { action: "grab", propId, ...prev };
    }
    this.socket?.send({ type: "grab", propId });
  }

  dropAction(): void {
    const g = this.game;
    const propId = g?.carry() ?? -1;
    // optimistic; a server-side drop of nothing is a silent no-op, so no rollback needed
    if (g && propId >= 0) {
      const e = g.playerEid;
      g.applyDropped(propId, Position.x[e], Position.z[e]);
    }
    this.socket?.send({ type: "drop" });
  }

  stunAction(): void {
    this.sendPosNow();
    this.game?.playSlap(this.myId); // swing instantly; a whiff is honest feedback
    this.socket?.send({ type: "stun" });
  }

  throwAction(power: number): void {
    const g = this.game;
    if (!g) return;
    this.sendPosNow();
    // throw the way the character is facing, not where the camera points
    const yaw = Yaw.v[g.playerEid];
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    // optimistic: launch the same arc the server will compute (shared ballistics)
    const propId = g.carry();
    if (propId >= 0) {
      const prev = g.propPosition(propId);
      const v = throwVelocity(dirX, dirZ, power);
      const e = g.playerEid;
      g.applyThrown(propId, Position.x[e] + dirX * 0.6, CARRY_HEIGHT, Position.z[e] + dirZ * 0.6, v.vx, v.vy, v.vz);
      if (prev) this.pending = { action: "throw", propId, ...prev };
    }
    this.socket?.send({ type: "throw", dirX: q2(dirX), dirZ: q2(dirZ), power: q2(power) });
  }

  /** Server said no — put things back exactly as they were. */
  private rollbackPending(): void {
    const p = this.pending;
    const g = this.game;
    this.pending = null;
    if (!p || !g) return;
    if (p.action === "grab") {
      // only undo if we still (optimistically) hold it — if the race loser is
      // us, the winner's `grabbed` broadcast has already reassigned it
      if (g.carry() === p.propId) g.forceDetach(p.propId, p.x, p.y, p.z);
    } else {
      // rejected throw: the prop never left our hands
      g.applyGrabbed(this.myId, p.propId);
    }
  }

  placeAction(): void {
    if (this.serverPhase !== "CREATE" || !this.game) return;
    const pos = this.game.ghostPos();
    this.socket?.send({ type: "placeObject", x: q2(pos.x), z: q2(pos.z) });
  }

  pickAction(archetype: string, hue: number, scale: number): void {
    this.socket?.send({ type: "pickObject", archetype, params: { hue, scale } });
    this.game?.setGhost(archetypeIndex(archetype), hue, scale);
  }

  // ---- message handling ----

  private onMsg(m: S2C): void {
    switch (m.type) {
      case "welcome": {
        this.myId = m.playerId;
        this.players = m.players;
        this.serverPhase = m.phase;
        this.scores = m.scores;
        this.totals = m.totals;
        this.saveResume(m.resume);
        if (this.game) {
          // reconnected mid-session: keep the running Game (a second init
          // would double every listener) and just resync room state; the
          // server re-sends propAdded/phase, snapshots self-heal the rest
          for (const p of m.players) if (p.id !== this.myId) this.game.addRemote(p.id);
          toast("reconnected ✓", 1600);
          if (this.serverPhase !== "LOBBY") {
            this.enterLivePhase();
          } else {
            this.ui.showRoom(this.code, this.players, this.isHost(), m.settings, this.totals);
          }
          this.sendPing();
          break;
        }
        const game = new Game(this.container, m.seed);
        game.fakeRoundsEnabled = false;
        game.setLocalSpawn(this.myId);
        for (const p of m.players) if (p.id !== this.myId) game.addRemote(p.id);
        this.game = game;
        this.panel = new CreatePanel(
          (sel) => this.pickAction(sel.archetype, sel.params.hue, sel.params.scale),
          () => this.placeAction(),
        );
        this.ui.showRoom(this.code, this.players, this.isHost(), m.settings, this.totals);
        this.onGameReady(game);
        initSlapSounds(); // start preloading before the first stun lands
        if (this.serverPhase !== "LOBBY") this.enterLivePhase();
        this.sendPing(); // first latency reading right away
        break;
      }
      case "pong":
        if (this.pingSentAt !== 0) {
          setPing(performance.now() - this.pingSentAt);
          this.pingSentAt = 0;
        }
        break;
      case "lobby":
        this.players = m.players;
        this.totals = m.totals;
        this.ui.updatePlayers(m.players, this.isHost(), m.settings);
        for (const p of m.players) if (p.id !== this.myId) this.game?.addRemote(p.id);
        break;
      case "playerJoined":
        this.game?.addRemote(m.player.id);
        break;
      case "playerLeft":
        this.game?.removeRemote(m.playerId);
        break;
      case "phase":
        this.serverPhase = m.name;
        this.game?.setNetPhase(m.name, m.endsAt, m.round, m.totalRounds);
        if (m.name === "CREATE") {
          this.enterLivePhase();
          this.panel?.show();
        } else {
          this.panel?.hide();
        }
        if (m.name === "LOBBY") {
          this.ui.showRoom(this.code, this.players, this.isHost(), this.ui.readSettings(), this.totals);
          setStunCooldown(null);
        } else {
          this.ui.hide();
        }
        break;
      case "reveal": {
        const idx = archetypeIndex(m.archetype);
        this.game?.applyReveal(idx, m.params.hue, m.params.scale);
        break;
      }
      case "propAdded":
        this.game?.addCreatedProp(m.prop);
        if (m.creatorId === this.myId) {
          this.panel?.setStatus("placed ✓ — you can re-place until the timer ends");
        }
        break;
      case "grabbed":
        this.game?.applyGrabbed(m.playerId, m.propId);
        if (m.playerId === this.myId) {
          if (this.pending?.action === "grab" && this.pending.propId === m.propId) this.pending = null;
          toast("BRING ME!", 1400);
        }
        break;
      case "dropped":
        this.game?.applyDropped(m.propId, m.x, m.z);
        break;
      case "thrown":
        this.game?.applyThrown(m.propId, m.x, m.y, m.z, m.vx, m.vy, m.vz);
        if (m.byId === this.myId && this.pending?.action === "throw") this.pending = null;
        break;
      case "stunned":
        this.game?.applyStunned(m.victimId, m.until);
        this.game?.playSlap(m.byId); // no-op for self if the optimistic swing is mid-flight
        // keyed by the shared timestamp so every client plays the same file
        playSlapSound(m.until);
        if (m.byId === this.myId) this.stunCdUntil = Date.now() + STUN_COOLDOWN_MS;
        if (m.victimId === this.myId) toast("STUNNED!", 1600);
        break;
      case "delivered":
        toast(`${this.nameOf(m.byId)} delivered it! +${m.points}`, 2600);
        this.game?.jumbotron.setWin("DELIVERED!");
        break;
      case "roundEnd":
        if (!m.found) {
          toast(`unfound! ${this.nameOf(m.creatorId)} +${m.creatorPoints} (×2)`, 3000);
          this.game?.jumbotron.setWin("NOBODY FOUND IT!");
        } else if (m.creatorPoints > 0) {
          toast(`${this.nameOf(m.creatorId)} sneaky bonus +${m.creatorPoints}`, 2200);
        }
        this.scores = m.scores;
        break;
      case "matchEnd": {
        this.scores = m.scores;
        this.totals = m.totals; // arrives before the LOBBY phase msg re-opens the room panel
        const rows = Object.entries(m.scores)
          .map(([id, pts]) => ({ name: this.nameOf(Number(id)), pts }))
          .sort((a, b) => b.pts - a.pts);
        const winner = rows[0];
        toast(winner ? `🏆 ${winner.name} wins with ${Math.round(winner.pts)}!` : "match over", 5000);
        this.ui.setStatus(rows.map((r, i) => `${i + 1}. ${r.name} — ${Math.round(r.pts)}`).join("  ·  "));
        break;
      }
      case "snapshot": {
        for (const sp of m.players) {
          if (sp.id === this.myId) {
            this.game?.reconcileOwnPos(sp.x, sp.z);
            // self-heal own carry state unless an optimistic action is in flight
            if (!this.pending) this.game?.reconcileCarry(sp.id, sp.carry);
            continue;
          }
          this.game?.addRemote(sp.id);
          this.game?.pushRemoteSample(sp.id, sp.x, sp.z, sp.yaw, sp.y ?? 0);
          this.game?.reconcileCarry(sp.id, sp.carry);
        }
        for (const lp of m.loose) this.game?.applyLoose(lp.propId, lp.x, lp.y, lp.z);
        this.scores = m.scores;
        this.updateHudScores();
        if (this.serverPhase === "SEEK") {
          setStunCooldown(Math.max(0, this.stunCdUntil - Date.now()) / 1000);
        } else {
          setStunCooldown(null);
        }
        break;
      }
      case "err":
        this.rollbackPending();
        if (m.code === "wrong") toast("not this one!", 1200);
        else if (m.code === "own") toast("that's not allowed!", 1400);
        else if (m.code === "cooldown") toast("stun recharging…", 1000);
        else this.ui.setStatus(`server: ${m.code}`);
        break;
      default:
        break;
    }
  }

  private nameOf(id: number): string {
    return this.players.find((p) => p.id === id)?.name ?? `player ${id}`;
  }

  private updateHudScores(): void {
    const rows = this.players
      .filter((p) => p.id in this.scores)
      .map((p) => ({ name: p.name, pts: this.scores[p.id], me: p.id === this.myId }))
      .sort((a, b) => b.pts - a.pts);
    setScores(rows);
  }

  private saveResume(token: string): void {
    this.resume = token;
    try {
      sessionStorage.setItem(`bringme_resume_${this.code}`, token);
    } catch {
      /* storage blocked */
    }
  }

  // ---- keepalive + latency probe ----
  // One ping in flight at a time, every 3s, in EVERY phase — the lobby used
  // to sit fully silent, which is exactly when idle timeouts cut long-haul
  // players. The DO answers via auto-response without waking up.

  private startPingLoop(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = window.setInterval(() => this.sendPing(), 3000);
  }

  private sendPing(): void {
    if (!this.socket?.isOpen) return;
    const now = performance.now();
    if (this.pingSentAt !== 0 && now - this.pingSentAt > 6000) {
      setPing(9999); // pong lost — show the worst bar while we keep probing
      this.pingSentAt = 0;
    }
    if (this.pingSentAt !== 0) return;
    this.pingSentAt = now;
    this.socket.send({ type: "ping" });
  }

  private enterLivePhase(): void {
    this.ui.hide();
    this.startPosSender();
  }

  private startPosSender(): void {
    if (this.posTimer !== null) return;
    this.posTimer = window.setInterval(() => this.sendPosNow(), 1000 / POS_SEND_HZ);
  }

  private stopPosSender(): void {
    if (this.posTimer === null) return;
    clearInterval(this.posTimer);
    this.posTimer = null;
  }
}
