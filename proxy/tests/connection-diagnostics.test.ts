import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionDiagnostics, errorDetails } from '../src/connection-diagnostics.ts';

test('Worker diagnostics track successful byte transfers and preserve concrete TCP error details', t => {
  let time = 1000;
  t.mock.method(Date, 'now', () => time);
  const records: Record<string, unknown>[] = [];
  const identity = { connectionId: 'correlated-id', target: 'fox.example:3001', rayId: 'ray-LHR', colo: 'LHR' };
  const diagnostics = new ConnectionDiagnostics(identity, record => records.push(record));
  diagnostics.event('proxy_connecting');
  time += 10; diagnostics.sent(20);
  time += 10; diagnostics.received(30);
  time += 50;
  diagnostics.event('proxy_closed', { initiator: 'tcp_read_error', ...errorDetails(new TypeError('connection reset')) });
  assert.deepEqual(records[1], { ...identity, event: 'proxy_closed', timestamp: new Date(time).toISOString(),
    elapsedMs: 70, sentBytes: 20, receivedBytes: 30, lastSentAgoMs: 60, lastReceivedAgoMs: 50,
    initiator: 'tcp_read_error', errorName: 'TypeError', errorMessage: 'connection reset' });
  assert.deepEqual(errorDetails({ token: 'secret' }), { errorName: 'UnknownError' });
});
