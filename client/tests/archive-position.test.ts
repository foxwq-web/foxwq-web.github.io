import test from 'node:test';
import assert from 'node:assert/strict';
import { archivePositionUrl, readArchivePosition } from '../src/archive-position';

test('archive move pointers include the initial board and clamp beyond the record', () => {
  assert.deepEqual(readArchivePosition('', 120), { move: 120 });
  assert.deepEqual(readArchivePosition('?move=0', 120), { move: 0 });
  assert.deepEqual(readArchivePosition('?move=42', 120), { move: 42 });
  assert.deepEqual(readArchivePosition('?move=999', 120), { move: 120 });
});

test('legacy variation pointers load and normalize to the displayed compact branch', () => {
  const variation = { origin: 42, moves: [[3, 3], [15, 15], [null, null]] } as const;
  const position = readArchivePosition('?move=43&variation=42.ddpp--', 120);
  assert.deepEqual(position, { move: 43, variation });
  assert.equal(archivePositionUrl('https://example.com/game/abc?dev-screen=record&move=44#board', position!),
    '/game/abc?dev-screen=record&move=42&variation=dd#board');
  assert.deepEqual(readArchivePosition('?variation=42.ddpp--', 120), { move: 45, variation });
});

test('main-line links remove variations and preserve unrelated URL state', () => {
  assert.equal(archivePositionUrl('https://example.com/game/abc?variation=42.dd&move=43&theme=dark#board', { move: 0 }),
    '/game/abc?move=0&theme=dark#board');
});

test('malformed and inconsistent archive pointers cannot create a partial branch', () => {
  for (const query of ['move=-1', 'move=1.5', 'move=Infinity', 'move=9007199254740992',
    'move=2&variation=3.dd', 'move=1&variation=1.dd', 'move=4&variation=1.dd',
    'move=4&variation=3.tt', 'move=4&variation=3.d', 'move=4&variation=3.-d',
    'move=4&variation=3.', 'variation=121.dd']) {
    assert.equal(readArchivePosition('?' + query, 120), null, query);
  }
});


test('compact variation links use the origin and displayed branch coordinates', () => {
  const position = readArchivePosition('?move=106&variation=oeofpfog', 159);
  assert.deepEqual(position, { move: 110, variation: {
    origin: 106, moves: [[14, 4], [14, 5], [15, 5], [14, 6]],
  } });
  assert.equal(archivePositionUrl('https://example.com/game/abc', position!, 159),
    '/game/abc?move=106&variation=oeofpfog');
  assert.deepEqual(readArchivePosition('?move=0&variation=dd--', 120), {
    move: 2, variation: { origin: 0, moves: [[3, 3], [null, null]] },
  });
  for (const query of ['variation=dd', 'move=121&variation=dd', 'move=1&variation=tt',
    'move=1&variation=d', 'move=1&variation=-d', 'move=1&variation='])
    assert.equal(readArchivePosition('?' + query, 120), null, query);
});

test('the latest main-line position has no query string', () => {
  assert.equal(archivePositionUrl('https://example.com/game/abc', { move: 159 }, 159), '/game/abc');
  assert.equal(archivePositionUrl('https://example.com/game/abc?move=158&variation=dd', { move: 159 }, 159), '/game/abc');
  assert.equal(archivePositionUrl('https://example.com/game/abc?theme=dark#board', { move: 159 }, 159), '/game/abc?theme=dark#board');
});
