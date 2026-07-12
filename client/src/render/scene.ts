import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MAP_SIZE, type RectZone, type World } from "@bringme/shared";

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** draw one presented frame — through the post chain unless ?fx=0 */
  render(): void;
}

const HALF = MAP_SIZE / 2;

export function createScene(container: HTMLElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // color-preserving tone mapping (ACES washed the stylized palette) + soft
  // shadows: most of the perceived-quality jump
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc3e8);
  scene.fog = new THREE.Fog(0x8fc3e8, 34, 85);
  // image-based fill light so materials pick up sky/bounce color, not just
  // two analytic lights (the reason everything used to look chalky)
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 6, -8);

  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x5c7a45, 0.5));
  const sun = new THREE.DirectionalLight(0xfff3da, 2.1);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -44;
  sun.shadow.camera.right = 44;
  sun.shadow.camera.top = 44;
  sun.shadow.camera.bottom = -44;
  sun.shadow.camera.near = 5;
  sun.shadow.camera.far = 90;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04; // world units — big values erase small-object shadows
  scene.add(sun);

  // post chain: ambient occlusion grounds objects, a whisper of bloom makes
  // the jumbotron and highlights glow. OFF by default (perf headroom for the
  // party crowd) — opt in with ?fx=1.
  const fxOn = new URLSearchParams(location.search).get("fx") === "1";
  let composer: EffectComposer | null = null;
  let gtao: GTAOPass | null = null;
  let bloom: UnrealBloomPass | null = null;
  if (fxOn) {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
    gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1 });
    gtao.blendIntensity = 1.0;
    composer.addPass(gtao);
    bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.18, 0.4, 1.0);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer?.setSize(window.innerWidth, window.innerHeight);
    gtao?.setSize(window.innerWidth, window.innerHeight);
    bloom?.setSize(window.innerWidth, window.innerHeight);
  });

  const render = (): void => {
    if (composer) composer.render();
    else renderer.render(scene, camera);
  };
  return { renderer, scene, camera, render };
}

// ---------- small helpers ----------

function flat(color: number | string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), flatShading: true, roughness: 0.9 });
}

function box(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  color: number | string | THREE.Material,
  x: number,
  y: number,
  z: number,
  ry = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    typeof color === "object" ? (color as THREE.Material) : flat(color),
  );
  m.position.set(x, y, z);
  m.rotation.y = ry;
  parent.add(m);
  return m;
}

/** box() with bevelled edges — reads as manufactured, not extruded. */
function rbox(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  color: number | string | THREE.Material,
  x: number,
  y: number,
  z: number,
  ry = 0,
  r?: number,
): THREE.Mesh {
  const radius = Math.min(r ?? Math.min(w, h, d) * 0.18, Math.min(w, h, d) / 2 - 0.002);
  const m = new THREE.Mesh(
    new RoundedBoxGeometry(w, h, d, 2, radius),
    typeof color === "object" ? (color as THREE.Material) : flat(color),
  );
  m.position.set(x, y, z);
  m.rotation.y = ry;
  parent.add(m);
  return m;
}

/** clearcoated water surface — actually reflects the sky instead of matte blue */
function waterMat(color: number, opacity = 0.92): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.12,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    transparent: true,
    opacity,
  });
}

function cyl(
  parent: THREE.Object3D,
  rTop: number,
  rBot: number,
  h: number,
  color: number | string,
  x: number,
  y: number,
  z: number,
  seg = 10,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), flat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function stripeTexture(a: string, b: string, stripes: number, repeat: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const sw = 256 / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? a : b;
    ctx.fillRect(i * sw, 0, sw, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Group positioned/rotated so local +z points inward from wall edge e. */
function edgeGroup(scene: THREE.Object3D, x: number, z: number, e: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][e];
  scene.add(g);
  return g;
}

// ---------- stage themes ----------

interface StageTheme {
  sky: number;
  groundA: string;
  groundB: string;
  fence: number;
  deckA: string;
  deckB: string;
  driveway: number;
  poolStyle: "pool" | "pond";
  poolWater: number;
  poolTrim: number;
  pondWater: number;
  treeKind: "oak" | "autumn" | "palm";
  hedgeKind: "cypress" | "round" | "rock";
  houseKind: "house" | "pavilion" | "beachclub";
  bedKind: "flowers" | "seagrass";
  plazaPad: number;
}

/** Indexed by World.stage — see shared STAGES for the roster. */
const THEMES: StageTheme[] = [
  {
    // backyard — the original suburban look
    sky: 0x8fc3e8, groundA: "#6da24e", groundB: "#77ad55", fence: 0xf4f1e8,
    deckA: "#8a5c34", deckB: "#7c5230", driveway: 0xa8a49a,
    poolStyle: "pool", poolWater: 0x3fa8d8, poolTrim: 0xe8e2d2, pondWater: 0x3583b8,
    treeKind: "oak", hedgeKind: "cypress", houseKind: "house", bedKind: "flowers",
    plazaPad: 0xb9b2a4,
  },
  {
    // city park — deep greens, golden late-afternoon haze, public furniture
    sky: 0xf0c98f, groundA: "#4e8a45", groundB: "#579551", fence: 0x2e5744,
    deckA: "#5d4630", deckB: "#523d2a", driveway: 0x9a9484,
    poolStyle: "pond", poolWater: 0x4a7d5f, poolTrim: 0xa8a293, pondWater: 0x46785e,
    treeKind: "autumn", hedgeKind: "round", houseKind: "pavilion", bedKind: "flowers",
    plazaPad: 0xa8a191,
  },
  {
    // beach cove — sand underfoot, teal water, driftwood and palms
    sky: 0x9fd9ea, groundA: "#e6d6a3", groundB: "#dfcc96", fence: 0xc9bda6,
    deckA: "#c4b394", deckB: "#b8a687", driveway: 0xcfc2a5,
    poolStyle: "pool", poolWater: 0x2ec4d6, poolTrim: 0xf0ece0, pondWater: 0x2fa8c0,
    treeKind: "palm", hedgeKind: "rock", houseKind: "beachclub", bedKind: "seagrass",
    plazaPad: 0xd8cbaa,
  },
];

// ---------- statics ----------

/**
 * Build every static fixture for the world's stage into ONE group and return
 * it — a stage switch removes the group and rebuilds. Also tints the sky/fog.
 */
export function buildStatics(scene: THREE.Scene, world: World): THREE.Group {
  const t = THEMES[world.stage] ?? THEMES[0];
  scene.background = new THREE.Color(t.sky);
  scene.fog = new THREE.Fog(t.sky, 34, 85);
  const root = new THREE.Group();
  scene.add(root);

  buildLawn(root, t);
  buildFences(root, t);
  if (t.houseKind === "house") buildHouse(root, world);
  else if (t.houseKind === "pavilion") buildPavilion(root, world);
  else buildBeachClub(root, world);
  buildDeck(root, world, t);
  buildPool(root, world.pool, t);
  buildPlayground(root, world.playground, { frame: 0xd94f3d, bar: 0xf3c13a, seat: 0x3a72b0 });
  buildPlayground(root, world.playground2, { frame: 0x2a9d8f, bar: 0xe76f51, seat: 0x8859b6 });
  buildHoop(root, world);
  buildDriveway(root, world, t);
  buildCar(root, world.car);
  buildCar(root, world.car2);
  buildShed(root, world.shed, 0x8d6b48, 0x5a4a3a);
  buildShed(root, world.shed2, 0x7189a8, 0x3d4450);
  buildSandpit(root, world.sandpit);
  buildTrampoline(root, world.trampoline);
  buildBbq(root, world.bbq);
  buildPicnicTable(root, world.picnic);
  buildMower(root, world.mower);
  buildPond(root, world.pond, t);
  buildSoccerGoal(root, world.soccer);
  buildDoghouse(root, world.doghouse);
  buildBirdbath(root, world.birdbath);
  buildClothesline(root, world.clothesline);
  buildVeggieGarden(root, world.veggie);
  for (const b of world.benches) buildBench(root, b);
  for (const c of world.clouds) buildCloud(root, c);
  world.trees.forEach((tr, i) => buildTree(root, tr.x, tr.z, tr.s, i === 0 && t.treeKind === "oak", t.treeKind));
  for (const h of world.hedges) buildHedge(root, h.x, h.z, h.s, t.hedgeKind);
  for (const b of world.beds) buildBed(root, b.x, b.z, b.r, b.hue, t.bedKind);

  // party patio under the jumbotron
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.1, 22), flat(t.plazaPad));
  pad.position.set(world.plaza.x, 0.05, world.plaza.z);
  root.add(pad);

  // one sweep arms every opaque lit mesh for the shadow pass — water/glass
  // (transparent) and clouds (basic material) are skipped
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (mat.transparent || (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) return;
    m.castShadow = true;
    m.receiveShadow = true;
  });
  return root;
}

