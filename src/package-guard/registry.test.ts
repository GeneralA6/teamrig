import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpPackageRegistry } from './registry.ts';

/** What the local registry heard: each request's method, path and body. */
interface Heard {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const LODASH = {
  name: 'lodash',
  'dist-tags': { latest: '4.17.21', next: 7 },
  time: { created: '2012-04-23T16:37:12.603Z', '4.17.20': '2020-08-13T16:53:54.152Z', '4.17.21': '2021-02-20T15:42:16.891Z', '4.17.22': 'not a date' },
};

const ADVISORIES = {
  lodash: [
    { id: 1, url: 'https://github.com/advisories/GHSA-1', title: 'Prototype pollution', severity: 'high', vulnerable_versions: '<4.17.21' },
    'not an advisory',
    { id: 2 },
  ],
  other: 'not a list',
};

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

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('httpPackageRegistry', () => {
  const heard: Heard[] = [];
  let server: Server;
  let base = '';

  before(async () => {
    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        const path = request.url ?? '';
        heard.push({ method: request.method ?? '', path, body });
        if (path === '/lodash') {
          send(response, 200, LODASH);
        } else if (path === '/@types%2Fnode') {
          send(response, 200, { 'dist-tags': { latest: '22.10.1' }, time: { '22.10.1': '2024-11-26T00:00:00.000Z' } });
        } else if (path === '/broken') {
          send(response, 500, { error: 'down' });
        } else if (path === '/odd') {
          send(response, 200, ['not', 'an', 'object']);
        } else if (path === '/-/npm/v1/security/advisories/bulk') {
          send(response, 200, ADVISORIES);
        } else if (path === '/slow') {
          // Never answers: the caller's signal ends the wait.
        } else {
          send(response, 404, { error: 'Not found' });
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address: AddressInfo | string | null = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("reads a package's dist-tags and publish times, skipping values that are not a version or a date", async () => {
    const doc = await httpPackageRegistry(base).packageDoc('lodash', AbortSignal.timeout(5_000));
    assert.deepEqual(doc?.distTags, new Map([['latest', '4.17.21']]));
    assert.equal(doc?.published.get('4.17.21'), Date.parse('2021-02-20T15:42:16.891Z'));
    assert.equal(doc?.published.has('4.17.22'), false);
  });

  it("escapes a scope's slash in the package's path", async () => {
    const doc = await httpPackageRegistry(`${base}/`).packageDoc('@types/node', AbortSignal.timeout(5_000));
    assert.equal(doc?.distTags.get('latest'), '22.10.1');
    assert.ok(heard.some((request) => request.path === '/@types%2Fnode'));
  });

  it('answers undefined for a package the registry does not have, and throws on any other failure', async () => {
    const registry = httpPackageRegistry(base);
    assert.equal(await registry.packageDoc('no-such-package', AbortSignal.timeout(5_000)), undefined);
    await assert.rejects(registry.packageDoc('broken', AbortSignal.timeout(5_000)), /answered 500 for broken/);
    await assert.rejects(registry.packageDoc('odd', AbortSignal.timeout(5_000)), /other than an object/);
  });

  it('gives up when the signal ends the wait', async () => {
    await assert.rejects(httpPackageRegistry(base).packageDoc('slow', AbortSignal.timeout(100)), { name: 'TimeoutError' });
  });

  it('asks for advisories in one POST of each name with its versions, keeping only well-formed ones', async () => {
    const versions = new Map([['lodash', ['4.17.20']], ['other', ['1.0.0']]]);
    const found = await httpPackageRegistry(base).advisories(versions, AbortSignal.timeout(5_000));
    assert.deepEqual(found, [
      { name: 'lodash', title: 'Prototype pollution', severity: 'high', url: 'https://github.com/advisories/GHSA-1' },
      { name: 'lodash', title: 'an untitled advisory', severity: 'unknown', url: '' },
    ]);
    const posted = heard.find((request) => request.method === 'POST');
    assert.deepEqual(posted === undefined ? undefined : JSON.parse(posted.body), { lodash: ['4.17.20'], other: ['1.0.0'] });
  });

  it('throws when the advisory service fails', async () => {
    await assert.rejects(httpPackageRegistry(`${base}/broken/`).advisories(new Map([['x', ['1.0.0']]]), AbortSignal.timeout(5_000)), /advisory service answered 404/);
  });
});
