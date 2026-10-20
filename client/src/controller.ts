import { Session } from "./session.ts";
import { PROXY_URL, PROXY_TOKEN } from "./proxy.ts";
import { rememberedCredentials, rememberCredentials } from "./credentials.ts";
import {
  rememberedTimeControl,
  rememberTimeControl,
} from "./time-preference.ts";
import { FoxSounds } from "./sound.ts";
import { ByoyomiAnnouncements } from "./clock.ts";
import {
  reducer,
  boardAvailable,
  outOfTurn,
  type UIState,
  type UIEvent,
  type SessionState,
  type Command,
} from "./state";

function download(contents: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class Controller {
  readonly session: Session;
  readonly sounds = new FoxSounds();
  readonly announcements = new ByoyomiAnnouncements((name: string) =>
    this.sounds.play(name),
  );
  state!: UIState;
  password = "";
  preview = false;
  private listeners = new Set<() => void>();
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private clockTimer?: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;
  private suppress = false;

  constructor() {
    this.session = new Session({
      proxyUrl: PROXY_URL,
      proxyToken: PROXY_TOKEN,
      preferredTimeControl: rememberedTimeControl(),
      onSound: (name: string) => {
        this.sounds.play(name);
      },
      onChange: (state) => this.sync(state),
    });
  }
  snapshot(): SessionState {
    return this.session.snapshot();
  }
  async initialize() {
    let prompt: UIState["prompt"] = null,
      roomMenuOpen = false,
      menuError = "",
      error = "";
    if (import.meta.env.DEV) {
      const screen = new URLSearchParams(location.search).get("dev-screen");
      if (screen) {
        const { applyDevScreen } = await import("./dev-screens.ts");
        const fixture = await applyDevScreen(this.session, screen);
        this.preview = !!fixture;
        prompt = fixture?.prompt ?? null;
        menuError = fixture?.menuError ?? "";
        error = fixture?.boardError ?? "";
        roomMenuOpen = fixture?.roomMenuOpen ?? false;
      }
    }
    const saved = rememberedCredentials();
    this.password = saved?.password ?? "";
    const session = this.snapshot();
    this.emit({
      type: "initialize",
      state: {
        roomMenuOpen,
        session,
        now: Date.now() / 1000,
        frozen: this.preview,
        preview: null,
        prompt,
        menuError,
        error,
        focused: null,
        form: {
          username: saved?.username ?? "",
          passwordLength: this.password.length,
          remember: !!saved,
        },
      },
    });
    this.scheduleClock();
  }
  emit(event: UIEvent) {
    if (this.suppress) return;
    this.state = reducer(this.state, event);
    for (const listener of this.listeners) listener();
  }
  private sync(session: SessionState) {
    if (!this.state || this.suppress) return;
    const wasAvailable = boardAvailable(this.state.session);
    this.emit({ type: "session.updated", session });
    if (
      wasAvailable &&
      !boardAvailable(session) &&
      ["disconnected", "error"].includes(session.phase)
    ) {
      const saved = rememberedCredentials();
      if (saved) {
        this.emit({ type: "form.username", value: saved.username });
        this.editPassword(saved.password);
        this.emit({ type: "form.remember", value: true });
      }
    }
    this.audio();
    this.scheduleClock();
  }
  audio() {
    const s = this.state.session;
    this.announcements.update(s, this.state.now);
    if (s.phase !== "playing") this.sounds.stopVoice();
    else if (s.turn !== s.color || s.pending) this.sounds.stopCountdown();
  }
  scheduleClock() {
    clearTimeout(this.clockTimer);
    const s = this.state.session;
    if (
      this.preview ||
      s.phase !== "playing" ||
      !s.clocks[s.turn]
    )
      return;
    this.clockTimer = setTimeout(() => {
      this.emit({ type: "clock.tick", now: Date.now() / 1000 });
      this.audio();
      this.scheduleClock();
    }, 250);
  }
  editPassword(value: string) {
    this.password = value;
    this.emit({ type: "form.password", length: value.length });
  }
  remember(value: boolean) {
    this.emit({ type: "form.remember", value });
    if (!this.preview && !value) rememberCredentials("", "", false);
  }
  command(
    command: Command,
    body: { x?: number; y?: number; id?: number; accept?: boolean } = {},
  ) {
    if (outOfTurn({
      phase: this.session.phase,
      color: this.session.color,
      turn: this.session.board.turn,
    }, command)) return;
    if (this.state.prompt?.action === "resign" && command !== "resign") return;
    const { username, remember } = this.state.form,
      password = this.password;
    if (command === "login" && (!username.trim() || !password)) return;
    this.emit({ type: "command" });
    try {
      switch (command) {
        case "login":
          if (!this.preview) rememberCredentials(username, password, remember);
          this.session.login(username, password);
          break;
        case "disconnect":
          this.session.close();
          break;
        case "quit-room":
          if (this.session.phase === "finished")
            this.emit({ type: "room-menu.open" });
          else this.session.quitRoom();
          break;
        case "select-time":
          if (body.id === undefined) throw Error("Missing time control");
          this.session.selectMatchField(body.id);
          if (!this.preview && this.session.matchSettings)
            rememberTimeControl(this.session.matchSettings);
          break;
        case "match":
          this.session.match();
          break;
        case "cancel":
          this.session.cancelMatch();
          break;
        case "estimate-score":
          void this.session.estimateScore();
          break;
        case "return-game":
          this.session.returnToGame();
          break;
        case "request-score":
          this.session.requestCounting();
          break;
        case "confirm":
          if (body.accept === undefined)
            throw Error("Missing confirmation answer");
          this.session.confirm(body.accept);
          break;
        case "play":
          if (body.x === undefined || body.y === undefined)
            throw Error("Missing move coordinates");
          this.session.play(body.x, body.y);
          break;
        case "pass":
          this.session.passTurn();
          break;
        case "resign":
          this.session.resign();
          break;
      }
    } catch (error) {
      this.raise(error instanceof Error ? error.message : String(error));
    } finally {
      this.session.flushChanges();
    }
  }
  raise(message: string) {
    this.emit({
      type: "error.raised",
      message,
      menu: !boardAvailable(this.state.session),
    });
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(
      () => this.emit({ type: "error.dismissed" }),
      5000,
    );
  }
  save(format: "sgf" | "network-log") {
    const date = new Date(),
      pad = (value: number) => String(value).padStart(2, "0"),
      timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
    if (format === "network-log")
      download(
        this.session.networkLog.serialize(),
        "application/json",
        `fox-network-log-${timestamp}.json`,
      );
    else if (this.session.gameOver) {
      const black = this.session.players[1]?.name || "Black",
        white = this.session.players[2]?.name || "White",
        local = this.session.color === 2 ? white : black,
        remote = this.session.color === 2 ? black : white,
        filenamePart = (name: string) => name.replace(/[\\/<>:"|?*\u0000-\u001f]/g, "_");
      download(
        this.session.board.sgf(
          this.session.result,
          black,
          white,
          this.session.komi,
        ),
        "application/x-go-sgf",
        `${filenamePart(local)}-${filenamePart(remote)}-${timestamp}.sgf`,
      );
    }
  }
  dispose() {
    clearTimeout(this.clockTimer);
    clearTimeout(this.errorTimer);
    this.suppress = true;
    this.session.close();
    this.session.networkLog.flush();
    this.sounds.stopVoice();
  }
}