/** Remove a statics group and free its geometries/materials/textures. */
export function disposeStatics(scene: THREE.Object3D, root: THREE.Group): void {
  scene.remove(root);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.map) std.map.dispose();
      m.dispose();
    }
  });
}

function buildLawn(scene: THREE.Object3D, t: StageTheme): void {
  const tex = stripeTexture(t.groundA, t.groundB, 8, 7);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

function buildFences(scene: THREE.Object3D, t: StageTheme): void {
  const white = flat(t.fence);
  // pickets as one instanced mesh (~700 instances, one draw call)
  const picket = new THREE.BoxGeometry(0.16, 1.0, 0.05);
  const step = 0.34;
  const perSide = Math.floor(MAP_SIZE / step);
  const inst = new THREE.InstancedMesh(picket, white, perSide * 4);
  const m4 = new THREE.Matrix4();
  let idx = 0;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < perSide; i++) {
      const a = -HALF + (i + 0.5) * step;
      const [x, z, ry] =
        side === 0 ? [a, -HALF, 0] : side === 1 ? [HALF, a, Math.PI / 2] : side === 2 ? [a, HALF, 0] : [-HALF, a, Math.PI / 2];
      m4.makeRotationY(ry);
      m4.setPosition(x, 0.55, z);
      inst.setMatrixAt(idx++, m4);
    }
  }
  scene.add(inst);
  // rails + posts
  for (let side = 0; side < 4; side++) {
    const vert = side % 2 === 1;
    for (const railY of [0.35, 0.85]) {
      box(
        scene,
        vert ? 0.08 : MAP_SIZE,
        0.1,
        vert ? MAP_SIZE : 0.08,
        white,
        vert ? (side === 1 ? HALF : -HALF) : 0,
        railY,
        vert ? 0 : side === 2 ? HALF : -HALF,
      );
    }
    for (let a = -HALF; a <= HALF; a += 6) {
      box(scene, 0.18, 1.25, 0.18, white, vert ? (side === 1 ? HALF : -HALF) : a, 0.62, vert ? a : side === 2 ? HALF : -HALF);
    }
  }
}

function buildHouse(scene: THREE.Object3D, world: World): void {
  const g = edgeGroup(scene, world.house.x, world.house.z, world.houseEdge);
  const siding = flat(0x6e86a3);
  const trim = flat(0xf5f2ea);
  // facade block (local: along = x, inward = +z)
  box(g, 26, 4.6, 2.4, siding, 0, 2.3, 0);
  // shed roof leaning toward the yard
  const roof = box(g, 27, 0.25, 3.6, flat(0x4b4f58), 0, 4.9, 0.2);
  roof.rotation.x = 0.42;
  // garage doors
  for (const gx of [-8.2, -3.6]) {
    box(g, 3.8, 2.7, 0.12, trim, gx, 1.35, 1.26);
    for (let i = 0; i < 3; i++) box(g, 3.5, 0.06, 0.14, flat(0xd9d4c6), gx, 0.7 + i * 0.8, 1.28);
  }
  // front door + windows
  box(g, 1.1, 2.3, 0.12, trim, 1.4, 1.15, 1.26);
  box(g, 0.12, 0.12, 0.16, flat(0x35507a), 1.75, 1.15, 1.3);
  for (const wx of [4.6, 7.4, 10.2]) {
    box(g, 1.3, 1.5, 0.12, trim, wx, 2.2, 1.26);
    box(g, 1.06, 1.26, 0.13, flat(0x9cc4de), wx, 2.2, 1.27);
  }
}

