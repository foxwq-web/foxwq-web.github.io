import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import { decode, encode, type Fields } from "../src/wire.ts";
import { GAME_SVR, GoGameMessageID as ID, RoomMessageID as RM } from "../src/protocol.ts";
import { validateGameRoom } from "../src/room-validation.ts";

const key = { 1: GAME_SVR, 2: 63, 3: 23, 4: 202 };
const message = (fields: Fields) => decode(encode(fields));
const scopedEvents: [number, number][] = [
  [ID.GC_START_SET_PIECE_NOTIFY, 26], [ID.GC_GAME_COUNTDOWN_NOTIFY, 7],
  [ID.GC_RESUME_COUNTDOWN_NOTIFY, 3], [ID.GC_HEART_BEAT_REQUEST, 4],
  [ID.GC_SET_PIECE_REQUEST, 3], [ID.GC_SET_PIECE_NOTIFY, 12],
  [ID.GC_SKIP_SET_PIECE_REQUEST, 2], [ID.GC_SKIP_SET_PIECE_NOTIFY, 7],
  [ID.GC_GAME_PAUSE_NOTIFY, 5], [ID.GC_GAME_RESUME_NOTIFY, 4],
  [ID.GC_CALCULATE_REQUEST, 2], [ID.GC_CALCULATE_CONFIRM_NOTIFY, 10],
  [ID.GC_CALCULATE_ANSWER_REQUEST, 2], [ID.GC_CALCULATE_ANSWER_NOTIFY, 3],
  [ID.GC_GIVE_UP_REQUEST, 2], [ID.GC_SET_GAME_END_NOTIFY, 13],
  [ID.GC_SET_GAME_RESULT_NOTIFY, 18], [ID.LEGACY_GC_SET_GAME_END_NOTIFY, 13],
  [ID.GC_ROOM_DESTROY_NOTIFY, 1], [ID.GC_FETCH_GAME_ENV_REQUEST, 32],
  [ID.GC_OPPONENT_OFFLINE_NOTIFY, 4], [ID.GC_OPPONENT_RECONNECT_NOTIFY, 2],
];
function setup() {
  const sent: unknown[] = [], sounds: string[] = [];
  const session = new Session({ onSound: sound => sounds.push(sound) });
  Object.assign(session, { uid: 42, color: 1, roomKey: { ...key }, phase: "playing", synSeqId: 10 });
  session.boardRoomKey = Object.values(key).join(":");
  session.fgwConnection = { send(...args) { sent.push(args); }, close() {} };
  const notice = (id: number, fields: Fields, header: Fields = { 7: GAME_SVR, 8: 63 }) =>
    session.gameSvrProcess(id, message(fields), message(header));
  return { session, sent, sounds, notice };
}

for (const [id, tag] of scopedEvents) test(`operation ${id} rejects foreign room identities before any mutation`, () => {
  const { session: s, sent, sounds, notice } = setup();
  try {
    s.play(3, 3);
    const before = {
      board: s.board, moves: structuredClone(s.board.moves), clocks: structuredClone(s.clocks),
      phase: s.phase, pending: s.pendingMove, pendingId: s.pendingMessageId,
      sequence: s.synSeqId, result: s.result, confirmation: s.pendingConfirmation,
      counting: s.counting, deadline: s.opponentDisconnectDeadline,
    };
    const sentCount = sent.length, soundCount = sounds.length;
    // Include plausible move, result, clock and sequence payloads. The identity
    // guard must run before even decoding their operation-specific contents.
    for (const field of [1, 2, 3, 4]) notice(id, {
      1: 3, 2: 3, 3: 1, 5: { 1: 11 }, [tag]: { ...key, [field]: key[field as keyof typeof key] + 1 },
    });
    notice(id, {}, { 7: GAME_SVR, 8: 64 });
    notice(id, {}, { 7: GAME_SVR + 1, 8: 63 });
    assert.equal(s.board, before.board);
    assert.deepEqual(s.board.moves, before.moves);
    assert.deepEqual(s.clocks, before.clocks);
    assert.equal(s.phase, before.phase);
    assert.equal(s.pendingMove, before.pending);
    assert.equal(s.pendingMessageId, before.pendingId);
    assert.equal(s.synSeqId, before.sequence);
    assert.equal(s.result, before.result);
    assert.equal(s.pendingConfirmation, before.confirmation);
    assert.equal(s.counting, before.counting);
    assert.equal(s.opponentDisconnectDeadline, before.deadline);
    assert.equal(sent.length, sentCount);
    assert.equal(sounds.length, soundCount);
  } finally { s.close(); }
});

