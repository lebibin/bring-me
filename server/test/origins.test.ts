import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/origins.ts";

const URL_PROD = "https://bringme.example.workers.dev/room/ABCDE";
const ITCH = "https://html-classic.itch.zone,https://html.itch.zone,*.itch.zone";

describe("originAllowed", () => {
  it("always allows same-host (production serves the client itself)", () => {
    expect(originAllowed("https://bringme.example.workers.dev", URL_PROD, "", false)).toBe(true);
  });

  it("always allows localhost dev origins, with or without a port", () => {
    expect(originAllowed("http://localhost:5175", URL_PROD, "", false)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5175", URL_PROD, "", false)).toBe(true);
    expect(originAllowed("https://localhost", URL_PROD, "", false)).toBe(true);
  });

  it("gates Origin-less requests on the flag (dev bots yes, production no)", () => {
    expect(originAllowed(null, URL_PROD, ITCH, true)).toBe(true);
    expect(originAllowed(null, URL_PROD, ITCH, false)).toBe(false);
  });

  it("matches exact allowlist entries", () => {
    expect(originAllowed("https://html-classic.itch.zone", URL_PROD, ITCH, false)).toBe(true);
    expect(originAllowed("https://html.itch.zone", URL_PROD, ITCH, false)).toBe(true);
    expect(originAllowed("https://evil.example.com", URL_PROD, ITCH, false)).toBe(false);
  });

  it("wildcard matches subdomains and the bare suffix, https only", () => {
    expect(originAllowed("https://v6p9d9t4.itch.zone", URL_PROD, ITCH, false)).toBe(true);
    expect(originAllowed("https://a.b.itch.zone", URL_PROD, ITCH, false)).toBe(true);
    expect(originAllowed("https://itch.zone", URL_PROD, ITCH, false)).toBe(true);
    expect(originAllowed("http://sub.itch.zone", URL_PROD, ITCH, false)).toBe(false);
  });

  it("wildcard is dot-anchored — lookalike domains never match", () => {
    expect(originAllowed("https://evilitch.zone", URL_PROD, ITCH, false)).toBe(false);
    expect(originAllowed("https://itch.zone.evil.com", URL_PROD, ITCH, false)).toBe(false);
  });

  it("rejects malformed Origins and empty allowlist entries", () => {
    expect(originAllowed("not a url", URL_PROD, ITCH, true)).toBe(false);
    expect(originAllowed("https://x.test", URL_PROD, ", ,", false)).toBe(false);
  });
});
