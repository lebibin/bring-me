import * as THREE from "three";
import { MAP_SIZE, type RectZone, type World } from "@bringme/shared";

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

const HALF = MAP_SIZE / 2;

export function createScene(container: HTMLElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc3e8);
  scene.fog = new THREE.Fog(0x8fc3e8, 34, 85);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 6, -8);

  scene.add(new THREE.HemisphereLight(0xd8ecff, 0x5c7a45, 1.05));
  const sun = new THREE.DirectionalLight(0xfff3da, 1.7);
  sun.position.set(18, 30, 12);
  scene.add(sun);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
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
function edgeGroup(scene: THREE.Scene, x: number, z: number, e: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][e];
  scene.add(g);
  return g;
}

// ---------- statics ----------

/** The backyard: lawn, picket fence, house + deck + pool, playground, hoop, hedges, beds. */
export function buildStatics(scene: THREE.Scene, world: World): void {
  buildLawn(scene);
  buildFences(scene);
  buildHouse(scene, world);
  buildDeck(scene, world);
  buildPool(scene, world.pool);
  buildPlayground(scene, world.playground, { frame: 0xd94f3d, bar: 0xf3c13a, seat: 0x3a72b0 });
  buildPlayground(scene, world.playground2, { frame: 0x2a9d8f, bar: 0xe76f51, seat: 0x8859b6 });
  buildHoop(scene, world);
  buildDriveway(scene, world);
  buildCar(scene, world.car);
  buildCar(scene, world.car2);
  buildShed(scene, world.shed, 0x8d6b48, 0x5a4a3a);
  buildShed(scene, world.shed2, 0x7189a8, 0x3d4450);
  buildSandpit(scene, world.sandpit);
  buildTrampoline(scene, world.trampoline);
  buildBbq(scene, world.bbq);
  buildPicnicTable(scene, world.picnic);
  buildMower(scene, world.mower);
  buildPond(scene, world.pond);
  buildSoccerGoal(scene, world.soccer);
  buildDoghouse(scene, world.doghouse);
  buildBirdbath(scene, world.birdbath);
  buildClothesline(scene, world.clothesline);
  buildVeggieGarden(scene, world.veggie);
  for (const b of world.benches) buildBench(scene, b);
  for (const c of world.clouds) buildCloud(scene, c);
  world.trees.forEach((t, i) => buildTree(scene, t.x, t.z, t.s, i === 0));
  for (const h of world.hedges) buildHedge(scene, h.x, h.z, h.s);
  for (const b of world.beds) buildBed(scene, b.x, b.z, b.r, b.hue);

  // concrete party patio under the jumbotron
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.1, 22), flat(0xb9b2a4));
  pad.position.set(world.plaza.x, 0.05, world.plaza.z);
  scene.add(pad);
}

