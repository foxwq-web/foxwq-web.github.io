import { playerName } from "./player-name";
import { StoneColor, StoneMoveFlag, GameStatus, ENGameEndReason, SpecialResult, CalculateProcessType, DuMiaoConst } from "./protocol.ts";
import { gameFields as Game, roomFields as Room, fgwFields as Fgw, commonFields as Common } from "./protocol-fields.ts";
import {
  RoomMessageID,
  LegacyMsgTypeID,
  GoGameMessageID,
  ClientMessageID,
  CLINET_MSG_ID,
  ErrorCode,
} from "./protocol.ts";
import { PlayerInfoStore, SVR_TYPE_USER_INFO_PANEL_SVR } from "./player-info";
import { Buffer } from "buffer";
import SparkMD5 from "spark-md5";
import * as game from "./game.ts";
import { validateGameRoom } from "./room-validation.ts";
import { clockReading } from "./clock.ts";
import { Board } from "./board.ts";
import { placementSound } from "./sound.ts";
import { Connection } from "./transport.ts";
import { NetworkLog } from "./network-log.ts";
import {
  decodeEstimate,
  type Estimator,
} from "../../score-estimator/src/score-estimation.ts";
import { localEstimate } from "../../score-estimator/src/local-score-estimation.ts";
import { encode, decode, signed, type Message, type Fields } from "./wire.ts";
import { logError } from "./error-message";

export function loginRequest(
  username: string,
  password: string,
  mac = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase(),
) {
  return encode({
    1: username,
    2: "foxwq",
    3: SparkMD5.hash(password),
    4: 8,
    5: 11509231,
    6: false,
    7: mac,
    9: false,
  });
}
const now = () => Date.now() / 1000;
import { boardAvailable, type SessionState, type StatusNotice, type TimeControl, type Clock } from "./state";
import type { Transport, TransportOptions } from "./transport.ts";
import type { NetMsg } from "./framing.ts";
export interface SessionOptions {
  networkLog?: NetworkLog;
  host?: string;
  port?: number;
  proxyUrl?: string;
  proxyToken?: string;
  preferredTimeControl?: Omit<TimeControl, "id"> | null;
  connectionFactory?: (
    host: string,
    port: number,
    receive: (frame: NetMsg) => void,
    failed: (reason: string) => void,
    options: TransportOptions,
  ) => Promise<Transport>;
  estimationFetcher?: Estimator;
  historyFetcher?: typeof fetch;
  onSound?: (name: string) => void;
  onChange?: (state: SessionState) => void;
}
type Confirmation = [
  string,
  Fields,
  (ReturnType<typeof game.decodeCalculateConfirmNotify> | null)?,
];
// The one matchmaking message whose reply has not arrived yet.
type MatchWire =
  | { kind: "idle" }
  | { kind: "request"; field: number }
  | { kind: "cancel" };
export class Session {
  spectating = false;
  archived = false;
  archiveId?: string;
  host!: string;
  port!: number;
  proxyUrl!: string;
  proxyToken!: string;
  preferredTimeControl!: Omit<TimeControl, "id"> | null;
  connectionFactory!: NonNullable<SessionOptions["connectionFactory"]>;
  estimationFetcher!: Estimator;
  onSound!: (name: string) => void;
  onChange!: (state: SessionState) => void;
  connection: Transport | null;
  fgwConnection: Transport | null;
  private pendingGateway: Transport | null = null;
  timer: ReturnType<typeof setTimeout> | null;
  bootstrapTimer?: ReturnType<typeof setTimeout>;
  generation: number;
  phase: string;
  private statusText = "";
  private notice: StatusNotice | null = null;
  get status() {
    return this.statusText;
  }
  // Any status change drops the previous notice unless the new one is given,
  // so the UI never acts on a notice that belongs to older text.
  set status(text: string) {
    this.setStatus(text);
  }
  private setStatus(text: string, notice: StatusNotice | null = null) {
    this.statusText = text;
    this.notice = notice;
  }
  gameOver: boolean;
  networkLog: NetworkLog;
  estimation: SessionState["estimation"];
  estimateController: AbortController | null;
  players: SessionState["players"];
  account: SessionState["account"] = null;
  playerInfo: PlayerInfoStore;
  board: Board;
  komi: number;
  result: string;
  uid: number;
  token: Buffer;
  servers: Message[];
  gameLockChecked: boolean;
  fieldId: number | null;
  matchFields: TimeControl[];
  matchSettings: TimeControl | null;
  fieldsLoaded: boolean;
  fieldPlayers: Record<string, number>;
  fieldPlayersRequestedAt: number;
  // Matchmaking keeps two layers apart. `matchIntent` is the user's choice and
  // drives the UI; `matchConfirmed`/`matchWire` describe what the server has
  // acknowledged and the one message in flight. Only user commands change the
  // intent and only server replies change the wire state.
  private matchIntent: number | null = null;
  private matchConfirmed: number | null = null;
  private matchWire: MatchWire = { kind: "idle" };
  roomKey: Record<number, number>;
  private expectedRoomKey: Record<number, number> | null = null;
  private previousRoomKey: Record<number, number> | null = null;
  color: number;
  synSeqId: number;
  boardRoomKey = "";
  pendingMove: {
    board: Board;
    clocks: Record<string, Clock>;
    x: number;
    y: number;
    color: number;
  } | null;
  // A pass already applied to the board while its request is unconfirmed.
  private pendingPass: {
    board: Board;
    clocks: Record<string, Clock>;
    color: number;
  } | null = null;
  pending: boolean;
  pendingMessageId: number | null = null;
  private roomExit: "resigning" | "after-resignation" | null = null;
  get quitRequested() { return this.roomExit !== null; }
  startedRoom: string | null;
  clocks: Record<string, Clock>;
  opponentDisconnectDeadline: number | null = null;
  paused = false;
  pauseTimeSeconds: number | null = null;
  pendingConfirmation: Confirmation | null;
  private countingActive = false;
  get counting() { return this.countingActive; }
  set counting(active: boolean) {
    if (active === this.countingActive) return;
    const time = now(), color = this.board.turn, clock = this.clocks[color];
    if (clock && this.phase === "playing") {
      if (active && !this.paused && !(color !== this.color && this.opponentDisconnectDeadline != null)) {
        const reading = clockReading(clock, time - clock.at, DuMiaoConst.DU_MIAO_60_SEC, color === this.color);
        Object.assign(clock, {
          main: reading.main, periods: reading.periods, byoyomi: reading.seconds,
        });
      }
      // Preserve the displayed time on entry; exclude the counting interval
      // when play resumes, including rejection paths without a timing packet.
      clock.at = time;
    }
    this.countingActive = active;
  }
  countingAnswer: { confirmation: Confirmation; accept: boolean } | null;
  changeQueued = false;
  lastChangeKey = "";
  pendingSince = 0;
  private loginPacket: Buffer | null = null;
  private reconnectBoard: SessionState | null = null;
  private reconnectMode: "player" | "discovery" | null = null;
  private get recoveringPlayer() {
    return !!this.reconnectBoard && (this.reconnectMode === "player" ||
      (this.reconnectMode === null && [StoneColor.BLACK, StoneColor.WHITE].includes(this.reconnectBoard.color)));
  }
  private reconnectBoardModel: Board | null = null;
  private reconnectAttempt = 0;
  private reconnectStatus = "";
  private reconnectNotice: StatusNotice | null = null;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private lastFgwResponse = 0;
  private gameEnvRecovery: {
    roomKey: Record<number, number>;
    state: SessionState;
    board: Board;
    requestedAt: number;
    attempts: number;
  } | null = null;
  constructor({
    host = "43.132.13.39",
    port = 10000,
    proxyUrl = "",
    proxyToken = "",
    preferredTimeControl = null,
    connectionFactory = Connection.open,
    estimationFetcher = localEstimate,
    historyFetcher,
    networkLog = new NetworkLog(),
    onSound = (_name) => {},
    onChange = (_state) => {},
  }: SessionOptions = {}) {
    Object.assign(this, {
      host,
      port,
      proxyUrl,
      proxyToken,
      preferredTimeControl,
      connectionFactory,
      estimationFetcher,
      onSound,
      onChange,
    });
    this.playerInfo = new PlayerInfoStore(fields => this.sendFgwChannelMsg(SVR_TYPE_USER_INFO_PANEL_SVR, CLINET_MSG_ID.MTID_FETCH_PANEL_USER_INFO, fields),
      () => this.changed(), () => this, historyFetcher);
    this.connection = null;
    this.fgwConnection = null;
    this.timer = null;
    this.generation = 0;
    this.phase = "disconnected";
    this.status = "Disconnected";
    this.gameOver = false;
    this.networkLog = networkLog;
    this.estimation = null;
    this.estimateController = null;
    this.players = {};
    this.board = new Board();
    this.komi = 7.5;
    this.result = "";
    this.uid = 0;
    this.token = Buffer.alloc(0);
    this.servers = [];
    this.gameLockChecked = false;
    this.fieldId = null;
    this.matchFields = [];
    this.matchSettings = null;
    this.fieldsLoaded = false;
    this.fieldPlayers = {};
    this.fieldPlayersRequestedAt = 0;
    this.roomKey = {};
    this.color = 0;
    this.synSeqId = 0;
    this.pendingMove = null;
    this.pendingPass = null;
    this.pending = false;
    this.startedRoom = null;
    this.clocks = {};
    this.pendingConfirmation = null;
    this.counting = false;
    this.countingAnswer = null;
  }