/** Park stage: a long public pavilion on the house's exact footprint. */
function buildPavilion(scene: THREE.Object3D, world: World): void {
  const g = edgeGroup(scene, world.house.x, world.house.z, world.houseEdge);
  const stone = flat(0xb0a894);
  const timber = flat(0x6b4f33);
  // low stone wall along the back + raised floor (the rect blocks players)
  box(g, 26, 0.35, 2.4, stone, 0, 0.17, 0);
  box(g, 26, 1.1, 0.5, stone, 0, 0.9, -0.95);
  // timber pillars + green hipped roof
  for (const px of [-12, -7.2, -2.4, 2.4, 7.2, 12]) {
    box(g, 0.34, 3.2, 0.34, timber, px, 1.95, 0.85);
    box(g, 0.34, 3.2, 0.34, timber, px, 1.95, -0.85);
  }
  box(g, 27, 0.28, 3.8, flat(0x3e6b48), 0, 3.7, 0);
  const ridge = box(g, 27.4, 0.22, 2.2, flat(0x35593d), 0, 4.05, 0);
  ridge.rotation.x = 0;
  // noticeboard + planters facing the lawn
  box(g, 2.4, 1.4, 0.14, timber, -4.8, 1.7, 1.15);
  box(g, 2.1, 1.1, 0.06, flat(0xe8e0cc), -4.8, 1.72, 1.23);
  for (const px of [-11, 11]) {
    box(g, 1.1, 0.6, 0.9, flat(0x7a5b3a), px, 0.65, 1.1);
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), flat(0xc95d78));
    bloom.position.set(px, 1.15, 1.1);
    bloom.scale.y = 0.7;
    g.add(bloom);
  }
}

/** Beach stage: a weathered beach club on the house's exact footprint. */
function buildBeachClub(scene: THREE.Object3D, world: World): void {
  const g = edgeGroup(scene, world.house.x, world.house.z, world.houseEdge);
  const wood = flat(0x8fb8c8);
  const trim = flat(0xf0ece0);
  rbox(g, 26, 3.6, 2.4, wood, 0, 1.8, 0, 0, 0.12);
  // white trim bands + flat roof with a driftwood fascia
  box(g, 26.2, 0.2, 2.6, trim, 0, 3.7, 0);
  box(g, 26.4, 0.35, 2.8, flat(0xc9bda6), 0, 3.95, 0);
  // porthole windows + double door
  for (const wx of [-8.5, -4.5, 4.5, 8.5]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.1, 8, 16), trim);
    ring.position.set(wx, 2.1, 1.22);
    g.add(ring);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 14), flat(0x7fd4e0));
    glass.rotation.x = Math.PI / 2;
    glass.position.set(wx, 2.1, 1.22);
    g.add(glass);
  }
  box(g, 2.2, 2.5, 0.12, trim, 0.6, 1.25, 1.22);
  box(g, 0.1, 2.3, 0.16, flat(0x8fb8c8), 0.6, 1.25, 1.26);
  // surfboards leaning on the wall
  for (const [bx, hue] of [[-11.4, 0.02], [-10.6, 0.55], [11, 0.33]] as const) {
    const board = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 1.9, 4, 8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.65, 0.55), flatShading: true, roughness: 0.6 }),
    );
    board.position.set(bx, 1.4, 1.28);
    board.rotation.x = -0.18;
    board.scale.z = 0.28;
    g.add(board);
  }
  // lifebuoy by the door
  const buoy = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.12, 8, 16), flat(0xd94f3d));
  buoy.position.set(3.2, 2.4, 1.24);
  g.add(buoy);
}

function buildDeck(scene: THREE.Object3D, world: World, t: StageTheme): void {
  const g = edgeGroup(scene, world.deck.x, world.deck.z, world.houseEdge);
  const plankTex = stripeTexture(t.deckA, t.deckB, 12, 1);
  const deckMat = new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.95 });
  const W = 15;
  const D = 7.2;
  box(g, W, 0.28, D, deckMat, 0, 0.14, 0);

  const navy = flat(0x2c4a8a);
  const wicker = flat(0x4d4438);
  const sofa = (x: number, z: number, ry: number, len: number): void => {
    const s = new THREE.Group();
    s.position.set(x, 0.28, z);
    s.rotation.y = ry;
    rbox(s, len, 0.42, 0.95, wicker, 0, 0.21, 0, 0, 0.07);
    rbox(s, len, 0.55, 0.22, wicker, 0, 0.55, -0.38, 0, 0.06);
    const cushions = Math.max(1, Math.round(len / 0.85));
    for (let i = 0; i < cushions; i++) {
      const cx = -len / 2 + (i + 0.5) * (len / cushions);
      rbox(s, len / cushions - 0.08, 0.18, 0.8, navy, cx, 0.5, 0.04, 0, 0.06);
      rbox(s, len / cushions - 0.08, 0.5, 0.16, navy, cx, 0.75, -0.34, 0, 0.055);
    }
    g.add(s);
  };
  sofa(-3.6, 0.4, Math.PI / 2, 2.6); // facing right
  sofa(3.6, 0.4, -Math.PI / 2, 2.6); // facing left
  sofa(0, 2.3, Math.PI, 3.2); // long sofa facing house
  // coffee table + deco
  rbox(g, 1.8, 0.42, 1.0, wicker, 0, 0.49, 0.2, 0, 0.06);
  box(g, 0.35, 0.12, 0.35, flat(0xf5f2ea), -0.3, 0.76, 0.2);
  box(g, 0.25, 0.2, 0.25, flat(0x88b04b), 0.35, 0.8, 0.2);
  // planters at the deck's yard-side corners
  for (const px of [-6.6, 6.6]) {
    box(g, 0.7, 0.55, 0.7, flat(0x5a5148), px, 0.55, 2.9);
    const bush = new THREE.Mesh(new THREE.SphereGeometry(0.45, 9, 7), flat(0x3c7a3d));
    bush.position.set(px, 1.15, 2.9);
    bush.scale.y = 0.85;
    g.add(bush);
  }
}

