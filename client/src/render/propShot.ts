/**
 * Product shots of catalog objects: a tiny offscreen WebGL renderer takes a
 * one-off picture of the exact target mesh (archetype + hue + scale) so the
 * jumbotron and HUD can show the real thing instead of a name + color hex.
 */

import * as THREE from "three";
import { buildPropMesh } from "./propMeshes.ts";

const SIZE = 200;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function ensure(): void {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x000000, 0); // transparent background
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.05, 30);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x778, 1.5));
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.9);
  sun.position.set(2, 3, 2.5);
  scene.add(sun);
}

/** Render the object and return the picture as a standalone 2D canvas. */
export function snapshotProp(archetype: number, hue: number, scale: number): HTMLCanvasElement {
  ensure();
  const mesh = buildPropMesh(archetype, hue, scale);
  scene!.add(mesh);
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const dist = (box.getSize(new THREE.Vector3()).length() || 1) * 1.4;
  camera!.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.85);
  camera!.lookAt(center);
  renderer!.render(scene!, camera!);
  scene!.remove(mesh);

  const out = document.createElement("canvas");
  out.width = SIZE;
  out.height = SIZE;
  out.getContext("2d")!.drawImage(renderer!.domElement, 0, 0);
  return out;
}
