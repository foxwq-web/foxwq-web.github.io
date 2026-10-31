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
import type { SessionState, TimeControl, Clock } from "./state";
import type { Transport, TransportOptions } from "./transport.ts";
import type { NetMsg } from "./framing.ts";
export interface SessionOptions {
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
export class Session {
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
  timer: ReturnType<typeof setTimeout> | null;
  bootstrapTimer?: ReturnType<typeof setTimeout>;
  generation: number;
  phase: string;
  status: string;
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
  pending: boolean;
  pendingMessageId: number | null = null;
  quitRequested: boolean;
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
  private reconnectBoardModel: Board | null = null;
  private reconnectAttempt = 0;
  private reconnectStatus = "";
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
    this.networkLog = new NetworkLog();
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
    this.pending = false;
    this.quitRequested = false;
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
    if (this.reconnectBoard) return structuredClone({
      ...this.reconnectBoard,
      phase: "reconnecting",
      status: this.reconnectStatus,
      pending: false,
      pendingMove: false,
      confirmation: false,
      confirmationKind: null,
      counting: false,
      estimation: null,
      gatewayAvailable: false,
    });
    return structuredClone({
      phase: this.phase,
      status: this.status,
      stones: this.board.stones,
      turn: this.board.turn,
      komi: this.komi,
      captures: this.board.captures,
      passes: this.board.passes,
      moves: this.board.moves.length,
      result: this.result,
      game_over: this.gameOver,
      time: this.matchSettings ? game.timeLabel(this.matchSettings) : "",
      matchFields: this.matchFields,
      fieldPlayers: this.fieldPlayers,
      fieldId: this.fieldId,
      color: this.color,
      pending: this.pending,
      pendingMove: this.awaitingMove,
      quitRequested: this.quitRequested,
      players: this.players,
      account: this.account,
      playerInfo: this.playerInfo.current,
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
      gatewayAvailable: !!this.fgwConnection,
      koStones: this.board.history.at(-1) ?? null,
    });
  }
  private resetGame() {
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
    this.quitRequested = false;
    this.pendingConfirmation = null;
    this.counting = false;
    this.countingAnswer = null;
  }
  close() {
    try {
      clearTimeout(this.reconnectTimer);
      this.reconnectBoard = null;
      this.reconnectAttempt = 0;
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
        throw Error("Enter your username and password");
      const request = loginRequest(username, password);
      this.close();
      this.loginPacket = request;
      this.account = { name: username, rank: "" };
      this.phase = "connecting";
      this.status = "Connecting...";
      this.timeout(this.generation, "Login timed out");
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
        this.failed(generation, "Login connection failed");
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
  failed(generation: number, reason: string) {
    try {
      if (generation !== this.generation) return;
      const recovery = this.gameEnvRecovery;
      this.gameEnvRecovery = null;
      if (this.phase === "finished" && this.gameOver) {
        // Review is local. Losing the optional connection for the next game
        // must not reset the board, variations, or an in-progress estimate.
        this.generation++;
        clearTimeout(this.timer ?? undefined);
        clearTimeout(this.bootstrapTimer);
        clearTimeout(this.reconnectTimer);
        this.timer = null;
        this.fgwConnection?.close();
        this.connection?.close();
        this.fgwConnection = this.connection = null;
        return;
      }
      if (this.loginPacket &&
          (this.reconnectBoard || recovery || (this.phase === "playing" && [StoneColor.BLACK, StoneColor.WHITE].includes(this.color)))) {
        const first = !this.reconnectBoard;
        this.reconnectBoardModel ??= recovery?.board ?? this.pendingMove?.board ?? this.board;
        this.reconnectBoard ??= recovery?.state ?? this.snapshot();
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
        this.quitRequested = false;
        if (first) this.reconnect();
        else {
          this.reconnectStatus = `Reconnection ${/timed out/i.test(reason) ? "timed out" : "failed"}: ${reason}. Retrying... (Attempt ${this.reconnectAttempt})`;
          this.reconnectTimer = setTimeout(() => this.reconnect(), 2000);
        }
        return;
      }
      this.close();
      this.phase = "error";
      this.status = reason;
    } finally {
      this.changed();
    }
  }
  private reconnect() {
    if (!this.reconnectBoard || !this.loginPacket) return;
    this.reconnectAttempt++;
    this.reconnectStatus = `Connection lost. Reconnecting... (Attempt ${this.reconnectAttempt})`;
    this.phase = "connecting";
    this.token = Buffer.alloc(0);
    this.fieldsLoaded = false;
    this.gameLockChecked = false;
    this.roomKey = {};
    this.expectedRoomKey = null;
    this.startedRoom = null;
    this.timeout(this.generation, "Reconnection timed out");
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
      ? "Another client logged in"
      : `Fox ended this session${code ? ` (code ${code})` : ""}`;
    const restriction = message.one(Fgw.KickOutNotify.forbid_login_time);
    if ((typeof restriction === "number" || typeof restriction === "bigint") && restriction > 0)
      reason += ". Fox has restricted login";

    const saved = this.reconnectBoard ?? this.gameEnvRecovery?.state;
    const board = this.reconnectBoardModel ?? this.pendingMove?.board ?? this.board;
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
    this.paused = false;
    this.pauseTimeSeconds = null;
    this.gameEnvRecovery = null;
    this.expectedRoomKey = null;
    this.reconnectBoard = null;
    this.reconnectBoardModel = null;
    this.reconnectAttempt = 0;
    this.pending = false;
    this.pendingMessageId = null;
    this.pendingSince = 0;
    this.pendingConfirmation = null;
    this.countingAnswer = null;
    this.counting = false;
    this.quitRequested = false;
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
            this.failed(generation, reason);
            return;
          }
          this.uid = uid;
          const account = m.sub(3);
          this.account = {
            name: account.text(3) || account.text(2) || this.account?.name || "",
            rank: account.has(4) ? game.rankLabel(signed(account.one(4))) : "",
          };
          this.token = token;
          this.phase = "bootstrap";
          this.status = "Fetching server list...";
          this.connection!.send(3000, encode({ 1: uid, 2: false }));
          this.connection!.send(3010, encode({ 1: uid }));
          this.timeout(generation, "Server discovery timed out");
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
            throw Error("Server list has no usable gateway");
          this.phase = "gateway";
          this.status = "Connecting to gateway...";
          this.timeout(generation, "Gateway discovery timed out");
          void this.startConnectFgwServer(generation, host, port);
        }
      } catch (error) {
        this.failed(generation, "Invalid protocol response");
      }
    } finally {
      this.changed();
    }
  }
  async startConnectFgwServer(generation: number, host: string, port: number) {
    try {
      let connection;
      try {
        connection = await this.open(host, port, generation);
        if (generation !== this.generation) {
          connection.close();
          return;
        }
        this.fgwConnection = connection;
        this.sendFgwChannelMsg(game.SVR_TYPE_FGW, ClientMessageID.MID_LOGIN_REQUEST, { [Fgw.LoginRequest.session]: this.token });
        connection.start?.();
      } catch (error) {
        connection?.close();
        this.failed(generation, "Gateway connection failed");
      }
    } finally {
      this.changed();
    }
  }
  sendFgwChannelMsg(serverType: number, messageId: number, fields: Fields = {}, serverId = 0) {
    if (!this.fgwConnection) throw Error("Gateway is disconnected");
    this.fgwConnection.send(
      LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET,
      game.encodeFgwMessage(this.uid, serverType, messageId, fields, serverId),
    );
  }
  private expectedGameRoom() {
    if (this.gameEnvRecovery) return this.gameEnvRecovery.roomKey;
    if (this.reconnectBoard)
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
      roomKey: { ...this.roomKey }, state: this.snapshot(), board: this.pendingMove?.board ?? this.board,
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
          this.failed(generation, "Network response timed out");
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
                this.failed(generation, "Game synchronization timed out");
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
        this.failed(generation, "Heartbeat failed");
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
        this.playerInfo.receive(m);
      } else if (serverType === game.SVR_TYPE_FGW) {
        if (messageId === ClientMessageID.MID_LOGIN_REQUEST) {
          if (signed(m.one(Fgw.LoginResponse.op_code))) {
            this.failed(generation, `Gateway login status ${signed(m.one(Fgw.LoginResponse.op_code))}`);
            return;
          }
          clearTimeout(this.timer ?? undefined);
          this.status = "Discovering game settings...";
          this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_LOGIN_GAME_SVR_MGR_REQUEST, { 1: true });
          this.heartbeat(generation);

          this.bootstrapTimer = setTimeout(() => {
            if (
              !this.fieldsLoaded ||
              !this.gameLockChecked ||
              this.phase === "resuming"
            )
              this.failed(generation, "Room discovery timed out");
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
        if (signed(m.one(Room.LoginGameSvrMgrResponse.result))) throw Error("Room manager login failed");
        this.preloadPlayerInfo();
        for (const operation of [RoomMessageID.RM_FETCH_ALL_FIELD_INFO_REQUEST, RoomMessageID.RM_QUERY_GAME_LOCK_REQUEST, RoomMessageID.RM_FETCH_FIELD_CFG])
          this.sendFgwChannelMsg(game.GAME_SVR_MGR, operation);
        this.fieldPlayersRequestedAt = Math.floor(performance.now());
      } else if (messageId === RoomMessageID.RM_QUERY_GAME_LOCK_REQUEST) {
        if (this.phase === "finished" && this.gameOver) return;
        if (m.number(Room.QueryGameLockResponse.result) === 0 && m.number(Room.QueryGameLockResponse.server_type) === game.GAME_SVR) {
          const room = validateGameRoom(messageId, m, undefined, this.expectedGameRoom());
          if (!room) return;
          this.expectedRoomKey = room.roomKey;
          this.gameLockChecked = true;
          this.phase = "resuming";
          this.status = "Reconnecting...";
          this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, {}, m.number(Room.QueryGameLockResponse.server_id));
        } else if (this.reconnectBoard) {
          this.gameLockChecked = true;
          // The lock can disappear when the game ends during the outage.
          this.phase = "resuming";
          this.sendFgwChannelMsg(game.GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, {}, Number(this.reconnectBoard.gameId.split(":")[1]));
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
        if (this.phase !== "matching") return;
        this.phase = signed(m.one(Room.AutoInviteResponse.result)) ? "ready" : "matching";
        this.status = signed(m.one(Room.AutoInviteResponse.result))
          ? `matchmaking rejected: ${signed(m.one(Room.AutoInviteResponse.result))}`
          : `Searching for a game...`;
      } else if ([RoomMessageID.RM_AUTO_INVITE_TIMEOUT_NOTIFY, RoomMessageID.RM_AUTO_INVITE_CANCEL_REQUEST, RoomMessageID.RM_AUTO_INVITE_CANCEL_NOTIFY].includes(messageId)) {
        if (this.phase !== "matching") return;
        this.pendingConfirmation = null;
        this.phase = "ready";
        this.status = messageId === RoomMessageID.RM_AUTO_INVITE_TIMEOUT_NOTIFY
          ? "Matchmaking timed out"
          : "Matchmaking cancelled";
      } else if (messageId === RoomMessageID.RM_ENTER_ROOM_NOTIFY) {
        if (!["matching", "joining", "playing"].includes(this.phase)) return;
        if (this.phase === "matching" && signed(m.one(Room.EnterRoomNotify.result))) throw Error("Room entry failed");
        const room = validateGameRoom(messageId, m, undefined, this.expectedGameRoom());
        if (!room || (this.phase === "matching" && this.isPreviousRoom(room.roomKey))) return;
        if (signed(m.one(Room.EnterRoomNotify.result))) throw Error("Room entry failed");
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
      if (this.account) this.playerInfo.prefetch(this.uid, this.account.name, this.account.rank);
      for (const player of Object.values(this.players)) {
        if (player.id) this.playerInfo.prefetch(player.id, player.name, player.rank);
      }
    });
  }
  discoveryReady() {
    if (!this.fieldsLoaded || !this.gameLockChecked) return;
    if (this.phase !== "resuming") clearTimeout(this.bootstrapTimer);
    if (["gateway", "bootstrap"].includes(this.phase)) {
      this.phase = "ready";
      this.status = this.matchFields.length
        ? "Choose your time control"
        : "No time controls available";
    }
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
      if (this.reconnectBoard && ![GoGameMessageID.GC_START_SET_PIECE_NOTIFY, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST].includes(messageId)) return;
      if (["ready", "disconnected", "error", "kicked"].includes(this.phase)) return;
      if (
        this.phase === "matching" &&
        !Object.keys(this.roomKey).length &&
        messageId !== GoGameMessageID.GC_START_SET_PIECE_NOTIFY
      )
        return;
      const room = validateGameRoom(messageId, m, header, this.expectedGameRoom());
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
          if (!m.has(Game.FetchGameEnvResponse.check_syn)) throw Error("Game snapshot has no synchronization state");
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
        if (signed(m.one(Game.GameSvrRoomMsgResponse.result))) throw Error("Game room rejected entry");
      } else if (messageId === GoGameMessageID.GC_START_SET_PIECE_NOTIFY) {
        if (this.reconnectBoard) {
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
        this.phase = "playing";
        this.status = "Game started";
        this.pendingMove = null;
        this.pending = false;
        this.synSeqId = 0;
        this.pendingConfirmation = null;
        this.counting = false;
        this.countingAnswer = null;
        this.quitRequested = false;
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
        if (this.pendingMessageId !== GoGameMessageID.GC_GIVE_UP_REQUEST) this.pending = false;
        this.status = "";
      } else if (messageId === GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY) {
        const color = this.board.turn;
        if (color === 3 - this.color) this.opponentDisconnectDeadline = null;
        this.board.passTurn();
        this.clock(color, m.sub(Game.SkipSetPieceNotify.countdown));
        this.synSeqId = m.sub(Game.SkipSetPieceNotify.check_syn).number(Game.CheckSyn.syn_seq_id, this.synSeqId);
        this.pending = false;
        this.status =
          this.board.turn === this.color ? "Opponent passed" : "You passed";
      } else if ([
        GoGameMessageID.GC_SET_PIECE_REQUEST,
        GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST,
        GoGameMessageID.GC_CALCULATE_REQUEST,
        GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST,
        GoGameMessageID.GC_GIVE_UP_REQUEST,
      ].includes(messageId)) {
        if (signed(m.one(Game.SetPieceResponse.result))) {
          if (messageId === GoGameMessageID.GC_GIVE_UP_REQUEST && this.pendingMove) {
            this.pendingMessageId = GoGameMessageID.GC_SET_PIECE_REQUEST;
          } else {
            this.rollbackMove();
            if (messageId === GoGameMessageID.GC_SET_PIECE_REQUEST) this.clearEstimate();
            if (messageId !== GoGameMessageID.GC_SET_PIECE_REQUEST || this.pendingMessageId !== GoGameMessageID.GC_GIVE_UP_REQUEST) this.pending = false;
          }
          this.status = `Action ${messageId} rejected: ${signed(m.one(Game.SetPieceResponse.result))}`;
          if (messageId === GoGameMessageID.GC_GIVE_UP_REQUEST) this.quitRequested = false;
          if (messageId === GoGameMessageID.GC_CALCULATE_REQUEST) this.counting = false;
          if (messageId === GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST && this.countingAnswer) {
            this.pendingConfirmation = this.countingAnswer.confirmation;
            this.countingAnswer = null;
          }
        } else if ([GoGameMessageID.GC_CALCULATE_REQUEST, GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST].includes(messageId)) {
          this.pending = false;
          if (messageId === GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST && this.countingAnswer) {
            if (!this.countingAnswer.accept) {
              this.counting = false;
              this.status = "Counting rejected. Continue.";
            }
            this.countingAnswer = null;
          }
        }
      } else if (messageId === GoGameMessageID.GC_CALCULATE_ANSWER_NOTIFY && [CalculateProcessType.CPT_START, CalculateProcessType.CPT_RESULT].includes(m.number(Game.CalculateAnswerNotify.type, CalculateProcessType.CPT_START))) {
        this.pending = false;
        this.pendingConfirmation = null;
        this.countingAnswer = null;
        this.counting = Boolean(m.number(Game.CalculateAnswerNotify.accept));
        this.status = m.number(Game.CalculateAnswerNotify.accept)
          ? "Counting accepted"
          : "Counting rejected. Continue.";
      } else if ([GoGameMessageID.GC_GAME_COUNTDOWN_NOTIFY, GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY].includes(messageId) && [StoneColor.BLACK, StoneColor.WHITE].includes(this.color)) {
        // ResumeCountdownNotify (109) wraps the same clock data as 108.
        // Fox can answer a counting rejection with 304 status 1, then resume
        // the clock without sending 306. Resumption ends the counting flow,
        // including any confirmation restored by the nonzero 304 response.
        if (messageId === GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY && this.phase === "playing" && this.counting) {
          this.pending = false;
          this.pendingConfirmation = null;
          this.countingAnswer = null;
          this.counting = false;
          this.status = "Counting rejected. Continue.";
        }
        const timing = messageId === GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY ? m.sub(Game.ResumeCountdownNotify.countdown) : m;
        if (timing.has(Game.GameCountdownNotify.uid)) {
          const color = timing.number(Game.GameCountdownNotify.uid) === this.uid ? this.color : 3 - this.color;
          this.readClock(color, timing, true);
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
          this.pending = false;
          this.pendingConfirmation = null;
          this.counting = false;
          this.countingAnswer = null;
          this.status = `Counting failed: ${status}`;
        } else if ([StoneColor.BLACK, StoneColor.WHITE].includes(mode)) {
          this.pending = false;
          this.counting = true;
          this.countingAnswer = null;
          this.pendingConfirmation = [
            mode === CalculateProcessType.CPT_START ? "counting-request" : "counting-result",
            game.plain(m),
            mode === CalculateProcessType.CPT_RESULT ? game.decodeCalculateConfirmNotify(m) : null,
          ];
          this.status =
            mode === CalculateProcessType.CPT_START
              ? "Opponent requested counting"
              : "Counting result needs your confirmation";
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
        if (signed(m.one(Game.FetchGameEnvResponse.result))) throw Error("Game synchronization failed");
        // Decode before replacing the board or clearing reconnect/recovery state.
        const result = m.number(Game.FetchGameEnvResponse.game_state) === GameStatus.GS_END && m.has(Game.FetchGameEnvResponse.game_result) ? m.sub(Game.FetchGameEnvResponse.game_result) : null;
        const restoredResult = result ? {
          winner: result.number(Game.GameResult.winner),
          margin: result.has(Game.GameResult.points) ? signed(result.one(Game.GameResult.points)) : null,
          reason: result.number(Game.GameResult.reason),
        } : null;
        const previousBoard = this.pendingMove?.board ?? this.board;
        this.roomKey = room.roomKey;
        this.expectedRoomKey = null;
        const roomKey = Object.values(this.roomKey).join(":");
        const sameGame = roomKey === this.boardRoomKey;
        if (!sameGame || m.number(Game.FetchGameEnvResponse.game_state) === GameStatus.GS_END) this.opponentDisconnectDeadline = null;
        this.synSeqId = m.sub(Game.FetchGameEnvResponse.check_syn).number(Game.CheckSyn.syn_seq_id);
        this.pendingMove = null;
        this.board = new Board();
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
        if ((this.reconnectBoard || this.gameEnvRecovery) && ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color))
          throw Error("Game synchronization did not restore the player");
        if (this.gameEnvRecovery) this.pendingMessageId = null;
        this.gameEnvRecovery = null;
        this.reconnectBoard = null;
        this.reconnectBoardModel = null;
        this.reconnectAttempt = 0;
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
            this.quitRequested = false;
            this.status = "Failed to end game";
          }
        }
      }
    } finally {
      this.changed();
    }
  }
  readGameUserInfo(user: Message) {
    const color = user.number(Game.GameUserInfo.stone_color);
    if (![StoneColor.BLACK, StoneColor.WHITE].includes(color)) return;
    const previous =
      this.players[color]?.id === user.number(Game.GameUserInfo.uid) ? this.players[color] : null;
    this.players[color] = {
      id: user.number(Game.GameUserInfo.uid),
      name: user.text(Game.GameUserInfo.nickname) || user.text(Game.GameUserInfo.platform_picture) || previous?.name || "",
      rank: user.has(Game.GameUserInfo.grade)
        ? game.rankLabel(signed(user.one(Game.GameUserInfo.grade)))
        : (previous?.rank ?? ""),
    };
    if (user.number(Game.GameUserInfo.uid) === this.uid) {
      this.account = {
        name: this.players[color].name || this.account?.name || "",
        rank: this.players[color].rank || this.account?.rank || "",
      };
    }
    this.preloadPlayerInfo();
  }
  announceStart(resuming: boolean) {
    const room = Object.values(this.roomKey).join(":");
    if (!room || room === this.startedRoom) return;
    this.startedRoom = room;
    if (!resuming) this.onSound("start-play");
  }
  rollbackMove() {
    if (!this.pendingMove) return;
    this.board = this.pendingMove.board;
    this.clocks = this.pendingMove.clocks;
    this.pendingMove = null;
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
  updateGameResult(m: Message) {
    this.setGameResult(m.number(Game.SetGameEndNotify.winner), m.has(Game.SetGameEndNotify.points) ? signed(m.one(Game.SetGameEndNotify.points)) : null, m.number(Game.SetGameEndNotify.reason));
  }
  private setGameResult(winner: number, margin: number | null, reason: number) {
    this.paused = false;
    this.pauseTimeSeconds = null;
    this.pendingConfirmation = null;
    this.counting = false;
    this.countingAnswer = null;
    const ending = reason === ENGameEndReason.EER_OPP_RESIGN ? "R" : reason === ENGameEndReason.EER_INVALIDGAME_ROUNDNUM_TOO_SMALL ? "Void" : margin === SpecialResult.SR_TIMEOUT ? "T" : "";
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
  estimateScore(position?: Pick<Board, "stones" | "captures">) {
    if (
      (this.phase !== "playing" && !(this.phase === "finished" && this.gameOver)) ||
      !Object.keys(this.roomKey).length ||
      ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color)
    )
      throw Error("Score estimation requires an active game");
    if (this.paused) throw Error("Game is paused");
    if ((this.pending && !this.awaitingMove) ||
      (this.pendingConfirmation?.[0] !== "counting-request" &&
        (this.counting || this.pendingConfirmation)))
      throw Error("Finish the pending game action first");
    if (this.estimation && this.estimation.phase !== "error")
      throw Error("An estimate is already open");
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
          throw Error("Score estimation timed out");
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
            ? "Score estimation timed out"
            : error instanceof Error
              ? error.message
              : String(error),
        };
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
        throw Error("A confirmation or counting request is already active");
      if (this.phase === "playing" && this.board.turn !== this.color)
        throw Error("Wait for your turn");
      this.onlineAction(GoGameMessageID.GC_CALCULATE_REQUEST, { [Game.CalculateRequest.extend]: 0 });
      this.counting = true;
      this.status = "Counting requested; waiting for opponent";
    } finally {
      this.changed();
    }
  }
  confirm(accept: boolean) {
    try {
      if (typeof accept !== "boolean") throw Error("accept must be boolean");
      if (!this.pendingConfirmation) throw Error("No pending confirmation");
      const [kind] = this.pendingConfirmation;
      if (!["counting-request", "counting-result"].includes(kind))
        throw Error("No pending counting confirmation");
      if (this.phase !== "playing")
        throw Error("No active game");

      this.clearEstimate();

      this.onlineAction(GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST, {
        [Game.CalculateAnswerRequest.accept]: accept,
        [Game.CalculateAnswerRequest.type]: kind === "counting-result" ? CalculateProcessType.CPT_RESULT : CalculateProcessType.CPT_START,
      });
      this.countingAnswer = { confirmation: this.pendingConfirmation, accept };
      this.status = accept
        ? "Counting accepted..."
        : "Counting rejected...";
      this.pendingConfirmation = null;
    } finally {
      this.changed();
    }
  }
  selectMatchField(id: number) {
    try {
      if (!["ready", "finished"].includes(this.phase))
        throw Error("Time settings cannot change during matchmaking or a game");
      const field = this.matchFields.find((f) => f.id === id);
      if (!field) throw Error("No time control available");
      this.fieldId = id;
      this.matchSettings = field;
      this.preferredTimeControl = field;
    } finally {
      this.changed();
    }
  }
  match() {
    try {
      if (
        !["ready", "finished"].includes(this.phase) ||
        this.fieldId === null
      )
        throw Error("Log in and wait for server discovery first");
      this.clearEstimate();
      this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_AUTO_INVITE_REQUEST, { [Room.AutoInviteRequest.field_id]: this.fieldId, [Room.AutoInviteRequest.only_adjoin_grade]: false });
      this.resetGame();
      this.phase = "matching";
      this.status = "Requesting a match...";
    } finally {
      this.changed();
    }
  }
  quitRoom() {
    try {
      if (
        !["playing", "finished"].includes(this.phase) ||
        !Object.keys(this.roomKey).length
      )
        throw Error("No room to quit");
      if (this.quitRequested || this.pending)
        throw Error("Waiting to confirm previous action");
      if (this.phase === "finished") {
        this.leaveFinishedRoom();
        return;
      }
      this.resign();
      this.quitRequested = true;
      this.status = "Leaving room; waiting for confirm resignation...";
    } finally {
      this.changed();
    }
  }
  leaveFinishedRoom() {
    try {
      this.resetGame();
      this.phase = "ready";
      this.status = "Room left. Choose your next game.";
    } finally {
      this.changed();
    }
  }
  cancelMatch() {
    try {
      if (this.phase !== "matching")
        throw Error("No active matchmaking request");
      this.sendFgwChannelMsg(game.GAME_SVR_MGR, RoomMessageID.RM_AUTO_INVITE_CANCEL_REQUEST);
    } finally {
      this.changed();
    }
  }
  onlineAction(messageId: number, fields: Fields) {
    try {
      if (
        this.phase !== "playing" ||
        !Object.keys(this.roomKey).length ||
        ![StoneColor.BLACK, StoneColor.WHITE].includes(this.color)
      )
        throw Error("No active game");
      if (this.paused && messageId !== GoGameMessageID.GC_CALCULATE_ANSWER_REQUEST) throw Error("Game is paused");
      if (this.estimation) throw Error("Return to the game before playing");
      if (this.pending && !(messageId === GoGameMessageID.GC_GIVE_UP_REQUEST && this.awaitingMove))
        throw Error("Waiting to confirm the previous action");
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
        throw Error("Finish the counting confirmation first");
      if (this.board.turn !== this.color) throw Error("Wait for your turn");
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
      const clock = this.clocks[this.color];
      if (clock) {
        const remaining = clockReading(clock, now() - clock.at);
        Object.assign(clock, {
          main: remaining.main,
          periods: remaining.periods,
          byoyomi: remaining.seconds,
          at: now(),
        });
      }
      if (this.clocks[3 - this.color]) this.clocks[3 - this.color].at = now();
      this.board = board;
      this.onSound(placementSound(captures));
    } finally {
      this.changed();
    }
  }
  passTurn() {
    try {
      if (this.pendingConfirmation?.[0] !== "counting-request" &&
        (this.counting || this.pendingConfirmation))
        throw Error("Finish the counting confirmation first");
      if (this.board.turn !== this.color) throw Error("Wait for your turn");
      this.onlineAction(GoGameMessageID.GC_SKIP_SET_PIECE_REQUEST, { [Game.SkipSetPieceRequest.check_syn]: { [Game.CheckSyn.syn_seq_id]: this.synSeqId } });
    } finally {
      this.changed();
    }
  }
  resign() {
    try {
      this.onlineAction(GoGameMessageID.GC_GIVE_UP_REQUEST, { [Game.GiveUpRequest.give_up_type]: this.color, [Game.GiveUpRequest.room_key]: this.roomKey });
    } finally {
      this.changed();
    }
  }
}