function buildPool(scene: THREE.Object3D, pool: RectZone, theme: StageTheme): void {
  const coping = flat(theme.poolTrim);
  const t = 0.5;
  // rim
  box(scene, pool.w + t * 2, 0.22, t, coping, pool.x, 0.11, pool.z - pool.d / 2 - t / 2);
  box(scene, pool.w + t * 2, 0.22, t, coping, pool.x, 0.11, pool.z + pool.d / 2 + t / 2);
  box(scene, t, 0.22, pool.d, coping, pool.x - pool.w / 2 - t / 2, 0.11, pool.z);
  box(scene, t, 0.22, pool.d, coping, pool.x + pool.w / 2 + t / 2, 0.11, pool.z);
  // water
  const water = new THREE.Mesh(new THREE.PlaneGeometry(pool.w, pool.d), waterMat(theme.poolWater));
  water.rotation.x = -Math.PI / 2;
  water.position.set(pool.x, 0.14, pool.z);
  scene.add(water);
  if (theme.poolStyle === "pond") {
    // park duck pond: rocks along the rim, lily pads, a pair of ducks
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const rx = pool.x + Math.cos(a) * (pool.w / 2 + 0.45);
      const rz = pool.z + Math.sin(a) * (pool.d / 2 + 0.45);
      const rock = new THREE.Mesh(new THREE.SphereGeometry(0.2 + (i % 3) * 0.07, 6, 5), flat(0x8a8578));
      rock.position.set(rx, 0.14, rz);
      rock.scale.y = 0.6;
      scene.add(rock);
    }
    for (const [dx, dz] of [[-0.3, -0.25], [0.25, 0.1], [-0.1, 0.3]] as const) {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 8), flat(0x4a8a3f));
      pad.position.set(pool.x + dx * pool.w, 0.16, pool.z + dz * pool.d);
      scene.add(pad);
    }
    for (const [dx, dz] of [[0.15, -0.2], [-0.2, 0.12]] as const) {
      const duck = new THREE.Group();
      duck.position.set(pool.x + dx * pool.w, 0.22, pool.z + dz * pool.d);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), flat(0xf5f2ea));
      body.scale.set(1.25, 0.8, 1);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 7, 6), flat(0xf5f2ea));
      head.position.set(0.16, 0.16, 0);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 6), flat(0xe8a33d));
      beak.rotation.z = -Math.PI / 2;
      beak.position.set(0.27, 0.15, 0);
      duck.add(body, head, beak);
      duck.rotation.y = (dx + dz) * 9;
      scene.add(duck);
    }
    return;
  }
  // shallow-end shimmer patch — barely-there tint, not a floating glass pane
  const glint = new THREE.Mesh(
    new THREE.PlaneGeometry(pool.w * 0.6, pool.d * 0.35),
    new THREE.MeshStandardMaterial({ color: 0x9adcf2, roughness: 0.15, transparent: true, opacity: 0.28 }),
  );
  glint.rotation.x = -Math.PI / 2;
  glint.position.set(pool.x, 0.143, pool.z + pool.d * 0.2);
  scene.add(glint);
  // ladder
  const lx = pool.x + pool.w / 2 + 0.15;
  for (const dz of [-0.25, 0.25]) cyl(scene, 0.03, 0.03, 0.9, "#d8d8dc", lx, 0.45, pool.z + dz, 6);
  for (let i = 0; i < 3; i++) box(scene, 0.05, 0.04, 0.55, 0xd8d8dc, lx, 0.2 + i * 0.25, pool.z);
  // pool loungers mirrored on both sides
  for (const side of [-1, 1]) {
    for (const dz of [-1.6, 0.6]) {
      const lounger = new THREE.Group();
      lounger.position.set(pool.x + side * (pool.w / 2 + 1.4), 0, pool.z + dz);
      box(lounger, 0.7, 0.18, 1.7, flat(0x3a72b0), 0, 0.35, 0);
      // backrest hinged at the seat's head end — lower edge tucks into the seat
      const back = box(lounger, 0.7, 0.18, 0.7, flat(0x3a72b0), 0, 0.5, -0.65);
      back.rotation.x = -0.7;
      for (const [ly, lz] of [[0.18, 0.6], [0.18, -0.6]] as const) {
        box(lounger, 0.6, 0.35, 0.08, flat(0xf5f2ea), 0, ly, lz);
      }
      scene.add(lounger);
    }
  }
}

function buildDriveway(scene: THREE.Object3D, world: World, t: StageTheme): void {
  const d = world.driveway;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.07, d.d), flat(t.driveway));
  slab.position.set(d.x, 0.035, d.z);
  scene.add(slab);
}

function buildCar(scene: THREE.Object3D, car: { x: number; z: number; rot: number; hue: number }): void {
  const g = new THREE.Group();
  g.position.set(car.x, 0, car.z);
  g.rotation.y = car.rot;
  scene.add(g);
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setHSL(car.hue / 360, 0.55, 0.45),
    flatShading: true,
    roughness: 0.32,
    metalness: 0.35,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  rbox(g, 1.8, 0.55, 4.1, paint, 0, 0.65, 0, 0, 0.1); // body
  rbox(g, 1.6, 0.5, 2.0, paint, 0, 1.15, -0.2, 0, 0.12); // cabin
  const glass = flat(0x9cc4de);
  box(g, 1.62, 0.36, 0.06, glass, 0, 1.18, 0.82); // windshield
  box(g, 1.62, 0.36, 0.06, glass, 0, 1.18, -1.2); // rear window
  for (const sx of [-0.82, 0.82]) box(g, 0.05, 0.34, 1.7, glass, sx, 1.16, -0.2);
  for (const [wx, wz] of [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]] as const) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.24, 12), flat(0x1c1e24));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.32, wz);
    g.add(wheel);
  }
  for (const sx of [-0.55, 0.55]) box(g, 0.3, 0.12, 0.06, flat(0xfff3b0), sx, 0.72, 2.06); // headlights
}

function buildShed(
  scene: THREE.Object3D,
  shed: { x: number; z: number; rot: number },
  wallColor: number,
  roofColor: number,
): void {
  const g = new THREE.Group();
  g.position.set(shed.x, 0, shed.z);
  g.rotation.y = shed.rot;
  scene.add(g);
  const wall = flat(wallColor);
  rbox(g, 3.0, 2.2, 2.4, wall, 0, 1.1, 0, 0, 0.08);
  const roofL = box(g, 1.75, 0.14, 2.8, flat(roofColor), -0.78, 2.55, 0);
  roofL.rotation.z = 0.5;
  const roofR = box(g, 1.75, 0.14, 2.8, flat(roofColor), 0.78, 2.55, 0);
  roofR.rotation.z = -0.5;
  box(g, 0.85, 1.6, 0.1, flat(0x6b4f33), 0, 0.8, 1.22); // door
  box(g, 0.08, 0.08, 0.14, flat(0xd8d8dc), 0.3, 0.85, 1.26); // handle
  box(g, 0.7, 0.6, 0.08, flat(0x9cc4de), -0.9, 1.5, 1.22); // window
}

