import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPath, recordedGameId } from '../src/routes';

test('archive URLs preserve uint64 precision without a format marker', () => {
  assert.equal(reviewPath('1'), '/game/vqUOWNBFwa4');
  for (const id of ['1', '1793333770030061788', '9007199254740993', '18446744073709551615']) {
    const path = reviewPath(id);
    assert.match(path, /^\/game\/[A-Za-z0-9_-]{11}$/);
    assert.equal(recordedGameId(path), id);
    assert.equal(recordedGameId(path + '/'), id);
    assert.equal(recordedGameId(`/game/${id}`), 'invalid');
  }
  for (const id of ['0', '-1', '1.5', '18446744073709551616']) assert.throws(() => reviewPath(id));
  assert.equal(recordedGameId('/game/11111111110'), '5177390512426396590', 'all-digit tokens decode as Base64');
  assert.equal(recordedGameId('/game/~AAAAAAAAAAE'), 'invalid');
  assert.equal(recordedGameId('/lobby/'), undefined);
  assert.equal(recordedGameId('/archive/vqUOWNBFwa4'), undefined);
  assert.equal(recordedGameId('/review/vqUOWNBFwa4'), undefined);
  assert.equal(recordedGameId('/game/invalid'), 'invalid');
  assert.equal(recordedGameId('/game/__________9'), 'invalid', 'reject noncanonical trailing bits');
});

test('nearby archive IDs have distinct scrambled prefixes with stable, compact round trips', () => {
  const reviews = new Set<string>();
  for (let i = 0; i < 1024; i++) {
    const id = (1793333770030061788n + BigInt(i)).toString();
    const review = reviewPath(id);
    assert.equal(reviewPath(id), review);
    assert.equal(review.length, '/game/'.length + 11);
    assert.equal(recordedGameId(review), id);
    reviews.add(review.slice('/game/'.length, '/game/'.length + 6));
  }
  assert.equal(reviews.size, 1024);
});
