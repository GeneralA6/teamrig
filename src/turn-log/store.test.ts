import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { TurnLogEntry } from './entry.ts';
import { hourOf, TurnLog } from './store.ts';

const DIR = join('/', 'kit', 'teams', 'app', 'state', 'turn-log');
const CLAUDE = '0123abcd-0000-4000-8000-00000000000a';

function entry(at: string, text: string): TurnLogEntry {
  return { at, kind: 'prompt', text, claude: CLAUDE };
}

/** The log's files, below its folder. */
function namesOf(files: MemoryFiles): string[] {
  return files.paths().map((path) => path.slice(path.indexOf('/turn-log/') + '/turn-log/'.length));
}

describe('TurnLog', () => {
  it("names an entry's file by its UTC hour", () => {
    assert.equal(hourOf('2030-01-08T09:59:59.999Z'), '2030-01-08T09');
    assert.equal(hourOf('2030-01-08T12:30:00+02:00'), '2030-01-08T10');
  });

  it("appends each entry to its hour's file and reads the session's last one back", async () => {
    const files = new MemoryFiles();
    const log = new TurnLog(files, DIR);
    assert.equal(await log.last('alpha'), undefined);
    await log.append('alpha', entry('2030-01-08T09:59:00.000Z', 'first'));
    await log.append('alpha', entry('2030-01-08T10:01:00.000Z', 'second'));
    await log.append('bravo', entry('2030-01-08T10:02:00.000Z', 'other'));
    assert.deepEqual(namesOf(files), ['alpha/2030-01-08T09.jsonl', 'alpha/2030-01-08T10.jsonl', 'bravo/2030-01-08T10.jsonl']);
    assert.equal((await log.last('alpha'))?.text, 'second');
  });

  it('skips a torn last line, as one a crash cut short', async () => {
    const files = new MemoryFiles();
    const log = new TurnLog(files, DIR);
    await log.append('alpha', entry('2030-01-08T10:01:00.000Z', 'whole'));
    await files.append(join(DIR, 'alpha', '2030-01-08T10.jsonl'), '{"v":1,"at":"2030-01-08T10:02');
    assert.equal((await log.last('alpha'))?.text, 'whole');
  });

  it("removes every session's hours that ended before the kept hours, and leaves stray files alone", async () => {
    const files = new MemoryFiles({ [join(DIR, 'README.md')]: 'not a session' });
    const log = new TurnLog(files, DIR);
    for (const at of ['2030-01-08T08:10:00.000Z', '2030-01-08T09:10:00.000Z', '2030-01-08T10:10:00.000Z']) {
      await log.append('alpha', entry(at, at));
    }
    await log.append('bravo', entry('2030-01-07T23:00:00.000Z', 'yesterday'));
    // Kept from 09:30: the 09 hour still holds kept entries, so only 08 and yesterday's 23 go.
    assert.equal(await log.prune(Date.parse('2030-01-08T10:30:00.000Z'), 1), 2);
    assert.deepEqual(namesOf(files), ['README.md', 'alpha/2030-01-08T09.jsonl', 'alpha/2030-01-08T10.jsonl']);
  });
});