function buildLawn(scene: THREE.Scene): void {
  const tex = stripeTexture("#6da24e", "#77ad55", 8, 7);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

function buildFences(scene: THREE.Scene): void {
  const white = flat(0xf4f1e8);
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

function buildHouse(scene: THREE.Scene, world: World): void {
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

function buildDeck(scene: THREE.Scene, world: World): void {
  const g = edgeGroup(scene, world.deck.x, world.deck.z, world.houseEdge);
  const plankTex = stripeTexture("#8a5c34", "#7c5230", 12, 1);
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
    box(s, len, 0.42, 0.95, wicker, 0, 0.21, 0);
    box(s, len, 0.55, 0.22, wicker, 0, 0.55, -0.38);
    const cushions = Math.max(1, Math.round(len / 0.85));
    for (let i = 0; i < cushions; i++) {
      const cx = -len / 2 + (i + 0.5) * (len / cushions);
      box(s, len / cushions - 0.08, 0.18, 0.8, navy, cx, 0.5, 0.04);
      box(s, len / cushions - 0.08, 0.5, 0.16, navy, cx, 0.75, -0.34);
    }
    g.add(s);
  };
  sofa(-3.6, 0.4, Math.PI / 2, 2.6); // facing right
  sofa(3.6, 0.4, -Math.PI / 2, 2.6); // facing left
  sofa(0, 2.3, Math.PI, 3.2); // long sofa facing house
  // coffee table + deco
  box(g, 1.8, 0.42, 1.0, wicker, 0, 0.49, 0.2);
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

function buildPool(scene: THREE.Scene, pool: RectZone): void {
  const coping = flat(0xe8e2d2);
  const t = 0.5;
  // rim
  box(scene, pool.w + t * 2, 0.22, t, coping, pool.x, 0.11, pool.z - pool.d / 2 - t / 2);
  box(scene, pool.w + t * 2, 0.22, t, coping, pool.x, 0.11, pool.z + pool.d / 2 + t / 2);
  box(scene, t, 0.22, pool.d, coping, pool.x - pool.w / 2 - t / 2, 0.11, pool.z);
  box(scene, t, 0.22, pool.d, coping, pool.x + pool.w / 2 + t / 2, 0.11, pool.z);
  // water
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(pool.w, pool.d),
    new THREE.MeshStandardMaterial({ color: 0x3fa8d8, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.92 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(pool.x, 0.14, pool.z);
  scene.add(water);
  // shallow-end shimmer patch
  const glint = new THREE.Mesh(
    new THREE.PlaneGeometry(pool.w * 0.6, pool.d * 0.35),
    new THREE.MeshStandardMaterial({ color: 0x6cc4e8, roughness: 0.2, transparent: true, opacity: 0.75 }),
  );
  glint.rotation.x = -Math.PI / 2;
  glint.position.set(pool.x, 0.145, pool.z + pool.d * 0.2);
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
      const back = box(lounger, 0.7, 0.18, 0.7, flat(0x3a72b0), 0, 0.55, -1.0);
      back.rotation.x = -0.7;
      for (const [ly, lz] of [[0.18, 0.6], [0.18, -0.6]] as const) {
        box(lounger, 0.6, 0.35, 0.08, flat(0xf5f2ea), 0, ly, lz);
      }
      scene.add(lounger);
    }
  }
}

function buildDriveway(scene: THREE.Scene, world: World): void {
  const d = world.driveway;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.07, d.d), flat(0xa8a49a));
  slab.position.set(d.x, 0.035, d.z);
  scene.add(slab);
}

function buildCar(scene: THREE.Scene, car: { x: number; z: number; rot: number; hue: number }): void {
  const g = new THREE.Group();
  g.position.set(car.x, 0, car.z);
  g.rotation.y = car.rot;
  scene.add(g);
  const paint = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(car.hue / 360, 0.55, 0.45),
    flatShading: true,
    roughness: 0.4,
    metalness: 0.3,
  });
  box(g, 1.8, 0.55, 4.1, paint, 0, 0.65, 0); // body
  box(g, 1.6, 0.5, 2.0, paint, 0, 1.15, -0.2); // cabin
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
  scene: THREE.Scene,
  shed: { x: number; z: number; rot: number },
  wallColor: number,
  roofColor: number,
): void {
  const g = new THREE.Group();
  g.position.set(shed.x, 0, shed.z);
  g.rotation.y = shed.rot;
  scene.add(g);
  const wall = flat(wallColor);
  box(g, 3.0, 2.2, 2.4, wall, 0, 1.1, 0);
  const roofL = box(g, 1.75, 0.14, 2.8, flat(roofColor), -0.78, 2.55, 0);
  roofL.rotation.z = 0.5;
  const roofR = box(g, 1.75, 0.14, 2.8, flat(roofColor), 0.78, 2.55, 0);
  roofR.rotation.z = -0.5;
  box(g, 0.85, 1.6, 0.1, flat(0x6b4f33), 0, 0.8, 1.22); // door
  box(g, 0.08, 0.08, 0.14, flat(0xd8d8dc), 0.3, 0.85, 1.26); // handle
  box(g, 0.7, 0.6, 0.08, flat(0x9cc4de), -0.9, 1.5, 1.22); // window
}

