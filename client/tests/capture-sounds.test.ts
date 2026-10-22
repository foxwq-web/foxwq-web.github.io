import { setupFoxGame } from './fox-game.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/board.ts';
import { Session } from '../src/session.ts';
import { placementSound, FoxSounds, bindAudioUnlock } from '../src/sound.ts';
import { encode, decode } from '../src/wire.ts';



function captureBoard(count: number, color = 1) {
  const board = new Board(); board.turn = color; board.captures[color] = 100;
  for (let x = 1; x <= count; x++) {
    board.stones[19 + x] = 3 - color;
    board.stones[x] = color;
    if (x !== 1) board.stones[38 + x] = color;
  }
  if (count) { board.stones[19] = color; board.stones[20 + count] = color; }
  return board;
}

const cases = [[0, 'stone'], [1, 'stone-capture-small'], [2, 'stone-capture-small'],
  [3, 'stone-capture-medium'], [15, 'stone-capture-medium'], [16, 'stone-capture-large'], [17, 'stone-capture-large']] as const;

test('Fox sound thresholds use captures in this move for own and opponent moves of either color', () => {
  for (const [count, expected] of cases) for (const color of [1, 2]) for (const mode of ['own', 'opponent']) {
    const sounds: string[] = [], session = new Session({ onSound: name => sounds.push(name) });
    session.phase = 'playing';
    session.board = captureBoard(count, color);
    session.color = mode === 'opponent' ? 3 - color : color;
    session.roomKey = { 1: 31000, 2: 63 }; session.gateway = { send() {}, close() {} };
    const move = decode(encode({ 1: 1, 2: 2, 3: color }));
    if (mode === 'opponent') session.gameMessage(203, move, decode(encode({})));
    else session.play(1, 2);
    assert.equal(session.board.captures[color], 100 + count, `${count}/${color}/${mode}`);
    assert.deepEqual(sounds, [expected]);
    if (mode === 'own') {
      session.gameMessage(203, move, decode(encode({})));
      assert.equal(session.pending, false); assert.deepEqual(sounds, [expected]);
    }
    session.close();
  }
  assert.equal(placementSound(361), 'stone-capture-large');
});

test('one move capturing several separate groups selects by their combined size', () => {
  const board = new Board(5);
  for (const [x, y] of [[2,0],[1,1],[3,1],[0,2],[4,2],[1,3],[3,3],[2,4]]) board.play(x,y,1);
  for (const [x, y] of [[2,1],[1,2],[3,2],[2,3]]) board.play(x,y,2);
  const sounds: string[] = [], session = new Session({ onSound: name => sounds.push(name) });
  setupFoxGame(session); session.board = board; session.play(2,2);
  assert.equal(session.board.captures[1], 4); assert.deepEqual(sounds, ['stone-capture-medium']); session.close();
});

test('an authoritative replacement selects after rollback; synchronized replay is silent', () => {
  const sounds: string[] = [], session = new Session({ onSound: name => sounds.push(name) });
  session.board = captureBoard(3); session.phase = 'playing'; session.color = 1; session.uid = 42;
  session.roomKey = { 1: 31000, 2: 63 }; session.gateway = { send() {}, close() {} };
  session.play(10, 10); assert.deepEqual(sounds, ['stone']);
  session.gameMessage(203, decode(encode({ 1: 1, 2: 2, 3: 1 })), decode(encode({})));
  assert.equal(session.board.stones[200], 0); assert.equal(session.board.captures[1], 103);
  assert.deepEqual(sounds, ['stone', 'stone-capture-medium']);

  const moves = [[1,1,0],[1,0,1],[1,2,1],[2,1,1],[1,1,2]];
  session.gameMessage(501, decode(encode({ 1: 0, 3: [{ 1: 42, 6: 1 }],
    4: moves.map(([color,x,y]) => ({ 1:1, 2:x, 3:y, 4:color })), 5:{1:5}, 12:31000, 13:63 })), decode(encode({})));
  assert.equal(session.board.captures[1], 1); assert.deepEqual(sounds, ['stone', 'stone-capture-medium']); session.close();
});

test('rejected or unsent capturing moves do not add playback or leave captures behind', () => {
  for (const count of [3, 16]) {
    const sounds: string[] = [], session = new Session({ onSound: name => sounds.push(name) });
    session.board = captureBoard(count); session.phase = 'playing'; session.color = 1;
    session.roomKey = { 1: 31000, 2: 63 }; session.gateway = { send() { throw Error('closed'); }, close() {} };
    const before = session.board.clone();
    assert.throws(() => session.play(1,2), /closed/); assert.deepEqual(session.board,before); assert.deepEqual(sounds,[]);
    session.gateway.send = () => {}; session.play(1,2);
    session.gameMessage(201, decode(encode({1:7})), decode(encode({})));
    assert.deepEqual(session.board,before); assert.deepEqual(sounds,[placementSound(count)]);
    session.close();
  }
});

