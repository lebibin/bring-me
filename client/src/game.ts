/**
 * M0 local sandbox: builds the seeded world, spawns the local blob, runs the
 * ECS pipe, and drives a client-only practice round (T key) — jumbotron
 * countdown, reveal, deliver-to-NPC by walking or throwing. Multiplayer (M1)
 * replaces the practice round with server phases but reuses everything else.
 */

import * as THREE from "three";
import { hasComponent } from "bitecs";
import {
  ARCHETYPES,
  COUNTDOWN_MS,
  INTERP_DELAY_MS,
  MAX_PLAYERS,
  NPC_RADIUS,
  PLAYER_RADIUS,
  PROP_REST_Y,
  RESOLVE_MS,
  REVEAL_MS,
  THROW_HOLD_MS,
  GRAB_RADIUS,
  INTERP_EXTRAP_MS,
  groundHeightAt,
  OWN_POS_BLEND_DIST,
  OWN_POS_BLEND_RATE,
  OWN_POS_SNAP_DIST,
  generateWorld,
  type NetProp,
  type World,
} from "@bringme/shared";
import { createScene, buildStatics, disposeStatics, type SceneCtx } from "./render/scene.ts";
import { buildPropMesh } from "./render/propMeshes.ts";
import { snapshotProp } from "./render/propShot.ts";
import { buildBlob, recolorBlob, type BlobParts } from "./render/blob.ts";
import { Jumbotron } from "./render/jumbotron.ts";
import { world, object3ds, spawnPlayer, spawnProp, spawnNpc } from "./ecs/world.ts";
import { addComponent, removeComponent, removeEntity } from "bitecs";
import { Airborne, CarriedBy, Position, Prop, Yaw } from "./ecs/components.ts";
import {
  ballisticSystem,
  cameraSystem,
  carrierEids,
  carrySystem,
  carriedPropEid,
  dropCarried,
  lastThrower,
  localEid,
  movementSystem,
  renderSyncSystem,
  setSimWorld,
  throwCarried,
  tryGrab,
} from "./ecs/systems.ts";
import { input } from "./ecs/input.ts";
import { announce, announceTarget, clearAnnounce, setCharge, setTimer, toast } from "./ui/hud.ts";

export type LocalPhase = "IDLE" | "COUNTDOWN" | "REVEAL" | "SEEK" | "WIN";

export class Game {
  data: World;
  readonly seed: number;
  stage: number;
  readonly ctx: SceneCtx;
  readonly jumbotron: Jumbotron;
  readonly propEidById = new Map<number, number>();
  readonly playerEid: number;
  readonly npcEid: number;
  simTime = 0;
  phase: LocalPhase = "IDLE";
  /** false in net mode: the server drives rounds, T does nothing. */
  fakeRoundsEnabled = true;
  localNetId = 0;
  /** simTime until which the local player's input is frozen (server stun). */
  stunUntilSim = 0;
  netPhase: { name: string; endsAt: number; round?: number; totalRounds?: number } | null = null;
  private readonly remoteEids = new Map<number, number>();
  private readonly playerHues = new Map<number, number>();
  private readonly interpBufs = new Map<number, { rt: number; x: number; y: number; z: number; yaw: number }[]>();
  private readonly stunFx = new Map<number, number>(); // eid -> simTime until wobble
  private readonly walkAnim = new Map<number, { phase: number; lastX: number; lastZ: number }>();
  private readonly slapAnim = new Map<number, number>(); // eid -> simTime the slap started
  private camFocusStart = -1; // simTime the reveal camera pan began (-1 = inactive)
  private camFocusTotal = 3; // seconds the pan covers (countdown + reveal)
  private camFocusWideAt = 2; // seconds in when the slow zoom-out begins (reveal start)
  private ghost: THREE.Object3D | null = null;
  private phaseEndsAt = 0;
  private targetEid = 0;
  private npcObj: THREE.Object3D;
  private npcArrow!: THREE.Group;
  private staticsGroup: THREE.Group;