function buildPond(scene: THREE.Scene, pond: { x: number; z: number; r: number }): void {
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(pond.r, pond.r, 0.08, 20),
    new THREE.MeshStandardMaterial({ color: 0x3583b8, roughness: 0.25, transparent: true, opacity: 0.92 }),
  );
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

function buildSoccerGoal(scene: THREE.Scene, at: { x: number; z: number; rot: number }): void {
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
    const back = cyl(g, 0.03, 0.03, 1.7, "#c9ccd4", px, 0.6, -0.75, 6);
    back.rotation.x = 0.9;
  }
  box(g, 3.1, 0.02, 0.05, white, 0, 0.02, -1.5); // ground bar
  // chalk goal box on the lawn
  for (const [w, d, x, z] of [[4.4, 0.08, 0, 2.6], [0.08, 2.6, -2.2, 1.3], [0.08, 2.6, 2.2, 1.3]] as const) {
    box(g, w, 0.015, d, white, x, 0.01, z);
  }
}

function buildDoghouse(scene: THREE.Scene, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  box(g, 1.2, 0.9, 1.4, flat(0xa0522d), 0, 0.45, 0);
  const roofL = box(g, 0.75, 0.1, 1.6, flat(0x5a4a3a), -0.32, 1.1, 0);
  roofL.rotation.z = 0.55;
  const roofR = box(g, 0.75, 0.1, 1.6, flat(0x5a4a3a), 0.32, 1.1, 0);
  roofR.rotation.z = -0.55;
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 12, 1, false, 0, Math.PI), flat(0x1c1e24));
  arch.rotation.x = Math.PI / 2;
  arch.position.set(0, 0.42, 0.71);
  g.add(arch);
  box(g, 0.5, 0.42, 0.06, flat(0x1c1e24), 0, 0.24, 0.71); // dark doorway
}

function buildBirdbath(scene: THREE.Scene, at: { x: number; z: number }): void {
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.75, 8), flat(0xb5af9f));
  ped.position.set(at.x, 0.38, at.z);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.28, 0.16, 12), flat(0xb5af9f));
  bowl.position.set(at.x, 0.82, at.z);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12),
    new THREE.MeshStandardMaterial({ color: 0x6cc4e8, roughness: 0.2 }),
  );
  water.position.set(at.x, 0.88, at.z);
  scene.add(ped, bowl, water);
}

function buildClothesline(scene: THREE.Scene, at: { x: number; z: number; rot: number }): void {
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

function buildVeggieGarden(scene: THREE.Scene, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  for (const dz of [-0.8, 0.8]) {
    box(g, 3, 0.35, 1.1, flat(0x7a5b3a), 0, 0.18, dz);
    box(g, 2.8, 0.08, 0.9, flat(0x4a3826), 0, 0.36, dz); // soil
    for (let i = 0; i < 5; i++) {
      const sprout = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), flat(0x4a8a3f));
      sprout.position.set(-1.2 + i * 0.6, 0.52, dz);
      g.add(sprout);
    }
  }
}

function buildBench(scene: THREE.Scene, at: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rot;
  scene.add(g);
  const wood = flat(0x9a7047);
  for (const dy of [0, 0.09]) box(g, 1.5, 0.06, 0.2, wood, 0, 0.45 + dy * 0, -0.1 + dy * 2.2); // seat slats
  box(g, 1.5, 0.06, 0.2, wood, 0, 0.45, 0.1);
  for (const dy of [0.72, 0.88]) box(g, 1.5, 0.09, 0.05, wood, 0, dy, -0.26); // back slats
  for (const px of [-0.6, 0.6]) {
    box(g, 0.08, 0.45, 0.4, flat(0x3b3e45), px, 0.22, 0);
    box(g, 0.08, 0.55, 0.08, flat(0x3b3e45), px, 0.72, -0.26);
  }
}

