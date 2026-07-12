/**
 * Origin gate for every game-facing route. Pure so vitest can table-drive it.
 *
 * A browser page always sends an Origin; non-browser tooling (test bots)
 * sends none. Allowed: same-host (production serves the client itself),
 * localhost (dev), entries from the comma-separated allowlist (the itch.io
 * iframe origins), and Origin-less requests only when `allowNoOrigin` —
 * true in dev for the bots, false in production where the per-IP rate
 * limits are the real abuse bound.
 */
export function originAllowed(
  origin: string | null,
  requestUrl: string,
  allowed: string,
  allowNoOrigin: boolean,
): boolean {
  if (!origin) return allowNoOrigin;
  let host: string;
  let https: boolean;
  try {
    const u = new URL(origin);
    host = u.host;
    https = u.protocol === "https:";
    if (host === new URL(requestUrl).host) return true;
  } catch {
    return false;
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  for (const raw of allowed.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      // wildcard entries are https-only and suffix-anchored on a dot —
      // "*.itch.zone" matches html-classic.itch.zone, never evilitch.zone
      const suffix = entry.slice(2);
      if (https && (host === suffix || host.endsWith("." + suffix))) return true;
    } else if (origin === entry) {
      return true;
    }
  }
  return false;
}