test('capture effects overlap each other and never replace or stop voice announcements', () => {
  const started: (AudioBuffer | null)[] = [], stopped: (AudioBuffer | null)[] = [];
  const audio = Object.assign(Object.create(FoxSounds.prototype) as FoxSounds, {
    context: { state: 'running', createBufferSource() {
      return { buffer: null as AudioBuffer | null, connect(output: unknown) { assert.equal(output, audio.output); },
        start() { started.push(this.buffer); }, stop() { stopped.push(this.buffer); } };
    } }, output: {}, buffers: new Map(['start-play', 'count-9', ...cases.map(([,name]) => name)].map(name => [name,name]))
  });
  audio.play('start-play'); const voice = audio.voice;
  for (const name of ['stone', 'stone-capture-small', 'stone-capture-medium', 'stone-capture-large']) {
    audio.play(name); assert.equal(audio.voice,voice); assert.equal(audio.voiceName,'start-play');
  }
  audio.play('count-9'); assert.deepEqual(stopped,[]); assert.equal(started.length,5);
  audio.stopVoice(); assert.deepEqual(stopped,['start-play']);
  assert.equal(started.filter(name => String(name).startsWith('stone-capture-')).length,3);
});

function suspendedSounds() {
  const audio = new FoxSounds({ muted: true }), started: (AudioBuffer | null)[] = [];
  let finishResume!: () => void, failResume!: (reason: Error) => void, resumeCalls = 0;
  const resumed = new Promise<void>((resolve, reject) => { finishResume = resolve; failResume = reject; });
  audio.output = { gain: { value: 0 } } as GainNode;
  const context = {
    state: 'suspended', currentTime: 0,
    resume() { resumeCalls++; return resumed; },
    createBufferSource() {
      return { buffer: null as AudioBuffer | null, connect(output: unknown) { assert.equal(output, audio.output); },
        start() { started.push(this.buffer); }, stop() {} };
    }
  };
  audio.context = context as unknown as AudioContext;
  audio.buffers = new Map(['stone', 'stone-capture-small', 'start-play', 'count-9', 'count-8']
    .map(name => [name, name as unknown as AudioBuffer]));
  return { audio, context, started, resumeCalls: () => resumeCalls,
    finish() { context.state = 'running'; finishResume(); },
    fail() { failResume(new Error('Audio interrupted')); } };
}

const flushAudio = () => new Promise<void>(resolve => setImmediate(resolve));

test('touch completion and clicks unlock audio and are removed on cleanup', () => {
  const target = new EventTarget();
  let unlocks = 0;
  const unbind = bindAudioUnlock({ unlock() { unlocks++; } }, target);
  for (const event of ['pointerdown', 'touchend', 'click', 'keydown']) target.dispatchEvent(new Event(event));
  assert.equal(unlocks, 4);
  unbind();
  for (const event of ['pointerdown', 'touchend', 'click', 'keydown']) target.dispatchEvent(new Event(event));
  assert.equal(unlocks, 4);
});

test('a real gesture retries an autoplay-blocked resume instead of sharing it', async () => {
  const s = suspendedSounds();
  s.audio.play('stone');
  assert.equal(s.resumeCalls(), 1);
  s.audio.unlock();
  assert.equal(s.resumeCalls(), 2);
  s.finish(); await flushAudio();
  assert.deepEqual(s.started, ['stone']);
});

test('unmuted gesture selects media playback; muted tests leave the audio session alone', async t => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'audioSession');
  const session = { type: 'auto' };
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: session });
  t.after(() => {
    if (original) Object.defineProperty(navigator, 'audioSession', original);
    else Reflect.deleteProperty(navigator, 'audioSession');
  });
  const muted = suspendedSounds();
  muted.audio.unlock(); muted.finish(); await flushAudio();
  assert.equal(session.type, 'auto');
  const audible = suspendedSounds();
  audible.audio.muted = false;
  audible.audio.unlock(); audible.finish(); await flushAudio();
  assert.equal(session.type, 'playback');
});

test('first effects wait for resume; gesture and playback share one resume request', async () => {
  const s = suspendedSounds();
  s.audio.unlock(); s.audio.play('stone'); s.audio.play('stone-capture-small');
  assert.deepEqual(s.started, []); assert.equal(s.resumeCalls(), 1);
  s.finish(); await flushAudio();
  assert.deepEqual(s.started, ['stone', 'stone-capture-small']);
});

test('voice cancellation and newer countdowns invalidate sounds waiting for resume', async () => {
  const cancelled = suspendedSounds();
  cancelled.audio.play('count-9'); cancelled.audio.stopVoice();
  cancelled.finish(); await flushAudio(); assert.deepEqual(cancelled.started, []);
  const latest = suspendedSounds();
  latest.audio.play('count-9'); latest.audio.play('count-8');
  latest.finish(); await flushAudio(); assert.deepEqual(latest.started, ['count-8']);
  const start = suspendedSounds();
  start.audio.play('start-play'); start.audio.play('count-9'); start.audio.stopCountdown();
  start.finish(); await flushAudio(); assert.deepEqual(start.started, ['start-play']);
});

test('long interruptions discard stale effects instead of replaying a backlog', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const s = suspendedSounds(); s.audio.play('stone'); s.audio.play('count-9');
  now = 1000; s.finish(); await flushAudio(); assert.deepEqual(s.started, []);
});

test('failed resumes do not break gameplay and allow the next effect to retry', async () => {
  const s = suspendedSounds(); s.audio.play('stone'); s.fail(); await flushAudio();
  assert.deepEqual(s.started, []);
  s.context.resume = async () => { s.context.state = 'running'; };
  s.audio.play('stone'); await flushAudio(); assert.deepEqual(s.started, ['stone']);
});
