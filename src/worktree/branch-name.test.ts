import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BRANCHES } from '../config/defaults.ts';
import type { BranchesConfig } from '../config/types.ts';
import {
  type BranchTask,
  type BranchWords,
  branchNameFor,
  branchPatternProblem,
  branchPatternRefusal,
  isBranchType,
  slugOf,
  taskBranchName,
} from './branch-name.ts';
import { branchTaskOf } from './owner.ts';

const WORDS: BranchWords = { type: 'feat', id: 't12', issue: '933', slug: 'issue-forms', session: 'web' };

describe('branchPatternRefusal (#1433)', () => {
  it('takes a new branch the default pattern makes, a ship retry suffix included', () => {
    for (const branch of ['feat/t12-parser', 'fix/t9-login-loop', 'chore/t3200-a-b-c', 'feat/t12-parser-2', 'docs/t7-x1']) {
      assert.equal(branchPatternRefusal(branch, DEFAULT_BRANCHES), undefined, branch);
    }
  });

  it('takes a retry suffix after a pattern that ends at {id} or {issue}, and nothing else after it', () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, pattern: '{type}/{id}', typePatterns: { hotfix: 'hotfix/gh{issue}' } };
    for (const branch of ['feat/t12', 'feat/t12-2', 'feat/t12-999', 'hotfix/gh933-3']) {
      assert.equal(branchPatternRefusal(branch, branches), undefined, branch);
    }
    for (const branch of ['feat/t12-0', 'feat/t12-1000', 'feat/t12-x', 'feat/t12-2-3', 'feat/t12-', 'hotfix/gh933-retry']) {
      assert.ok(branchPatternRefusal(branch, branches) !== undefined, branch);
    }
  });

  it('refuses a new branch in another style, naming the pattern and an example', () => {
    for (const branch of ['t12-parser', 'my-fix', 'feat/t12', 'feature/T12-parser', 'feat/t012-parser', 'feat/t12-Parser', 'feat/t12_parser', 'Feat/t12-parser', 'x/feat/t12-a']) {
      assert.equal(
        branchPatternRefusal(branch, DEFAULT_BRANCHES),
        `"${branch}" does not match the branch pattern {type}/{id}-{slug} (delivery.branches), such as feat/t12-parser; delivery.branches.enforce false lets any name through`,
        branch,
      );
    }
  });

  it("takes a branch type's own pattern, the issue and the session, and names every pattern when refusing", () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, pattern: '{session}/{id}-gh{issue}-{slug}', typePatterns: { release: 'release/{id}', docs: 'docs/{id}-{slug}' } };
    for (const branch of ['web/t12-gh933-forms', 'team-oss/t4-gh1-a', 'release/t5', 'docs/t6-readme']) {
      assert.equal(branchPatternRefusal(branch, branches), undefined, branch);
    }
    assert.equal(
      branchPatternRefusal('feat/t12-parser', branches),
      '"feat/t12-parser" does not match any of the branch patterns {session}/{id}-gh{issue}-{slug}, release/{id}, docs/{id}-{slug} (delivery.branches), such as web/t12-gh933-parser; delivery.branches.enforce false lets any name through',
    );
    assert.match(branchPatternRefusal('release/t5-x', branches) ?? '', /does not match/);
    assert.match(branchPatternRefusal('web/t12-ghx-a', branches) ?? '', /does not match/);
  });

  it('keeps text outside placeholders as written, regex characters included', () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, pattern: 'wip.{type}/{id}-{slug}' };
    assert.equal(branchPatternRefusal('wip.feat/t1-a', branches), undefined);
    assert.match(branchPatternRefusal('wipxfeat/t1-a', branches) ?? '', /does not match/);
  });

  it('splits a name between placeholders that both take a -, in any way that fits', () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, pattern: '{slug}-{session}/{id}-{slug}' };
    for (const branch of ['a-web/t1-b', 'a-b-c-team-oss/t1-b-c', 'a1-w-/t1-x']) {
      assert.equal(branchPatternRefusal(branch, branches), undefined, branch);
    }
    for (const branch of ['a/t1-b', '-a-web/t1-b', 'a--web/t1-b', 'a-1web/t1-b']) {
      assert.match(branchPatternRefusal(branch, branches) ?? '', /does not match/, branch);
    }
  });

  it('answers a long miss at once, however many placeholders that take a - sit side by side', () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, pattern: `${Array(6).fill('{slug}').join('-')}/{id}` };
    // A backtracking regex takes seconds at 120 characters, growing as the length to the sixth power; a matcher that
    // lists every end of every start takes seconds at 10,000.
    for (const words of [80, 3_400]) {
      const branch = `${'ab-'.repeat(words)}ab/x`;
      const started = performance.now();
      assert.match(branchPatternRefusal(branch, branches) ?? '', /does not match/);
      assert.ok(performance.now() - started < 1000, `${branch.length} characters took ${Math.round(performance.now() - started)} ms`);
    }
    assert.equal(branchPatternRefusal(`${'ab-'.repeat(3_400)}ab/t1`, branches), undefined, 'a long name it makes');
  });

  it('lets any name through with enforce off', () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, enforce: false };
    for (const branch of ['t12-parser', 'my-fix', 'feature/T12-parser']) {
      assert.equal(branchPatternRefusal(branch, branches), undefined, branch);
    }
  });

  it('takes every branch taskBranchName names', () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, typePatterns: { release: 'release/{id}' }, classes: { Improvements: 'chore' } };
    for (const title of ['Fix T12 login loop!', 'a', '日本語 only', 'Über-long title that goes past the slug cap of forty characters for sure']) {
      const tasks: readonly [BranchTask, string | undefined][] = [
        [{ id: 'T42', title, owner: 'web', ref: null, itemType: 'task', workClass: 'Roadmap' }, undefined],
        [{ id: 'T42', title, owner: 'web', ref: null, itemType: 'bug', workClass: 'Improvements' }, undefined],
        [{ id: 'T42', title, owner: 'web', ref: null, itemType: 'task', workClass: 'Roadmap' }, 'release'],
        [{ id: 'T42', title, owner: 'web', ref: null, itemType: 'task', workClass: 'Roadmap' }, 'docs'],
      ];
      for (const [task, type] of tasks) {
        const named = taskBranchName(task, branches, type);
        assert.equal(named.kind === 'name' ? branchPatternRefusal(named.branch, branches) : 'refused', undefined, `${title} ${type ?? ''}`);
      }
    }
  });
});

