export const PROTOCOL_VERSION = 2; // v2: PlayerInfo.hue + setHue/hueChanged

// --- Networking rates ---
export const TICK_HZ = 15;
export const TICK_MS = 1000 / TICK_HZ;
export const POS_SEND_HZ = 15;
// Remote-player render delay (jitter buffer): ~2.5 snapshot intervals. 100ms
// proved too tight over real internet — any jitter emptied the buffer and
// froze remotes between samples.
export const INTERP_DELAY_MS = 160;
// If the buffer still runs dry, extrapolate along the last velocity for at
// most this long instead of freezing in place.
export const INTERP_EXTRAP_MS = 120;

// Own-position reconciliation against server snapshots. The server's view
// lags by network latency + one report + one snapshot interval — at sprint
// speed over the internet that's easily 1-1.5 m, so the dead zone must sit
// WELL above it or every snapshot rubber-bands the local player ("stutter
// steps"). Movement is client-simulated anyway; this only needs to catch
// clamp/teleport-grade divergence.
export const OWN_POS_BLEND_DIST = 2.5;
export const OWN_POS_SNAP_DIST = 6;
export const OWN_POS_BLEND_RATE = 0.15; // per snapshot

// --- World ---
export const MAP_SIZE = 60; // meters, square, centered on origin
export const WALL_HEIGHT = 2.5;
export const SCATTER_CELL = 3; // jittered-grid cell size
export const SCATTER_FILL = 0.4; // spawn chance per cell
export const MIN_DECOYS_PER_ARCHETYPE = 3;
export const PLAZA_KEEPOUT = 8; // no scatter props within this radius of the plaza
export const SPAWN_KEEPOUT = 2;
export const SPAWN_RING_RADIUS = 7; // spawn points ring around the plaza
export const SPAWN_MIN_GAP = 1.2; // no two spawn points closer than this
export const MAX_PLAYERS = 10;
// Player-created props get ids at/above this; worldgen decoys count up from 0.
export const CREATED_PROP_ID_BASE = 100000;

// --- Movement ---
export const PLAYER_SPEED = 6; // m/s
export const CARRY_SPEED = 4.2; // m/s while carrying
export const PLAYER_RADIUS = 0.45;
// Jumping: v²/2g ≈ 0.97 m apex — clears every "standable" fixture top
// (bench/picnic/veggie/trampoline/car/doghouse) but not sheds or the house.
export const JUMP_VY = 5.9;
export const STEP_UP = 0.35; // max ledge you can walk up without jumping
// Server-side clamp slack on client-reported displacement.
export const SPEED_CLAMP_SLACK = 1.5;

// --- Actions ---
export const GRAB_RADIUS = 2;
export const NPC_RADIUS = 1.5; // delivery hit sphere
export const STUN_RANGE = 2.5;
export const STUN_DURATION_MS = 2000;
export const STUN_COOLDOWN_MS = 10000;
export const DROP_LOCK_MS = 1500; // stun victim can't re-grab their dropped prop

// --- Throwing ---
export const THROW_MIN_SPEED = 5; // m/s horizontal at power 0
export const THROW_MAX_SPEED = 14; // m/s horizontal at power 1
export const THROW_UP_RATIO = 0.5; // vy = horizontal speed * ratio
// Hold duration for full throw power. Must be comfortably longer than a
// natural press-aim-release (~1s), or every real throw saturates at max and
// the charge mechanic reads as "fixed distance".
export const THROW_HOLD_MS = 2200;
export const GRAVITY = 18; // m/s^2, gamey arc
export const PROP_REST_Y = 0.4; // resting height of a loose prop
export const CARRY_HEIGHT = 0.95; // carried prop rides at chest height...
// ...held out in front of the carrier — far enough that the biggest prop
// (basketball r 0.42 at max scale) clears the blob's torso and head
export const CARRY_FORWARD = 0.8;

// --- Scoring ---
// Dead simple, party-readable: bring someone's item to the NPC = 1 point;
// your own item surviving the whole round unfound = 2 points.
export const DELIVER_PTS = 1;
export const UNFOUND_PTS = 2;
export const ALLOW_SELF_GRAB = false; // creators may not grab their own object

// --- Match flow ---
export const MIN_PLAYERS = 3; // 2 allowed behind ?dev
export const CREATE_SECS_DEFAULT = 90;
export const CREATE_SECS_MIN = 30;
export const CREATE_SECS_MAX = 300;
export const ROUND_SECS_DEFAULT = 120;
export const ROUND_SECS_MIN = 30;
export const ROUND_SECS_MAX = 300;
export const COUNTDOWN_MS = 5000;
export const REVEAL_MS = 3000;
export const RESOLVE_MS = 5000;

// --- Quick game (one-click public match, topped up with bots) ---
// The room fills to this many players (humans + bots) and keeps that count
// until enough real players arrive to replace every bot.
export const QUICK_TARGET_PLAYERS = 5;
// Staggered, human-looking bot joins: one bot per alarm, spaced randomly.
export const QUICK_BOT_JOIN_MIN_MS = 1500;
export const QUICK_BOT_JOIN_MAX_MS = 5000;
// A bot yields its seat this long after a real player arrives (one at a time).
// Kept below the auto-start window so a human who joins a full room bumps a bot
// and gets to play THIS game rather than waiting for the next lobby.
export const QUICK_BOT_LEAVE_MIN_MS = 1500;
export const QUICK_BOT_LEAVE_MAX_MS = 3500;
// Lobby self-start countdown, armed once the quick room's table is full.
export const QUICK_AUTOSTART_MS = 5000;
// Snappier presets than the host defaults — "quick" should mean quick.
export const QUICK_CREATE_SECS = 60;
export const QUICK_ROUND_SECS = 90;

// --- Bot AI ---
export const BOT_DECISION_HZ = 4; // AI re-plans this often; movement is per-tick
export const BOT_REACT_MIN_MS = 1200; // post-reveal reaction delay (before skill scale)
export const BOT_REACT_MAX_MS = 4500;
export const BOT_SKILL_MIN = 0.45; // per-bot competence scalar (speed, aim, reaction)
export const BOT_SKILL_MAX = 0.9;
// Distance at which a bot considers throwing instead of walking the last stretch.
export const BOT_THROW_RANGE = 8;

// --- Public lobby / launch guardrails ---
export const LOBBY_LIST_MAX = 20; // rooms served by GET /lobby (client pings each)
export const LOBBY_POLL_MS = 5000; // browse-screen refresh
export const REGISTRY_STALE_MS = 10 * 60_000; // prune entries not seen for this long
export const REGISTRY_REFRESH_MS = 4 * 60_000; // occupied public rooms heartbeat via alarm
export const REGISTRY_MAX_ROOMS = 200; // hard cap on stored registry rows
// Per-socket inbound message budget: pos@15Hz + actions leaves headroom under
// the sustained rate; the burst absorbs a reconnect re-hello + catch-up.
export const WS_MSG_RATE = 25; // sustained msgs/sec/socket
export const WS_MSG_BURST = 60; // token-bucket capacity
export const WS_RATE_GRACE = 20; // dropped msgs tolerated before close 1008
export const RESUME_TOKENS_MAX = 64; // FIFO cap on stored resume tokens
