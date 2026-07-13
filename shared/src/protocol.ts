/**
 * Wire protocol — JSON text frames, discriminated on `type`.
 * C2S = client to server, S2C = server to client.
 */

import type { PropParams } from "./catalog.ts";

export type PhaseName =
  | "LOBBY"
  | "CREATE"
  | "COUNTDOWN"
  | "REVEAL"
  | "SEEK"
  | "RESOLVE"
  | "MATCH_END";

export interface MatchSettings {
  createSecs: number;
  roundSecs: number;
  /** index into STAGES; host picks it in the lobby, applied at match start */
  stage: number;
}

export interface PlayerInfo {
  id: number;
  name: string;
  isHost: boolean;
  /** blob body color, degrees 0-359 (player-picked; defaults to a per-id hash) */
  hue: number;
}

/**
 * Cumulative standings across every finished game in this room's lifetime.
 * Keyed by playerId; keeps the name so departed players stay on the board.
 */
export type RoomTotals = Record<number, { name: string; pts: number }>;

/** A dynamic (player-created or loose) prop on the wire. */
export interface NetProp {
  propId: number;
  archetype: number;
  hue: number;
  scale: number;
  x: number;
  z: number;
}

// ---------- C2S ----------

export type C2S =
  /**
   * `pub`/`quick` only honored on the very first hello a brand-new room
   * receives. `quick` implies a public room topped up with bots to a full table.
   */
  | { type: "hello"; name: string; v: number; resume?: string; pub?: boolean; quick?: boolean }
  /** keepalive + RTT probe; answered by the DO's auto-response without waking it */
  | { type: "ping" }
  | { type: "start"; settings: MatchSettings }
  | { type: "pos"; x: number; z: number; yaw: number; y?: number }
  | { type: "grab"; propId: number }
  | { type: "drop" }
  | { type: "throw"; dirX: number; dirZ: number; power: number }
  | { type: "stun" }
  | { type: "pickObject"; archetype: string; params: PropParams }
  | { type: "placeObject"; x: number; z: number }
  | { type: "setHue"; hue: number }
  | { type: "leave" };

// ---------- S2C ----------

export interface SnapshotPlayer {
  id: number;
  x: number;
  y: number; // jump height (0 = grounded)
  z: number;
  yaw: number;
  carry: number; // propId or -1
  stun: 0 | 1;
}

export interface SnapshotLoose {
  propId: number;
  x: number;
  y: number;
  z: number;
}

export type S2C =
  | {
      type: "welcome";
      playerId: number;
      seed: number;
      phase: PhaseName;
      players: PlayerInfo[];
      settings: MatchSettings;
      scores: Record<number, number>;
      totals: RoomTotals;
      /** opaque token — present it in `hello.resume` to reclaim this playerId */
      resume: string;
      /** room is listed on the public lobby browser */
      isPublic?: boolean;
      /** Cloudflare colo the room's DO landed in (latency diagnostics; may lag a wake) */
      colo?: string;
    }
  | { type: "pong" }
  | {
      type: "lobby";
      players: PlayerInfo[];
      settings: MatchSettings;
      totals: RoomTotals;
      /** quick-room auto-start deadline (server epoch ms); absent = no countdown */
      startsAt?: number;
    }
  | {
      type: "phase";
      name: PhaseName;
      endsAt: number; // server epoch ms; 0 = untimed
      round?: number;
      totalRounds?: number;
    }
  | { type: "reveal"; archetype: string; params: PropParams; name: string }
  | { type: "propAdded"; prop: NetProp; creatorId: number }
  | {
      type: "snapshot";
      t: number;
      players: SnapshotPlayer[];
      loose: SnapshotLoose[];
      scores: Record<number, number>;
    }
  | { type: "grabbed"; playerId: number; propId: number }
  | { type: "dropped"; propId: number; x: number; z: number; lockUntil: number; lockedFor: number }
  | { type: "thrown"; propId: number; byId: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  /**
   * A thrown prop came to rest at exactly (x,y,z) — the one authoritative
   * landing correction. Resting props are NOT streamed in snapshots (only
   * airborne ones are); this message plus `dropped` carry every final
   * position, and joins/reconnects get a replay for each displaced prop.
   */
  | { type: "rested"; propId: number; x: number; y: number; z: number }
  | { type: "stunned"; victimId: number; byId: number; until: number }
  | { type: "delivered"; byId: number; propId: number; points: number }
  | {
      type: "roundEnd";
      found: boolean;
      creatorId: number;
      creatorPoints: number;
      deliverer?: number;
      scores: Record<number, number>;
    }
  | { type: "matchEnd"; scores: Record<number, number>; totals: RoomTotals }
  | { type: "playerJoined"; player: PlayerInfo }
  | { type: "playerLeft"; playerId: number }
  | { type: "hueChanged"; playerId: number; hue: number }
  | { type: "err"; code: ErrCode };

export type ErrCode =
  | "full"
  | "version"
  | "taken"
  | "own"
  | "far"
  | "wrong" // grabbed a decoy / non-target object
  | "stunned"
  | "carrying"
  | "locked"
  | "not_host"
  | "bad_phase"
  | "bad_input"
  | "cooldown";

// ---------- Lobby HTTP API (GET /lobby) ----------
// Rides HTTP rather than the room socket, but it's still wire contract.

/** One row in GET /lobby — public rooms only. */
export interface LobbyRoomEntry {
  code: string;
  hostName: string;
  players: number;
  /** coarse room status; mid-match joiners spectate until the next game */
  status: "lobby" | "match";
}

export interface LobbyListResponse {
  rooms: LobbyRoomEntry[];
}

export function encode(msg: C2S | S2C): string {
  return JSON.stringify(msg);
}

export function decodeC2S(raw: string): C2S | null {
  return safeParse<C2S>(raw);
}

export function decodeS2C(raw: string): S2C | null {
  return safeParse<S2C>(raw);
}

function safeParse<T extends { type: string }>(raw: string): T | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") {
      return v as T;
    }
    return null;
  } catch {
    return null;
  }
}

/** Quantize a float to 2 decimals for snapshot payloads. */
export function q2(v: number): number {
  return Math.round(v * 100) / 100;
}