test("legacy events without optional keys still work; matching keys confirm moves", () => {
  for (const room of [undefined, key]) {
    const { session: s, notice } = setup();
    try {
      s.play(3, 3);
      notice(ID.GC_SET_PIECE_NOTIFY, { 1: 3, 2: 3, 3: 1, 5: { 1: 11 }, 12: room });
      assert.equal(s.pending, false);
      assert.equal(s.pendingMove, null);
      assert.equal(s.synSeqId, 11);
      assert.deepEqual(s.board.moves, [[1, 3, 3]]);
    } finally { s.close(); }
  }
});

test("initial identities must agree across modern, legacy and gateway fields", () => {
  for (const [id, tag, flat] of [
    [107, 26, { 11: GAME_SVR, 12: 63, 6: 23, 7: 202 }],
    [501, 32, { 12: GAME_SVR, 13: 63, 7: 23, 10: 202 }],
  ] as const) {
    const valid = { ...flat, [tag]: key };
    assert.deepEqual(validateGameRoom(id, message(valid), message({ 7: GAME_SVR, 8: 63 }), {})?.roomKey, key);
    for (const field of [1, 2, 3, 4]) assert.equal(validateGameRoom(id,
      message({ ...valid, [tag]: { ...key, [field]: 999 } }), undefined, {}), null);
    assert.equal(validateGameRoom(id, message(valid), message({ 8: 64 }), {}), null);
  }
});

test("malformed metadata and contradictions in embedded countdowns are rejected", () => {
  for (const bad of [123, new Uint8Array([0x80]), { 3: "not a room" }, { 4: 2n ** 63n }]) {
    assert.equal(validateGameRoom(203, message({ 12: bad }), undefined, key), null);
  }
  for (const [id, tag] of [[203, 4], [206, 1], [109, 2]]) {
    assert.equal(validateGameRoom(id, message({ [tag]: { 7: { ...key, 4: 203 } } }), undefined, key), null);
  }
  assert.equal(validateGameRoom(ID.GS_OP_ERROR, message({ 7: GAME_SVR, 8: 64 }), undefined, key), null);
  assert.deepEqual(validateGameRoom(501, message({}), undefined, key), { roomKey: key, completeBodyIdentity: false });
});

test("room assignment binds a new game and cannot rebind an active game", () => {
  const { session: s, sent, notice } = setup();
  try {
    s.phase = "matching";
    s.roomKey = {};
    s.gameSvrMgrProcess(RM.RM_ENTER_ROOM_NOTIFY, message({ 2: GAME_SVR, 3: 63, 4: 23, 7: 202 }));
    assert.equal(s.phase, "joining");
    assert.deepEqual(s.roomKey, key);
    const count = sent.length;
    for (const phase of ["joining", "playing"] as const) {
      s.phase = phase;
      s.gameSvrMgrProcess(RM.RM_ENTER_ROOM_NOTIFY, message({ 2: GAME_SVR, 3: 63, 4: 23, 7: 201 }));
      assert.equal(s.phase, phase);
      assert.deepEqual(s.roomKey, key);
      notice(107, { 26: { ...key, 4: 201 } });
      assert.deepEqual(s.roomKey, key);
    }
    assert.equal(sent.length, count);
  } finally { s.close(); }
});