  constructor(container: HTMLElement, seed: number, stage = 0) {
    this.seed = seed;
    this.stage = stage;
    this.data = generateWorld(seed, stage);
    setSimWorld(this.data); // movement collides with the world's solid fixtures
    this.ctx = createScene(container);
    this.staticsGroup = buildStatics(this.ctx.scene, this.data);

    this.jumbotron = new Jumbotron(this.data);
    this.ctx.scene.add(this.jumbotron.group);

    this.spawnScatterProps();

    this.npcObj = buildBlob(45);
    this.ctx.scene.add(this.npcObj);
    this.npcEid = spawnNpc(this.data.npc.x, this.data.npc.z, this.data.plaza.facing, this.npcObj);

    // bouncing "deliver here" arrow over the NPC, shown while carrying
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    const arrow = new THREE.Group();
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.55, 4), arrowMat);
    tip.rotation.x = Math.PI; // point down at the NPC
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.22), arrowMat);
    shaft.position.y = 0.5;
    arrow.add(tip, shaft);
    arrow.position.set(this.data.npc.x, 2.6, this.data.npc.z);
    arrow.visible = false;
    this.ctx.scene.add(arrow);
    this.npcArrow = arrow;

    const spawn = this.data.spawnPoints[0];
    const blob = buildBlob(200);
    this.ctx.scene.add(blob);
    this.playerEid = spawnPlayer(spawn.x, spawn.z, this.data.plaza.facing, 1, true, blob);
    input.camYaw = this.data.plaza.facing;
  }

  private spawnScatterProps(): void {
    for (const p of this.data.props) {
      const mesh = buildPropMesh(p.archetype, p.hue, p.scale);
      this.ctx.scene.add(mesh);
      const eid = spawnProp(p.propId, p.archetype, p.x, PROP_REST_Y * p.scale, p.z, p.rotY, mesh);
      this.propEidById.set(p.propId, eid);
    }
  }

  /**
   * Swap the world to another stage (same seed): rebuild statics and the
   * decoy scatter. Plaza/NPC/spawns are seed-derived BEFORE any stage knob,
   * so they stay put — the jumbotron and NPC never move. Anyone left
   * standing inside a new solid walks out via the stepMove escape valve.
   */
  setStage(stage: number): void {
    if (stage === this.stage) return;
    this.stage = stage;
    this.data = generateWorld(this.seed, stage);
    setSimWorld(this.data);
    disposeStatics(this.ctx.scene, this.staticsGroup);
    this.staticsGroup = buildStatics(this.ctx.scene, this.data);
    // every prop entity goes — the old scatter AND created leftovers from
    // the previous match; the new stage's scatter replaces them
    for (const eid of this.propEidById.values()) {
      const obj = object3ds.get(eid);
      if (obj) this.ctx.scene.remove(obj);
      object3ds.delete(eid);
      removeEntity(world, eid);
    }
    this.propEidById.clear();
    this.spawnScatterProps();
  }

  /** One deterministic sim step — no rendering, drivable headlessly. */
  step(dt: number): void {
    this.simTime += dt;
    if (input.charging) {
      input.throwCharge = Math.min(1, input.throwCharge + dt / (THROW_HOLD_MS / 1000));
    }
    movementSystem(this.simTime < this.stunUntilSim ? 0 : dt);
    ballisticSystem(dt);
    carrySystem();
    this.stepRound();
    renderSyncSystem();
  }

  /** step + camera + visuals + draw; called from the RAF loop. */
  frame(dt: number): void {
    this.step(dt);
    this.interpolateRemotes(performance.now(), dt);
    this.animateWalk(dt);
    setCharge(input.charging, input.throwCharge);
    cameraSystem(this.ctx.camera);
    this.applyCameraFocus();
    // NPC stands ON the plaza pad (0.1 tall); the idle bob never dips below it
    this.npcObj.position.y = 0.1 + (Math.sin(this.simTime * 2.2) * 0.5 + 0.5) * 0.07;
    // "deliver here" arrow: visible while you carry, bouncing and spinning
    this.npcArrow.visible = this.carry() >= 0;
    if (this.npcArrow.visible) {
      this.npcArrow.position.y = 2.6 + Math.sin(this.simTime * 4) * 0.22;
      this.npcArrow.rotation.y += dt * 2.2;
    }
    this.jumbotron.update(dt);
    this.updateNetVisuals();
    this.ctx.render();
  }

  /** Server-driven HUD/jumbotron bits + ghost + stun wobble (net mode). */
  private updateNetVisuals(): void {
    const np = this.netPhase;
    if (np) {
      if (np.name === "COUNTDOWN") {
        this.jumbotron.setCountdown((np.endsAt - Date.now()) / 1000);
        setTimer(null);
      } else if (np.name === "SEEK" || np.name === "CREATE") {
        setTimer(np.endsAt > 0 ? (np.endsAt - Date.now()) / 1000 : null);
      } else {
        setTimer(null);
      }
    }
    if (this.ghost) {
      const e = this.playerEid;
      const gx = Position.x[e] + Math.sin(Yaw.v[e]) * 2;
      const gz = Position.z[e] + Math.cos(Yaw.v[e]) * 2;
      this.ghost.position.set(gx, groundHeightAt(this.data, gx, gz, 99, 0.05) + PROP_REST_Y, gz);
    }
    for (const [eid, until] of this.stunFx) {
      const obj = object3ds.get(eid);
      if (!obj) continue;
      if (this.simTime < until) {
        obj.rotation.z = Math.sin(this.simTime * 18) * 0.14;
      } else {
        obj.rotation.z = 0;
        this.stunFx.delete(eid);
      }
    }
  }

  grab(): number {
    return tryGrab();
  }

  drop(): void {
    dropCarried();
  }

  throw(power: number): number {
    return throwCarried(power);
  }

  /** propId currently carried by the local player, or -1. */
  carry(): number {
    const eid = carriedPropEid(localEid());
    return eid ? Prop.propId[eid] : -1;
  }

  // ---------- multiplayer (M1) ----------

  /** Move the local blob to its server-assigned spawn point. */
  setLocalSpawn(netId: number): void {
    this.localNetId = netId;
    const s = this.data.spawnPoints[(netId - 1) % MAX_PLAYERS];
    Position.x[this.playerEid] = s.x;
    Position.z[this.playerEid] = s.z;
  }

  /** Repaint a player's blob (and remember the hue for late spawns). */
  setPlayerHue(netId: number, hue: number): void {
    this.playerHues.set(netId, hue);
    const eid = netId === this.localNetId ? this.playerEid : this.remoteEids.get(netId);
    if (eid === undefined) return;
    const obj = object3ds.get(eid);
    if (obj) recolorBlob(obj, hue);
  }

  addRemote(netId: number): void {
    if (netId === this.localNetId || this.remoteEids.has(netId)) return;
    const blob = buildBlob(this.playerHues.get(netId) ?? (netId * 67) % 360);
    this.ctx.scene.add(blob);
    const s = this.data.spawnPoints[(netId - 1) % MAX_PLAYERS];
    const eid = spawnPlayer(s.x, s.z, 0, netId, false, blob);
    this.remoteEids.set(netId, eid);
    this.interpBufs.set(eid, []);
  }

  removeRemote(netId: number): void {
    const eid = this.remoteEids.get(netId);
    if (eid === undefined) return;
    const obj = object3ds.get(eid);
    if (obj) this.ctx.scene.remove(obj);
    object3ds.delete(eid);
    this.interpBufs.delete(eid);
    this.walkAnim.delete(eid);
    this.remoteEids.delete(netId);
    removeEntity(world, eid);
  }

  /** Buffer a remote player's snapshot sample (receive-time interpolation). */
  pushRemoteSample(netId: number, x: number, z: number, yaw: number, y = 0): void {
    const eid = this.remoteEids.get(netId);
    if (eid === undefined) return;
    const buf = this.interpBufs.get(eid);
    if (!buf) return;
    buf.push({ rt: performance.now(), x, y, z, yaw });
    if (buf.length > 6) buf.shift();
  }

  /** Public for the test hook — applies interp without a render pass. */
  interpolateRemotes(now: number, dt = 1 / 60): void {
    const target = now - INTERP_DELAY_MS;
    // exponential smoothing factor (frame-rate independent)
    const k = 1 - Math.exp(-dt * 14);
    for (const [eid, buf] of this.interpBufs) {
      if (buf.length === 0) continue;
      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].rt <= target && buf[i + 1].rt >= target) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      let tx: number;
      let ty: number;
      let tz: number;
      let tyaw: number;
      const newest = buf[buf.length - 1];
      if (target > newest.rt && buf.length >= 2) {
        // buffer ran dry (network jitter): extrapolate along the last segment's
        // velocity for a bounded window instead of freezing in place
        const prev = buf[buf.length - 2];
        const seg = Math.max(1, newest.rt - prev.rt);
        const ahead = Math.min(target - newest.rt, INTERP_EXTRAP_MS);
        tx = newest.x + ((newest.x - prev.x) / seg) * ahead;
        tz = newest.z + ((newest.z - prev.z) / seg) * ahead;
        ty = newest.y;
        tyaw = newest.yaw;
      } else {
        let t = b.rt === a.rt ? 1 : (target - a.rt) / (b.rt - a.rt);
        t = Math.min(1, Math.max(0, t));
        tx = a.x + (b.x - a.x) * t;
        ty = a.y + (b.y - a.y) * t;
        tz = a.z + (b.z - a.z) * t;
        let dy = b.yaw - a.yaw;
        if (dy > Math.PI) dy -= Math.PI * 2;
        if (dy < -Math.PI) dy += Math.PI * 2;
        tyaw = a.yaw + dy * t;
      }
      // ease the rendered pose toward the computed one — hides sample pops
      Position.x[eid] += (tx - Position.x[eid]) * k;
      Position.y[eid] += (ty - Position.y[eid]) * k;
      Position.z[eid] += (tz - Position.z[eid]) * k;
      let dyaw = tyaw - Yaw.v[eid];
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      Yaw.v[eid] += dyaw * k;
      const obj = object3ds.get(eid);
      if (obj) {
        obj.position.set(Position.x[eid], Position.y[eid], Position.z[eid]);
        obj.rotation.y = Yaw.v[eid];
      }
    }
  }

  remotePlayerCount(): number {
    return this.remoteEids.size;
  }

  /** Kick off the stun-slap swing on a player's arm (optimistic for self). */
  playSlap(netId: number): void {
    const eid = this.eidForNetId(netId);
    if (!eid) return;
    const started = this.slapAnim.get(eid);
    if (started !== undefined && this.simTime - started < 0.3) return; // already mid-swing
    this.slapAnim.set(eid, this.simTime);
  }

  /**
   * Procedural pose layer: legs swing with traveled distance; arms pick the
   * strongest applicable pose — slap swing > carrying hold > walk swing.
   */
  private animateWalk(dt: number): void {
    const carriers = carrierEids();
    const eids = [this.playerEid, this.npcEid, ...this.remoteEids.values()];
    for (const eid of eids) {
      const obj = object3ds.get(eid);
      const parts = obj?.userData["parts"] as BlobParts | undefined;
      if (!obj || !parts) continue;
      let st = this.walkAnim.get(eid);
      if (!st) {
        st = { phase: 0, lastX: obj.position.x, lastZ: obj.position.z };
        this.walkAnim.set(eid, st);
      }
      const dist = Math.hypot(obj.position.x - st.lastX, obj.position.z - st.lastZ);
      st.lastX = obj.position.x;
      st.lastZ = obj.position.z;
      const moving = dist > 0.0008;
      const swing = moving ? Math.sin((st.phase += dist * 5.5)) * 0.6 : 0;
      const airborne =
        Position.y[eid] > groundHeightAt(this.data, Position.x[eid], Position.z[eid], Position.y[eid]) + 0.04;

      // legs + bob follow movement; airborne strikes the Mario pose — front
      // knee driven up, back leg kicked out behind
      if (airborne) {
        const blendAir = Math.min(1, dt * 18);
        parts.legL.rotation.x += (-1.05 - parts.legL.rotation.x) * blendAir;
        parts.legR.rotation.x += (0.75 - parts.legR.rotation.x) * blendAir;
        parts.body.position.y = 0;
      } else if (moving) {
        parts.legL.rotation.x = swing;
        parts.legR.rotation.x = -swing;
        parts.body.position.y = Math.abs(Math.sin(st.phase)) * 0.045;
      } else {
        const ease = Math.max(0, 1 - dt * 12);
        parts.legL.rotation.x *= ease;
        parts.legR.rotation.x *= ease;
        parts.body.position.y *= ease;
      }

      // arms: hold pose while carrying > Mario jump (fist punched skyward,
      // other arm swung down-back) > walk swing / rest. The raised fist goes
      // UP THROUGH THE FRONT (-2.9 ≡ up, tilted slightly forward) — swinging
      // it backward made the jumper read as facing the wrong way.
      const carrying = carriers.has(eid);
      const blend = Math.min(1, dt * 14);
      // walking arms take a real stride: wider swing than the legs' 0.6x
      // dampening used before, opposite phase to the same-side leg
      const armSwingL = moving ? -swing * 0.9 : 0;
      const armSwingR = moving ? swing * 0.9 : 0;
      const targetL = carrying ? -0.85 : airborne ? 0.55 : armSwingL;
      const targetR = carrying ? -0.85 : airborne ? -2.9 : armSwingR;
      parts.armL.rotation.x += (targetL - parts.armL.rotation.x) * blend;
      parts.armR.rotation.x += (targetR - parts.armR.rotation.x) * blend;
      // elbows: deep bend wrapping a carried object, straight for the raised
      // jump fist; while walking they pump — bent on the forward carry,
      // nearly straight on the backswing (stiff arms read as sleepwalking)
      const elbowL = carrying ? -0.7 : airborne ? -0.25 : -0.18 - Math.max(0, -armSwingL) * 0.8;
      const elbowR = carrying ? -0.7 : airborne ? -0.05 : -0.18 - Math.max(0, -armSwingR) * 0.8;
      parts.elbowL.rotation.x += (elbowL - parts.elbowL.rotation.x) * blend;
      parts.elbowR.rotation.x += (elbowR - parts.elbowR.rotation.x) * blend;

      // slap: anticipation -> whip -> follow-through, with the whole body in it
      const slapStart = this.slapAnim.get(eid);
      if (slapStart !== undefined) {
        const p = (this.simTime - slapStart) / 0.45;
        if (p >= 1) {
          this.slapAnim.delete(eid);
          parts.body.rotation.y = 0;
          parts.body.rotation.x = 0;
          parts.body.position.z = 0;
          parts.body.position.y = 0;
          parts.armR.rotation.z = 0.1;
        } else {
          let armX: number;
          let armZ: number;
          let twist: number;
          let lean = 0;
          if (p < 0.3) {
            // wind up: arm back over the shoulder, torso coils away
            const w = easeOut(p / 0.3);
            armX = 1.1 * w;
            armZ = 0.1 + 0.6 * w;
            twist = -0.35 * w;
          } else if (p < 0.55) {
            // the whip: arm slashes through, torso snaps around with a waist lean
            const s = easeOut((p - 0.3) / 0.25);
            armX = 1.1 - 3.1 * s;
            armZ = 0.7 - 1.25 * s;
            twist = -0.35 + 0.85 * s;
            lean = Math.sin(s * Math.PI) * 0.14;
          } else {
            // follow-through: everything settles back
            const r = easeOut((p - 0.55) / 0.45);
            armX = -2.0 * (1 - r);
            armZ = -0.55 + 0.65 * r;
            twist = 0.5 * (1 - r);
          }
          parts.armR.rotation.x = armX;
          parts.armR.rotation.z = armZ;
          parts.body.rotation.y = twist;
          // lean pivots at the hips (~y 0.55), not the feet, so the torso
          // bends instead of sliding off the legs
          parts.body.rotation.x = lean;
          parts.body.position.z = -Math.sin(lean) * 0.55;
          parts.body.position.y = (1 - Math.cos(lean)) * 0.55;
        }
      } else if (Math.abs(parts.armR.rotation.z - 0.1) > 0.001) {
        parts.armR.rotation.z += (0.1 - parts.armR.rotation.z) * blend;
      }
    }
  }

  /**
   * Reconcile our predicted position against the server's view of us.
   * Small divergence is normal report lag (dead zone); moderate divergence
   * blends smoothly; teleport-grade divergence (server clamp, stun freeze)
   * snaps.
   */
  reconcileOwnPos(sx: number, sz: number): void {
    const e = this.playerEid;
    const dx = sx - Position.x[e];
    const dz = sz - Position.z[e];
    const d = Math.hypot(dx, dz);
    if (d > OWN_POS_SNAP_DIST) {
      Position.x[e] = sx;
      Position.z[e] = sz;
    } else if (d > OWN_POS_BLEND_DIST) {
      Position.x[e] += dx * OWN_POS_BLEND_RATE;
      Position.z[e] += dz * OWN_POS_BLEND_RATE;
    }
  }

  /** Current position of a prop, for optimistic-action rollback bookkeeping. */
  propPosition(propId: number): { x: number; y: number; z: number } | null {
    const eid = this.propEidById.get(propId);
    if (eid === undefined) return null;
    return { x: Position.x[eid], y: Position.y[eid], z: Position.z[eid] };
  }

  /** Undo an optimistic pickup/throw: detach and put the prop back exactly. */
  forceDetach(propId: number, x: number, y: number, z: number): void {
    const eid = this.propEidById.get(propId);
    if (eid === undefined) return;
    if (hasComponent(world, CarriedBy, eid)) removeComponent(world, CarriedBy, eid);
    if (hasComponent(world, Airborne, eid)) removeComponent(world, Airborne, eid);
    Position.x[eid] = x;
    Position.y[eid] = y;
    Position.z[eid] = z;
  }

  private eidForNetId(netId: number): number {
    if (netId === this.localNetId) return this.playerEid;
    return this.remoteEids.get(netId) ?? 0;
  }

  /** Spawn or replace a player-created object (propAdded). */
  addCreatedProp(prop: NetProp): void {
    const old = this.propEidById.get(prop.propId);
    if (old !== undefined) {
      const obj = object3ds.get(old);
      if (obj) this.ctx.scene.remove(obj);
      object3ds.delete(old);
      removeEntity(world, old);
      this.propEidById.delete(prop.propId);
    }
    const mesh = buildPropMesh(prop.archetype, prop.hue, prop.scale);
    this.ctx.scene.add(mesh);
    // objects can be placed on standable fixture tops — rest on the surface
    const surf = groundHeightAt(this.data, prop.x, prop.z, 99, 0.05);
    const eid = spawnProp(prop.propId, prop.archetype, prop.x, surf + PROP_REST_Y * prop.scale, prop.z, 0, mesh);
    this.propEidById.set(prop.propId, eid);
  }

  applyGrabbed(netId: number, propId: number): void {
    const teid = this.propEidById.get(propId);
    const peid = this.eidForNetId(netId);
    if (teid === undefined || !peid) return;
    if (hasComponent(world, Airborne, teid)) removeComponent(world, Airborne, teid);
    addComponent(world, CarriedBy, teid);
    CarriedBy.eid[teid] = peid;
  }

  applyDropped(propId: number, x: number, z: number): void {
    const teid = this.propEidById.get(propId);
    if (teid === undefined) return;
    if (hasComponent(world, CarriedBy, teid)) removeComponent(world, CarriedBy, teid);
    if (hasComponent(world, Airborne, teid)) removeComponent(world, Airborne, teid);
    Position.x[teid] = x;
    Position.y[teid] = groundHeightAt(this.data, x, z, 99, 0.05) + PROP_REST_Y;
    Position.z[teid] = z;
  }

  /**
   * Self-heal carry state from the server snapshot (the authoritative view):
   * missed/raced grab-drop events can desync who is visibly holding what.
   */
  reconcileCarry(netId: number, serverCarry: number): void {
    const peid = this.eidForNetId(netId);
    if (!peid) return;
    let clientCarry = -1;
    let clientEid = 0;
    for (const [propId, eid] of this.propEidById) {
      if (hasComponent(world, CarriedBy, eid) && CarriedBy.eid[eid] === peid) {
        clientCarry = propId;
        clientEid = eid;
        break;
      }
    }
    if (clientCarry === serverCarry) return;
    if (clientCarry >= 0 && clientEid) {
      // server says this hand is empty (or holds something else) — drop ours
      this.applyDropped(clientCarry, Position.x[peid], Position.z[peid]);
    }
    if (serverCarry >= 0) this.applyGrabbed(netId, serverCarry);
  }

  applyThrown(propId: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const teid = this.propEidById.get(propId);
    if (teid === undefined) return;
    if (hasComponent(world, CarriedBy, teid)) removeComponent(world, CarriedBy, teid);
    addComponent(world, Airborne, teid);
    Position.x[teid] = x;
    Position.y[teid] = y;
    Position.z[teid] = z;
    Airborne.vx[teid] = vx;
    Airborne.vy[teid] = vy;
    Airborne.vz[teid] = vz;
  }

  applyStunned(victimNetId: number, untilEpoch: number): void {
    const durSec = Math.max(0, untilEpoch - Date.now()) / 1000;
    const eid = this.eidForNetId(victimNetId);
    if (!eid) return;
    this.stunFx.set(eid, this.simTime + durSec);
    if (victimNetId === this.localNetId) this.stunUntilSim = this.simTime + durSec;
  }

  /** Server correction for a loose (dropped/landed) prop's position. */
  applyLoose(propId: number, x: number, y: number, z: number): void {
    const teid = this.propEidById.get(propId);
    if (teid === undefined) return;
    if (hasComponent(world, CarriedBy, teid)) return;
    if (hasComponent(world, Airborne, teid)) return; // local ballistics mirror the server
    Position.x[teid] = x;
    Position.y[teid] = y;
    Position.z[teid] = z;
  }

  /** Show the target as a rendered picture of the actual object. */
  applyReveal(archetypeIdx: number, hue: number, scale: number): void {
    const shot = snapshotProp(archetypeIdx, hue, scale);
    this.jumbotron.setReveal(shot, buildPropMesh(archetypeIdx, hue, scale));
    announceTarget(shot);
  }

  /** Pull the view to the jumbotron for `totalSec`; zoom out at `wideAtSec`. */
  startCamFocus(totalSec: number, wideAtSec = totalSec): void {
    this.camFocusStart = this.simTime;
    this.camFocusTotal = totalSec;
    this.camFocusWideAt = wideAtSec;
  }

  /**
   * Reveal camera: ease to a close-up of the jumbotron for the countdown,
   * then — as the reveal starts — slowly pull back to a wider framing that
   * fits the screen AND the spinning 3D preview of the target in one shot,
   * then ease back to exactly the follow-cam pose (which cameraSystem
   * recomputes every frame, so returning players keep their orbit).
   */
  private applyCameraFocus(): void {
    if (this.camFocusStart < 0) return;
    const t = this.simTime - this.camFocusStart;
    const total = this.camFocusTotal;
    let k: number;
    if (t < 1.0) k = smoothstep(t / 1.0);
    else if (t < total - 0.8) k = 1;
    else if (t < total) k = 1 - smoothstep((t - (total - 0.8)) / 0.8);
    else {
      this.camFocusStart = -1;
      return;
    }
    // u: 0 = countdown close-up, 1 = wide reveal shot (screen + 3D preview)
    const u = smoothstep((t - this.camFocusWideAt) / 1.6);
    const f = this.data.plaza.facing;
    const dist = 3.6 + (7.4 - 3.6) * u;
    const camX = this.data.plaza.x + Math.sin(f) * dist;
    const camZ = this.data.plaza.z + Math.cos(f) * dist;
    const camY = 3.8 + (3.0 - 3.8) * u;
    const lookAhead = 0.2 + 0.6 * u;
    const lookX = this.data.plaza.x + Math.sin(f) * lookAhead;
    const lookZ = this.data.plaza.z + Math.cos(f) * lookAhead;
    const lookY = 3.9 + (3.0 - 3.9) * u;
    const cam = this.ctx.camera;
    // cameraSystem just wrote the follow pose — blend from it toward the screen
    cam.position.set(
      cam.position.x + (camX - cam.position.x) * k,
      cam.position.y + (camY - cam.position.y) * k,
      cam.position.z + (camZ - cam.position.z) * k,
    );
    const e = this.playerEid;
    cam.lookAt(
      Position.x[e] + (lookX - Position.x[e]) * k,
      1.1 + (lookY - 1.1) * k,
      Position.z[e] + (lookZ - Position.z[e]) * k,
    );
  }

  setNetPhase(name: string, endsAt: number, round?: number, totalRounds?: number): void {
    this.netPhase = { name, endsAt, round, totalRounds };
    if (name === "CREATE") {
      this.jumbotron.setIdle();
      announce("CREATE & HIDE your object!");
    } else if (name === "LOBBY") {
      this.jumbotron.setIdle();
      clearAnnounce();
      setTimer(null);
      this.clearGhost();
    } else if (name === "COUNTDOWN") {
      clearAnnounce();
      this.clearGhost();
      // pull in for the countdown, widen when the reveal starts
      this.startCamFocus((COUNTDOWN_MS + REVEAL_MS) / 1000, COUNTDOWN_MS / 1000);
    }
  }

  setGhost(archetypeIdx: number, hue: number, scale: number): void {
    this.clearGhost();
    const g = buildPropMesh(archetypeIdx, hue, scale);
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const m = (mesh.material as THREE.MeshStandardMaterial).clone();
        m.transparent = true;
        m.opacity = 0.55;
        mesh.material = m;
      }
    });
    this.ctx.scene.add(g);
    this.ghost = g;
  }

  clearGhost(): void {
    if (this.ghost) {
      this.ctx.scene.remove(this.ghost);
      this.ghost = null;
    }
  }

  /** Where a placed object would land: the ghost spot in front of the player. */
  ghostPos(): { x: number; z: number } {
    const e = this.playerEid;
    return {
      x: Position.x[e] + Math.sin(Yaw.v[e]) * 2,
      z: Position.z[e] + Math.cos(Yaw.v[e]) * 2,
    };
  }

  /** Nearest free prop in grab range — ANY catalog object can be carried (chaos rule). */
  nearestGrabbablePropId(): number {
    const e = this.playerEid;
    let best = -1;
    let bestD = GRAB_RADIUS;
    for (const [propId, eid] of this.propEidById) {
      if (hasComponent(world, CarriedBy, eid)) continue;
      const d = Math.hypot(Position.x[eid] - Position.x[e], Position.z[eid] - Position.z[e]);
      if (d < bestD) {
        bestD = d;
        best = propId;
      }
    }
    return best;
  }

  /** Position of a remote blob, for tests. */
  remotePos(netId: number): { x: number; z: number } | null {
    const eid = this.remoteEids.get(netId);
    if (eid === undefined) return null;
    return { x: Position.x[eid], z: Position.z[eid] };
  }

  startFakeRound(propId?: number): void {
    if (!this.fakeRoundsEnabled) return;
    const eid =
      propId !== undefined
        ? (this.propEidById.get(propId) ?? 0)
        : this.randomTargetEid();
    if (!eid) return;
    this.targetEid = eid;
    this.phase = "COUNTDOWN";
    this.phaseEndsAt = this.simTime + COUNTDOWN_MS / 1000;
    clearAnnounce();
    this.startCamFocus((COUNTDOWN_MS + REVEAL_MS) / 1000, COUNTDOWN_MS / 1000);
  }

  targetPropId(): number {
    return this.targetEid ? Prop.propId[this.targetEid] : -1;
  }

  private randomTargetEid(): number {
    const ids = [...this.propEidById.values()];
    return ids.length ? ids[Math.floor(Math.random() * ids.length)] : 0;
  }

  private targetInfo(): { name: string; hue: number; archetype: number; scale: number } {
    const eid = this.targetEid;
    const src = this.data.props.find((p) => p.propId === Prop.propId[eid]);
    const archetype = Prop.archetype[eid];
    return {
      name: ARCHETYPES[archetype].name,
      hue: src ? src.hue : 0,
      archetype,
      scale: src ? src.scale : 1,
    };
  }

  private stepRound(): void {
    switch (this.phase) {
      case "COUNTDOWN": {
        this.jumbotron.setCountdown(this.phaseEndsAt - this.simTime);
        if (this.simTime >= this.phaseEndsAt) {
          const t = this.targetInfo();
          this.applyReveal(t.archetype, t.hue, t.scale);
          this.phase = "REVEAL";
          this.phaseEndsAt = this.simTime + REVEAL_MS / 1000;
        }
        break;
      }
      case "REVEAL":
        if (this.simTime >= this.phaseEndsAt) this.phase = "SEEK";
        break;
      case "SEEK":
        this.checkDelivery();
        break;
      case "WIN":
        if (this.simTime >= this.phaseEndsAt) {
          this.phase = "IDLE";
          this.targetEid = 0;
          this.jumbotron.setIdle();
          clearAnnounce();
        }
        break;
      case "IDLE":
        break;
    }
  }

  private checkDelivery(): void {
    const teid = this.targetEid;
    if (!teid) return;
    const nx = this.data.npc.x;
    const nz = this.data.npc.z;
    let delivered = false;
    if (hasComponent(world, CarriedBy, teid)) {
      const carrier = CarriedBy.eid[teid];
      delivered =
        Math.hypot(Position.x[carrier] - nx, Position.z[carrier] - nz) <
        NPC_RADIUS + PLAYER_RADIUS;
    } else if (hasComponent(world, Airborne, teid)) {
      const dy = Position.y[teid] - 0.8;
      delivered =
        Math.hypot(Position.x[teid] - nx, Position.z[teid] - nz) < NPC_RADIUS &&
        Math.abs(dy) < 1.4 &&
        lastThrower !== 0;
    }
    if (!delivered) return;

    // settle the prop at the NPC's feet
    if (hasComponent(world, CarriedBy, teid)) dropCarried();
    Position.x[teid] = nx;
    Position.y[teid] = PROP_REST_Y;
    Position.z[teid] = nz + 0.8;

    this.phase = "WIN";
    this.phaseEndsAt = this.simTime + RESOLVE_MS / 1000;
    this.jumbotron.setWin("DELIVERED!");
    toast("DELIVERED! You win 🎉");
  }
}

function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) * (1 - c);
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

// re-export for the hook
export { object3ds };
