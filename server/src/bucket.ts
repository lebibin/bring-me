/**
 * Per-socket inbound token bucket — pure so vitest can drive it. room.ts owns
 * the WebSocket -> Bucket map and closes offenders.
 */

import { WS_MSG_BURST, WS_MSG_RATE, WS_RATE_GRACE } from "@bringme/shared";

export interface Bucket {
  tokens: number;
  last: number; // ms timestamp of the previous frame
  dropped: number;
}

export function newBucket(now: number): Bucket {
  return { tokens: WS_MSG_BURST, last: now, dropped: 0 };
}

/**
 * Spend one token for an inbound frame.
 * "ok" — within budget. "drop" — over rate, ignore the frame. "close" — kept
 * flooding past the grace allowance, hang up. Accepted frames slowly forgive
 * past drops so a one-off burst (throttled tab resuming) never accumulates
 * into a close, while a sustained flood outruns the forgiveness in under a
 * second.
 */
export function takeToken(b: Bucket, now: number): "ok" | "drop" | "close" {
  b.tokens = Math.min(WS_MSG_BURST, b.tokens + ((now - b.last) / 1000) * WS_MSG_RATE);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    if (b.dropped > 0) b.dropped--;
    return "ok";
  }
  b.dropped++;
  return b.dropped > WS_RATE_GRACE ? "close" : "drop";
}
