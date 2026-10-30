import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/board.ts';
import { Session } from '../src/session.ts';
import { DEV_SCREENS, applyDevScreen } from '../src/dev-screens.ts';
import { COUNTING_PREVIEW } from '../src/dev-counting.ts';

test('playing previews include AlphaGo move 37 and preserve the player’s turn', async () => {
  for (const [id, color, moveCount] of [['board-white', 2, 37], ['board-black', 1, 38]] as const) {
    const session = new Session();
    try {
      await applyDevScreen(session, id);
      assert.equal(session.board.moves.length, moveCount);
      assert.deepEqual(session.board.moves[36], [1, 14, 9]); // P10, move 37.
      assert.equal(session.board.stones[9 * 19 + 14], 1);
      assert.equal(session.board.stones[8 * 19 + 14], color === 1 ? 2 : 0); // P11, reply 38.
      assert.equal(session.color, color);
      assert.equal(session.board.turn, color);
      assert.equal(session.pending, false);
    } finally { session.close(); }
  }
});

test('offline player cards load recent games for the requested player', async () => {
  const session = new Session();
  try {
    await applyDevScreen(session, 'board-black');
    for (const [uid, name, rank, wins, losses, result, color, moves, id, opponent, opponentRank] of [
      [531127799, '黑白双杀29', '2d', 427, 407, 'W+T', 'Black', 166, '1793308330030064800', 'products', '3d'],
      [533702962, '拉依苏圣泉', '4d', 157, 43, 'W+F', 'Black', 12, '1793333770030061788', '风往北吹11', '4d'],
    ] as const) {
      session.playerInfo.open(uid, name);
      await new Promise(resolve => setImmediate(resolve));
      const info = session.playerInfo.current!;
      assert.equal(info.loading, false);
      assert.equal(info.error, '');
      assert.equal(info.summaryError, '');
      assert.equal(info.name, name);
      assert.equal(info.rank, rank);
      assert.equal(info.wins, wins);
      assert.equal(info.losses, losses);
      assert.equal(info.games.length, 20);
      assert.equal(info.games[0].id, id);
      assert.equal(info.games[0].result, result);
      assert.equal(info.games[0].color, color);
      assert.equal(info.games[0].moves, moves);
      assert.equal(info.games[0].opponent, opponent);
      assert.equal(info.games[0].opponentRank, opponentRank);
    }
  } finally { session.close(); }
});

test('all offline fixtures cover session phases, have valid histories and forbid real login', async () => {
  assert.equal(new Set(DEV_SCREENS.map(screen => screen.id)).size, DEV_SCREENS.length);
  assert.deepEqual(new Set(DEV_SCREENS.map(screen => screen.phase)), new Set([
    'disconnected','connecting','authenticating','bootstrap','gateway','resuming',
    'error','ready','matching','joining','playing','finished'
  ]));
  for (const fixture of DEV_SCREENS) {
    const session = new Session({ connectionFactory() { assert.fail('Opened real transport'); } });
    const preview = await applyDevScreen(session, fixture.id);
    assert.ok(fixture.group && fixture.reach, fixture.id);
    assert.ok(preview, fixture.id);
    if (preview.prompt) assert.ok('title' in preview.prompt, fixture.id);
    assert.equal(session.snapshot().phase, fixture.phase, fixture.id);
    assert.throws(() => session.login('user', 'password'), /Offline preview/, fixture.id);
    const replay = new Board();
    for (const [color, x, y] of session.board.moves) {
      if (x === null) replay.passTurn(color); else replay.play(x, y!, color);
    }
    assert.deepEqual(replay.stones, session.board.stones, fixture.id);
    assert.deepEqual(replay.captures, session.board.captures, fixture.id);
    session.close();
  }
});

