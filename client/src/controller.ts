import { Board } from "./board.ts";
import { Session } from "./session.ts";
import { PROXY_URL, PROXY_TOKEN } from "./proxy.ts";
import { rememberedCredentials, rememberCredentials } from "./credentials.ts";
import {
  rememberedTimeControl,
  rememberTimeControl,
} from "./time-preference.ts";
import { preloadLocalEstimate } from "../../score-estimator/src/local-score-estimation.ts";
import { FoxSounds } from "./sound.ts";
import { ByoyomiAnnouncements, recordedClocks } from "./clock.ts";
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
  previewCoordinates = false;
  private listeners = new Set<() => void>();
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private clockTimer?: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;
  private suppress = false;
  private assetsStarted = false;
  private pendingCredentials?: { username: string; password: string; remember: boolean };

  constructor() {
    this.session = new Session({
      proxyUrl: PROXY_URL,
      proxyToken: PROXY_TOKEN,
      preferredTimeControl: rememberedTimeControl(),
      onSound: (name: string) => {
        // Session sounds can arrive before its batched UI update (game start).
        this.sounds.setActive(this.session.phase === "playing" && !this.session.gameOver);
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
      menuError = "",
      error = "";
    let variation: [number, number][] | undefined;
    if (import.meta.env.DEV) {
      const screen = new URLSearchParams(location.search).get("dev-screen");
      if (screen) {
        const { applyDevScreen } = await import("./dev-screens.ts");
        const fixture = await applyDevScreen(this.session, screen);
        this.preview = !!fixture;
        this.previewCoordinates = fixture?.fixture.coordinates ?? false;
        variation = fixture?.fixture.variation;
        prompt = fixture?.prompt ?? null;
        menuError = fixture?.menuError ?? "";
        error = fixture?.boardError ?? "";
      }
    }
    const saved = rememberedCredentials();
    this.password = saved?.password ?? "";
    const session = this.snapshot();
    this.emit({
      type: "initialize",
      state: {
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
    if (variation) {
      this.review("previous");
      for (const [x, y] of variation) this.playVariation(x, y);
    }
    this.preloadGameplayAssets(session);
    this.audio();
    this.scheduleClock();
  }
  private preloadGameplayAssets(session: SessionState) {
    if (this.assetsStarted || !["ready", "matching", "joining", "playing", "finished", "reconnecting"].includes(session.phase)) return;
    this.assetsStarted = true;
    this.sounds.preload();
    void preloadLocalEstimate().catch(() => {});
  }
  emit(event: UIEvent) {
    if (this.suppress) return;
    this.state = reducer(this.state, event);
    for (const listener of this.listeners) listener();
  }
  private sync(session: SessionState) {
    if (!this.state || this.suppress) return;
    if (this.pendingCredentials && this.session.uid && this.session.token.length) {
      const { username, password, remember } = this.pendingCredentials;
      this.pendingCredentials = undefined;
      if (!this.preview) rememberCredentials(username, password, remember);
    } else if (["error", "disconnected"].includes(session.phase)) {
      this.pendingCredentials = undefined;
    }
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
    this.preloadGameplayAssets(session);
    this.audio();
    this.scheduleClock();
  }
  audio() {
    const s = this.state.session;
    this.sounds.setActive(s.phase === "playing" && !s.game_over);
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
      (!s.clocks[s.turn] && s.opponentDisconnectDeadline == null)
    )
      return;
    this.clockTimer = setTimeout(() => {
      const time = Date.now() / 1000;
      if (this.session.tickClock(time))
        this.emit({ type: "session.updated", session: this.snapshot() });
      this.emit({ type: "clock.tick", now: time });
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
    if (this.pendingCredentials && !value) this.pendingCredentials.remember = false;
    if (!this.preview && !value) rememberCredentials("", "", false);
  }
  command(
    command: Command,
    body: { x?: number; y?: number; id?: number; accept?: boolean } = {},
  ) {
    if (command === "play" && this.state.session.phase === "finished" && this.state.session.game_over) {
      if (body.x !== undefined && body.y !== undefined) this.playVariation(body.x, body.y);
      return;
    }
    if (this.state.session.phase === "reconnecting" && command !== "disconnect") return;
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
          this.pendingCredentials = { username, password, remember };
          this.session.login(username, password);
          break;
        case "disconnect":
          this.session.close();
          break;
        case "quit-room":
          this.session.quitRoom();
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
          void this.session.estimateScore(this.state.review ?? undefined);
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
      if (command === "login") this.pendingCredentials = undefined;
      this.raise(error instanceof Error ? error.message : String(error));
    } finally {
      this.session.flushChanges();
    }
  }
  private reviewBoard(move: number, variation?: NonNullable<UIState["review"]>["variation"]) {
    const board = new Board(this.session.board.size);
    const numbers: Record<number, number> = {};
    const moves = this.session.board.moves.slice(0, variation?.origin ?? move);
    if (variation) moves.push(...variation.moves.slice(0, variation.cursor));
    moves.forEach(([color, x, y], index) => {
      if (x === null || y === null) board.passTurn(color);
      else {
        board.play(x, y, color);
        for (const point of Object.keys(numbers))
          if (!board.stones[Number(point)]) delete numbers[Number(point)];
        if (variation && index >= variation.origin)
          numbers[y * board.size + x] = index - variation.origin + 1;
      }
    });
    return { board, numbers };
  }
  private showReview(board: Board, variation?: NonNullable<UIState["review"]>["variation"], moveNumbers?: Record<number, number>) {
    this.session.clearEstimate();
    this.emit({ type: "review.position", position: {
      stones: board.stones,
      captures: board.captures,
      turn: board.turn,
      passes: board.passes,
      moves: board.moves.length,
      last_move: board.moves.at(-1) ?? null,
      koStones: board.history.at(-1) ?? null,
      clocks: recordedClocks(this.session.board, variation?.origin ?? board.moves.length),
      totalPeriods: this.session.board.timeControl?.periods,
      variation,
      moveNumbers,
    } });
    this.session.changed();
    this.session.flushChanges();
  }
  playVariation(x: number, y: number) {
    const s = this.state.session;
    if (s.phase !== "finished" || !s.game_over || !boardAvailable(s) || s.estimation || this.state.prompt) return;
    const current = this.state.review;
    const origin = current?.variation?.origin ?? current?.moves ?? s.moves;
    const previous = current?.variation;
    const variation = {
      origin,
      moves: previous?.moves.slice(0, previous.cursor) ?? [],
      cursor: (previous?.cursor ?? 0) + 1,
    };
    const { board } = this.reviewBoard(current?.moves ?? s.moves, previous);
    try { board.play(x, y); } catch { return; }
    variation.moves.push(board.moves.at(-1)!);
    const position = this.reviewBoard(board.moves.length, variation);
    this.showReview(position.board, variation, position.numbers);
  }
  review(direction: "first" | "previous" | "next" | "last" | "main") {
    const s = this.state.session;
    if (s.phase !== "finished" || !s.game_over || !boardAvailable(s) || s.estimation) return;
    const total = this.session.board.moves.length;
    const current = this.state.review?.moves ?? total;
    const variation = this.state.review?.variation;
    if (variation) {
      if (direction === "last") return;
      if (direction === "main" || direction === "first" ||
          (direction === "previous" && variation.cursor === 1)) {
        this.showReview(this.reviewBoard(variation.origin).board);
        return;
      }
      const cursor = Math.min(variation.moves.length, variation.cursor + (direction === "next" ? 1 : -1));
      if (cursor === variation.cursor) return;
      const updated = { ...variation, cursor };
      const position = this.reviewBoard(current, updated);
      this.showReview(position.board, updated, position.numbers);
      return;
    }
    if (direction === "main") return;
    const move = direction === "first" ? 0 : direction === "last" ? total
      : Math.max(0, Math.min(total, current + (direction === "next" ? 1 : -1)));
    if (move !== current) this.showReview(this.reviewBoard(move).board);
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
  async save(format: "sgf" | "network-log") {
    const date = new Date(),
      pad = (value: number) => String(value).padStart(2, "0"),
      timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
    if (format === "network-log")
      download(
        await this.session.networkLog.serialize(),
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
    this.pendingCredentials = undefined;
    clearTimeout(this.clockTimer);
    clearTimeout(this.errorTimer);
    this.suppress = true;
    this.session.close();
    void this.session.networkLog.flush();
    this.sounds.stopVoice();
    this.sounds.setActive(false);
  }
}
