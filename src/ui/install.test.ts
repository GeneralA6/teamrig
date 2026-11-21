import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { ARCHIVE_FORMAT, readArchive, sha256Hex, type UiArchive } from './archive.ts';
import { INSTALLED_MARK, installArchive, installedEntry, stagingFolder, uiFolder, type Installed } from './install.ts';

const FILES = [
  { path: 'package.json', text: '{"type":"module"}\n' },
  { path: 'ui/main.js', text: 'export {};\n' },
  { path: 'hooks/core/rows.js', text: 'export const rows = 1;\n' },
];

function sourceOf(files: UiArchive['files']): string {
  return `${JSON.stringify({ format: ARCHIVE_FORMAT, version: '0.77.0', interface: '1.0', entry: 'ui/main.js', files })}\n`;
}

const SOURCE = sourceOf(FILES);
const PIN = sha256Hex(new TextEncoder().encode(SOURCE));
const OTHER_SOURCE = sourceOf([{ path: 'ui/main.js', text: 'old\n' }]);
const OTHER = sha256Hex(new TextEncoder().encode(OTHER_SOURCE));

function archiveOf(source: string, pin: string): UiArchive {
  const read = readArchive(new TextEncoder().encode(source), pin);
  assert.ok(read.ok, read.ok ? '' : read.reason);
  return read.archive;
}

const ARCHIVE = archiveOf(SOURCE, PIN);
const FOLDER = `/kit/ui/0.77.0-${PIN}`;
const STAGING = '/kit/ui/.staging-n1';
const MARK = `${FOLDER}/${INSTALLED_MARK}`;
const ENTRY = `${FOLDER}/ui/main.js`;

async function installed(files: MemoryFiles): Promise<MemoryFiles> {
  await installArchive(files, FOLDER, STAGING, ARCHIVE, SOURCE);
  return files;
}

function entryOf(result: Installed): string {
  assert.equal(result.state, 'ok', result.state === 'changed' ? result.reason : result.state);
  return result.state === 'ok' ? normalisePath(result.entry) : '';
}

describe('uiFolder and stagingFolder', () => {
  it('names the folder by the version and the whole pin, in lowercase', () => {
    assert.equal(normalisePath(uiFolder('/kit', '0.77.0', PIN.toUpperCase())), FOLDER);
  });

  it('stages beside the installed folders, under a dot name no version takes', () => {
    assert.equal(normalisePath(stagingFolder('/kit', 'n1')), STAGING);
  });
});

describe('installArchive', () => {
  it('writes each file and the archive text as the mark, moves them into the folder whole and answers the entry', async () => {
    const files = new MemoryFiles();
    assert.equal(normalisePath(await installArchive(files, FOLDER, STAGING, ARCHIVE, SOURCE)), ENTRY);
    assert.deepEqual(files.paths(), [MARK, `${FOLDER}/hooks/core/rows.js`, `${FOLDER}/package.json`, ENTRY]);
    assert.equal(files.get(MARK), SOURCE);
  });

  it('leaves no file in the folder or the staging folder when a write fails', async () => {
    const memory = new MemoryFiles();
    const files = new FaultyFiles(memory).fail('write', `${STAGING}/hooks/core/rows.js`, systemError('ENOSPC'));
    await assert.rejects(installArchive(files, FOLDER, STAGING, ARCHIVE, SOURCE), /ENOSPC/);
    assert.deepEqual(memory.paths(), []);
    assert.deepEqual(await installedEntry(memory, FOLDER, PIN), { state: 'none' });
  });

  it('leaves no file when the mark cannot be written, so no folder counts as installed', async () => {
    const memory = new MemoryFiles();
    const files = new FaultyFiles(memory).fail('write', `${STAGING}/${INSTALLED_MARK}`, systemError('EIO'));
    await assert.rejects(installArchive(files, FOLDER, STAGING, ARCHIVE, SOURCE), /EIO/);
    assert.deepEqual(memory.paths(), []);
  });

  it('never writes into a folder already there: the move fails and the staged files go', async () => {
    const memory = await installed(new MemoryFiles());
    await memory.write(ENTRY, 'edited\n');
    await assert.rejects(installArchive(memory, FOLDER, '/kit/ui/.staging-n2', ARCHIVE, SOURCE), /exists already/);
    assert.equal(memory.get(ENTRY), 'edited\n');
    assert.deepEqual(await memory.list('/kit/ui/.staging-n2'), []);
  });
});

describe('installedEntry', () => {
  it('answers the entry of an untouched install, the pin in either case', async () => {
    const files = await installed(new MemoryFiles());
    assert.equal(entryOf(await installedEntry(files, FOLDER, PIN)), ENTRY);
    assert.equal(entryOf(await installedEntry(files, FOLDER, PIN.toUpperCase())), ENTRY);
  });

  it('answers none for a folder that is not there', async () => {
    assert.deepEqual(await installedEntry(new MemoryFiles(), FOLDER, PIN), { state: 'none' });
  });

  it('refuses an edited file, the entry or any other', async () => {
    for (const path of [ENTRY, `${FOLDER}/hooks/core/rows.js`]) {
      const files = await installed(new MemoryFiles());
      await files.write(path, 'process.exit(0);\n');
      const relative = path.slice(FOLDER.length + 1);
      assert.deepEqual(await installedEntry(files, FOLDER, PIN), { state: 'changed', reason: `${relative} was changed` });
    }
  });

  it('refuses a missing file', async () => {
    const files = await installed(new MemoryFiles());
    await files.remove(`${FOLDER}/package.json`);
    assert.deepEqual(await installedEntry(files, FOLDER, PIN), { state: 'changed', reason: 'package.json is missing' });
  });

  it('refuses an extra file, at the top or deep in a folder', async () => {
    for (const extra of ['loader.js', 'hooks/core/rows.js.bak', 'node_modules/x/index.js']) {
      const files = await installed(new MemoryFiles());
      await files.write(`${FOLDER}/${extra}`, '');
      assert.deepEqual(await installedEntry(files, FOLDER, PIN), { state: 'changed', reason: `${extra} is not one of its files` });
    }
  });

  it('refuses a mark that is gone, edited to name other files, or not the pinned archive', async () => {
    const gone = await installed(new MemoryFiles());
    await gone.remove(MARK);
    assert.deepEqual(await installedEntry(gone, FOLDER, PIN), { state: 'changed', reason: `its mark ${INSTALLED_MARK} is missing` });

    for (const mark of [sourceOf([...FILES.slice(0, 2), { path: 'hooks/core/rows.js', text: 'process.exit(0);\n' }]), OTHER_SOURCE, '', '{ not json']) {
      const files = await installed(new MemoryFiles());
      await files.write(MARK, mark);
      const result = await installedEntry(files, FOLDER, PIN);
      assert.equal(result.state, 'changed', mark);
      assert.match(result.state === 'changed' ? result.reason : '', /^its mark \.installed is not the pinned archive: its sha256 is [0-9a-f]{64}, not the pinned [0-9a-f]{64}$/);
    }
  });

  it('holds the folder to the pin it is asked for, not to the one it was installed with', async () => {
    const files = await installed(new MemoryFiles());
    assert.equal((await installedEntry(files, FOLDER, OTHER)).state, 'changed');
  });
});
