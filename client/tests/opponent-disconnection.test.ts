import { GoGameMessageID } from "../src/protocol.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import { encode, decode } from "../src/wire.ts";
import * as game from "../src/game.ts";

function setup(color = 1) {
  const session = new Session();
  session.uid = 34253685;
  session.phase = "joining";
  const notice = (op: number, fields: Parameters<typeof encode>[0]) =>
    session.gameSvrProcess(op, decode(encode(fields)), decode(encode({ 8: 61 })));
  notice(GoGameMessageID.GC_START_SET_PIECE_NOTIFY, { 6: 357, 7: 1792463395, 9: [
    { 1: session.uid, 6: color, 7: 1200, 8: 3, 9: 60 },
    { 1: 533712957, 6: 3 - color, 7: 1200, 8: 3, 9: 60 },
  ] });
  return { session, notice };
}

// Captured at 2026-10-20T02:31:33.335Z, after move five.
const offline = { 1: 533712957, 2: 90, 3: 1,
  4: { 1: game.GAME_SVR, 2: 61, 3: 357, 4: 1792463395 } };

test("Fox opponent offline notice starts a countdown for either player color", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  for (const color of [1, 2]) {
    const { session, notice } = setup(color);
    try {
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, { ...offline, 1: session.uid });
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, { ...offline, 1: 123 });
      assert.equal(session.snapshot().opponentDisconnectDeadline, null);
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
      const before = session.snapshot();
      assert.equal(before.opponentDisconnectDeadline, 190);
      context.mock.timers.tick(30000);
      assert.equal(session.snapshot().opponentDisconnectDeadline! - Date.now() / 1000, 60);
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, { ...offline, 2: 20 });
      assert.equal(session.snapshot().opponentDisconnectDeadline, 150);
      assert.deepEqual(session.snapshot().stones, before.stones);
      assert.equal(session.phase, "playing");
    } finally { session.close(); }
    context.mock.timers.setTime(100000);
  }
});

test("opponent return clears the notice while own return does not", () => {
  for (const op of [504, 203, 206]) {
    const { session, notice } = setup();
    try {
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
      notice(GoGameMessageID.GC_OPPONENT_RECONNECT_NOTIFY, { 1: session.uid });
      notice(GoGameMessageID.GC_GAME_COUNTDOWN_NOTIFY, { 5: session.uid });
      notice(GoGameMessageID.GC_GAME_COUNTDOWN_NOTIFY, { 5: 533712957 });
      assert.ok(session.snapshot().opponentDisconnectDeadline);
      if (op === GoGameMessageID.GC_OPPONENT_RECONNECT_NOTIFY) notice(GoGameMessageID.GC_OPPONENT_RECONNECT_NOTIFY, { 1: 533712957, 2: offline[4] });
      if (op === GoGameMessageID.GC_SET_PIECE_NOTIFY) notice(GoGameMessageID.GC_SET_PIECE_NOTIFY, { 1: 3, 2: 3, 3: 2 });
      if (op === GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY) { session.board.turn = 2; notice(GoGameMessageID.GC_SKIP_SET_PIECE_NOTIFY, {}); }
      assert.equal(session.snapshot().opponentDisconnectDeadline, null);
    } finally { session.close(); }
  }
});

test("game completion, new games and closing clear opponent disconnect state", () => {
  for (const op of [402, 403, 405, 107, 501, 0]) {
    const { session, notice } = setup();
    try {
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
      if (op === 0) session.close();
      else if (op === GoGameMessageID.GC_START_SET_PIECE_NOTIFY) notice(GoGameMessageID.GC_START_SET_PIECE_NOTIFY, { 6: 358, 7: 1792463396 });
      else if (op === GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST) notice(GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, { 1: 0, 12: game.GAME_SVR, 13: 61, 7: 358, 10: 1792463396 });
      else notice(op, { 1: 0, 2: 1, 4: 3 });
      assert.equal(session.snapshot().opponentDisconnectDeadline, null);
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
      assert.equal(session.snapshot().opponentDisconnectDeadline, null);
    } finally { session.close(); }
  }
});

