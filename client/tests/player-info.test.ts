import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PlayerInfoStore, applyPlayerSummary, type PlayerInfo } from '../src/player-info';
import { historyGames } from '../src/player-history';
import { encode, decode, type Fields } from '../src/wire';

const record = (id: string, uid = 42) => ({ chessid: id, blackuid: uid, whiteuid: 43,
  blackenname: 'River', whiteenname: 'Moon', whitedan: 19,
  gamestarttime: '1791872071', winner: 1, point: -1, reason: 3, movenum: 120 });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const config = () => ({ proxyUrl: 'wss://proxy.example/proxy', proxyToken: 'test-token', uid: 7, token: new Uint8Array([251, 255, 0, 1]) });

test('history uses the signed-in UID and base64 login token with the desktop signature', async () => {
  let requests = 0;
  const store = new PlayerInfoStore(() => {}, () => {}, config, async (input, init) => {
    requests++;
    const url = new URL(String(input)), query = url.searchParams;
    assert.equal(url.pathname, '/fox/chessbook/TXWQFetchChessList');
    assert.equal(query.get('uid'), '42');
    assert.equal(query.get('srcuid'), '7');
    assert.equal(query.get('token'), '+/8AAQ==');
    assert.ok(url.search.includes('token=%2B%2F8AAQ%3D%3D'));
    const time = query.get('time')!;
    assert.ok(Math.abs(Number(time) - Date.now() / 1000) < 2);
    assert.equal(query.get('session'), createHash('md5').update(`7${time}mD!VaWbS9uz6joCn0T8c`).digest('hex'));
    assert.equal(query.get('type'), '1');
    assert.equal(query.get('lastCode'), '');
    assert.equal(query.get('FindUserName'), '');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.cache, 'no-store');
    return Response.json({ result: 0, chesslist: [] });
  });
  try {
    const info = store.prefetch(42, 'River')!;
    await settle();
    assert.equal(info.error, '');
    assert.equal(info.loading, false);
    assert.equal(requests, 1);
  } finally { store.reset(); }
});

test('history never falls back to guest requests without a signed-in UID and token', async () => {
  for (const credentials of [{ uid: 0, token: new Uint8Array([1]) }, { uid: 7, token: new Uint8Array() }]) {
    const store = new PlayerInfoStore(() => {}, () => {}, () => ({ ...config(), ...credentials }),
      async () => assert.fail('Signed-out history must not reach Fox'));
    try {
      const info = store.prefetch(42, 'River')!;
      await settle();
      assert.equal(info.error, 'Sign in to load recent games.');
      assert.equal(info.loading, false);
    } finally { store.reset(); }
  }
});

test('native summary stays cached regardless of elapsed time until invalidation', async t => {
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const sent: Fields[] = [], calls: string[] = [];
  let finish!: (r: Response) => void;
  const store = new PlayerInfoStore(fields => { sent.push(fields); }, () => {}, config,
    async input => { calls.push(String(input)); return new Promise(r => { finish = r; }); });
  try {
    store.open(42, 'River', '1d');
    const info = store.current!;
    store.open(42, 'River');
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]).origin + new URL(calls[0]).pathname, 'https://proxy.example/fox/chessbook/TXWQFetchChessList');
    store.receive(decode(encode({ 1: 0, 2: 'stale', 3: 42 })));
    assert.equal(info.summaryLoading, true);
    store.receive(decode(encode({ 1: 0, 2: sent[0][3], 3: 42, 7: 19,
      8: { 5: 'River' }, 9: { 1: { 1: 9, 2: 13, 3: 10, 4: 0 }, 2: '-+--++' },
      16: [{ 1: 5, 2: 3, 3: 3 }, { 1: 0, 2: 9, 3: 16, 4: 0 }] })));
    assert.equal(info.summaryLoading, false);
    assert.equal(info.loading, true);
    assert.equal(info.rank, '2d');
    assert.equal(info.wins, 9);
    assert.equal(info.losses, 16);
    assert.equal(info.promotion, 9);
    assert.equal(info.demotion, 10);
    assert.equal(info.doubleDemotion, undefined);
    finish(Response.json({ result: 0, chesslist: [record('1791872071030044736')] }));
    await settle();
    assert.equal(info.loading, false);
    assert.equal(info.games[0].result, 'B+R');
    time += 24 * 60 * 60 * 1000;
    store.close(); store.open(42, 'River');
    assert.equal(store.current, info);
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 1);
    store.invalidate(); store.open(42, 'River');
    assert.equal(sent.length, 2);
    assert.equal(calls.length, 2);
    finish(Response.json({ result: 0, chesslist: [] })); await settle();
  } finally { store.reset(); }
});