test("a late start or assignment for the completed room cannot win a fresh match", () => {
  const { session: s, notice, sent } = setup();
  try {
    s.phase = "finished";
    s.gameOver = true;
    s.fieldId = 1;
    s.match();
    const count = sent.length;
    notice(107, { 26: key });
    s.gameSvrMgrProcess(RM.RM_ENTER_ROOM_NOTIFY, message({ 2: GAME_SVR, 3: 63, 4: 23, 7: 202 }));
    assert.equal(s.phase, "matching");
    assert.deepEqual(s.roomKey, {});
    assert.equal(sent.length, count);
    notice(107, { 26: { ...key, 4: 203 } });
    assert.equal(s.phase, "playing");
    assert.equal(s.roomKey[4], 203);
  } finally { s.close(); }
});

test("cold game-lock discovery pins the room before accepting a snapshot", () => {
  const { session: s, notice } = setup();
  try {
    s.phase = "resuming";
    s.roomKey = {};
    s.gameSvrMgrProcess(RM.RM_QUERY_GAME_LOCK_REQUEST, message({ 1: 0, 2: GAME_SVR, 3: 63, 4: 23, 7: 202 }));
    notice(501, { 32: { ...key, 4: 203 } });
    notice(501, { 32: key }, { 8: 64 });
    assert.equal(s.phase, "resuming");
    assert.deepEqual(s.roomKey, {});
    notice(501, { 32: key, 6: 3, 3: [{ 1: 42, 6: 1 }] });
    assert.equal(s.phase, "playing");
    assert.deepEqual(s.roomKey, key);
  } finally { s.close(); }
});

test("cached reconnect identity protects the cleared live room, including the no-lock fallback", () => {
  for (const foundLock of [true, false]) {
    const { session: s, notice, sent } = setup();
    try {
      Object.assign(s, { reconnectBoard: s.snapshot() });
      s.roomKey = {};
      s.phase = "resuming";
      s.gameSvrMgrProcess(RM.RM_QUERY_GAME_LOCK_REQUEST, message(foundLock
        ? { 1: 0, 2: GAME_SVR, 3: 63, 4: 23, 7: 202 } : { 1: 1 }));
      const count = sent.length;
      notice(107, { 26: { ...key, 4: 203 } });
      notice(501, { 32: { ...key, 4: 203 } });
      assert.deepEqual(s.roomKey, {});
      assert.equal(sent.length, count);
      notice(501, { 32: key, 6: 3, 3: [{ 1: 42, 6: 1 }] });
      assert.deepEqual(s.roomKey, key);
      assert.equal(s.phase, "playing");
    } finally { s.close(); }
  }
});

test("sequence recovery accepts a complete structured-only identity", () => {
  const { session: s, notice } = setup();
  try {
    notice(ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 11 }, 4: key });
    assert.equal(s.pendingMessageId, ID.GC_FETCH_GAME_ENV_REQUEST);
    notice(501, { 32: { ...key, 4: 203 }, 5: { 1: 11 } });
    assert.equal(s.pending, true);
    notice(501, { 32: key, 5: { 1: 11 }, 6: 3, 3: [{ 1: 42, 6: 1 }] });
    assert.equal(s.pending, false);
    assert.equal(s.synSeqId, 11);
    assert.deepEqual(s.roomKey, key);
  } finally { s.close(); }
});

test("foreign results cannot overwrite a finished game's local review", () => {
  const { session: s, notice } = setup();
  try {
    s.phase = "finished";
    s.gameOver = true;
    s.result = "B+R";
    const board = s.board;
    for (const [id, tag] of [[402, 13], [403, 18], [405, 13]]) {
      notice(id, { 1: 0, 2: 2, 4: 3, [tag]: { ...key, 4: 201 } });
    }
    assert.equal(s.board, board);
    assert.equal(s.result, "B+R");
    assert.equal(s.phase, "finished");
  } finally { s.close(); }
});
