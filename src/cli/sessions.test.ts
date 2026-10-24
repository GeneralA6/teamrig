import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SessionRecordStore } from '../sessions/record.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';

const MB = 2 ** 20;
const SESSIONS = join(TEAM_HOME, 'state', 'sessions');

/** A team whose lead last started in Claude Code 6900 (still running, with a shell) and alpha in 7100 (ended). */
async function recordedTeam(): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
  await store.write('lead', { claudePid: 6900, claudeSession: 'claude-lead', at: '2030-01-08T09:00:00.000Z' });
  await store.write('alpha', { claudePid: 7100, claudeSession: 'claude-alpha', at: '2030-01-08T09:30:00.000Z' });
  return kit;
}

/** As a `ps` list gives them: resident memory only. */
const ROWS = [
  { pid: 6900, parent: 1, bytes: 700 * MB },
  { pid: 6901, parent: 6900, bytes: 150 * MB },
  { pid: 9000, parent: 1, bytes: 4000 * MB },
];

/** As Windows gives them: what each process committed too. */
const COMMITTED_ROWS = [
  { pid: 6900, parent: 1, bytes: 700 * MB, committed: 1600 * MB },
  { pid: 6901, parent: 6900, bytes: 150 * MB, committed: 300 * MB },
  { pid: 9000, parent: 1, bytes: 4000 * MB, committed: 5000 * MB },
];

describe('teamrig sessions', () => {
  it('prints where each session runs and the memory its Claude Code holds and committed, then the host', async () => {
    const kit = await recordedTeam();
    const memory = new FakeHostMemory().lists(COMMITTED_ROWS, { usedMb: 85_300, limitMb: 100_700 });
    memory.free = 21_400;
    const result = await kit.run(['sessions'], { memory });
    assert.equal(result.code, 0, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      'lead app-lead: running in Claude Code 6900, 850 MB, 1900 MB committed',
      'alpha app-alpha: closed: the Claude Code it last started in has ended',
      'bravo app-bravo: no start recorded',
      '1 running hold 850 MB, 1900 MB committed; 1 closed; 1 with no start recorded',
      'host: 21400 MB free; commit 85300 of 100700 MB (85%)',
    ]);
  });

  it('leaves out what is committed where the host does not say', async () => {
    const result = await (await recordedTeam()).run(['sessions'], { memory: new FakeHostMemory().lists(ROWS) });
    assert.deepEqual(result.stdout.slice(0, 1), ['lead app-lead: running in Claude Code 6900, 850 MB']);
    assert.equal(result.stdout[3], '1 running hold 850 MB; 1 closed; 1 with no start recorded');
  });

  it('says so when the host cannot list its processes or give its commit charge', async () => {
    const kit = await recordedTeam();
    const result = await kit.run(['sessions'], { memory: new FakeHostMemory().lists(undefined) });
    assert.deepEqual(result.stdout, [
      "teamrig could not list the host's processes, so it cannot tell which sessions run.",
      'host: 8000 MB free; commit charge unknown on this system',
    ]);
  });

  it('refuses an argument', async () => {
    const result = await (await recordedTeam()).run(['sessions', 'alpha']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr.join('\n'), /unexpected "alpha"/);
  });
});
