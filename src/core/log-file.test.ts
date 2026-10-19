import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { PlainLogFile } from './log-file.ts';

const LOG = 'state/bind-hints.jsonl';

describe('PlainLogFile', () => {
  it('reads nothing before its first append, then what was appended in order', async () => {
    const files = new MemoryFiles();
    const log = new PlainLogFile(files, LOG);
    assert.equal(await log.read(), undefined);
    await log.append('{"v":1}\n');
    await log.append('{"v":2}\n');
    assert.equal(await log.read(), '{"v":1}\n{"v":2}\n');
    assert.equal(await files.read(LOG), '{"v":1}\n{"v":2}\n');
  });
});
