import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'preact/compat';
import { renderToStaticMarkup } from 'preact/compat/server';
import { Session } from '../src/session';
import { encode, decode } from '../src/wire';
import { PlayerName } from '../src/PlayerInfo';
import type { Controller } from '../src/controller';
import { historyGames } from '../src/player-history';

const message = (fields: Parameters<typeof encode>[0]) => decode(encode(fields));
test('AI identities from game messages reach shared player names', () => {
  const s = new Session();
  try {
    s.readGameUserInfo(message({ 1: 42, 3: 'Robot', 4: 26, 6: 1, 38: 1 }));
    s.readGameUserInfo(message({ 1: 43, 3: 'Human', 4: 26, 6: 2, 24: 0 }));
    const controller = { session: s, state: { session: s.snapshot() } } as Controller;
    assert.match(renderToStaticMarkup(createElement(PlayerName, { controller, uid: 42, name: 'Robot', rank: '9d' })).replace(/<[^>]*>/g, ''), /Robot AI 9d/);
    assert.equal(s.players[1].name, 'Robot', 'display labels do not alter identity or SGF names');
    s.readGameUserInfo(message({ 1: 42, 3: 'Robot', 6: 1 }));
    assert.ok(s.playerInfo.isAI(42), 'partial messages preserve known AI status');
    s.readGameUserInfo(message({ 1: 42, 3: 'Robot', 6: 1, 24: 0, 38: 0 }));
    assert.equal(s.playerInfo.isAI(42), false, 'explicit corrections remove the label');
    s.readGameUserInfo(message({ 1: 42, 3: 'Robot', 6: 1, 24: 1 }));
    assert.ok(s.playerInfo.isAI(42), 'legacy AI certification also marks game players');
  } finally { s.close(); }
});

test('profile AI certification updates cached identities and missing flags preserve them', () => {
  const s = new Session();
  s.fgwConnection = { send() {}, close() {} };
  try {
    const info = s.playerInfo.prefetch(42, 'Robot')!;
    s.playerInfo.receive(message({ 1: 0, 2: 'player-1', 3: 42, 14: { 2: 1 } }));
    assert.equal(info.ai, true);
    assert.deepEqual(s.snapshot().aiPlayers, [42]);
    s.playerInfo.invalidate();
    s.playerInfo.prefetch(42, 'Robot');
    s.playerInfo.receive(message({ 1: 0, 2: 'player-2', 3: 42 }));
    assert.ok(s.playerInfo.isAI(42));
    s.playerInfo.invalidate();
    s.playerInfo.prefetch(42, 'Robot');
    s.playerInfo.receive(message({ 1: 0, 2: 'player-3', 3: 42, 14: { 2: 0 } }));
    assert.equal(s.playerInfo.isAI(42), false);
    s.playerInfo.rememberAI(42, true);
    s.playerInfo.reset();
    assert.deepEqual(s.playerInfo.aiPlayers, []);
  } finally { s.close(); }
});

test('history preserves opponent IDs to share known AI labels without guessing from names', () => {
  const games = historyGames({ result: 0, chesslist: [{ chessid: '123', blackuid: 42, whiteuid: 43,
    whiteenname: 'Robot', whitedan: 26, gamestarttime: 1791872071, winner: 1, reason: 3, point: -1 }] }, 42);
  assert.equal(games[0].opponentId, 43);
  assert.equal(games[0].opponent, 'Robot');
});
