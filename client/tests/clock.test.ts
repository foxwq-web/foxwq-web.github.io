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

test('own countdown speaks seconds and announces each local period rollover once', () => {
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state: SessionState = { ...new Session().snapshot(), phase: 'playing', color: 1, turn: 1, pending: false, moves: 0,
    clocks: { 1: { main: 0, periods: 3, byoyomi: 60, at: 0 } } };
  for (let t = 49; t < 60.5; t += 0.25) speaker.update(state, t);
  assert.deepEqual(sounds, Array.from({ length: 9 }, (_, i) => `count-${9 - i}`));
  speaker.update(state, 60.5);
  assert.equal(sounds.at(-1), 'periods-2');
  state.clocks[1] = { main: 0, periods: 2, byoyomi: 60, at: 60.5 };
  for (let t = 60.5; t < 121; t += 0.25) speaker.update(state, t);
  speaker.update(state, 121);
  assert.deepEqual(sounds.filter(name => name.startsWith('periods-')), ['periods-2', 'periods-1']);
  state.pending = true; speaker.update(state, 172);
  state.pending = false; state.turn = 2; speaker.update(state, 172);
  assert.equal(sounds.at(-1), 'periods-1');
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

test('native half-second cushion permits last-moment play and only own clocks roll over', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  for (const color of [1, 2]) {
    const session = new Session(), sounds: string[] = [];
    const speaker = new ByoyomiAnnouncements(name => sounds.push(name));
    session.color = color; session.phase = 'playing'; session.board.turn = color;
    session.clocks[color] = { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 };
    try {
      speaker.update(session.snapshot(), 0);
      for (const time of [30, 30.499]) {
        session.tickClock(time); speaker.update(session.snapshot(), time);
        assert.equal(session.clocks[color].periods, 3);
        assert.deepEqual(sounds, []);
      }
      // A stone submitted during zero freezes the player's clock before rollover.
      session.pending = true;
      assert.equal(session.tickClock(30.5), false);
      speaker.update(session.snapshot(), 30.5);
      assert.equal(session.clocks[color].periods, 3);
      assert.deepEqual(sounds, []);
      session.pending = false;
      session.tickClock(30.5); speaker.update(session.snapshot(), 30.5);
      speaker.update(session.snapshot(), 30.75);
      assert.equal(session.clocks[color].periods, 2);
      assert.deepEqual(sounds, ['periods-2']);
      const opponent = 3 - color;
      session.board.turn = opponent;
      session.clocks[opponent] = { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 };
      assert.equal(session.tickClock(300), false);
      assert.deepEqual(clockReading(session.clocks[opponent], 300, 60, false),
        { main: 0, periods: 3, seconds: 0, overtime: true });
      speaker.update(session.snapshot(), 300);
      assert.deepEqual(sounds, ['periods-2']);
      session.uid = 42;
      session.gameMessage(108, decode(encode({ 2: 0, 3: 2, 4: 30, 5: 43 })), decode(encode({})));
      assert.equal(session.clocks[opponent].periods, 2, 'opponent period changes only on server data');
    } finally { session.close(); }
  }
});

test('server updates can trigger own period voices and do not duplicate local rollover', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  for (const color of [1, 2]) for (const op of [108, 109]) {
    const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
    const session = new Session({ onSound: name => sounds.push(name) });
    session.uid = 42; session.color = color; session.phase = 'playing'; session.board.turn = color;
    session.clocks[color] = { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 };
    const notice = (periods: number) => {
      const timing = { 2: 0, 3: periods, 4: 30, 5: 42 };
      session.gameMessage(op, decode(encode(op === 109 ? { 2: timing } : timing)), decode(encode({})));
      speaker.update(session.snapshot());
    };
    try {
      context.mock.timers.setTime(0);
      notice(3); notice(2); notice(2);
      assert.deepEqual(sounds, ['periods-2']);
      context.mock.timers.setTime(30500);
      session.tickClock(); speaker.update(session.snapshot());
      notice(1); notice(1);
      assert.deepEqual(sounds, ['periods-2', 'periods-1']);
    } finally { session.close(); }
  }
});

