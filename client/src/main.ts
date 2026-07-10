import { Game } from "./game.ts";
import { attachInput } from "./ecs/input.ts";
import { installHook } from "./dev/hook.ts";
import { LobbyUI } from "./ui/lobby.ts";
import { NetClient } from "./net/client.ts";

const containerEl = document.getElementById("app");
if (!containerEl) throw new Error("missing #app");
const container: HTMLElement = containerEl;

document.getElementById("fsBtn")?.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});

let loopStarted = false;
function startLoop(game: Game): void {
  if (loopStarted) return;
  loopStarted = true;
  let last = performance.now();
  const loop = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.frame(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function wireInput(game: Game): void {
  attachInput(game.ctx.renderer.domElement, {
    onGrab: () => game.grab(),
    onDrop: () => game.drop(),
    onThrowRelease: (power) => game.throw(power),
    onFakeRound: () => game.startFakeRound(),
  });
}

function newCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}

// ---- routing: #/sandbox = local M0 sandbox, #/r/CODE = multiplayer room ----

const hashCode = location.hash.match(/^#\/r\/([A-Za-z0-9]{1,12})$/);

if (location.hash === "#/sandbox") {
  const game = new Game(container, 1234);
  wireInput(game);
  installHook(game);
  startLoop(game);
} else {
  const code = hashCode ? hashCode[1].toUpperCase() : null;
  let net: NetClient | null = null;

  const ui = new LobbyUI({
    onJoin: (name) => join(code ?? newCode(), name),
    onStart: (settings) => net?.start(settings),
  });

  function join(roomCode: string, name: string): void {
    if (!location.hash.startsWith("#/r/")) {
      history.replaceState(null, "", `${location.pathname}${location.search}#/r/${roomCode}`);
    }
    net = new NetClient(container, roomCode, name, ui, (game) => {
      // net mode: all outcome actions go through the server
      attachInput(game.ctx.renderer.domElement, {
        onGrab: () => net?.grabAction(),
        onDrop: () => net?.dropAction(),
        onThrowRelease: (power) => net?.throwAction(power),
        onFakeRound: () => {},
        onStun: () => net?.stunAction(),
        onPlace: () => net?.placeAction(),
      });
      installHook(game, net ?? undefined);
      startLoop(game);
    });
    net.connect();
  }

  ui.showLanding(code);
  // ?name=X auto-joins — used by the two-iframe test harness and bots
  const autoName = new URLSearchParams(location.search).get("name");
  if (autoName) join(code ?? newCode(), autoName);
}
