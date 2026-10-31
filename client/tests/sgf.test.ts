import { GAME_SVR, GoGameMessageID } from "../src/protocol.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Board } from "../src/board.ts";
import { recordedClocks } from "../src/clock.ts";
import { Session } from "../src/session.ts";
import { decode, encode, type Fields } from "../src/wire.ts";

function game() {
  const session = new Session();
  session.uid = 42;
  session.phase = "matching";
  session.matchSettings = { id: 101, size: 19, main: 1200, periods: 3, byoyomi: 60 };
  session.fgwConnection = { send() {}, close() {} };
  session.gameSvrProcess(GoGameMessageID.GC_START_SET_PIECE_NOTIFY, decode(encode({
    6: 23, 7: 202, 9: [{ 1: 42, 6: 1, 7: 1200, 8: 3, 9: 60 }],
  })), decode(encode({ 8: 63 })));
  return session;
}
function notify(session: Session, op: number, fields: Fields) {
  session.gameSvrProcess(op, decode(encode(fields)), decode(encode({})));
}
function environment(moves: Fields[], room = 202): Fields {
  return { 1: 0, 3: [{ 1: 42, 6: 1 }], 4: moves, 6: 3,
    7: 23, 10: room, 12: GAME_SVR, 13: 63 };
}

test("SGF records Fox main time, both colors, passes and remaining overtime periods", () => {
  const s = game();
  try {
    s.play(3, 3);
    notify(s, 203, { 1: 3, 2: 3, 3: 1, 4: { 2: 1192, 3: 3, 4: 60 } });
    notify(s, 203, { 1: 15, 2: 15, 3: 2, 4: { 2: 1185, 3: 3, 4: 60 } });
    notify(s, 206, { 1: { 2: 0, 3: 3, 4: 60 } });
    notify(s, 203, { 1: 10, 2: 10, 3: 2, 4: { 2: 0, 3: 2, 4: 60 } });
    assert.match(s.board.sgf(), /TM\[1200\]OT\[3x60 byo-yomi\]/);
    assert.match(s.board.sgf(), /;B\[dd\]BL\[1192\];W\[pp\]WL\[1185\];B\[\]BL\[60\]OB\[3\];W\[kk\]WL\[60\]OW\[2\]/);
  } finally { s.close(); }
});

test("SGF timing follows confirmed moves through rejection, rollback and cloning", () => {
  const s = game();
  try {
    s.play(3, 3);
    notify(s, 203, { 1: 3, 2: 3, 3: 1, 4: { 2: 1190 } });
    notify(s, 203, { 1: 15, 2: 15, 3: 2, 4: { 2: 1180 } });
    const before = s.board.sgf();
    s.play(10, 10);
    assert.equal(s.board.moveTimings[2], null);
    notify(s, 201, { 1: 7 });
    assert.equal(s.board.sgf(), before);
    assert.equal(s.board.clone().sgf(), before);
    s.play(10, 10);
    notify(s, 203, { 1: 11, 2: 11, 3: 1, 4: { 2: 1170 } });
    assert.match(s.board.sgf(), /;B\[ll\]BL\[1170\]/);
    assert.doesNotMatch(s.board.sgf(), /B\[kk\]/);
  } finally { s.close(); }
});

test("synchronization preserves known timing only for the same game's matching history", () => {
  const s = game();
  const black = { 1: 1, 2: 3, 3: 3, 4: 1 };
  const white = { 1: 1, 2: 15, 3: 15, 4: 2 };
  try {
    notify(s, 203, { 1: 3, 2: 3, 3: 1, 4: { 2: 1190 } });
    notify(s, 203, { 1: 15, 2: 15, 3: 2, 4: { 2: 1180 } });
    s.play(10, 10);
    // Recovery rolls back unconfirmed moves while retaining the current game.
    s.rollbackMove();
    s.phase = "resuming";
    notify(s, 501, environment([black, white, { 1: 2, 4: 1 }]));
    assert.match(s.board.sgf(), /TM\[1200\]/);
    assert.match(s.board.sgf(), /;B\[dd\]BL\[1190\];W\[pp\]WL\[1180\];B\[\]\)/);
    notify(s, 501, environment([black, { ...white, 2: 14 }]));
    assert.match(s.board.sgf(), /;B\[dd\]BL\[1190\];W\[op\]\)/);
    notify(s, 501, environment([black, white], 203));
    assert.doesNotMatch(s.board.sgf(), /(?:BL|WL|TM)\[/);
  } finally { s.close(); }
});

