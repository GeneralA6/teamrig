import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGit } from '../lib/fake-git.ts';
import { GitError } from '../lib/git.ts';
import { TEST_SYSTEMS, changeKindOf, classifyChange, describeChange, testSystems } from './change-kind.ts';

const DIFF = 'diff --name-only --no-renames -z base...head';

describe('changeKindOf', () => {
  it('is docs for top-level Markdown and anything under docs/, pictures included', () => {
    assert.equal(changeKindOf(['README.md', 'CONTRIBUTING.md', 'docs/features.md', 'docs/images/hero.svg']), 'docs');
  });

  it('is design only when every file is under docs/design/', () => {
    assert.equal(changeKindOf(['docs/design/merge-queue.md', 'docs/design/notes/a.md']), 'design');
    assert.equal(changeKindOf(['docs/design/merge-queue.md', 'docs/features.md']), 'docs');
  });

  it('is code once any file is outside the docs, Markdown that ships or that tools read included', () => {
    assert.equal(changeKindOf(['docs/features.md', 'src/cli/main.ts']), 'code');
    assert.equal(changeKindOf(['plugins/teamrig/skills/teamrig-guide/commands.md']), 'code', 'a plugin skill ships to every user');
    assert.equal(changeKindOf(['.github/pull_request_template.md']), 'code', 'the ship tool reads the template');
    assert.equal(changeKindOf(['.claude/skills/dev-ship-change/SKILL.md']), 'code');
    assert.equal(changeKindOf(['docsy/a.md']), 'code', 'only the docs folder itself');
    assert.equal(changeKindOf(['README.txt']), 'code');
  });

  it('is code for no file at all, so an empty diff never skips a check', () => {
    assert.equal(changeKindOf([]), 'code');
  });
});

describe('testSystems', () => {
  it('tests a code change on every runner, and a docs or design change on ubuntu alone', () => {
    assert.deepEqual(testSystems('code'), TEST_SYSTEMS);
    assert.deepEqual(testSystems('docs'), ['ubuntu-latest']);
    assert.deepEqual(testSystems('design'), ['ubuntu-latest']);
  });
});

describe('classifyChange', () => {
  it("reads the files from the base's common ancestor to the head, both sides of a rename listed", async () => {
    const git = new FakeGit({ [DIFF]: 'docs/a.md\0src/a.ts\0' });
    assert.deepEqual(await classifyChange(git, { base: 'base', head: 'head' }), { kind: 'code', files: ['docs/a.md', 'src/a.ts'] });
    assert.deepEqual(git.calls, [DIFF.split(' ')]);
  });

  it('is docs when the diff lists only docs', async () => {
    const git = new FakeGit({ [DIFF]: 'docs/a.md\0README.md\0' });
    assert.deepEqual(await classifyChange(git, { base: 'base', head: 'head' }), { kind: 'docs', files: ['docs/a.md', 'README.md'] });
  });

  it('is code with no git call when there is no base to compare with', async () => {
    const git = new FakeGit({});
    assert.deepEqual(await classifyChange(git, { base: undefined, head: 'head' }), { kind: 'code', files: undefined });
    assert.deepEqual(git.calls, []);
  });

  it('fails when git cannot read the range, never guessing a lighter kind', async () => {
    const git = new FakeGit({ [DIFF]: new GitError(DIFF.split(' '), 'fatal: bad revision', new Error('exit 128')) });
    await assert.rejects(classifyChange(git, { base: 'base', head: 'head' }), /bad revision/);
  });
});

describe('describeChange', () => {
  it('names the kind, the count and the range it read', () => {
    assert.equal(
      describeChange({ kind: 'docs', files: ['docs/a.md', 'README.md'] }, { base: 'b1', head: 'h1' }),
      'change-kind: docs: 2 file(s) changed in b1...h1',
    );
  });

  it('says every check runs when there was no base', () => {
    assert.equal(
      describeChange({ kind: 'code', files: undefined }, { base: undefined, head: 'h1' }),
      'change-kind: code: no base commit to compare with (a new branch or a run by hand), every check runs',
    );
  });
});