describe('branchPatternProblem', () => {
  it('takes the default pattern and patterns with the id starting a part', () => {
    assert.equal(branchPatternProblem('{type}/{id}-{slug}'), undefined);
    assert.equal(branchPatternProblem('{id}-{slug}'), undefined);
    assert.equal(branchPatternProblem('{session}/{type}/{id}/{slug}'), undefined);
    assert.equal(branchPatternProblem('{type}/{id}-gh{issue}-{slug}'), undefined);
    assert.equal(branchPatternProblem('{type}/{id}'), undefined);
  });

  it('refuses an unknown placeholder, naming the ones it takes', () => {
    assert.equal(branchPatternProblem('{type}/{id}-{title}'), '{title} is no placeholder: use {type}, {id}, {issue}, {slug}, {session}');
  });

  it('refuses a pattern without {id}, or with it twice', () => {
    assert.equal(branchPatternProblem('{type}/{slug}'), 'needs {id} exactly once: the task id tells whose branch it is');
    assert.equal(branchPatternProblem('{id}/{id}-{slug}'), 'needs {id} exactly once: the task id tells whose branch it is');
  });

  it('refuses {id} that does not start a part, or runs into the next word', () => {
    const where = '{id} must start the pattern or follow a /, and be followed by -, / or the end';
    assert.equal(branchPatternProblem('{type}-{id}-{slug}'), where);
    assert.equal(branchPatternProblem('{type}/{id}{slug}'), where);
  });

  it('refuses a pattern that makes no branch name git takes', () => {
    assert.match(branchPatternProblem('{type}//{id}-{slug}') ?? '', /^makes no branch name \(feat\/\/t1-a-b\): expected a branch name/);
    assert.match(branchPatternProblem('{id}-{slug}.lock') ?? '', /^makes no branch name \(t1-a-b\.lock\)/);
    assert.match(branchPatternProblem('{id}-{slug} x') ?? '', /^makes no branch name/);
  });
});

