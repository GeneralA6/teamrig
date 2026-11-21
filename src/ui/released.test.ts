import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHttp } from '../testing/fake-http.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { ARCHIVE_FORMAT, sha256Hex } from './archive.ts';
import { releasedEntry, type ReleasedUi, type UiPin } from './released.ts';

const HOME = '/kit';
const URL_A = 'https://releases.example/pane/teamrig-ui.json';
const URL_B = 'https://store.example/files/abc';
const ENTRY = '/kit/ui/0.77.0/ui/main.js';

function textOf(version: string): string {
  const document = {
    format: ARCHIVE_FORMAT,
    version,
    entry: 'ui/main.js',
    files: [
      { path: 'package.json', text: '{"type":"module"}\n' },
      { path: 'ui/main.js', text: 'export {};\n' },
    ],
  };
  return `${JSON.stringify(document)}\n`;
}

const TEXT = textOf('0.77.0');
const pinOf = (text: string): UiPin => ({ version: '0.77.0', url: URL_A, sha256: sha256Hex(new TextEncoder().encode(text)) });
const PIN = pinOf(TEXT);

function entryOf(result: ReleasedUi): string {
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return normalisePath(result.entry);
}

describe('releasedEntry', () => {
  it('fetches the pinned archive through its redirect, writes it and answers the entry', async () => {
    const files = new MemoryFiles();
    const http = new FakeHttp().answers('GET', URL_A, 302, '', { location: URL_B }).answers('GET', URL_B, 200, TEXT);
    const result = await releasedEntry({ files, http }, HOME, PIN);
    assert.equal(entryOf(result), ENTRY);
    assert.equal(result.ok && result.fetched, true);
    assert.equal(await files.read(ENTRY), 'export {};\n');
  });

  it('answers an installed one with no request', async () => {
    const files = new MemoryFiles();
    await releasedEntry({ files, http: new FakeHttp().answers('GET', URL_A, 200, TEXT) }, HOME, PIN);
    const http = new FakeHttp();
    const result = await releasedEntry({ files, http }, HOME, PIN);
    assert.equal(entryOf(result), ENTRY);
    assert.equal(result.ok && result.fetched, false);
    assert.deepEqual(http.requests, []);
  });

  it('fetches again when the folder holds the files of another pin', async () => {
    const files = new MemoryFiles();
    await releasedEntry({ files, http: new FakeHttp().answers('GET', URL_A, 200, TEXT) }, HOME, PIN);
    const other = `${TEXT}\n`;
    const http = new FakeHttp().answers('GET', URL_A, 200, other);
    const result = await releasedEntry({ files, http }, HOME, pinOf(other));
    assert.equal(result.ok && result.fetched, true);
    assert.equal(http.requests.length, 1);
  });

  it('writes nothing when the fetched bytes are not the pinned ones', async () => {
    const files = new MemoryFiles();
    const http = new FakeHttp().answers('GET', URL_A, 200, `${TEXT} `);
    const result = await releasedEntry({ files, http }, HOME, PIN);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /^the fetched UI 0\.77\.0 was refused: its sha256 is [0-9a-f]{64}, not the pinned [0-9a-f]{64}$/);
    assert.deepEqual(files.paths(), []);
  });

  it('refuses an archive of another version than the pin names, whatever its hash', async () => {
    const files = new MemoryFiles();
    const text = textOf('0.78.0');
    const http = new FakeHttp().answers('GET', URL_A, 200, text);
    const result = await releasedEntry({ files, http }, HOME, pinOf(text));
    assert.deepEqual(result, { ok: false, reason: 'the fetched UI was refused: it is version 0.78.0, not the pinned 0.77.0' });
    assert.deepEqual(files.paths(), []);
  });

  it('says why a fetch failed, and writes nothing', async () => {
    const files = new MemoryFiles();
    const http = new FakeHttp().answers('GET', URL_A, 404);
    assert.deepEqual(await releasedEntry({ files, http }, HOME, PIN), { ok: false, reason: 'the UI 0.77.0 could not be fetched: the server answered 404' });
    assert.deepEqual(files.paths(), []);
  });
});