test("synchronizing the same game preserves a known disconnect deadline", () => {
  const { session, notice } = setup();
  try {
    notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
    const deadline = session.snapshot().opponentDisconnectDeadline;
    notice(GoGameMessageID.GC_FETCH_GAME_ENV_REQUEST, { 1: 0, 6: 3, 12: game.GAME_SVR, 13: 61, 7: 357, 10: 1792463395,
      3: [{ 1: session.uid, 6: 1 }, { 1: 533712957, 6: 2 }] });
    assert.equal(session.snapshot().opponentDisconnectDeadline, deadline);
  } finally { session.close(); }
});

test("disconnect freezes elapsed main time once and reconnect applies Fox's resume clock in either order", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  for (const color of [1, 2]) for (const resumeFirst of [true, false]) {
    context.mock.timers.setTime(100000);
    const { session, notice } = setup(color);
    const opponent = 3 - color;
    try {
      session.board.turn = opponent;
      context.mock.timers.tick(10000);
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
      assert.equal(session.clocks[opponent].main, 1190);
      context.mock.timers.tick(30000);
      notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, { ...offline, 2: 60 });
      assert.equal(session.clocks[opponent].main, 1190, "repeated notices do not charge disconnected time");
      const ownClock = structuredClone(session.clocks[color]);
      // ResumeCountdownNotify captured at 2026-10-20T02:46:06.611Z.
      const resume = () => notice(GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY, { 1: 27,
        2: { 1: 0, 2: 1034, 3: 3, 4: 60, 5: 533712957, 6: 45, 7: offline[4] },
        3: offline[4] });
      if (resumeFirst) resume();
      notice(GoGameMessageID.GC_OPPONENT_RECONNECT_NOTIFY, { 1: 533712957, 2: offline[4] });
      if (!resumeFirst) resume();
      assert.equal(session.opponentDisconnectDeadline, null);
      assert.equal(session.clocks[opponent].main, 1034);
      assert.equal(session.clocks[opponent].at, 140);
      assert.deepEqual(session.clocks[color], ownClock);
      assert.deepEqual(session.board.moveTimings, [], "clock updates do not create move timing records");
    } finally { session.close(); }
  }
});

test("disconnect preserves overtime periods and reconnect without clock data resumes the frozen value", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { session, notice } = setup();
  try {
    session.board.turn = 2;
    session.clocks[2] = { main: 0, periods: 3, byoyomi: 20, periodLength: 60, at: 100 };
    context.mock.timers.tick(25000);
    notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
    assert.deepEqual(session.clocks[2], { main: 0, periods: 3, byoyomi: 0, periodLength: 60, at: 125 });
    context.mock.timers.tick(40000);
    notice(GoGameMessageID.GC_OPPONENT_RECONNECT_NOTIFY, { 1: 533712957 });
    assert.deepEqual(session.clocks[2], { main: 0, periods: 3, byoyomi: 0, periodLength: 60, at: 165 });
    notice(GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY, { 2: { 2: 0, 3: 2, 4: 53, 5: 533712957 } });
    assert.deepEqual(session.clocks[2], { main: 0, periods: 2, byoyomi: 53, periodLength: 60, at: 165 });
  } finally { session.close(); }
});

test("disconnect during our turn leaves both stored clocks unchanged and accepts our resume timing", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { session, notice } = setup();
  try {
    const clocks = structuredClone(session.clocks);
    context.mock.timers.tick(10000);
    notice(GoGameMessageID.GC_OPPONENT_OFFLINE_NOTIFY, offline);
    assert.deepEqual(session.clocks, clocks);
    notice(GoGameMessageID.GC_RESUME_COUNTDOWN_NOTIFY, { 2: { 2: 1189, 3: 3, 4: 60, 5: session.uid } });
    assert.equal(session.clocks[1].main, 1189);
    assert.deepEqual(session.clocks[2], clocks[2]);
  } finally { session.close(); }
});
