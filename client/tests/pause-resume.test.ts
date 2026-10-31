import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import { encode, decode, type Fields } from "../src/wire.ts";
import { GAME_SVR } from "../src/protocol.ts";
import { actionsBlocked, blocked } from "../src/state.ts";
import { ByoyomiAnnouncements, clockReading } from "../src/clock.ts";

const key = { 1: GAME_SVR, 2: 63, 3: 23, 4: 202 };
function setup(color = 1) {
  const sent: unknown[] = [];
  const s = new Session();
  Object.assign(s, { uid: 42, color, roomKey: { ...key }, phase: "playing", synSeqId: 10,
    players: { [color]: { id: 42, name: "Me" }, [3 - color]: { id: 43, name: "Opponent" } } });
  s.boardRoomKey = Object.values(key).join(":");
  s.clocks = {
    1: { main: 120, periods: 3, byoyomi: 60, at: 100, periodLength: 60 },
    2: { main: 240, periods: 3, byoyomi: 60, at: 100, periodLength: 60 },
  };
  s.fgwConnection = { send(...args) { sent.push(args); }, close() {} };
  const notice = (op: number, fields: Fields) => s.gameSvrProcess(op, decode(encode(fields)), decode(encode({ 7: GAME_SVR, 8: 63 })));
  const pause = (fields: Fields = {}) => notice(218, { 1: { 1: 11 }, 2: 30, 3: 42, 5: key, ...fields });
  const resume = (fields: Fields = {}) => notice(219, { 1: { 1: 12 }, 2: 42, 4: key, ...fields });
  return { s, notice, pause, resume, sent };
}

test("pause and resume apply both clocks and authoritative current UID for either player color", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  for (const color of [1, 2]) {
    const { s, pause, resume, sent } = setup(color);
    try {
      pause({ 4: [
        { 2: 111, 3: 3, 4: 60, 5: 42, 7: key },
        { 2: 222, 3: 2, 4: 45, 5: 43, 7: key },
      ] });
      assert.equal(s.paused, true);
      assert.equal(s.snapshot().pauseTimeSeconds, 30);
      assert.equal(s.board.turn, color);
      assert.equal(s.clocks[color].main, 111);
      assert.equal(s.clocks[3 - color].main, 222);
      assert.equal(s.synSeqId, 11);
      assert.equal(s.status, "Game paused");
      assert.equal(s.counting, false);
      assert.equal(s.pendingConfirmation, null);
      assert.ok(blocked(s.snapshot()));
      assert.ok(actionsBlocked(s.snapshot()));
      const clocks = structuredClone(s.clocks);
      for (const action of [() => s.play(3, 3), () => s.passTurn(), () => s.requestCounting(), () => s.resign(), () => s.estimateScore()])
        assert.throws(action, /paused/);
      assert.deepEqual(sent, []);
      context.mock.timers.tick(60000);
      assert.equal(s.tickClock(), false);
      assert.deepEqual(s.clocks, clocks);
      assert.equal(s.paused, true, "pause allowance expiry never resumes locally");
      resume({ 2: 43, 3: [
        { 2: 109, 3: 3, 4: 60, 5: 42 },
        { 2: 220, 3: 2, 4: 45, 5: 43 },
      ] });
      assert.equal(s.paused, false);
      assert.equal(s.pauseTimeSeconds, null);
      assert.equal(s.board.turn, 3 - color);
      assert.equal(s.clocks[color].main, 109);
      assert.equal(s.clocks[3 - color].main, 220);
      assert.equal(s.clocks[3 - color].at, Date.now() / 1000);
      assert.equal(s.synSeqId, 12);
      assert.ok(!blocked(s.snapshot()));
      assert.deepEqual(s.board.moves, []);
      assert.deepEqual(s.board.moveTimings, []);
    } finally { s.close(); }
    context.mock.timers.setTime(100000);
  }
});

test("missing clocks freeze the displayed reading once and exclude the whole pause on resume", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { s, pause, resume } = setup();
  try {
    context.mock.timers.tick(7000);
    pause();
    assert.equal(s.clocks[1].main, 113);
    context.mock.timers.tick(20000);
    pause({ 2: 10 });
    assert.equal(s.clocks[1].main, 113);
    context.mock.timers.tick(10000);
    resume();
    assert.equal(s.clocks[1].at, 137);
    assert.equal(clockReading(s.clocks[1], 5).main, 108);
    context.mock.timers.tick(5000);
    resume();
    assert.equal(s.clocks[1].at, 137, "duplicate resume does not give back elapsed time");
  } finally { s.close(); }
});

test("paused overtime neither rolls periods nor speaks and resume starts from the server reading", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { s, pause, resume } = setup();
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(sound => sounds.push(sound));
  try {
    s.clocks[1] = { main: 0, periods: 2, byoyomi: 8, periodLength: 30, at: 100 };
    pause({ 4: [{ 2: 0, 3: 2, 4: 8, 5: 42 }] });
    context.mock.timers.tick(90000);
    assert.equal(s.tickClock(), false);
    speaker.update(s.snapshot(), 190);
    assert.equal(sounds.length, 0);
    assert.equal(s.clocks[1].periods, 2);
    resume({ 3: [{ 2: 0, 3: 2, 4: 7, 5: 42 }] });
    speaker.update(s.snapshot(), 190);
    assert.ok(sounds.includes("count-7"));
    assert.equal(s.clocks[1].byoyomi, 7);
    assert.equal(s.clocks[1].at, 190);
  } finally { s.close(); }
});

