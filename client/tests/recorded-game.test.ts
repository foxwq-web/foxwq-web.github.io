import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSgf, fetchGameSgf } from '../src/sgf';
import { Controller } from '../src/controller';
import { reviewAvailable } from '../src/state';

const foxSgf = readFileSync(new URL('./fixtures/fox-history.sgf', import.meta.url), 'utf8');

test('Fox history records retain all moves and normalize Fox ranks and komi', () => {
  const record = parseSgf(foxSgf);
  assert.equal(record.board.moves.length, 12);
  assert.deepEqual(record.board.moves[0], [1, 15, 3]);
  assert.deepEqual(record.board.moves.at(-1), [2, 14, 13]);
  assert.equal(record.komi, 7.5);
  assert.equal(record.players[1].name, '拉依苏圣泉');
  assert.equal(record.players[2].rank, '4d');
  assert.deepEqual(record.board.timeControl, { main: 300, periods: 3, byoyomi: 30 });
  assert.equal(record.board.startedAt, Date.parse('2026-10-30') / 1000);
});

test('Fox archive records accept literal escaped line breaks between tokens', () => {
  const sgf = readFileSync(new URL('./fixtures/fox-escaped-newlines.sgf', import.meta.url), 'utf8');
  assert.ok(sgf.includes('\\r\\n'));
  const record = parseSgf(sgf);
  assert.equal(record.board.moves.length, 286);
  assert.deepEqual(record.board.moves[0], [1, 16, 3]);
  assert.equal(record.players[1].name, '终结者5');
  assert.equal(record.players[2].name, '七杀');
  assert.equal(record.result, 'W+R');
  assert.equal(record.komi, 7.5);
  assert.deepEqual(record, parseSgf(sgf.replaceAll('\\r\\n', '\r\n')));
});

test('escaped line break compatibility preserves escapes inside property values', () => {
  const record = parseSgf(String.raw`\r\n(;GM[1]\r\nSZ[19]PB[Black\r\nPlayer]PW[White\\r\\nPlayer]\r\n;B[dd]\r\n)\r\n`);
  assert.equal(record.players[1].name, 'BlackrnPlayer');
  assert.equal(record.players[2].name, String.raw`White\r\nPlayer`);
  assert.deepEqual(record.board.moves, [[1, 3, 3]]);
});

test('SGF main line handles escaped text, setup, captures, passes and clock properties', () => {
  const record = parseSgf(' ( ; GM[1]SZ[19]PB[A\\]B\\\\C]PW[White\\\nPlayer]BR[2级]KM[6.5]AB[aa:ab][ca]AW[ba]PL[W]TM[60]OT[3x30 byo-yomi]\n'
    + ';W[ss]WL[50](;B[bb]BL[25]OB[2]C[ignore ;B[pp\\] here];W[];B[tt])(;B[pp])) ');
  assert.equal(record.players[1].name, 'A]B\\C');
  assert.equal(record.players[2].name, 'WhitePlayer');
  assert.equal(record.players[1].rank, '2k');
  assert.equal(record.komi, 6.5);
  assert.deepEqual(record.board.moves, [[2, 18, 18], [1, 1, 1], [2, null, null], [1, null, null]]);
  assert.equal(record.initialBoard.stones[0], 1);
  assert.equal(record.initialBoard.stones[19], 1);
  assert.equal(record.initialBoard.turn, 2);
  assert.equal(record.board.stones[1], 0, 'white setup stone is captured');
  assert.equal(record.board.captures[1], 1);
  assert.deepEqual(record.board.moveTimings, [{ remaining: 50 }, { remaining: 25, periods: 2 }, null, null]);
});

