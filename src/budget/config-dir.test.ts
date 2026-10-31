import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NewerDataError } from '../core/jsonl.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { CONFIG_DIR_FORMAT, formatConfigDirRecord, readConfigDir, recordConfigDir } from './config-dir.ts';

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

  it('refuses to overwrite a record of a newer format, and replaces a damaged one', async () => {
    const files = new MemoryFiles();
    const newer = `${JSON.stringify({ v: CONFIG_DIR_FORMAT + 1, configDir: HOME_DIR })}\n`;
    await files.write(RECORD, newer);
    await assert.rejects(recordConfigDir(files, RECORD, WORK_DIR), NewerDataError);
    assert.equal(files.get(RECORD), newer);
    await files.write(RECORD, '{"v":1,');
    await recordConfigDir(files, RECORD, WORK_DIR);
    assert.equal(await readConfigDir(files, RECORD), WORK_DIR);
  });

  it('writes the pinned fields of its format: a field added to the record raises CONFIG_DIR_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = { 1: ['configDir', 'v'] };
    assert.deepEqual(fieldPaths(JSON.parse(formatConfigDirRecord(HOME_DIR))), written[CONFIG_DIR_FORMAT]);
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
