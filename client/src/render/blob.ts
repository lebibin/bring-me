import * as THREE from "three";

/**
 * The "slop" — a smooth, featureless MECCHA CHAMELEON-style humanoid.
 * Heavily overlapped capsules so it reads as one seamless body. Each limb
 * hangs from a pivot Group placed AT its joint (shoulder/hip, sunk inside the
 * torso), so the walk cycle can swing pivot.rotation.x around the joint and
 * nothing ever floats. Group origin at the feet, ~1.6 m tall.
 */

export interface BlobParts {
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  /** torso + head, offset for the walk bob */
  body: THREE.Group;
}

export function buildBlob(hue: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL((((hue % 360) + 360) % 360) / 360, 0.18, 0.88),
    roughness: 0.45,
    metalness: 0.02,
  });

  /** Capsule hanging from a joint pivot, tilted angleZ radians outward. */
  const limb = (radius: number, length: number, ax: number, ay: number, angleZ: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(ax, ay, 0);
    pivot.rotation.z = angleZ;
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 14), mat);
    // sink the top tip slightly past the joint so it stays inside the body
    m.position.y = -(length / 2 + radius * 0.6);
    pivot.add(m);
    return pivot;
  };

  const body = new THREE.Group();
  // slimmer, longer torso with a higher crotch — closer to the MC reference,
  // where the legs are a good 40% of the height and the trunk isn't an egg
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.215, 0.44, 8, 18), mat);
  torso.position.y = 0.98; // spans ~0.55..1.41
  torso.scale.set(1.06, 1, 0.82);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.175, 20, 16), mat);
  head.position.y = 1.47; // slight neck indent against the shoulder curve
  body.add(torso, head);

  const legL = limb(0.105, 0.42, -0.1, 0.66, -0.045); // long thighs, near-touching
  const legR = limb(0.105, 0.42, 0.1, 0.66, 0.045);
  const armL = limb(0.082, 0.42, -0.175, 1.16, -0.09); // arms hug the slimmer trunk
  const armR = limb(0.082, 0.42, 0.175, 1.16, 0.09);

  g.add(body, legL, legR, armL, armR);
  const parts: BlobParts = { legL, legR, armL, armR, body };
  g.userData["parts"] = parts;
  return g;
}