test('counting preview uses the estimator map for its exact board and consistent area totals', async () => {
  const session = new Session();
  try {
    await applyDevScreen(session, 'counting-result');
    assert.equal(session.board.stones.join(''), COUNTING_PREVIEW.stones);
    const result = session.snapshot().countingResult!;
    assert.equal(result.ownership!.join(''), COUNTING_PREVIEW.ownership);
    const areas = [0, 0, 0];
    result.ownership!.forEach((owner, p) => areas[owner || session.board.stones[p]]++);
    assert.deepEqual(areas, [158, 122, 81]);
    assert.equal(result.black, areas[1] + areas[0] / 2);
    assert.equal(result.white, areas[2] + areas[0] / 2);
    assert.equal(result.black! - result.white! - result.komi!, COUNTING_PREVIEW.margin);
    assert.equal(result.winner, 'Black wins');
  } finally { session.close(); }
});

test('counting previews accept and reject offline through real session commands', async () => {
  for (const id of ['counting-request','counting-result']) for (const accept of [true,false]) {
    const session = new Session();
    await applyDevScreen(session, id);
    session.confirm(accept);
    assert.equal(session.pending, true);
    assert.equal(session.pendingConfirmation, null);
    assert.equal(session.countingAnswer!.accept, accept);
    session.close();
  }
});

test('unknown preview names leave the normal login untouched', async () => {
  const session = new Session(), before = session.snapshot(), login = session.login;
  assert.equal(await applyDevScreen(session, 'unknown'), null);
  assert.deepEqual(session.snapshot(), before);
  assert.equal(session.login, login);
});


test('previews preserve real pending, acknowledgement, rollback and pass semantics', async () => {
  const sessions: Record<string, Session> = {};
  try {
    for (const id of ['board-black', 'move-pending', 'action-rejected', 'pass-pending',
      'opponent-passed', 'both-passed', 'counting-pending', 'counting-waiting',
      'counting-answer-pending', 'counting-accepted']) {
      const session = sessions[id] = new Session();
      const recipes: Partial<Record<string, (s: Session) => void>> = {
        'move-pending': s => s.play(10, 10),
        'pass-pending': s => s.passTurn(),
        'counting-pending': s => s.requestCounting(),
        'counting-answer-pending': s => s.confirm(true),
      };
      const recipe = recipes[id];
      await applyDevScreen(session, recipe
        ? id === 'counting-answer-pending' ? 'counting-request' : 'board-black'
        : id);
      recipe?.(session);
    }
    assert.equal(sessions['move-pending'].board.moves.length, sessions['board-black'].board.moves.length + 1);
    assert.deepEqual(sessions['move-pending'].pendingMove!.board.stones, sessions['board-black'].board.stones);
    assert.deepEqual(sessions['action-rejected'].board.stones, sessions['board-black'].board.stones);
    assert.equal(sessions['action-rejected'].pendingMove, null);
    assert.equal(sessions['action-rejected'].pending, false);
    assert.equal(sessions['pass-pending'].board.passes, 0);
    assert.equal(sessions['pass-pending'].pending, true);
    assert.equal(sessions['opponent-passed'].board.passes, 1);
    assert.equal(sessions['both-passed'].board.passes, 2);
    assert.equal(sessions['counting-pending'].pending, true);
    assert.equal(sessions['counting-waiting'].pending, false);
    assert.equal(sessions['counting-waiting'].counting, true);
    assert.equal(sessions['counting-answer-pending'].countingAnswer!.accept, true);
    assert.equal(sessions['counting-accepted'].pending, false);
    assert.equal(sessions['counting-accepted'].countingAnswer, null);
  } finally {
    Object.values(sessions).forEach(session => session.close());
  }
});

test('final results come from complete game flows', async () => {
  for (const [id, result] of [['finished','B+33.5'], ['finished-resign','W+R'], ['finished-void','Void']]) {
    const session = new Session();
    try {
      await applyDevScreen(session, id);
      assert.equal(session.result, result);
      assert.equal(session.gameOver, true);
      assert.equal(session.pendingConfirmation, null);
      assert.equal(session.counting, false);
      assert.match(session.board.sgf(session.result), /RE\[/);
    } finally { session.close(); }
  }
});