  changed() {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => this.flushChanges());
  }
  flushChanges() {
    if (!this.changeQueued) return;
    this.changeQueued = false;
    const state = this.snapshot(),
      key = JSON.stringify(state);
    if (key === this.lastChangeKey) return;
    this.lastChangeKey = key;
    this.onChange(state);
  }
  snapshot(): SessionState {
    if (this.reconnectBoard?.game_over) return structuredClone({
      ...this.reconnectBoard,
      playerInfo: this.playerInfo.current,
      estimation: this.estimation,
      gatewayAvailable: false,
    });
    if (this.reconnectBoard) return structuredClone({
      ...this.reconnectBoard,
      phase: "reconnecting",
      status: this.reconnectStatus,
      notice: this.reconnectNotice,
      pending: false,
      pendingMove: false,
      resignationResult: undefined,
      confirmation: false,
      confirmationKind: null,
      counting: false,
      estimation: null,
      gatewayAvailable: false,
    });
    return structuredClone({
      spectating: this.spectating,
      archived: this.archived,
      archiveId: this.archiveId,
      phase: this.phase,
      status: this.status,
      notice: this.notice,
      stones: this.board.stones,
      turn: this.board.turn,
      komi: this.komi,
      captures: this.board.captures,
      passes: this.board.passes,
      moves: this.board.moves.length,
      result: this.result,
      resignationResult: this.phase === "playing" && this.awaitingResignation && this.roomExit !== "resigning"
        ? game.resultLabel(3 - this.color, null, "R") : undefined,
      game_over: this.gameOver,
      time: this.matchSettings ? game.timeLabel(this.matchSettings) : "",
      totalPeriods: this.board.timeControl?.periods,
      matchFields: this.matchFields,
      fieldPlayers: this.fieldPlayers,
      fieldId: this.fieldId,
      color: this.color,
      pending: this.pending,
      // An action that is already applied to the board and only waits for its
      // acknowledgement. The UI keeps accepting input for it.
      pendingMove: this.awaitingMove || this.awaitingPass,
      quitRequested: this.quitRequested,
      players: this.players,
      account: this.account,
      playerInfo: this.playerInfo.current,
      aiPlayers: this.playerInfo.aiPlayers,
      clocks: this.clocks,
      opponentDisconnectDeadline: this.opponentDisconnectDeadline,
      paused: this.paused,
      pauseTimeSeconds: this.pauseTimeSeconds,
      gameId: Object.values(this.roomKey).join(":"),
      last_move: this.board.moves.at(-1) ?? null,
      confirmation: this.pendingConfirmation !== null,
      counting: this.counting,
      confirmationKind: this.pendingConfirmation?.[0] ?? null,
      countingResult: this.pendingConfirmation?.[2] ?? this.countingAnswer?.confirmation[2] ?? null,
      estimation: this.estimation,
      gatewayAvailable: !!this.fgwConnection && this.fgwConnection !== this.pendingGateway,
      koStones: this.board.history.at(-1) ?? null,
    });
  }
  private resetGame() {
    this.spectating = false;
    if (this.roomKey[Game.RoomKey.server_type] === game.GAME_SVR && [Game.RoomKey.server_type, Game.RoomKey.server_id, Game.RoomKey.room_id, Game.RoomKey.create_time].every(field => this.roomKey[field] !== undefined))
      this.previousRoomKey = { ...this.roomKey };
    this.expectedRoomKey = null;
    this.gameEnvRecovery = null;
    this.reconnectBoardModel = null;
    this.rollbackMove();
    this.clearEstimate();
    this.playerInfo.close();
    this.board = new Board();
    this.boardRoomKey = "";
    this.players = {};
    this.clocks = {};
    this.komi = 7.5;
    this.result = "";
    this.gameOver = false;
    this.archiveId = undefined;
    this.startedRoom = null;
    this.opponentDisconnectDeadline = null;
    this.paused = false;
    this.pauseTimeSeconds = null;
    this.synSeqId = 0;
    this.pendingMessageId = null;
    this.pendingSince = 0;
    this.roomKey = {};
    this.color = 0;
    this.pending = false;
    this.roomExit = null;
    this.pendingConfirmation = null;
    this.counting = false;
    this.countingAnswer = null;
  }
  close() {
    try {
      this.finishReconnect();
      this.loginPacket = null;
      this.resetGame();
      this.previousRoomKey = null;
      this.playerInfo.reset();
      this.generation++;
      clearTimeout(this.bootstrapTimer);
      clearTimeout(this.timer ?? undefined);
      this.timer = null;
      this.fgwConnection?.close();
      this.connection?.close();
      this.fgwConnection = this.connection = null;
      this.token = Buffer.alloc(0);
      this.uid = 0;
      this.fieldId = null;
      this.matchFields = [];
      this.matchSettings = null;
      this.fieldsLoaded = false;
      this.clearMatchmaking();
      this.fieldPlayers = {};
      this.fieldPlayersRequestedAt = 0;
      this.gameLockChecked = false;
      this.phase = "disconnected";
      this.status = "Disconnected";
    } finally {
      this.changed();
    }
  }
  timeout(generation: number, reason: string) {
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => this.failed(generation, reason), 15000);
  }
  login(username: string, password: string) {
    try {
      if (!username || !password)
        throw Error("enter your username and password");
      const request = loginRequest(username, password);
      this.close();
      this.loginPacket = request;
      this.account = { name: username, rank: "" };
      this.phase = "connecting";
      this.status = "Connecting...";
      this.timeout(this.generation, "login timed out");
      void this.connect(this.generation, request);
    } finally {
      this.changed();
    }
  }
  async open(host: string, port: number, generation: number, nav = false) {
    return this.connectionFactory(
      host,
      port,
      (packet) => this.receive(generation, packet),
      (reason) =>
        nav
          ? this.navFailed(generation, reason)
          : this.failed(generation, reason),
      this,
    );
  }
  async connect(generation: number, request: Buffer) {
    try {
      let connection;
      try {
        if (generation !== this.generation) return;
        connection = await this.open(this.host, this.port, generation, true);
        if (generation !== this.generation) {
          connection.close();
          return;
        }
        this.connection = connection;
        this.phase = "authenticating";
        this.status = "Waiting for login response...";
        connection.send(2000, request);
        connection.start?.();
      } catch (error) {
        connection?.close();
        this.failed(generation, "login connection failed");
      }
    } finally {
      this.changed();
    }
  }
  navFailed(generation: number, reason: string) {
    try {
      if (generation !== this.generation) return;
      if (this.fgwConnection && !this.fgwConnection.closed) {
        this.connection = null;
      } else this.failed(generation, reason);
    } finally {
      this.changed();
    }
  }
  failed(generation: number, reason: string, { fatal = false }: { fatal?: boolean } = {}) {
    try {
      if (generation !== this.generation) return;
      if (fatal && !boardAvailable(this.snapshot())) {
        this.loginFailed(reason);
        return;
      }
      if (this.reconnectBoard?.game_over) {
        // One background attempt is enough; review never reports its failure.
        this.generation++;
        clearTimeout(this.timer ?? undefined);
        clearTimeout(this.bootstrapTimer);
        this.timer = null;
        this.fgwConnection?.close();
        this.connection?.close();
        this.fgwConnection = this.connection = null;
        this.restoreFinishedReview();
        return;
      }
      const recovery = this.gameEnvRecovery;
      this.gameEnvRecovery = null;
      if (this.phase === "finished" && this.gameOver && !this.spectating && !this.reconnectBoard) {
        // Reauthenticate in the background while the finished board stays visible.
        const finished = this.snapshot();
        this.generation++;
        clearTimeout(this.timer ?? undefined);
        clearTimeout(this.bootstrapTimer);
        clearTimeout(this.reconnectTimer);
        this.timer = null;
        this.fgwConnection?.close();
        this.connection?.close();
        this.fgwConnection = this.connection = null;
        if (this.loginPacket && !fatal) {
          this.reconnectBoard = finished;
          this.reconnectMode = "discovery";
          this.reconnect();
        }
        return;
      }
      if (this.loginPacket &&
          (this.reconnectBoard || recovery || ["ready", "matching", "joining"].includes(this.phase) ||
            (this.phase === "playing" && [StoneColor.BLACK, StoneColor.WHITE].includes(this.color)))) {
        const first = !this.reconnectBoard;
        if (first) this.reconnectMode = this.phase === "playing" || recovery ? "player" : "discovery";
        this.reconnectBoardModel ??= recovery?.board ?? this.pendingMove?.board ?? this.pendingPass?.board ?? this.board;
        if (!this.reconnectBoard) {
          const saved = recovery?.state ?? this.snapshot();
          const clock = saved.clocks[saved.turn];
          if (clock && saved.phase === "playing" && !saved.paused && !saved.counting && !saved.resignationResult &&
              !(saved.turn !== saved.color && saved.opponentDisconnectDeadline != null)) {
            const time = now();
            const reading = clockReading(clock, time - clock.at, DuMiaoConst.DU_MIAO_60_SEC, saved.turn === saved.color);
            Object.assign(clock, { main: reading.main, periods: reading.periods, byoyomi: reading.seconds, at: time });
          }
          this.reconnectBoard = saved;
        }
        this.clearEstimate();
        this.rollbackMove();
        this.playerInfo.reset();
        // Invalidate callbacks before closing either transport.
        this.generation++;
        clearTimeout(this.timer ?? undefined);
        clearTimeout(this.bootstrapTimer);
        clearTimeout(this.reconnectTimer);
        this.fgwConnection?.close();
        this.connection?.close();
        this.fgwConnection = this.connection = null;
        this.phase = "reconnecting";
        this.pending = false;
        this.pendingConfirmation = null;
        this.counting = false;
        this.countingAnswer = null;
        this.roomExit = null;
        logError(reason);
        if (first) this.reconnect(reason);
        else {
          const timedOut = /timed out/i.test(reason);
          this.reconnectStatus = `reconnection ${timedOut ? "timed out" : "failed"} ${reason} retrying attempt ${this.reconnectAttempt}`;
          this.reconnectNotice = timedOut ? null : { error: true };
          this.reconnectTimer = setTimeout(() => this.reconnect(), 2000);
        }
        return;
      }
      this.loginFailed(reason);
    } finally {
      this.changed();
    }
  }
  private loginFailed(reason: string) {
    logError(reason);
    this.close();
    this.phase = "error";
    this.status = reason;
    this.changed();
  }
  private reconnect(reason = "connection lost") {
    if (!this.reconnectBoard || !this.loginPacket) return;
    this.reconnectAttempt++;
    this.reconnectStatus = `${reason} reconnecting attempt ${this.reconnectAttempt}`;
    this.reconnectNotice = null;
    this.phase = "connecting";
    this.token = Buffer.alloc(0);
    this.fieldsLoaded = false;
    this.gameLockChecked = false;
    this.roomKey = {};
    this.expectedRoomKey = null;
    this.startedRoom = null;
    this.timeout(this.generation, "reconnection timed out");
    void this.connect(this.generation, this.loginPacket);
    this.changed();
  }
  private onKickOutNotify(generation: number, message: Message) {
    if (generation !== this.generation) return;
    // KickOutNotify has optional fields. An unusable reason must not turn a
    // terminal server decision into a retryable protocol/connection failure.
    const codeValue = message.one(Fgw.KickOutNotify.op_code);
    const code = typeof codeValue === "number" || typeof codeValue === "bigint" ? signed(codeValue) : 0;
    const reasonValue = message.one(Fgw.KickOutNotify.reason_phrase);
    let reason = Buffer.isBuffer(reasonValue) ? reasonValue.toString("utf8").trim() : "";
    reason ||= code === ErrorCode.EC_ACCOUNT_KICKOUT_BY_ANOTHER_LOGIN
      ? "another client logged in"
      : `fox ended this session${code ? ` code ${code}` : ""}`;
    const restriction = message.one(Fgw.KickOutNotify.forbid_login_time);
    if ((typeof restriction === "number" || typeof restriction === "bigint") && restriction > 0)
      reason += " fox has restricted login";

    const saved = this.reconnectBoard ?? this.gameEnvRecovery?.state;
    const board = this.reconnectBoardModel ?? this.pendingMove?.board ?? this.pendingPass?.board ?? this.board;
    // Invalidate callbacks before closing sockets, including an open that is
    // still awaiting its promise. No cached password packet survives a kick.
    this.generation++;
    clearTimeout(this.timer ?? undefined);
    clearTimeout(this.bootstrapTimer);
    clearTimeout(this.reconnectTimer);
    this.timer = null;
    this.loginPacket = null;
    this.token = Buffer.alloc(0);
    this.uid = 0;
    this.rollbackMove();
    this.board = board;
    if (saved) {
      this.color = saved.color;
      this.roomKey = Object.fromEntries(saved.gameId.split(":").map((value, index) => [index + 1, Number(value)]));
      this.players = saved.players;
      this.clocks = saved.clocks;
      this.komi = saved.komi;
      this.result = saved.result;
      this.gameOver = saved.game_over;
      this.archiveId = saved.archiveId;
      this.account = saved.account;
    }
    if (!this.gameOver) this.clearEstimate();
    const clock = this.clocks[this.board.turn];
    if (clock && this.phase === "playing" && !this.paused && !this.counting &&
        !(this.board.turn !== this.color && this.opponentDisconnectDeadline != null)) {
      const reading = clockReading(clock, now() - clock.at, DuMiaoConst.DU_MIAO_60_SEC, this.board.turn === this.color);
      Object.assign(clock, { main: reading.main, periods: reading.periods, byoyomi: reading.seconds, at: now() });
    }
    this.phase = [StoneColor.BLACK, StoneColor.WHITE].includes(this.color) && Object.keys(this.roomKey).length ? "kicked" : "error";
    this.status = reason;
    logError(reason);
    this.paused = false;
    this.pauseTimeSeconds = null;
    this.gameEnvRecovery = null;
    this.expectedRoomKey = null;
    this.finishReconnect();
    this.spectating = false;
    this.pending = false;
    this.pendingMessageId = null;
    this.pendingSince = 0;
    this.pendingConfirmation = null;
    this.countingAnswer = null;
    this.counting = false;
    this.roomExit = null;
    this.opponentDisconnectDeadline = null;
    this.playerInfo.reset();
    this.fgwConnection?.close();
    this.connection?.close();
    this.fgwConnection = this.connection = null;
  }
  receive(generation: number, packet: NetMsg) {
    try {
      if (generation !== this.generation || this.phase === "kicked") return;
      try {
        if (packet.msgTypeID === LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET) {
          this.onReceiveFgwMessage(generation, packet);
          return;
        }
        const m = decode(packet.rawProto);
        if (packet.msgTypeID === 2005) {
          clearTimeout(this.timer ?? undefined);
          const code = signed(m.one(1)),
            uid = m.number(2) || m.sub(3).number(1),
            token = m.bytes(8);
          if (code || !uid || !token.length) {

            const reason =
              code === ErrorCode.NEC_USERNAME_PASSWORD_ERROR
                ? "incorrect credentials"
                : `${code}`;
            this.failed(generation, reason, { fatal: true });
            return;
          }
          this.uid = uid;
          const account = m.sub(3);
          this.account = {
            name: playerName(account.text(3), account.text(2), this.account?.name),
            rank: account.has(4) ? game.rankLabel(signed(account.one(4))) : "",
          };
          this.token = token;
          this.phase = "bootstrap";
          this.status = "Fetching server list...";
          this.connection!.send(3000, encode({ 1: uid, 2: false }));
          this.connection!.send(3010, encode({ 1: uid }));
          this.timeout(generation, "server discovery timed out");
        } else if (
          packet.msgTypeID === 3005 &&
          m.has(3) &&
          this.phase === "bootstrap"
        ) {
          this.servers = m.get(3)!.map((value) => decode(value));
          const record =
            this.servers.find((r) => r.number(1) === 1) ?? this.servers[0];
          const host = record.text(21),
            port = record.number(22);
          if (!host || !Number.isInteger(port) || port <= 0 || port > 65535)
            throw Error("server list has no usable gateway");
          this.phase = "gateway";
          this.status = "Connecting to gateway...";
          this.timeout(generation, "gateway discovery timed out");
          void this.startConnectFgwServer(generation, host, port);
        }
      } catch (error) {
        this.failed(generation, "invalid protocol response");
      }
    } finally {
      this.changed();
    }
  }
  private async openGateway(generation: number, host: string, port: number) {
    let connection: Transport | undefined;
    try {
      connection = await this.open(host, port, generation);
      if (generation !== this.generation) {
        connection.close();
        return null;
      }
      // Own the preconnected socket immediately so logout, timeout, or a PC
      // login rejection also closes it while authentication is pending.
      this.pendingGateway = connection;
      this.fgwConnection = connection;
      return connection;
    } catch {
      connection?.close();
      this.failed(generation, "gateway connection failed");
      return null;
    }
  }
  async startConnectFgwServer(generation: number, host: string, port: number) {
    try {
      const connection = await this.openGateway(generation, host, port);
      if (!connection || generation !== this.generation) return;
      try {
        this.sendFgwChannelMsg(game.SVR_TYPE_FGW, ClientMessageID.MID_LOGIN_REQUEST, { [Fgw.LoginRequest.session]: this.token });
        connection.start?.();
      } catch {
        connection.close();
        this.failed(generation, "gateway connection failed");
      }
    } finally {
      this.changed();
    }
  }
  sendFgwChannelMsg(serverType: number, messageId: number, fields: Fields = {}, serverId = 0) {
    if (!this.fgwConnection) throw Error("gateway is disconnected");
    if (this.fgwConnection === this.pendingGateway &&
        !(serverType === game.SVR_TYPE_FGW && messageId === ClientMessageID.MID_LOGIN_REQUEST))
      throw Error("gateway login is pending");
    this.fgwConnection.send(
      LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET,
      game.encodeFgwMessage(this.uid, serverType, messageId, fields, serverId),
    );
  }
  private expectedGameRoom() {
    if (this.gameEnvRecovery) return this.gameEnvRecovery.roomKey;
    if (this.reconnectBoard?.gameId && this.recoveringPlayer && !this.expectedRoomKey)
      return Object.fromEntries(this.reconnectBoard.gameId.split(":").map((value, index) => [index + 1, Number(value)]));
    return this.expectedRoomKey ?? this.roomKey;
  }
  private isPreviousRoom(roomKey: Record<number, number>) {
    return this.previousRoomKey !== null && [Game.RoomKey.server_type, Game.RoomKey.server_id, Game.RoomKey.room_id, Game.RoomKey.create_time].every(field =>
      roomKey[field] === this.previousRoomKey![field]);
  }
  private requestGameEnvRecovery() {
    if (this.gameEnvRecovery || this.phase !== "playing" || this.gameOver ||
        ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color) || !Object.keys(this.roomKey).length) return;
    this.gameEnvRecovery = {
      roomKey: { ...this.roomKey }, state: this.snapshot(), board: this.pendingMove?.board ?? this.pendingPass?.board ?? this.board,
      requestedAt: now(), attempts: 0,
    };
    this.clearEstimate();
    this.pending = true;
    this.pendingMessageId = GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST;
    this.pendingConfirmation = null;
    this.countingAnswer = null;
    this.counting = false;
    this.status = "Synchronizing game...";
    this.fetchGameEnvForRecovery();
  }
  private fetchGameEnvForRecovery() {
    const recovery = this.gameEnvRecovery!;
    recovery.attempts++;
    recovery.requestedAt = this.pendingSince = now();
    this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST,
      { [Game.FetchGameEnvRequest.room_key]: recovery.roomKey }, recovery.roomKey[Game.RoomKey.server_id]);
  }
  heartbeat(generation: number) {
    try {
      if (generation !== this.generation || !this.fgwConnection) return;
      try {
        if (now() - this.lastFgwResponse > 20) {
          this.failed(generation, "network response timed out");
          return;
        }
        const ticks = Math.floor(performance.now());
        this.sendFgwChannelMsg(game.SVR_TYPE_FGW, ClientMessageID.MID_HEART_BEAT_REQUEST, { [Fgw.HeartBeatRequest.client_time]: ticks });
        this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_HEART_BEAT_REQUEST, { [Room.HeartBeatRequest.client_time_us]: ticks });
        this.refreshFieldPlayers(ticks);
        if (Object.keys(this.roomKey).length) {
          if (this.gameEnvRecovery) {
            if (now() - this.gameEnvRecovery.requestedAt > 8) {
              if (this.gameEnvRecovery.attempts >= 3) {
                this.failed(generation, "game synchronization timed out");
                return;
              }
              this.fetchGameEnvForRecovery();
            }
          } else if (this.pending && now() - this.pendingSince > 8) {
            this.requestGameEnvRecovery();
          }
          this.sendFgwChannelMsg(
            game.GAME_SVR,
            GoGameMessageID.GC_HEART_BEAT_REQUEST,
            { [Game.HeartBeatRequest.client_time_us]: ticks, [Game.HeartBeatRequest.room_key]: this.roomKey },
            this.roomKey[Game.RoomKey.server_id],
          );
        }
        this.timer = setTimeout(() => this.heartbeat(generation), 5000);
      } catch {
        this.failed(generation, "heartbeat failed");
      }
    } finally {
      this.changed();
    }
  }
  onReceiveFgwMessage(generation: number, packet: NetMsg) {
    try {
      this.lastFgwResponse = now();
      const [fgwHead, m] = game.decodeFgwMessage(packet.rawProto),
        serverType = fgwHead.number(Common.FGWHead.server_type),
        messageId = fgwHead.number(Common.FGWHead.message_id);
      if (serverType === SVR_TYPE_USER_INFO_PANEL_SVR && messageId === CLINET_MSG_ID.MTID_FETCH_PANEL_USER_INFO) {
        const profile = this.playerInfo.receive(m);
        if (this.account && profile?.uid === this.uid && profile.country !== undefined)
          this.account = { ...this.account, country: profile.country };
      } else if (serverType === game.SVR_TYPE_FGW) {
        if (messageId === ClientMessageID.MID_LOGIN_REQUEST) {
          if (signed(m.one(Fgw.LoginResponse.op_code))) {
            this.failed(generation, `gateway login status ${signed(m.one(Fgw.LoginResponse.op_code))}`, { fatal: true });
            return;
          }
          this.pendingGateway = null;
          clearTimeout(this.timer ?? undefined);
          this.status = "Discovering game settings...";
          this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_LOGIN_GAME_SVR_MGR_REQUEST, { 1: true });
          this.preloadPlayerInfo();
          this.heartbeat(generation);

          this.bootstrapTimer = setTimeout(() => {
            if (
              !this.fieldsLoaded ||
              !this.gameLockChecked ||
              this.phase === "resuming"
            )
              this.failed(generation, "room discovery timed out");
          }, 15000);
          this.bootstrapTimer.unref?.();
        } else if (messageId === ClientMessageID.MID_KICKOUT_NOTIFY)
          this.onKickOutNotify(generation, m);
      } else if (serverType === game.GAME_SVR_MGR) this.gameSvrMgrProcess(messageId, m);
      else if (serverType === game.GAME_SVR) this.gameSvrProcess(messageId, m, fgwHead);
    } finally {
      this.changed();
    }
  }
  refreshFieldPlayers(ticks = Math.floor(performance.now())) {
    if (
      !["ready", "finished", "matching"].includes(this.phase) ||
      ticks - this.fieldPlayersRequestedAt < 25000
    )
      return;
    this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_FETCH_ALL_FIELD_INFO_REQUEST);
    this.fieldPlayersRequestedAt = ticks;
  }
  gameSvrMgrProcess(messageId: number, m: Message) {
    try {
      if (messageId === RoomMessageID.RM_LOGIN_GAME_SVR_MGR_REQUEST) {
        if (signed(m.one(Room.LoginGameSvrMgrResponse.result))) {
          this.failed(this.generation, "room manager login failed", { fatal: true });
          return;
        }
        for (const operation of [RoomMessageID.RM_FETCH_ALL_FIELD_INFO_REQUEST, RoomMessageID.RM_QUERY_GAME_LOCK_REQUEST, RoomMessageID.RM_FETCH_FIELD_CFG])
          this.sendFgwChannelMsg(game.GAME_SVR_MGR, operation);
        this.fieldPlayersRequestedAt = Math.floor(performance.now());
      } else if (messageId === RoomMessageID.RM_QUERY_GAME_LOCK_REQUEST) {
        if (this.reconnectBoard?.game_over) {
          this.gameLockChecked = true;
          this.discoveryReady();
          return;
        }
        if (this.phase === "finished" && this.gameOver) return;
        if (m.number(Room.QueryGameLockResponse.result) === 0 && m.number(Room.QueryGameLockResponse.server_type) === game.GAME_SVR) {
          const room = validateGameRoom(messageId, m, undefined,
            this.reconnectMode && this.reconnectMode !== "player" ? {} : this.expectedGameRoom());
          if (!room) return;
          if (this.reconnectBoard) {
            this.reconnectMode = "player";
            this.spectating = false;
          }
          this.expectedRoomKey = room.roomKey;
          this.gameLockChecked = true;
          this.phase = "resuming";
          this.status = "Reconnecting...";
          this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, {}, m.number(Room.QueryGameLockResponse.server_id));
        } else if (this.recoveringPlayer) {
          this.gameLockChecked = true;
          // The lock can disappear when the game ends during the outage.
          this.phase = "resuming";
          this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, {}, Number(this.reconnectBoard!.gameId.split(":")[1]));
        } else {
          this.gameLockChecked = true;
          this.discoveryReady();
        }
      } else if (messageId === RoomMessageID.RM_FETCH_ALL_FIELD_INFO_REQUEST) {
        if (signed(m.one(Room.FetchAllFieldInfoResponse.result))) {
          return;
        }
        const counts: Record<string, number> = {};
        for (const record of (m.get(Room.FetchAllFieldInfoResponse.field_infos) ?? []).map(decode)) {
          const id = record.number(Room.FieldInfo.field_id),
            count = record.number(Room.FieldInfo.people_num);
          if (
            Number.isSafeInteger(id) &&
            id > 0 &&
            Number.isSafeInteger(count) &&
            count >= 0
          )
            counts[id] = count;
        }
        this.fieldPlayers = counts;
      } else if (messageId === RoomMessageID.RM_FETCH_FIELD_CFG) {
        this.fieldsLoaded = true;
        this.matchFields = game.fieldCfgsToTimeControls((m.get(Room.FetchFieldCfgResponse.field_cfgs) ?? []).map(decode));
        const selected =
          this.matchFields.find((f) => f.id === this.fieldId) ??
          this.matchFields.find(
            (f) =>
              this.preferredTimeControl &&
              (["size", "main", "periods", "byoyomi"] as const).every(
                (key) => f[key] === this.preferredTimeControl![key],
              ),
          ) ??
          this.matchFields.find((f) =>
            [f.size, f.main, f.periods, f.byoyomi].every(
              (v, i) => v === game.NORMAL[i],
            ),
          ) ??
          this.matchFields[0];
        this.fieldId = selected?.id ?? null;
        this.matchSettings = selected ?? null;
        this.discoveryReady();
      } else if (messageId === RoomMessageID.RM_AUTO_INVITE_REQUEST) {
        const wire = this.matchWire;
        if (wire.kind !== "request") return;
        this.matchWire = { kind: "idle" };
        const rejected = signed(m.one(Room.AutoInviteResponse.result));
        if (rejected) {
          this.matchConfirmed = null;
          // A newer time control arrived while this request was in flight.
          if (this.matchIntent !== null && this.matchIntent !== wire.field) {
            this.pumpMatchmaking();
            return;
          }
          this.matchIntent = null;
          this.setMatchIntent(null);
          this.setStatus(`matchmaking rejected ${rejected}`, { kind: "matchmaking-rejected", error: true });
          logError(this.status);
          return;
        }
        this.matchConfirmed = wire.field;
        // The user may have cancelled or chosen another control meanwhile.
        this.setMatchIntent(this.matchIntent);
        this.pumpMatchmaking();
      } else if ([RoomMessageID.RM_AUTO_INVITE_TIMEOUT_NOTIFY, RoomMessageID.RM_AUTO_INVITE_CANCEL_REQUEST, RoomMessageID.RM_AUTO_INVITE_CANCEL_NOTIFY].includes(messageId)) {
        if (!this.matchmakingPending()) return;
        const cancelExpected = this.matchWire.kind === "cancel";
        const searchingField = this.matchConfirmed ??
          (this.matchWire.kind === "request" ? this.matchWire.field : null) ?? this.fieldId;
        this.matchWire = { kind: "idle" };
        this.matchConfirmed = null;
        // A cancel we asked for always frees the way for a newer search, even
        // when the user restarted the same time control before the reply.
        const restart = this.matchIntent !== null &&
          (cancelExpected || this.matchIntent !== searchingField);
        if (restart) {
          this.setMatchIntent(this.matchIntent);
          this.pumpMatchmaking();
          return;
        }
        this.pendingConfirmation = null;
        this.matchIntent = null;
        this.setMatchIntent(
          null,
          messageId === RoomMessageID.RM_AUTO_INVITE_TIMEOUT_NOTIFY
            ? "matchmaking timed out"
            : "Matchmaking cancelled",
          messageId === RoomMessageID.RM_AUTO_INVITE_TIMEOUT_NOTIFY
            ? null
            : { kind: "matchmaking-cancelled" },
        );
        if (messageId === RoomMessageID.RM_AUTO_INVITE_TIMEOUT_NOTIFY) logError(this.status);
      } else if (messageId === RoomMessageID.RM_ENTER_ROOM_NOTIFY) {
        if (!["matching", "joining", "playing"].includes(this.phase)) return;
        if (this.phase === "matching" && signed(m.one(Room.EnterRoomNotify.result))) throw Error("room entry failed");
        const room = validateGameRoom(messageId, m, undefined, this.expectedGameRoom());
        if (!room || (this.phase === "matching" && this.isPreviousRoom(room.roomKey))) return;
        if (signed(m.one(Room.EnterRoomNotify.result))) throw Error("room entry failed");
        this.clearMatchmaking();
        this.roomKey = room.roomKey;
        if (this.phase !== "playing") {
          this.phase = "joining";
          this.status = "Joining the game...";
        }
        this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_READY_REQUEST, {}, this.roomKey[Game.RoomKey.server_id]);
      }
    } finally {
      this.changed();
    }
  }
  private preloadPlayerInfo() {
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation || !this.fgwConnection || this.fgwConnection.closed || !this.token.length) return;
      if (this.account) this.playerInfo.prefetch(this.uid, this.account.name, this.account.rank, this.account);
      for (const player of Object.values(this.players)) {
        if (player.id) this.playerInfo.prefetch(player.id, player.name, player.rank, player);
      }
    });
  }
  discoveryReady() {
    if (!this.fieldsLoaded || !this.gameLockChecked) return;
    if (["gateway", "bootstrap"].includes(this.phase)) {
      clearTimeout(this.bootstrapTimer);
      if (this.reconnectBoard?.game_over) {
        this.restoreFinishedReview();
        return;
      }
      this.finishReconnect();
      this.phase = "ready";
      this.status = this.matchFields.length
        ? "Choose your time control"
        : "No time controls available";
    }
  }
  private restoreFinishedReview() {
    const saved = this.reconnectBoard!;
    this.roomKey = Object.fromEntries(saved.gameId.split(":").map((value, index) => [index + 1, Number(value)]));
    this.phase = "finished";
    this.status = saved.status;
    this.notice = saved.notice;
    this.finishReconnect();
  }
  private finishReconnect() {
    this.reconnectBoard = null;
    this.reconnectBoardModel = null;
    this.reconnectMode = null;
    this.reconnectAttempt = 0;
    clearTimeout(this.reconnectTimer);
  }
  gameSvrProcess(messageId: number, m: Message, header: Message) {
    try {
      // Results may arrive in multiple packets; other late room events must
      // never replace a completed game or disturb its offline review.
      if (this.phase === "finished" && this.gameOver && ![
        GoGameMessageID.GC_SET_GAME_END_NOTIFY,
        GoGameMessageID.GC_SET_GAME_RESULT_NOTIFY,
        GoGameMessageID.LEGACY_GC_SET_GAME_END_NOTIFY,
      ].includes(messageId)) return;
      // Only a full synchronization may replace the board during recovery.
      if (this.recoveringPlayer && ![GoGameMessageID.GC_START_SET_PIECE_NOTIFY, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST].includes(messageId)) return;
      if (["ready", "disconnected", "error", "kicked"].includes(this.phase)) return;
      if (
        this.phase === "matching" &&
        !Object.keys(this.roomKey).length &&
        messageId !== GoGameMessageID.GC_START_SET_PIECE_NOTIFY
      )
        return;
      const room = validateGameRoom(messageId, m, header, this.expectedGameRoom(), game.GAME_SVR);
      if (!room || (this.phase === "matching" && this.isPreviousRoom(room.roomKey))) return;
      // Partial events cannot repair a divergent board or confirm an uncertain
      // move. Only the requested snapshot (or a terminal result) may unlock it.
      if (this.gameEnvRecovery && ![
        GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST,
        GoGameMessageID.GC_SET_GAME_END_NOTIFY,
        GoGameMessageID.GC_SET_GAME_RESULT_NOTIFY,
        GoGameMessageID.LEGACY_GC_SET_GAME_END_NOTIFY,
      ].includes(messageId)) return;
      if (messageId === GoGameMessageID.GC_HEART_BEAT_REQUEST) {
        if (m.has(Game.HeartBeatResponse.check_syn) && m.sub(Game.HeartBeatResponse.check_syn).has(Game.CheckSyn.syn_seq_id) && m.sub(Game.HeartBeatResponse.check_syn).number(Game.CheckSyn.syn_seq_id) !== this.synSeqId)
          this.requestGameEnvRecovery();
        return;
      }
      if ([
        GoGameMessageID.GC_SET_PIECE_REQUEST,
        GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST,
        GoGameMessageID.GC_CALCULATE_REQUEST,
        GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST,
        GoGameMessageID.GC_GIVE_UP_REQUEST,
        GoGameMessageID.GS_OP_ERROR,
      ].includes(messageId) && signed(m.one(Game.GameRoomOpErrorCode.error_code)) === ErrorCode.NEC_CHECK_SYC_ERROR) {
        this.requestGameEnvRecovery();
        return;
      }
      if (this.gameEnvRecovery) {
        if (messageId === GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST && !signed(m.one(Game.FetchGameEnvResponse.result))) {
          if (!room.completeBodyIdentity) return;
          if (!m.has(Game.FetchGameEnvResponse.check_syn)) throw Error("game snapshot has no synchronization state");
        }
      }
      const confirmsMove = messageId === GoGameMessageID.GC_SET_PIECE_NOTIFY && this.pendingMove &&
        this.pendingMove.color === m.number(Game.SetPieceNotify.color) &&
        this.pendingMove.x === m.number(Game.SetPieceNotify.x) && this.pendingMove.y === m.number(Game.SetPieceNotify.y);
      const opponentMove = (messageId === GoGameMessageID.GC_SET_PIECE_NOTIFY && m.number(Game.SetPieceNotify.color) === 3 - this.color) ||
        (messageId === GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY && this.board.turn === 3 - this.color);
      if (!this.gameOver && [
        GoGameMessageID.GC_START_SET_PIECE_NOTIFY,
        GoGameMessageID.GC_SET_PIECE_NOTIFY,
        GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY,
        GoGameMessageID.GC_CALCULATE_CONFIRM_NOTIFY,
        GoGameMessageID.GC_CALCULATE_ANSWER_NOTIFY,
        GoGameMessageID.GC_SET_GAME_END_NOTIFY,
        GoGameMessageID.GC_SET_GAME_RESULT_NOTIFY,
        GoGameMessageID.LEGACY_GC_SET_GAME_END_NOTIFY,
        GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST,
      ].includes(messageId) && !confirmsMove && !opponentMove)
        this.clearEstimate();
      if (messageId === GoGameMessageID.GC_READY_REQUEST) {
        if (signed(m.one(Game.GameSvrRoomMsgResponse.result))) throw Error("game room rejected entry");
      } else if (messageId === GoGameMessageID.GC_START_SET_PIECE_NOTIFY) {
        if (this.recoveringPlayer) {
          this.phase = "resuming";
          this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, {}, room.roomKey[Game.RoomKey.server_id]);
          return;
        }
        const resuming = this.phase === "resuming";
        this.roomKey = room.roomKey;
        this.expectedRoomKey = null;
        this.players = {};
        this.opponentDisconnectDeadline = null;
        this.paused = false;
        this.pauseTimeSeconds = null;
        this.board = new Board();
        this.boardRoomKey = Object.values(this.roomKey).join(":");
        this.archiveId = this.readArchiveId(m, Game.StartSetPieceNotify.chess_id, Game.StartSetPieceNotify.chess_id_str);
        this.board.startedAt = m.number(Game.StartSetPieceNotify.game_start_time) || this.roomKey[Game.RoomKey.create_time] || 0;
        const rule = m.sub(Game.StartSetPieceNotify.rule);
        this.board.setupHandicap(rule.number(Game.GameRule.handicap));
        if (rule.has(Game.GameRule.komi)) this.komi = signed(rule.one(Game.GameRule.komi)) / (rule.number(Game.GameRule.chess_rule) === 2 ? 100 : 50);
        this.board.timeControl = this.matchSettings ? {
          main: this.matchSettings.main,
          periods: this.matchSettings.periods,
          byoyomi: this.matchSettings.byoyomi,
        } : null;
        this.color = 0;
        this.clocks = {};
        this.result = "";
        this.gameOver = false;
        for (const data of m.get(Game.StartSetPieceNotify.game_users) ?? []) {
          const user = decode(data);
          this.readGameUserInfo(user);
          if (user.number(Game.GameUserInfo.uid) === this.uid) this.color = user.number(Game.GameUserInfo.stone_color);
          this.clocks[user.number(Game.GameUserInfo.stone_color)] = {
            main: user.number(Game.GameUserInfo.remaining_jushi_time),
            periods: user.number(Game.GameUserInfo.remaining_dumiao_num),
            byoyomi: user.number(Game.GameUserInfo.remaining_dumaio_time),
            periodLength:
              m.sub(Game.StartSetPieceNotify.rule).number(Game.GameRule.dumiao_time) || this.matchSettings?.byoyomi || DuMiaoConst.DU_MIAO_60_SEC,
            at: now(),
          };
        }
        clearTimeout(this.bootstrapTimer);
        this.clearMatchmaking();
        this.phase = "playing";
        this.status = "Game started";
        this.pendingMove = null;
        this.pendingPass = null;
        this.pending = false;
        this.synSeqId = 0;
        this.pendingConfirmation = null;
        this.counting = false;
        this.countingAnswer = null;
        this.roomExit = null;
        this.announceStart(resuming);
      } else if (messageId === GoGameMessageID.GC_SET_PIECE_NOTIFY) {
        const color = m.number(Game.SetPieceNotify.color),
          x = m.number(Game.SetPieceNotify.x),
          y = m.number(Game.SetPieceNotify.y);
        const submittedClock = confirmsMove ? this.pendingMove?.clocks[color] : undefined;
        if (color === 3 - this.color) this.opponentDisconnectDeadline = null;
        if (confirmsMove) this.pendingMove = null;
        else {
          this.rollbackMove();
          const captures = this.board.play(x, y, color);
          this.onSound(placementSound(captures));
        }
        this.synSeqId = m.sub(Game.SetPieceNotify.check_syn).number(Game.CheckSyn.syn_seq_id, this.synSeqId);
        this.clock(color, m.sub(Game.SetPieceNotify.countdown), submittedClock);
        if (!this.awaitingResignation) this.pending = false;
        this.status = "";
      } else if (messageId === GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY) {
        // An optimistic pass already advanced the board; the reply only carries
        // the server clock and sequence number.
        const confirmsPass = this.pendingPass !== null && this.pendingPass.color !== this.board.turn;
        const submittedClocks = this.pendingPass?.clocks;
        const color = confirmsPass ? this.pendingPass!.color : this.board.turn;
        if (color === 3 - this.color) this.opponentDisconnectDeadline = null;
        if (confirmsPass) this.pendingPass = null;
        else this.board.passTurn();
        this.clock(color, m.sub(Game.SkipSetPieceNotify.countdown), submittedClocks?.[color]);
        this.synSeqId = m.sub(Game.SkipSetPieceNotify.check_syn).number(Game.CheckSyn.syn_seq_id, this.synSeqId);
        if (!this.awaitingResignation) this.pending = false;
        this.setStatus(this.board.turn === this.color ? "Opponent passed" : "You passed", { game: true });
      } else if ([
        GoGameMessageID.GC_SET_PIECE_REQUEST,
        GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST,
        GoGameMessageID.GC_CALCULATE_REQUEST,
        GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST,
        GoGameMessageID.GC_GIVE_UP_REQUEST,
      ].includes(messageId)) {
        if (signed(m.one(Game.SetPieceResponse.result))) {
          if (messageId === GoGameMessageID.GC_GIVE_UP_REQUEST && (this.pendingMove || this.pendingPass)) {
            this.pendingMessageId = this.pendingMove ? GoGameMessageID.GC_SET_PIECE_REQUEST : GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST;
          } else {
            this.rollbackMove();
            if (messageId === GoGameMessageID.GC_SET_PIECE_REQUEST) this.clearEstimate();
            if (messageId === GoGameMessageID.GC_GIVE_UP_REQUEST || !this.awaitingResignation) this.pending = false;
          }
          this.setStatus(`action ${messageId} rejected ${signed(m.one(Game.SetPieceResponse.result))}`,
            { game: true, error: true });
          logError(this.status);
          if (messageId === GoGameMessageID.GC_GIVE_UP_REQUEST) this.roomExit = null;
          if (messageId === GoGameMessageID.GC_CALCULATE_REQUEST) this.counting = false;
          if (messageId === GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST && this.countingAnswer) {
            this.pendingConfirmation = this.countingAnswer.confirmation;
            this.countingAnswer = null;
          }
        } else if ([GoGameMessageID.GC_CALCULATE_REQUEST, GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST].includes(messageId)) {
          if (!this.awaitingResignation) this.pending = false;
          if (messageId === GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST && this.countingAnswer) {
            if (!this.countingAnswer.accept) {
              this.counting = false;
              this.setStatus("counting rejected continue", { game: true, error: true });
            }
            this.countingAnswer = null;
          }
        }
      } else if (messageId === GoGameMessageID.GC_CALCULATE_ANSWER_NOTIFY && [CalculateProcessType.CPT_START, CalculateProcessType.CPT_RESULT].includes(m.number(Game.CalculateAnswerNotify.type, CalculateProcessType.CPT_START))) {
        if (!this.awaitingResignation) this.pending = false;
        this.pendingConfirmation = null;
        this.countingAnswer = null;
        this.counting = Boolean(m.number(Game.CalculateAnswerNotify.accept));
        if (m.number(Game.CalculateAnswerNotify.accept))
          this.setStatus("Counting accepted", { game: true });
        else this.setStatus("counting rejected continue", { game: true, error: true });
      } else if ([GoGameMessageID.GC_GAME_COUNTDOWN_NOTIFY, GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY].includes(messageId) && (this.spectating || [StoneColor.BLACK, StoneColor.WHITE].includes(this.color))) {
        // ResumeCountdownNotify (109) wraps the same clock data as 108.
        // Fox can answer a counting rejection with 304 status 1, then resume
        // the clock without sending 306. Resumption ends the counting flow,
        // including any confirmation restored by the nonzero 304 response.
        if (messageId === GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY && this.phase === "playing" && this.counting) {
          if (!this.awaitingResignation) this.pending = false;
          this.pendingConfirmation = null;
          this.countingAnswer = null;
          this.counting = false;
          this.setStatus("counting rejected continue", { game: true, error: true });
        }
        const timing = messageId === GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY ? m.sub(Game.ResumeCountdownNotify.countdown) : m;
        if (timing.has(Game.GameCountdownNotify.uid)) {
          const color = this.spectating ? this.colorForUid(timing.number(Game.GameCountdownNotify.uid))
            : timing.number(Game.GameCountdownNotify.uid) === this.uid ? this.color : 3 - this.color;
          if (color) this.readClock(color, timing, true);
        }
      } else if (
        messageId === GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY && this.phase === "playing" &&
        [StoneColor.BLACK, StoneColor.WHITE].includes(this.color) &&
        m.number(Game.OpponentOfflineNotify.offline_uid) === this.players[3 - this.color]?.id
      ) {
        // OpponentOfflineNotify: player ID, remaining allowance in seconds.
        const color = 3 - this.color, clock = this.clocks[color];
        if (clock && !this.paused && this.opponentDisconnectDeadline == null && this.board.turn === color) {
          const remaining = clockReading(clock, Math.max(0, now() - clock.at), DuMiaoConst.DU_MIAO_60_SEC, false);
          Object.assign(clock, {
            main: remaining.main,
            periods: remaining.periods,
            byoyomi: remaining.seconds,
            at: now(),
          });
        }
        this.opponentDisconnectDeadline = now() + Math.max(0, m.number(Game.OpponentOfflineNotify.countdown_time));
      } else if (messageId === GoGameMessageID.GC_OPPONENT_RECONNECT_NOTIFY && m.number(Game.OpponentReconnectNotify.reconnect_uid) === this.players[3 - this.color]?.id) {
        // OpponentReconnectNotify identifies the returning player in field 1.
        const clock = this.clocks[3 - this.color];
        if (clock && this.opponentDisconnectDeadline != null) clock.at = now();
        this.opponentDisconnectDeadline = null;
      } else if (
        messageId === GoGameMessageID.GC_CALCULATE_CONFIRM_NOTIFY &&
        this.phase === "playing" &&
        [StoneColor.BLACK, StoneColor.WHITE].includes(this.color)
      ) {
        const mode = m.number(Game.CalculateConfirmNotify.type, CalculateProcessType.CPT_START),
          status = signed(m.one(Game.CalculateConfirmNotify.result));
        if (status) {
          if (!this.awaitingResignation) this.pending = false;
          this.pendingConfirmation = null;
          this.counting = false;
          this.countingAnswer = null;
          this.setStatus(`counting failed ${status}`, { game: true, error: true });
          logError(this.status);
        } else if ([StoneColor.BLACK, StoneColor.WHITE].includes(mode)) {
          if (!this.awaitingResignation) this.pending = false;
          this.counting = true;
          this.countingAnswer = null;
          this.pendingConfirmation = [
            mode === CalculateProcessType.CPT_START ? "counting-request" : "counting-result",
            game.plain(m),
            mode === CalculateProcessType.CPT_RESULT ? game.decodeCalculateConfirmNotify(m) : null,
          ];
          this.setStatus(
            mode === CalculateProcessType.CPT_START
              ? "Opponent requested counting"
              : "Counting result needs your confirmation",
            { game: true },
          );
        }
      } else if ([
        GoGameMessageID.GC_SET_GAME_END_NOTIFY,
        GoGameMessageID.GC_SET_GAME_RESULT_NOTIFY,
        GoGameMessageID.LEGACY_GC_SET_GAME_END_NOTIFY,
      ].includes(messageId)) {
        if (!this.gameOver) {
          this.gameEnvRecovery = null;
          this.playerInfo.invalidate();
          this.preloadPlayerInfo();
        }
        this.opponentDisconnectDeadline = null;
        this.rollbackMove();
        this.pending = false;
        this.phase = "finished";
        this.gameOver = true;
        this.archiveId = this.readArchiveId(m, messageId === GoGameMessageID.GC_SET_GAME_RESULT_NOTIFY
          ? Game.SetGameResultNotify.chess_id : Game.SetGameEndNotify.chess_id) ?? this.archiveId;
        this.updateGameResult(m);
        if (this.quitRequested) this.leaveFinishedRoom();
      } else if ([GoGameMessageID.GC_GAME_PAUSE_NOTIFY, GoGameMessageID.GC_GAME_RESUME_NOTIFY].includes(messageId)) {
        const pause = messageId === GoGameMessageID.GC_GAME_PAUSE_NOTIFY;
        const current = this.colorForUid(m.number(pause ? Game.GamePauseNotify.cur_round_uid : Game.GameResumeNotify.cur_round_uid));
        this.setPaused(pause, current || this.board.turn);
        this.pauseTimeSeconds = pause ? (m.has(Game.GamePauseNotify.pause_time_s) ? m.number(Game.GamePauseNotify.pause_time_s) : this.pauseTimeSeconds) : null;
        this.synSeqId = m.sub(Game.GamePauseNotify.check_syn).number(Game.CheckSyn.syn_seq_id, this.synSeqId);
        if (current) this.board.turn = current;
        for (const bytes of m.get(pause ? Game.GamePauseNotify.countdowns : Game.GameResumeNotify.countdowns) ?? []) {
          const timing = decode(bytes), color = this.colorForUid(timing.number(Game.GameCountdownNotify.uid));
          if (color) this.readClock(color, timing);
        }
        if (!this.counting && !this.pendingConfirmation && !this.pending)
          this.status = pause ? "Game paused" : "Game resumed";
      } else if (messageId === GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST) {
        const resuming = this.phase !== "joining";
        if (signed(m.one(Game.FetchGameEnvResponse.result))) throw Error("game synchronization failed");
        // Decode before replacing the board or clearing reconnect/recovery state.
        const result = m.number(Game.FetchGameEnvResponse.game_state) === GameStatus.GS_END && m.has(Game.FetchGameEnvResponse.game_result) ? m.sub(Game.FetchGameEnvResponse.game_result) : null;
        const restoredResult = result ? {
          winner: result.number(Game.GameResult.winner),
          margin: result.has(Game.GameResult.points) ? signed(result.one(Game.GameResult.points)) : null,
          reason: result.number(Game.GameResult.reason),
        } : null;
        const previousBoard = this.pendingMove?.board ?? this.pendingPass?.board ?? this.board;
        this.roomKey = room.roomKey;
        this.expectedRoomKey = null;
        const roomKey = Object.values(this.roomKey).join(":");
        const sameGame = roomKey === this.boardRoomKey;
        this.archiveId = this.readArchiveId(m, Game.FetchGameEnvResponse.chess_id, Game.FetchGameEnvResponse.chess_id_str)
          ?? (sameGame ? this.archiveId : undefined);
        if (!sameGame || m.number(Game.FetchGameEnvResponse.game_state) === GameStatus.GS_END) this.opponentDisconnectDeadline = null;
        this.synSeqId = m.sub(Game.FetchGameEnvResponse.check_syn).number(Game.CheckSyn.syn_seq_id);
        this.pendingMove = null;
        this.pendingPass = null;
        this.board = new Board();
        this.board.startedAt = m.number(Game.FetchGameEnvResponse.game_start_time) ||
          (sameGame ? previousBoard.startedAt : 0) || this.roomKey[Game.RoomKey.create_time] || 0;
        const rule = m.sub(Game.FetchGameEnvResponse.game_rule);
        this.board.setupHandicap(rule.number(Game.GameRule.handicap));
        if (rule.has(Game.GameRule.komi)) this.komi = signed(rule.one(Game.GameRule.komi)) / (rule.number(Game.GameRule.chess_rule) === 2 ? 100 : 50);
        this.board.timeControl = sameGame ? previousBoard.timeControl :
          this.phase === "joining" && this.matchSettings ? {
            main: this.matchSettings.main,
            periods: this.matchSettings.periods,
            byoyomi: this.matchSettings.byoyomi,
          } : null;
        this.boardRoomKey = roomKey;
        this.clocks = {};
        this.color = 0;
        for (const data of m.get(Game.FetchGameEnvResponse.stone_moves) ?? []) {
          const move = decode(data);
          if (move.number(Game.StoneMove.flag) === StoneMoveFlag.E_NOMAL_MOVE)
            this.board.play(move.number(Game.StoneMove.x), move.number(Game.StoneMove.y), move.number(Game.StoneMove.color));
          else if (move.number(Game.StoneMove.flag) === StoneMoveFlag.E_PASS) this.board.passTurn(move.number(Game.StoneMove.color));
        }


        if (sameGame) {
          for (let i = 0; i < this.board.moves.length; i++) {
            if (!previousBoard.moves[i] ||
              !this.board.moves[i].every((value, j) => value === previousBoard.moves[i][j])) break;
            this.board.moveTimings[i] = previousBoard.moveTimings[i] ?? null;
          }
        }
        for (const data of m.get(Game.FetchGameEnvResponse.game_users) ?? []) {
          const user = decode(data);
          this.readGameUserInfo(user);
          if (user.number(Game.GameUserInfo.uid) === this.uid) this.color = user.number(Game.GameUserInfo.stone_color);
          this.clocks[user.number(Game.GameUserInfo.stone_color)] = {
            main: user.number(Game.GameUserInfo.remaining_jushi_time),
            periods: user.number(Game.GameUserInfo.remaining_dumiao_num),
            byoyomi: user.number(Game.GameUserInfo.remaining_dumaio_time),
            periodLength:
              m.sub(Game.FetchGameEnvResponse.game_rule).number(Game.GameRule.dumiao_time) || this.matchSettings?.byoyomi || DuMiaoConst.DU_MIAO_60_SEC,
            at: now(),
          };
        }
        if (m.number(Game.FetchGameEnvResponse.game_state) === GameStatus.GS_END) {
          this.pendingConfirmation = null;
          this.counting = false;
          this.countingAnswer = null;
        }
        this.gameOver = m.number(Game.FetchGameEnvResponse.game_state) === GameStatus.GS_END;
        // An explicit pause countdown is authoritative; legacy same-room
        // snapshots without it must not silently release an existing pause.
        this.paused = !this.gameOver && (m.has(Game.FetchGameEnvResponse.game_pause_left_time_s) ? m.number(Game.FetchGameEnvResponse.game_pause_left_time_s) > 0 : sameGame && this.paused);
        this.pauseTimeSeconds = this.paused ? (m.has(Game.FetchGameEnvResponse.game_pause_left_time_s) ? m.number(Game.FetchGameEnvResponse.game_pause_left_time_s) : this.pauseTimeSeconds) : null;
        if ((this.recoveringPlayer || this.gameEnvRecovery) && ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color))
          throw Error("game synchronization did not restore the player");
        if (this.gameEnvRecovery) this.pendingMessageId = null;
        this.gameEnvRecovery = null;
        if (!this.spectating) this.finishReconnect();
        clearTimeout(this.bootstrapTimer);
        this.phase = this.gameOver ? "finished" : "playing";
        this.result = "";
        this.status = this.gameOver ? "Game ended" : this.paused ? "Game paused" : "Game synchronized";
        if (restoredResult) {
          // GameResult uses 1/2/3, unlike the top-level 402/403 result fields.
          this.setGameResult(restoredResult.winner, restoredResult.margin, restoredResult.reason);
        }
        this.pending = false;
        if (!this.gameOver) this.announceStart(resuming);
        if (this.quitRequested) {
          if (this.gameOver) this.leaveFinishedRoom();
          else {
            this.roomExit = null;
            this.setStatus("failed to end game", { game: true, error: true });
            logError(this.status);
          }
        }
      }
    } finally {
      if (this.spectating) {
        this.color = 0;
        this.pendingConfirmation = null;
        this.countingAnswer = null;
      }
      this.changed();
    }
  }
  readGameUserInfo(user: Message) {
    const color = user.number(Game.GameUserInfo.stone_color);
    if (![StoneColor.BLACK, StoneColor.WHITE].includes(color)) return;
    if (user.has(Game.GameUserInfo.ai) || user.has(Game.GameUserInfo.is_ai))
      this.playerInfo.rememberAI(user.number(Game.GameUserInfo.uid),
        user.number(Game.GameUserInfo.ai) > 0 || user.number(Game.GameUserInfo.is_ai) > 0);
    const previous =
      this.players[color]?.id === user.number(Game.GameUserInfo.uid) ? this.players[color] : null;
    this.players[color] = {
      ...(user.has(Game.GameUserInfo.country) ? { country: user.number(Game.GameUserInfo.country) }
        : previous?.country !== undefined ? { country: previous.country } : {}),
      id: user.number(Game.GameUserInfo.uid),
      name: playerName(user.text(Game.GameUserInfo.globalname), user.text(Game.GameUserInfo.nickname),
        user.text(Game.GameUserInfo.platform_picture), previous?.name),
      rank: user.has(Game.GameUserInfo.grade)
        ? game.rankLabel(signed(user.one(Game.GameUserInfo.grade)))
        : (previous?.rank ?? ""),
    };
    if (user.number(Game.GameUserInfo.uid) === this.uid) {
      this.account = {
        ...this.account,
        name: this.players[color].name || this.account?.name || "",
        rank: this.players[color].rank || this.account?.rank || "",
        ...(this.players[color].country !== undefined ? { country: this.players[color].country } : {}),
      };
    }
    this.preloadPlayerInfo();
  }
  announceStart(resuming: boolean) {
    const room = Object.values(this.roomKey).join(":");
    if (!room || room === this.startedRoom) return;
    this.startedRoom = room;
    // Spectator joins also load a start/environment snapshot for an existing
    // game. The invitation to play belongs only to the player's own game.
    if (!resuming && !this.spectating) this.onSound("start-play");
  }
  // Undoes the action that is still waiting for its acknowledgement.
  rollbackMove() {
    if (this.pendingMove) {
      this.board = this.pendingMove.board;
      this.clocks = this.pendingMove.clocks;
      this.pendingMove = null;
    }
    if (this.pendingPass) {
      this.board = this.pendingPass.board;
      this.clocks = this.pendingPass.clocks;
      this.pendingPass = null;
    }
  }
  clock(color: number, m: Message, previous = this.clocks[color]) {
    if (m.has(Game.GameCountdownNotify.remaining_jushi_time) && (m.number(Game.GameCountdownNotify.remaining_jushi_time) > 0 || m.has(Game.GameCountdownNotify.remaining_dumiao_time))) {
      let remaining = Math.max(0, m.number(Game.GameCountdownNotify.remaining_jushi_time) > 0 ? m.number(Game.GameCountdownNotify.remaining_jushi_time) : m.number(Game.GameCountdownNotify.remaining_dumiao_time));
      const length = previous?.periodLength || this.board.timeControl?.byoyomi ||
        this.matchSettings?.byoyomi;
      // Move notifications report the next period's full allowance, not the
      // seconds left when the stone was played. Save the pre-reset countdown
      // for SGF/review, while readClock still resets the live clock normally.
      if (m.number(Game.GameCountdownNotify.remaining_jushi_time) <= 0 && previous && length && remaining === length && m.has(Game.GameCountdownNotify.remaining_dumiao_num)) {
        // Use the clock captured before optimistic placement, and stop our
        // stones/passes at submission rather than confirmation receipt.
        const time = color === this.color && this.pending ? this.pendingSince : now();
        const paused = this.paused || this.counting || !!this.pendingConfirmation ||
          (color !== this.color && this.opponentDisconnectDeadline != null);
        const elapsed = paused ? 0 : Math.floor(Math.max(0, time - previous.at) + 0.5);
        const spentPeriods = Math.max(0, previous.periods - m.number(Game.GameCountdownNotify.remaining_dumiao_num));
        remaining = Math.max(0, Math.min(length,
          previous.byoyomi + spentPeriods * length - Math.max(0, elapsed - previous.main)));
      }
      this.board.moveTimings[this.board.moves.length - 1] = {
        remaining,
        ...(m.number(Game.GameCountdownNotify.remaining_jushi_time) <= 0 && m.has(Game.GameCountdownNotify.remaining_dumiao_num) ? { periods: m.number(Game.GameCountdownNotify.remaining_dumiao_num) } : {}),
      };
    }
    this.readClock(color, m);
    if (this.clocks[3 - color]) this.clocks[3 - color].at = now();
  }
  tickClock(time = now()) {
    if (this.phase !== "playing" || this.paused || this.pending || this.counting || this.pendingConfirmation ||
        this.board.turn !== this.color) return false;
    const clock = this.clocks[this.color];
    if (!clock) return false;
    const reading = clockReading(clock, time - clock.at);
    if (reading.periods !== clock.periods) {
      clock.periods = reading.periods;
      if (reading.periods > 0) Object.assign(clock, {
        main: reading.main, byoyomi: reading.seconds, at: time,
      });
      return true;
    }
    return false;
  }
  readClock(color: number, m: Message, countdown = false) {
    if (m.has(Game.GameCountdownNotify.remaining_jushi_time)) {
      const time = now();
      const previous = this.clocks[color];
      const control = this.board.timeControl ?? this.matchSettings;
      let byoyomi = m.number(Game.GameCountdownNotify.remaining_dumiao_time);
      // 0080c930 clamps a full initial-period countdown notification to the
      // already displayed seconds. Move confirmations still reset the period.
      if (countdown && previous && control && m.number(Game.GameCountdownNotify.remaining_jushi_time) === 0 &&
          m.number(Game.GameCountdownNotify.remaining_dumiao_num) > 0 && m.number(Game.GameCountdownNotify.remaining_dumiao_num) === control.periods &&
          byoyomi > 0 && byoyomi === control.byoyomi) {
        const elapsed = this.board.turn === color && !this.paused && !this.pending && !this.counting &&
          !this.pendingConfirmation && !(color !== this.color && this.opponentDisconnectDeadline != null)
          ? time - previous.at : 0;
        byoyomi = Math.min(byoyomi, clockReading(previous, elapsed, DuMiaoConst.DU_MIAO_60_SEC, color === this.color).seconds);
      }
      this.clocks[color] = {
        main: m.number(Game.GameCountdownNotify.remaining_jushi_time),
        periods: m.number(Game.GameCountdownNotify.remaining_dumiao_num),
        byoyomi,
        periodLength:
          this.clocks[color]?.periodLength || this.matchSettings?.byoyomi || DuMiaoConst.DU_MIAO_60_SEC,
        at: time,
      };
    }
  }
  private colorForUid(uid: number) {
    if (!uid) return 0;
    return [StoneColor.BLACK, StoneColor.WHITE].find(color => this.players[color]?.id === uid || (color === this.color && this.uid === uid)) ?? 0;
  }
  private setPaused(paused: boolean, current: number) {
    if (paused === this.paused && current === this.board.turn) return;
    const time = now(), color = this.board.turn, clock = this.clocks[color];
    if (!this.paused && clock && this.phase === "playing" && !this.pending && !this.counting &&
        !this.pendingConfirmation && !(color !== this.color && this.opponentDisconnectDeadline != null)) {
      const reading = clockReading(clock, Math.max(0, time - clock.at), DuMiaoConst.DU_MIAO_60_SEC, color === this.color);
      Object.assign(clock, { main: reading.main, periods: reading.periods, byoyomi: reading.seconds });
    }
    for (const clock of Object.values(this.clocks)) clock.at = time;
    this.paused = paused;
    if (!paused) this.pauseTimeSeconds = null;
  }
  private readArchiveId(m: Message, field: number, textField?: number): string | undefined {
    const id = textField && m.has(textField) ? m.text(textField) : String(m.one(field));
    return /^[1-9][0-9]{0,19}$/.test(id) && BigInt(id) <= 0xffffffffffffffffn ? id : undefined;
  }
  updateGameResult(m: Message) {
    this.setGameResult(m.number(Game.SetGameEndNotify.winner), m.has(Game.SetGameEndNotify.points) ? signed(m.one(Game.SetGameEndNotify.points)) : null, m.number(Game.SetGameEndNotify.reason));
  }
  private setGameResult(winner: number, margin: number | null, reason: number) {
    this.paused = false;
    this.pauseTimeSeconds = null;
    this.pendingConfirmation = null;
    this.counting = false;
    this.countingAnswer = null;
    // Broadcasts can report CALCULATE_END while the signed points field
    // carries a special ending (e.g. -1 for resignation).
    const ending = reason === ENGameEndReason.EER_INVALIDGAME_ROUNDNUM_TOO_SMALL ? "Void"
      : reason === ENGameEndReason.EER_OPP_RESIGN || margin === SpecialResult.SR_MID_GAME ? "R"
      : margin === SpecialResult.SR_TIMEOUT ? "T"
      : reason === ENGameEndReason.EER_OPP_OFFLINE_TIMEOUT || margin === SpecialResult.SR_OFFLINE ? "F" : "";
    this.result = game.resultLabel(winner, margin !== null && margin >= 0 ? margin / 50 : null, ending);
    this.status = `Result: ${this.result || "Unknown"}`;
  }
  clearEstimate() {
    this.estimateController?.abort();
    this.estimateController = null;
    this.estimation = null;
  }
  get awaitingMove() {
    return this.pending && this.pendingMessageId === GoGameMessageID.GC_SET_PIECE_REQUEST && !!this.pendingMove;
  }
  get awaitingPass() {
    return this.pending && this.pendingMessageId === GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST && !!this.pendingPass;
  }
  private get awaitingResignation() {
    return this.pending && this.pendingMessageId === GoGameMessageID.GC_GIVE_UP_REQUEST;
  }
  estimateScore(position?: Pick<Board, "stones" | "captures">) {
    if (this.spectating) throw Error("score estimation is unavailable while spectating");
    if (
      (this.phase !== "playing" && !(this.phase === "finished" && this.gameOver)) ||
      !Object.keys(this.roomKey).length ||
      ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color)
    )
      throw Error("score estimation requires an active game");
    if (this.paused) throw Error("game is paused");
    if ((this.pending && !this.awaitingMove && !this.awaitingPass) ||
      (this.pendingConfirmation?.[0] !== "counting-request" &&
        (this.counting || this.pendingConfirmation)))
      throw Error("finish the pending game action first");
    if (this.estimation && this.estimation.phase !== "error")
      throw Error("an estimate is already open");
    const board = this.board.clone();
    if (position) {
      board.stones = [...position.stones];
      board.captures = [...position.captures];
    }
    const komi = this.komi,
      payload = { status: board.stones.join("") };
    this.clearEstimate();
    const controller = new AbortController();
    this.estimateController = controller;
    this.estimation = { phase: "loading" };
    this.changed();
    const timer = setTimeout(() => controller.abort("timeout"), 20000);
    timer.unref?.();
    return (async () => {
      try {
        const response = await this.estimationFetcher({
          payload,
          signal: controller.signal,
        });
        if (this.estimateController !== controller) return;
        if (controller.signal.aborted)
          throw Error("score estimation timed out");
        this.estimation = {
          phase: "result",
          stones: board.stones,
          ...decodeEstimate(response, board, komi),
        };
      } catch (error) {
        if (this.estimateController !== controller) return;
        this.estimation = {
          phase: "error",
          error: controller.signal.aborted
            ? "score estimation timed out"
            : error instanceof Error
              ? error.message
              : String(error),
        };
        logError(this.estimation.error);
      } finally {
        clearTimeout(timer);
        if (this.estimateController === controller) {
          this.estimateController = null;
          this.changed();
        }
      }
    })();
  }
  returnToGame() {
    this.clearEstimate();
    this.changed();
  }
  requestCounting() {
    try {
      if (this.counting || this.pendingConfirmation)
        throw Error("a confirmation or counting request is already active");
      if (this.phase === "playing" && this.board.turn !== this.color)
        throw Error("wait for your turn");
      this.onlineAction(GoGameMessageID.GC_CALCULATE_REQUEST, { [Game.CalculateRequest.extend]: 0 });
      this.counting = true;
      this.setStatus("Counting requested; waiting for opponent",
        { game: true, kind: "counting-requested" });
    } finally {
      this.changed();
    }
  }
  confirm(accept: boolean) {
    try {
      if (typeof accept !== "boolean") throw Error("accept must be boolean");
      if (!this.pendingConfirmation) throw Error("no pending confirmation");
      const [kind] = this.pendingConfirmation;
      if (!["counting-request", "counting-result"].includes(kind))
        throw Error("no pending counting confirmation");
      if (this.phase !== "playing")
        throw Error("no active game");

      this.clearEstimate();

      this.onlineAction(GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST, {
        [Game.CalculateAnswerRequest.accept]: accept,
        [Game.CalculateAnswerRequest.type]: kind === "counting-result" ? CalculateProcessType.CPT_RESULT : CalculateProcessType.CPT_START,
      });
      this.countingAnswer = { confirmation: this.pendingConfirmation, accept };
      if (accept) this.setStatus("Counting accepted...", { game: true });
      else this.setStatus("counting rejected", { game: true, error: true });
      this.pendingConfirmation = null;
    } finally {
      this.changed();
    }
  }
  // The search the server is actually running, as opposed to the one the user
  // has just asked for. Only a running search can be cancelled.
  private get searching() {
    return this.matchIntent !== null && this.matchConfirmed === this.matchIntent;
  }
  selectMatchField(id: number) {
    try {
      if (!["ready", "finished", "matching"].includes(this.phase))
        throw Error("time settings cannot change during a game");
      const field = this.matchFields.find((f) => f.id === id);
      if (!field) throw Error("no time control available");
      if (this.phase !== "matching") {
        // A click always starts searching that time control, whether or not it
        // was the remembered one. Selecting alone made the result depend on
        // whether a previous search had already finished.
        this.startMatch(id);
      } else if (id !== this.fieldId) {
        this.switchMatchTo(id);
      } else if (this.searching) {
        // Clicking the searching control stops it. `searching` is false until
        // the server confirms the request, so an impatient repeat click cannot
        // cancel the search it just asked for.
        this.stopMatch();
      }
    } finally {
      this.changed();
    }
  }
  match() {
    try {
      if (!["ready", "finished"].includes(this.phase) || this.fieldId === null)
        throw Error("log in and wait for server discovery first");
      this.startMatch(this.fieldId);
    } finally {
      this.changed();
    }
  }
  cancelMatch() {
    try {
      if (this.phase !== "matching") throw Error("no matchmaking search to cancel");
      this.stopMatch();
    } finally {
      this.changed();
    }
  }
  switchMatch(id: number) {
    try {
      if (this.phase !== "matching")
        throw Error("time settings cannot change outside a search");
      const field = this.matchFields.find((f) => f.id === id);
      if (!field) throw Error("no time control available");
      if (id === this.fieldId) this.stopMatch();
      else this.switchMatchTo(id);
    } finally {
      this.changed();
    }
  }
  // Intent -> UI. Matchmaking phase and status change only here.
  private setMatchIntent(id: number | null, status = "Matchmaking cancelled",
    notice: StatusNotice | null = { kind: "matchmaking-cancelled" }) {
    this.matchIntent = id;
    if (id !== null) {
      const field = this.matchFields.find((f) => f.id === id);
      if (field) {
        this.fieldId = id;
        this.matchSettings = field;
        this.preferredTimeControl = field;
      }
      this.phase = "matching";
      this.setStatus(this.searchStatus(id));
      return;
    }
    if (this.phase === "matching") this.phase = "ready";
    this.setStatus(status, notice);
  }
  // Intent -> wire. Sends at most one message and records it as in flight.
  private pumpMatchmaking() {
    if (this.matchWire.kind !== "idle") return;
    if (this.matchConfirmed !== null && this.matchConfirmed !== this.matchIntent) {
      this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_AUTO_INVITE_CANCEL_REQUEST);
      this.matchWire = { kind: "cancel" };
      return;
    }
    if (this.matchIntent !== null && this.matchConfirmed !== this.matchIntent) {
      const field = this.matchIntent;
      this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_AUTO_INVITE_REQUEST, {
        [Room.AutoInviteRequest.field_id]: field,
        [Room.AutoInviteRequest.only_adjoin_grade]: false,
      });
      this.matchWire = { kind: "request", field };
    }
  }
  private startMatch(id: number) {
    const intent = this.matchIntent;
    this.matchIntent = id;
    try {
      this.pumpMatchmaking();
    } catch (error) {
      this.matchIntent = intent;
      throw error;
    }
    this.clearEstimate();
    this.resetGame();
    this.setMatchIntent(id);
  }
  private switchMatchTo(id: number) {
    const previous = {
      fieldId: this.fieldId,
      settings: this.matchSettings,
      preferred: this.preferredTimeControl,
      intent: this.matchIntent,
    };
    this.setMatchIntent(id);
    try {
      this.pumpMatchmaking();
    } catch (error) {
      this.fieldId = previous.fieldId;
      this.matchSettings = previous.settings;
      this.preferredTimeControl = previous.preferred;
      this.matchIntent = previous.intent;
      this.status = this.searchStatus();
      throw error;
    }
  }
  private stopMatch() {
    const intent = this.matchIntent;
    this.setMatchIntent(null);
    try {
      this.pumpMatchmaking();
    } catch (error) {
      this.matchIntent = intent;
      this.setMatchIntent(intent);
      throw error;
    }
  }
  private clearMatchmaking() {
    this.matchIntent = null;
    this.matchConfirmed = null;
    this.matchWire = { kind: "idle" };
  }
  private matchmakingPending() {
    return this.matchIntent !== null || this.matchConfirmed !== null ||
      this.matchWire.kind !== "idle";
  }
  private searchStatus(fieldId: number | null = this.fieldId) {
    const field =
      this.matchFields.find((f) => f.id === fieldId) ??
      this.matchSettings;
    return field
      ? `Searching for 19,${game.timeLabel(field)}...`
      : "Searching for game...";
  }
  quitRoom() {
    try {
      if (
        (!this.reconnectBoard?.game_over && !["playing", "finished"].includes(this.phase)) ||
        (!this.reconnectBoard?.game_over && !Object.keys(this.roomKey).length)
      )
        throw Error("no room to quit");
      if (this.quitRequested || (this.pending && !this.awaitingResignation))
        throw Error("waiting to confirm previous action");
      if (this.phase === "finished" || this.reconnectBoard?.game_over) {
        this.leaveFinishedRoom();
        return;
      }
      if (this.awaitingResignation) {
        this.roomExit = "after-resignation";
      } else {
        this.resign();
        this.roomExit = "resigning";
      }
      this.setStatus("Leaving room; waiting for confirm resignation...", { game: true });
    } finally {
      this.changed();
    }
  }
  leaveFinishedRoom() {
    try {
      const reviewingReconnect = !!this.reconnectBoard?.game_over;
      const transportPhase = this.phase;
      if (reviewingReconnect) this.finishReconnect();
      this.resetGame();
      this.phase = "ready";
      this.status = "Room left. Choose your next game.";
      if (reviewingReconnect) {
        this.reconnectBoard = this.snapshot();
        this.reconnectMode = "discovery";
        this.phase = transportPhase;
      }
    } finally {
      this.changed();
    }
  }
  onlineAction(messageId: number, fields: Fields) {
    try {
      if (this.spectating) throw Error("spectators cannot play game actions");
      if (
        this.phase !== "playing" ||
        !Object.keys(this.roomKey).length ||
        ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color)
      )
        throw Error("no active game");
      if (this.paused && messageId !== GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST) throw Error("game is paused");
      if (this.estimation) throw Error("return to the game before playing");
      if (this.pending && !(messageId === GoGameMessageID.GC_GIVE_UP_REQUEST && (this.awaitingMove || this.awaitingPass)))
        throw Error("waiting to confirm the previous action");
      this.sendFgwChannelMsg(game.GAME_SVR, messageId, fields, this.roomKey[Game.RoomKey.server_id]);
      this.pending = true;
      this.pendingMessageId = messageId;
      this.pendingSince = now();
    } finally {
      this.changed();
    }
  }
  play(x: number, y: number) {
    try {
      if (this.counting || this.pendingConfirmation)
        throw Error("finish the counting confirmation first");
      if (this.board.turn !== this.color) throw Error("wait for your turn");
      const board = this.board.clone(),
        captures = board.play(x, y, this.color);
      this.onlineAction(GoGameMessageID.GC_SET_PIECE_REQUEST, {
        [Game.SetPieceRequest.x]: x,
        [Game.SetPieceRequest.y]: y,
        [Game.SetPieceRequest.color]: this.color,
        [Game.SetPieceRequest.check_syn]: { [Game.CheckSyn.syn_seq_id]: this.synSeqId },
      });
      this.pendingMove = {
        board: this.board,
        clocks: structuredClone(this.clocks),
        x,
        y,
        color: this.color,
      };
      this.board = board;
      this.stopClock(this.color);
      this.onSound(placementSound(captures));
    } finally {
      this.changed();
    }
  }
  passTurn() {
    try {
      if (this.pendingConfirmation?.[0] !== "counting-request" &&
        (this.counting || this.pendingConfirmation))
        throw Error("finish the counting confirmation first");
      if (this.board.turn !== this.color) throw Error("wait for your turn");
      this.onlineAction(GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST, { [Game.SkipSetPieceRequest.check_syn]: { [Game.CheckSyn.syn_seq_id]: this.synSeqId } });
      // The turn moves at once; the reply only supplies the server clock and
      // sequence number. rollbackMove() restores the board on rejection.
      const board = this.board.clone();
      board.passTurn(this.color);
      this.pendingPass = { board: this.board, clocks: structuredClone(this.clocks), color: this.color };
      this.board = board;
      this.stopClock(this.color);
    } finally {
      this.changed();
    }
  }
  // Stops the acting player's clock at submission and starts the opponent's.
  private stopClock(color: number) {
    const clock = this.clocks[color];
    if (clock) {
      const remaining = clockReading(clock, now() - clock.at);
      Object.assign(clock, {
        main: remaining.main,
        periods: remaining.periods,
        byoyomi: remaining.seconds,
        at: now(),
      });
    }
    if (this.clocks[3 - color]) this.clocks[3 - color].at = now();
  }
  resign() {
    this.onlineAction(GoGameMessageID.GC_GIVE_UP_REQUEST, { [Game.GiveUpRequest.give_up_type]: this.color, [Game.GiveUpRequest.room_key]: this.roomKey });
  }
}