function buildCloud(scene: THREE.Scene, c: { x: number; y: number; z: number; s: number }): void {
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

function buildSandpit(scene: THREE.Scene, pit: { x: number; z: number; r: number }): void {
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

function buildTrampoline(scene: THREE.Scene, tr: { x: number; z: number }): void {
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

function buildBbq(scene: THREE.Scene, bbq: { x: number; z: number; rot: number }): void {
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
  box(g, 0.55, 0.05, 0.35, flat(0x8d6b48), 0.55, 0.8, 0); // side shelf
}

function buildPicnicTable(scene: THREE.Scene, p: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  g.rotation.y = p.rot;
  scene.add(g);
  const wood = flat(0x9a7047);
  box(g, 1.7, 0.09, 0.9, wood, 0, 0.75, 0); // top
  for (const side of [-1, 1]) {
    box(g, 1.7, 0.07, 0.3, wood, 0, 0.45, side * 0.75); // benches
    const legs = box(g, 0.08, 0.8, 1.7, wood, side * 0.6, 0.38, 0);
    legs.rotation.x = side * 0.35;
  }
}

function buildMower(scene: THREE.Scene, m: { x: number; z: number; rot: number }): void {
  const g = new THREE.Group();
  g.position.set(m.x, 0, m.z);
  g.rotation.y = m.rot;
  scene.add(g);
  box(g, 0.5, 0.18, 0.7, flat(0xd94f3d), 0, 0.28, 0); // deck
  box(g, 0.28, 0.16, 0.3, flat(0x23262e), 0, 0.45, 0.05); // engine
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

function buildTree(scene: THREE.Scene, x: number, z: number, s: number, tireSwing: boolean): void {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  scene.add(g);
  const trunk = cyl(g, 0.16 * s, 0.24 * s, 2.6 * s, "#6b4f33", 0, 1.3 * s, 0, 8);
  trunk.rotation.y = x + z; // vary silhouette
  const leaf = flat(0x4a8a3f);
  const leaf2 = flat(0x548f46);
  for (const [cx, cy, cz, r] of [
    [0, 3.1 * s, 0, 1.55 * s],
    [0.9 * s, 2.7 * s, 0.3 * s, 1.1 * s],
    [-0.8 * s, 2.8 * s, -0.4 * s, 1.15 * s],
    [0.1 * s, 2.5 * s, 0.9 * s, 1.0 * s],
  ] as const) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 7), (cx + cz) * 7 % 2 < 1 ? leaf : leaf2);
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
  scene: THREE.Scene,
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
      leg.position.set(sx, 1.2, tilt * 2.4);
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
  const chute = box(slide, 0.7, 0.09, 2.6, barMat, 0, 1.05, 1.05);
  chute.rotation.x = -0.55;
  for (const cx of [-0.38, 0.38]) {
    const rail = box(slide, 0.06, 0.16, 2.6, barMat, cx, 1.15, 1.05);
    rail.rotation.x = -0.55;
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
  for (const px of [-1.4, 1.4]) {
    const grip = cyl(seesaw, 0.025, 0.025, 0.3, "#c9ccd4", px, 0.5 + Math.tan(0.22) * px + 0.18, 0, 6);
    grip.position.y = 0.5 + 0.22 * px + 0.2;
  }
  g.add(seesaw);
}

function buildHoop(scene: THREE.Scene, world: World): void {
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

function buildHedge(scene: THREE.Scene, x: number, z: number, s: number): void {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55 * s, 2.3 * s, 8), flat(0x2f5d31));
  cone.position.set(x, 1.15 * s, z);
  scene.add(cone);
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.5 * s, 8, 6), flat(0x37693a));
  base.position.set(x, 0.35 * s, z);
  base.scale.y = 0.7;
  scene.add(base);
}

function buildBed(scene: THREE.Scene, x: number, z: number, r: number, hue: number): void {
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