function buildPond(scene: THREE.Object3D, pond: { x: number; z: number; r: number }, t: StageTheme): void {
  const water = new THREE.Mesh(new THREE.CylinderGeometry(pond.r, pond.r, 0.08, 20), waterMat(t.pondWater));
  water.position.set(pond.x, 0.05, pond.z);
  scene.add(water);
  // rock ring
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const rock = new THREE.Mesh(new THREE.SphereGeometry(0.22 + (i % 3) * 0.06, 6, 5), flat(0x8a8578));
    rock.position.set(pond.x + Math.cos(a) * (pond.r + 0.15), 0.12, pond.z + Math.sin(a) * (pond.r + 0.15));
    rock.scale.y = 0.65;
    scene.add(rock);
  }
  // lily pads
  for (const [dx, dz] of [[-0.5, 0.4], [0.7, -0.3], [0.1, 0.8]] as const) {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 8), flat(0x4a8a3f));
    pad.position.set(pond.x + dx * pond.r * 0.7, 0.1, pond.z + dz * pond.r * 0.7);
    scene.add(pad);
  }
  // fountain: two stone tiers + a water jet
  const tier1 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.25, 12), flat(0xb5af9f));
  tier1.position.set(pond.x, 0.2, pond.z);
  const tier2 = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.4, 10), flat(0xb5af9f));
  tier2.position.set(pond.x, 0.5, pond.z);
  const jet = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.8, 8),
    new THREE.MeshStandardMaterial({ color: 0x9fd8f0, roughness: 0.15, transparent: true, opacity: 0.75 }),
  );
  jet.position.set(pond.x, 1.1, pond.z);
  scene.add(tier1, tier2, jet);
}

function buildSoccerGoal(scene: THREE.Object3D, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  const white = flat(0xf5f2ea);
  for (const px of [-1.5, 1.5]) cyl(g, 0.05, 0.05, 1.5, "#f5f2ea", px, 0.75, 0, 8);
  const crossbar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.1, 8), white);
  crossbar.position.y = 1.5;
  crossbar.rotation.z = Math.PI / 2;
  g.add(crossbar);
  for (const px of [-1.5, 1.5]) {
    // back stay runs post-top (y1.5, z0) -> ground bar (y0, z-1.5): len √(1.5²+1.5²)
    const back = cyl(g, 0.03, 0.03, 2.12, "#c9ccd4", px, 0.75, -0.75, 6);
    back.rotation.x = Math.PI / 4;
  }
  box(g, 3.1, 0.02, 0.05, white, 0, 0.02, -1.5); // ground bar
  // chalk goal box on the lawn
  for (const [w, d, x, z] of [[4.4, 0.08, 0, 2.6], [0.08, 2.6, -2.2, 1.3], [0.08, 2.6, 2.2, 1.3]] as const) {
    box(g, w, 0.015, d, white, x, 0.01, z);
  }
}

function buildDoghouse(scene: THREE.Object3D, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  rbox(g, 1.2, 0.9, 1.4, flat(0xa0522d), 0, 0.45, 0, 0, 0.06);
  const roofL = box(g, 0.75, 0.1, 1.6, flat(0x5a4a3a), -0.32, 1.1, 0);
  roofL.rotation.z = 0.55;
  const roofR = box(g, 0.75, 0.1, 1.6, flat(0x5a4a3a), 0.32, 1.1, 0);
  roofR.rotation.z = -0.55;
  // gable fill: triangular prism (3-seg cylinder, vertex up) squashed to the
  // roof pitch so the front/back triangles under the ridge aren't open holes
  const gable = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 1.36, 3, 1, false, Math.PI), flat(0xa0522d));
  gable.rotation.x = Math.PI / 2;
  gable.scale.z = 0.35; // local z becomes world height after the tilt
  gable.position.set(0, 1.03, 0);
  g.add(gable);
  // thetaStart π/2 puts the half-disc's flat chord at the bottom (an arch, not a sideways D)
  const arch = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.08, 12, 1, false, Math.PI / 2, Math.PI),
    flat(0x1c1e24),
  );
  arch.rotation.x = Math.PI / 2;
  arch.position.set(0, 0.42, 0.71);
  g.add(arch);
  box(g, 0.5, 0.42, 0.06, flat(0x1c1e24), 0, 0.24, 0.71); // dark doorway
}

function buildBirdbath(scene: THREE.Object3D, at: { x: number; z: number }): void {
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.75, 8), flat(0xb5af9f));
  ped.position.set(at.x, 0.38, at.z);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.28, 0.16, 12), flat(0xb5af9f));
  bowl.position.set(at.x, 0.82, at.z);
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12), waterMat(0x6cc4e8, 1));
  water.position.set(at.x, 0.88, at.z);
  scene.add(ped, bowl, water);
}

function buildClothesline(scene: THREE.Object3D, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  for (const px of [-1.8, 1.8]) {
    cyl(g, 0.045, 0.045, 1.8, "#8a8f99", px, 0.9, 0, 7);
    const t = box(g, 0.9, 0.06, 0.06, flat(0x8a8f99), px, 1.8, 0);
    t.rotation.y = Math.PI / 2;
  }
  const line = box(g, 3.6, 0.02, 0.02, flat(0xd8d8dc), 0, 1.8, 0);
  line.visible = true;
  // towels drying
  const hues = [0.02, 0.55, 0.12];
  for (let i = 0; i < 3; i++) {
    const towel = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.75, 0.04),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hues[i], 0.6, 0.6), roughness: 0.9 }),
    );
    towel.position.set(-1.1 + i * 1.1, 1.42, 0);
    g.add(towel);
  }
}

