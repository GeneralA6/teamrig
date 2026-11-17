import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { LOG_SIZE_WARN_BYTES, logSizeWarnings } from './log-size-check.ts';
import { EXIT } from './runtime.ts';

const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const STATE = join(TEAM_HOME, 'state');
const INBOX = join(STATE, 'inbox');

/** A text of `bytes` bytes. */
const sized = (bytes: number): string => 'x'.repeat(bytes);

describe('logSizeWarnings: a team file near the task pane read limit (T3482)', () => {
  it('warns of a state or inbox file at three quarters of the limit, and not of one under it', async () => {
    const files = new MemoryFiles({
      [join(STATE, 'snapshot.jsonl')]: sized(LOG_SIZE_WARN_BYTES),
      [join(STATE, 'events.jsonl')]: sized(LOG_SIZE_WARN_BYTES - 1),
      [join(INBOX, 'lead.md')]: sized(LOG_SIZE_WARN_BYTES + 1),
    });
    const warnings = await logSizeWarnings(files, { state: STATE, inbox: INBOX });
    assert.deepEqual(warnings.map((warning) => [warning.key, warning.source]), [
      [`log-size ${join(STATE, 'snapshot.jsonl')}`, `the log size check of ${STATE}`],
      [`log-size ${join(INBOX, 'lead.md')}`, `the log size check of ${INBOX}`],
    ]);
  });

  it("never reads a subfolder whole: the archive and the step logs are not the pane's", async () => {
    const files = new MemoryFiles({
      [join(STATE, 'archive', 'events-000001.jsonl')]: sized(LOG_SIZE_WARN_BYTES),
      [join(STATE, 'logs', 'test-1.log')]: sized(LOG_SIZE_WARN_BYTES),
    });
    assert.deepEqual(await logSizeWarnings(files, { state: STATE, inbox: INBOX }), []);
  });

  it('reads an inbox kept inside the state folder once', async () => {
    const files = new MemoryFiles({ [join(STATE, 'goals.jsonl')]: sized(LOG_SIZE_WARN_BYTES) });
    assert.equal((await logSizeWarnings(files, { state: STATE, inbox: STATE })).length, 1);
  });
});

describe('check LOG-SIZE', () => {
  it("gives the lead the warning, naming the file, its size and the pane's limit", async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(STATE, 'snapshot.jsonl'), sized(LOG_SIZE_WARN_BYTES));
    const result = await kit.run(['check', '--all'], AS_LEAD);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout.filter((line) => line.includes('the log size check')), [
      `from the log size check of ${STATE}: LOG-SIZE ${join(STATE, 'snapshot.jsonl')} is 3.0 MiB, near the 4.0 MiB the task pane reads of a file at once, ` +
        `past which the pane stops reading it: archive or trim it (teamrig compact archives the task list and the hooks' records)`,
    ]);
  });
});
