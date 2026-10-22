import { Buffer } from "buffer";
import SparkMD5 from "spark-md5";
import * as game from "./game.ts";
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
import type { Frame } from "./framing.ts";
export interface SessionOptions {
  host?: string;
  port?: number;
  proxyUrl?: string;
  proxyToken?: string;
  preferredTimeControl?: Omit<TimeControl, "id"> | null;
  connectionFactory?: (
    host: string,
    port: number,
    receive: (frame: Frame) => void,
    failed: (reason: string) => void,
    options: TransportOptions,
  ) => Promise<Transport>;
  estimationFetcher?: Estimator;
  onSound?: (name: string) => void;
  onChange?: (state: SessionState) => void;
}
type Confirmation = [
  string,
  Fields,
  (ReturnType<typeof game.countingResult> | null)?,
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
  gateway: Transport | null;
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
  color: number;
  sync: number;
  boardRoomKey = "";
  pendingMove: {
    board: Board;
    clocks: Record<string, Clock>;
    x: number;
    y: number;
    color: number;
  } | null;
  pending: boolean;
  pendingAction: number | null = null;
  quitRequested: boolean;
  startedRoom: string | null;
  clocks: Record<string, Clock>;
  opponentDisconnectDeadline: number | null = null;
  pendingConfirmation: Confirmation | null;
  counting: boolean;
  countingAnswer: { confirmation: Confirmation; accept: boolean } | null;
  changeQueued = false;
  lastChangeKey = "";
  pendingSince = 0;
  private loginPacket: Buffer | null = null;
  private reconnectBoard: SessionState | null = null;
  private reconnectAttempt = 0;
  private reconnectStatus = "";
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private lastGatewayResponse = 0;
  constructor({
    host = "43.132.13.39",
    port = 10000,
    proxyUrl = "",
    proxyToken = "",
    preferredTimeControl = null,
    connectionFactory = Connection.open,
    estimationFetcher = localEstimate,
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
    this.connection = null;
    this.gateway = null;
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
    this.sync = 0;
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
      clocks: this.clocks,
      opponentDisconnectDeadline: this.opponentDisconnectDeadline,
      gameId: Object.values(this.roomKey).join(":"),
      last_move: this.board.moves.at(-1) ?? null,
      confirmation: this.pendingConfirmation !== null,
      counting: this.counting,
      confirmationKind: this.pendingConfirmation?.[0] ?? null,
      countingResult: this.pendingConfirmation?.[2] ?? null,
      estimation: this.estimation,
      gatewayAvailable: !!this.gateway,
      koStones: this.board.history.at(-1) ?? null,
    });
  }
  close() {
    try {
      clearTimeout(this.reconnectTimer);
      this.reconnectBoard = null;
      this.opponentDisconnectDeadline = null;
      this.reconnectAttempt = 0;
      this.loginPacket = null;
      this.clearEstimate();
      this.rollbackMove();
      this.generation++;
      clearTimeout(this.bootstrapTimer);
      clearTimeout(this.timer ?? undefined);
      this.timer = null;
      this.gateway?.close();
      this.connection?.close();
      this.gateway = this.connection = null;
      this.token = Buffer.alloc(0);
      this.uid = 0;
      this.fieldId = null;
      this.matchFields = [];
      this.matchSettings = null;
      this.fieldsLoaded = false;
      this.fieldPlayers = {};
      this.fieldPlayersRequestedAt = 0;
      this.gameLockChecked = false;
      this.roomKey = {};
      this.color = 0;
      this.quitRequested = false;
      this.startedRoom = null;
      this.phase = "disconnected";
      this.status = "Disconnected";
      this.pending = false;
      this.pendingConfirmation = null;
      this.counting = false;
      this.countingAnswer = null;
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
      this.players = {};
      this.board = new Board();
      this.clocks = {};
      this.result = "";
      this.gameOver = false;
      this.roomKey = {};
      this.color = 0;
      this.sync = 0;
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
      if (this.gateway && !this.gateway.closed) {
        this.connection = null;
      } else this.failed(generation, reason);
    } finally {
      this.changed();
    }
  }
  failed(generation: number, reason: string) {
    try {
      if (generation !== this.generation) return;
      if (this.loginPacket &&
          (this.reconnectBoard || (this.phase === "playing" && [1, 2].includes(this.color)))) {
        const first = !this.reconnectBoard;
        this.reconnectBoard ??= this.snapshot();
        this.clearEstimate();
        this.rollbackMove();
        // Invalidate callbacks before closing either transport.
        this.generation++;
        clearTimeout(this.timer ?? undefined);
        clearTimeout(this.bootstrapTimer);
        clearTimeout(this.reconnectTimer);
        this.gateway?.close();
        this.connection?.close();
        this.gateway = this.connection = null;
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
    this.startedRoom = null;
    this.timeout(this.generation, "Reconnection timed out");
    void this.connect(this.generation, this.loginPacket);
    this.changed();
  }
  receive(generation: number, packet: Frame) {
    try {
      if (generation !== this.generation) return;
      try {
        if (packet.command === 26200) {
          this.gatewayMessage(generation, packet);
          return;
        }
        const m = decode(packet.payload);
        if (packet.command === 2005) {
          clearTimeout(this.timer ?? undefined);
          const code = signed(m.one(1)),
            uid = m.number(2) || m.sub(3).number(1),
            token = m.bytes(8);
          if (code || !uid || !token.length) {

            const reason =
              code === 111231
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
          packet.command === 3005 &&
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
          void this.connectGateway(generation, host, port);
        }
      } catch (error) {
        this.failed(generation, "Invalid protocol response");
      }
    } finally {
      this.changed();
    }
  }
  async connectGateway(generation: number, host: string, port: number) {
    try {
      let connection;
      try {
        connection = await this.open(host, port, generation);
        if (generation !== this.generation) {
          connection.close();
          return;
        }
        this.gateway = connection;
        this.send(game.GATEWAY, 1, { 1: this.token });
        connection.start?.();
      } catch (error) {
        connection?.close();
        this.failed(generation, "Gateway connection failed");
      }
    } finally {
      this.changed();
    }
  }
  send(service: number, op: number, fields: Fields = {}, node = 0) {
    if (!this.gateway) throw Error("Gateway is disconnected");
    this.gateway.send(
      26200,
      game.envelope(this.uid, service, op, fields, node),
    );
  }
  heartbeat(generation: number) {
    try {
      if (generation !== this.generation || !this.gateway) return;
      try {
        if (now() - this.lastGatewayResponse > 20) {
          this.failed(generation, "Network response timed out");
          return;
        }
        const ticks = Math.floor(performance.now());
        this.send(game.GATEWAY, 5, { 1: ticks });
        this.send(game.ROOM, 100010, { 1: ticks });
        this.refreshFieldPlayers(ticks);
        if (Object.keys(this.roomKey).length) {
          if (this.pending && now() - this.pendingSince > 8) {
            this.send(game.GAME, 501, {}, this.roomKey[2]);
            this.pendingSince = now();
          }
          this.send(
            game.GAME,
            200,
            { 1: ticks, 3: this.roomKey },
            this.roomKey[2],
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
  gatewayMessage(generation: number, packet: Frame) {
    try {
      this.lastGatewayResponse = now();
      const [header, m] = game.unpack(packet.payload),
        service = header.number(7),
        op = header.number(1);
      if (service === game.GATEWAY) {
        if (op === 1) {
          if (signed(m.one(1))) {
            this.failed(generation, `Gateway login status ${signed(m.one(1))}`);
            return;
          }
          clearTimeout(this.timer ?? undefined);
          this.status = "Discovering game settings...";
          this.send(game.ROOM, 100008, { 1: true });
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
        } else if (op === 100)
          this.failed(
            generation,
            "Session ended (another client may have logged in)",
          );
      } else if (service === game.ROOM) this.roomMessage(op, m);
      else if (service === game.GAME) this.gameMessage(op, m, header);
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
    this.send(game.ROOM, 100145);
    this.fieldPlayersRequestedAt = ticks;
  }
  roomMessage(op: number, m: Message) {
    try {
      if (op === 100008) {
        if (signed(m.one(1))) throw Error("Room manager login failed");
        for (const operation of [100145, 100115, 100150])
          this.send(game.ROOM, operation);
        this.fieldPlayersRequestedAt = Math.floor(performance.now());
      } else if (op === 100115) {
        this.gameLockChecked = true;
        if (m.number(1) === 0 && m.number(2) === game.GAME) {
          this.phase = "resuming";
          this.status = "Reconnecting...";
          this.send(game.GAME, 501, {}, m.number(3));
        } else if (this.reconnectBoard) {
          // The lock can disappear when the game ends during the outage.
          this.phase = "resuming";
          this.send(game.GAME, 501, {}, Number(this.reconnectBoard.gameId.split(":")[1]));
        } else this.discoveryReady();
      } else if (op === 100145) {
        if (signed(m.one(1))) {
          return;
        }
        const counts: Record<string, number> = {};
        for (const record of (m.get(2) ?? []).map(decode)) {
          const id = record.number(1),
            count = record.number(2);
          if (
            Number.isSafeInteger(id) &&
            id > 0 &&
            Number.isSafeInteger(count) &&
            count >= 0
          )
            counts[id] = count;
        }
        this.fieldPlayers = counts;
      } else if (op === 100150) {
        this.fieldsLoaded = true;
        this.matchFields = game.matchFields((m.get(1) ?? []).map(decode));
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
      } else if (op === 100130) {
        if (this.phase !== "matching") return;
        this.phase = signed(m.one(1)) ? "ready" : "matching";
        this.status = signed(m.one(1))
          ? `Matchmaking rejected: ${signed(m.one(1))}`
          : `Searching for a game...`;
      } else if ([100132, 100139, 100141].includes(op)) {
        if (this.phase !== "matching") return;
        this.pendingConfirmation = null;
        this.phase = "ready";
        this.status = "Matchmaking ended";
      } else if (op === 100140) {
        if (!["matching", "joining", "playing"].includes(this.phase)) return;
        if (signed(m.one(1))) throw Error("Room entry failed");
        this.roomKey = {
          1: m.number(2),
          2: m.number(3),
          3: m.number(4),
          4: m.number(7),
        };
        if (this.phase !== "playing") {
          this.phase = "joining";
          this.status = "Joining the game...";
        }
        this.send(game.GAME, 105, {}, m.number(3));
      }
    } finally {
      this.changed();
    }
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
  gameMessage(op: number, m: Message, header: Message) {
    try {
      // Only a full synchronization may replace the board during recovery.
      if (this.reconnectBoard && ![107, 501].includes(op)) return;
      if (["ready", "disconnected", "error"].includes(this.phase)) return;
      if (
        this.phase === "matching" &&
        !Object.keys(this.roomKey).length &&
        op !== 107
      )
        return;
      const confirmsMove = op === 203 && this.pendingMove &&
        this.pendingMove.color === m.number(3) &&
        this.pendingMove.x === m.number(1) && this.pendingMove.y === m.number(2);
      const opponentMove = (op === 203 && m.number(3) === 3 - this.color) ||
        (op === 206 && this.board.turn === 3 - this.color);
      if ([107, 203, 206, 303, 306, 402, 403, 405, 501].includes(op) && !confirmsMove && !opponentMove)
        this.clearEstimate();
      if (op === 105) {
        if (signed(m.one(1))) throw Error("Game room rejected entry");
      } else if (op === 107) {
        if (this.reconnectBoard) {
          this.phase = "resuming";
          this.send(game.GAME, 501, {}, header.number(8));
          return;
        }
        const resuming = this.phase === "resuming";
        this.roomKey = {
          1: game.GAME,
          2: header.number(8),
          3: m.number(6),
          4: m.number(7),
        };
        this.players = {};
        this.opponentDisconnectDeadline = null;
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
        for (const data of m.get(9) ?? []) {
          const user = decode(data);
          this.readPlayer(user);
          if (user.number(1) === this.uid) this.color = user.number(6);
          this.clocks[user.number(6)] = {
            main: user.number(7),
            periods: user.number(8),
            byoyomi: user.number(9),
            periodLength:
              m.sub(1).number(7) || this.matchSettings?.byoyomi || 60,
            at: now(),
          };
        }
        clearTimeout(this.bootstrapTimer);
        this.phase = "playing";
        this.status = "Game started";
        this.pendingMove = null;
        this.pending = false;
        this.sync = 0;
        this.pendingConfirmation = null;
        this.counting = false;
        this.countingAnswer = null;
        this.quitRequested = false;
        this.announceStart(resuming);
      } else if (op === 203) {
        const color = m.number(3),
          x = m.number(1),
          y = m.number(2);
        if (color === 3 - this.color) this.opponentDisconnectDeadline = null;
        if (confirmsMove) this.pendingMove = null;
        else {
          this.rollbackMove();
          const captures = this.board.play(x, y, color);
          this.onSound(placementSound(captures));
        }
        this.sync = m.sub(5).number(1, this.sync);
        this.clock(color, m.sub(4));
        if (this.pendingAction !== 311) this.pending = false;
        this.status = "";
      } else if (op === 206) {
        const color = this.board.turn;
        if (color === 3 - this.color) this.opponentDisconnectDeadline = null;
        this.board.passTurn();
        this.clock(color, m.sub(1));
        this.sync = m.sub(2).number(1, this.sync);
        this.pending = false;
        this.status =
          this.board.turn === this.color ? "Opponent passed" : "You passed";
      } else if ([201, 204, 301, 304, 311].includes(op)) {
        if (signed(m.one(1))) {
          if (op === 311 && this.pendingMove) {
            this.pendingAction = 201;
          } else {
            this.rollbackMove();
            if (op === 201) this.clearEstimate();
            if (op !== 201 || this.pendingAction !== 311) this.pending = false;
          }
          this.status = `Action ${op} rejected: ${signed(m.one(1))}`;
          if (op === 311) this.quitRequested = false;
          if (op === 301) this.counting = false;
          if (op === 304 && this.countingAnswer) {
            this.pendingConfirmation = this.countingAnswer.confirmation;
            this.countingAnswer = null;
          }
        } else if ([301, 304].includes(op)) {
          this.pending = false;
          if (op === 304 && this.countingAnswer) {
            if (!this.countingAnswer.accept) {
              this.counting = false;
              this.status = "Counting rejected. Continue playing.";
            }
            this.countingAnswer = null;
          }
        }
      } else if (op === 306 && [1, 2].includes(m.number(2, 1))) {
        this.pending = false;
        this.pendingConfirmation = null;
        this.countingAnswer = null;
        this.counting = Boolean(m.number(1));
        this.status = m.number(1)
          ? "Counting accepted"
          : "Counting rejected. Continue playing.";
      } else if ([108, 109].includes(op) && [1, 2].includes(this.color)) {
        // ResumeCountdownNotify (109) wraps the same clock data as 108.
        // Fox can answer a counting rejection with 304 status 1, then resume
        // the clock without sending 306. Resumption ends the counting flow,
        // including any confirmation restored by the nonzero 304 response.
        if (op === 109 && this.phase === "playing" && this.counting) {
          this.pending = false;
          this.pendingConfirmation = null;
          this.countingAnswer = null;
          this.counting = false;
          this.status = "Counting rejected. Continue playing.";
        }
        const timing = op === 109 ? m.sub(2) : m;
        if (timing.has(5)) {
          const color = timing.number(5) === this.uid ? this.color : 3 - this.color;
          this.readClock(color, timing, true);
        }
      } else if (
        op === 503 && this.phase === "playing" &&
        [1, 2].includes(this.color) &&
        m.number(1) === this.players[3 - this.color]?.id
      ) {
        // OpponentOfflineNotify: player ID, remaining allowance in seconds.
        const color = 3 - this.color, clock = this.clocks[color];
        if (clock && this.opponentDisconnectDeadline == null && this.board.turn === color) {
          const remaining = clockReading(clock, Math.max(0, now() - clock.at), 60, false);
          Object.assign(clock, {
            main: remaining.main,
            periods: remaining.periods,
            byoyomi: remaining.seconds,
            at: now(),
          });
        }
        this.opponentDisconnectDeadline = now() + Math.max(0, m.number(2));
      } else if (op === 504 && m.number(1) === this.players[3 - this.color]?.id) {
        // OpponentReconnectNotify identifies the returning player in field 1.
        const clock = this.clocks[3 - this.color];
        if (clock && this.opponentDisconnectDeadline != null) clock.at = now();
        this.opponentDisconnectDeadline = null;
      } else if (
        op === 303 &&
        this.phase === "playing" &&
        [1, 2].includes(this.color)
      ) {
        const mode = m.number(2, 1),
          status = signed(m.one(1));
        if (status) {
          this.pending = false;
          this.pendingConfirmation = null;
          this.counting = false;
          this.countingAnswer = null;
          this.status = `Counting failed: ${status}`;
        } else if ([1, 2].includes(mode)) {
          this.pending = false;
          this.counting = true;
          this.countingAnswer = null;
          this.pendingConfirmation = [
            mode === 1 ? "counting-request" : "counting-result",
            game.plain(m),
            mode === 2 ? game.countingResult(m) : null,
          ];
          this.status =
            mode === 1
              ? "Opponent requested counting"
              : "Counting result needs your confirmation";
        }
      } else if ([402, 403, 405].includes(op)) {
        this.opponentDisconnectDeadline = null;
        this.rollbackMove();
        this.pending = false;
        this.phase = "finished";
        this.gameOver = true;
        this.setResult(m);
        if (this.quitRequested) this.leaveFinishedRoom();
      } else if ([218, 219].includes(op))
        this.sync = m.sub(1).number(1, this.sync);
      else if (op === 501) {
        const resuming = this.phase !== "joining";
        if (signed(m.one(1))) throw Error("Game synchronization failed");
        const previousBoard = this.pendingMove?.board ?? this.board;
        this.roomKey = {
          1: m.number(12),
          2: m.number(13),
          3: m.number(7),
          4: m.number(10),
        };
        const roomKey = Object.values(this.roomKey).join(":");
        const sameGame = roomKey === this.boardRoomKey;
        if (!sameGame || m.number(6) === 5) this.opponentDisconnectDeadline = null;
        this.sync = m.sub(5).number(1);
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
        for (const data of m.get(4) ?? []) {
          const move = decode(data);
          if (move.number(1) === 1)
            this.board.play(move.number(2), move.number(3), move.number(4));
          else if (move.number(1) === 2) this.board.passTurn(move.number(4));
        }


        if (sameGame) {
          for (let i = 0; i < this.board.moves.length; i++) {
            if (!previousBoard.moves[i] ||
              !this.board.moves[i].every((value, j) => value === previousBoard.moves[i][j])) break;
            this.board.moveTimings[i] = previousBoard.moveTimings[i] ?? null;
          }
        }
        for (const data of m.get(3) ?? []) {
          const user = decode(data);
          this.readPlayer(user);
          if (user.number(1) === this.uid) this.color = user.number(6);
          this.clocks[user.number(6)] = {
            main: user.number(7),
            periods: user.number(8),
            byoyomi: user.number(9),
            periodLength:
              m.sub(2).number(7) || this.matchSettings?.byoyomi || 60,
            at: now(),
          };
        }
        if (m.number(6) === 5) {
          this.pendingConfirmation = null;
          this.counting = false;
          this.countingAnswer = null;
        }
        this.gameOver = m.number(6) === 5;
        if (this.reconnectBoard && ![1, 2].includes(this.color))
          throw Error("Game synchronization did not restore the player");
        this.reconnectBoard = null;
        this.reconnectAttempt = 0;
        clearTimeout(this.bootstrapTimer);
        this.phase = this.gameOver ? "finished" : "playing";
        this.status =
          m.number(6) === 5 ? "Game ended" : "Game synchronized";
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
  readPlayer(user: Message) {
    const color = user.number(6);
    if (![1, 2].includes(color)) return;
    const previous =
      this.players[color]?.id === user.number(1) ? this.players[color] : null;
    this.players[color] = {
      id: user.number(1),
      name: user.text(3) || user.text(2) || previous?.name || "",
      rank: user.has(4)
        ? game.rankLabel(signed(user.one(4)))
        : (previous?.rank ?? ""),
    };
    if (user.number(1) === this.uid) {
      this.account = {
        name: this.players[color].name || this.account?.name || "",
        rank: this.players[color].rank || this.account?.rank || "",
      };
    }
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
  clock(color: number, m: Message) {
    if (m.has(2) && (m.number(2) > 0 || m.has(4))) {
      this.board.moveTimings[this.board.moves.length - 1] = {
        remaining: Math.max(0, m.number(2) > 0 ? m.number(2) : m.number(4)),
        ...(m.number(2) <= 0 && m.has(3) ? { periods: m.number(3) } : {}),
      };
    }
    this.readClock(color, m);
    if (this.clocks[3 - color]) this.clocks[3 - color].at = now();
  }
  tickClock(time = now()) {
    if (this.phase !== "playing" || this.pending || this.counting || this.pendingConfirmation ||
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
    if (m.has(2)) {
      const time = now();
      const previous = this.clocks[color];
      const control = this.board.timeControl ?? this.matchSettings;
      let byoyomi = m.number(4);
      // 0080c930 clamps a full initial-period countdown notification to the
      // already displayed seconds. Move confirmations still reset the period.
      if (countdown && previous && control && m.number(2) === 0 &&
          m.number(3) > 0 && m.number(3) === control.periods &&
          byoyomi > 0 && byoyomi === control.byoyomi) {
        const elapsed = this.board.turn === color && !this.pending && !this.counting &&
          !this.pendingConfirmation && !(color !== this.color && this.opponentDisconnectDeadline != null)
          ? time - previous.at : 0;
        byoyomi = Math.min(byoyomi, clockReading(previous, elapsed, 60, color === this.color).seconds);
      }
      this.clocks[color] = {
        main: m.number(2),
        periods: m.number(3),
        byoyomi,
        periodLength:
          this.clocks[color]?.periodLength || this.matchSettings?.byoyomi || 60,
        at: time,
      };
    }
  }
  setResult(m: Message) {
    const winner = m.number(2),
      margin = signed(m.one(3)),
      reason = m.number(4);
    this.pendingConfirmation = null;
    this.counting = false;
    this.countingAnswer = null;
    this.result = "";
    if ([1, 2].includes(winner) && reason === 3) {
      this.result = `${winner === 1 ? "B" : "W"}+R`;
    } else if (reason === 8) {
      this.result = "Void";
    } else if ([1, 2].includes(winner)) {

      const points = m.has(3) && margin >= 0 ? margin / 50 : null;
      this.result = `${winner === 1 ? "B" : "W"}+${points ?? ""}`;
    }
    this.status = `Result: ${this.result || "Unknown"}`;
  }
  clearEstimate() {
    this.estimateController?.abort();
    this.estimateController = null;
    this.estimation = null;
  }
  get awaitingMove() {
    return this.pending && this.pendingAction === 201 && !!this.pendingMove;
  }
  estimateScore() {
    if (
      this.phase !== "playing" ||
      !Object.keys(this.roomKey).length ||
      ![1, 2].includes(this.color)
    )
      throw Error("Score estimation requires an active game");
    if ((this.pending && !this.awaitingMove) ||
      (this.pendingConfirmation?.[0] !== "counting-request" &&
        (this.counting || this.pendingConfirmation)))
      throw Error("Finish the pending game action first");
    if (this.estimation && this.estimation.phase !== "error")
      throw Error("An estimate is already open");
    const board = this.board.clone(),
      komi = this.komi,
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
      this.onlineAction(301, { 1: 0 });
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

      this.onlineAction(304, {
        1: accept,
        2: kind === "counting-result" ? 2 : 1,
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
      this.send(game.ROOM, 100130, { 1: this.fieldId, 2: false });
      this.players = {};
      this.board = new Board();
      this.roomKey = {};
      this.clocks = {};
      this.result = "";
      this.gameOver = false;
      this.color = 0;
      this.pendingConfirmation = null;
      this.counting = false;
      this.countingAnswer = null;
      this.quitRequested = false;
      this.startedRoom = null;
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
      this.rollbackMove();
      this.roomKey = {};
      this.color = 0;
      this.pending = false;
      this.quitRequested = false;
      this.pendingConfirmation = null;
      this.counting = false;
      this.countingAnswer = null;
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
      this.send(game.ROOM, 100139);
    } finally {
      this.changed();
    }
  }
  onlineAction(op: number, fields: Fields) {
    try {
      if (
        this.phase !== "playing" ||
        !Object.keys(this.roomKey).length ||
        ![1, 2].includes(this.color)
      )
        throw Error("No active game");
      if (this.estimation) throw Error("Return to the game before playing");
      if (this.pending && !(op === 311 && this.awaitingMove))
        throw Error("Waiting to confirm the previous action");
      this.send(game.GAME, op, fields, this.roomKey[2]);
      this.pending = true;
      this.pendingAction = op;
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
      this.onlineAction(201, {
        1: x,
        2: y,
        3: this.color,
        4: { 1: this.sync },
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
      this.onlineAction(204, { 1: { 1: this.sync } });
    } finally {
      this.changed();
    }
  }
  resign() {
    try {
      this.onlineAction(311, { 1: this.color, 2: this.roomKey });
    } finally {
      this.changed();
    }
  }
}
