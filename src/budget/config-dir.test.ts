import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { readConfigDir, recordConfigDir } from './config-dir.ts';

const RECORD = join('/', 'kit', 'teams', 'app', 'state', 'usage', 'claude-config-dir.json');
const HOME_DIR = join('/', 'u', '.claude');
const WORK_DIR = join('/', 'u', '.claude-work');

describe('the recorded Claude config dir', () => {
  it('reads back what was recorded, and the newest record after a change', async () => {
    const files = new MemoryFiles();
    await recordConfigDir(files, RECORD, HOME_DIR);
    assert.equal(await readConfigDir(files, RECORD), HOME_DIR);
    await recordConfigDir(files, RECORD, WORK_DIR);
    assert.equal(await readConfigDir(files, RECORD), WORK_DIR);
  });

  it('writes nothing when the record already names the dir', async () => {
    const memory = new MemoryFiles();
    await recordConfigDir(memory, RECORD, HOME_DIR);
    const files = new FaultyFiles(memory).fail('write', RECORD, systemError('EACCES'));
    await recordConfigDir(files, RECORD, HOME_DIR);
    await assert.rejects(recordConfigDir(files, RECORD, WORK_DIR), /EACCES/);
  });

  it('reads as none when nothing is recorded, the record is damaged, of another format, or cannot be read', async () => {
    const files = new MemoryFiles();
    assert.equal(await readConfigDir(files, RECORD), undefined);
    await files.write(RECORD, '{"v":1,"configDir":');
    assert.equal(await readConfigDir(files, RECORD), undefined);
    await files.write(RECORD, `${JSON.stringify({ v: 2, configDir: HOME_DIR })}\n`);
    assert.equal(await readConfigDir(files, RECORD), undefined);
    await files.write(RECORD, `${JSON.stringify({ v: 1, configDir: 7 })}\n`);
    assert.equal(await readConfigDir(files, RECORD), undefined);
    const faulty = new FaultyFiles(new MemoryFiles()).fail('read', RECORD, systemError('EACCES'));
    assert.equal(await readConfigDir(faulty, RECORD), undefined);
  });
});
