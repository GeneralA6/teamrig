import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { chatWebhook, httpsOnly, httpWebhook, isHttpsUrl, WEBHOOK_MAX_CONTENT, type ChatWebhook } from './webhook.ts';

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
        if (request.url === '/moved') {
          response.writeHead(307, { location: `${base}/elsewhere` });
          response.end();
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

  it('follows no redirect: the post fails and the address it points to hears nothing', async () => {
    heard.length = 0;
    assert.match((await httpWebhook().post(`${base}/moved`, 'RAN R1')) ?? '', /^the webhook could not be reached/);
    assert.deepEqual(heard.map((request) => request.path), ['/moved']);
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

  it("refuses, as teamrig's own webhook, every URL but https, before any request", async () => {
    heard.length = 0;
    for (const url of [`${base}/hook-token`, 'ftp://chat.example/hook-token', 'not a url/hook-token']) {
      assert.equal(await chatWebhook().post(url, 'RAN R1'), 'the webhook address is not an https URL', url);
    }
    assert.deepEqual(heard, []);
  });
});

describe('httpsOnly', () => {
  /** A webhook that records each post it is handed and answers `answer`. */
  function recording(answer: string | undefined): { readonly webhook: ChatWebhook; readonly posts: string[] } {
    const posts: string[] = [];
    return { posts, webhook: { post: (url, content) => Promise.resolve((posts.push(`${url} ${content}`), answer)) } };
  }

  it('hands an https post on and gives back its answer', async () => {
    const inner = recording('the webhook answered HTTP 404');
    assert.equal(await httpsOnly(inner.webhook).post('https://chat.example/hook', 'RAN R1'), 'the webhook answered HTTP 404');
    assert.deepEqual(inner.posts, ['https://chat.example/hook RAN R1']);
  });

  it('refuses an http, internal or other address without handing it on', async () => {
    const inner = recording(undefined);
    for (const url of ['http://chat.example/hook', 'http://192.0.2.10/latest', 'file:///etc/passwd', 'data:text/plain,x', 'chat.example/hook']) {
      assert.equal(await httpsOnly(inner.webhook).post(url, 'RAN R1'), 'the webhook address is not an https URL', url);
    }
    assert.deepEqual(inner.posts, []);
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
