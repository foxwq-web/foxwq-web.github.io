import { persistenceAllowed, setPersistenceAllowed } from "./persistence";
import { parseRoomId, PC_LOBBY } from "./room-id";
import { Board } from "./board.ts";
import { parseSgf, fetchGameSgf } from "./sgf.ts";
import { livePaths, navigateTo, recordedGameId, reviewPath } from "./routes.ts";
import { logError } from "./error-message";
import { Session } from "./session.ts";
import { readArchivePosition, archivePositionUrl, type ArchivePosition } from "./archive-position";
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
  isLoginStep,
  quitRoomPrompt,
  reviewAvailable,
  outOfTurn,
  type UIState,
  type UIEvent,
  type SessionState,
  type Command,
} from "./state";

function liveScreen(session: SessionState) {
  return boardAvailable(session) ? 2 : isLoginStep(session) ? 0 : 1;
}

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
  recordedGame?: { id: string; sgf: string; initialBoard: Board };
  preparedArchive?: Controller;
  private listeners = new Set<() => void>();
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private clockTimer?: ReturnType<typeof setTimeout>;
  private suppress = false;
  private assetsStarted = false;
  private initializing = false;
  private archiveConversion = "";
  private reviewingFinishedGame = false;
  private returningThroughHistory = false;
  private visitingArchive = false;
  private archiveLookup?: AbortController;
  private submittedCredentials?: { username: string; password: string; remember: boolean; accepted: boolean };

  constructor() {
    setPersistenceAllowed(!!rememberedCredentials());
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

  async initialize(record?: { id: string; sgf: string } | { id: string; loading: true }) {
    this.initializing = true;
    let menuError = "",
      error = "";
    let variation: [number, number][] | undefined;
    if (record && 'loading' in record) {
      this.recordedGame = { id: record.id, sgf: '', initialBoard: new Board() };
      Object.assign(this.session, {
        phase: 'joining', status: '', spectating: true, archived: true, roomKey: { 1: record.id },
      });
    } else if (record) {
      const parsed = parseSgf(record.sgf);
      this.recordedGame = { ...record, initialBoard: parsed.initialBoard };
      Object.assign(this.session, {
        board: parsed.board, players: parsed.players, komi: parsed.komi, result: parsed.result,
        phase: 'finished', status: 'Reviewing recorded game', spectating: true, archived: true, gameOver: true,
        roomKey: { 1: record.id }, clocks: recordedClocks(parsed.board, parsed.board.moves.length),
      });
    } else if (import.meta.env.DEV) {
      const screen = new URLSearchParams(location.search).get("dev-screen");
      if (screen) {
        const { applyDevScreen, DEV_SCREENS } = await import("./dev-screens.ts");
        const fixture = await applyDevScreen(this.session,
          DEV_SCREENS.find(fixture => fixture.id === screen)?.record ? "matchmaking" : screen);
        this.preview = !!fixture;
        this.previewCoordinates = fixture?.fixture.coordinates ?? false;
        variation = fixture?.fixture.variation;
        menuError = fixture?.menuError ?? "";
        error = fixture?.boardError ?? "";
      }
    }
    const saved = record ? null : rememberedCredentials();
    this.password = saved?.password ?? "";
    const session = this.snapshot();
    this.emit({
      type: "initialize",
      state: {
        session,
        now: Date.now() / 1000,
        frozen: this.preview,
        preview: null,
        prompt: null,
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
    if (typeof window !== "undefined") {
      if (record) {
        window.addEventListener("popstate", this.restoreArchivePosition);
        if ('sgf' in record) this.restoreArchivePosition();
      } else {
        this.visitingArchive = !!recordedGameId();
        // A fresh load starts from login, regardless of the requested live URL.
        if (!this.visitingArchive) this.writeLiveRoute(0, true);
        window.addEventListener("popstate", this.restoreLiveRoute);
      }
    }
    this.updateRoute(session);
    this.preloadGameplayAssets(session);
    this.audio();
    this.scheduleClock();
    this.initializing = false;
  }
  leaveSpectator() {
    if (!this.recordedGame) return;
    const params = new URLSearchParams(location.search);
    params.delete('move');
    params.delete('variation');
    navigateTo('/' + (params.size ? '?' + params : ''));
  }
  private async resolveDesktopArchive(session: SessionState, signal: AbortSignal): Promise<string | undefined> {
    const black = session.players[1]?.id, white = session.players[2]?.id;
    if (!black || !white) return;
    const room = parseRoomId(session.gameId)!;
    // Classic chess IDs pack the start timestamp into bits 16..47.
    const startedAt = session.archiveId
      ? Number((BigInt(session.archiveId) >> 16n) & 0xffffffffn) : this.session.board.startedAt;
    const moves = JSON.stringify(this.session.board.moves);
    const initialStones = JSON.stringify(this.session.board.initialPosition().stones);
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      if (attempt) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, attempt * 1000);
        signal.addEventListener('abort', done, { once: true });
      });
      if (signal.aborted) return;
      const histories = await Promise.allSettled([black, white].map(uid => this.session.playerInfo.history(uid, true)));
      if (signal.aborted) return;
      const candidates = new Map<string, import('./player-history').HistoryGame>();
      histories.forEach((history, index) => {
        if (history.status !== 'fulfilled') return;
        for (const game of history.value) {
          const opponent = session.players[index === 0 ? 2 : 1];
          if (game.color !== (index === 0 ? 'Black' : 'White') || game.date < room[4] - 60 ||
              (game.opponentId ? game.opponentId !== opponent.id : game.opponent !== opponent.name)) continue;
          candidates.set(game.id, game);
        }
      });
      const exact = [...candidates.values()].filter(game => game.date === startedAt && game.result === session.result);
      if (exact.length === 1) return exact[0].id;
      // Some classic snapshots only carry the room creation time. Compare the
      // actual record rather than guessing an ID from a nearby history row.
      for (const game of [...candidates.values()].sort((a, b) => Math.abs(a.date - startedAt) - Math.abs(b.date - startedAt)).slice(0, 3)) {
        try {
          const record = parseSgf(await fetchGameSgf(game.id, signal));
          if (!signal.aborted && session.moves > 0 && JSON.stringify(record.board.moves) === moves &&
              JSON.stringify(record.initialBoard.stones) === initialStones) return game.id;
        } catch { /* History may be published before the SGF is available. */ }
      }
    }
  }
  private openFinishedArchive(session: SessionState, id: string) {
    const sgf = this.session.board.sgf(session.result,
      session.players[1]?.name || 'Black', session.players[2]?.name || 'White', session.komi);
    const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
    const ranks = [1, 2].map(color => session.players[color]?.rank
      ? `${color === 1 ? 'BR' : 'WR'}[${escape(session.players[color].rank!)}]` : '').join('');
    const date = this.session.board.startedAt > 0
      ? `DT[${new Date(this.session.board.startedAt * 1000).toISOString().slice(0, 10)}]` : '';
    const snapshot = { id, sgf: sgf.replace('SZ[', `${ranks}${date}SZ[`) };
    const url = archivePositionUrl(new URL(reviewPath(id) + location.search, location.href).href,
      this.archivePosition(), this.session.board.moves.length);
    history.replaceState({ ...history.state, archive: snapshot }, '', url);
    // Keep the board, player profiles and authenticated transports in place.
    this.recordedGame = { ...snapshot, initialBoard: this.session.board.initialPosition() };
    this.preparedArchive = this;
    window.addEventListener("popstate", this.restoreArchivePosition);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  private writeLiveRoute(screen: number, replace = false) {
    const url = new URL(location.href);
    url.pathname = livePaths[screen];
    const entry = { livePath: livePaths[screen] };
    if (replace) history.replaceState(entry, '', url);
    else history.pushState(entry, '', url);
  }
  private updateLiveRoute(session: SessionState) {
    if (this.returningThroughHistory) return;
    const screen = liveScreen(session);
    let current = livePaths.indexOf(history.state?.livePath);
    if (current < 0) {
      this.writeLiveRoute(0, true);
      current = 0;
    }
    if (current > screen) {
      // Reuse the earlier entry when a room closes or the session ends.
      this.returningThroughHistory = true;
      history.go(screen - current);
    } else {
      while (current < screen) this.writeLiveRoute(++current);
    }
  }
  private restoreLiveRoute = () => {
    const returning = this.returningThroughHistory;
    this.returningThroughHistory = false;
    if (recordedGameId()) {
      this.visitingArchive = this.preparedArchive !== this;
      return;
    }
    const fromArchive = this.visitingArchive;
    this.visitingArchive = false;
    const session = this.snapshot();
    const target = livePaths.indexOf(history.state?.livePath);
    if (!returning && !fromArchive && target >= 0 && target < liveScreen(session)) {
      if (!boardAvailable(session) || session.phase === "kicked") {
        this.command("disconnect");
      } else if (session.phase === "finished" || session.resignationResult) {
        this.command("quit-room");
      } else if (session.phase === "playing" && !session.quitRequested) {
        this.emit({ type: "prompt.open", prompt: quitRoomPrompt });
      }
    }
    this.updateRoute(this.snapshot());
  };
  private updateRoute(session: SessionState) {
    if (this.recordedGame || typeof location === "undefined" || typeof history === "undefined" || recordedGameId()) return;
    this.updateLiveRoute(session);
    if (this.reviewingFinishedGame && session.game_over && session.phase === 'finished' && parseRoomId(session.gameId)) {
      if (parseRoomId(session.gameId)![1] !== PC_LOBBY && !session.archiveId) return;
      if (this.archiveConversion === session.gameId) return;
      this.archiveConversion = session.gameId;
      if (parseRoomId(session.gameId)![1] === PC_LOBBY) {
        this.archiveLookup?.abort();
        this.archiveLookup = new AbortController();
        void this.resolveDesktopArchive(session, this.archiveLookup.signal).then(id => {
          const current = this.snapshot();
          if (this.suppress || recordedGameId() || current.gameId !== session.gameId || !current.game_over ||
              current.phase !== 'finished') return;
          if (id) this.openFinishedArchive(session, id);
          // Local review remains usable if the public record is not ready.
        });
      } else if (session.archiveId) this.openFinishedArchive(session, session.archiveId);
      return;
    }
    if (!session.game_over && !session.resignationResult) this.reviewingFinishedGame = false;
    this.archiveConversion = "";
    this.archiveLookup?.abort();
  }
  private preloadGameplayAssets(session: SessionState) {
    if (this.recordedGame || this.assetsStarted || !["ready", "matching", "joining", "playing", "finished", "reconnecting"].includes(session.phase)) return;
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
    if (this.submittedCredentials && !this.submittedCredentials.accepted && this.session.uid && this.session.token.length) {
      const { username, password, remember } = this.submittedCredentials;
      this.submittedCredentials.accepted = true;
      if (!this.preview) rememberCredentials(username, password, remember);
    } else if (["error", "disconnected", "kicked"].includes(session.phase)) {
      this.submittedCredentials = undefined;
    }
    const wasAvailable = boardAvailable(this.state.session);
    this.emit({ type: "session.updated", session });
    this.updateRoute(session);
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
    if (!s.spectating) this.announcements.update(s, this.state.now);
    if (s.phase !== "playing") this.sounds.stopVoice();
    else if (s.paused || s.counting || s.confirmation ||
      (s.turn === 3 - s.color && s.opponentDisconnectDeadline != null)) this.sounds.stopCountdown();
    else if (s.pending) this.sounds.stopCountdown(true);
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
    if (this.submittedCredentials) this.submittedCredentials.remember = value;
    if (!this.preview) {
      setPersistenceAllowed(value);
      if (value && this.submittedCredentials?.accepted) {
        const { username, password } = this.submittedCredentials;
        rememberCredentials(username, password, true);
      }
    }
  }
  command(
    command: Command,
    body: { x?: number; y?: number; id?: number; accept?: boolean } = {},
  ) {
    if (command === "play" && reviewAvailable(this.state.session)) {
      if (body.x !== undefined && body.y !== undefined) this.playVariation(body.x, body.y);
      return;
    }
    if (this.state.session.phase === "reconnecting" && command !== "disconnect") return;
    if (outOfTurn({
      phase: this.session.phase,
      color: this.session.color,
      turn: this.session.board.turn,
    }, command)) {
      const message = command === "pass" ? "can only pass on your turn" : "can only request counting on your turn";
      this.raise(message);
      return;
    }
    const { username, remember } = this.state.form,
      password = this.password;
    if (command === "login" && (!username.trim() || !password)) return;
    this.emit({ type: "command" });
    try {
      switch (command) {
        case "login":
          this.submittedCredentials = { username, password, remember, accepted: false };
          this.session.login(username, password);
          break;
        case "disconnect":
          this.session.close();
          break;
        case "quit-room":
          if (this.preparedArchive === this) {
            this.session.quitRoom();
            this.recordedGame = undefined;
            this.preparedArchive = undefined;
            this.reviewingFinishedGame = false;
            window.removeEventListener("popstate", this.restoreArchivePosition);
            this.updateLiveRoute(this.snapshot());
            break;
          }
          if (this.session.spectating) { this.leaveSpectator(); break; }
          this.session.quitRoom();
          break;
        case "select-time":
          if (body.id === undefined) throw Error("missing time control");
          this.session.selectMatchField(body.id);
          if (!this.preview && this.session.matchSettings)
            rememberTimeControl(this.session.matchSettings);
          break;
        case "match":
          this.session.match();
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
            throw Error("missing confirmation answer");
          this.session.confirm(body.accept);
          break;
        case "play":
          if (body.x === undefined || body.y === undefined)
            throw Error("missing move coordinates");
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
      if (command === "login") this.submittedCredentials = undefined;
      this.raise(error instanceof Error ? error.message : String(error));
    } finally {
      this.session.flushChanges();
    }
  }
  private reviewBoard(move: number, variation?: NonNullable<UIState["review"]>["variation"]) {
    const board = this.recordedGame?.initialBoard.clone() ?? this.session.board.initialPosition();
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
  private archivePosition(): ArchivePosition {
    const review = this.state.review;
    const variation = review?.variation;
    return {
      move: review?.moves ?? this.session.board.moves.length,
      variation: variation ? { origin: variation.origin, moves: variation.moves.map(([, x, y]) => [x, y]) } : undefined,
    };
  }
  private updateArchivePositionUrl() {
    if (!this.recordedGame || typeof location === 'undefined' || typeof history === 'undefined' ||
        recordedGameId() !== this.recordedGame.id) return;
    const url = archivePositionUrl(location.href, this.archivePosition(), this.session.board.moves.length);
    if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', url);
  }
  private restoreArchivePosition = () => {
    if (!this.recordedGame || !reviewAvailable(this.state.session) || typeof location === 'undefined' ||
        recordedGameId() !== this.recordedGame.id) return;
    const total = this.session.board.moves.length;
    const position = readArchivePosition(location.search, total) ?? { move: total };
    try {
      if (position.variation) {
        const { origin, moves } = position.variation;
        const { board } = this.reviewBoard(origin);
        const branch: NonNullable<UIState['review']>['variation'] = { origin, moves: [], cursor: position.move - origin };
        // Validate the entire continuation before displaying any part of it.
        for (const [x, y] of moves) {
          if (x === null || y === null) board.passTurn();
          else board.play(x, y);
          branch.moves.push(board.moves.at(-1)!);
        }
        const replay = this.reviewBoard(position.move, branch);
        this.showReview(replay.board, branch, replay.numbers);
      } else this.showReview(this.reviewBoard(position.move).board);
    } catch {
      // Invalid/illegal shared branches must not leave a partially applied board.
      this.showReview(this.reviewBoard(total).board);
    }
  };
  private showReview(board: Board, variation?: NonNullable<UIState["review"]>["variation"], moveNumbers?: Record<number, number>) {
    this.session.clearEstimate();
    const followLive = this.state.session.spectating && !this.state.session.game_over &&
      !variation && board.moves.length === this.session.board.moves.length;
    this.emit({ type: "review.position", position: followLive ? null : {
      stones: board.stones,
      captures: board.captures,
      turn: board.turn,
      passes: board.passes,
      moves: board.moves.length,
      last_move: board.moves.at(-1) ?? null,
      koStones: board.history.at(-1) ?? null,
      // Broadcast time controls describe the rules, not a transmitted clock reading.
      clocks: recordedClocks(this.session.board, variation?.origin ?? board.moves.length,
        !this.state.session.spectating || !!this.recordedGame),
      totalPeriods: this.session.board.timeControl?.periods,
      variation,
      moveNumbers,
    } });
    if (!this.initializing) this.reviewingFinishedGame = true;
    this.updateRoute(this.state.session);
    this.updateArchivePositionUrl();
    this.session.changed();
    this.session.flushChanges();
  }
  playVariation(x: number, y: number) {
    const s = this.state.session;
    if (!reviewAvailable(s) || s.estimation || this.state.prompt) return;
    const current = this.state.review;
    if (s.spectating && !s.game_over && !current) return;
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
    if (!reviewAvailable(s) || s.estimation) return;
    const total = this.session.board.moves.length;
    const current = this.state.review?.moves ?? total;
    const variation = this.state.review?.variation;
    if (direction === "first") {
      if (variation || current !== 0) this.showReview(this.reviewBoard(0).board);
      return;
    }
    if (direction === "last") {
      if (variation || current !== total) this.showReview(this.reviewBoard(total).board);
      return;
    }
    if (variation) {
      if (direction === "main" ||
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
    const move = Math.max(0, Math.min(total, current + (direction === "next" ? 1 : -1)));
    if (move !== current) this.showReview(this.reviewBoard(move).board);
  }
  raise(message: string) {
    logError(message);
    this.emit({
      type: "error.raised",
      message,
      menu: !boardAvailable(this.state.session),
    });
  }
  async save(format: "sgf" | "network-log") {
    if (format === "network-log") {
      const date = new Date(),
        pad = (value: number) => String(value).padStart(2, "0"),
        timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
      try {
        if (!persistenceAllowed()) throw Error("network logging is disabled while remember me is off");
        const log = this.session.networkLog;
        const contents = await log.serialize();
        if (log.error)
          throw Error(`network log unavailable ${log.error} reload the page to try again`);
        download(contents, "application/json", `fox-network-log-${timestamp}.json`);
      } catch (error) {
        this.raise(error instanceof Error ? error.message : String(error));
      }
    } else if (reviewAvailable(this.state.session)) {
      if (this.recordedGame) {
        download(this.recordedGame.sgf, 'application/x-go-sgf;charset=utf-8', `${this.recordedGame.id}.sgf`);
        return;
      }
      const black = this.session.players[1]?.name || "Black",
        white = this.session.players[2]?.name || "White",
        local = this.session.color === 2 ? white : black,
        remote = this.session.color === 2 ? black : white,
        filenamePart = (name: string) => name.replace(/[\\/<>:"|?*\u0000-\u001f]/g, "_");
      // Use the recorded game time in UTC so repeat exports keep the same name.
      const gameTimestamp = this.session.board.startedAt > 0
        ? new Date(this.session.board.startedAt * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
        : 'undated';
      download(
        this.session.board.sgf(
          this.state.session.resignationResult ?? this.state.session.result,
          black,
          white,
          this.session.komi,
        ),
        "application/x-go-sgf",
        `${filenamePart(local)}-${filenamePart(remote)}-${gameTimestamp}.sgf`,
      );
    }
  }

  dispose() {
    this.archiveLookup?.abort();
    this.submittedCredentials = undefined;
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", this.restoreArchivePosition);
      window.removeEventListener("popstate", this.restoreLiveRoute);
    }
    clearTimeout(this.clockTimer);
    this.suppress = true;
    this.session.close();
    void this.session.networkLog.flush();
    this.sounds.stopVoice();
    this.sounds.setActive(false);
  }
}
