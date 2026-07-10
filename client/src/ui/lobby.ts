/** Lobby overlay: landing (name + create/join) and the room panel. */

import {
  CREATE_SECS_DEFAULT,
  CREATE_SECS_MAX,
  CREATE_SECS_MIN,
  ROUND_SECS_DEFAULT,
  ROUND_SECS_MAX,
  ROUND_SECS_MIN,
  type MatchSettings,
  type PlayerInfo,
} from "@bringme/shared";

export interface LobbyHandlers {
  onJoin(name: string): void;
  onStart(settings: MatchSettings): void;
}

const NAME_KEY = "bringme_name";

export class LobbyUI {
  private readonly root: HTMLDivElement;
  private status: HTMLDivElement | null = null;
  private playerList: HTMLUListElement | null = null;
  private startBtn: HTMLButtonElement | null = null;
  private createInput: HTMLInputElement | null = null;
  private roundInput: HTMLInputElement | null = null;

  constructor(private readonly handlers: LobbyHandlers) {
    this.root = document.getElementById("lobby") as HTMLDivElement;
  }

  showLanding(code: string | null): void {
    const saved = localStorage.getItem(NAME_KEY) ?? "";
    this.root.style.display = "flex";
    this.root.innerHTML = `
      <div class="panel">
        <h1>BRING ME</h1>
        <p class="sub">${code ? `joining room <b>${code}</b>` : "hide it well. find it first."}</p>
        <input id="lb-name" maxlength="16" placeholder="your name" value="${saved}" />
        <button id="lb-go">${code ? "Join room" : "Create room"}</button>
        <div id="lb-status" class="status"></div>
      </div>`;
    this.status = this.root.querySelector("#lb-status");
    const nameInput = this.root.querySelector<HTMLInputElement>("#lb-name");
    const go = (): void => {
      const name = (nameInput?.value ?? "").trim() || "slop";
      localStorage.setItem(NAME_KEY, name);
      this.handlers.onJoin(name);
    };
    this.root.querySelector("#lb-go")?.addEventListener("click", go);
    nameInput?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") go();
    });
    nameInput?.focus();
  }

  showRoom(code: string, players: PlayerInfo[], isHost: boolean, settings: MatchSettings): void {
    this.root.style.display = "flex";
    this.root.innerHTML = `
      <div class="panel">
        <h1>ROOM ${code}</h1>
        <button id="lb-copy" class="ghost">copy invite link</button>
        <ul id="lb-players"></ul>
        <div class="settings">
          <label>create time (s)
            <input id="lb-create" type="number" min="${CREATE_SECS_MIN}" max="${CREATE_SECS_MAX}" value="${settings.createSecs}" ${isHost ? "" : "disabled"} />
          </label>
          <label>round time (s)
            <input id="lb-round" type="number" min="${ROUND_SECS_MIN}" max="${ROUND_SECS_MAX}" value="${settings.roundSecs}" ${isHost ? "" : "disabled"} />
          </label>
        </div>
        <button id="lb-start" disabled>…</button>
        <div id="lb-status" class="status"></div>
      </div>`;
    this.status = this.root.querySelector("#lb-status");
    this.playerList = this.root.querySelector("#lb-players");
    this.startBtn = this.root.querySelector("#lb-start");
    this.createInput = this.root.querySelector("#lb-create");
    this.roundInput = this.root.querySelector("#lb-round");

    const copyBtn = this.root.querySelector<HTMLButtonElement>("#lb-copy");
    let copyTimer = 0;
    copyBtn?.addEventListener("click", () => {
      const link = `${location.origin}${location.pathname}#/r/${code}`;
      void navigator.clipboard.writeText(link).then(() => {
        copyBtn.classList.remove("copied");
        void copyBtn.offsetWidth; // restart the pop animation on rapid re-clicks
        copyBtn.classList.add("copied");
        copyBtn.textContent = "✓ link copied!";
        clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.textContent = "copy invite link";
        }, 1600);
      });
    });
    this.startBtn?.addEventListener("click", () => this.handlers.onStart(this.readSettings()));
    this.renderPlayers(players);
    this.refreshStart(players, isHost);
  }

  updatePlayers(players: PlayerInfo[], isHost: boolean, settings: MatchSettings): void {
    this.renderPlayers(players);
    this.refreshStart(players, isHost);
    if (this.createInput && !isHost) this.createInput.value = String(settings.createSecs);
    if (this.roundInput && !isHost) this.roundInput.value = String(settings.roundSecs);
  }

  /** Start needs a host AND someone to play against. */
  private refreshStart(players: PlayerInfo[], isHost: boolean): void {
    if (!this.startBtn) return;
    if (players.length < 2) {
      this.startBtn.disabled = true;
      this.startBtn.textContent = "waiting for players…";
    } else {
      this.startBtn.disabled = !isHost;
      this.startBtn.textContent = isHost ? "Start" : "waiting for host…";
    }
  }

  readSettings(): MatchSettings {
    return {
      createSecs: Number(this.createInput?.value) || CREATE_SECS_DEFAULT,
      roundSecs: Number(this.roundInput?.value) || ROUND_SECS_DEFAULT,
    };
  }

  setStatus(text: string): void {
    if (this.status) this.status.textContent = text;
  }

  hide(): void {
    this.root.style.display = "none";
  }

  private renderPlayers(players: PlayerInfo[]): void {
    if (!this.playerList) return;
    this.playerList.innerHTML = players
      .map((p) => `<li>${p.isHost ? "👑 " : ""}${escapeHtml(p.name)}</li>`)
      .join("");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