describe('branchNameFor', () => {
  it('fills the pattern, and the branch names its task', () => {
    const named = branchNameFor('{type}/{id}-{slug}', WORDS);
    assert.deepEqual(named, { kind: 'name', branch: 'feat/t12-issue-forms' });
    assert.equal(named.kind === 'name' ? branchTaskOf(named.branch) : undefined, 'T12');
    assert.deepEqual(branchNameFor('{session}/{type}/{id}-gh{issue}', WORDS), { kind: 'name', branch: 'web/feat/t12-gh933' });
  });

  it('refuses a pattern naming a word the task lacks', () => {
    assert.deepEqual(branchNameFor('{type}/{id}-gh{issue}-{slug}', { ...WORDS, issue: undefined }), {
      kind: 'refused',
      reason: 'the branch pattern {type}/{id}-gh{issue}-{slug} names {issue}, which this task has none of: give a branch name instead',
    });
  });

  it('refuses a bad pattern, and words that make no branch name', () => {
    assert.deepEqual(branchNameFor('{type}/{slug}', WORDS), {
      kind: 'refused',
      reason: 'the branch pattern {type}/{slug} needs {id} exactly once: the task id tells whose branch it is',
    });
    const named = branchNameFor('{session}/{id}-{slug}', { ...WORDS, session: '.web' });
    assert.equal(named.kind, 'refused');
    assert.match(named.kind === 'refused' ? named.reason : '', /^"\.web\/t12-issue-forms": expected a branch name/);
  });
});

describe('taskBranchName', () => {
  const task: BranchTask = { id: 'T12', title: 'Parse the input (T11)', owner: 'web', ref: 'gh:acme/app#933', itemType: 'task', workClass: 'Roadmap' };

  it("names a task's branch feat and a bug's fix by default", () => {
    assert.deepEqual(taskBranchName(task, DEFAULT_BRANCHES, undefined), { kind: 'name', branch: 'feat/t12-parse-the-input' });
    assert.deepEqual(taskBranchName({ ...task, itemType: 'bug' }, DEFAULT_BRANCHES, undefined), { kind: 'name', branch: 'fix/t12-parse-the-input' });
  });

  it("takes the given type over the work class's, and the class's over the item type's", () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, classes: { Roadmap: 'chore' } };
    assert.deepEqual(taskBranchName(task, branches, undefined), { kind: 'name', branch: 'chore/t12-parse-the-input' });
    assert.deepEqual(taskBranchName(task, branches, 'docs'), { kind: 'name', branch: 'docs/t12-parse-the-input' });
  });

  it("takes the branch type's own pattern, and fills the issue, session and slug cap", () => {
    const branches: BranchesConfig = { ...DEFAULT_BRANCHES, typePatterns: { release: '{type}/{id}-gh{issue}' }, pattern: '{session}/{type}/{id}-{slug}', slugMax: 9 };
    assert.deepEqual(taskBranchName(task, branches, 'release'), { kind: 'name', branch: 'release/t12-gh933' });
    assert.deepEqual(taskBranchName(task, branches, undefined), { kind: 'name', branch: 'web/feat/t12-parse-the' });
    assert.equal(taskBranchName({ ...task, ref: null }, { ...branches, pattern: '{id}-gh{issue}' }, undefined).kind, 'refused');
  });
});

describe('slugOf', () => {
  it('lowercases the title, joins its words by -, and leaves task ids out', () => {
    assert.equal(slugOf('T2609: Issue forms & the PR format check (T2723)', 40), 'issue-forms-the-pr-format-check');
  });

  it('cuts at a word to the cap, and cuts a first word longer than it', () => {
    assert.equal(slugOf('Branch and worktree names follow a convention', 20), 'branch-and-worktree');
    assert.equal(slugOf('Supercalifragilistic word', 5), 'super');
  });

  it('falls back to work when nothing is left', () => {
    assert.equal(slugOf('T12 — ✓', 40), 'work');
  });
});

describe('isBranchType', () => {
  it('takes a lowercase word', () => {
    assert.equal(isBranchType('feat'), true);
    assert.equal(isBranchType('v2'), true);
    assert.equal(isBranchType('Feat'), false);
    assert.equal(isBranchType('fix/x'), false);
    assert.equal(isBranchType(''), false);
  });
});
