import test from 'node:test';
import assert from 'node:assert/strict';
import { clockInputValue, clockReading } from '../src/clock.ts';

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
