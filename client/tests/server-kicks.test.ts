import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import { encode, type Fields } from "../src/wire.ts";
import { encodeFgwMessage, GAME_SVR, SVR_TYPE_FGW } from "../src/game.ts";
import { LegacyMsgTypeID, ClientMessageID, GoGameMessageID, ErrorCode } from "../src/protocol.ts";
import { boardAvailable, reviewAvailable, blocked } from "../src/state.ts";
import type { NetMsg } from "../src/framing.ts";
import type { Transport } from "../src/transport.ts";

const key = { 1: GAME_SVR, 2: 63, 3: 23, 4: 202 };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function setup(phase = "playing") {
  const sockets: { receive: (packet: NetMsg) => void; fail: (reason: string) => void;
    sent: number[]; closed: boolean; transport: Transport }[] = [];
  const s = new Session({ connectionFactory: async (_host, _port, receive, fail) => {
    const socket = { receive, fail, sent: [] as number[], closed: false, transport: null! as Transport };
    socket.transport = { send(id) { socket.sent.push(id); }, close() { socket.closed = true; } };
    sockets.push(socket);
    return socket.transport;
  } });
  s.login("fixture", "fixture");
  await settle();
  if (phase === "playing") {
    Object.assign(s, { phase, uid: 42, token: Buffer.from("fixture-token"), roomKey: { ...key },
      color: 1, account: { name: "Test", rank: "1d" },
      players: { 1: { id: 42, name: "Black" }, 2: { id: 43, name: "White" } } });
    s.boardRoomKey = Object.values(key).join(":");
    s.board.play(3, 3, 1); s.board.play(15, 15, 2);
    s.fgwConnection = sockets[0].transport;
  } else s.phase = phase;
  const packet = (service: number, id: number, fields: Fields = {}) => ({
    msgTypeID: LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET, flag: 0,
    rawProto: encodeFgwMessage(42, service, id, fields, 63),
  });
  const kick = (fields: Fields = {}) => s.receive(s.generation,
    packet(SVR_TYPE_FGW, ClientMessageID.MID_KICKOUT_NOTIFY, fields));
  if (phase === "playing") {
    s.receive(s.generation, packet(SVR_TYPE_FGW, ClientMessageID.MID_LOGIN_REQUEST, { 1: 0 }));
  }
  return { s, sockets, kick, packet };
}

test("a kick cancels gateway bootstrap and heartbeat work", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { s, sockets, packet, kick } = await setup("gateway");
  try {
    s.fgwConnection = sockets[0].transport;
    s.receive(s.generation, packet(SVR_TYPE_FGW, ClientMessageID.MID_LOGIN_REQUEST, { 1: 0 }));
    kick({ 8: "Login restricted" });
    const sent = [...sockets[0].sent];
    context.mock.timers.tick(120000);
    await settle();
    assert.equal(s.phase, "error");
    assert.equal(s.status, "Login restricted");
    assert.equal(sockets.length, 1);
    assert.deepEqual(sockets[0].sent, sent);
  } finally { s.close(); }
});

for (const phase of ["gateway", "ready", "matching", "joining"]) {
  test(`kick while ${phase} stops authentication and timers without creating a finished game`, async context => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const { s, sockets, kick } = await setup(phase);
    try {
      kick({ 1: ErrorCode.EC_ACCOUNT_KICKOUT_BY_ANOTHER_LOGIN });
      assert.equal(s.phase, "error");
      assert.equal(s.status, "Another client logged in");
      assert.equal(s.gameOver, false);
      assert.equal(s.uid, 0);
      assert.equal(s.token.length, 0);
      assert.equal(sockets[0].closed, true);
      context.mock.timers.tick(120000);
      await settle();
      assert.equal(sockets.length, 1);
      assert.deepEqual(sockets[0].sent, [2000]);
    } finally { s.close(); }
  });
}

