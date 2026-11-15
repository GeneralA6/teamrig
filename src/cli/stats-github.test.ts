import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EMPTY_USAGE, UsageStore } from '../budget/store.ts';
import { CliHarness, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';
import { GITHUB_TASKS_SHOWN, githubWLines } from './stats-github.ts';

function ok(result: CliResult): CliResult {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result;
}

describe('githubWLines', () => {
  const task = (id: string, ref: string | null): { id: string; ref: string | null } => ({ id, ref });

  it('names each GitHub-linked task with metered W, costliest first, and leaves out other refs, no ref and no W', () => {
    const w = new Map([['T1', 2_000_000], ['T2', 9_000_000], ['T3', 5_000_000], ['T4', 1_000_000]]);
    assert.deepEqual(githubWLines([task('T1', 'gh:acme/web#1'), task('T2', 'gh:acme/web#2'), task('T3', 'notes/plan.md'), task('T4', null), task('T5', 'gh:acme/web#5')], w), [
      'GITHUB 2 linked task(s) used 11.00M W as metered: T2 gh:acme/web#2 9.00M, T1 gh:acme/web#1 2.00M; internal, never posted',
    ]);
  });

  it('prints no line with none, and counts past the tasks it names', () => {
    assert.deepEqual(githubWLines([task('T1', 'gh:acme/web#1')], new Map()), []);
    const many = Array.from({ length: GITHUB_TASKS_SHOWN + 2 }, (_, at) => task(`T${at + 1}`, `gh:acme/web#${at + 1}`));
    const [line] = githubWLines(many, new Map(many.map((one) => [one.id, 1_000_000])));
    assert.match(line ?? '', /^GITHUB 8 linked task\(s\) used 8\.00M W as metered: .+, 2 more; internal, never posted$/);
  });
});

describe('teamrig stats: GITHUB', () => {
  it("prints the W the meter kept on the team's GitHub-linked tasks, and with --session only that session's", async () => {
    const kit = new CliHarness();
    const add = (ref: string, owner: string): Promise<CliResult> =>
      kit.run(['add', '--title', `Answer ${ref}`, '--description', 'Work tracked on an issue.', '--priority', 'p2', '--owner', owner, '--ref', ref, '--session', 'lead']);
    ok(await add('gh:acme/web#7', 'alpha'));
    ok(await add('gh:acme/web#8', 'bravo'));
    const store = new UsageStore(kit.files, join(TEAM_HOME, 'state', 'usage'));
    const { rev } = await store.load('alpha');
    assert.equal(await store.save('alpha', { ...EMPTY_USAGE, byTask: { '2030-01-08': { T1: 3_000_000, T2: 1_000_000 } } }, rev), true);
    const github = async (args: readonly string[]): Promise<string[]> => ok(await kit.run(['stats', ...args], { env: { TEAMRIG_SESSION: 'lead' } })).stdout.filter((line) => line.startsWith('GITHUB'));
    assert.deepEqual(await github([]), ['GITHUB 2 linked task(s) used 4.00M W as metered: T1 gh:acme/web#7 3.00M, T2 gh:acme/web#8 1.00M; internal, never posted']);
    assert.deepEqual(await github(['--session', 'bravo']), ['GITHUB 1 linked task(s) used 1.00M W as metered: T2 gh:acme/web#8 1.00M; internal, never posted']);
  });
});
