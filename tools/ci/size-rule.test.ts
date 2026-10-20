import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMMITS } from '../../src/config/defaults.ts';
import type { CommitLog, CommitStat } from '../../src/push-guard/commit-size.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { checkCommitSizes } from './size-rule.ts';

const SHA = 'a'.repeat(40);

/** A commit of one file with `lines` added lines. */
function commitOf(path: string, lines: number, body = ''): CommitStat {
  return { sha: SHA, subject: 'change', body, files: [{ path, added: lines, deleted: 0 }] };
}

/** A commit log that answers base..tip with `commits` and records each range it was asked for. */
function fakeLog(commits: readonly CommitStat[] | undefined): CommitLog & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    between: (dir, base, tip) => {
      asked.push(`${dir} ${base}..${tip}`);
      return commits;
    },
  };
}

function run(base: string | undefined, log: CommitLog): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = checkCommitSizes({ base, head: 'HEAD' }, { dir: 'repo', commitLog: log, rule: DEFAULT_COMMITS, out: (line) => lines.push(line) });
  return { code, lines };
}

describe('checkCommitSizes', () => {
  it('has nothing to check without a base, and asks git nothing', () => {
    const log = fakeLog([]);
    assert.deepEqual(run(undefined, log), { code: EXIT_CLEAN, lines: ['size-rule: no base commit to compare with (a new branch), nothing to check'] });
    assert.deepEqual(log.asked, []);
  });

  it('throws when git cannot list the range', () => {
    assert.throws(() => run('main', fakeLog(undefined)), { message: 'git cannot list the commits in main..HEAD' });
  });

  it('passes commits within the rule and counts them', () => {
    const log = fakeLog([commitOf('src/a.ts', 400), commitOf('src/b.ts', 10)]);
    assert.deepEqual(run('main', log), {
      code: EXIT_CLEAN,
      lines: ['size-rule: 2 commit(s) in main..HEAD, none over 400 changed non-test lines or 15 non-test files without a "Large-commit: <reason>" line'],
    });
    assert.deepEqual(log.asked, ['repo main..HEAD']);
  });

  it('fails a commit over the line bound with no reason line, and names it', () => {
    const { code, lines } = run('main', fakeLog([commitOf('src/a.ts', 401)]));
    assert.equal(code, EXIT_FINDINGS);
    assert.deepEqual(lines, [
      `size-rule: 1 commit(s) go over 400 changed non-test lines or 15 non-test files with no "Large-commit: <reason>" line: ${SHA.slice(0, 7)} "change" (401 line(s), 1 file(s)). Split each into logical steps, or give the reason in its message.`,
    ]);
  });

  it('fails a commit over the file bound', () => {
    const files = Array.from({ length: 16 }, (_, index) => ({ path: `src/f${index}.ts`, added: 1, deleted: 0 }));
    assert.equal(run('main', fakeLog([{ sha: SHA, subject: 'wide', body: '', files }])).code, EXIT_FINDINGS);
  });

  it('passes a large commit whose message gives the reason, and does not count test files', () => {
    const reasoned = commitOf('src/a.ts', 900, 'Large-commit: a generated table');
    const tests = commitOf('src/a.test.ts', 900);
    assert.equal(run('main', fakeLog([reasoned, tests])).code, EXIT_CLEAN);
  });
});
