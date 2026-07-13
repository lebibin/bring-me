/**
 * Structured JSON logging for Workers Logs (observability in wrangler.toml).
 * One line per event with `event` as the queryable key — filter in the
 * dashboard, e.g. `event = "match_started"` or `level = "error"`.
 *
 * Discipline: log LIFECYCLE and ANOMALIES only — joins, phase transitions,
 * rejections, upstream failures. Never log per-tick / per-pos traffic (15 Hz
 * per room would drown everything else and burn the logs quota).
 */

export function logInfo(event: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Expected-but-noteworthy: rejections, rate limits, retriable failures. */
export function logWarn(event: string, fields?: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/** console.error surfaces at error severity in the dashboard (alertable). */
export function logError(event: string, error: unknown, fields?: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      ...fields,
    }),
  );
}
