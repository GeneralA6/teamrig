import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMMITS } from '../config/defaults.ts';
import {
  describeLargeCommits,
  hasLargeReason,
  largeCommits,
  parseCommitLog,
  renamedPath,
  testMatcher,
  weighCommit,
  type CommitStat,
  type FileChange,
} from './commit-size.ts';

const RULE = DEFAULT_COMMITS;
const file = (path: string, added: number | null, deleted: number | null = 0): FileChange => ({ path, added, deleted });
const commit = (files: readonly FileChange[], body = '', sha = 'a'.repeat(40)): CommitStat => ({ sha, subject: 'Rewrite the store', body, files });
/** `count` non-test files of `lines` added lines each. */
const spread = (count: number, lines: number): FileChange[] => Array.from({ length: count }, (_, index) => file(`src/f${index}.ts`, lines));

describe('testMatcher', () => {
  it('reads the default test paths as tests, and nothing else', () => {
    const isTest = testMatcher(RULE.testPatterns);
    for (const path of ['src/a.test.ts', 'src/a.spec.js', 'test/x.ts', 'pkg/tests/x.py', 'src/__tests__/x.tsx', 'spec/x.rb', 'app/test_x.py', 'C:\\r\\src\\a.test.ts']) {
      assert.equal(isTest(path), true, path);
    }
    for (const path of ['src/a.ts', 'src/testing/x.ts', 'latest/x.ts', 'src/contest.ts', 'docs/test.md']) {
      assert.equal(isTest(path), false, path);
    }
  });

  it('judges a renamed file by where it ends', () => {
    const isTest = testMatcher(RULE.testPatterns);
    assert.equal(isTest('src/{store.ts => store.test.ts}'), true);
    assert.equal(isTest('test/old.ts => src/new.ts'), false);
  });
});

describe('renamedPath', () => {
  it('reads both numstat rename forms', () => {
    assert.equal(renamedPath('src/{a => b}/x.ts'), 'src/b/x.ts');
    assert.equal(renamedPath('src/{ => sub}/x.ts'), 'src/sub/x.ts');
    assert.equal(renamedPath('src/{sub => }/x.ts'), 'src/x.ts');
    assert.equal(renamedPath('old.ts => test/new.ts'), 'test/new.ts');
    assert.equal(renamedPath('plain.ts'), 'plain.ts');
  });
});

describe('weighCommit', () => {
  it('counts added and deleted non-test lines, and a binary file as a file with no lines', () => {
    const isTest = testMatcher(RULE.testPatterns);
    const weight = weighCommit(commit([file('src/a.ts', 300, 50), file('src/a.test.ts', 900), file('img.png', null, null)]), isTest);
    assert.deepEqual(weight, { lines: 350, files: 2 });
  });
});

describe('hasLargeReason', () => {
  it('needs the key at the start of a line, in any case, with a reason after it', () => {
    assert.equal(hasLargeReason('Large-commit: generated client', 'Large-commit'), true);
    assert.equal(hasLargeReason('Why.\r\n\r\nlarge-COMMIT: vendored', 'Large-commit'), true);
    assert.equal(hasLargeReason('Large-commit:', 'Large-commit'), false);
    assert.equal(hasLargeReason('Large-commit:   ', 'Large-commit'), false);
    assert.equal(hasLargeReason('See Large-commit: x', 'Large-commit'), false);
    assert.equal(hasLargeReason('', 'Large-commit'), false);
  });
});

describe('largeCommits', () => {
  it('lets a commit at either bound through and stops one past it', () => {
    const atBound = commit([...spread(14, 0), file('src/big.ts', 400)]);
    const overLines = commit([file('src/big.ts', 401)], '', 'b'.repeat(40));
    const overFiles = commit(spread(16, 1), '', 'c'.repeat(40));
    const large = largeCommits([atBound, overLines, overFiles], RULE);
    assert.deepEqual(
      large.map((entry) => [entry.sha[0], entry.lines, entry.files]),
      [
        ['b', 401, 1],
        ['c', 16, 16],
      ],
    );
  });

  it('lets through a commit with a reason line, and one whose size is all tests', () => {
    const explained = commit([file('src/gen.ts', 5_000)], 'Large-commit: generated from the schema');
    const testsOnly = commit([file('src/a.test.ts', 5_000), ...Array.from({ length: 30 }, (_, index) => file(`test/t${index}.ts`, 10))]);
    assert.deepEqual(largeCommits([explained, testsOnly], RULE), []);
  });

  it("uses the team's bounds, key and test patterns", () => {
    const rule = { ...RULE, maxLines: 50, maxFiles: 2, largeCommitTrailer: 'Big', testPatterns: ['^fixtures/'] };
    assert.equal(largeCommits([commit([file('src/a.ts', 51)])], rule).length, 1);
    assert.equal(largeCommits([commit([file('src/a.ts', 51)], 'Big: data')], rule).length, 0);
    assert.equal(largeCommits([commit([file('fixtures/a.json', 999), file('src/a.test.ts', 30)])], rule).length, 0);
  });
});

describe('describeLargeCommits', () => {
  it('names five commits, counts the rest and says how to let each through', () => {
    const large = Array.from({ length: 6 }, (_, index) => ({ sha: `${index}`.repeat(40), subject: `Step ${index}`, lines: 500 + index, files: 3 }));
    const text = describeLargeCommits(large, RULE);
    assert.match(text, /^6 commit\(s\) go over 400 changed non-test lines or 15 non-test files with no "Large-commit: <reason>" line: /);
    assert.match(text, /0000000 "Step 0" \(500 line\(s\), 3 file\(s\)\); /);
    assert.match(text, /4444444 "Step 4" \(504 line\(s\), 3 file\(s\)\), and 1 more\. Split each/);
    assert.doesNotMatch(text, /5555555/);
  });

  it('shortens a long subject', () => {
    const text = describeLargeCommits([{ sha: 'f'.repeat(40), subject: 's'.repeat(80), lines: 900, files: 1 }], RULE);
    assert.match(text, new RegExp(`"${'s'.repeat(59)}…"`));
  });
});

describe('parseCommitLog', () => {
  it('reads each commit, its body and its numstat lines', () => {
    const first = `\x1e${'a'.repeat(40)}\x1fAdd the store\x1fWhy it exists.\nLarge-commit: generated\n\x1f\n\n12\t3\tsrc/a.ts\r\n-\t-\timg.png\n`;
    const second = `\x1e${'b'.repeat(40)}\x1fEmpty\x1f\x1f\n`;
    assert.deepEqual(parseCommitLog(first + second), [
      {
        sha: 'a'.repeat(40),
        subject: 'Add the store',
        body: 'Why it exists.\nLarge-commit: generated',
        files: [file('src/a.ts', 12, 3), file('img.png', null, null)],
      },
      { sha: 'b'.repeat(40), subject: 'Empty', body: '', files: [] },
    ]);
  });

  it('reads no commits from empty output or a record with no sha', () => {
    assert.deepEqual(parseCommitLog(''), []);
    assert.deepEqual(parseCommitLog('\x1e\x1fsubject\x1f\x1f'), []);
  });
});
