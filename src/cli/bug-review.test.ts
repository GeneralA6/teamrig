import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';
import { REGISTER_ONLY_LINE } from './commands/register.ts';

/** Every part a bug's review needs, as `set` flags. */
const REVIEW = [
  '--cause',
  'the parser skipped blank rows',
  '--how',
  'a refactor dropped the guard',
  '--prevent',
  'the reader now refuses blank rows',
  '--missed-test',
  'T2 adds a spec feeding blank rows',
  '--missed-monitor',
  'no monitor can see a skipped row',
  '--missed-log',
  'the skip now logs a warning line',
];
const DONE = ['set', 'T1', '--status', 'done', '--note', 'fixed', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'alpha'];

/** A harness holding T1, a bug alpha has started, and T2, the spec its review names. */
async function startedBug(kit = new CliHarness()): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Fix the blank-row skip', '--description', 'what and why', '--priority', 'p2', '--type', 'bug', '--session', 'alpha']);
  await kit.run(['add', '--title', 'Add a blank-row spec', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  return kit;
}

describe("runCli: a bug's review (T916)", () => {
  it('refuses done until the review is given, then shows it, its follow-up and its history', async () => {
    const kit = await startedBug();
    const refused = await kit.run(DONE);
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout[0] ?? '', /^REFUSED T1 is a bug: done needs its review, --cause, --how, --prevent, --missed-test, --missed-monitor and --missed-log \(/);

    const done = await kit.run([...DONE, ...REVIEW]);
    assert.equal(done.code, EXIT.ok, done.stdout.join('\n'));
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n');
    assert.match(shown, /\nfollowups: T2\n/);
    assert.match(shown, /\nreview:\n {2}cause: the parser skipped blank rows\n {2}how it happened: a refactor dropped the guard\n/);
    assert.match(shown, / review=cause,how,prevent,missed-test,missed-monitor,missed-log/);
  });

  it('takes the parts across sets, a part given while working counting at done', async () => {
    const kit = await startedBug();
    const working = await kit.run(['set', 'T1', '--status', 'in-progress', ...REVIEW.slice(0, 4), '--session', 'alpha']);
    assert.equal(working.code, EXIT.ok, working.stdout.join('\n'));
    const done = await kit.run([...DONE, ...REVIEW.slice(4)]);
    assert.equal(done.code, EXIT.ok, done.stdout.join('\n'));
  });

  it('sets done in warn mode, warning of the parts still missing', async () => {
    const kit = await startedBug(new CliHarness({ ...TEAM, register: { review: { mode: 'warn' } } }));
    const done = await kit.run([...DONE, '--cause', 'the parser skipped blank rows']);
    assert.equal(done.code, EXIT.ok, done.stdout.join('\n'));
    assert.deepEqual(done.stderr, [
      'WARN T1 is a bug: done needs its review, --how, --prevent, --missed-test, --missed-monitor and --missed-log ' +
        '(how it happened, what stops it and how it was missed; teamrig help set); set anyway, as register.review.mode is warn',
      REGISTER_ONLY_LINE,
    ]);
  });

  it('refuses a blank part as a usage error, and a part on a task no one marked a bug', async () => {
    const kit = await startedBug();
    const blank = await kit.run(['set', 'T1', '--status', 'in-progress', '--cause', ' ', '--session', 'alpha']);
    assert.equal(blank.code, EXIT.usage);
    assert.match(blank.stderr[0] ?? '', /^--cause needs text/);
    const work = await kit.run(['set', 'T2', '--status', 'in-progress', '--how', 'a refactor dropped the guard', '--session', 'alpha']);
    assert.deepEqual([work.code, work.stdout], [EXIT.refused, ['REFUSED --how goes only with a bug: mark it first, teamrig update T2 --type bug']]);
  });
});
