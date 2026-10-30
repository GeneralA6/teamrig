import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMMITS } from '../config/defaults.ts';
import type { CommitStat, FileChange } from '../push-guard/commit-size.ts';
import type { PassRecord } from '../push-guard/pass-record.ts';
import { missesText, selfMergeMisses, type SelfMergeChange } from './self-merge.ts';

const RULE = DEFAULT_COMMITS;
const TREE = 'e'.repeat(40);
const PASS: PassRecord = { tree: TREE, commit: 'c'.repeat(40), checks: ['unit'], passedAt: '2026-10-21T09:00:00.000Z', node: 'v24.0.0' };
const file = (path: string, added: number | null = 10, deleted: number | null = 0): FileChange => ({ path, added, deleted });
const commit = (files: readonly FileChange[], body = '', sha = 'a'.repeat(40)): CommitStat => ({ sha, subject: 'Store the rows', body, files });

/** A change that holds every gate, with `over` on top. */
function change(over: Partial<SelfMergeChange> = {}): SelfMergeChange {
  return {
    session: 'alpha',
    repo: 'app',
    reviewGate: true,
    branch: 't7-store',
    taskId: 'T7',
    task: { owner: 'alpha', status: 'in-progress' },
    tree: TREE,
    pass: PASS,
    commits: [commit([file('src/store.ts'), file('src/store.test.ts')])],
    ...over,
  };
}

const gatesOf = (value: SelfMergeChange): readonly string[] => selfMergeMisses(value, RULE).map((miss) => miss.gate);

describe('selfMergeMisses', () => {
  it('misses nothing when every gate holds', () => {
    assert.deepEqual(selfMergeMisses(change(), RULE), []);
  });

  describe('task', () => {
    it('needs the branch to name a task the register has', () => {
      assert.deepEqual(selfMergeMisses(change({ branch: 'store', taskId: undefined }), RULE), [
        { gate: 'task', why: 'store names no task: name the branch t<n>-… after your task' },
      ]);
      assert.deepEqual(selfMergeMisses(change({ task: undefined }), RULE), [{ gate: 'task', why: 'T7, which t7-store names, is not in the register' }]);
    });

    it("needs the task to be the session's own", () => {
      assert.deepEqual(selfMergeMisses(change({ task: { owner: 'bravo', status: 'open' } }), RULE), [{ gate: 'task', why: "T7 is bravo's, not alpha's" }]);
    });

    it('holds for every active status and misses a finished task', () => {
      for (const status of ['open', 'in-progress', 'verifying', 'waiting'] as const) {
        assert.deepEqual(gatesOf(change({ task: { owner: 'alpha', status } })), [], status);
      }
      for (const status of ['done', 'dropped'] as const) {
        assert.deepEqual(selfMergeMisses(change({ task: { owner: 'alpha', status } }), RULE), [{ gate: 'task', why: `T7 is ${status}` }]);
      }
    });
  });

  it('needs a pass record of the rebased tree', () => {
    assert.deepEqual(selfMergeMisses(change({ pass: undefined }), RULE), [
      { gate: 'pass', why: "no pass record proves the rebased tree eeeeeeee: run the repo's local checks on the rebased branch, then merge again" },
    ]);
  });

  describe('size', () => {
    const big = commit([file('src/store.ts', 401), file('src/store.test.ts')]);

    it('misses a commit over the bounds with no reason line, naming it as the push guard does', () => {
      const [miss] = selfMergeMisses(change({ commits: [big] }), RULE);
      assert.equal(miss?.gate, 'size');
      assert.match(miss?.why ?? '', /^1 commit\(s\) go over 400 changed non-test lines or 15 non-test files .*aaaaaaa "Store the rows" \(401 line\(s\), 1 file\(s\)\)/);
    });

    it('holds for a large commit that gives its reason', () => {
      assert.deepEqual(gatesOf(change({ commits: [{ ...big, body: 'Large-commit: generated client' }] })), []);
    });
  });

  describe('tests', () => {
    it('misses a change of source with no test, naming three sources and a count', () => {
      const sources = ['src/a.ts', 'src/b.py', 'lib/c.go', 'web/d.tsx'].map((path) => file(path));
      assert.deepEqual(selfMergeMisses(change({ commits: [commit(sources)] }), RULE), [
        { gate: 'tests', why: 'it changes source (src/a.ts, src/b.py, lib/c.go, 1 more) and no test: add or change the tests that cover it' },
      ]);
    });

    it('counts a test in another commit of the change', () => {
      assert.deepEqual(gatesOf(change({ commits: [commit([file('src/a.ts')]), commit([file('test/a.ts')], '', 'b'.repeat(40))] })), []);
    });

    it('holds for a change of no source: docs, config and data', () => {
      assert.deepEqual(gatesOf(change({ commits: [commit([file('docs/a.md'), file('config.json'), file('img.png', null, null)])] })), []);
    });

    it('judges a renamed file where it ends, and names it there', () => {
      assert.deepEqual(gatesOf(change({ commits: [commit([file('src/{a.ts => a.test.ts}')])] })), []);
      assert.deepEqual(selfMergeMisses(change({ commits: [commit([file('notes/{a.md => b.ts}')])] }), RULE), [
        { gate: 'tests', why: 'it changes source (notes/b.ts) and no test: add or change the tests that cover it' },
      ]);
    });

    it("reads the team's source patterns", () => {
      const rule = { ...RULE, sourcePatterns: ['^lib/'] };
      assert.deepEqual(selfMergeMisses(change({ commits: [commit([file('src/a.ts')])] }), rule), []);
      assert.equal(selfMergeMisses(change({ commits: [commit([file('lib/a.txt')])] }), rule)[0]?.gate, 'tests');
    });
  });

  it("needs the repo's review gate on", () => {
    assert.deepEqual(selfMergeMisses(change({ reviewGate: false }), RULE), [
      { gate: 'review', why: 'delivery.repos.app.reviewGate is off, so no review gate looked at its paths' },
    ]);
  });

  it('lists every miss in gate order', () => {
    const missing = change({ task: undefined, pass: undefined, commits: [commit([file('src/a.ts', 500)])], reviewGate: false });
    assert.deepEqual(gatesOf(missing), ['task', 'pass', 'size', 'tests', 'review']);
  });
});

describe('missesText', () => {
  it('names each miss by its gate on one line', () => {
    const text = missesText(selfMergeMisses(change({ task: { owner: 'alpha', status: 'done' }, pass: undefined }), RULE));
    assert.equal(text, "task: T7 is done; pass: no pass record proves the rebased tree eeeeeeee: run the repo's local checks on the rebased branch, then merge again");
  });
});
