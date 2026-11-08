import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'preact/compat';
import { renderToStaticMarkup } from 'preact/compat/server';
import { PlayerFlag } from '../src/PlayerInfo';
import { playerFlags } from '../src/player-flags';
import { Session } from '../src/session';
import { encodeFgwMessage } from '../src/game';
import { CLINET_MSG_ID, SVR_TYPE_USER_INFO_PANEL_SVR } from '../src/protocol';
import { applyPlayerSummary, type PlayerInfo } from '../src/player-info';
import { encode, decode, type Fields } from '../src/wire';

const message = (fields: Fields) => decode(encode(fields));

test('the prefetched account country reaches the pinned player and survives partial game updates', () => {
  const s = new Session();
  s.uid = 42; s.account = { name: 'Self', rank: '1d' };
  s.fgwConnection = { send() {}, close() {} };
  try {
    s.playerInfo.prefetch(42, 'Self', '1d');
    const summary = (fields: Fields) => s.onReceiveFgwMessage(s.generation, {
      msgTypeID: 0, flag: 0, rawProto: encodeFgwMessage(42, SVR_TYPE_USER_INFO_PANEL_SVR,
        CLINET_MSG_ID.MTID_FETCH_PANEL_USER_INFO, fields),
    });
    summary({ 3: 42, 2: 'player-1', 8: { 7: 86 } });
    assert.equal(s.snapshot().account?.country, 86);
    assert.equal(s.playerInfo.current, null, 'country loads without opening the player card');
    s.readGameUserInfo(message({ 1: 42, 3: 'Self', 6: 1 }));
    assert.equal(s.snapshot().account?.country, 86);
    s.readGameUserInfo(message({ 1: 42, 3: 'Self', 6: 1, 20: 81 }));
    s.playerInfo.prefetch(43, 'Opponent', '1d');
    summary({ 3: 43, 2: 'player-2', 8: { 7: 44 } });
    assert.equal(s.snapshot().account?.country, 81, 'another profile cannot restore a stale account country');
    s.playerInfo.invalidate();
    s.playerInfo.prefetch(42, 'Self', '1d');
    summary({ 3: 42, 2: 'player-3', 8: { 7: 0 } });
    assert.equal(s.snapshot().account?.country, 0, 'an explicit country removal is preserved');
  } finally { s.close(); }
});

test('country flags use embedded images and omit missing or unsupported countries', () => {
  for (const country of [86, 81, 82, 1, 44]) {
    const html = renderToStaticMarkup(createElement(PlayerFlag, { country }));
    assert.ok(html.includes(`src="${playerFlags[country].src}"`));
    assert.match(html, /src="data:image\/svg\+xml,/);
    assert.ok(html.includes(`title="${playerFlags[country].name}"`));
  }
  for (const country of [undefined, 0, 99999]) {
    assert.equal(renderToStaticMarkup(createElement(PlayerFlag, { country })), '');
  }
  for (const flag of Object.values(playerFlags)) {
    assert.equal(flag.width, 16);
    assert.equal(flag.height, 12);
    if (flag.src.startsWith('data:image/svg+xml,')) {
      const svg = decodeURIComponent(flag.src.slice('data:image/svg+xml,'.length));
      assert.match(svg, /<svg\b/);
      assert.match(svg, /viewBox="0 0 640 480"/);
    } else {
      const png = Buffer.from(flag.src.slice('data:image/png;base64,'.length), 'base64');
      assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(png.readUInt32BE(16), 48);
      assert.equal(png.readUInt32BE(20), 36);
    }
  }
});
