// Bring Me room server — Cloudflare Worker entry.
//   /room/<CODE>       -> WebSocket upgrade to that code's BringMeRoom DO
//   /room/<CODE>/ping  -> 204 from the room DO (browse-screen latency probe)
//   /lobby             -> public-room list from the LobbyRegistry DO
// Origin gate + per-IP rate limits front every route; the DO stays trusting.

import { PROTOCOL_VERSION } from "@bringme/shared";
import { BringMeRoom } from "./room.ts";
import { LobbyRegistry } from "./registry.ts";
import { originAllowed } from "./origins.ts";
import type { Env } from "./env.ts";

export { BringMeRoom, LobbyRegistry };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const originOk = originAllowed(
      origin,
      request.url,
      env.ALLOWED_ORIGINS ?? "",
      env.ALLOW_NO_ORIGIN !== "false",
    );
    // absent under `wrangler dev` — fall back so local bots never 429
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";

    if (url.pathname === "/lobby") {
      if (!originOk) return new Response("forbidden origin", { status: 403 });
      if (!(await env.LOBBY_LIMITER.limit({ key: ip })).success) {
        return new Response("rate limited", { status: 429 });
      }
      const stub = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
      // always a fresh internal request — never forward the client's
      return withCors(await stub.fetch("https://registry/list"), origin);
    }

    const m = url.pathname.match(/^\/room\/([A-Z0-9]{1,12})(\/ping)?$/);
    if (!m) return new Response(`bring me room server v${PROTOCOL_VERSION}`, { status: 200 });
    if (!originOk) return new Response("forbidden origin", { status: 403 });

    const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
    if (m[2]) {
      if (!(await env.LOBBY_LIMITER.limit({ key: ip })).success) {
        return new Response("rate limited", { status: 429 });
      }
      return withCors(await stub.fetch(request), origin);
    }

    if (!(await env.ROOM_LIMITER.limit({ key: ip })).success) {
      return new Response("rate limited", { status: 429 });
    }
    // the room trusts X-Room-Code (it can't derive its code from its own id),
    // so overwrite it on a clone — a client-sent value must never get through
    const fwd = new Request(request);
    fwd.headers.set("X-Room-Code", m[1]);
    return stub.fetch(fwd);
  },
} satisfies ExportedHandler<Env>;

/** Echo the (already-validated) Origin so the itch iframe can fetch cross-origin. */
function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.set("Vary", "Origin");
  return out;
}
