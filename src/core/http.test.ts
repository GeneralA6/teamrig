import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { FakeHttp } from '../testing/fake-http.ts';
import { listening, readBody, stopped } from '../testing/local-server.ts';
import { fetchFailure, fetchHttpClient, HTTP_TIMEOUT_MS, httpsOnlyClient, isHttpsUrl, nodeHttpClient } from './http.ts';

/** What the local server heard: each request's method, path, sign-in header and body. */
interface Heard {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** The length of the `/long` answer, in bytes. */
const LONG_BYTES = 5_000;

describe('fetchHttpClient', () => {
  const heard: Heard[] = [];
  let server: Server;
  let base = '';

  before(async () => {
    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        heard.push({ method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization, body });
        switch (request.url) {
          case '/slow':
            return;
          case '/stalls':
            response.writeHead(200);
            response.write('begun');
            return;
          case '/moved':
            response.writeHead(302, { location: `${base}/elsewhere` });
            response.end();
            return;
          case '/gone':
            response.writeHead(404);
            response.end('{"errorMessages":["no such issue"]}');
            return;
          case '/long':
            response.writeHead(200);
            response.end('x'.repeat(LONG_BYTES));
            return;
          case '/empty':
            response.writeHead(204);
            response.end();
            return;
          default:
            response.writeHead(200, { 'Content-Type': 'application/json', 'X-Seen': 'yes' });
            response.end('{"summary":"שלום – done"}');
        }
      });
    });
    base = await listening(server);
  });

  after(async () => {
    await stopped(server);
  });

  it('sends the method, headers and body, and gives back the status, the headers by lower-case name and the text', async () => {
    heard.length = 0;
    const result = await fetchHttpClient().send({ method: 'POST', url: `${base}/issue`, headers: { Authorization: 'Basic abc' }, body: '{"a":1}' });
    assert.deepEqual(heard, [{ method: 'POST', path: '/issue', authorization: 'Basic abc', body: '{"a":1}' }]);
    assert.equal(result.kind, 'answered');
    assert.ok(result.kind === 'answered');
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'application/json');
    assert.equal(result.headers['x-seen'], 'yes');
    assert.equal(result.body, '{"summary":"שלום – done"}');
  });

  it('sends a request with no headers and no body, and reads an answer with none', async () => {
    heard.length = 0;
    const result = await fetchHttpClient().send({ method: 'DELETE', url: `${base}/empty` });
    assert.deepEqual(heard, [{ method: 'DELETE', path: '/empty', authorization: undefined, body: '' }]);
    assert.ok(result.kind === 'answered');
    assert.deepEqual([result.status, result.body], [204, '']);
  });

  it('hands back a refusal as the answer it is', async () => {
    const result = await fetchHttpClient().send({ method: 'GET', url: `${base}/gone` });
    assert.ok(result.kind === 'answered');
    assert.deepEqual([result.status, result.body], [404, '{"errorMessages":["no such issue"]}']);
  });

  it('follows no redirect: it is the answer, and the address it points to hears nothing', async () => {
    heard.length = 0;
    const result = await fetchHttpClient().send({ method: 'GET', url: `${base}/moved`, headers: { Authorization: 'Basic abc' } });
    assert.ok(result.kind === 'answered');
    assert.deepEqual([result.status, result.headers['location']], [302, `${base}/elsewhere`]);
    assert.deepEqual(
      heard.map((request) => request.path),
      ['/moved'],
    );
  });

  it('fails when no answer comes in time, or its body stops midway', async () => {
    const expected = { kind: 'failed', reason: 'the server did not answer within 50 ms' };
    assert.deepEqual(await fetchHttpClient(50).send({ method: 'GET', url: `${base}/slow` }), expected);
    assert.deepEqual(await fetchHttpClient(50).send({ method: 'GET', url: `${base}/stalls` }), expected);
  });

  it('reads an answer up to the longest it may be, and gives up a longer one', async () => {
    const whole = await fetchHttpClient(HTTP_TIMEOUT_MS, LONG_BYTES).send({ method: 'GET', url: `${base}/long` });
    assert.ok(whole.kind === 'answered');
    assert.equal(whole.body.length, LONG_BYTES);
    assert.deepEqual(await fetchHttpClient(HTTP_TIMEOUT_MS, LONG_BYTES - 1).send({ method: 'GET', url: `${base}/long` }), {
      kind: 'failed',
      reason: `the server's answer was longer than ${LONG_BYTES - 1} bytes`,
    });
  });

  it('never quotes the URL when it is not one or cannot be reached', async () => {
    assert.deepEqual(await fetchHttpClient().send({ method: 'GET', url: 'not a url/with-token' }), { kind: 'failed', reason: 'the address is not a URL' });
    const closed = createServer();
    const gone = await listening(closed);
    await stopped(closed);
    const result = await fetchHttpClient().send({ method: 'GET', url: `${gone}/with-token` });
    assert.ok(result.kind === 'failed');
    assert.match(result.reason, /^the server could not be reached/);
    assert.doesNotMatch(result.reason, /with-token|127\.0\.0\.1/);
  });

  it("refuses, as the connectors' own client, every URL but https, before any request", async () => {
    heard.length = 0;
    for (const url of [`${base}/issue`, 'ftp://tracker.example/issue', 'not a url/issue']) {
      assert.deepEqual(await nodeHttpClient().send({ method: 'GET', url }), { kind: 'failed', reason: 'the address is not an https URL' }, url);
    }
    assert.deepEqual(heard, []);
  });
});

describe('httpsOnlyClient', () => {
  it('hands an https request on and gives back its answer', async () => {
    const inner = new FakeHttp().answers('GET', 'https://tracker.example/issue', 200, '{}');
    const request = { method: 'GET', url: 'https://tracker.example/issue' } as const;
    assert.deepEqual(await httpsOnlyClient(inner).send(request), { kind: 'answered', status: 200, headers: {}, body: '{}' });
    assert.deepEqual(inner.requests, [request]);
  });

  it('refuses an http, internal or other address without handing it on', async () => {
    const inner = new FakeHttp();
    for (const url of ['http://tracker.example/issue', 'http://192.0.2.10/latest', 'file:///etc/passwd', 'data:text/plain,x', 'tracker.example/issue']) {
      assert.deepEqual(await httpsOnlyClient(inner).send({ method: 'GET', url }), { kind: 'failed', reason: 'the address is not an https URL' }, url);
    }
    assert.deepEqual(inner.requests, []);
  });
});

describe('isHttpsUrl', () => {
  it('is true only for an absolute https URL', () => {
    assert.deepEqual(
      ['https://chat.example/hook', 'HTTPS://chat.example/hook', 'http://chat.example/hook', 'https:/', '//chat.example/hook', ''].map(isHttpsUrl),
      [true, true, false, false, false, false],
    );
  });
});

describe('fetchFailure', () => {
  it('names a timeout by its length', () => {
    assert.equal(fetchFailure('the webhook', new DOMException('The operation timed out', 'TimeoutError'), 50), 'the webhook did not answer within 50 ms');
  });

  it("names the cause's code, and never the error's own message, which can quote the URL", () => {
    const refused = new TypeError('fetch failed: https://chat.example/hook-token', { cause: { code: 'ECONNREFUSED' } });
    assert.equal(fetchFailure('the webhook', refused, 50), 'the webhook could not be reached (ECONNREFUSED)');
    assert.equal(fetchFailure('the server', new TypeError('fetch failed: https://chat.example/hook-token'), 50), 'the server could not be reached');
    assert.equal(fetchFailure('the server', 'https://chat.example/hook-token', 50), 'the server could not be reached');
  });
});
