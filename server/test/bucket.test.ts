import { describe, expect, it } from "vitest";
import { WS_MSG_BURST, WS_MSG_RATE, WS_RATE_GRACE } from "@bringme/shared";
import { newBucket, takeToken } from "../src/bucket.ts";

const T0 = 1_000_000;

describe("per-socket token bucket", () => {
  it("passes a legit client (pos@15Hz + pings) indefinitely", () => {
    const b = newBucket(T0);
    // 20 msgs/sec for 30 simulated seconds — under WS_MSG_RATE
    for (let i = 0; i < 600; i++) {
      expect(takeToken(b, T0 + i * 50)).toBe("ok");
    }
  });

  it("absorbs a full burst at t=0, then starts dropping", () => {
    const b = newBucket(T0);
    for (let i = 0; i < WS_MSG_BURST; i++) {
      expect(takeToken(b, T0)).toBe("ok");
    }
    expect(takeToken(b, T0)).toBe("drop");
  });

  it("closes a sustained flood within the grace allowance", () => {
    const b = newBucket(T0);
    let closed = 0;
    // 1000 frames in one instant: burst passes, then drops, then close
    for (let i = 0; i < 1000; i++) {
      if (takeToken(b, T0) === "close") closed++;
    }
    expect(closed).toBeGreaterThan(0);
    // the close verdict lands right after the grace runs out
    expect(closed).toBe(1000 - WS_MSG_BURST - WS_RATE_GRACE);
  });

  it("refills at WS_MSG_RATE while idle, capped at the burst size", () => {
    const b = newBucket(T0);
    for (let i = 0; i < WS_MSG_BURST; i++) takeToken(b, T0);
    // 1 second idle -> WS_MSG_RATE tokens back
    for (let i = 0; i < WS_MSG_RATE; i++) {
      expect(takeToken(b, T0 + 1000)).toBe("ok");
    }
    expect(takeToken(b, T0 + 1000)).toBe("drop");
    // long idle refills to the cap, not beyond
    for (let i = 0; i < WS_MSG_BURST; i++) {
      expect(takeToken(b, T0 + 60_000)).toBe("ok");
    }
    expect(takeToken(b, T0 + 60_000)).toBe("drop");
  });

  it("forgives sporadic drops so a throttled tab's resume flush never accumulates into a close", () => {
    const b = newBucket(T0);
    let t = T0;
    for (let round = 0; round < 10; round++) {
      // burst past the bucket -> a few drops...
      for (let i = 0; i < WS_MSG_BURST + 5; i++) takeToken(b, t);
      // ...then a normal minute at 10 msgs/sec forgives them
      for (let i = 0; i < 600; i++) {
        t += 100;
        takeToken(b, t);
      }
      t += 1000;
    }
    // after ten such cycles a fresh burst still only drops, never closes
    for (let i = 0; i < WS_MSG_BURST + 5; i++) {
      expect(takeToken(b, t)).not.toBe("close");
    }
  });
});
