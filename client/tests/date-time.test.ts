import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime } from '../src/date-time';

test('timestamps use padded local yyyy-mm-dd hh:mm values', () => {
  assert.equal(formatDateTime(new Date(2026, 0, 2, 3, 4, 59).getTime() / 1000), '2026-01-02 03:04');
  assert.equal(formatDateTime(new Date(2026, 10, 17, 23, 45).getTime() / 1000), '2026-11-17 23:45');
  for (const value of [undefined, 0, -1, NaN, Infinity, 8_640_000_000_001]) assert.equal(formatDateTime(value), '—');
});