test("unknown UIDs never switch turn or overwrite another player's clock", () => {
  const { s, pause, resume } = setup();
  try {
    pause({ 3: 999, 4: [{ 2: 1, 5: 999 }, { 2: 1 }] });
    assert.equal(s.board.turn, 1);
    assert.equal(s.clocks[2].main, 240);
    resume({ 2: 999 });
    assert.equal(s.board.turn, 1);
  } finally { s.close(); }
});

test("foreign outer and embedded room keys cannot pause or resume the game", () => {
  const { s, pause, resume } = setup();
  try {
    pause({ 5: { ...key, 4: 203 } });
    pause({ 4: [{ 2: 1, 5: 42, 7: { ...key, 3: 24 } }] });
    assert.equal(s.paused, false);
    assert.equal(s.synSeqId, 10);
    pause();
    resume({ 4: { ...key, 4: 203 } });
    resume({ 3: [{ 2: 1, 5: 42, 7: { ...key, 2: 64 } }] });
    assert.equal(s.paused, true);
    assert.equal(s.synSeqId, 11);
  } finally { s.close(); }
});

test("pause and resume preserve counting confirmations and pending actions", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { s, pause, resume, notice } = setup();
  try {
    s.play(3, 3);
    const pendingMove = s.pendingMove;
    pause(); resume();
    assert.equal(s.pendingMove, pendingMove);
    assert.equal(s.pending, true);
    notice(203, { 1: 3, 2: 3, 3: 1 });
    notice(303, { 1: 0, 2: 1 });
    pause();
    const confirmation = s.pendingConfirmation;
    s.confirm(false);
    assert.equal(s.pending, true, "an open counting dialog can be answered during pause");
    notice(304, { 1: 1 });
    assert.equal(s.pendingConfirmation, confirmation);
    resume();
    assert.equal(s.counting, true);
    assert.equal(s.pendingConfirmation, confirmation);
    notice(109, { 2: { 2: 100, 3: 3, 4: 60, 5: 42 } });
    assert.equal(s.counting, false);
    assert.equal(s.pendingConfirmation, null);
    assert.equal(s.paused, false);
    assert.equal(s.clocks[1].main, 100);
  } finally { s.close(); }
});

test("counting and opponent offline during a pause never charge the frozen clock", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { s, pause, resume, notice } = setup();
  try {
    pause({ 3: 43 });
    const main = s.clocks[2].main;
    context.mock.timers.tick(30000);
    notice(503, { 1: 43, 2: 90 });
    assert.equal(s.clocks[2].main, main);
    s.counting = true;
    assert.equal(s.clocks[2].main, main);
    resume();
    assert.equal(s.counting, true, "game resume cannot resolve counting by itself");
  } finally { s.close(); }
});

test("snapshots preserve or authoritatively restore pause and finished games clear it", () => {
  const { s, pause, notice } = setup();
  const env: Fields = { 1: 0, 3: [{ 1: 42, 6: 1 }, { 1: 43, 6: 2 }], 5: { 1: 12 }, 6: 3, 32: key };
  try {
    pause();
    notice(501, env);
    assert.equal(s.paused, true, "legacy snapshots cannot release a known pause");
    notice(501, { ...env, 25: 0 });
    assert.equal(s.paused, false);
    notice(501, { ...env, 25: 20 });
    assert.equal(s.paused, true);
    assert.equal(s.pauseTimeSeconds, 20);
    notice(501, { ...env, 6: 5, 15: { 1: 2, 3: 3 } });
    assert.equal(s.paused, false);
    assert.equal(s.pauseTimeSeconds, null);
    assert.equal(s.result, "W+R");
  } finally { s.close(); }
  assert.equal(s.paused, false);
});

test("terminal results and fresh matches clear pause state", () => {
  for (const op of [402, 403, 405]) {
    const { s, pause, notice } = setup();
    try {
      pause();
      notice(op, { 2: 1, 4: 3 });
      assert.equal(s.paused, false);
      assert.equal(s.pauseTimeSeconds, null);
      s.fieldId = 1;
      s.match();
      notice(107, { 26: { ...key, 4: 203 }, 9: [{ 1: 42, 6: 1 }] });
      assert.equal(s.paused, false);
    } finally { s.close(); }
  }
});

test("a resume received without its pause rebases a changed turn without refunding elapsed time", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { s, resume } = setup();
  try {
    context.mock.timers.tick(10000);
    resume({ 2: 43 });
    assert.equal(s.board.turn, 2);
    assert.equal(s.clocks[1].main, 110);
    assert.equal(s.clocks[2].main, 240);
    assert.equal(s.clocks[2].at, 110);
    context.mock.timers.tick(5000);
    resume({ 2: 43 });
    assert.equal(s.clocks[2].at, 110);
    assert.equal(clockReading(s.clocks[2], 5).main, 235);
  } finally { s.close(); }
});
