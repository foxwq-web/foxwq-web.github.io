import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import type { Fields, Message } from "../src/wire.ts";
import { encodeFgwMessage, decodeFgwMessage, GAME_SVR, SVR_TYPE_FGW } from "../src/game.ts";
import { GoGameMessageID as ID, ErrorCode, LegacyMsgTypeID, ClientMessageID } from "../src/protocol.ts";
import { blocked, actionsBlocked } from "../src/state.ts";

const roomKey = { 1: GAME_SVR, 2: 63, 3: 23, 4: 202 };
function setup() {
  const sent: { messageId: number; serverType: number; serverId: number; body: Message }[] = [];
  const sounds: string[] = [];
  let closed = false;
  const session = new Session({ onSound: name => sounds.push(name) });
  Object.assign(session, { uid: 42, color: 1, roomKey: { ...roomKey }, synSeqId: 10, phase: "playing" });
  session.boardRoomKey = Object.values(roomKey).join(":");
  session.fgwConnection = {
    send(_type, bytes) {
      const [header, body] = decodeFgwMessage(Buffer.from(bytes));
      sent.push({ messageId: header.number(1), serverType: header.number(7), serverId: header.number(8), body });
    },
    close() { closed = true; },
  };
  const reply = (messageId: number, fields: Fields, serverId = roomKey[2], serverType = GAME_SVR) =>
    session.receive(session.generation, { msgTypeID: LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET,
      flag: 0, rawProto: encodeFgwMessage(42, serverType, messageId, fields, serverId) });
  const snapshot = (fields: Fields = {}, serverId = roomKey[2]) => reply(ID.GC_FETCH_GAME_ENV_REQUEST, {
    1: 0, 3: [{ 1: 42, 6: 1, 7: 300, 8: 3, 9: 60 }, { 1: 43, 6: 2, 7: 290, 8: 3, 9: 60 }],
    4: [{ 1: 1, 2: 3, 3: 3, 4: 1 }, { 1: 1, 2: 15, 3: 15, 4: 2 }],
    5: { 1: 12 }, 6: 3, 7: 23, 10: 202, 12: GAME_SVR, 13: 63, ...fields,
  }, serverId);
  const mismatch = () => reply(ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 11 }, 4: roomKey });
  const requests = () => sent.filter(packet => packet.messageId === ID.GC_FETCH_GAME_ENV_REQUEST);
  return { session, sent, sounds, reply, snapshot, mismatch, requests, closed: () => closed };
}

test("matching and absent heartbeat sequences do not recover; mismatches are scoped to the current room", () => {
  const { session: s, reply, requests, mismatch } = setup();
  try {
    for (const fields of [{}, { 3: {} }, { 3: { 1: 10 }, 4: roomKey }]) reply(ID.GC_HEART_BEAT_REQUEST, fields);
    for (const field of [1, 2, 3, 4]) {
      reply(ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 11 }, 4: { ...roomKey, [field]: 999 } });
    }
    reply(ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 11 } }, 64);
    assert.equal(requests().length, 0);
    assert.equal(s.pending, false);
    // Older replies may omit the optional room key; the header still routes them.
    reply(ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 11 } });
    assert.equal(requests().length, 1);
    assert.equal(s.synSeqId, 10, "a heartbeat never advances the local sequence without the board");
    assert.equal(s.pendingMessageId, ID.GC_FETCH_GAME_ENV_REQUEST);
    assert.ok(blocked(s.snapshot()));
    assert.ok(actionsBlocked(s.snapshot()));
    mismatch();
    assert.equal(requests().length, 1);
  } finally { s.close(); }
});

test("recovery coalesces signals, blocks every action, and only a matching snapshot restores an optimistic board", () => {
  const { session: s, sounds, reply, snapshot, mismatch, requests } = setup();
  try {
    s.play(3, 3);
    mismatch();
    assert.equal(requests().length, 1);
    assert.equal(requests()[0].serverType, GAME_SVR);
    assert.equal(requests()[0].serverId, 63);
    assert.deepEqual([...requests()[0].body.sub(1)].map(([field, values]) => [field, values[0]]),
      Object.entries(roomKey).map(([field, value]) => [Number(field), value]));
    for (const action of [() => s.play(4, 4), () => s.passTurn(), () => s.resign(), () => s.requestCounting(), () => s.estimateScore()]) {
      assert.throws(action);
    }
    for (let i = 0; i < 4; i++) mismatch();
    reply(ID.GC_SET_PIECE_REQUEST, { 1: ErrorCode.NEC_CHECK_SYC_ERROR });
    reply(ID.GC_SET_PIECE_REQUEST, { 1: 0 });
    reply(ID.GC_SET_PIECE_NOTIFY, { 1: 3, 2: 3, 3: 1, 5: { 1: 11 } });
    reply(ID.GC_SKIP_SET_PIECE_NOTIFY, { 2: { 1: 12 } });
    reply(ID.GC_CALCULATE_CONFIRM_NOTIFY, { 1: 0, 2: 1 });
    assert.equal(requests().length, 1);
    assert.equal(s.pending, true);
    assert.equal(s.pendingConfirmation, null);
    assert.equal(s.synSeqId, 10);
    assert.deepEqual(s.board.moves, [[1, 3, 3]]);
    for (const fields of [{ 7: 999 }, { 10: 100 }, { 12: 1 }, { 13: 64 }]) snapshot(fields);
    snapshot({}, 64);
    assert.equal(s.pending, true);
    assert.equal(s.board.moves.length, 1);
    snapshot();
    assert.equal(s.phase, "playing");
    assert.equal(s.synSeqId, 12);
    assert.equal(s.pending, false);
    assert.equal(s.pendingMove, null);
    assert.equal(s.pendingMessageId, null);
    assert.equal(s.clocks[1].main, 300);
    assert.deepEqual(s.board.moves, [[1, 3, 3], [2, 15, 15]]);
    assert.deepEqual(sounds, ["stone"], "snapshot replay is silent");
    assert.doesNotThrow(() => s.play(4, 4));
  } finally { s.close(); }
});

