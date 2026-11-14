import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type BranchWords, branchNameFor, branchPatternProblem, isBranchType, issueNumberOf, slugOf } from './branch-name.ts';
import { branchTaskOf } from './owner.ts';

const WORDS: BranchWords = { type: 'feat', id: 't12', issue: '933', slug: 'issue-forms', session: 'web' };

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

describe('issueNumberOf', () => {
  it("reads the number of a task's GitHub issue ref", () => {
    assert.equal(issueNumberOf('gh:acme/app#933'), '933');
    assert.equal(issueNumberOf(null), undefined);
    assert.equal(issueNumberOf('jira:ABC-1'), undefined);
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
