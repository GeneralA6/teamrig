import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_FORMAT, isArchivePath, readArchive, sha256Hex, type ArchiveRead } from './archive.ts';

const encoder = new TextEncoder();

interface Document {
  readonly format?: unknown;
  readonly version?: unknown;
  readonly entry?: unknown;
  readonly files?: unknown;
}

const GOOD: Document = {
  format: ARCHIVE_FORMAT,
  version: '0.77.0',
  entry: 'ui/main.js',
  files: [
    { path: 'package.json', text: '{"type":"module"}\n' },
    { path: 'ui/main.js', text: 'export {};\n' },
  ],
};

function bytesOf(document: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(document)}\n`);
}

/** Reads `document` against its own hash, so only its shape can refuse it. */
function readOf(document: unknown): ArchiveRead {
  const bytes = bytesOf(document);
  return readArchive(bytes, sha256Hex(bytes));
}

function reasonOf(read: ArchiveRead): string {
  assert.equal(read.ok, false);
  return read.ok ? '' : read.reason;
}

function withFiles(paths: readonly string[]): Document {
  return { ...GOOD, entry: paths[0], files: paths.map((path) => ({ path, text: '' })) };
}

describe('isArchivePath', () => {
  it('takes relative paths of plain names', () => {
    for (const path of ['a.js', 'ui/main.js', 'hooks/core/x_y-z.1.js', '_a/-b']) assert.equal(isArchivePath(path), true, path);
  });

  it('refuses a path that could leave its folder or name another file on some OS', () => {
    const refused = ['', '/a', 'a/', 'a//b', '.', '..', '../a', 'a/../b', '.git/config', 'a\\b', 'C:/a', 'C:a', 'a b', 'a.', 'ui/a.', 'nul', 'NUL.js', 'ui/con', 'com1.txt', 'lpt9', 'a\u0000b', 'é.js'];
    for (const path of refused) assert.equal(isArchivePath(path), false, JSON.stringify(path));
  });

  it('takes a name that only starts like a device name', () => {
    for (const path of ['console.js', 'null.js', 'com10.js', 'auxiliary']) assert.equal(isArchivePath(path), true, path);
  });
});

describe('sha256Hex', () => {
  it('is the sha256 of the bytes in lowercase hex', () => {
    assert.equal(sha256Hex(encoder.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('readArchive', () => {
  it('answers the archive whose bytes hash to the pin', () => {
    const read = readOf(GOOD);
    assert.deepEqual(read, {
      ok: true,
      archive: {
        version: '0.77.0',
        entry: 'ui/main.js',
        files: [
          { path: 'package.json', text: '{"type":"module"}\n' },
          { path: 'ui/main.js', text: 'export {};\n' },
        ],
      },
    });
  });

  it('takes the pin in uppercase hex', () => {
    const bytes = bytesOf(GOOD);
    assert.equal(readArchive(bytes, sha256Hex(bytes).toUpperCase()).ok, true);
  });

  it('refuses bytes that do not hash to the pin, naming both hashes', () => {
    const bytes = bytesOf(GOOD);
    const pin = sha256Hex(encoder.encode('other'));
    assert.equal(reasonOf(readArchive(bytes, pin)), `its sha256 is ${sha256Hex(bytes)}, not the pinned ${pin}`);
  });

  it('checks the hash before it parses: bytes that are no archive are refused for their hash alone', () => {
    const bytes = encoder.encode('{ not json');
    assert.match(reasonOf(readArchive(bytes, sha256Hex(encoder.encode('other')))), /^its sha256 is /);
  });

  it('refuses a pin that is no sha256, whatever the bytes', () => {
    for (const pin of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      assert.equal(reasonOf(readArchive(bytesOf(GOOD), pin)), 'the pinned sha256 is not 64 hex digits');
    }
  });

  it('refuses pinned bytes that are not UTF-8', () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x7b]);
    assert.equal(reasonOf(readArchive(bytes, sha256Hex(bytes))), 'it is not UTF-8 text');
  });

  it('refuses pinned bytes that are no JSON object', () => {
    for (const text of ['{ not json', '[]', '"text"', 'null', '7']) {
      const bytes = encoder.encode(text);
      assert.equal(reasonOf(readArchive(bytes, sha256Hex(bytes))), 'it is not a JSON object', text);
    }
  });

  it('refuses another format', () => {
    assert.equal(reasonOf(readOf({ ...GOOD, format: 2 })), 'its format is 2, and this teamrig reads format 1');
    assert.equal(reasonOf(readOf({ ...GOOD, format: '1' })), 'its format is "1", and this teamrig reads format 1');
    assert.match(reasonOf(readOf({ version: '1', entry: 'a', files: [] })), /^its format is /);
  });

  it('refuses a version that is no plain folder name', () => {
    for (const version of [undefined, 7, '', '..', '../0.1.0', '0.1.0/x', 'a\\b', 'nul', '1.0.']) {
      assert.equal(reasonOf(readOf({ ...GOOD, version })), 'its version is not a plain name', JSON.stringify(version));
    }
  });

  it('refuses a missing entry and a missing files list', () => {
    assert.equal(reasonOf(readOf({ ...GOOD, entry: 7 })), 'it names no entry');
    assert.equal(reasonOf(readOf({ ...GOOD, files: { path: 'a', text: '' } })), 'it holds no list of files');
  });

  it('refuses a file without a path or a text', () => {
    for (const file of [null, 'ui/main.js', { path: 'a.js' }, { text: '' }, { path: 7, text: '' }, { path: 'a.js', text: 7 }]) {
      assert.equal(reasonOf(readOf({ ...GOOD, files: [file] })), 'one of its files lacks a path or a text', JSON.stringify(file));
    }
  });

  it('refuses the whole archive for one path that could leave the folder', () => {
    for (const path of ['../evil.js', '/etc/x', 'C:/x', 'ui\\..\\x', '.npmrc']) {
      const read = readOf({ ...GOOD, files: [{ path: 'ui/main.js', text: '' }, { path, text: '' }] });
      assert.equal(reasonOf(read), `a file's path could leave the folder it is written into: ${JSON.stringify(path)}`);
    }
  });

  it('refuses two files one disk would write as one', () => {
    assert.equal(reasonOf(readOf(withFiles(['a.js', 'a.js']))), 'its files cannot all be written: two files at a.js');
    assert.equal(reasonOf(readOf(withFiles(['ui/a.js', 'UI/A.js']))), 'its files cannot all be written: two files at UI/A.js');
  });

  it('refuses a path that is both a file and a folder, in either order and case', () => {
    assert.equal(reasonOf(readOf(withFiles(['ui', 'ui/a.js']))), 'its files cannot all be written: ui/a.js is under a path that is also a file');
    assert.equal(reasonOf(readOf(withFiles(['a/b/c.js', 'A/B']))), 'its files cannot all be written: a/b/c.js is under a path that is also a file');
  });

  it('takes files that only share a folder or a name start', () => {
    assert.equal(readOf(withFiles(['ui/a.js', 'ui/b.js', 'ui-x/a.js', 'ui.js'])).ok, true);
  });

  it('refuses an entry that is not among the files, by exact case', () => {
    assert.equal(reasonOf(readOf({ ...GOOD, entry: 'ui/other.js' })), 'its entry "ui/other.js" is not among its files');
    assert.equal(reasonOf(readOf({ ...GOOD, entry: 'UI/main.js' })), 'its entry "UI/main.js" is not among its files');
    assert.equal(reasonOf(readOf({ ...GOOD, files: [] })), 'its entry "ui/main.js" is not among its files');
  });
});
