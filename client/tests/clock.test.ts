import test from 'node:test';
import assert from 'node:assert/strict';
import { clockInputValue, clockReading, ByoyomiAnnouncements } from '../src/clock.ts';
import type { SessionState } from '../src/state.ts';
import type { Fields } from '../src/wire.ts';
import { Session } from '../src/session.ts';
import { encode, decode } from '../src/wire.ts';
import nativeTraces from './fixtures/native-countdown.json' with { type: 'json' };

test('native clock input values preserve seconds across minute and hour boundaries', () => {
  for (const [seconds, value] of [[0,'00:00:00'],[59,'00:00:59'],[60,'00:01:00'],[425,'00:07:05'],[3600,'01:00:00']] as const) {
    assert.equal(clockInputValue(seconds), value);
  }
});

test('Fox rounds elapsed time and keeps zero until the following tick', () => {
  const c = { at: 0, main: 5, periods: 3, byoyomi: 60 };
  assert.equal(clockReading(c, 4).main, 1);
  assert.deepEqual(clockReading(c, 5), { main: 0, periods: 3, seconds: 60, overtime: true });
  assert.equal(clockReading(c, 55).seconds, 10);
  assert.deepEqual(clockReading(c, 65), { main: 0, periods: 3, seconds: 0, overtime: true });
  assert.deepEqual(clockReading(c, 65.5), { main: 0, periods: 2, seconds: 60, overtime: true });
  assert.equal(clockReading({ at: 0, main: 0, periods: 2, byoyomi: 3 }, 3).seconds, 0);
  assert.equal(clockReading({ at: 0, main: 0, periods: 1, byoyomi: 3 }, 3.5).periods, 0);
  assert.equal(clockReading(c, 0.499).main, 5);
  assert.equal(clockReading(c, 0.5).main, 4);
});

test('clock ticks match traces executed from the original Fox x86 routines', () => {
  for (const trace of nativeTraces.cases) {
    const session = new Session();
    session.phase = 'playing';
    session.color = trace.own ? trace.color : 3 - trace.color;
    session.board.turn = trace.color;
    session.clocks[trace.color] = structuredClone(trace.initial);
    try {
      for (const expected of trace.ticks) {
        const time = expected.ms / 1000;
        session.tickClock(time);
        const clock = session.clocks[trace.color];
        const actual = clockReading(clock, time - clock.at, 60, trace.own);
        assert.deepEqual({ main: actual.main, seconds: actual.seconds, periods: actual.periods, atMs: clock.at * 1000 },
          { main: Math.max(0, expected.main), seconds: Math.max(0, expected.seconds), periods: expected.periods, atMs: expected.atMs },
          `${trace.name}, color ${trace.color}, own=${trace.own}, t=${expected.ms}`);
      }
    } finally { session.close(); }
  }
});

test('speaks 9 through 1 once per period, remaining periods, and stops on placing a move', () => {
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state: SessionState = { ...new Session().snapshot(),  phase: 'playing', color: 1, turn: 1, pending: false, moves: 0,
    clocks: { 1: { main: 0, periods: 3, byoyomi: 60, at: 0 } } };
  speaker.update(state, 49);
  speaker.update(state, 50); assert.deepEqual(sounds, []);
  for (let t = 51; t < 60; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, Array.from({ length: 9 }, (_, i) => `count-${9 - i}`));
  speaker.update(state, 60); speaker.update(state, 60.25);
  assert.equal(sounds.at(-1), 'count-1');
  speaker.update(state, 60.5);
  assert.equal(sounds.at(-1), 'periods-2'); assert.equal(sounds.length, 10);

  state.clocks[1] = { main: 0, periods: 2, byoyomi: 60, at: 60.5 };
  speaker.update(state, 60.75); assert.equal(sounds.length, 10);
  speaker.update(state, 110.5); assert.equal(sounds.at(-1), 'periods-2');
  speaker.update(state, 111); assert.equal(sounds.at(-1), 'count-9');
  speaker.update(state, 121); assert.equal(sounds.at(-1), 'periods-1');
  state.pending = true; speaker.update(state, 170); assert.equal(sounds.at(-1), 'periods-1');
  state.pending = false; state.turn = 2; speaker.update(state, 171); assert.equal(sounds.at(-1), 'periods-1');
});

test('main time stays silent, announces overtime once, and counts only in byoyomi', () => {
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state: SessionState = { ...new Session().snapshot(),  phase: 'playing', color: 1, turn: 1, pending: false, moves: 0,
    clocks: { 1: { main: 10, periods: 3, byoyomi: 60, at: 0 } } };

  for (let t = 0; t <= 60; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, ['byoyomi-start']);
  speaker.update(state, 61);
  assert.deepEqual(sounds, ['byoyomi-start', 'count-9']);

  speaker.reset(); sounds.length = 0;
  state.clocks[1] = { main: 10, periods: 3, byoyomi: 9, at: 0 };
  for (let t = 0; t < 9.5; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, []);
  speaker.update(state, 10);
  assert.deepEqual(sounds, ['byoyomi-start', 'count-9']);
});