test('deeply nested Fox analysis keeps the first variation without a recursion limit', () => {
  const depth = 12_000;
  const sgf = '(;SZ[19]' + '(;C[move]'.repeat(depth) + ';B[dd]'
    + ')'.repeat(depth) + '(;B[pp](;W[zz]))' + ')';
  const record = parseSgf(sgf);
  assert.deepEqual(record.board.moves, [[1, 3, 3]]);
  // Side variations are still checked for valid SGF structure.
  assert.throws(() => parseSgf(sgf.replace('W[zz]', 'W')), /invalid sgf record/);
});

test('Fox handicap setup in a separate node is retained throughout record review', async () => {
  const sgf = readFileSync(new URL('./fixtures/fox-handicap.sgf', import.meta.url), 'utf8');
  const record = parseSgf(sgf);
  const initial = new Array(19 * 19).fill(0);
  for (const [x, y] of [[15, 3], [3, 15], [3, 3]]) initial[y * 19 + x] = 1;
  assert.deepEqual(record.initialBoard.stones, initial);
  assert.equal(record.initialBoard.turn, 2);
  assert.equal(record.initialBoard.moves.length, 0);
  assert.deepEqual(record.board.moves[0], [2, 16, 16]);
  assert.equal(record.board.moves.length, 155);
  const c = new Controller();
  try {
    await c.initialize({ id: '1787297321010001239', sgf });
    c.review('first');
    assert.deepEqual(c.state.review?.stones, initial);
    assert.equal(c.state.review?.turn, 2);
    c.review('next');
    assert.equal(c.state.review?.stones[16 * 19 + 16], 2);
    c.review('last');
    assert.deepEqual(c.state.review?.stones, record.board.stones);
  } finally { c.dispose(); }
});

test('setup nodes before play apply additions, removals, ranges and turn overrides in order', () => {
  const record = parseSgf('(;SZ[19]HA[3]AB[aa];C[setup];AB[bb:bc]AW[cc];AE[aa]PL[B];B[dd])');
  assert.equal(record.initialBoard.stones[0], 0);
  assert.equal(record.initialBoard.stones[20], 1);
  assert.equal(record.initialBoard.stones[39], 1);
  assert.equal(record.initialBoard.stones[40], 2);
  assert.equal(record.initialBoard.turn, 1);
  assert.deepEqual(record.board.history[0], record.initialBoard.stones);
  const setupOnly = parseSgf('(;SZ[19];AB[dd];PL[W])');
  assert.equal(setupOnly.initialBoard.stones[60], 1);
  assert.equal(setupOnly.initialBoard.turn, 2);
  assert.equal(setupOnly.board.moves.length, 0);
});

test('invalid or unsupported records fail explicitly instead of showing an empty board', () => {
  for (const sgf of ['', '(;SZ[19];B[dd]', '(;C[unclosed)', '(;B[dd]) trailing', '(;B[zz])', '(;B[dd]W[pp])', '(;B[dd];W[dd])', '(;SZ[19]())', '(;SZ[19](;B[dd]);W[pp])'])
    assert.throws(() => parseSgf(sgf), Error, sgf);
  assert.throws(() => parseSgf('(;GM[2])'), /non-standard rules/);
  for (const size of [9, 11, 13])
    assert.throws(() => parseSgf(`(;SZ[${size}])`), { message: `${size}x${size} game` });
  for (const setup of ['AB[pp]', 'AW[pp]', 'AE[dd]', 'PL[B]']) {
    assert.throws(() => parseSgf(`(;B[dd];${setup})`), /unsupported changes/);
    assert.throws(() => parseSgf(`(;SZ[19];W[];${setup})`), /unsupported changes/);
    assert.throws(() => parseSgf(`(;SZ[19];B[dd]${setup})`), /unsupported changes/);
  }
});

