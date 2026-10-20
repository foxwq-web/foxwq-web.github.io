import test from "node:test";
import assert from "node:assert/strict";
import { Board } from "../src/board.ts";
import { Session } from "../src/session.ts";
import { decode, encode, type Fields } from "../src/wire.ts";

function game() {
  const session = new Session();
  session.uid = 42;
  session.phase = "matching";
  session.matchSettings = { id: 101, size: 19, main: 1200, periods: 3, byoyomi: 60 };
  session.gateway = { send() {}, close() {} };
  session.gameMessage(107, decode(encode({
    6: 23, 7: 202, 9: [{ 1: 42, 6: 1, 7: 1200, 8: 3, 9: 60 }],
  })), decode(encode({ 8: 63 })));
  return session;
}
function notify(session: Session, op: number, fields: Fields) {
  session.gameMessage(op, decode(encode(fields)), decode(encode({})));
}
function environment(moves: Fields[], room = 202): Fields {
  return { 1: 0, 3: [{ 1: 42, 6: 1 }], 4: moves, 6: 3,
    7: 23, 10: room, 12: 31000, 13: 63 };
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
    s.close();
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
