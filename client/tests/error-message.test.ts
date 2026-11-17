import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError } from '../src/error-message';

test('error presentation adds the error prefix', () => {
  assert.equal(formatError('could not load player details'),
    'Error: could not load player details');
  assert.equal(formatError(''), '');
});
