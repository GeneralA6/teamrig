import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EXIT, RefusedError } from '../../src/cli/runtime.ts';
import { mergeStandingOf, type MergeStanding } from '../../src/cli/ship-approval.ts';
import { CliHarness } from '../../src/testing/cli-harness.ts';
import { TempRepo } from '../lib/temp-repo.ts';
import { changePatch, clearMerge, clearMergeFrom, mergeClearance, type StandingOf, taskOfBranch } from './approval.ts';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

/** Team app with T1, alpha's, waiting on the lead's approval; `answer` is the lead's answer, if any. */
async function waitingKit(answer?: readonly string[]): Promise<CliHarness> {
  const kit = new CliHarness();
  assert.equal((await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.ok);
  assert.equal((await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t1-cli', '--session', 'alpha'])).code, EXIT.ok);
  if (answer !== undefined) {
    const run = await kit.run(['approve', 'T1', ...answer, '--session', 'lead']);
    assert.equal(run.code, EXIT.ok, run.stderr.join('\n'));
  }
  return kit;
}

const standing = async (kit: CliHarness, caller = 'alpha'): Promise<MergeStanding> => mergeStandingOf(kit.runtime(), 'app', caller, 'T1');
const approvedBy = async (note: string): Promise<MergeStanding> => standing(await waitingKit(['--note', note]));
const reasonOf = (clearance: ReturnType<typeof mergeClearance>): string => (clearance.kind === 'refused' ? clearance.reason : `not refused: ${clearance.kind}`);

describe('taskOfBranch', () => {
  it('reads the task from the t<id>- prefix, and none from any other name', () => {
    assert.equal(taskOfBranch('t2788-ship-approval'), 'T2788');
    assert.equal(taskOfBranch('t2693-conflict-hints-r5'), 'T2693');
    assert.equal(taskOfBranch('main'), null);
    assert.equal(taskOfBranch('fix-t12-thing'), null);
    assert.equal(taskOfBranch('t-12-thing'), null);
  });
});

describe('mergeClearance: the merge needs its approver to have approved the head it merges (T2788)', () => {
  it('clears the head the lead approved, by a short or a full sha in its note', async () => {
    assert.deepEqual(mergeClearance(await approvedBy(`head ${HEAD.slice(0, 9)} checked`), 'T1', HEAD, HEAD.slice(0, 9)), { kind: 'approved', by: 'lead' });
    assert.deepEqual(mergeClearance(await approvedBy(`approve ${HEAD}`), 'T1', HEAD, HEAD), { kind: 'approved', by: 'lead' });
  });

  it('refuses a task the register does not hold', async () => {
    const kit = await waitingKit(['--note', HEAD]);
    const clearance = mergeClearance(await mergeStandingOf(kit.runtime(), 'app', 'alpha', 'T9'), 'T9', HEAD, HEAD);
    assert.match(reasonOf(clearance), /holds no task T9/);
  });

  it("refuses a caller merging another session's task, the lead too", async () => {
    const kit = await waitingKit(['--note', HEAD]);
    assert.match(reasonOf(mergeClearance(await standing(kit, 'bravo'), 'T1', HEAD, HEAD)), /T1 is alpha's: only its owner merges it, not bravo/);
    assert.match(reasonOf(mergeClearance(await standing(kit, 'lead'), 'T1', HEAD, null)), /only its owner merges it, not lead/);
  });

  it("clears a root team's lead on its own task with no --approved", async () => {
    const kit = new CliHarness();
    assert.equal((await kit.run(['add', '--title', 'Lead work', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(mergeClearance(await standing(kit, 'lead'), 'T1', HEAD, null), { kind: 'self' });
  });

  it('refuses a merge that names no approved head', async () => {
    assert.match(reasonOf(mergeClearance(await approvedBy(HEAD), 'T1', HEAD, null)), /--approved <sha>: alpha's merge needs the approval of lead/);
  });

  it('refuses --approved that is no sha, or not the branch head', async () => {
    const approved = await approvedBy(HEAD);
    assert.match(reasonOf(mergeClearance(approved, 'T1', HEAD, 'HEAD')), /--approved HEAD is not the branch head/);
    assert.match(reasonOf(mergeClearance(approved, 'T1', HEAD, '0123')), /is not the branch head/, 'too short to name a commit');
    assert.match(reasonOf(mergeClearance(approved, 'T1', HEAD, 'fedcba987')), /--approved fedcba987 is not the branch head/);
  });

  it('refuses a task with no approval: none asked, none given yet, or declined', async () => {
    const asked = new CliHarness();
    assert.equal((await asked.run(['add', '--title', 'Ship', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(reasonOf(mergeClearance(await standing(asked), 'T1', HEAD, HEAD)), /T1 \(open\) holds no approval of lead: set it waiting approval:lead/);
    assert.match(reasonOf(mergeClearance(await standing(await waitingKit()), 'T1', HEAD, HEAD)), /T1 \(waiting\) holds no approval of lead/);
    assert.match(reasonOf(mergeClearance(await standing(await waitingKit(['--decline', '--note', HEAD])), 'T1', HEAD, HEAD)), /holds no approval of lead/);
  });

  it('refuses an approval whose note names another head, or no sha', async () => {
    const earlier = 'fedcba9876543210fedcba9876543210fedcba98';
    assert.match(reasonOf(mergeClearance(await approvedBy(`head ${earlier} checked`), 'T1', HEAD, HEAD)), /lead's approval of T1 names no sha of the head/);
    assert.match(reasonOf(mergeClearance(await approvedBy('looks good'), 'T1', HEAD, HEAD)), /names no sha of the head/);
    assert.match(reasonOf(mergeClearance(await approvedBy(`x${HEAD}`), 'T1', HEAD, HEAD)), /names no sha of the head/, 'a sha inside a longer word');
  });
});

describe('clearMerge', () => {
  const caller = { session: 'alpha', team: 'app' } as const;
  const fixed = (value: MergeStanding): StandingOf => async () => value;

  it('reads the standing for the caller, team and branch task, then clears it', async () => {
    const value = await approvedBy(HEAD);
    const asked: string[][] = [];
    const standingOf: StandingOf = async (team, session, taskId) => {
      asked.push([team, session, taskId]);
      return value;
    };
    assert.deepEqual(await clearMerge(caller, standingOf, 't1-cli', HEAD, HEAD), { kind: 'approved', by: 'lead' });
    assert.deepEqual(asked, [['app', 'alpha', 'T1']]);
  });

  it('refuses a branch that names no task, and a caller or team left unset', async () => {
    const value = fixed(await approvedBy(HEAD));
    assert.match(reasonOf(await clearMerge(caller, value, 'cli-fix', HEAD, HEAD)), /branch cli-fix names no task/);
    assert.match(reasonOf(await clearMerge({ session: undefined, team: 'app' }, value, 't1-cli', HEAD, HEAD)), /TEAMRIG_SESSION and TEAMRIG_TEAM/);
    assert.match(reasonOf(await clearMerge({ session: 'alpha', team: '' }, value, 't1-cli', HEAD, HEAD)), /TEAMRIG_SESSION and TEAMRIG_TEAM/);
  });

  it('clearMergeFrom reads the caller and team from the env and the register through the reader', async () => {
    const kit = await waitingKit(['--note', HEAD]);
    const env = { TEAMRIG_SESSION: ' alpha ', TEAMRIG_TEAM: 'app' };
    assert.deepEqual(await clearMergeFrom(env, kit.runtime())('t1-cli', HEAD, HEAD), { kind: 'approved', by: 'lead' });
    assert.match(reasonOf(await clearMergeFrom({ ...env, TEAMRIG_SESSION: 'stranger' }, kit.runtime())('t1-cli', HEAD, HEAD)), /stranger is not a session on this team/);
    assert.match(reasonOf(await clearMergeFrom({ TEAMRIG_TEAM: 'app' }, kit.runtime())('t1-cli', HEAD, HEAD)), /TEAMRIG_SESSION and TEAMRIG_TEAM/);
  });

  it("refuses with the register's refusal, and lets any other failure through", async () => {
    const refusing: StandingOf = async () => {
      throw new RefusedError('stranger is no session of app');
    };
    assert.deepEqual(await clearMerge(caller, refusing, 't1-cli', HEAD, HEAD), { kind: 'refused', reason: 'stranger is no session of app' });
    const broken: StandingOf = async () => {
      throw new Error('disk gone');
    };
    await assert.rejects(clearMerge(caller, broken, 't1-cli', HEAD, HEAD), /disk gone/);
  });
});

describe('changePatch: the fingerprint of what a branch changes over main', () => {
  const REGENERATED = ['dist/', 'version.txt'];
  let repo: TempRepo;
  const git = (args: readonly string[]): string => repo.git(...args);
  const commitFiles = (subject: string, files: Readonly<Record<string, string>>): string => {
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git('add', '--', ...Object.keys(files));
    repo.git('commit', '-q', '-m', subject);
    return repo.git('rev-parse', 'HEAD').trim();
  };
  const patch = (rev = 'HEAD'): string => changePatch(git, rev, 'main', REGENERATED);
  const lines = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('');

  beforeEach(() => {
    repo = new TempRepo('approval').init();
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commitFiles('base', { 'src/a.ts': lines(1, 20), 'src/b.ts': 'b\n', 'dist/a.js': 'a\n', 'version.txt': '1\n' });
    repo.git('checkout', '-q', '-b', 't1-change');
    commitFiles('core: a', { 'src/a.ts': lines(1, 20).replace('line 15\n', 'line fifteen\n'), 'src/new.ts': 'new\n' });
  });

  afterEach(() => repo.remove());

  it('is a sha256, the same on the same change', () => {
    assert.match(patch(), /^[0-9a-f]{64}$/);
    assert.equal(patch(), patch());
  });

  it('keeps the fingerprint when the branch is rebased over main lines above its own, and its regenerated files move', () => {
    const approved = patch();
    repo.git('checkout', '-q', 'main');
    commitFiles('main: more', { 'src/a.ts': `line 0\n${lines(1, 20)}`, 'src/b.ts': 'b2\n', 'dist/a.js': 'a2\n', 'version.txt': '2\n' });
    repo.git('checkout', '-q', 't1-change');
    repo.git('rebase', '-q', 'main');
    commitFiles('plugin: version 3', { 'version.txt': '3\n' });
    commitFiles('build: dist', { 'dist/a.js': 'a3\n', 'dist/new.js': 'new\n' });
    assert.equal(patch(), approved);
  });

  it('moves the fingerprint on any change to the branch outside its regenerated files', () => {
    const approved = patch();
    const sneaked = commitFiles('core: more', { 'src/b.ts': 'b, changed\n' });
    assert.notEqual(patch(sneaked), approved, 'a new file change');
    repo.git('checkout', '-q', '-b', 't1-edited', 'HEAD~1');
    commitFiles('core: a, edited', { 'src/new.ts': 'new, edited\n' });
    assert.notEqual(patch(), approved, 'an edit of a line the approved change made');
  });

  it('reads the change from the merge base, so commits main gains after the fork never count', () => {
    const approved = patch();
    repo.git('checkout', '-q', 'main');
    commitFiles('main: other', { 'src/c.ts': 'c\n' });
    repo.git('checkout', '-q', 't1-change');
    assert.equal(patch(), approved);
  });
});
