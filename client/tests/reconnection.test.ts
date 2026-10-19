import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { Session } from "../src/session.ts";
import { encode } from "../src/wire.ts";
import * as game from "../src/game.ts";
import { actionsBlocked, blocked, boardAvailable } from "../src/state";
import type { Frame } from "../src/framing.ts";
import type { Transport } from "../src/transport.ts";

function setup() {
  const sockets: {
    receive: (frame: Frame) => void;
    fail: (reason: string) => void;
    sent: { command: number; payload: Buffer }[];
    closed: boolean;
  }[] = [];
  const s = new Session({ connectionFactory: async (_host, _port, receive, fail) => {
    const socket = { receive, fail, sent: [] as { command: number; payload: Buffer }[], closed: false };
    sockets.push(socket);
    return {
      send(command, payload) { socket.sent.push({ command, payload: Buffer.from(payload) }); },
      close() { socket.closed = true; },
    } satisfies Transport;
  } });
  s.login("test", "password");
  const packet = (command: number, fields: Parameters<typeof encode>[0]) =>
    ({ command, flags: 0, payload: encode(fields) });
  const reply = (service: number, op: number, fields = {}) => s.receive(s.generation, {
    command: 26200, flags: 0, payload: game.envelope(42, service, op, fields, 63),
  });
  const authenticate = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    s.receive(s.generation, packet(2005, { 1: 0, 2: 42, 8: "token" }));
    s.receive(s.generation, packet(3005, { 3: [{ 1: 1, 21: "gateway", 22: 3001 }] }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    reply(game.GATEWAY, 1, { 1: 0 });
    reply(game.ROOM, 100008, { 1: 0 });
  };
  const fields = () => reply(game.ROOM, 100150, { 1: [{ 1: 101, 2: 19, 3: 1200, 4: 3, 5: 60, 12: 1 }] });
  const restore = (finished = false) => reply(game.GAME, 501, {
    1: 0, 3: [{ 1: 42, 3: "Test", 6: 1, 7: 300, 8: 3, 9: 60 }],
    4: [{ 1: 1, 2: 3, 3: 3, 4: 1 }, { 1: 1, 2: 15, 3: 15, 4: 2 }],
    6: finished ? 5 : 3, 7: 23, 10: 202, 12: game.GAME, 13: 63,
  });
  const start = async () => {
    await authenticate(); fields(); reply(game.ROOM, 100115, { 1: 1 });
    assert.equal(s.phase, "ready", s.status);
    s.match();
    reply(game.GAME, 107, { 6: 23, 7: 202, 9: [{ 1: 42, 6: 1 }] });
    s.play(3, 3); reply(game.GAME, 203, { 1: 3, 2: 3, 3: 1 });
  };
  return { s, sockets, reply, authenticate, fields, restore, start };
}

test("gateway loss preserves the board and rejoins through authentication and discovery in either order", async () => {
  for (const fieldsFirst of [true, false]) {
    const { s, sockets, reply, authenticate, fields, restore, start } = setup();
    try {
      await start();
      const before = s.snapshot(), oldGateway = sockets[1];
      oldGateway.fail("Proxy connection closed");
      const reconnecting = s.snapshot();
      assert.equal(reconnecting.phase, "reconnecting");
      assert.equal(reconnecting.status, "Connection lost. Reconnecting... (Attempt 1)");
      assert.deepEqual(reconnecting.stones, before.stones);
      assert.deepEqual(reconnecting.players, before.players);
      assert.ok(boardAvailable(reconnecting));
      assert.ok(blocked(reconnecting)); assert.ok(actionsBlocked(reconnecting));
      assert.throws(() => s.play(4, 4));
      assert.ok(oldGateway.closed);
      oldGateway.receive({ command: 26200, flags: 0, payload: game.envelope(42, game.GAME, 203, { 1: 4, 2: 4, 3: 2 }) });
      assert.deepEqual(s.snapshot().stones, before.stones);
      await authenticate();
      if (fieldsFirst) fields();
      reply(game.ROOM, 100115, { 1: 0, 2: game.GAME, 3: 63 });
      if (!fieldsFirst) fields();
      assert.equal(s.snapshot().phase, "reconnecting");
      assert.deepEqual(s.snapshot().stones, before.stones);
      const sync = sockets.at(-1)!.sent.filter(p => p.command === 26200).map(p => game.unpack(p.payload)).find(([h]) => h.number(1) === 501);
      assert.equal(sync?.[0].number(8), 63);
      restore();
      assert.equal(s.snapshot().phase, "playing");
      assert.equal(s.board.moves.length, 2);
      assert.ok(!blocked(s.snapshot()));
      sockets.at(-1)!.fail("Proxy connection closed");
      assert.match(s.snapshot().status, /Attempt 1/);
    } finally { s.close(); }
  }
});

test("timeouts and network errors retry with progress; close cancels retries and stale opens", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { s, sockets, start } = setup();
  try {
    await start();
    sockets[1].fail("Proxy connection closed");
    context.mock.timers.tick(15000);
    assert.match(s.snapshot().status, /Reconnection timed out.*Attempt 1/);
    context.mock.timers.tick(2000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.ok(sockets[2].closed, "late open from the timed out attempt is closed");
    assert.match(s.snapshot().status, /Reconnecting\.\.\. \(Attempt 2\)/);
    sockets.at(-1)!.fail("Proxy unreachable");
    assert.match(s.snapshot().status, /Reconnection failed: Proxy unreachable.*Attempt 2/);
    const attempts = sockets.length;
    s.close();
    context.mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(s.snapshot().phase, "disconnected");
    assert.equal(sockets.length, attempts);
  } finally { s.close(); }
});

test("silent network stalls reconnect, and a game ending during the outage can be restored without a lock", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { s, sockets, start, authenticate, reply, fields, restore } = setup();
  try {
    await start();
    context.mock.timers.tick(25000);
    assert.equal(s.snapshot().phase, "reconnecting");
    assert.ok(sockets[1].closed);
    await authenticate(); fields();
    reply(game.ROOM, 100115, { 1: 107004 });
    assert.equal(s.snapshot().phase, "reconnecting");
    restore(true);
    assert.equal(s.snapshot().phase, "finished");
    assert.equal(s.snapshot().game_over, true);
  } finally { s.close(); }
});

test("a failed connection open retries while preserving an unconfirmed stone until authoritative recovery", async () => {
  const { s, sockets, start } = setup();
  try {
    await start();
    s.board.passTurn(2);
    s.play(4, 4);
    const visible = s.snapshot().stones;
    s.connectionFactory = async () => { throw Error("offline"); };
    sockets[1].fail("Proxy connection closed");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(s.snapshot().stones, visible);
    assert.match(s.snapshot().status, /Reconnection failed: Login connection failed.*Attempt 1/);
    assert.ok(blocked(s.snapshot()));
  } finally { s.close(); }
});

test("rejected synchronization retries and partial game events cannot unlock recovery", async () => {
  const { s, sockets, start, authenticate, fields, reply } = setup();
  try {
    await start(); sockets[1].fail("Proxy connection closed");
    await authenticate(); fields();
    reply(game.ROOM, 100115, { 1: 0, 2: game.GAME, 3: 63 });
    reply(game.GAME, 402, { 1: 0, 2: 2, 4: 3 });
    assert.equal(s.snapshot().phase, "reconnecting");
    reply(game.GAME, 501, { 1: 1 });
    assert.match(s.snapshot().status, /Reconnection failed: Invalid protocol response/);
    assert.ok(blocked(s.snapshot()));
  } finally { s.close(); }
});