for (const messageId of [ID.GC_SET_PIECE_REQUEST, ID.GC_SKIP_SET_PIECE_REQUEST, ID.GC_CALCULATE_REQUEST,
  ID.GC_CALCULATE_ANSWER_REQUEST, ID.GC_GIVE_UP_REQUEST, ID.GS_OP_ERROR]) {
  test(`sequence error ${messageId} repairs the board without resubmitting the action`, () => {
    const { session: s, reply, snapshot, sent, requests } = setup();
    try {
      if (messageId === ID.GC_SET_PIECE_REQUEST) s.play(3, 3);
      reply(messageId, { 1: ErrorCode.NEC_CHECK_SYC_ERROR });
      assert.equal(requests().length, 1);
      assert.equal(s.pending, true);
      snapshot();
      assert.equal(s.pending, false);
      assert.equal(s.synSeqId, 12);
      assert.equal(sent.filter(packet => packet.messageId === ID.GC_SET_PIECE_REQUEST).length,
        messageId === ID.GC_SET_PIECE_REQUEST ? 1 : 0);
    } finally { s.close(); }
  });
}

test("foreign sequence errors and ordinary action rejection retain their separate behavior", () => {
  const { session: s, reply, requests } = setup();
  try {
    reply(ID.GC_SET_PIECE_REQUEST, { 1: ErrorCode.NEC_CHECK_SYC_ERROR, 3: { ...roomKey, 4: 100 } });
    reply(ID.GC_SKIP_SET_PIECE_REQUEST, { 1: ErrorCode.NEC_CHECK_SYC_ERROR, 2: { ...roomKey, 3: 99 } });
    reply(ID.GS_OP_ERROR, { 1: ErrorCode.NEC_CHECK_SYC_ERROR, 7: GAME_SVR, 8: 64 });
    reply(ID.GS_OP_ERROR, { 1: ErrorCode.NEC_CHECK_SYC_ERROR, 7: 1, 8: 63 });
    reply(ID.GS_OP_ERROR, { 1: ErrorCode.NEC_CHECK_SYC_ERROR }, 64);
    assert.equal(requests().length, 0);
    s.play(3, 3);
    reply(ID.GC_SET_PIECE_REQUEST, { 1: 123 });
    assert.equal(s.pending, false);
    assert.equal(s.board.moves.length, 0);
    assert.equal(requests().length, 0);
  } finally { s.close(); }
});

test("only three snapshot attempts are sent before recovery fails into the normal connection-failure path", context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { session: s, reply, mismatch, requests, closed } = setup();
  try {
    mismatch();
    s.heartbeat(s.generation);
    for (let step = 1; step <= 6; step++) {
      context.mock.timers.tick(5000);
      if (step < 6) reply(ClientMessageID.MID_HEART_BEAT_REQUEST, {}, 0, SVR_TYPE_FGW);
      assert.equal(requests().length, Math.min(3, 1 + Math.floor(step / 2)));
    }
    assert.equal(s.phase, "error"); // This fixture has no cached credentials to reconnect with.
    assert.equal(s.status, "Game synchronization timed out");
    assert.equal(closed(), true);
    context.mock.timers.tick(60000);
    assert.equal(requests().length, 3);
  } finally { s.close(); }
});

test("a stalled action uses the same recovery and ignores a late acknowledgment", context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { session: s, reply, snapshot, requests } = setup();
  try {
    s.play(3, 3);
    reply(ClientMessageID.MID_HEART_BEAT_REQUEST, {}, 0, SVR_TYPE_FGW);
    s.heartbeat(s.generation);
    context.mock.timers.tick(10000);
    assert.equal(requests().length, 1);
    reply(ID.GC_SET_PIECE_NOTIFY, { 1: 3, 2: 3, 3: 1 });
    assert.equal(s.pending, true);
    snapshot();
    assert.equal(s.pending, false);
  } finally { s.close(); }
});

for (const fields of [{ 1: 123 }, { 3: [{ 1: 43, 6: 2 }] }, { 5: undefined }]) {
  test(`rejected or incomplete snapshots cannot unlock recovery: ${JSON.stringify(fields)}`, () => {
    const { session: s, mismatch, snapshot, closed } = setup();
    try {
      mismatch();
      snapshot(fields);
      assert.equal(s.phase, "error");
      assert.ok(blocked(s.snapshot()));
      assert.equal(closed(), true);
    } finally { s.close(); }
  });
}

test("terminal results and close cancel recovery; finished and disconnected games never request it", context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { session: s, reply, mismatch, requests } = setup();
  try {
    mismatch();
    reply(ID.GC_SET_GAME_END_NOTIFY, { 1: 0, 2: 2, 4: 3 });
    assert.equal(s.phase, "finished");
    assert.equal(s.pending, false);
    mismatch();
    assert.equal(requests().length, 1);
    const oldGeneration = s.generation;
    s.close();
    context.mock.timers.tick(60000);
    s.receive(oldGeneration, { msgTypeID: LegacyMsgTypeID.MTID_CS_GATEWAYSERVER_PACKET, flag: 0,
      rawProto: encodeFgwMessage(42, GAME_SVR, ID.GC_HEART_BEAT_REQUEST, { 3: { 1: 99 } }, 63) });
    assert.equal(requests().length, 1);
    assert.equal(s.phase, "disconnected");
  } finally { s.close(); }
});
