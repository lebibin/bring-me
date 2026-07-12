/**
 * LobbyRegistry — a single Durable Object (idFromName("lobby")) holding the
 * public-room list. Rooms push their row via the LOBBY binding; binding stubs
 * are unreachable from the public internet, so registrations can't be spoofed.
 * The Worker's GET /lobby is hard-coded to /list — the only public surface.
 *
 * Liveness: rooms upsert on membership/status changes plus a periodic
 * heartbeat; /list lazily prunes rows not seen for REGISTRY_STALE_MS, so no
 * registry-side alarm is needed (the client poll guarantees reads).
 */

import {
  LOBBY_LIST_MAX,
  MAX_PLAYERS,
  REGISTRY_MAX_ROOMS,
  REGISTRY_STALE_MS,
  type LobbyListResponse,
  type LobbyRoomEntry,
} from "@bringme/shared";

const CODE_RE = /^[A-Z0-9]{1,12}$/;

export class LobbyRegistry {
  constructor(private readonly state: DurableObjectState) {
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        players INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/list") return this.list();
    if (request.method === "POST" && path === "/upsert") return this.upsert(request);
    if (request.method === "POST" && path === "/remove") return this.remove(request);
    return new Response("not found", { status: 404 });
  }

  private list(): Response {
    const sql = this.state.storage.sql;
    sql.exec("DELETE FROM rooms WHERE last_seen < ?", Date.now() - REGISTRY_STALE_MS);
    const rows = sql
      .exec(
        `SELECT code, host_name, players, status FROM rooms
         ORDER BY (status = 'lobby') DESC, last_seen DESC LIMIT ?`,
        LOBBY_LIST_MAX,
      )
      .toArray();
    const rooms: LobbyRoomEntry[] = rows.map((r) => ({
      code: String(r["code"]),
      hostName: String(r["host_name"]),
      players: Number(r["players"]),
      status: r["status"] === "match" ? "match" : "lobby",
    }));
    return Response.json({ rooms } satisfies LobbyListResponse);
  }

  private async upsert(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof body?.["code"] === "string" ? body["code"] : "";
    if (!CODE_RE.test(code)) return new Response("bad code", { status: 400 });
    // never trust the payload's strings/numbers, even from rooms — re-clamp
    // exactly like room.ts sanitizes names on join
    const hostName = String(body?.["hostName"] ?? "").trim().slice(0, 16) || "slop";
    const rawPlayers = Number(body?.["players"]);
    const players = Number.isFinite(rawPlayers)
      ? Math.min(MAX_PLAYERS, Math.max(0, Math.round(rawPlayers)))
      : 0;
    const status = body?.["status"] === "match" ? "match" : "lobby";
    const sql = this.state.storage.sql;
    const exists = sql.exec("SELECT 1 FROM rooms WHERE code = ?", code).toArray().length > 0;
    if (!exists) {
      const count = Number(sql.exec("SELECT COUNT(*) AS n FROM rooms").one()["n"]);
      if (count >= REGISTRY_MAX_ROOMS) return new Response("registry full", { status: 503 });
    }
    sql.exec(
      `INSERT INTO rooms (code, host_name, players, status, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         host_name = excluded.host_name, players = excluded.players,
         status = excluded.status, last_seen = excluded.last_seen`,
      code,
      hostName,
      players,
      status,
      Date.now(),
    );
    return new Response(null, { status: 204 });
  }

  private async remove(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof body?.["code"] === "string" ? body["code"] : "";
    if (!CODE_RE.test(code)) return new Response("bad code", { status: 400 });
    this.state.storage.sql.exec("DELETE FROM rooms WHERE code = ?", code);
    return new Response(null, { status: 204 });
  }
}
