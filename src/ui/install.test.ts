import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import type { UiArchive } from './archive.ts';
import { INSTALLED_MARK, installArchive, installedEntry, uiFolder } from './install.ts';

const PIN = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const FOLDER = '/kit/ui/0.77.0';
const MARK = `${FOLDER}/${INSTALLED_MARK}`;
const ENTRY = `${FOLDER}/ui/main.js`;

const ARCHIVE: UiArchive = {
  version: '0.77.0',
  entry: 'ui/main.js',
  files: [
    { path: 'package.json', text: '{"type":"module"}\n' },
    { path: 'ui/main.js', text: 'export {};\n' },
    { path: 'hooks/core/rows.js', text: 'export const rows = 1;\n' },
  ],
};

describe('uiFolder', () => {
  it('is the version folder under the kit home', () => {
    assert.equal(normalisePath(uiFolder('/kit', '0.77.0')), FOLDER);
  });
});

describe('installArchive', () => {
  it('writes each file under the folder, then the mark, and answers the entry', async () => {
    const files = new MemoryFiles();
    const entry = await installArchive(files, FOLDER, ARCHIVE, PIN);
    assert.equal(normalisePath(entry), ENTRY);
    assert.deepEqual(files.paths(), [MARK, `${FOLDER}/hooks/core/rows.js`, `${FOLDER}/package.json`, ENTRY]);
    assert.equal(files.get(ENTRY), 'export {};\n');
    assert.equal(files.get(MARK), `${JSON.stringify({ sha256: PIN, entry: 'ui/main.js' })}\n`);
  });

  it('leaves no mark when a write fails, an old mark included', async () => {
    const memory = new MemoryFiles();
    await installArchive(memory, FOLDER, ARCHIVE, OTHER);
    const files = new FaultyFiles(memory).fail('write', `${FOLDER}/hooks/core/rows.js`, systemError('ENOSPC'));
    await assert.rejects(installArchive(files, FOLDER, ARCHIVE, PIN), /ENOSPC/);
    assert.equal(memory.get(MARK), undefined);
    assert.equal(await installedEntry(memory, FOLDER, OTHER), undefined);
    assert.equal(await installedEntry(memory, FOLDER, PIN), undefined);
  });

  it('writes over the files of another archive of the same version', async () => {
    const files = new MemoryFiles();
    await installArchive(files, FOLDER, { ...ARCHIVE, files: [{ path: 'ui/main.js', text: 'old\n' }] }, OTHER);
    await installArchive(files, FOLDER, ARCHIVE, PIN);
    assert.equal(files.get(ENTRY), 'export {};\n');
    assert.equal(await installedEntry(files, FOLDER, OTHER), undefined);
  });
});

describe('installedEntry', () => {
  it('answers the entry of the folder installed from the pinned archive, the pin in either case', async () => {
    const files = new MemoryFiles();
    await installArchive(files, FOLDER, ARCHIVE, PIN.toUpperCase());
    assert.equal(normalisePath((await installedEntry(files, FOLDER, PIN)) ?? ''), ENTRY);
    assert.equal(normalisePath((await installedEntry(files, FOLDER, PIN.toUpperCase())) ?? ''), ENTRY);
  });

  it('answers nothing for an empty folder, files without a mark, or another archive', async () => {
    assert.equal(await installedEntry(new MemoryFiles(), FOLDER, PIN), undefined);
    assert.equal(await installedEntry(new MemoryFiles({ [ENTRY]: 'export {};\n' }), FOLDER, PIN), undefined);
    const files = new MemoryFiles();
    await installArchive(files, FOLDER, ARCHIVE, OTHER);
    assert.equal(await installedEntry(files, FOLDER, PIN), undefined);
  });

  it('answers nothing when the entry script is gone', async () => {
    const files = new MemoryFiles();
    await installArchive(files, FOLDER, ARCHIVE, PIN);
    await files.remove(ENTRY);
    assert.equal(await installedEntry(files, FOLDER, PIN), undefined);
  });

  it('answers nothing for a mark it cannot read or whose entry could leave the folder', async () => {
    const marks = ['', '{ not json', '[]', '"text"', JSON.stringify({ sha256: PIN }), JSON.stringify({ sha256: 7, entry: 'ui/main.js' }), JSON.stringify({ sha256: PIN, entry: '../../evil.js' })];
    for (const mark of marks) {
      const files = new MemoryFiles({ [MARK]: mark, [ENTRY]: 'export {};\n', '/kit/evil.js': '' });
      assert.equal(await installedEntry(files, FOLDER, PIN), undefined, mark);
    }
  });
});
