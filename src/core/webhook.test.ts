import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { httpWebhook, WEBHOOK_MAX_CONTENT } from './webhook.ts';

/** What the local webhook heard: each request's method, path, content type and parsed body. */
interface Heard {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => done(body));
  });
}

async function listening(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'a TCP server has a port');
  return `http://127.0.0.1:${address.port}`;
}

describe('httpWebhook', () => {
  const heard: Heard[] = [];
  let server: Server;
  let base = '';

  before(async () => {
    server = createServer((request, response) => {
      void readBody(request).then((text) => {
        const body: unknown = JSON.parse(text);
        heard.push({ method: request.method ?? '', path: request.url ?? '', contentType: request.headers['content-type'], body });
        if (request.url === '/slow') {
          return;
        }
        response.writeHead(request.url === '/gone' ? 404 : 204);
        response.end();
      });
    });
    base = await listening(server);
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('posts the content as JSON with every mention turned off', async () => {
    heard.length = 0;
    assert.equal(await httpWebhook().post(`${base}/hook`, 'APPROVED R1 by @everyone'), undefined);
    assert.deepEqual(heard, [
      { method: 'POST', path: '/hook', contentType: 'application/json', body: { content: 'APPROVED R1 by @everyone', allowed_mentions: { parse: [] } } },
    ]);
  });

  it('cuts a message longer than the chat accepts, ending it with an ellipsis', async () => {
    heard.length = 0;
    assert.equal(await httpWebhook().post(`${base}/hook`, 'x'.repeat(WEBHOOK_MAX_CONTENT + 10)), undefined);
    assert.deepEqual(heard[0]?.body, { content: `${'x'.repeat(WEBHOOK_MAX_CONTENT - 1)}…`, allowed_mentions: { parse: [] } });
  });

  it('names the status of a refused post, and a post with no answer in time', async () => {
    assert.equal(await httpWebhook().post(`${base}/gone`, 'RAN R1'), 'the webhook answered HTTP 404');
    assert.equal(await httpWebhook(50).post(`${base}/slow`, 'RAN R1'), 'the webhook did not answer within 50 ms');
  });

  it('never quotes the URL when it is not one or cannot be reached', async () => {
    assert.equal(await httpWebhook().post('not a url/with-token', 'RAN R1'), 'the webhook address is not a URL');
    const closed = createServer();
    const gone = await listening(closed);
    await new Promise<void>((done) => closed.close(() => done()));
    const problem = await httpWebhook().post(`${gone}/hook-token`, 'RAN R1');
    assert.match(problem ?? '', /^the webhook could not be reached/);
    assert.doesNotMatch(problem ?? '', /hook-token|127\.0\.0\.1/);
  });
});
