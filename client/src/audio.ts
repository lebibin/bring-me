/**
 * Slap sound effects (public/hits/1..18.ogg).
 *
 * Consistency contract: every client must play the SAME file for the same
 * stun, and a different one next time. The index is derived from the
 * `stunned` broadcast's `until` timestamp — a server-authored value that is
 * byte-identical on every client — so no extra protocol is needed. The
 * anti-repeat nudge also stays in lockstep because all clients see the same
 * event stream and therefore share the same "last played" value.
 */

const SLAP_COUNT = 18;
const pool: HTMLAudioElement[] = [];
let lastIndex = -1;

export function initSlapSounds(): void {
  if (pool.length > 0) return;
  for (let i = 1; i <= SLAP_COUNT; i++) {
    const a = new Audio(`/hits/${i}.ogg`);
    a.preload = "auto";
    a.volume = 0.75;
    pool.push(a);
  }
}

// Round SFX (public/sfx/*.ogg — synthesized, no external assets).
const SFX = {
  countdown: "/sfx/countdown.ogg",
  start: "/sfx/start.ogg",
  win: "/sfx/win.ogg",
} as const;
const sfxPool = new Map<keyof typeof SFX, HTMLAudioElement>();

export function playSound(name: keyof typeof SFX): void {
  let a = sfxPool.get(name);
  if (!a) {
    a = new Audio(SFX[name]);
    a.preload = "auto";
    a.volume = 0.6;
    sfxPool.set(name, a);
  }
  a.currentTime = 0;
  void a.play().catch(() => {
    /* autoplay policy before first user gesture — fine to stay silent */
  });
}

/** Play the slap for a stun event, keyed by the shared server timestamp. */
export function playSlapSound(eventKey: number): void {
  initSlapSounds();
  let idx = Math.abs(Math.floor(eventKey)) % SLAP_COUNT;
  if (idx === lastIndex) idx = (idx + 1) % SLAP_COUNT; // never the same twice in a row
  lastIndex = idx;
  const a = pool[idx];
  a.currentTime = 0;
  void a.play().catch(() => {
    /* autoplay policy before first user gesture — fine to stay silent */
  });
}
