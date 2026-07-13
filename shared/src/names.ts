/**
 * Display-name pool, shared by client and server. The client draws from it to
 * name a player who never typed one; the server names its quick-game bots from
 * the SAME pool, so a bot's name is statistically indistinguishable from a real
 * player's auto-name. Deliberately no "bot/ai/cpu/npc"-shaped entries, no
 * uniform capitalization, everything <= 16 chars (the server's name clamp).
 */

import { randInt, type Rng } from "./rng.ts";

export const NAME_POOL: readonly string[] = [
  // plain first names, mixed casing
  "maya", "Jordan", "kiko", "sofie", "Rohan", "ella", "Ben", "noa",
  "priya", "Diego", "mika", "Sam", "yuki", "Amara", "leo", "Nina",
  "tariq", "Chloe", "hana", "Marco", "zoe", "Ravi", "iris", "Theo",
  "lena", "Kai", "omar", "Freya", "juno", "Dani", "esra", "Milo",
  "aria", "Nikhil", "cleo", "Bea", "otis", "Suki", "remy", "Vera",
  // casual handles / gamer tags
  "notlucas", "mika_p", "dex", "jm2", "karlaaa", "ben10x", "pogiboy",
  "quietstorm", "toffee", "greg.exe", "l0la", "mvp_ren", "sn4cks",
  "haloween", "biggie_s", "penny4", "voidcat", "tofuboy", "mango",
  "z3ke", "clumsyfox", "roro", "8bitbea", "sundae", "wispr", "kb",
  "gigi_x", "tinyrick", "drowsy", "pechay", "kwek", "hoshi", "nate2k",
  "waffles", "orbit", "moony", "fig", "sabo", "junk_id", "pluto",
  "melon", "clank", "rue", "dvsn", "pilo", "spudz", "echo7", "nara",
];

/**
 * A name not already in `exclude` (a lowercase set of names in the room). Falls
 * back to a suffixed variant if the pool is somehow exhausted so it always
 * returns something distinct.
 */
export function randomName(rng: Rng, exclude: ReadonlySet<string> = new Set()): string {
  const start = randInt(rng, 0, NAME_POOL.length);
  for (let i = 0; i < NAME_POOL.length; i++) {
    const cand = NAME_POOL[(start + i) % NAME_POOL.length];
    if (!exclude.has(cand.toLowerCase())) return cand;
  }
  // pool exhausted (>~90 in one room, impossible with MAX_PLAYERS) — suffix
  for (let n = 2; ; n++) {
    const cand = `${NAME_POOL[start]}${n}`.slice(0, 16);
    if (!exclude.has(cand.toLowerCase())) return cand;
  }
}
