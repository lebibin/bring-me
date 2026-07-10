/**
 * Client half of the catalog: builds a low-poly primitive mesh for each
 * archetype id defined in shared/catalog.ts. Everything is flat-shaded
 * MeshStandardMaterial — no textures, no imported assets.
 */

import * as THREE from "three";
import { ARCHETYPES } from "@bringme/shared";

function mat(hue: number, sat = 0.65, light = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL((((hue % 360) + 360) % 360) / 360, sat, light),
    flatShading: true,
    roughness: 0.85,
  });
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geo, m);
}

/** Each builder returns a group roughly 0.6-0.9 m, centered near the origin. */
const builders: Record<string, (hue: number) => THREE.Group> = {
  umbrella(hue) {
    const g = new THREE.Group();
    const canopy = mesh(new THREE.ConeGeometry(0.42, 0.26, 9), mat(hue));
    canopy.position.y = 0.22;
    const shaft = mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.62, 6), mat(0, 0, 0.3));
    shaft.position.y = -0.05;
    const tip = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.1, 5), mat(0, 0, 0.35));
    tip.position.y = 0.42;
    g.add(canopy, shaft, tip);
    return g;
  },
  ball(hue) {
    const g = new THREE.Group();
    const b = mesh(new THREE.SphereGeometry(0.3, 10, 8), mat(hue));
    const band = mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 14), mat(hue + 180, 0.5, 0.75));
    band.rotation.x = Math.PI / 2;
    g.add(b, band);
    return g;
  },
  duck(hue) {
    const g = new THREE.Group();
    const body = mesh(new THREE.SphereGeometry(0.26, 9, 7), mat(hue));
    body.scale.set(1.05, 0.85, 1.2);
    const head = mesh(new THREE.SphereGeometry(0.15, 8, 7), mat(hue));
    head.position.set(0, 0.22, 0.18);
    const beak = mesh(new THREE.ConeGeometry(0.06, 0.14, 6), mat(25, 0.9, 0.55));
    beak.position.set(0, 0.2, 0.34);
    beak.rotation.x = Math.PI / 2;
    g.add(body, head, beak);
    return g;
  },
  cone(hue) {
    const g = new THREE.Group();
    const body = mesh(new THREE.ConeGeometry(0.2, 0.52, 9), mat(hue));
    body.position.y = 0.06;
    const stripe = mesh(new THREE.CylinderGeometry(0.135, 0.16, 0.09, 9), mat(0, 0, 0.92));
    stripe.position.y = 0.06;
    const base = mesh(new THREE.BoxGeometry(0.4, 0.05, 0.4), mat(hue));
    base.position.y = -0.22;
    g.add(body, stripe, base);
    return g;
  },
  boot(hue) {
    const g = new THREE.Group();
    const shaft = mesh(new THREE.BoxGeometry(0.2, 0.4, 0.22), mat(hue));
    shaft.position.set(0, 0.05, -0.1);
    const foot = mesh(new THREE.BoxGeometry(0.2, 0.16, 0.44), mat(hue));
    foot.position.set(0, -0.17, 0.05);
    const sole = mesh(new THREE.BoxGeometry(0.22, 0.05, 0.46), mat(0, 0, 0.25));
    sole.position.set(0, -0.27, 0.05);
    g.add(shaft, foot, sole);
    return g;
  },
  basketball(hue) {
    const g = new THREE.Group();
    const b = mesh(new THREE.SphereGeometry(0.3, 12, 10), mat(hue, 0.8, 0.5));
    const seamMat = mat(0, 0, 0.12);
    for (const rx of [0, Math.PI / 2]) {
      const seam = mesh(new THREE.TorusGeometry(0.3, 0.012, 5, 20), seamMat);
      seam.rotation.x = rx;
      g.add(seam);
    }
    const eq = mesh(new THREE.TorusGeometry(0.3, 0.012, 5, 20), seamMat);
    eq.rotation.x = Math.PI / 2;
    eq.rotation.y = Math.PI / 2;
    g.add(b, eq);
    return g;
  },
  wateringcan(hue) {
    const g = new THREE.Group();
    const body = mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.36, 10), mat(hue));
    const spout = mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.4, 6), mat(hue));
    spout.position.set(0.28, 0.08, 0);
    spout.rotation.z = -0.9;
    const nose = mesh(new THREE.CylinderGeometry(0.08, 0.05, 0.05, 8), mat(hue));
    nose.position.set(0.42, 0.22, 0);
    nose.rotation.z = -0.9;
    const handle = mesh(new THREE.TorusGeometry(0.13, 0.025, 6, 12, Math.PI), mat(hue));
    handle.position.set(-0.16, 0.14, 0);
    handle.rotation.z = -0.4;
    g.add(body, spout, nose, handle);
    return g;
  },
  flowerpot(hue) {
    const g = new THREE.Group();
    const pot = mesh(new THREE.CylinderGeometry(0.18, 0.13, 0.24, 10), mat(hue, 0.6, 0.45));
    pot.position.y = -0.12;
    const rim = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 10), mat(hue, 0.6, 0.45));
    rim.position.y = 0.02;
    const bush = mesh(new THREE.SphereGeometry(0.16, 9, 7), mat(115, 0.5, 0.35));
    bush.position.y = 0.16;
    const bloom = mesh(new THREE.SphereGeometry(0.06, 7, 6), mat(hue + 150, 0.8, 0.6));
    bloom.position.set(0.04, 0.28, 0.04);
    g.add(pot, rim, bush, bloom);
    return g;
  },
  gnome(hue) {
    const g = new THREE.Group();
    const body = mesh(new THREE.ConeGeometry(0.17, 0.34, 10), mat(215, 0.5, 0.45));
    body.position.y = -0.13;
    const head = mesh(new THREE.SphereGeometry(0.1, 10, 8), mat(30, 0.5, 0.8));
    head.position.y = 0.1;
    const beard = mesh(new THREE.ConeGeometry(0.09, 0.16, 8), mat(0, 0, 0.92));
    beard.position.set(0, 0.0, 0.05);
    const hat = mesh(new THREE.ConeGeometry(0.11, 0.3, 9), mat(hue, 0.75, 0.5));
    hat.position.y = 0.3;
    g.add(body, head, beard, hat);
    return g;
  },
  frisbee(hue) {
    const g = new THREE.Group();
    const disc = mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.06, 16), mat(hue, 0.75, 0.55));
    const dome = mesh(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI / 3), mat(hue, 0.75, 0.62));
    dome.position.y = -0.02;
    g.add(disc, dome);
    return g;
  },
};

export function buildPropMesh(archetype: number, hue: number, scale: number): THREE.Group {
  const arch = ARCHETYPES[archetype];
  const builder = arch ? builders[arch.id] : undefined;
  const g = builder ? builder(hue) : new THREE.Group();
  g.scale.setScalar(scale);
  return g;
}
