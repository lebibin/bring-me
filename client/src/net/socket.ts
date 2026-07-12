import { decodeS2C, encode, type C2S, type S2C } from "@bringme/shared";

export interface SocketHandlers {
  /** fires on every successful (re)connect — re-send `hello` here */
  onOpen(): void;
  onMsg(msg: S2C): void;
  /** the socket dropped; a redial is already scheduled (attempt starts at 1) */
  onReconnecting(attempt: number): void;
}

export function wsBase(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_WS_URL) return env.VITE_WS_URL;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "ws://127.0.0.1:8787";
  }
  // production: the Worker serves this very page, so the room socket lives on
  // the same origin — no config, no CORS
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

/** Same host resolution as wsBase, http(s) scheme — for /lobby and ping probes. */
export function httpBase(): string {
  // "ws://..." -> "http://...", "wss://..." -> "https://..."
  return wsBase().replace(/^ws/, "http");
}

/**
 * Room socket that survives the real internet: any close/error that we did
 * not ask for schedules a redial with jittered exponential backoff (0.8s ->
 * 10s cap, retrying for as long as the tab lives — the room itself expires
 * server-side). The NetClient re-hellos with its resume token on every
 * onOpen, so a blip costs seconds, not the match.
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempt = 0;
  private redialTimer = 0;

  constructor(
    private readonly code: string,
    private readonly handlers: SocketHandlers,
  ) {
    this.dial();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private dial(): void {
    const ws = new WebSocket(`${wsBase()}/room/${this.code}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.handlers.onOpen();
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      const msg = decodeS2C(ev.data);
      if (msg) this.handlers.onMsg(msg);
    });
    const drop = (): void => {
      if (this.ws !== ws) return; // superseded by a newer dial
      this.ws = null;
      if (this.closedByUs) return;
      this.attempt += 1;
      this.handlers.onReconnecting(this.attempt);
      const backoff = Math.min(10000, 800 * 2 ** Math.min(this.attempt - 1, 4));
      this.redialTimer = window.setTimeout(() => this.dial(), backoff + Math.random() * 300);
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  send(msg: C2S): void {
    if (this.isOpen) this.ws!.send(encode(msg));
  }

  close(): void {
    this.closedByUs = true;
    clearTimeout(this.redialTimer);
    this.ws?.close(1000, "bye");
  }
}
