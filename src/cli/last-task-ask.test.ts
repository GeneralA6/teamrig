import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, TEAM_HOME, type CliHarness, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { HELPER_HANDOVER, LEAD_TEAM, ok, teamWithHelper } from '../testing/hired-team.ts';

const AUTOMATIC: JsonRecord = { ...LEAD_TEAM, hiring: { policy: 'automatic' } };
const ASK = join(TEAM_HOME, 'state', 'last-task-asks', 'helper.json');
const STALE = '{"v":1,"task":"T1","at":"2030-01-08T10:00:00.000Z"}\n';

function close(kit: CliHarness, id: string, status: 'done' | 'dropped' = 'done', files?: FaultyFiles): Promise<CliResult> {
  const closing = status === 'done' ? ['--evidence', 'abc1234', '--skill', 'none', '--followups', 'none'] : [];
  return kit.run(['set', id, '--status', status, '--note', 'finished', ...closing, '--session', 'helper'], files === undefined ? {} : { files });
}

function stop(kit: CliHarness, session = 'helper', active = false, files?: FaultyFiles): Promise<CliResult> {
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, stop_hook_active: active });
  return kit.run(['hook', 'stop'], { stdin, env: { TEAMRIG_SESSION: session }, ...(files === undefined ? {} : { files }) });
}

/** The Stop hook's block reason; undefined when it did not block. */
function blockReason(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '{}');
  return isRecord(parsed) && parsed['decision'] === 'block' && typeof parsed['reason'] === 'string' ? parsed['reason'] : undefined;
}

describe('the automatic last-task ask', () => {
  it('asks a hired session whose last open task closed to write its handover and retire, at one stop only', async () => {
    const kit = await teamWithHelper(AUTOMATIC, ['port it', 'test it'], false);
    ok(await close(kit, 'T1'));
    assert.equal(kit.files.get(ASK), undefined, 'T2 is still open');
    ok(await close(kit, 'T2', 'dropped'));
    assert.match(kit.files.get(ASK) ?? '', /"task":"T2"/);
    assert.equal(blockReason(await stop(kit, 'helper', true)), undefined, 'a stop the hook already blocked keeps the ask');
    assert.equal(blockReason(await stop(kit, 'alpha')), undefined);
    const reason = blockReason(await stop(kit));
    assert.ok(reason?.startsWith(`Your last open task T2 is closed. Write your handover to ${HELPER_HANDOVER} `), reason);
    assert.ok(reason?.includes('Do not retire: your leader decides which workers the team needs'), reason);
    assert.equal(kit.files.get(ASK), undefined);
    assert.deepEqual((await stop(kit)).stdout, []);
  });

  it('refuses the session retiring itself, and a lead\'s retire clears any ask left', async () => {
    const kit = await teamWithHelper(AUTOMATIC, ['port it']);
    ok(await close(kit, 'T1'));
    const self = await kit.run(['retire', 'helper', '--yes', '--session', 'helper']);
    assert.match(self.stdout.join('\n'), /^REFUSED only a lead over the session retires it/);
    assert.match(kit.files.get(ASK) ?? '', /"task":"T1"/);
    ok(await kit.run(['retire', 'helper', '--yes', '--session', 'lead']));
    assert.equal(kit.files.get(ASK), undefined);
  });

  it('drops the ask when a task came in before the stop, and asks no session off the team', async () => {
    const kit = await teamWithHelper(AUTOMATIC, ['port it']);
    ok(await close(kit, 'T1'));
    ok(await kit.run(['add', '--owner', 'helper', '--title', 'more', '--description', 'the next job', '--priority', 'p2', '--session', 'lead']));
    assert.equal(blockReason(await stop(kit)), undefined);
    assert.equal(kit.files.get(ASK), undefined);
    const gone = await teamWithHelper(AUTOMATIC, ['port it']);
    ok(await gone.run(['retire', 'helper', '--to', 'alpha', '--yes', '--session', 'lead']));
    await gone.files.write(ASK, STALE);
    assert.deepEqual((await stop(gone)).stdout, [], 'the hook runs for no session off the team');
  });

  it('asks nobody under another policy', async () => {
    const kit = await teamWithHelper(LEAD_TEAM, ['port it']);
    ok(await close(kit, 'T1'));
    assert.equal(kit.files.get(ASK), undefined);
    await kit.files.write(ASK, STALE);
    assert.equal(blockReason(await stop(kit)), undefined);
  });

  it('only warns when the ask cannot be recorded: the task stays closed', async () => {
    const kit = await teamWithHelper(AUTOMATIC, ['port it']);
    const files = new FaultyFiles(kit.files).fail('write', ASK, systemError('EACCES'));
    const result = ok(await close(kit, 'T1', 'done', files));
    assert.ok(result.stderr.some((line) => line.startsWith('WARN T1 is closed, but the ask for helper to write its handover was not recorded: ')), result.stderr.join('\n'));
    assert.match(ok(await kit.run(['show', 'T1', '--session', 'lead'])).stdout.join('\n'), /done/);
  });

  it('never fails the Stop hook when the ask cannot be read', async () => {
    const kit = await teamWithHelper(AUTOMATIC, ['port it']);
    ok(await close(kit, 'T1'));
    const files = new FaultyFiles(kit.files).fail('read', ASK, systemError('EACCES'));
    assert.deepEqual(ok(await stop(kit, 'helper', false, files)).stdout, []);
    assert.ok(blockReason(await stop(kit)), 'the ask waits for a stop that can read it');
  });
});
