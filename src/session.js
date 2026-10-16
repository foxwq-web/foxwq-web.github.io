import { Buffer } from 'buffer';
import SparkMD5 from 'spark-md5';
import * as game from './game.js';
import { Board } from './board.js';
import { Connection } from './transport.js';
import { encode, decode, signed } from './wire.js';

export function loginRequest(username, password, mac = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('').toUpperCase()) {
  return encode({ 1: username, 2: 'foxwq', 3: SparkMD5.hash(password), 4: 8, 5: 11509231, 6: false, 7: mac, 9: false });
}
const now = () => Date.now() / 1000;
export class Session {
  constructor({ host = '43.132.13.39', port = 10000, proxyUrl, proxyToken, connectionFactory = Connection.open } = {}) {
    Object.assign(this, { host, port, proxyUrl, proxyToken, connectionFactory });
    this.connection = null; this.gateway = null; this.timer = null; this.generation = 0;
    this.phase = 'disconnected'; this.status = 'Disconnected'; this.mode = 'fox';
    this.board = new Board(); this.result = ''; this.uid = 0; this.token = Buffer.alloc(0);
    this.servers = []; this.fieldId = null; this.roomKey = {}; this.color = 0;
    this.sync = 0; this.pending = false; this.clocks = {}; this.pendingConfirmation = null; this.events = [];
  }
  event(message) { this.events.push(message); this.events = this.events.slice(-30); }
  snapshot() {
    return structuredClone({ phase: this.phase, status: this.status, mode: this.mode, stones: this.board.stones,
      turn: this.board.turn, captures: this.board.captures, passes: this.board.passes, moves: this.board.moves.length,
      result: this.result, events: this.events, time: '20 min + 3 × 60 s', color: this.color, pending: this.pending,
      clocks: this.clocks, last_move: this.board.moves.at(-1) ?? null, confirmation: this.pendingConfirmation !== null });
  }
  close() {
    this.generation++; clearTimeout(this.bootstrapTimer); clearTimeout(this.timer); this.timer = null;
    this.gateway?.close(); this.connection?.close(); this.gateway = this.connection = null;
    this.token = Buffer.alloc(0); this.uid = 0; this.fieldId = null;
    this.phase = 'disconnected'; this.status = 'Disconnected'; this.pending = false; this.pendingConfirmation = null;
  }
  timeout(generation, reason) { clearTimeout(this.timer); this.timer = setTimeout(() => this.failed(generation, reason), 15000); }
  login(username, password) {
    if (!username || !password) throw Error('Enter your FOX username and password');
    const request = loginRequest(username, password);
    if (!this.proxyUrl || !this.proxyToken) throw Error('Enter the proxy URL and access token first');
    this.close(); this.mode = 'fox'; this.board = new Board(); this.clocks = {}; this.result = ''; this.roomKey = {}; this.color = 0; this.sync = 0;
    this.phase = 'connecting'; this.status = 'Connecting to Fox…';
    this.timeout(this.generation, 'Login timed out');
    void this.connect(this.generation, request);
  }
  async open(host, port, generation, nav = false) {
    return this.connectionFactory(host, port, packet => this.receive(generation, packet), reason => nav ? this.navFailed(generation, reason) : this.failed(generation, reason), this);
  }
  async connect(generation, request) {
    let connection;
    try {
      if (generation !== this.generation) return;
      connection = await this.open(this.host, this.port, generation, true);
      if (generation !== this.generation) { connection.close(); return; }
      this.connection = connection; this.phase = 'authenticating'; this.status = 'Waiting for Fox login response…';
      connection.send(2000, request); connection.start();
    } catch { connection?.close(); this.failed(generation, 'FOX login connection failed'); }
  }
  navFailed(generation, reason) {
    if (generation !== this.generation) return;
    if (this.gateway && !this.gateway.closed) { this.connection = null; this.event('Navigation connection closed; game gateway remains connected'); }
    else this.failed(generation, reason);
  }
  failed(generation, reason) {
    if (generation !== this.generation) return;
    this.close(); this.phase = 'error'; this.status = reason; this.event(reason);
  }
  receive(generation, packet) {
    if (generation !== this.generation) return;
    try {
      if (packet.command === 26200) { this.gatewayMessage(generation, packet); return; }
      const m = decode(packet.payload);
      if (packet.command === 2005) {
        clearTimeout(this.timer);
        const code = signed(m.one(1)), uid = m.one(2) || m.sub(3).one(1), token = m.one(8, Buffer.alloc(0));
        if (code || !uid || !token.length) { this.failed(generation, `Fox login status ${code}; no authenticated session.`); return; }
        this.uid = uid; this.token = token; this.phase = 'bootstrap'; this.status = 'Authenticated; fetching server list…';
        this.connection.send(3000, encode({ 1: uid, 2: false })); this.connection.send(3010, encode({ 1: uid }));
        this.timeout(generation, 'Server discovery timed out');
      } else if (packet.command === 3005 && m.has(3) && this.phase === 'bootstrap') {
        this.servers = m.get(3).map(decode);
        const record = this.servers.find(r => r.one(1) === 1) ?? this.servers[0];
        const host = record.text(21), port = record.one(22);
        if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw Error('Server list has no usable gateway');
        this.event(`Authenticated; connecting to gateway ${host}:${port}`); this.phase = 'gateway'; this.status = 'Connecting to Fox game gateway…';
        this.timeout(generation, 'Gateway discovery timed out'); void this.connectGateway(generation, host, port);
      } else if (packet.command === 3015) this.event('Received navigation settings');
      else this.event(`Fox response ${packet.command} (${packet.payload.length} bytes)`);
    } catch { this.failed(generation, 'Invalid FOX protocol response'); }
  }
  async connectGateway(generation, host, port) {
    let connection;
    try {
      connection = await this.open(host, port, generation);
      if (generation !== this.generation) { connection.close(); return; }
      this.gateway = connection; this.send(game.GATEWAY, 1, { 1: this.token }); connection.start();
    } catch { connection?.close(); this.failed(generation, 'FOX gateway connection failed'); }
  }
  send(service, op, fields = {}, node = 0) {
    if (!this.gateway) throw Error('Game gateway is disconnected');
    this.gateway.send(26200, game.envelope(this.uid, service, op, fields, node));
  }
  heartbeat(generation) {
    if (generation !== this.generation || !this.gateway) return;
    try {
      const ticks = Math.floor(performance.now());
      this.send(game.GATEWAY, 5, { 1: ticks }); this.send(game.ROOM, 100010, { 1: ticks });
      if (Object.keys(this.roomKey).length) {
        if (this.pending && now() - this.pendingSince > 8) { this.send(game.GAME, 501, {}, this.roomKey[2]); this.pendingSince = now(); }
        this.send(game.GAME, 200, { 1: ticks, 3: this.roomKey }, this.roomKey[2]);
      }
      this.timer = setTimeout(() => this.heartbeat(generation), 5000);
    } catch { this.failed(generation, 'FOX heartbeat failed'); }
  }
  gatewayMessage(generation, packet) {
    const [header, m] = game.unpack(packet.payload), service = header.one(7), op = header.one(1);
    if (![5, 200, 100010].includes(op)) this.event(`Fox ${service}/${op}`);
    if (service === game.GATEWAY) {
      if (op === 1) {
        if (signed(m.one(1))) { this.failed(generation, `Gateway login status ${signed(m.one(1))}`); return; }
        clearTimeout(this.timer); this.status = 'Gateway authenticated; discovering game settings…';
        this.send(game.ROOM, 100008, { 1: true }); this.heartbeat(generation);
        // Heartbeats must not hide a stalled room bootstrap.
        this.bootstrapTimer = setTimeout(() => { if (this.fieldId === null) this.failed(generation, 'Room discovery timed out'); }, 15000);
        this.bootstrapTimer.unref?.();
      } else if (op === 100) this.failed(generation, 'Fox ended this session (another client may have logged in)');
    } else if (service === game.ROOM) this.roomMessage(op, m);
    else if (service === game.GAME) this.gameMessage(op, m, header);
  }
  roomMessage(op, m) {
    if (op === 100008) {
      if (signed(m.one(1))) throw Error('Room manager login failed');
      for (const operation of [100145, 100115, 100150]) this.send(game.ROOM, operation);
    } else if (op === 100115 && m.one(1) === 0 && m.one(2) === game.GAME) {
      this.phase = 'resuming'; this.status = 'Reconnecting to your existing game…'; this.send(game.GAME, 501, {}, m.one(3));
    } else if (op === 100150) {
      this.fieldId = game.normalField((m.get(1) ?? []).map(decode)); clearTimeout(this.bootstrapTimer);
      if (!['playing', 'resuming', 'joining'].includes(this.phase)) { this.phase = 'ready'; this.status = 'Connected to Fox. Normal 20 min + 3 × 60 s match available.'; }
    } else if (op === 100130) {
      this.phase = signed(m.one(1)) ? 'ready' : 'matching';
      this.status = signed(m.one(1)) ? `Matchmaking rejected: ${signed(m.one(1))}` : 'Searching for a normal game…';
    } else if ([100132, 100139, 100141].includes(op)) {
      this.pendingConfirmation = null; this.phase = 'ready'; this.status = 'Matchmaking ended';
    } else if ([100135, 100143, 100146].includes(op)) {
      this.pendingConfirmation = [({ 100135: 'invite', 100143: 'rule', 100146: 'make-rule' })[op], game.plain(m)];
      this.phase = 'confirming'; this.status = ({ 100135: 'Fox found an opponent. Match confirmation needs inspection.', 100143: 'Opponent proposed game settings', 100146: 'Fox requested game-rule negotiation' })[op];
    } else if (op === 100140) {
      if (signed(m.one(1))) throw Error('Room entry failed');
      this.roomKey = { 1: m.one(2), 2: m.one(3), 3: m.one(4), 4: m.one(7) };
      if (this.phase !== 'playing') { this.phase = 'joining'; this.status = 'Joining the matched game…'; }
      this.send(game.GAME, 105, {}, m.one(3));
    }
  }
  gameMessage(op, m, header) {
    if (op === 105) { if (signed(m.one(1))) throw Error('Game room rejected entry'); }
    else if (op === 107) {
      this.roomKey = { 1: game.GAME, 2: header.one(8), 3: m.one(6), 4: m.one(7) }; this.board = new Board(); this.color = 0; this.clocks = {}; this.result = '';
      for (const data of m.get(9) ?? []) { const user = decode(data); if (user.one(1) === this.uid) this.color = user.one(6); }
      this.phase = 'playing'; this.status = 'Fox game started'; this.pending = false; this.sync = 0;
    } else if (op === 203) {
      const color = m.one(3); this.board.play(m.one(1), m.one(2), color, true); this.sync = m.sub(5).one(1, this.sync);
      this.clock(color, m.sub(4)); this.pending = false; this.status = this.board.turn === this.color ? 'Your turn' : 'Opponent’s turn';
    } else if (op === 206) {
      const color = this.board.turn; this.board.passTurn(); this.clock(color, m.sub(1)); this.sync = m.sub(2).one(1, this.sync);
      this.pending = false; this.status = this.board.turn === this.color ? 'Opponent passed' : 'You passed';
    } else if ([201, 204, 301, 304, 311].includes(op)) {
      if (signed(m.one(1))) { this.pending = false; this.status = `Fox rejected action ${op}: ${signed(m.one(1))}`; }
      else if ([301, 304].includes(op)) this.pending = false;
    } else if (op === 306) { this.pending = false; this.status = m.one(1) ? 'Scoring accepted; waiting for Fox result' : 'Scoring declined; continue playing'; }
    else if (op === 108) this.clocks.countdown = Object.fromEntries([...m].filter(([, v]) => typeof v.at(-1) === 'number').map(([k, v]) => [k, v.at(-1)]));
    else if (op === 303) { this.pendingConfirmation = ['score', game.plain(m)]; this.status = 'Opponent requested scoring'; }
    else if ([402, 403, 405].includes(op)) { this.pending = false; this.phase = 'finished'; this.setResult(m); }
    else if ([218, 219].includes(op)) this.sync = m.sub(1).one(1, this.sync);
    else if (op === 501) {
      if (signed(m.one(1))) throw Error('Game synchronization failed');
      this.roomKey = { 1: m.one(12), 2: m.one(13), 3: m.one(7), 4: m.one(10) }; this.sync = m.sub(5).one(1);
      this.board = new Board(); this.clocks = {}; this.color = 0;
      for (const data of m.get(4) ?? []) {
        const move = decode(data);
        if (move.one(1) === 1) this.board.play(move.one(2), move.one(3), move.one(4), true);
        else if (move.one(1) === 2) this.board.passTurn(move.one(4));
      }
      for (const data of m.get(3) ?? []) {
        const user = decode(data); if (user.one(1) === this.uid) this.color = user.one(6);
        this.clocks[user.one(6)] = { main: user.one(7), periods: user.one(8), byoyomi: user.one(9), at: now() };
      }
      this.phase = m.one(6) === 5 ? 'finished' : 'playing'; this.status = m.one(6) === 5 ? 'Fox game ended' : 'Fox game synchronized'; this.pending = false;
    }
  }
  clock(color, m) {
    if (m.has(2)) this.clocks[color] = { main: m.one(2), periods: m.one(3), byoyomi: m.one(4), at: now() };
    if (this.clocks[3 - color]) this.clocks[3 - color].at = now();
  }
  setResult(m) {
    const winner = m.one(2), margin = signed(m.one(3)), reason = m.one(4); this.pendingConfirmation = null;
    this.resultDetails = { winner, margin, reason }; this.result = '';
    if ([1, 2].includes(winner) && reason === 3) { this.result = `${winner === 1 ? 'B' : 'W'}+R`; this.status = `Fox result: ${this.result}`; }
    else if (reason === 8) { this.result = 'Void'; this.status = 'Fox cancelled the game'; }
    else if ([1, 2].includes(winner)) { this.result = `${winner === 1 ? 'B' : 'W'}+`; this.status = `${winner === 1 ? 'Black' : 'White'} wins`; }
    else this.status = 'Fox game ended';
    this.event(`Final result: winner ${winner}, value ${margin}, reason ${reason}`);
  }
  requestScore() { if (this.mode !== 'fox') throw Error('This action requires a Fox game'); this.onlineAction(301, { 1: 0 }); this.status = 'Scoring requested; waiting for Fox'; }
  confirm(accept) {
    if (typeof accept !== 'boolean') throw Error('accept must be boolean');
    if (!this.pendingConfirmation) throw Error('No pending confirmation');
    const [kind, fields] = this.pendingConfirmation;
    if (kind === 'score') this.send(game.GAME, 304, { 1: accept, 2: 1 }, this.roomKey[2]);
    else if (kind === 'rule') {
      const rule = decode(fields[2] ?? Buffer.alloc(0));
      if (accept && ![1, 6, 8, 7].every((f, i) => rule.one(f) === game.NORMAL[i])) throw Error('Proposed rules do not match your normal time settings');
      this.send(game.ROOM, 100144, { 1: fields[1], 2: accept });
    } else throw Error('This negotiation path has not yet been verified');
    this.pendingConfirmation = null;
  }
  match() {
    if (this.mode !== 'fox' || !['ready', 'finished'].includes(this.phase) || this.fieldId === null) throw Error('Log in and wait for server discovery first');
    this.board = new Board(); this.roomKey = {}; this.clocks = {}; this.result = ''; this.color = 0; this.pendingConfirmation = null;
    this.send(game.ROOM, 100130, { 1: this.fieldId, 2: false }); this.phase = 'matching'; this.status = 'Requesting a normal match…';
  }
  cancelMatch() { if (!['matching', 'confirming'].includes(this.phase)) throw Error('No matchmaking request is active'); this.send(game.ROOM, 100139); }
  onlineAction(op, fields) {
    if (this.phase !== 'playing' || !Object.keys(this.roomKey).length || ![1, 2].includes(this.color)) throw Error('No active Fox game');
    if (this.pending) throw Error('Waiting for Fox to confirm the previous action');
    this.send(game.GAME, op, fields, this.roomKey[2]); this.pending = true; this.pendingSince = now();
  }
  localGame() { this.close(); this.board = new Board(); this.clocks = {}; this.color = 0; this.mode = 'local'; this.phase = 'playing'; this.status = 'Local board — both players on this computer'; this.result = ''; }
  play(x, y) {
    if (this.mode === 'fox') {
      if (this.board.turn !== this.color) throw Error('Wait for your turn');
      this.board.clone().play(x, y, this.color); this.onlineAction(201, { 1: x, 2: y, 3: this.color, 4: { 1: this.sync } });
    } else { if (this.phase !== 'playing') throw Error('No active game'); this.board.play(x, y); }
  }
  passTurn() {
    if (this.mode === 'fox') { if (this.board.turn !== this.color) throw Error('Wait for your turn'); this.onlineAction(204, { 1: { 1: this.sync } }); }
    else {
      if (this.phase !== 'playing') throw Error('No active local game'); this.board.passTurn();
      if (this.board.passes >= 2) { this.phase = 'scoring'; this.status = 'Both players passed. Mark dead groups, then finish scoring.'; }
    }
  }
  score(dead) {
    if (this.mode !== 'local' || this.phase !== 'scoring') throw Error('Game is not being scored');
    if (!Array.isArray(dead)) throw Error('Invalid dead-stone positions');
    const points = new Set();
    for (const p of dead) {
      if (!Number.isInteger(p) || p < 0 || p >= 361) throw Error('Invalid dead-stone position');
      if (this.board.stones[p]) for (const q of this.board.group(p)[0]) points.add(q);
    }
    const [black, white] = this.board.areaScore(7.5, points);
    this.result = black === white ? '0' : `${black > white ? 'B' : 'W'}+${Math.abs(black - white)}`;
    this.phase = 'finished'; this.status = `Local result: ${this.result}`;
  }
  resign() {
    if (this.mode === 'fox') this.onlineAction(311, { 1: this.color, 2: this.roomKey });
    else { if (this.phase !== 'playing') throw Error('No active local game'); this.result = `${this.board.turn === 1 ? 'W' : 'B'}+R`; this.phase = 'finished'; this.status = `Local result: ${this.result}`; }
  }
}
