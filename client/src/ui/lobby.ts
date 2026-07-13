/** Lobby overlay: landing (name + create/join) and the room panel. */

import {
  CREATE_SECS_DEFAULT,
  CREATE_SECS_MAX,
  CREATE_SECS_MIN,
  LOBBY_POLL_MS,
  MAX_PLAYERS,
  QUICK_AUTOSTART_MS,
  ROUND_SECS_DEFAULT,
  ROUND_SECS_MAX,
  ROUND_SECS_MIN,
  STAGES,
  clampStage,
  randomName,
  type LobbyRoomEntry,
  type MatchSettings,
  type PlayerInfo,
  type RoomTotals,
} from "@bringme/shared";
import { fetchLobbyList, pingRoom } from "../net/lobbyApi.ts";
import { storageGet, storageSet } from "../storage.ts";

export interface LobbyHandlers {
  /** create (or hash-join) — `pub` lists the new room on the public browser */
  onJoin(name: string, pub: boolean): void;
  /** join an existing room picked off the browse list */
  onJoinRoom(code: string, name: string): void;
  /** one-click public game topped up with bots; auto-starts after a countdown */
  onQuickGame(name: string): void;
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
  private stageVal = 0;
  // browse-panel state; the poll runs only while the panel is open
  private browseTimer = 0;
  private rooms: LobbyRoomEntry[] = [];
  private readonly latencies = new Map<string, number>();
  private readonly pinged = new Set<string>();
  // quick-room auto-start countdown; ticks the status line until the match begins
  private autoStartTimer = 0;
  private autoStartAt = 0;

  constructor(private readonly handlers: LobbyHandlers) {
    this.root = document.getElementById("lobby") as HTMLDivElement;
  }

