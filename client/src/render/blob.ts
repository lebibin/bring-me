import * as THREE from "three";

/**
 * The "slop" — a smooth MECCHA CHAMELEON-style humanoid, now a proper little
 * rig: head on a visible NECK, and two-segment arms (shoulder pivot → upper
 * arm → elbow pivot → forearm) so poses can bend like the reference art.
 * Pose code drives pivot rotations; nothing floats because every segment
 * hangs from its joint. Group origin at the feet, ~1.62 m tall.
 */

export interface BlobParts {
  legL: THREE.Group;
  legR: THREE.Group;
  /** shoulder pivots (rotate these for swings/holds/slaps) */
  armL: THREE.Group;
  armR: THREE.Group;
  /** elbow pivots nested inside the arms (bend for carry/rest poses) */
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  /** torso + neck + head, offset for the walk bob */
  body: THREE.Group;
}

export function buildBlob(hue: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL((((hue % 360) + 360) % 360) / 360, 0.18, 0.88),
    roughness: 0.45,
    metalness: 0.02,
  });

  /** single-segment limb hanging from a joint pivot (legs) */
  const limb = (radius: number, length: number, ax: number, ay: number, angleZ: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(ax, ay, 0);
    pivot.rotation.z = angleZ;
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 14), mat);
    m.position.y = -(length / 2 + radius * 0.6);
    pivot.add(m);
    return pivot;
  };

  /**
   * two-segment arm: shoulder pivot → upper arm → elbow pivot → forearm.
   * Matching radii + a filler sphere embedded AT each joint keep the surface
   * continuous through any bend — the rig exists, the seams don't.
   */
  const arm = (ax: number, ay: number, angleZ: number): { shoulder: THREE.Group; elbow: THREE.Group } => {
    const shoulder = new THREE.Group();
    shoulder.position.set(ax, ay, 0);
    shoulder.rotation.z = angleZ;
    // each capsule's round END CAP is centered on its joint pivot, so the cap
    // itself acts as the ball joint: bends stay smooth, no filler bulges
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.083, 0.22, 6, 14), mat);
    upper.position.y = -0.11; // top cap center ON the shoulder pivot
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.33; // at the upper arm's lower cap center
    elbow.rotation.x = -0.08; // arms hang nearly straight in the tutorial
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.079, 0.16, 6, 14), mat);
    fore.position.y = -0.08; // top cap center ON the elbow pivot
    elbow.add(fore);
    shoulder.add(elbow);
    return { shoulder, elbow };
  };

  // Proportions traced from the "How to draw MECCHA CHAMELEON" tutorial's
  // front view: head ~20% of height, NO neck (the head nestles into the
  // torso's narrowing top), slab trunk with hips as wide as the shoulders,
  // arms hanging flush along the body to crotch level, thick straight legs
  // split by a narrow notch.
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.4, 8, 18), mat);
  torso.position.y = 0.97; // spans ~0.59..1.35
  torso.scale.set(1.06, 1, 0.78);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 16), mat);
  head.scale.set(1.05, 1, 1);
  head.position.y = 1.44; // tucked into the torso cap — the pinch IS the neck
  body.add(torso, head);

  const legL = limb(0.12, 0.4, -0.11, 0.62, -0.02);
  const legR = limb(0.12, 0.4, 0.11, 0.62, 0.02);
  // arms sunk into the slab's sides — the intersection crease is the same
  // interior line the tutorial draws to separate arm from torso
  const armLrig = arm(-0.2, 1.21, -0.03);
  const armRrig = arm(0.2, 1.21, 0.03);

  g.add(body, legL, legR, armLrig.shoulder, armRrig.shoulder);
  const parts: BlobParts = {
    legL,
    legR,
    armL: armLrig.shoulder,
    armR: armRrig.shoulder,
    elbowL: armLrig.elbow,
    elbowR: armRrig.elbow,
    body,
  };
  g.userData["parts"] = parts;
  return g;
}
