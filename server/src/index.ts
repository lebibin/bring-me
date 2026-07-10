// Bring Me room server — Cloudflare Worker entry.
// Routes /room/<CODE> to one BringMeRoom Durable Object per code
// (routing + origin allowlist adapted from salpakan/infra/signal/worker.js).

import { PROTOCOL_VERSION } from "@bringme/shared";
import { BringMeRoom } from "./room.ts";

export { BringMeRoom };

export interface Env {
  ROOM: DurableObjectNamespace;
}

// A browser page always sends an Origin. Non-browser tooling (test bots)
// sends none — allowed, rate limiting bounds abuse. A present Origin that is
// not same-host (the Worker serves the client itself) and not localhost is a
// cross-site WebSocket attempt and is rejected.
function originAllowed(origin: string | null, requestUrl: string): boolean {
  if (!origin) return true;
  try {
    if (new URL(origin).host === new URL(requestUrl).host) return true;
  } catch {
    return false;
  }
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const m = new URL(request.url).pathname.match(/^\/room\/([A-Z0-9]{1,12})$/);
    if (!m) return new Response(`bring me room server v${PROTOCOL_VERSION}`, { status: 200 });
    if (!originAllowed(request.headers.get("Origin"), request.url)) {
      return new Response("forbidden origin", { status: 403 });
    }
    const id = env.ROOM.idFromName(m[1]);
    return env.ROOM.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