test('native period voice window suppresses late updates and observes changes rather than lifetime deduplication', () => {
  const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
  const state: SessionState = { ...new Session().snapshot(), phase: 'playing', color: 1, turn: 1, pending: false,
    clocks: { 1: { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 } } };
  speaker.update(state, 0);
  state.clocks[1].periods = 2; state.clocks[1].byoyomi = 27;
  speaker.update(state, 0);
  assert.deepEqual(sounds, [], 'late period changes are silent');
  state.clocks[1].periods = 1; state.clocks[1].byoyomi = 28;
  speaker.update(state, 0); speaker.update(state, 0);
  assert.deepEqual(sounds, ['periods-1'], 'two-second boundary is included');
  state.clocks[1].periods = 2; state.clocks[1].byoyomi = 30;
  speaker.update(state, 0);
  state.clocks[1].periods = 1;
  speaker.update(state, 0);
  assert.deepEqual(sounds, ['periods-1', 'periods-2', 'periods-1']);
});

test('initial overtime readings, inactive transitions, reconnects, and new games establish silent baselines', () => {
  for (const blocked of ['pending', 'counting', 'confirmation', 'opponent-turn'] as const) {
    const sounds: string[] = [], speaker = new ByoyomiAnnouncements(name => sounds.push(name));
    const state: SessionState = { ...new Session().snapshot(), phase: 'playing', gameId: 'room-1', color: 1, turn: 1, pending: false,
      clocks: { 1: { main: 0, periods: 3, byoyomi: 30, periodLength: 30, at: 0 } } };
    speaker.update(state, 0);
    if (blocked === 'opponent-turn') state.turn = 2;
    else state[blocked] = true;
    state.clocks[1].periods = 2;
    speaker.update(state, 0);
    state.turn = 1; state.pending = state.counting = state.confirmation = false;
    speaker.update(state, 0);
    assert.deepEqual(sounds, [], blocked);
    state.phase = 'reconnecting'; speaker.update(state, 0);
    state.phase = 'playing'; state.clocks[1].periods = 1; speaker.update(state, 0);
    assert.deepEqual(sounds, [], 'restored last-period baseline');
    state.gameId = 'room-2'; state.clocks[1].periods = 2; speaker.update(state, 0);
    state.clocks[1].periods = 1; speaker.update(state, 0);
    assert.deepEqual(sounds, ['periods-1'], 'new game starts a new baseline');
  }
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

test('counting freezes the current reading and resumes without charging the waiting time', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  for (const own of [true, false]) for (const main of [0, 120]) {
    for (const exit of ['request-failed', 'rejected', 'answer-rejected', 'resume']) {
      if (!own && exit === 'request-failed') continue;
      context.mock.timers.setTime(0);
      const session = new Session();
      session.phase = 'playing'; session.color = 1; session.uid = 42;
      session.board.turn = own ? 1 : 2;
      session.roomKey = { 1: 31000, 2: 63, 3: 23, 4: 202 };
      session.gateway = { send() {}, close() {} };
      const color = session.board.turn;
      session.clocks[color] = { main, periods: 3, byoyomi: 30, periodLength: 30, at: 0 };
      const notify = (op: number, fields: Fields) =>
        session.gameMessage(op, decode(encode(fields)), decode(encode({})));
      try {
        context.mock.timers.tick(7000);
        const before = clockReading(session.clocks[color], 7, 60, own);
        if (own) session.requestCounting();
        else notify(303, { 1: 0, 2: 1 });
        assert.deepEqual(clockReading(session.clocks[color], 0, 60, own), before);
        if (exit !== 'request-failed' && own) notify(301, { 1: 0 });
        context.mock.timers.tick(90000);
        assert.equal(session.tickClock(), false);
        assert.deepEqual(clockReading(session.clocks[color], 0, 60, own), before);
        if (exit === 'request-failed') notify(301, { 1: -1 });
        if (exit === 'rejected') notify(306, { 1: false, 2: 1 });
        if (exit === 'answer-rejected') {
          notify(303, { 1: 0, 2: 1 });
          session.confirm(false);
          notify(304, { 1: 0 });
        }
        if (exit === 'resume') notify(109, { 2: {
          2: before.main, 3: before.periods, 4: before.seconds, 5: own ? 42 : 43,
        } });
        assert.equal(session.counting, false);
        assert.deepEqual(clockReading(session.clocks[color], 0, 60, own), before);
        context.mock.timers.tick(2000);
        const after = clockReading(session.clocks[color], Date.now() / 1000 - session.clocks[color].at, 60, own);
        assert.equal(main ? after.main : after.seconds, (main ? before.main : before.seconds) - 2);
        assert.equal(after.periods, 3);
      } finally { session.close(); }
    }
  }
});
