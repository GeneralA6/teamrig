import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTERFACE_MAJOR, INTERFACE_MINOR, INTERFACE_VERSION } from '../interface/version.ts';
import { FakeHttp } from '../testing/fake-http.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { ARCHIVE_FORMAT, sha256Hex } from './archive.ts';
import { INSTALLED_MARK, uiFolder } from './install.ts';
import { releasedEntry, type ReleasedDeps, type ReleasedUi, type UiPin } from './released.ts';

const HOME = '/kit';
const URL_A = 'https://releases.example/pane/teamrig-ui.json';
const URL_B = 'https://store.example/files/abc';

function textOf(version: string, speaks: string = INTERFACE_VERSION): string {
  const document = {
    format: ARCHIVE_FORMAT,
    version,
    interface: speaks,
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
const FOLDER = `/kit/ui/0.77.0-${PIN.sha256}`;
const ENTRY = `${FOLDER}/ui/main.js`;

function depsOf(files: MemoryFiles, http: FakeHttp): ReleasedDeps {
  let count = 0;
  return { files, http, nonce: () => `n${(count += 1)}` };
}

function entryOf(result: ReleasedUi): string {
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return normalisePath(result.entry);
}

/** Files where another start's work (`before`) lands just ahead of this start's first move, as two starts at once can. */
class RacingFiles extends MemoryFiles {
  private before: ((inner: MemoryFiles) => Promise<void>) | undefined;

  constructor(before: (inner: MemoryFiles) => Promise<void>) {
    super();
    this.before = before;
  }

  override async move(from: string, to: string): Promise<boolean> {
    const before = this.before;
    this.before = undefined;
    if (before !== undefined) await before(this);
    return super.move(from, to);
  }
}

async function installedFiles(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  await releasedEntry(depsOf(files, new FakeHttp().answers('GET', URL_A, 200, TEXT)), HOME, PIN);
  return files;
}

describe('releasedEntry', () => {
  it('fetches the pinned archive through its redirect, installs it under its pin and answers the entry', async () => {
    const files = new MemoryFiles();
    const http = new FakeHttp().answers('GET', URL_A, 302, '', { location: URL_B }).answers('GET', URL_B, 200, TEXT);
    const result = await releasedEntry(depsOf(files, http), HOME, PIN);
    assert.equal(entryOf(result), ENTRY);
    assert.equal(result.ok && result.fetched, true);
    assert.equal(await files.read(ENTRY), 'export {};\n');
    assert.equal(await files.read(`${FOLDER}/${INSTALLED_MARK}`), TEXT);
  });

  it('answers an untouched install with no request', async () => {
    const files = await installedFiles();
    const http = new FakeHttp();
    const result = await releasedEntry(depsOf(files, http), HOME, PIN);
    assert.equal(entryOf(result), ENTRY);
    assert.equal(result.ok && result.fetched, false);
    assert.deepEqual(http.requests, []);
  });

  it('refuses an install edited since, with no request, and runs none of it', async () => {
    const files = await installedFiles();
    await files.write(ENTRY, 'process.exit(0);\n');
    const http = new FakeHttp();
    assert.deepEqual(await releasedEntry(depsOf(files, http), HOME, PIN), {
      ok: false,
      reason: `the installed UI 0.77.0 in ${uiFolder(HOME, '0.77.0', PIN.sha256)} was changed after its install (ui/main.js was changed); remove that folder to fetch it again`,
    });
    assert.deepEqual(http.requests, []);
  });

  it('installs a new pin of the same version in a folder of its own, leaving the old one as it was', async () => {
    const files = await installedFiles();
    const other = `${TEXT}\n`;
    const http = new FakeHttp().answers('GET', URL_A, 200, other);
    const pin = pinOf(other);
    const result = await releasedEntry(depsOf(files, http), HOME, pin);
    assert.equal(entryOf(result), `/kit/ui/0.77.0-${pin.sha256}/ui/main.js`);
    assert.equal(http.requests.length, 1);
    assert.equal(await files.read(`${FOLDER}/${INSTALLED_MARK}`), TEXT);
  });

  it("uses the folder another start moved in first, when this start's move finds it there", async () => {
    const files = new RacingFiles(async (inner) => {
      await releasedEntry({ files: inner, http: new FakeHttp().answers('GET', URL_A, 200, TEXT), nonce: () => 'other' }, HOME, PIN);
    });
    const result = await releasedEntry(depsOf(files, new FakeHttp().answers('GET', URL_A, 200, TEXT)), HOME, PIN);
    assert.equal(entryOf(result), ENTRY);
    assert.deepEqual(await files.list('/kit/ui/.staging-n1'), []);
  });

  it('throws the move\'s error when the folder another start left is not the pinned one', async () => {
    const files = new RacingFiles(async (inner) => {
      await inner.write(`${FOLDER}/ui/main.js`, 'process.exit(0);\n');
    });
    await assert.rejects(releasedEntry(depsOf(files, new FakeHttp().answers('GET', URL_A, 200, TEXT)), HOME, PIN), /exists already/);
    assert.equal(await files.read(ENTRY), 'process.exit(0);\n');
  });

  it('writes nothing when the fetched bytes are not the pinned ones', async () => {
    const files = new MemoryFiles();
    const http = new FakeHttp().answers('GET', URL_A, 200, `${TEXT} `);
    const result = await releasedEntry(depsOf(files, http), HOME, PIN);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /^the fetched UI 0\.77\.0 was refused: its sha256 is [0-9a-f]{64}, not the pinned [0-9a-f]{64}$/);
    assert.deepEqual(files.paths(), []);
  });

  it('refuses an archive of another version than the pin names, whatever its hash', async () => {
    const files = new MemoryFiles();
    const text = textOf('0.78.0');
    const http = new FakeHttp().answers('GET', URL_A, 200, text);
    const result = await releasedEntry(depsOf(files, http), HOME, pinOf(text));
    assert.deepEqual(result, { ok: false, reason: 'the fetched UI was refused: it is version 0.78.0, not the pinned 0.77.0' });
    assert.deepEqual(files.paths(), []);
  });

  it('refuses an archive written against an interface this teamrig does not serve, and writes nothing', async () => {
    const cases = [
      [`${INTERFACE_MAJOR + 1}.0`, 'update teamrig'],
      [`${INTERFACE_MAJOR}.${INTERFACE_MINOR + 1}`, 'update teamrig'],
      [`${INTERFACE_MAJOR - 1}.0`, 'update the reader'],
    ] as const;
    for (const [speaks, side] of cases) {
      const files = new MemoryFiles();
      const text = textOf('0.77.0', speaks);
      const result = await releasedEntry(depsOf(files, new FakeHttp().answers('GET', URL_A, 200, text)), HOME, pinOf(text));
      assert.equal(result.ok, false, speaks);
      assert.match(result.ok ? '' : result.reason, new RegExp(`^the fetched UI 0\\.77\\.0 was refused: interface ${speaks.replace('.', '\\.')} .*${side}$`), speaks);
      assert.deepEqual(files.paths(), [], speaks);
    }
  });

  it('starts an archive written against an older minor of the served major', async () => {
    const speaks = `${INTERFACE_MAJOR}.0`;
    const text = textOf('0.77.0', speaks);
    const pin = pinOf(text);
    const result = await releasedEntry(depsOf(new MemoryFiles(), new FakeHttp().answers('GET', URL_A, 200, text)), HOME, pin);
    assert.equal(entryOf(result), `/kit/ui/0.77.0-${pin.sha256}/ui/main.js`);
  });

  it('says why a fetch failed, and writes nothing', async () => {
    const files = new MemoryFiles();
    const http = new FakeHttp().answers('GET', URL_A, 404);
    assert.deepEqual(await releasedEntry(depsOf(files, http), HOME, PIN), { ok: false, reason: 'the UI 0.77.0 could not be fetched: the server answered 404' });
    assert.deepEqual(files.paths(), []);
  });
});
