/** Thin DOM overlay: announce banner, center toast, throw charge bar. */

const banner = document.getElementById("banner") as HTMLDivElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const chargeWrap = document.getElementById("chargeWrap") as HTMLDivElement;
const chargeBar = document.getElementById("charge") as HTMLDivElement;

let toastTimer = 0;

export function announce(text: string, swatchHue?: number): void {
  banner.textContent = text;
  if (swatchHue !== undefined) {
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = `hsl(${swatchHue}, 70%, 55%)`;
    banner.appendChild(sw);
  }
  banner.style.display = "block";
}

export function clearAnnounce(): void {
  banner.style.display = "none";
}

/** Banner variant showing a picture of the target instead of its name. */
export function announceTarget(shot: HTMLCanvasElement): void {
  banner.textContent = "BRING ME ";
  shot.style.height = "104px";
  shot.style.width = "104px";
  shot.style.verticalAlign = "middle";
  shot.style.marginLeft = "16px";
  banner.appendChild(shot);
  banner.style.display = "block";
}

export function toast(text: string, ms = 2500): void {
  toastEl.textContent = text;
  toastEl.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.style.display = "none";
  }, ms);
}

export function setCharge(active: boolean, frac: number): void {
  chargeWrap.style.display = active ? "block" : "none";
  chargeBar.style.width = `${Math.round(frac * 100)}%`;
}

const timerEl = document.getElementById("timer") as HTMLDivElement;
const scoresEl = document.getElementById("scores") as HTMLDivElement;
const cooldownEl = document.getElementById("cooldown") as HTMLDivElement;

export function setTimer(secondsLeft: number | null): void {
  if (secondsLeft === null || secondsLeft < 0) {
    timerEl.style.display = "none";
    return;
  }
  timerEl.style.display = "block";
  const s = Math.max(0, Math.ceil(secondsLeft));
  timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function setScores(rows: { name: string; pts: number; me: boolean }[]): void {
  if (rows.length === 0) {
    scoresEl.style.display = "none";
    return;
  }
  scoresEl.style.display = "block";
  scoresEl.innerHTML = rows
    .map(
      (r) =>
        `<div class="row"><span>${r.me ? "<b>" : ""}${escapeHtml(r.name)}${r.me ? "</b>" : ""}</span><span>${Math.round(r.pts)}</span></div>`,
    )
    .join("");
}

export function setStunCooldown(secondsLeft: number | null): void {
  if (secondsLeft === null) {
    cooldownEl.style.display = "none";
    return;
  }
  cooldownEl.style.display = "block";
  if (secondsLeft <= 0) {
    cooldownEl.className = "hud ready";
    cooldownEl.textContent = "STUN READY (Q)";
  } else {
    cooldownEl.className = "hud";
    cooldownEl.textContent = `stun in ${Math.ceil(secondsLeft)}s`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