  showLanding(code: string | null): void {
    const saved = storageGet(NAME_KEY) ?? "";
    this.root.style.display = "flex";
    this.root.innerHTML = `
      <div class="panel">
        <img class="wordmark" src="logo.png" alt="BRING ME!" />
        <p class="sub">hide your item then find them<br />faster than your friends do!</p>
        ${code ? `<p class="sub">joining room <b>${code}</b></p>` : ""}
        <input id="lb-name" maxlength="16" placeholder="your name" value="${escapeHtml(saved)}" />
        ${code ? "" : `<button id="lb-quick">⚡ quick game</button>`}
        ${code ? "" : `<label class="pubRow"><input id="lb-pub" type="checkbox" /> public room — anyone can join</label>`}
        <button id="lb-go" ${code ? "" : `class="ghost"`}>${code ? "join room" : "create room"}</button>
        ${code ? "" : `<button id="lb-browse" class="ghost">browse public rooms</button>
        <ul class="rooms" id="lb-roomlist" style="display: none"></ul>`}
        <div id="lb-status" class="status"></div>
      </div>`;
    this.status = this.root.querySelector("#lb-status");
    const nameInput = this.root.querySelector<HTMLInputElement>("#lb-name");
    const readName = (): string => (nameInput?.value ?? "").trim() || "slop";
    const go = (): void => {
      const name = readName();
      storageSet(NAME_KEY, name);
      this.stopBrowse();
      const pub = this.root.querySelector<HTMLInputElement>("#lb-pub")?.checked === true;
      this.handlers.onJoin(name, pub);
    };
    // quick game: name yourself if you haven't, then jump into a bot-filled
    // public match. A typed or previously-saved name is never overwritten.
    const quick = (): void => {
      let name = nameInput?.value.trim() ?? "";
      if (!name) {
        name = randomName(Math.random);
        if (nameInput) nameInput.value = name;
      }
      storageSet(NAME_KEY, name);
      this.stopBrowse();
      this.handlers.onQuickGame(name);
    };
    this.root.querySelector("#lb-quick")?.addEventListener("click", quick);
    this.root.querySelector("#lb-go")?.addEventListener("click", go);
    nameInput?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") go();
    });
    const browseBtn = this.root.querySelector<HTMLButtonElement>("#lb-browse");
    const roomList = this.root.querySelector<HTMLUListElement>("#lb-roomlist");
    browseBtn?.addEventListener("click", () => {
      if (!roomList) return;
      const open = roomList.style.display !== "none";
      roomList.style.display = open ? "none" : "flex";
      browseBtn.textContent = open ? "browse public rooms" : "hide public rooms";
      if (open) this.stopBrowse();
      else this.startBrowse(readName);
    });
    nameInput?.focus();
  }

  // ---------- public-room browser ----------

  private startBrowse(readName: () => string): void {
    if (this.browseTimer !== 0) return;
    const refresh = async (): Promise<void> => {
      this.rooms = await fetchLobbyList();
      this.renderRooms(readName);
      for (const r of this.rooms) {
        if (this.pinged.has(r.code)) continue; // one probe per room per visit
        this.pinged.add(r.code);
        void pingRoom(r.code).then((ms) => {
          this.latencies.set(r.code, ms);
          this.renderRooms(readName);
        });
      }
    };
    void refresh();
    this.browseTimer = window.setInterval(() => void refresh(), LOBBY_POLL_MS);
  }

  private stopBrowse(): void {
    if (this.browseTimer === 0) return;
    clearInterval(this.browseTimer);
    this.browseTimer = 0;
  }

  private renderRooms(readName: () => string): void {
    const list = this.root.querySelector<HTMLUListElement>("#lb-roomlist");
    if (!list) return;
    if (this.rooms.length === 0) {
      list.innerHTML = `<li class="empty">no public rooms right now — create one!</li>`;
      return;
    }
    list.innerHTML = this.rooms
      .map((r) => {
        const ms = this.latencies.get(r.code);
        const lat = ms === undefined ? "…" : ms < 0 ? "?" : `~${Math.round(ms)}ms`;
        const full = r.players >= MAX_PLAYERS;
        const meta = `${r.players}/${MAX_PLAYERS} · ${full ? "full" : r.status === "lobby" ? "in lobby" : "in match"} · ${lat}`;
        return `<li><button class="roomRow" data-code="${escapeHtml(r.code)}" ${full ? "disabled" : ""}>
          <span class="rhost">${escapeHtml(r.hostName)}'s room</span>
          <span class="rmeta">${meta}</span>
        </button></li>`;
      })
      .join("");
    list.querySelectorAll<HTMLButtonElement>(".roomRow").forEach((btn) => {
      btn.addEventListener("click", () => {
        const roomCode = btn.dataset["code"] ?? "";
        if (!roomCode) return;
        const name = readName();
        storageSet(NAME_KEY, name);
        this.stopBrowse();
        this.handlers.onJoinRoom(roomCode, name);
      });
    });
  }

  showRoom(code: string, players: PlayerInfo[], isHost: boolean, settings: MatchSettings, totals: RoomTotals = {}, isPublic = false): void {
    this.stopBrowse();
    this.root.style.display = "flex";
    this.root.innerHTML = `
      <div class="panelRow">
      <div class="panel">
        <h1>ROOM ${code}</h1>
        ${isPublic ? `<p class="sub">public room — listed in the room browser</p>` : ""}
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
        <div class="stageRow">
          <span class="stageLabel">stage</span>
          <div class="stages" id="lb-stages">
            ${STAGES.map((s, i) => `<button class="stageBtn" data-stage="${i}" ${isHost ? "" : "disabled"}>${s.name}</button>`).join("")}
          </div>
        </div>
        <button id="lb-start" disabled>…</button>
        <div id="lb-status" class="status"></div>
      </div>
      ${renderScoreboard(totals)}
      </div>`;
    this.status = this.root.querySelector("#lb-status");
    this.playerList = this.root.querySelector("#lb-players");
    this.startBtn = this.root.querySelector("#lb-start");
    this.createInput = this.root.querySelector("#lb-create");
    this.roundInput = this.root.querySelector("#lb-round");
    this.stageVal = clampStage(settings.stage);
    this.root.querySelectorAll<HTMLButtonElement>(".stageBtn").forEach((btn) => {
      btn.addEventListener("click", () => this.setStageSel(Number(btn.dataset["stage"])));
    });
    this.markStage();

    const copyBtn = this.root.querySelector<HTMLButtonElement>("#lb-copy");
    let copyTimer = 0;
    copyBtn?.addEventListener("click", () => {
      // itch build: the page URL is itch's CDN iframe — hand out the canonical
      // web build's URL instead (both builds join the same rooms)
      const env = (import.meta as { env?: Record<string, string | undefined> }).env;
      const base = env?.VITE_INVITE_URL || `${location.origin}${location.pathname}`;
      const link = `${base}#/r/${code}`;
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
    // host can migrate mid-lobby (original host left) — controls must follow
    if (this.createInput) this.createInput.disabled = !isHost;
    if (this.roundInput) this.roundInput.disabled = !isHost;
    this.root.querySelectorAll<HTMLButtonElement>(".stageBtn").forEach((b) => (b.disabled = !isHost));
    if (this.createInput && !isHost) this.createInput.value = String(settings.createSecs);
    if (this.roundInput && !isHost) this.roundInput.value = String(settings.roundSecs);
    if (!isHost) this.setStageSel(clampStage(settings.stage));
  }

  private setStageSel(stage: number): void {
    this.stageVal = clampStage(stage);
    this.markStage();
  }

  private markStage(): void {
    this.root.querySelectorAll<HTMLButtonElement>(".stageBtn").forEach((btn) => {
      btn.classList.toggle("sel", Number(btn.dataset["stage"]) === this.stageVal);
    });
  }

  /** Start needs a host AND someone to play against. */
  private refreshStart(players: PlayerInfo[], isHost: boolean): void {
    if (!this.startBtn) return;
    if (players.length < 2) {
      this.startBtn.disabled = true;
      this.startBtn.textContent = "waiting for players…";
    } else {
      this.startBtn.disabled = !isHost;
      this.startBtn.textContent = isHost ? "start" : "waiting for host…";
    }
  }

  readSettings(): MatchSettings {
    return {
      createSecs: Number(this.createInput?.value) || CREATE_SECS_DEFAULT,
      roundSecs: Number(this.roundInput?.value) || ROUND_SECS_DEFAULT,
      stage: this.stageVal,
    };
  }

  setStatus(text: string): void {
    if (this.status) this.status.textContent = text;
  }

  /**
   * Drive the quick-room self-start countdown on the status line. `startsAt` is
   * the server's epoch-ms deadline; undefined/past clears it. Re-reads the
   * status element each tick, so it survives showRoom rebuilds.
   */
  setAutoStart(startsAt: number | undefined): void {
    if (this.autoStartTimer !== 0) {
      clearInterval(this.autoStartTimer);
      this.autoStartTimer = 0;
    }
    this.autoStartAt = startsAt && startsAt > Date.now() ? startsAt : 0;
    if (this.autoStartAt === 0) return;
    const render = (): void => {
      // clamp to the configured window so clock skew can't ever show 6s for a
      // 5s countdown — it always begins at exactly QUICK_AUTOSTART_MS seconds
      const secs = Math.min(
        Math.ceil(QUICK_AUTOSTART_MS / 1000),
        Math.ceil((this.autoStartAt - Date.now()) / 1000),
      );
      if (secs <= 0) {
        clearInterval(this.autoStartTimer);
        this.autoStartTimer = 0;
        return;
      }
      this.setStatus(`starting in ${secs}s…`);
    };
    render();
    this.autoStartTimer = window.setInterval(render, 500);
  }

  hide(): void {
    this.stopBrowse(); // never leak the poll into the game
    this.setAutoStart(undefined); // never leak the countdown into the game
    this.root.style.display = "none";
  }

  private renderPlayers(players: PlayerInfo[]): void {
    if (!this.playerList) return;
    this.playerList.innerHTML = players
      .map((p) => `<li>${p.isHost ? "👑 " : ""}${escapeHtml(p.name)}</li>`)
      .join("");
  }
}

/**
 * Room-lifetime standings beside the room card — only once a game has been
 * played. Top three get their medals; everyone else gets a plain rank.
 */
function renderScoreboard(totals: RoomTotals): string {
  const rows = Object.values(totals).sort((a, b) => b.pts - a.pts);
  if (rows.length === 0) return "";
  const line = (r: { name: string; pts: number }, i: number): string => {
    const rank = ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
    return `<li><span class="medal">${rank}</span><span class="sname">${escapeHtml(r.name)}</span><span class="pts">${Math.round(r.pts)}</span></li>`;
  };
  return `
    <div class="panel scoreboard">
      <h2>STANDINGS</h2>
      <ul>${rows.map(line).join("")}</ul>
      <div class="subtle">totals across games in this room</div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
