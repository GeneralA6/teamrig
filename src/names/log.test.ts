import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { renameOf } from '../testing/rename.ts';
import { JsonlRenameLog } from './log.ts';

const PATH = join('/', 'state', 'renames.jsonl');

describe('JsonlRenameLog', () => {
  it('reads an empty log when the file does not exist yet', async () => {
    assert.deepEqual(await new JsonlRenameLog(new MemoryFiles(), PATH).read(), { renames: [], unreadable: 0, newer: 0 });
  });

  it('appends one whole line per rename and reads them back in order', async () => {
    const files = new MemoryFiles();
    const log = new JsonlRenameLog(files, PATH);
    const renames = [renameOf('alpha', 'app-alpha', 'scout'), renameOf('alpha', 'scout', 'ranger', { by: 'lead' })];
    for (const rename of renames) {
      await log.append(rename);
    }
    assert.equal(files.get(PATH)?.split('\n').length, 3);
    assert.deepEqual(await log.read(), { renames, unreadable: 0, newer: 0 });
  });

  it('starts a new line after a last line written without one', async () => {
    const first = renameOf('alpha', 'app-alpha', 'scout');
    const second = renameOf('bravo', 'app-bravo', 'ranger');
    const log = new JsonlRenameLog(new MemoryFiles({ [PATH]: JSON.stringify(first) }), PATH);
    await log.append(second);
    assert.deepEqual((await log.read()).renames, [first, second]);
  });

  it('counts damaged lines and newer records apart, and still reads the rest', async () => {
    const good = renameOf('alpha', 'app-alpha', 'scout');
    const text = ['{torn', JSON.stringify({ ...good, v: 9 }), JSON.stringify({ ...good, to: '' }), JSON.stringify(good)].join('\n');
    const log = new JsonlRenameLog(new MemoryFiles({ [PATH]: text }), PATH);
    assert.deepEqual(await log.read(), { renames: [good], unreadable: 2, newer: 1 });
  });
});