test('overtime and remaining-period announcements survive turns and server corrections without repeating', () => {
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state: SessionState = { ...new Session().snapshot(), phase:'playing',gameId:'room-1',color:1,turn:1,pending:false,moves:0,
    clocks:{1:{main:2,periods:3,byoyomi:30,periodLength:30,at:0}}};
  speaker.update(state, 0); speaker.update(state, 2); speaker.update(state, 2.25);
  assert.deepEqual(sounds, ['byoyomi-start']);
  speaker.update(state, 32.5); assert.equal(sounds.at(-1), 'periods-2');
  state.pending = true; speaker.update(state, 33);
  state.pending = false; state.moves = 2;
  state.clocks[1] = {main:0,periods:2,byoyomi:30,periodLength:30,at:34};
  speaker.update(state, 34); assert.deepEqual(sounds, ['byoyomi-start','periods-2']);
  speaker.update(state, 64.5); assert.equal(sounds.at(-1), 'periods-1');
  state.clocks[1] = {main:0,periods:2,byoyomi:1,periodLength:30,at:64};
  speaker.update(state, 66); assert.equal(sounds.filter(s=>s==='periods-1').length, 1);
  state.gameId = 'room-2'; state.clocks[1] = {main:2,periods:3,byoyomi:30,periodLength:30,at:70};
  speaker.update(state, 70); speaker.update(state, 72);
  assert.equal(sounds.filter(s=>s==='byoyomi-start').length, 2);
});

test('reconnecting in overtime, opponents, and clocks without byoyomi do not announce overtime entry', () => {
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state: SessionState = { ...new Session().snapshot(), phase:'playing',color:1,turn:2,moves:0,pending:false,
    clocks:{1:{main:1,periods:3,byoyomi:60,at:0}}};
  speaker.update(state, 0); speaker.update(state, 20); assert.deepEqual(sounds, []);
  speaker.reset(); state.turn = 1; state.clocks[1].main = 0;
  speaker.update(state, 0); assert.deepEqual(sounds, []);
  speaker.reset(); state.clocks[1] = {main:1,periods:0,byoyomi:0,at:0};
  speaker.update(state, 0); speaker.update(state, 2); assert.deepEqual(sounds, []);
});

test('full initial-period notifications cannot rewind the countdown; moves and real corrections still apply', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  for (const color of [1, 2]) for (const op of [108, 109]) {
    context.mock.timers.setTime(0);
    const session = new Session();
    session.uid = 42; session.color = color; session.phase = 'playing'; session.board.turn = color;
    session.board.timeControl = { main: 0, periods: 3, byoyomi: 60 };
    session.clocks[color] = { main: 0, periods: 3, byoyomi: 60, periodLength: 60, at: 0 };
    try {
      context.mock.timers.tick(52000);
      const timing = { 2: 0, 3: 3, 4: 60, 5: 42 };
      const notice = (fields: Fields) => session.gameMessage(op, decode(encode(op === 109 ? { 2: fields } : fields)), decode(encode({})));
      notice(timing);
      assert.equal(session.clocks[color].byoyomi, 8, 'full-period notification clamps to displayed seconds');
      assert.equal(session.clocks[color].at, 52);
      notice({ ...timing, 4: 9 });
      assert.equal(session.clocks[color].byoyomi, 9, 'genuine server correction remains authoritative');
      notice({ ...timing, 3: 2 });
      assert.equal(session.clocks[color].byoyomi, 60, 'later-period reset is authoritative');
      session.clock(color, decode(encode(timing)));
      assert.equal(session.clocks[color].byoyomi, 60, 'move clock resets the period');
    } finally { session.close(); }
  }
});

test('Fox full-period sync guard preserves countdown voice cadence near the end', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  const session = new Session(), voices: { time: number; name: string }[] = [];
  const speaker = new ByoyomiAnnouncements(name => voices.push({ time: Date.now() / 1000, name }));
  session.uid = 42; session.color = 1; session.phase = 'playing';
  session.board.timeControl = { main: 0, periods: 3, byoyomi: 60 };
  session.clocks[1] = { main: 0, periods: 3, byoyomi: 60, periodLength: 60, at: 0 };
  function tick(ms: number) {
    context.mock.timers.setTime(ms); session.tickClock(); speaker.update(session.snapshot());
  }
  try {
    tick(50500); tick(51500);
    context.mock.timers.setTime(52100);
    session.gameMessage(108, decode(encode({ 2: 0, 3: 3, 4: 60, 5: 42 })), decode(encode({})));
    speaker.update(session.snapshot());
    assert.equal(clockReading(session.clocks[1]).seconds, 8);
    tick(52600);
    assert.deepEqual(voices, [
      { time: 50.5, name: 'count-9' }, { time: 51.5, name: 'count-8' },
      { time: 52.6, name: 'count-7' },
    ]);
  } finally { session.close(); }
});
