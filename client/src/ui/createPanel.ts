/** CREATE-phase panel: pick an archetype, tweak hue/scale, place your object. */

import { ARCHETYPES, SCALE_MAX, SCALE_MIN, type PropParams } from "@bringme/shared";

export interface CreateSelection {
  archetype: string;
  params: PropParams;
}

export class CreatePanel {
  private readonly root: HTMLDivElement;
  private sel: CreateSelection = { archetype: ARCHETYPES[0].id, params: { hue: 0, scale: 1 } };
  private statusEl: HTMLDivElement | null = null;

  constructor(
    private readonly onChange: (sel: CreateSelection) => void,
    private readonly onPlace: () => void,
  ) {
    this.root = document.getElementById("createPanel") as HTMLDivElement;
  }

  current(): CreateSelection {
    return { archetype: this.sel.archetype, params: { ...this.sel.params } };
  }

  show(): void {
    this.root.style.display = "block";
    this.root.innerHTML = `
      <h3>CREATE YOUR OBJECT — hide it well!</h3>
      <div class="grid">
        ${ARCHETYPES.map(
          (a) => `<button data-arch="${a.id}"${a.id === this.sel.archetype ? ' class="sel"' : ""}>${a.name}</button>`,
        ).join("")}
      </div>
      <label>color <input id="cp-hue" type="range" min="0" max="359" value="${this.sel.params.hue}" /></label>
      <label>size <input id="cp-scale" type="range" min="${SCALE_MIN}" max="${SCALE_MAX}" step="0.05" value="${this.sel.params.scale}" /></label>
      <button class="place" id="cp-place">Place here (P)</button>
      <div class="status" id="cp-status">walk around — the ghost shows where it lands</div>`;
    this.statusEl = this.root.querySelector("#cp-status");

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-arch]")) {
      btn.addEventListener("click", () => {
        this.sel.archetype = btn.dataset["arch"] ?? this.sel.archetype;
        for (const b of this.root.querySelectorAll("[data-arch]")) b.classList.remove("sel");
        btn.classList.add("sel");
        this.onChange(this.current());
      });
    }
    this.root.querySelector<HTMLInputElement>("#cp-hue")?.addEventListener("input", (e) => {
      this.sel.params.hue = Number((e.target as HTMLInputElement).value);
      this.onChange(this.current());
    });
    this.root.querySelector<HTMLInputElement>("#cp-scale")?.addEventListener("input", (e) => {
      this.sel.params.scale = Number((e.target as HTMLInputElement).value);
      this.onChange(this.current());
    });
    this.root.querySelector("#cp-place")?.addEventListener("click", () => this.onPlace());
    this.onChange(this.current());
  }

  setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  hide(): void {
    this.root.style.display = "none";
  }

  visible(): boolean {
    return this.root.style.display !== "none" && this.root.style.display !== "";
  }
}
