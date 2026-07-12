/**
 * Browse-screen HTTP calls. Best-effort by design: a dead server or a rate
 * limit renders as an empty list / unknown latency, never an error state.
 */

import type { LobbyListResponse, LobbyRoomEntry } from "@bringme/shared";
import { httpBase } from "./socket.ts";

export async function fetchLobbyList(): Promise<LobbyRoomEntry[]> {
  try {
    const res = await fetch(`${httpBase()}/lobby`, { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as LobbyListResponse;
    return Array.isArray(body.rooms) ? body.rooms : [];
  } catch {
    return [];
  }
}

/**
 * Approximate join latency in ms, -1 if unreachable. Min of two sequential
 * probes — the first eats connection setup (and a hibernated room's wake),
 * the second is closest to real in-game RTT.
 */
export async function pingRoom(code: string): Promise<number> {
  let best = -1;
  for (let i = 0; i < 2; i++) {
    try {
      const t0 = performance.now();
      const res = await fetch(`${httpBase()}/room/${code}/ping`, { cache: "no-store" });
      if (!res.ok) return best;
      const dt = performance.now() - t0;
      best = best < 0 ? dt : Math.min(best, dt);
    } catch {
      return best;
    }
  }
  return best;
}
