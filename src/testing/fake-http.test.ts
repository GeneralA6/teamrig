import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHttp } from './fake-http.ts';

const URL_A = 'https://tracker.example/a';

describe('FakeHttp', () => {
  it('answers each request with the next result queued for its method and URL, the last one repeating', async () => {
    const http = new FakeHttp().answers('GET', URL_A, 429, '', { 'retry-after': '1' }).answers('GET', URL_A, 200, '{}').failsOn('POST', URL_A, 'the server could not be reached');
    const get = { method: 'GET', url: URL_A } as const;
    assert.deepEqual(await http.send(get), { kind: 'answered', status: 429, headers: { 'retry-after': '1' }, body: '' });
    assert.deepEqual(await http.send(get), { kind: 'answered', status: 200, headers: {}, body: '{}' });
    assert.deepEqual(await http.send(get), { kind: 'answered', status: 200, headers: {}, body: '{}' });
    assert.deepEqual(await http.send({ method: 'POST', url: URL_A, body: 'x' }), { kind: 'failed', reason: 'the server could not be reached' });
    assert.deepEqual(http.requests, [get, get, get, { method: 'POST', url: URL_A, body: 'x' }]);
  });

  it('fails a request no test routed, naming it', async () => {
    assert.deepEqual(await new FakeHttp().send({ method: 'PUT', url: URL_A }), { kind: 'failed', reason: `no answer is queued for PUT ${URL_A}` });
  });
});
