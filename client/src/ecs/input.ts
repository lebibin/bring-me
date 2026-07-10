/**
 * Input as data: systems read this singleton, they never touch the DOM.
 * The __bringme test hook writes the same fields for deterministic headless
 * stepping, so DOM listeners and tests drive the sim identically.
 */

export interface InputState {
  forward: number; // -1..1 (W/S)
  strafe: number; // -1..1 (D/A)
  camYaw: number; // heading the camera (and W) points at
  camPitch: number;
  charging: boolean;
  throwCharge: number; // 0..1, accumulated in game.step while charging
}

export const input: InputState = {
  forward: 0,
  strafe: 0,
  camYaw: 0,
  camPitch: 0.4,
  charging: false,
  throwCharge: 0,
};

export interface InputCallbacks {
  onGrab: () => void;
  onDrop: () => void;
  onThrowRelease: (power: number) => void;
  onFakeRound: () => void;
  onStun?: () => void;
  onPlace?: () => void;
}

const keys = new Set<string>();

export function attachInput(canvas: HTMLCanvasElement, cb: InputCallbacks): void {
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === "KeyE") cb.onGrab();
    if (e.code === "KeyG") cb.onDrop();
    if (e.code === "KeyT") cb.onFakeRound();
    if (e.code === "KeyQ") cb.onStun?.();
    if (e.code === "KeyP") cb.onPlace?.();
    if (e.code === "KeyF") {
      input.charging = true;
      input.throwCharge = 0;
    }
    updateAxes();
  });
  window.addEventListener("keyup", (e) => {
    keys.delete(e.code);
    if (e.code === "KeyF" && input.charging) {
      input.charging = false;
      cb.onThrowRelease(input.throwCharge);
      input.throwCharge = 0;
    }
    updateAxes();
  });
  window.addEventListener("blur", () => {
    keys.clear();
    updateAxes();
  });

  // no browser context menu inside the game
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  let dragging = false;
  canvas.addEventListener("mousedown", () => {
    dragging = true;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    input.camYaw -= e.movementX * 0.005;
    input.camPitch = Math.min(1.2, Math.max(0.12, input.camPitch + e.movementY * 0.004));
  });
}

function updateAxes(): void {
  input.forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  input.strafe = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
}
