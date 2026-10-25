import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { ok } from '../testing/hired-team.ts';

const ASK = join(TEAM_HOME, 'state', 'keep-working-asks', 'alpha.json');
/** Quiet from 09:00 to 11:00 UTC: the harness clock reads 10:00. */
const QUIET: JsonRecord = {
  ...TEAM,
  budget: { enabled: true, weeklyLimitW: 1_000_000_000, overAction: 'ask-lead', quietHours: { startUtc: '09:00', endUtc: '11:00', action: 'ask' } },
};

/** A task alpha owns: its title, priority and the task it comes after, if any. */
type Owned = readonly [title: string, priority: string, after?: string];

/** A team where alpha owns T1, a task to wait, then each task given. */
async function teamOf(config: JsonRecord, tasks: readonly Owned[]): Promise<CliHarness> {
  const kit = new CliHarness(config);
  const owned: readonly Owned[] = [['Pick the plan', 'p2'], ...tasks];
  for (const [title, priority, after] of owned) {
    const add = ['add', '--owner', 'alpha', '--title', title, '--description', 'the job', '--priority', priority];
    ok(await kit.run([...add, ...(after === undefined ? [] : ['--after', after]), '--session', 'lead']));
  }
  return kit;
}

function wait(kit: CliHarness, files?: FaultyFiles): Promise<CliResult> {
  const waiting = ['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two plans', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha'];
  return kit.run(waiting, files === undefined ? {} : { files });
}

function stop(kit: CliHarness, session = 'alpha', active = false, files?: FaultyFiles): Promise<CliResult> {
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, stop_hook_active: active });
  return kit.run(['hook', 'stop'], { stdin, env: { TEAMRIG_SESSION: session }, ...(files === undefined ? {} : { files }) });
}

/** The Stop hook's block reason; undefined when it did not block. */
function blockReason(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '{}');
  return isRecord(parsed) && parsed['decision'] === 'block' && typeof parsed['reason'] === 'string' ? parsed['reason'] : undefined;
}

describe('the keep-working ask', () => {
  it('sends a session whose task went waiting to its work that does not come after it, at one stop only', async () => {
    const kit = await teamOf(TEAM, [
      ['Fix the login', 'p1'],
      ['Ship the plan', 'p1', 'T1'],
    ]);
    ok(await wait(kit));
    assert.match(kit.files.get(ASK) ?? '', /"task":"T1"/);
    assert.equal(blockReason(await stop(kit, 'alpha', true)), undefined, 'a stop the hook already blocked keeps the ask');
    assert.equal(blockReason(await stop(kit, 'bravo')), undefined);
    const reason = blockReason(await stop(kit));
    assert.ok(reason?.startsWith('T1 waits (decision owner), and you own work that does not come after it: T2 "Fix the login" (p1). '), reason);
    assert.ok(reason?.includes('`teamrig list --session alpha`'), reason);
    assert.ok(!reason?.includes('T3'), 'T3 comes after T1');
    assert.equal(kit.files.get(ASK), undefined);
    assert.equal(blockReason(await stop(kit)), undefined);
  });

  it('records the ask for the caller of set --ask, whose task now waits on a peer', async () => {
    const kit = await teamOf(TEAM, [['Fix the login', 'p2']]);
    ok(await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']));
    ok(await kit.run(['set', 'T1', '--status', 'waiting', '--ask', 'bravo', '--text', 'Review the plan', '--session', 'alpha']));
    assert.match(kit.files.get(ASK) ?? '', /"task":"T1"/);
    const reason = blockReason(await stop(kit));
    assert.ok(reason?.startsWith('T1 waits (on T3), and you own work that does not come after it: T2 "Fix the login" (p2). '), reason);
  });

  it('ends the turn as it would with only dependent work left, or once the task stopped waiting', async () => {
    const dependent = await teamOf(TEAM, [['Ship the plan', 'p1', 'T1']]);
    ok(await wait(dependent));
    assert.equal(blockReason(await stop(dependent)), undefined);
    assert.equal(dependent.files.get(ASK), undefined, 'the ask is taken even when it sends nobody back');
    const resumed = await teamOf(TEAM, [['Fix the login', 'p1']]);
    ok(await wait(resumed));
    ok(await resumed.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']));
    assert.equal(blockReason(await stop(resumed)), undefined);
  });

  it('sends nobody back in quiet hours: the day-start wake brings the session back to its work', async () => {
    const kit = await teamOf(QUIET, [['Fix the login', 'p1']]);
    ok(await wait(kit));
    assert.equal(blockReason(await stop(kit)), undefined);
    assert.equal(kit.files.get(ASK), undefined);
  });

  it('only warns when the ask cannot be recorded: the task still waits', async () => {
    const kit = await teamOf(TEAM, [['Fix the login', 'p1']]);
    const files = new FaultyFiles(kit.files).fail('write', ASK, systemError('EACCES'));
    const result = ok(await wait(kit, files));
    assert.ok(result.stderr.some((line) => line.startsWith('WARN T1 is waiting, but the ask for alpha to keep working was not recorded: ')), result.stderr.join('\n'));
    assert.match(ok(await kit.run(['show', 'T1', '--session', 'lead'])).stdout.join('\n'), /waiting/);
  });

  it('never fails the Stop hook when the ask cannot be read', async () => {
    const kit = await teamOf(TEAM, [['Fix the login', 'p1']]);
    ok(await wait(kit));
    const files = new FaultyFiles(kit.files).fail('read', ASK, systemError('EACCES'));
    assert.equal(blockReason(ok(await stop(kit, 'alpha', false, files))), undefined);
    assert.ok(blockReason(await stop(kit)), 'the ask waits for a stop that can read it');
  });
});