test('switching players and resetting ignore stale native and HTTP completions', async () => {
  const sent: Fields[] = [];
  const signals: AbortSignal[] = [];
  const store = new PlayerInfoStore(fields => { sent.push(fields); }, () => {}, config,
    async (_input, init) => { signals.push(init!.signal!); return Response.json({ result: 0, chesslist: [] }); });
  store.open(42, 'River'); const first = store.current!;
  store.open(43, 'Moon'); const second = store.current!;
  store.receive(decode(encode({ 1: 0, 2: sent[0][3], 3: 42, 7: 20 })));
  assert.equal(first.summaryLoading, false);
  assert.equal(second.summaryLoading, true);
  assert.equal(store.current, second);
  store.receive(decode(encode({ 1: 0, 2: sent[1][3], 3: 42 })));
  assert.match(second.summaryError, /different player/);
  store.reset();
  assert.ok(signals.every(signal => signal.aborted));
  store.receive(decode(encode({ 1: 0, 2: sent[1][3], 3: 43 })));
  await settle();
  assert.equal(store.current, null);
});

test('history preserves 64-bit IDs, limits to 20 and decodes colors and endings without extra fetches', () => {
  const games = historyGames({ result: 0, chesslist: Array.from({ length: 25 }, (_, i) => ({
    ...record(String(1791872071030044736n + BigInt(i))), gamestarttime: String(1791872071 + i),
  })) }, 42);
  assert.equal(games.length, 20);
  assert.equal(games[0].id, '1791872071030044760');
  assert.equal(games[0].opponent, 'Moon');
  assert.equal(games[0].color, 'Black');
  assert.equal(games[0].outcome, 'win');
  assert.equal(games[0].moves, 120);
  const time = historyGames({ result: 0, chesslist: [{ ...record('1'), reason: 2, point: -2, winner: 2 }] }, 43)[0];
  assert.equal(time.result, 'W+T');
  assert.equal(time.color, 'White');
  assert.throws(() => historyGames({ result: 0, chesslist: [record('18446744073709551616')] }, 42), /identifier/);
  assert.throws(() => historyGames({ result: 1 }, 42), /Fox/);
  assert.throws(() => applyPlayerSummary({ uid: 42 } as PlayerInfo, decode(encode({ 1: 2 }))), /Fox/);
});

