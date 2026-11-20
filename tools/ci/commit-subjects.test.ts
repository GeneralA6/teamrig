import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommitLog, CommitStat } from '../../src/push-guard/commit-size.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { checkCommitSubjects, COMMIT_TYPES, subjectProblem } from './commit-subjects.ts';

const commit = (sha: string, subject: string): CommitStat => ({ sha, subject, body: '', files: [] });

/** A log that answers one range only, so a test sees which range the check asked for. */
function logOf(base: string, head: string, commits: readonly CommitStat[]): CommitLog {
  return { between: (_dir, from, to) => (from === base && to === head ? { kind: 'listed', commits } : { kind: 'refused' }) };
}

function run(base: string | undefined, head: string, log: CommitLog): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = checkCommitSubjects({ base, head }, { dir: '.', commitLog: log, out: (line) => lines.push(line) });
  return { code, lines };
}

describe('subjectProblem', () => {
  it('takes every type, with an area or without, and a breaking mark', () => {
    for (const type of COMMIT_TYPES) assert.equal(subjectProblem(`${type}: do it`), null, type);
    assert.equal(subjectProblem('fix(ship): a merge waits for its checks'), null);
    assert.equal(subjectProblem('feat(cli)!: the list command takes --all'), null);
    assert.equal(subjectProblem('chore(main): release teamrig 0.448.0'), null);
  });

  it('refuses the old area-only subject, an unknown type, a missing space and an empty what', () => {
    assert.equal(subjectProblem('tools: publish a release'), '"tools" is no commit type; use one of ' + COMMIT_TYPES.join(', '));
    assert.equal(subjectProblem('plugin: version 0.447.1, why'), '"plugin" is no commit type; use one of ' + COMMIT_TYPES.join(', '));
    assert.equal(subjectProblem('Fix the merge'), 'it does not start with <type>: or <type>(<area>):');
    assert.equal(subjectProblem('fix:the merge'), 'it does not start with <type>: or <type>(<area>):');
    assert.equal(subjectProblem('fix(): the merge'), 'it does not start with <type>: or <type>(<area>):');
    assert.equal(subjectProblem('fix: '), 'it does not start with <type>: or <type>(<area>):');
    assert.equal(subjectProblem('Revert "fix: the merge"'), 'it does not start with <type>: or <type>(<area>):');
  });
});

describe('checkCommitSubjects', () => {
  it('passes a range whose every subject is typed', () => {
    const { code, lines } = run('main', 'HEAD', logOf('main', 'HEAD', [commit('a'.repeat(40), 'fix(ship): x'), commit('b'.repeat(40), 'docs: y')]));
    assert.equal(code, EXIT_CLEAN);
    assert.deepEqual(lines, ['commit-subjects: 2 commit(s) in main..HEAD, each subject <type>(<area>): <what>']);
  });

  it('names each wrong commit and says how to reword it', () => {
    const { code, lines } = run('main', 'HEAD', logOf('main', 'HEAD', [commit('a'.repeat(40), 'fix: x'), commit('b'.repeat(40), 'tools: y')]));
    assert.equal(code, EXIT_FINDINGS);
    assert.equal(lines[0], 'commit-subjects: 1 of 2 commit(s) in main..HEAD have a subject the release workflow cannot read:');
    assert.equal(lines[1], `  bbbbbbbbb "tools: y": "tools" is no commit type; use one of ${COMMIT_TYPES.join(', ')}`);
    assert.match(lines[2] ?? '', /^commit-subjects: reword it as <type>\(<area>\): <what>.*git commit --amend.*git rebase -i <base>.*--force-with-lease$/);
  });

  it('checks the head commit alone when the run has no base, as a run by hand on the release pull request', () => {
    const { code, lines } = run(undefined, 'abc', logOf('abc~1', 'abc', [commit('c'.repeat(40), 'chore(main): release teamrig 0.448.0')]));
    assert.equal(code, EXIT_CLEAN);
    assert.deepEqual(lines, ['commit-subjects: 1 commit(s) in abc~1..abc, each subject <type>(<area>): <what>']);
  });

  it('stops when git cannot list the range', () => {
    assert.throws(() => run('nope', 'HEAD', logOf('main', 'HEAD', [])), /git cannot list the commits in nope\.\.HEAD/);
  });

  it('stops naming no answer, not an unlistable range, when the log run was stopped (#1523)', () => {
    const stopped: CommitLog = { between: () => ({ kind: 'unanswered', reason: 'stopped by SIGTERM' }) };
    assert.throws(() => run('main', 'HEAD', stopped), {
      message: 'git gave no answer listing the commits in main..HEAD (stopped by SIGTERM); run it again once git answers',
    });
  });
});
