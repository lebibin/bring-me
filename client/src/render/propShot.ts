/**
 * Product shots of catalog objects: a tiny offscreen WebGL renderer takes a
 * one-off picture of the exact target mesh (archetype + hue + scale) so the
 * jumbotron and HUD can show the real thing instead of a name + color hex.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
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
  // EXACTLY the world's grade (scene.ts) — a different tone map or hotter
  // lights here makes the jumbotron photo a different color than the object
  // players are hunting for
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();
  camera = new THREE.PerspectiveCamera(35, 1, 0.05, 30);
  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x777788, 0.55));
  const sun = new THREE.DirectionalLight(0xfff3da, 2.1);
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
