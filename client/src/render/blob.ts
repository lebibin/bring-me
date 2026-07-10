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

  /** two-segment arm: shoulder pivot → upper arm → elbow pivot → forearm */
  const arm = (ax: number, ay: number, angleZ: number): { shoulder: THREE.Group; elbow: THREE.Group } => {
    const shoulder = new THREE.Group();
    shoulder.position.set(ax, ay, 0);
    shoulder.rotation.z = angleZ;
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.2, 6, 14), mat);
    upper.position.y = -0.143; // top tip sunk into the shoulder
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.27; // at the lower end of the upper arm
    elbow.rotation.x = -0.18; // relaxed natural bend
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.18, 6, 14), mat);
    fore.position.y = -0.125;
    elbow.add(fore);
    shoulder.add(elbow);
    return { shoulder, elbow };
  };

  const body = new THREE.Group();
  // slim trunk: shoulders at ~1.32, crotch at ~0.56
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.195, 0.38, 8, 18), mat);
  torso.position.y = 0.94;
  torso.scale.set(1.05, 1, 0.8);
  // the visible neck the reference has (and we didn't)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.075, 0.16, 10), mat);
  neck.position.y = 1.36;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 20, 16), mat);
  head.scale.y = 1.05;
  head.position.y = 1.53;
  body.add(torso, neck, head);

  const legL = limb(0.1, 0.44, -0.095, 0.68, -0.045);
  const legR = limb(0.1, 0.44, 0.095, 0.68, 0.045);
  // anchors tucked into the torso's shoulder curve so the upper arms merge
  // with the body instead of floating beside it
  const armLrig = arm(-0.16, 1.22, -0.12);
  const armRrig = arm(0.16, 1.22, 0.12);

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
