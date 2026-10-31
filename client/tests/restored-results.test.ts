import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import { decode, encode, type Fields } from "../src/wire.ts";
import { GAME_SVR, GoGameMessageID as ID, RoomMessageID as RM } from "../src/protocol.ts";
import { actionsBlocked, reviewAvailable } from "../src/state.ts";

const key = { 1: GAME_SVR, 2: 63, 3: 23, 4: 202 };
function setup() {
  const sounds: string[] = [];
  const s = new Session({ onSound: sound => sounds.push(sound) });
  Object.assign(s, { uid: 42, phase: "resuming" });
  s.fgwConnection = { send() {}, close() {} };
  s.gameSvrMgrProcess(RM.RM_QUERY_GAME_LOCK_REQUEST, decode(encode({ 1: 0, 2: GAME_SVR, 3: 63, 4: 23, 7: 202 })));
  const notice = (op: number, fields: Fields) => s.gameSvrProcess(op, decode(encode(fields)), decode(encode({ 7: GAME_SVR, 8: 63 })));
  const restore = (result: Fields | undefined, fields: Fields = {}) => notice(501, {
    1: 0, 2: { 7: 60 },
    3: [{ 1: 42, 3: "Black", 6: 1, 7: 123, 8: 3, 9: 60 },
      { 1: 43, 3: "White", 6: 2, 7: 234, 8: 2, 9: 45 }],
    4: [{ 1: 1, 2: 3, 3: 3, 4: 1 }, { 1: 1, 2: 15, 3: 15, 4: 2 }],
    5: { 1: 12 }, 6: 5, 15: result, 32: key, ...fields,
  });
  return { s, sounds, notice, restore };
}

const results: [string, Fields, string][] = [
  ["Black resignation", { 1: 1, 3: 3 }, "B+R"],
  ["White resignation", { 1: 2, 3: 3 }, "W+R"],
  ["Black points", { 1: 1, 2: 125, 3: 2 }, "B+2.5"],
  ["White points", { 1: 2, 2: 1225, 3: 2 }, "W+24.5"],
  ["Black time", { 1: 1, 2: -2, 3: 2 }, "B+T"],
  ["White time", { 1: 2, 2: -2, 3: 2 }, "W+T"],
  ["draw", { 1: 3, 2: 0, 3: 2 }, "0"],
  ["void", { 3: 8 }, "Void"],
  ["unknown margin", { 1: 1, 2: -1, 3: 2 }, "B+"],
  ["omitted margin", { 1: 2, 3: 2 }, "W+"],
  ["unknown winner", { 1: 99, 2: 125, 3: 2 }, ""],
];
for (const [name, result, expected] of results) test(`restored ${name} matches live results and SGF`, () => {
  const { s, sounds, notice, restore } = setup();
  try {
    restore(result);
    assert.equal(s.result, expected);
    assert.equal(s.snapshot().status, `Result: ${expected || "Unknown"}`);
    assert.equal(s.phase, "finished");
    assert.equal(s.gameOver, true);
    assert.equal(s.pending, false);
    assert.ok(reviewAvailable(s.snapshot()));
    assert.ok(actionsBlocked(s.snapshot()));
    assert.throws(() => s.play(4, 4));
    assert.deepEqual(s.board.moves, [[1, 3, 3], [2, 15, 15]]);
    assert.deepEqual(s.roomKey, key);
    assert.equal(s.synSeqId, 12);
    assert.equal(s.clocks[1].main, 123);
    assert.equal(s.clocks[2].main, 234);
    assert.equal(s.clocks[2].byoyomi, 45);
    assert.deepEqual(sounds, [], "restoring a finished game is silent");
    const sgf = s.board.sgf(s.result);
    if (expected) assert.ok(sgf.includes(`RE[${expected}]`));
    else assert.doesNotMatch(sgf, /RE\[/);
    assert.match(sgf, /;B\[dd\];W\[pp\]/);
    for (const op of [402, 403, 405]) {
      notice(op, { 1: 0, 2: result[1], 3: result[2], 4: result[3] });
      assert.equal(s.result, expected);
      assert.equal(s.board.sgf(s.result), sgf);
    }
  } finally { s.close(); }
});

test("missing result leaves an ended snapshot unknown and a later notification completes it", () => {
  const { s, notice, restore } = setup();
  try {
    s.result = "B+2.5";
    restore(undefined);
    assert.equal(s.result, "");
    assert.equal(s.phase, "finished");
    assert.equal(s.status, "Game ended");
    assert.doesNotMatch(s.board.sgf(s.result), /RE\[/);
    notice(403, { 2: 2, 4: 3 });
    assert.equal(s.result, "W+R");
  } finally { s.close(); }
});

test("an active snapshot clears stale results and ignores embedded terminal data", () => {
  const { s, restore } = setup();
  try {
    s.result = "W+R";
    restore({ 1: 2, 3: 3 }, { 6: 3 });
    assert.equal(s.phase, "playing");
    assert.equal(s.gameOver, false);
    assert.equal(s.result, "");
    assert.equal(s.status, "Game synchronized");
    assert.doesNotMatch(s.board.sgf(s.result), /RE\[/);
  } finally { s.close(); }
});

test("an ended recovery snapshot resolves an optimistic move and counting state", () => {
  const { s, notice, restore } = setup();
  try {
    restore(undefined, { 6: 3, 4: [] });
    s.play(3, 3);
    notice(ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 13 }, 4: key });
    restore({ 1: 2, 3: 3 });
    assert.equal(s.result, "W+R");
    assert.equal(s.phase, "finished");
    assert.equal(s.pending, false);
    assert.equal(s.pendingMessageId, null);
    assert.equal(s.pendingMove, null);
    assert.equal(s.counting, false);
    assert.equal(s.pendingConfirmation, null);
  } finally { s.close(); }
});

test("malformed nested result is rejected before replacing the restored game", () => {
  const { s, restore } = setup();
  try {
    const board = s.board;
    for (const fields of [{ 15: 123 }, { 15: { 1: "invalid winner" } }]) {
      assert.throws(() => restore(undefined, fields));
      assert.equal(s.board, board);
      assert.equal(s.phase, "resuming");
      assert.deepEqual(s.roomKey, {});
    }
    restore({ 1: 2, 3: 3 });
    assert.equal(s.result, "W+R");
    assert.equal(s.phase, "finished");
  } finally { s.close(); }
});