function buildVeggieGarden(scene: THREE.Object3D, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  for (const dz of [-0.8, 0.8]) {
    rbox(g, 3, 0.35, 1.1, flat(0x7a5b3a), 0, 0.18, dz, 0, 0.05);
    box(g, 2.8, 0.08, 0.9, flat(0x4a3826), 0, 0.36, dz); // soil
    for (let i = 0; i < 5; i++) {
      const sprout = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), flat(0x4a8a3f));
      sprout.position.set(-1.2 + i * 0.6, 0.52, dz);
      g.add(sprout);
    }
  }
}

function buildBench(scene: THREE.Object3D, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  const wood = flat(0x9a7047);
  for (const dz of [-0.1, 0.1]) box(g, 1.5, 0.06, 0.2, wood, 0, 0.45, dz); // seat slats
  for (const dy of [0.72, 0.88]) box(g, 1.5, 0.09, 0.05, wood, 0, dy, -0.26); // back slats
  for (const px of [-0.6, 0.6]) {
    box(g, 0.08, 0.45, 0.4, flat(0x3b3e45), px, 0.22, 0);
    box(g, 0.08, 0.55, 0.08, flat(0x3b3e45), px, 0.72, -0.26);
  }
}

function buildCloud(scene: THREE.Object3D, c: { x: number; y: number; z: number; s: number }): void {
  const g = new THREE.Group();
  g.position.set(c.x, c.y, c.z);
  scene.add(g);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.88, fog: false });
  for (const [dx, dy, dz, r] of [
    [0, 0, 0, 1.6],
    [1.5, 0.2, 0.3, 1.15],
    [-1.4, 0.1, -0.2, 1.05],
    [0.4, 0.75, -0.4, 0.95],
  ] as const) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r * c.s, 8, 6), mat);
    puff.position.set(dx * c.s, dy * c.s, dz * c.s);
    puff.scale.y = 0.6;
    g.add(puff);
  }
}

function buildSandpit(scene: THREE.Object3D, pit: { x: number; z: number; r: number }): void {
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(pit.r, pit.r, 0.14, 14), flat(0xe3cd97));
  sand.position.set(pit.x, 0.07, pit.z);
  scene.add(sand);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(pit.r, 0.12, 6, 16), flat(0x8d6b48));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(pit.x, 0.12, pit.z);
  scene.add(rim);
  // sandcastle: keep + four corner towers with cone roofs
  const castle = new THREE.Group();
  castle.position.set(pit.x, 0.14, pit.z);
  const sandy = flat(0xd4b878);
  box(castle, 0.5, 0.35, 0.5, sandy, 0, 0.18, 0);
  for (const [tx, tz] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]] as const) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.45, 8), sandy);
    tower.position.set(tx, 0.22, tz);
    castle.add(tower);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.18, 8), flat(0xc9a765));
    roof.position.set(tx, 0.53, tz);
    castle.add(roof);
  }
  // toy bucket + shovel in the sand
  const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.1, 0.18, 9), flat(0xd94f3d));
  bucket.position.set(pit.x + pit.r * 0.55, 0.22, pit.z + 0.4);
  scene.add(bucket);
  scene.add(castle);
}

function buildTrampoline(scene: THREE.Object3D, tr: { x: number; z: number }): void {
  const g = new THREE.Group();
  g.position.set(tr.x, 0, tr.z);
  scene.add(g);
  const mat = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.06, 18), flat(0x23262e));
  mat.position.y = 0.8;
  g.add(mat);
  const pad = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.16, 8, 18), flat(0x3a72b0));
  pad.rotation.x = Math.PI / 2;
  pad.position.y = 0.82;
  g.add(pad);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    cyl(g, 0.045, 0.045, 0.8, "#8a8f99", Math.cos(a) * 1.45, 0.4, Math.sin(a) * 1.45, 7);
  }
}

function buildBbq(scene: THREE.Object3D, bbq: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(bbq.x, 0, bbq.z);
  g.rotation.y = bbq.rot;
  scene.add(g);
  const kettle = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 8), flat(0x23262e));
  kettle.position.y = 0.85;
  kettle.scale.y = 0.75;
  g.add(kettle);
  const lidKnob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), flat(0xc9ccd4));
  lidKnob.position.y = 1.16;
  g.add(lidKnob);
  for (const a of [0, 2.1, 4.2]) {
    const leg = cyl(g, 0.03, 0.03, 0.8, "#4a4d55", Math.cos(a) * 0.24, 0.4, Math.sin(a) * 0.24, 6);
    leg.rotation.z = Math.cos(a) * 0.2;
    leg.rotation.x = -Math.sin(a) * 0.2;
  }
  // side shelf: inner edge sinks ~3cm into the kettle (r=0.38) so it reads attached from every angle
  box(g, 0.55, 0.05, 0.35, flat(0x8d6b48), 0.62, 0.85, 0);
}

function buildPicnicTable(scene: THREE.Object3D, p: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  g.rotation.y = p.rot;
  scene.add(g);
  const wood = flat(0x9a7047);
  rbox(g, 1.7, 0.09, 0.9, wood, 0, 0.75, 0, 0, 0.03); // top
  for (const side of [-1, 1]) {
    rbox(g, 1.7, 0.07, 0.3, wood, 0, 0.45, side * 0.75, 0, 0.025); // benches
  }
  // classic A-frame ends: two crossed legs + a bench-height brace per end
  for (const end of [-1, 1]) {
    box(g, 0.08, 0.07, 1.72, wood, end * 0.7, 0.41, 0); // brace under both benches
    for (const lean of [-1, 1]) {
      const leg = box(g, 0.08, 1.0, 0.12, wood, end * 0.7, 0.4, 0);
      leg.rotation.x = lean * 0.65; // feet at z ±0.30, tops meet under the tabletop
    }
  }
}