test('preload runs both reads before hover, deduplicates in-flight work and preserves cached results during refresh', async () => {
  const sent: Fields[] = [];
  let calls = 0, changes = 0;
  let finish!: (response: Response) => void;
  const store = new PlayerInfoStore(fields => { sent.push(fields); }, () => { changes++; }, config,
    async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  try {
    const info = store.prefetch(42, 'River')!;
    assert.equal(store.current, null);
    assert.equal(changes, 0);
    assert.equal(sent.length, 1);
    assert.equal(calls, 1); // HTTP started before the native response arrived.
    store.prefetch(42, 'River'); store.open(42, 'River', '', 'name');
    assert.equal(store.current, info);
    assert.equal(sent.length, 1);
    assert.equal(calls, 1);
    store.receive(decode(encode({ 1: 0, 2: sent[0][3], 3: 42, 9: { 2: '+-' } })));
    assert.equal(info.recent, '+-');
    assert.equal(info.loading, true); // Ranked results do not wait for games.
    finish(Response.json({ result: 0, chesslist: [record('1')] })); await settle();
    assert.equal(store.ready(42), true);
    store.invalidate(); store.prefetch(42, 'River');
    assert.equal(info.recent, '+-');
    assert.equal(info.games.length, 1);
    assert.equal(sent.length, 2);
    assert.equal(calls, 2);
    // Opening during the post-game refresh reuses both requests.
    store.open(42, 'River');
    assert.equal(sent.length, 2);
    assert.equal(calls, 2);
    finish(Response.json({ result: 0, chesslist: [] })); await settle();
  } finally { store.reset(); }
});

test('game-end invalidation replaces in-flight reads and ignores their late responses', async () => {
  const sent: Fields[] = [], finishes: ((response: Response) => void)[] = [], signals: AbortSignal[] = [];
  const store = new PlayerInfoStore(fields => { sent.push(fields); }, () => {}, config,
    async (_input, init) => {
      signals.push(init!.signal!);
      return new Promise(resolve => { finishes.push(resolve); });
    });
  try {
    const info = store.prefetch(42, 'River')!;
    store.invalidate();
    store.open(42, 'River');
    assert.equal(sent.length, 2);
    assert.equal(signals[0].aborted, true);
    store.receive(decode(encode({ 1: 0, 2: sent[0][3], 3: 42, 9: { 2: '-' } })));
    finishes[0](Response.json({ result: 0, chesslist: [record('1')] }));
    await settle();
    assert.equal(info.summaryLoading, true);
    assert.equal(info.loading, true);
    assert.equal(info.games.length, 0);
    store.receive(decode(encode({ 1: 0, 2: sent[1][3], 3: 42, 9: { 2: '+' } })));
    finishes[1](Response.json({ result: 0, chesslist: [record('2')] }));
    await settle();
    assert.equal(info.recent, '+');
    assert.equal(info.games[0].id, '2');
    assert.equal(store.ready(42), true);
  } finally { store.reset(); }
});

test('session preloads on room login and player discovery, refreshes after game end, and cancels queued work on close', async () => {
  const { Session } = await import('../src/session');
  const { envelope, unpack, GATEWAY, ROOM } = await import('../src/game');
  let calls = 0;
  const native: number[] = [];
  const session = new Session({ proxyUrl: 'wss://proxy.example/proxy', historyFetcher: async () => {
    calls++; return Response.json({ result: 0, chesslist: [] });
  } });
  session.uid = 42;
  session.token = encode({ 1: 'test' });
  session.account = { name: 'River', rank: '3d' };
  session.phase = 'gateway';
  session.gateway = { close() {}, send(command, payload) {
    const [header, body] = unpack(Buffer.from(payload));
    if (command === 26200 && header.number(7) === 20043) {
      native.push(body.number(1));
      queueMicrotask(() => session.receive(session.generation, { command: 26200, flags: 0,
        payload: envelope(42, 20043, 1001, { 1: 0, 2: body.text(3), 3: body.number(1), 9: { 2: '+-' } }),
      }));
    }
  } };
  try {
    session.receive(session.generation, { command: 26200, flags: 0, payload: envelope(42, GATEWAY, 1, { 1: 0 }) });
    await settle();
    assert.equal(calls, 0); // Wait for room login before preloading.
    session.receive(session.generation, { command: 26200, flags: 0, payload: envelope(42, ROOM, 100008, { 1: 0 }) });
    await settle();
    assert.deepEqual(native, [42]);
    assert.equal(calls, 1);
    assert.equal(session.phase, 'gateway'); // Discovery has not completed yet.
    assert.equal(session.playerInfo.current, null);
    session.phase = 'ready';
    session.fieldId = 1;
    session.match();
    session.playerInfo.open(42, 'River');
    assert.deepEqual(native, [42]);
    assert.equal(calls, 1); // Matchmaking keeps the prefetched account card.
    session.readPlayer(decode(encode({ 1: 43, 3: 'Moon', 4: 20, 6: 2 })));
    await settle();
    assert.deepEqual(native, [42, 43]);
    assert.equal(calls, 2);
    session.playerInfo.open(43, 'Moon');
    assert.equal(session.snapshot().playerInfo?.recent, '+-');
    assert.equal(calls, 2);
    session.phase = 'playing';
    session.gameMessage(402, decode(encode({ 2: 1, 3: -1, 4: 3 })), decode(encode()));
    await settle();
    assert.deepEqual(native, [42, 43, 42, 43]);
    assert.equal(calls, 4);
    session.leaveFinishedRoom();
    session.playerInfo.open(42, 'River');
    assert.equal(calls, 4); // Returning to matchmaking retains the refreshed card.
    session.match();
    session.playerInfo.open(42, 'River');
    assert.equal(calls, 4);
    session.readPlayer(decode(encode({ 1: 44, 3: 'Cloud', 6: 2 })));
    session.close(); await settle();
    assert.equal(calls, 4);
  } finally { session.close(); }
});


test('ranked results keep at most twenty games from the latest uninterrupted rank run', () => {
  const recent = (value: string) => {
    const info = { uid: 42, rank: '2d' } as PlayerInfo;
    applyPlayerSummary(info, decode(encode({ 1: 0, 3: 42, 7: 19, 9: { 2: value } })));
    return info.recent;
  };
  assert.equal(recent('+-'.repeat(15)), '+-'.repeat(10));
  assert.equal(recent('++++|--+-'), '--+-');
  assert.equal(recent('---|++|-=+'), '-=+');
  assert.equal(recent('++++|'), '');
  assert.equal(recent(''), '');
});
