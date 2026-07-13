// Bring Me room server — Cloudflare Worker entry.
//   /room/<CODE>       -> WebSocket upgrade to that code's BringMeRoom DO
//   /room/<CODE>/ping  -> 204 from the room DO (browse-screen latency probe)
//   /lobby             -> public-room list from the LobbyRegistry DO
// Origin gate + per-IP rate limits front every route; the DO stays trusting.

import { PROTOCOL_VERSION } from "@bringme/shared";
import { BringMeRoom } from "./room.ts";
import { LobbyRegistry } from "./registry.ts";
import { originAllowed } from "./origins.ts";
import { logError, logWarn } from "./log.ts";
import type { Env } from "./env.ts";

export { BringMeRoom, LobbyRegistry };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (e) {
      // explicit catch (never passThroughOnException): the failure is logged
      // with a stack and the client gets a clean 500 instead of a hang
      logError("fetch_failed", e, { path: new URL(request.url).pathname });
      return new Response("internal error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Cloudflare answers plain HTTP too unless the zone forces HTTPS — force
  // it in code so every attached domain behaves identically. Gated on
  // CANONICAL_HOST (production): wrangler dev and the bots stay on http/ws.
  if (env.CANONICAL_HOST && url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.href, 301);
  }
  const origin = request.headers.get("Origin");
  const originOk = originAllowed(
    origin,
    request.url,
    env.ALLOWED_ORIGINS ?? "",
    env.ALLOW_NO_ORIGIN !== "false",
  );
  // absent under `wrangler dev` — fall back so local bots never 429
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  // logged rejections: origin_rejected is THE signal when itch changes its
  // iframe host (players suddenly 403 — fix is an ALLOWED_ORIGINS redeploy)
  const reject = (event: string, status: number, body: string): Response => {
    logWarn(event, { path: url.pathname, origin, ip });
    return new Response(body, { status });
  };
  // Browsers do NOT send Origin on same-origin GETs, so the strict
  // no-Origin rejection (ALLOW_NO_ORIGIN=false in prod) only fits the
  // websocket upgrade, which always carries one. The list/ping GETs are
  // public read-only data — Origin-less is fine, the rate limiter bounds it.
  const readOk = originOk || origin === null;

  // Page loads on legacy hosts (bibin.dev, workers.dev) 301 to the canonical
  // domain — browsers carry the #/r/CODE fragment across the redirect, so old
  // invite links land in the right room. Only "/" redirects: /room/* sockets
  // (redirects would break them) and /lobby stay served on every host.
  if (url.pathname === "/" && request.method === "GET") {
    if (env.CANONICAL_HOST && url.host !== env.CANONICAL_HOST) {
      return Response.redirect(`https://${env.CANONICAL_HOST}/${url.search}`, 301);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    // dev (no assets configured): fall through to the version banner
  }

  if (url.pathname === "/lobby") {
    if (!readOk) return reject("origin_rejected", 403, "forbidden origin");
    if (!(await env.LOBBY_LIMITER.limit({ key: ip })).success) {
      return reject("rate_limited", 429, "rate limited");
    }
    const stub = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
    // always a fresh internal request — never forward the client's
    return withCors(await stub.fetch("https://registry/list"), origin);
  }

  const m = url.pathname.match(/^\/room\/([A-Z0-9]{1,12})(\/ping)?$/);
  if (!m) return new Response(`bring me room server v${PROTOCOL_VERSION}`, { status: 200 });

  // Hints only apply the first time a DO is created — this pins each room
  // near whoever touches its code first, instead of wherever Cloudflare's
  // default placement lands (which has put SEA-created rooms in the US:
  // ~200 ms pings for everyone in them, forever — DOs never migrate).
  const stub = env.ROOM.get(env.ROOM.idFromName(m[1]), roomLocation(request));
  if (m[2]) {
    if (!readOk) return reject("origin_rejected", 403, "forbidden origin");
    if (!(await env.LOBBY_LIMITER.limit({ key: ip })).success) {
      return reject("rate_limited", 429, "rate limited");
    }
    return withCors(await stub.fetch(request), origin);
  }

  if (!originOk) return reject("origin_rejected", 403, "forbidden origin");
  if (!(await env.ROOM_LIMITER.limit({ key: ip })).success) {
    return reject("rate_limited", 429, "rate limited");
  }
  // the room trusts X-Room-Code (it can't derive its code from its own id),
  // so overwrite it on a clone — a client-sent value must never get through
  const fwd = new Request(request);
  fwd.headers.set("X-Room-Code", m[1]);
  return stub.fetch(fwd);
}

/**
 * Durable Object placement hint from the request's geo data. Continent-level
 * is enough (DO hints are region-coarse anyway); NA splits on longitude since
 * it spans two hint regions. Undefined (unknown geo / wrangler dev) falls back
 * to Cloudflare's default placement.
 */
function roomLocation(request: Request): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  const cf = request.cf;
  if (!cf) return undefined;
  const hints: Record<string, DurableObjectLocationHint> = {
    AF: "afr",
    AS: "apac",
    EU: "weur",
    OC: "oc",
    SA: "sam",
  };
  const continent = typeof cf.continent === "string" ? cf.continent : "";
  let hint = hints[continent];
  if (continent === "NA") {
    hint = Number(cf.longitude) < -100 ? "wnam" : "enam";
  }
  return hint ? { locationHint: hint } : undefined;
}

/** Echo the (already-validated) Origin so the itch iframe can fetch cross-origin. */
function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.set("Vary", "Origin");
  return out;
}
