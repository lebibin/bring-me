/**
 * Worker environment bindings — its own module so both index.ts and the
 * Durable Objects can import the type without an import cycle.
 */

/** Workers Rate Limiting binding (open beta; declared in wrangler.toml [[unsafe.bindings]]). */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  /** comma-separated extra Origins (exact `https://host` or wildcard `*.suffix`) */
  ALLOWED_ORIGINS?: string;
  /** page loads on other hosts 301 here; unset (dev) = no redirect */
  CANONICAL_HOST?: string;
  /** static-asset binding; only exists where assets are configured (production) */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** "false" rejects Origin-less requests (production); anything else allows them (dev bots) */
  ALLOW_NO_ORIGIN?: string;
  /** per-IP WebSocket upgrades */
  ROOM_LIMITER: RateLimit;
  /** per-IP lobby list + latency pings */
  LOBBY_LIMITER: RateLimit;
}