function buildMower(scene: THREE.Object3D, m: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(m.x, 0, m.z);
  g.rotation.y = m.rot;
  scene.add(g);
  rbox(g, 0.5, 0.18, 0.7, flat(0xd94f3d), 0, 0.28, 0, 0, 0.045); // deck
  rbox(g, 0.28, 0.16, 0.3, flat(0x23262e), 0, 0.45, 0.05, 0, 0.04); // engine
  for (const [wx, wz, r] of [[-0.24, 0.28, 0.09], [0.24, 0.28, 0.09], [-0.24, -0.3, 0.12], [0.24, -0.3, 0.12]] as const) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.08, 10), flat(0x1c1e24));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, r, wz);
    g.add(wheel);
  }
  for (const hx of [-0.2, 0.2]) {
    const bar = cyl(g, 0.02, 0.02, 1.1, "#4a4d55", hx, 0.75, -0.75, 6);
    bar.rotation.x = 0.75;
  }
  box(g, 0.44, 0.04, 0.05, flat(0x4a4d55), 0, 1.2, -1.18); // handle grip
}

function buildTree(
  scene: THREE.Object3D,
  x: number,
  z: number,
  s: number,
  tireSwing: boolean,
  kind: StageTheme["treeKind"],
): void {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);
  if (kind === "palm") {
    // one leaning trunk, frond crown at its tip, coconuts
    const lean = Math.sin(x * 3.1 + z * 1.7) * 0.14;
    const trunkLen = 3.3 * s;
    const trunk = cyl(g, 0.11 * s, 0.17 * s, trunkLen, "#9a7a52", 0, trunkLen / 2, 0, 7);
    trunk.rotation.z = lean;
    const crownX = -Math.sin(lean) * trunkLen * 0.5; // trunk tip after the tilt
    const crownY = trunkLen * 0.5 + Math.cos(lean) * trunkLen * 0.5;
    // fronds radiate from the crown point, drooping just past horizontal —
    // inner ends overlap the crown so nothing floats detached
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.17 * s, 8, 6), flat(0x3f8a44));
    hub.position.set(crownX, crownY, 0);
    g.add(hub);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const droop = 1.85 + Math.sin(x * 5.3 + i * 2.1) * 0.15; // rad from vertical
      const frond = new THREE.Mesh(new THREE.ConeGeometry(0.34 * s, 1.9 * s, 4), flat(i % 2 ? 0x3f8a44 : 0x4a9a4e));
      frond.scale.y = 0.55;
      frond.scale.z = 0.28;
      frond.rotation.z = -droop; // apex tips outward+down (Rz first in XYZ order)
      frond.rotation.y = -a;
      const len = 1.9 * s * 0.55;
      const dh = Math.sin(droop) * len * 0.38;
      const dy = Math.cos(droop) * len * 0.38;
      frond.position.set(crownX + Math.cos(a) * dh, crownY + dy, Math.sin(a) * dh);
      g.add(frond);
    }
    for (const [dx, dz] of [[0.18, 0.05], [-0.1, 0.16]] as const) {
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.13 * s, 7, 6), flat(0x6b4f33));
      nut.position.set(crownX + dx, crownY - 0.28 * s, dz);
      g.add(nut);
    }
    return;
  }
  const trunk = cyl(g, 0.16 * s, 0.24 * s, 2.6 * s, "#6b4f33", 0, 1.3 * s, 0, 8);
  trunk.rotation.y = x + z; // vary silhouette
  // autumn park trees mix warm canopies; the backyard stays summer green
  const palettes =
    kind === "autumn"
      ? [flat(0xc0783a), flat(0xd9a13b), flat(0x8f9a3a), flat(0xb85c33)]
      : [flat(0x4a8a3f), flat(0x548f46)];
  for (const [cx, cy, cz, r] of [
    [0, 3.1 * s, 0, 1.55 * s],
    [0.9 * s, 2.7 * s, 0.3 * s, 1.1 * s],
    [-0.8 * s, 2.8 * s, -0.4 * s, 1.15 * s],
    [0.1 * s, 2.5 * s, 0.9 * s, 1.0 * s],
  ] as const) {
    const pick = Math.abs(Math.floor((cx + cz) * 7 + x + z)) % palettes.length;
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 7), palettes[pick]);
    puff.position.set(cx, cy, cz);
    g.add(puff);
  }
  if (tireSwing) {
    cyl(g, 0.02, 0.02, 1.3, "#8a7a5a", 1.15 * s, 1.75 * s, 0, 5);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.09, 7, 14), flat(0x23262e));
    tire.position.set(1.15 * s, 1.05 * s, 0);
    g.add(tire);
  }
}

function buildPlayground(
  scene: THREE.Object3D,
  at: { x: number; z: number; rot: number },
  palette: { frame: number; bar: number; seat: number },
): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);

  const frameMat = flat(palette.frame);
  const barMat = flat(palette.bar);
  const seatMat = flat(palette.seat);
  const steel = flat(0xc9ccd4);

  // swing set (A-frame)
  const swing = new THREE.Group();
  swing.position.set(-3.4, 0, 0);
  for (const sx of [-1.7, 1.7]) {
    for (const tilt of [-0.35, 0.35]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 8), frameMat);
      // rotation.x=tilt swings the top end toward +z by sin(tilt)*halfLen, so the
      // center sits at -sin(tilt)*halfLen: tops meet at the apex (sx, ~2.44, 0)
      leg.position.set(sx, Math.cos(tilt) * 1.3, -Math.sin(tilt) * 1.3);
      leg.rotation.x = tilt;
      swing.add(leg);
    }
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 8), barMat);
  bar.position.set(0, 2.35, 0);
  bar.rotation.z = Math.PI / 2;
  swing.add(bar);
  for (const sx of [-0.8, 0.8]) {
    for (const rx of [-0.18, 0.18]) cyl(swing, 0.015, 0.015, 1.5, "#8a8f99", sx + rx, 1.55, 0, 5);
    box(swing, 0.5, 0.06, 0.22, seatMat, sx, 0.8, 0);
  }
  g.add(swing);

  // slide
  const slide = new THREE.Group();
  slide.position.set(2.6, 0, -0.6);
  for (const lx of [-0.35, 0.35]) cyl(slide, 0.05, 0.05, 1.7, "#c9ccd4", lx, 0.85, -0.8, 8);
  for (let i = 0; i < 4; i++) box(slide, 0.62, 0.05, 0.08, steel, 0, 0.35 + i * 0.4, -0.8);
  box(slide, 0.9, 0.12, 0.9, frameMat, 0, 1.7, -0.3);
  // +x tilt drops the far (+z) end: high end meets the platform, low end kisses the lawn
  const chute = box(slide, 0.7, 0.09, 2.6, barMat, 0, 1.05, 1.05);
  chute.rotation.x = 0.55;
  for (const cx of [-0.38, 0.38]) {
    const rail = box(slide, 0.06, 0.16, 2.6, barMat, cx, 1.15, 1.05);
    rail.rotation.x = 0.55;
  }
  g.add(slide);

  // seesaw
  const seesaw = new THREE.Group();
  seesaw.position.set(0.2, 0, 2.6);
  const pivot = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 4), frameMat);
  pivot.position.y = 0.25;
  seesaw.add(pivot);
  const plank = box(seesaw, 3.2, 0.09, 0.36, seatMat, 0, 0.5, 0);
  plank.rotation.z = 0.22;
  // seats + T-handles live in plank-local space so they ride the tilt
  for (const side of [-1, 1] as const) {
    box(plank, 0.4, 0.05, 0.38, frameMat, side * 1.35, 0.07, 0); // seat pad
    cyl(plank, 0.025, 0.025, 0.22, "#c9ccd4", side * 1.0, 0.15, 0, 6); // handle stem
    const gripBar = cyl(plank, 0.025, 0.025, 0.34, "#c9ccd4", side * 1.0, 0.28, 0, 6);
    gripBar.rotation.x = Math.PI / 2; // crossbar you hold onto
  }
  g.add(seesaw);
}

