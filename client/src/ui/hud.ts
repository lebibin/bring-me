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
  banner.textContent = "";
  banner.appendChild(wordmark(72));
  shot.style.height = "104px";
  shot.style.width = "104px";
  shot.style.verticalAlign = "middle";
  shot.style.marginLeft = "16px";
  banner.appendChild(shot);
  banner.style.display = "block";
}

/** The logo image, used wherever the game used to shout its own name. */
function wordmark(heightPx: number): HTMLImageElement {
  const img = document.createElement("img");
  img.src = "/logo.png";
  img.alt = "BRING ME!";
  img.style.height = `${heightPx}px`;
  img.style.verticalAlign = "middle";
  return img;
}

export function toast(text: string, ms = 2500): void {
  toastEl.textContent = text;
  toastEl.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.style.display = "none";
  }, ms);
}

/** Center toast showing the logo instead of text. */
export function toastLogo(ms = 2500): void {
  toastEl.textContent = "";
  toastEl.appendChild(wordmark(120));
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
    layoutCreditsBtn();
    return;
  }
  cooldownEl.style.display = "block";
  layoutCreditsBtn();
  if (secondsLeft <= 0) {
    cooldownEl.className = "hud ready";
    cooldownEl.textContent = "STUN READY (Q)";
  } else {
    cooldownEl.className = "hud";
    cooldownEl.textContent = `stun in ${Math.ceil(secondsLeft)}s`;
  }
}

const netEl = document.getElementById("netInd") as HTMLDivElement;
const creditsBtnEl = document.getElementById("creditsBtn") as HTMLButtonElement;

/**
 * Signal-bars latency meter: 4 green bars on a snappy link, fewer/warmer as
 * RTT climbs, 0 bars + blink while reconnecting (rtt = -1). null hides it
 * (sandbox / not yet connected).
 */
/** Stack the "?" button above whichever bottom-right widgets are visible. */
function layoutCreditsBtn(): void {
  const net = netEl.style.display !== "none";
  const cd = cooldownEl.style.display !== "none";
  creditsBtnEl.classList.toggle("raised", net && !cd);
  creditsBtnEl.classList.toggle("raised2", net && cd);
}

/** Diagnostics: which Cloudflare colo the room lives in — shown on meter hover. */
export function setRoomColo(colo: string): void {
  netEl.title = colo ? `room server: ${colo}` : "";
}

export function setPing(rtt: number | null): void {
  if (rtt === null) {
    netEl.style.display = "none";
    layoutCreditsBtn();
    return;
  }
  netEl.style.display = "flex";
  layoutCreditsBtn();
  const bars = netEl.querySelectorAll<HTMLSpanElement>(".b");
  const msEl = netEl.querySelector<HTMLSpanElement>(".ms");
  if (!msEl) return;
  if (rtt < 0) {
    netEl.classList.add("down");
    bars.forEach((b) => (b.className = "b"));
    msEl.textContent = "…";
    return;
  }
  netEl.classList.remove("down");
  const lit = rtt < 90 ? 4 : rtt < 170 ? 3 : rtt < 280 ? 2 : 1;
  const tone = lit >= 3 ? "good" : lit === 2 ? "mid" : "bad";
  bars.forEach((b, i) => (b.className = i < lit ? `b on ${tone}` : "b"));
  msEl.textContent = `${Math.round(Math.min(rtt, 999))}ms`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