test("an active kick preserves confirmed history, stops actions and ignores callbacks from closed transports", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { s, sockets, kick, packet } = await setup();
  try {
    const sgf = s.board.sgf(), oldGeneration = s.generation;
    s.play(4, 4);
    kick({ 1: 999, 8: "Server maintenance" });
    assert.equal(s.phase, "kicked");
    assert.equal(s.status, "Server maintenance");
    assert.equal(s.gameOver, false, "a connection termination is not a game result");
    assert.equal(s.result, "");
    assert.equal(s.board.sgf(), sgf, "the unconfirmed stone is rolled back");
    assert.deepEqual(s.players, { 1: { id: 42, name: "Black" }, 2: { id: 43, name: "White" } });
    assert.deepEqual(s.roomKey, key);
    assert.equal(s.uid, 0); assert.equal(s.token.length, 0);
    assert.equal(s.fgwConnection, null); assert.equal(s.connection, null);
    assert.equal(s.pending, false); assert.equal(s.pendingMove, null);
    assert.equal(s.pendingMessageId, null);
    assert.ok(boardAvailable(s.snapshot()));
    assert.ok(reviewAvailable(s.snapshot()));
    assert.ok(blocked(s.snapshot()));
    for (const action of [() => s.play(4, 4), () => s.passTurn(), () => s.resign(), () => s.match()]) assert.throws(action);
    const state = s.snapshot(), sent = sockets[0].sent.length;
    s.receive(oldGeneration, packet(GAME_SVR, GoGameMessageID.GC_SET_PIECE_NOTIFY, { 1: 4, 2: 4, 3: 1 }));
    sockets[0].receive({ msgTypeID: 2005, flag: 0, rawProto: encode({ 1: 0, 2: 42, 8: "late-token" }) });
    sockets[0].fail("late close");
    s.receive(s.generation, packet(GAME_SVR, GoGameMessageID.GC_SET_GAME_END_NOTIFY, { 2: 2, 4: 3 }));
    context.mock.timers.tick(120000);
    await settle();
    assert.deepEqual(s.snapshot(), state);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].sent.length, sent);
    // An explicit login still works; saved credentials are never submitted automatically.
    s.login("fixture", "fixture");
    await settle();
    assert.equal(sockets.length, 2);
    assert.equal(s.phase, "authenticating");
  } finally { s.close(); }
});

for (const [fields, expected] of [
  [{}, "Fox ended this session"],
  [{ 1: 123 }, "Fox ended this session (code 123)"],
  [{ 1: 123, 8: "  Account disabled  " }, "Account disabled"],
  [{ 1: 123, 8: " " }, "Fox ended this session (code 123)"],
  [{ 1: 123, 8: "Account disabled", 11: 600n }, "Account disabled. Fox has restricted login"],
  [{ 1: "invalid-code", 8: 42, 11: "invalid-time" }, "Fox ended this session"],
] as [Fields, string][]) {
  test(`kick reason is displayed without reclassifying every termination as another login: ${expected}`, async () => {
    const { s, kick } = await setup();
    try { kick(fields); assert.equal(s.status, expected); assert.equal(s.phase, "kicked"); }
    finally { s.close(); }
  });
}

for (const failure of ["sequence recovery", "reconnecting", "queued retry", "malformed snapshot"]) {
  test(`kick during ${failure} cancels recovery and retains the original board`, async context => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const { s, sockets, kick, packet } = await setup();
    try {
      const before = s.board.sgf();
      if (failure === "sequence recovery" || failure === "malformed snapshot") {
        s.receive(s.generation, packet(GAME_SVR, GoGameMessageID.GC_HEART_BEAT_REQUEST, { 3: { 1: 10 } }));
        assert.equal(s.pending, true);
        if (failure === "malformed snapshot") s.receive(s.generation,
          packet(GAME_SVR, GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, { 1: 0, 3: [{ 1: 42, 6: 1 }],
            4: [{ 1: 1, 2: 99, 3: 3, 4: 1 }], 5: { 1: 10 }, 6: 3, 7: 23, 10: 202, 12: GAME_SVR, 13: 63 }));
      } else {
        s.failed(s.generation, "connection lost");
        await settle();
        if (failure === "queued retry") sockets.at(-1)!.fail("still offline");
      }
      kick({ 8: "Session ended by Fox" });
      const opened = sockets.length;
      await settle();
      assert.equal(s.phase, "kicked");
      assert.equal(s.board.sgf(), before);
      assert.deepEqual(s.roomKey, key);
      assert.equal(s.gameOver, false);
      const state = s.snapshot();
      context.mock.timers.tick(120000);
      await settle();
      assert.equal(sockets.length, opened);
      assert.ok(sockets.every(socket => socket.closed));
      assert.deepEqual(s.snapshot(), state);
    } finally { s.close(); }
  });
}

test("a pending connection open is closed after a kick without sending a password packet", async () => {
  const { s, sockets, kick } = await setup();
  let resolve!: (transport: Transport) => void;
  let closed = false, sent = 0;
  try {
    s.connectionFactory = () => new Promise(done => { resolve = done; });
    s.failed(s.generation, "connection lost");
    kick({ 8: "Account unavailable" });
    resolve({ send() { sent++; }, close() { closed = true; } });
    await settle();
    assert.equal(s.phase, "kicked");
    assert.equal(closed, true); assert.equal(sent, 0);
  } finally { s.close(); }
});

for (const paused of [false, true]) {
  test(`kick freezes the local clock (${paused ? "already paused" : "running"})`, async context => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const { s, kick } = await setup();
    try {
      s.counting = paused;
      s.clocks[1] = { main: 300, periods: 3, byoyomi: 60, at: Date.now() / 1000 - 10 };
      kick({});
      assert.equal(s.clocks[1].main, paused ? 300 : 290);
      const clock = structuredClone(s.clocks[1]);
      context.mock.timers.tick(120000);
      assert.deepEqual(s.clocks[1], clock);
    } finally { s.close(); }
  });
}
