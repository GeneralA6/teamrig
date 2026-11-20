import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { LOG_SIZE_WARN_BYTES, logSizeWarnings, type LogSizePaths } from './log-size-check.ts';
import { EXIT } from './runtime.ts';

const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const STATE = join(TEAM_HOME, 'state');
const INBOX = join(STATE, 'inbox');
const PATHS: LogSizePaths = {
  state: STATE,
  inbox: INBOX,
  events: join(STATE, 'events.jsonl'),
  inboxShown: join(STATE, 'inbox-shown.jsonl'),
  bindHints: join(STATE, 'bind-hints.jsonl'),
  promptAnswers: join(STATE, 'prompt-answers.jsonl'),
};

/** A text of `bytes` bytes. */
const sized = (bytes: number): string => 'x'.repeat(bytes);

/** What the warning of `path` advises, the text after the pane's limit. */
async function remedyFor(path: string): Promise<string> {
  const [warning] = await logSizeWarnings(new MemoryFiles({ [path]: sized(LOG_SIZE_WARN_BYTES) }), PATHS);
  assert.ok(warning, `no warning of ${path}`);
  return warning.text.slice(warning.text.indexOf('stops reading it: ') + 'stops reading it: '.length);
}

describe('logSizeWarnings: a team file near the task pane read limit (T3482)', () => {
  it('warns of a state or inbox file at three quarters of the limit, and not of one under it', async () => {
    const files = new MemoryFiles({
      [join(STATE, 'snapshot.jsonl')]: sized(LOG_SIZE_WARN_BYTES),
      [join(STATE, 'events.jsonl')]: sized(LOG_SIZE_WARN_BYTES - 1),
      [join(INBOX, 'lead.md')]: sized(LOG_SIZE_WARN_BYTES + 1),
    });
    const warnings = await logSizeWarnings(files, PATHS);
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
    assert.deepEqual(await logSizeWarnings(files, PATHS), []);
  });

  it('reads an inbox kept inside the state folder once', async () => {
    const files = new MemoryFiles({ [join(STATE, 'goals.jsonl')]: sized(LOG_SIZE_WARN_BYTES) });
    assert.equal((await logSizeWarnings(files, { ...PATHS, inbox: STATE })).length, 1);
  });
});

describe("logSizeWarnings: each file's own remedy, as teamrig compact really shrinks it (T4686)", () => {
  it('sends the snapshot and the tail to compact, which folds and archives them', async () => {
    assert.equal(
      await remedyFor(join(STATE, 'snapshot.jsonl')),
      'teamrig compact rewrites it one line per kept task, the tasks done longest ago retired to the archive',
    );
    assert.equal(await remedyFor(PATHS.events), 'teamrig compact archives it whole and folds it into the snapshot');
  });

  it("sends each hook's aged log to compact, which archives its records older than a week", async () => {
    for (const path of [PATHS.inboxShown, PATHS.bindHints, PATHS.promptAnswers]) {
      assert.equal(await remedyFor(path), 'teamrig compact moves its records older than a week to the archive', path);
    }
  });

  it('says no command trims an inbox or another state log, never compact, which leaves them as they are', async () => {
    for (const path of [join(INBOX, 'lead.md'), join(STATE, 'inbox-marks.jsonl'), join(STATE, 'wakes.jsonl')]) {
      assert.equal(await remedyFor(path), 'no teamrig command trims it yet, so archive or trim it by hand', path);
    }
  });
});

describe('check LOG-SIZE', () => {
  it("gives the lead the warning, naming the file, its size, the pane's limit and the file's remedy", async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(STATE, 'snapshot.jsonl'), sized(LOG_SIZE_WARN_BYTES));
    const result = await kit.run(['check', '--all'], AS_LEAD);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout.filter((line) => line.includes('the log size check')), [
      `from the log size check of ${STATE}: LOG-SIZE ${join(STATE, 'snapshot.jsonl')} is 3.0 MiB, near the 4.0 MiB the task pane reads of a file at once, ` +
        `past which the pane stops reading it: teamrig compact rewrites it one line per kept task, the tasks done longest ago retired to the archive`,
    ]);
  });
});