test('record reviews replay from their initial setup and never send room moves', async () => {
  const c = new Controller();
  const sent: unknown[] = [];
  try {
    c.session.fgwConnection = { send: message => sent.push(message), close() {} };
    await c.initialize({ id: '1793333770030061788', sgf: '(;SZ[19]AB[dd]HA[2];W[pp];B[dp])' });
    assert.equal(reviewAvailable(c.state.session), true);
    assert.equal(c.state.session.gameId, '1793333770030061788');
    c.review('first');
    assert.equal(c.state.review?.moves, 0);
    assert.equal(c.state.review?.stones[3 * 19 + 3], 1);
    assert.equal(c.state.review?.turn, 2);
    c.review('next');
    assert.equal(c.state.review?.stones[15 * 19 + 15], 2);
    c.playVariation(4, 4);
    assert.equal(c.state.review?.variation?.moves.length, 1);
    assert.equal(c.session.board.moves.length, 2);
    c.review('main');
    assert.equal(c.state.review?.variation, undefined);
    c.review('last');
    assert.equal(c.state.review?.moves, 2);
    assert.deepEqual(sent, []);
  } finally { c.dispose(); }
});

test('archive downloads preserve the original SGF and stable record ID filename', async t => {
  const c = new Controller();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const files: string[] = [], blobs: Blob[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ download: '', click() { files.push(this.download); }, remove() {} }),
    body: { append() {} },
  } });
  t.mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => { blobs.push(blob as Blob); return 'blob:test'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await c.initialize({ id: '1793333770030061788', sgf: foxSgf });
    c.review('first');
    c.playVariation(3, 3);
    await c.save('sgf');
    await c.save('sgf');
    assert.deepEqual(files, ['1793333770030061788.sgf', '1793333770030061788.sgf']);
    for (const blob of blobs) assert.equal(await blob.text(), foxSgf);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
    c.dispose();
  }
});

test('record fetch preserves uint64 IDs and reports missing records and HTTP errors', async t => {
  const requests: string[] = [];
  const responses = [new Response(JSON.stringify({ result: 0, chess: foxSgf })),
    new Response('{}', { status: 503 }), new Response(JSON.stringify({ result: 1 })), new Response('null')];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => { requests.push(String(input)); return responses.shift()!; });
  assert.equal(await fetchGameSgf('1793333770030061788'), foxSgf);
  assert.match(requests[0], /chessid=1793333770030061788$/);
  await assert.rejects(fetchGameSgf('123'), /could not load game record/);
  await assert.rejects(fetchGameSgf('123'), /unavailable/);
  await assert.rejects(fetchGameSgf('123'), /unavailable/);
  await assert.rejects(fetchGameSgf('bad'), /invalid game record id/);
  assert.equal(requests.length, 4);
});

test('record reviews reject variants on join while keeping normal handicap Go', () => {
  for (const source of ['(;SZ[19]RL[2])', '(;SZ[19]RL[3])', '(;SZ[19]RL[4])', '(;SZ[19]RL[99])', '(;SZ[19]RU[Fly Cutter])'])
    assert.throws(() => parseSgf(source), /non-standard rules/);
  for (const rules of ['Chinese', 'Japanese', 'Korean', 'AGA', 'New Zealand', 'Tromp-Taylor']) {
    const record = parseSgf(`(;SZ[19]RU[${rules}]RL[0]HA[2]AB[dd][pp])`);
    assert.equal(record.initialBoard.stones.filter(stone => stone === 1).length, 2);
  }
});

test('archive controllers retain only SGF players and never start account services', async t => {
  const c = new Controller();
  t.mock.method(c.session.playerInfo, 'prefetch', () => assert.fail('No profile prefetch'));
  t.mock.method(c.session, 'sendFgwChannelMsg', () => assert.fail('No gateway traffic'));
  try {
    await c.initialize({ id: '123', loading: true });
    await c.initialize({ id: '123', sgf: foxSgf });
    assert.deepEqual(c.state.session.players, parseSgf(foxSgf).players);
    assert.equal(c.state.session.gatewayAvailable, false);
    assert.equal(c.state.session.playerInfo, null);
  } finally { c.dispose(); }
});
