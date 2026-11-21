import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHttp } from '../testing/fake-http.ts';
import { MAX_REDIRECTS, fetchArchive } from './fetch.ts';

const URL_A = 'https://releases.example/pane/teamrig-ui.json';
const URL_B = 'https://store.example/files/abc?sig=s3cr3t';

describe('fetchArchive', () => {
  it("answers the body's UTF-8 bytes, asked for with no header", async () => {
    const http = new FakeHttp().answers('GET', URL_A, 200, '{"é":1}\n');
    const fetched = await fetchArchive(http, URL_A);
    assert.deepEqual(fetched, { ok: true, bytes: new TextEncoder().encode('{"é":1}\n') });
    assert.deepEqual(http.requests, [{ method: 'GET', url: URL_A }]);
  });

  it('follows a redirect to another host, again with no header', async () => {
    const http = new FakeHttp().answers('GET', URL_A, 302, '', { location: URL_B }).answers('GET', URL_B, 200, 'x');
    const fetched = await fetchArchive(http, URL_A);
    assert.equal(fetched.ok, true);
    assert.deepEqual(http.requests, [
      { method: 'GET', url: URL_A },
      { method: 'GET', url: URL_B },
    ]);
  });

  it('reads a relative redirect against the address that answered it', async () => {
    const http = new FakeHttp().answers('GET', URL_A, 307, '', { location: '/moved/ui.json' }).answers('GET', 'https://releases.example/moved/ui.json', 200, 'x');
    assert.equal((await fetchArchive(http, URL_A)).ok, true);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`takes ${status} as a redirect`, async () => {
      const http = new FakeHttp().answers('GET', URL_A, status, '', { location: URL_B }).answers('GET', URL_B, 200, 'x');
      assert.equal((await fetchArchive(http, URL_A)).ok, true);
    });
  }

  it('refuses an address that is not https before any request', async () => {
    const http = new FakeHttp();
    assert.deepEqual(await fetchArchive(http, 'http://releases.example/ui.json'), { ok: false, reason: 'its address is not an https URL' });
    assert.deepEqual(http.requests, []);
  });

  it('refuses a redirect off https, and sends nothing there', async () => {
    for (const location of ['http://store.example/abc', 'file:///etc/hosts']) {
      const http = new FakeHttp().answers('GET', URL_A, 302, '', { location });
      assert.deepEqual(await fetchArchive(http, URL_A), { ok: false, reason: 'it was redirected to an address that is not an https URL' });
      assert.equal(http.requests.length, 1);
    }
  });

  it('refuses a redirect that names no address, or one that is no URL', async () => {
    const reason = 'the server answered 302 with no address to go to';
    assert.deepEqual(await fetchArchive(new FakeHttp().answers('GET', URL_A, 302), URL_A), { ok: false, reason });
    assert.deepEqual(await fetchArchive(new FakeHttp().answers('GET', URL_A, 302, '', { location: 'https://' }), URL_A), { ok: false, reason });
  });

  it(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    const http = new FakeHttp().answers('GET', URL_A, 302, '', { location: URL_A });
    assert.deepEqual(await fetchArchive(http, URL_A), { ok: false, reason: `it was redirected more than ${MAX_REDIRECTS} times` });
    assert.equal(http.requests.length, MAX_REDIRECTS + 1);
  });

  it('says the status of any other answer, and never an address', async () => {
    const http = new FakeHttp().answers('GET', URL_A, 302, '', { location: URL_B }).answers('GET', URL_B, 404, 'no such file');
    const fetched = await fetchArchive(http, URL_A);
    assert.deepEqual(fetched, { ok: false, reason: 'the server answered 404' });
  });

  it("hands on the client's own reason when no answer came", async () => {
    const http = new FakeHttp().failsOn('GET', URL_A, 'the server could not be reached (ENOTFOUND)');
    assert.deepEqual(await fetchArchive(http, URL_A), { ok: false, reason: 'the server could not be reached (ENOTFOUND)' });
  });
});
