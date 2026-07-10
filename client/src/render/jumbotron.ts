import * as THREE from "three";
import type { World } from "@bringme/shared";

/**
 * The in-world "BRING ME" screen at the plaza. Modes: idle / countdown /
 * reveal (object name + swatch, with a spinning 3D preview of the target
 * floating in front) / win. Text is drawn on a CanvasTexture.
 */
export class Jumbotron {
  readonly group = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly previewSlot = new THREE.Group();
  private preview: THREE.Object3D | null = null;
  private lastCountdown = -1;
  private lastDraw: ((c: CanvasRenderingContext2D, w: number, h: number) => void) | null = null;

  constructor(world: World) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 256;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx2d = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2d38, flatShading: true });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(6.6, 3.6, 0.4), frameMat);
    frame.position.y = 4.2;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 3),
      new THREE.MeshBasicMaterial({ map: this.texture }),
    );
    screen.position.set(0, 4.2, 0.21);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3, 0.35), frameMat);
      post.position.set(2.6 * side, 1.5, 0);
      this.group.add(post);
    }
    this.previewSlot.position.set(0, 2.2, 1.4);
    this.group.add(frame, screen, this.previewSlot);

    this.group.position.set(world.plaza.x, 0, world.plaza.z);
    this.group.rotation.y = world.plaza.facing;
    this.setIdle();
    // canvas text ignores webfonts until they load — redraw once Baloo 2 is in
    void document.fonts.ready.then(() => {
      if (this.lastDraw) this.draw(this.lastDraw);
    });
  }

  private draw(fn: (c: CanvasRenderingContext2D, w: number, h: number) => void): void {
    this.lastDraw = fn;
    const c = this.ctx2d;
    const { width: w, height: h } = this.canvas;
    c.fillStyle = "#10131c";
    c.fillRect(0, 0, w, h);
    c.textAlign = "center";
    c.textBaseline = "middle";
    fn(c, w, h);
    this.texture.needsUpdate = true;
  }

  setIdle(): void {
    this.lastCountdown = -1;
    this.setPreview(null);
    this.draw((c, w, h) => {
      c.fillStyle = "#ffd23f";
      c.font = "bold 72px 'Baloo 2', system-ui, sans-serif";
      c.fillText("BRING ME", w / 2, h / 2 - 14);
      c.fillStyle = "#8892a8";
      c.font = "26px 'Baloo 2', system-ui, sans-serif";
      c.fillText("press T for a practice round", w / 2, h / 2 + 52);
    });
  }

  setCountdown(secondsLeft: number): void {
    const s = Math.max(0, Math.ceil(secondsLeft));
    if (s === this.lastCountdown) return;
    this.lastCountdown = s;
    this.setPreview(null);
    this.draw((c, w, h) => {
      c.fillStyle = "#8892a8";
      c.font = "30px 'Baloo 2', system-ui, sans-serif";
      c.fillText("get ready…", w / 2, 52);
      c.fillStyle = "#f2efe6";
      c.font = "bold 130px 'Baloo 2', system-ui, sans-serif";
      c.fillText(String(s), w / 2, h / 2 + 30);
    });
  }

  /** Flash a picture of the actual target object (no name, no color hex). */
  setReveal(shot: HTMLCanvasElement, preview: THREE.Object3D | null): void {
    this.lastCountdown = -1;
    this.setPreview(preview);
    this.draw((c, w, h) => {
      c.fillStyle = "#ffd23f";
      c.font = "bold 56px 'Baloo 2', system-ui, sans-serif";
      c.fillText("BRING ME!", w / 2, 44);
      const s = h - 90;
      c.drawImage(shot, w / 2 - s / 2, 76, s, s);
    });
  }

  setWin(text: string): void {
    this.lastCountdown = -1;
    this.draw((c, w, h) => {
      c.fillStyle = "#7dd87d";
      c.font = "bold 56px 'Baloo 2', system-ui, sans-serif";
      c.fillText(text, w / 2, h / 2);
    });
  }

  private setPreview(obj: THREE.Object3D | null): void {
    if (this.preview) this.previewSlot.remove(this.preview);
    this.preview = obj;
    if (obj) {
      obj.position.set(0, 0, 0);
      obj.scale.multiplyScalar(1.6);
      this.previewSlot.add(obj);
    }
  }

  update(dt: number): void {
    if (this.preview) this.preview.rotation.y += dt * 1.8;
  }
}
