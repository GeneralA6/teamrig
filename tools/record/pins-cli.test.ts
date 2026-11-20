import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinsIn, recordedPins } from '../../src/testing/recorded-pins.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./pins-cli.ts', import.meta.url));

describe('pins cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('pins-cli');
  });
  afterEach(() => {
    repo.remove();
  });

  it("writes what teamrig does with the recorded session to the recording's expected folder", async () => {
    const pins = await recordedPins('claude-code');
    const out = join(repo.dir, 'src', 'testing', 'recorded', 'claude-code', 'expected');
    const result = repo.run(CLI);
    assert.deepEqual(result, { status: 0, stdout: `pins: ${Object.keys(pins).length} file(s) written to ${out}\n`, stderr: '' });
    assert.deepEqual(pinsIn(out), pins);
  });

  it('writes to the folder it is told, removes the pin of an event that is no longer recorded and keeps what is no pin', async () => {
    repo.write('pins/hooks/Old.json', '[]\n');
    repo.write('pins/notes.md', 'kept\n');
    const result = repo.run(CLI, ['--out', 'pins']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^pins: \d+ file\(s\) written to .+pins\n$/);
    assert.deepEqual(pinsIn(join(repo.dir, 'pins')), { ...(await recordedPins('claude-code')), 'notes.md': 'kept\n' });
    assert.equal(repo.has('src'), false);
  });

  it('exits 2 on an option it does not know, and writes nothing', () => {
    const result = repo.run(CLI, ['--nope']);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^pins: Unknown option '--nope'/);
    assert.equal(repo.has('src'), false);
  });
});