test("untimed boards omit clock properties and SGF retains fractional seconds", () => {
  const board = new Board();
  board.play(3, 3);
  assert.doesNotMatch(board.sgf(), /(?:BL|WL|TM|OT|OB|OW)\[/);
  board.timeControl = { main: 2700, periods: 5, byoyomi: 30 };
  board.moveTimings[0] = { remaining: 2690.113 };
  assert.match(board.sgf(), /TM\[2700\]OT\[5x30 byo-yomi\].*;B\[dd\]BL\[2690\.113\]/);
});


test("byoyomi records the pre-reset countdown for both colors and replays it", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const s = game();
  s.matchSettings!.byoyomi = 30;
  s.board.timeControl = { main: 300, periods: 3, byoyomi: 30 };
  s.clocks = {
    1: { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 },
    2: { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 },
  };
  try {
    context.mock.timers.setTime(7000);
    s.play(3, 3);
    // Waiting for the server to confirm must not consume more thinking time.
    context.mock.timers.setTime(10000);
    notify(s, 203, { 1: 3, 2: 3, 3: 1, 4: { 2: 0, 3: 3, 4: 30 } });
    assert.deepEqual(s.board.moveTimings[0], { remaining: 23, periods: 3 });
    assert.equal(s.clocks[1].byoyomi, 30, "live clock resets for the next turn");
    context.mock.timers.setTime(22000);
    notify(s, 203, { 1: 15, 2: 15, 3: 2, 4: { 2: 0, 3: 3, 4: 30 } });
    assert.deepEqual(s.board.moveTimings[1], { remaining: 18, periods: 3 });
    assert.equal(recordedClocks(s.board, 1)[1].byoyomi, 23);
    assert.equal(recordedClocks(s.board, 2)[2].byoyomi, 18);
    assert.match(s.board.sgf(), /;B\[dd\]BL\[23\]OB\[3\];W\[pp\]WL\[18\]OW\[3\]/);
  } finally { s.close(); }
});

test("byoyomi pass timing stops at submission and main-time transitions use only overtime elapsed", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const s = game();
  s.matchSettings!.byoyomi = 30;
  s.board.timeControl = { main: 300, periods: 3, byoyomi: 30 };
  s.clocks = {
    1: { main: 5, periods: 3, byoyomi: 30, periodLength: 30, at: 0 },
    2: { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 },
  };
  try {
    context.mock.timers.setTime(12000);
    s.passTurn();
    context.mock.timers.setTime(15000);
    notify(s, 206, { 1: { 2: 0, 3: 3, 4: 30 } });
    assert.deepEqual(s.board.moveTimings[0], { remaining: 23, periods: 3 });
    context.mock.timers.setTime(24000);
    notify(s, 206, { 1: { 2: 0, 3: 3, 4: 30 } });
    assert.deepEqual(s.board.moveTimings[1], { remaining: 21, periods: 3 });
    assert.match(s.board.sgf(), /;B\[\]BL\[23\]OB\[3\];W\[\]WL\[21\]OW\[3\]/);
  } finally { s.close(); }
});

test("byoyomi recording accounts for countdown updates and periods consumed during a move", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const s = game();
  s.matchSettings!.byoyomi = 30;
  s.board.timeControl = { main: 300, periods: 3, byoyomi: 30 };
  s.clocks[1] = { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 };
  try {
    context.mock.timers.setTime(38000);
    s.play(3, 3);
    notify(s, 203, { 1: 3, 2: 3, 3: 1, 4: { 2: 0, 3: 2, 4: 30 } });
    assert.deepEqual(s.board.moveTimings[0], { remaining: 22, periods: 2 });
    // A later countdown notification replaces the opponent's time anchor.
    context.mock.timers.setTime(58000);
    notify(s, 108, { 2: 0, 3: 3, 4: 10, 5: 43 });
    context.mock.timers.setTime(76000);
    notify(s, 203, { 1: 15, 2: 15, 3: 2, 4: { 2: 0, 3: 2, 4: 30 } });
    assert.deepEqual(s.board.moveTimings[1], { remaining: 22, periods: 2 });
    assert.equal(s.clocks[2].byoyomi, 30);
  } finally { s.close(); }
});

test("byoyomi recording trusts non-reset server readings and handles missing clocks", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const s = game();
  try {
    s.clocks = {};
    notify(s, 203, { 1: 3, 2: 3, 3: 1, 4: { 2: 0, 3: 2, 4: 60 } });
    assert.deepEqual(s.board.moveTimings[0], { remaining: 60, periods: 2 });
    s.clocks[2] = { main: 0, periods: 2, byoyomi: 60, periodLength: 60, at: 0 };
    context.mock.timers.setTime(5000);
    notify(s, 203, { 1: 15, 2: 15, 3: 2, 4: { 2: 0, 3: 2, 4: 42 } });
    assert.deepEqual(s.board.moveTimings[1], { remaining: 42, periods: 2 });
  } finally { s.close(); }
});
