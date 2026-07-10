import { decodeS2C, encode, type C2S, type S2C } from "@bringme/shared";

export interface SocketHandlers {
  onOpen(): void;
  onMsg(msg: S2C): void;
  onClose(): void;
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

export class RoomSocket {
  private readonly ws: WebSocket;
  private open = false;

  constructor(code: string, handlers: SocketHandlers) {
    this.ws = new WebSocket(`${wsBase()}/room/${code}`);
    this.ws.addEventListener("open", () => {
      this.open = true;
      handlers.onOpen();
    });
    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = decodeS2C(ev.data);
      if (msg) handlers.onMsg(msg);
    });
    this.ws.addEventListener("close", () => {
      this.open = false;
      handlers.onClose();
    });
    this.ws.addEventListener("error", () => {
      this.open = false;
      handlers.onClose();
    });
  }

  send(msg: C2S): void {
    if (this.open) this.ws.send(encode(msg));
  }

  close(): void {
    this.ws.close(1000, "bye");
  }
}
