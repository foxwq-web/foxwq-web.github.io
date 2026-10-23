import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../../client/src/board.ts';
import { Session } from '../../client/src/session.ts';
import { encode, decode } from '../../client/src/wire.ts';
import type { Estimator, EstimateResponse } from '../src/score-estimation.ts';
import { decodeEstimate } from '../src/score-estimation.ts';
import { applyDevScreen } from '../../client/src/dev-screens.ts';

const reply = (map: number[]): EstimateResponse => ({ ret: 0, board_size: 19, judge_status: map.join('') });
const deferred = () => { let resolve!: (value: EstimateResponse) => void, reject!: (reason: Error) => void; const promise = new Promise<EstimateResponse>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function foxSession(fetcher: Estimator) {
  const s = new Session(); await applyDevScreen(s, 'board-black');
  s.estimationFetcher = fetcher;
  return s;
}

test('Fox estimation counts territory, prisoners and dead stones, excluding live stones and dame', () => {
  const b = new Board(); b.play(3, 3); b.play(15, 15);
  b.captures[1] = 10; b.captures[2] = 5;
  const map = Array(361).fill(0); map[60] = 2;
  const e = decodeEstimate(reply(map), b, 7.5);
  assert.equal(e.ownership[60], 2);
  assert.equal(e.black, 10); assert.equal(e.white, 7);
  assert.equal(e.neutral, 359); assert.equal(e.lead, -4.5);

  assert.equal(b.stones[60], 1); assert.deepEqual(b.captures, [0,10,5]);
  b.turn = 2;
  const whiteToPlay = decodeEstimate(reply(map), b, 0);
  assert.equal(whiteToPlay.black, 10); assert.equal(whiteToPlay.white, 7);
  assert.equal(whiteToPlay.lead, 3);
});

test('estimation leaves isolated neutral holes unscored even in settled positions', () => {
  const b = new Board(), map = Array(361).fill(1); map[180] = 0;
  const settled = decodeEstimate(reply(map), b, 7.5);
  assert.equal(settled.black, 360); assert.equal(settled.white, 0);
  assert.equal(settled.ownership[180], 0); assert.equal(settled.neutral, 1);
  for (const p of [0,1,2,3,4,5,6,7,8,9]) map[p] = 0;
  const unsettled = decodeEstimate(reply(map), b, 7.5);
  assert.equal(unsettled.ownership[180], 0);
  assert.equal(unsettled.neutral, 11);
  assert.equal(unsettled.black + unsettled.white, 350);
});

test('false-eye penalties reduce only their own territory score', () => {
  const b = new Board(), map = Array(361).fill(0);
  map[0] = 1; map[1] = 1; map[2] = 2;
  const e = decodeEstimate({ ...reply(map), black_penalty: 2, white_penalty: 1 }, b, 7.5);
  assert.equal(e.black, 0); assert.equal(e.white, 0); assert.equal(e.lead, -7.5);
});

test('estimator failure codes, malformed and truncated maps are rejected', () => {
  const b = new Board();
  for (const data of [null, {}, { ret: '0' }, { ret: 109045 },
    { ret: 0, board_size: 13, judge_status: '0'.repeat(361) },
    { ret: 0, board_size: 19, judge_status: '0'.repeat(360) },
    { ret: 0, board_size: 19, judge_status: '3'.repeat(361) }]) assert.throws(() => decodeEstimate(data as EstimateResponse, b, 7.5));
});

test('estimate, return and retry preserve the board and resume normal game actions', async () => {
  const task = deferred(); let payload;
  const s = await foxSession(options => { payload = options.payload; return task.promise; });
  const before = structuredClone(s.board), status = s.status, clocks = structuredClone(s.clocks);
  const done = s.estimateScore();
  assert.equal(s.snapshot().estimation!.phase, 'loading');
  assert.throws(() => s.play(10, 10), /Return to the game/);
  assert.throws(() => s.passTurn(), /Return to the game/);
  assert.throws(() => s.estimateScore(), /already open/);
  task.resolve(reply(Array(361).fill(0))); await done;
  assert.equal(s.snapshot().estimation!.phase, 'result');
  assert.deepEqual(payload, { status: s.board.stones.join('') });
  assert.deepEqual(structuredClone(s.board), before); assert.deepEqual(s.clocks, clocks); assert.equal(s.status, status);
  s.returnToGame(); assert.equal(s.estimation, null);
  s.estimationFetcher = async () => ({ ret: 109045 });
  await s.estimateScore(); assert.equal(s.estimation!.phase, 'error');
  s.estimationFetcher = async () => reply(Array(361).fill(0));
  await s.estimateScore(); assert.equal(s.estimation!.phase, 'result');
  s.returnToGame(); s.passTurn(); assert.equal(s.pending, true); s.close();
});

test('opponent moves and passes preserve completed and pending estimates of the original board', async () => {
  for (const op of [203, 206]) for (const pending of [false, true]) {
    const task = deferred(); let signal!: AbortSignal, calls = 0;
    const s = await foxSession(options => { calls++; signal = options.signal; return task.promise; });
    try {
      s.board = new Board();
      s.board.play(10, 9, s.color);
      assert.equal(s.board.turn, 3 - s.color);
      const board = s.board.clone(), map = Array(361).fill(2);
      const expected = { phase: 'result', stones: board.stones, ...decodeEstimate(reply(map), board, s.komi) };
      const done = s.estimateScore();
      if (!pending) { task.resolve(reply(map)); await done; }
      const estimate = s.estimation;
      s.gameMessage(op, decode(encode(op === 203 ? {1:10,2:10,3:3 - s.color} : {})), decode(encode({})));
      assert.equal(s.board.turn, s.color);
      assert.equal(s.board.moves.length, board.moves.length + 1);
      assert.equal(s.board.stones[200], op === 203 ? 3 - s.color : 0);
      assert.equal(s.estimation, estimate);
      assert.equal(signal.aborted, false);
      if (pending) { task.resolve(reply(map)); await done; }
      assert.deepEqual(s.snapshot().estimation, expected);
      assert.equal(calls, 1);
      assert.throws(() => s.play(11, 10), /Return to the game/);
      s.returnToGame();
      assert.equal(s.estimation, null);
      s.play(11, 10);
      assert.equal(s.board.stones[201], s.color);
    } finally { s.close(); }
  }
});

test('return, disconnect, own move or pass, counting, game end and synchronization invalidate late results', async () => {
  for (const action of [(s: Session) => s.returnToGame(), (s: Session) => s.close(),
    (s: Session) => s.gameMessage(203, decode(encode({1:10,2:10,3:1})), decode(encode({}))),
    (s: Session) => s.gameMessage(206, decode(encode({})), decode(encode({}))),
    (s: Session) => s.gameMessage(303, decode(encode({1:0,2:1})), decode(encode({}))),
    (s: Session) => s.gameMessage(402, decode(encode({1:0,2:2,4:3})), decode(encode({}))),
    (s: Session) => s.gameMessage(501, decode(encode({1:0,6:5})), decode(encode({})))]) {
    const task = deferred(); let signal!: AbortSignal;
    const s = await foxSession(options => { signal = options.signal; return task.promise; });
    const done = s.estimateScore(); action(s);
    assert.equal(signal.aborted, true);
    task.resolve(reply(Array(361).fill(0))); await done;
    assert.equal(s.estimation, null); s.close();
  }
});

test('ownership decoding covers both winners and a zero-komi draw without extra preview screens', () => {
  const board = new Board();
  for (const [owner, sign] of [[1,1],[2,-1]]) {
    const estimate = decodeEstimate(reply(Array(361).fill(owner)), board, 7.5);
    assert.equal(Math.sign(estimate.lead), sign);
  }
  const balanced = [...Array(180).fill(1), 0, ...Array(180).fill(2)];
  assert.equal(decodeEstimate(reply(balanced), board, 0).lead, 0);
});

test('an aborted timeout shows a retryable error rather than a late success', async () => {
  const task = deferred();
  const s = await foxSession(({signal}) => {
    signal.addEventListener('abort', () => task.reject(Error('aborted')), {once:true});
    return task.promise;
  });
  const done = s.estimateScore();
  s.estimateController!.abort('timeout'); await done;
  assert.ok(s.estimation?.phase === 'error'); assert.match(s.estimation!.error,/timed out/);
  s.estimationFetcher = async () => reply(Array(361).fill(0));
  await s.estimateScore(); assert.equal(s.estimation!.phase,'result'); s.close();
});


test('opponent counting requests survive estimation, return, and accept or reject', async () => {
  for (const accept of [true, false]) {
    const s = new Session();
    try {
      await applyDevScreen(s, 'counting-request');
      const confirmation = structuredClone(s.pendingConfirmation);
      const board = structuredClone(s.board);
      await s.estimateScore();
      assert.equal(s.estimation!.phase, 'result');
      assert.deepEqual(s.pendingConfirmation, confirmation);
      s.returnToGame();
      assert.deepEqual(s.pendingConfirmation, confirmation);
      await s.estimateScore();
      s.confirm(accept);
      assert.equal(s.estimation, null);
      assert.equal(s.pendingConfirmation, null);
      assert.equal(s.countingAnswer!.accept, accept);
      assert.equal(s.pending, true);
      assert.deepEqual(structuredClone(s.board), board);
    } finally { s.close(); }
  }
});

test('estimation still waits for outgoing counting and counting results', async () => {
  for (const id of ['counting-waiting', 'counting-result']) {
    const s = new Session();
    try {
      await applyDevScreen(s, id);
      assert.throws(() => s.estimateScore(), /Finish the pending game action first/);
    } finally { s.close(); }
  }
});


test('estimate uses the optimistic move and survives confirmation, but clears on rejection', async () => {
  for (const rejected of [false, true]) {
    const s = new Session();
    try {
      await applyDevScreen(s, 'board-black');
      s.play(10, 10);
      let payload;
      s.estimationFetcher = async options => { payload = options.payload; return reply(Array(361).fill(0)); };
      await s.estimateScore();
      assert.deepEqual(payload, { status: s.board.stones.join('') });
      assert.equal(s.pending, true);
      assert.equal(s.snapshot().pendingMove, true);
      const {x, y, color} = s.pendingMove!;
      s.gameMessage(rejected ? 201 : 203, decode(encode(rejected ? {1: 7} : {1: x, 2: y, 3: color})), decode(encode({})));
      assert.equal(s.pending, false);
      assert.equal(s.estimation?.phase ?? null, rejected ? null : 'result');
    } finally { s.close(); }
  }
});