function buildHoop(scene: THREE.Object3D, world: World): void {
  const g = new THREE.Group();
  g.position.set(world.hoop.x, 0, world.hoop.z);
  g.rotation.y = world.hoop.rot;
  scene.add(g);
  // half-court pad
  box(g, 5.2, 0.06, 4.4, flat(0x8f9299), 0, 0.03, 1.6);
  const key = box(g, 1.6, 0.02, 2.2, flat(0xa8abb2), 0, 0.062, 1.2);
  key.visible = true;
  cyl(g, 0.07, 0.07, 3.1, "#3b3e45", 0, 1.55, -0.3, 8);
  box(g, 1.5, 1.0, 0.08, flat(0xf5f2ea), 0, 2.9, -0.22);
  box(g, 0.6, 0.45, 0.1, flat(0xd94f3d), 0, 2.75, -0.21);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.03, 6, 14), flat(0xe07020));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 2.55, 0.12);
  g.add(ring);
}

function buildHedge(scene: THREE.Object3D, x: number, z: number, s: number, kind: StageTheme["hedgeKind"]): void {
  if (kind === "rock") {
    // beach boulder + a small companion stone (same collider footprint)
    const rock = new THREE.Mesh(new THREE.SphereGeometry(0.52 * s, 7, 6), flat(0x9a9284));
    rock.position.set(x, 0.42 * s, z);
    rock.scale.y = 0.8;
    rock.rotation.y = x * 2 + z;
    scene.add(rock);
    const pebble = new THREE.Mesh(new THREE.SphereGeometry(0.2 * s, 6, 5), flat(0x8a8274));
    pebble.position.set(x + 0.45 * s, 0.14 * s, z + 0.2 * s);
    pebble.scale.y = 0.7;
    scene.add(pebble);
    return;
  }
  if (kind === "round") {
    // trimmed park topiary: two stacked spheres
    const lower = new THREE.Mesh(new THREE.SphereGeometry(0.52 * s, 9, 7), flat(0x3f7a44));
    lower.position.set(x, 0.5 * s, z);
    lower.scale.y = 0.85;
    scene.add(lower);
    const upper = new THREE.Mesh(new THREE.SphereGeometry(0.34 * s, 8, 6), flat(0x498a4e));
    upper.position.set(x, 1.2 * s, z);
    scene.add(upper);
    return;
  }
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55 * s, 2.3 * s, 8), flat(0x2f5d31));
  cone.position.set(x, 1.15 * s, z);
  scene.add(cone);
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.5 * s, 8, 6), flat(0x37693a));
  base.position.set(x, 0.35 * s, z);
  base.scale.y = 0.7;
  scene.add(base);
}

function buildBed(
  scene: THREE.Object3D,
  x: number,
  z: number,
  r: number,
  hue: number,
  kind: StageTheme["bedKind"],
): void {
  if (kind === "seagrass") {
    // dune patch: darker sand, seagrass tufts, one starfish (solid bush spot
    // is the same off-center circle the collider uses)
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.08, 14), flat(0xd0bc84));
    sand.position.set(x, 0.04, z);
    scene.add(sand);
    const clump = new THREE.Group();
    clump.position.set(x - r * 0.25, 0, z);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05 * r, 1.1 * r, 5), flat(i % 2 ? 0x7a9a5a : 0x6a8a4e));
      blade.position.set(Math.cos(a) * 0.3 * r, 0.5 * r, Math.sin(a) * 0.3 * r);
      blade.rotation.z = Math.cos(a) * 0.35;
      blade.rotation.x = -Math.sin(a) * 0.35;
      clump.add(blade);
    }
    scene.add(clump);
    const star = new THREE.Group();
    star.position.set(x + r * 0.5, 0.1, z + r * 0.3);
    star.rotation.y = hue;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const arm = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 5), flat(0xe07a4a));
      arm.rotation.z = Math.PI / 2 + a;
      arm.position.set(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12);
      arm.rotation.y = -a;
      star.add(arm);
    }
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5), flat(0xe07a4a));
    star.add(core);
    star.scale.y = 0.4;
    scene.add(star);
    return;
  }
  const mulch = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.1, 14), flat(0x5a4028));
  mulch.position.set(x, 0.05, z);
  scene.add(mulch);
  const bush = new THREE.Mesh(new THREE.SphereGeometry(r * 0.45, 9, 7), flat(0x3c7a3d));
  bush.position.set(x - r * 0.25, r * 0.3, z);
  bush.scale.y = 0.75;
  scene.add(bush);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const fx = x + Math.cos(a) * r * 0.55;
    const fz = z + Math.sin(a) * r * 0.55;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.25, 5), flat(0x3c7a3d));
    stem.position.set(fx, 0.22, fz);
    scene.add(stem);
    const bloom = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 7, 6),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(((hue + i * 12) % 360) / 360, 0.75, 0.6), flatShading: true }),
    );
    bloom.position.set(fx, 0.36, fz);
    scene.add(bloom);
  }
}
