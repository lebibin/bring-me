export const PROTOCOL_VERSION = 1;

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
export const MAX_PLAYERS = 8;
// Player-created props get ids at/above this; worldgen decoys count up from 0.
export const CREATED_PROP_ID_BASE = 100000;

// --- Movement ---
export const PLAYER_SPEED = 6; // m/s
export const CARRY_SPEED = 4.2; // m/s while carrying
export const PLAYER_RADIUS = 0.45;
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
export const CARRY_FORWARD = 0.55; // ...held out in front of the carrier

// --- Scoring (tunables) ---
// Creator accrual while object is in someone's view unseen. Kept low relative
// to DELIVER_PTS: a full round of hiding in plain sight ≈ half a delivery,
// ×2 unfound ≈ one delivery. (5/s playtested as way too hot: 214 pts/round.)
export const LOS_PTS_PER_SEC = 1;
export const LOS_RANGE = 15;
export const LOS_HALF_ANGLE = Math.PI / 4; // +/- 45deg of viewer yaw
export const UNFOUND_MULT = 2; // creator accrual multiplier when round times out unfound
export const DELIVER_PTS = 100; // fixed delivery award (default mode)
export const DELIVER_MULT = 1.25; // alternative: multiply deliverer's score instead
export const USE_DELIVER_MULT = false;
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
