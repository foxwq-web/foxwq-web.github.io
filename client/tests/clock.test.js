import test from 'node:test';
import assert from 'node:assert/strict';
import { clockInputValue, clockReading, ByoyomiAnnouncements } from '../src/clock.ts';

test('native clock input values preserve seconds across minute and hour boundaries', () => {
  for (const [seconds, value] of [[0,'00:00:00'],[59,'00:00:59'],[60,'00:01:00'],[425,'00:07:05'],[3600,'01:00:00']]) {
    assert.equal(clockInputValue(seconds), value);
  }
});

test('main time transitions to byoyomi, periods expire and the last period reaches zero', () => {
  const c = { main: 5, periods: 3, byoyomi: 60 };
  assert.equal(clockReading(c, 4).main, 1);
  assert.deepEqual(clockReading(c, 5), { main: 0, periods: 3, seconds: 60, overtime: true });
  assert.equal(clockReading(c, 55).seconds, 10);
  assert.deepEqual(clockReading(c, 65), { main: 0, periods: 2, seconds: 60, overtime: true });
  assert.equal(clockReading(c, 125).periods, 1);
  assert.equal(clockReading(c, 185).seconds, 0);
  assert.equal(clockReading({ main: 0, periods: 2, byoyomi: 3 }, 3).seconds, 60);
});

test('speaks 9 through 1 once per period, remaining periods, and stops on placing a move', () => {
  const sounds = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state = { phase: 'playing', color: 1, turn: 1, pending: false, moves: 0,
    clocks: { 1: { main: 0, periods: 3, byoyomi: 60, at: 0 } } };
  speaker.update(state, 49);
  speaker.update(state, 50); assert.deepEqual(sounds, []);
  for (let t = 51; t < 60; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, Array.from({ length: 9 }, (_, i) => `count-${9 - i}`));
  speaker.update(state, 60); speaker.update(state, 60.25);
  assert.equal(sounds.at(-1), 'periods-2'); assert.equal(sounds.length, 10);

  state.clocks[1] = { main: 0, periods: 2, byoyomi: 60, at: 60 };
  speaker.update(state, 60.5); assert.equal(sounds.length, 10);
  speaker.update(state, 110); assert.equal(sounds.at(-1), 'periods-2');
  speaker.update(state, 111); assert.equal(sounds.at(-1), 'count-9');
  speaker.update(state, 120); assert.equal(sounds.at(-1), 'periods-1');
  state.pending = true; speaker.update(state, 170); assert.equal(sounds.at(-1), 'periods-1');
  state.pending = false; state.turn = 2; speaker.update(state, 171); assert.equal(sounds.at(-1), 'periods-1');
});

test('main time stays silent, announces overtime once, and counts only in byoyomi', () => {
  const sounds = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state = { phase: 'playing', color: 1, turn: 1, pending: false, moves: 0,
    clocks: { 1: { main: 10, periods: 3, byoyomi: 60, at: 0 } } };

  for (let t = 0; t <= 60; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, ['byoyomi-start']);
  speaker.update(state, 61);
  assert.deepEqual(sounds, ['byoyomi-start', 'count-9']);

  speaker.reset(); sounds.length = 0;
  state.clocks[1] = { main: 10, periods: 3, byoyomi: 9, at: 0 };
  for (let t = 0; t < 10; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, []);
  speaker.update(state, 10);
  assert.deepEqual(sounds, ['byoyomi-start', 'count-9']);
});

test('overtime and remaining-period announcements survive turns and server corrections without repeating', () => {
  const sounds = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state = {phase:'playing',gameId:'room-1',color:1,turn:1,pending:false,moves:0,
    clocks:{1:{main:2,periods:3,byoyomi:30,periodLength:30,at:0}}};
  speaker.update(state, 0); speaker.update(state, 2); speaker.update(state, 2.25);
  assert.deepEqual(sounds, ['byoyomi-start']);
  speaker.update(state, 32); assert.equal(sounds.at(-1), 'periods-2');
  state.pending = true; speaker.update(state, 33);
  state.pending = false; state.moves = 2;
  state.clocks[1] = {main:0,periods:2,byoyomi:30,periodLength:30,at:34};
  speaker.update(state, 34); assert.deepEqual(sounds, ['byoyomi-start','periods-2']);
  speaker.update(state, 64); assert.equal(sounds.at(-1), 'periods-1');
  state.clocks[1] = {main:0,periods:2,byoyomi:1,periodLength:30,at:64};
  speaker.update(state, 66); assert.equal(sounds.filter(s=>s==='periods-1').length, 1);
  state.gameId = 'room-2'; state.clocks[1] = {main:2,periods:3,byoyomi:30,periodLength:30,at:70};
  speaker.update(state, 70); speaker.update(state, 72);
  assert.equal(sounds.filter(s=>s==='byoyomi-start').length, 2);
});

test('reconnecting in overtime, opponents, and clocks without byoyomi do not announce overtime entry', () => {
  const sounds = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state = {phase:'playing',color:1,turn:2,moves:0,pending:false,
    clocks:{1:{main:1,periods:3,byoyomi:60,at:0}}};
  speaker.update(state, 0); speaker.update(state, 20); assert.deepEqual(sounds, []);
  speaker.reset(); state.turn = 1; state.clocks[1].main = 0;
  speaker.update(state, 0); assert.deepEqual(sounds, []);
  speaker.reset(); state.clocks[1] = {main:1,periods:0,byoyomi:0,at:0};
  speaker.update(state, 0); speaker.update(state, 2); assert.deepEqual(sounds, []);
});
