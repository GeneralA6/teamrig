import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGit } from '../lib/fake-git.ts';
import { GitError } from '../lib/git.ts';
import { configureHooks, HOOKS_PATH } from './hooks.ts';

const WHERE = 'rev-parse --is-inside-work-tree --show-prefix';
const AT_ROOT = 'true\n\n';
const SET_HOOKS = `config --local core.hooksPath ${HOOKS_PATH}`;
const GET_DENYLIST = 'config --default  --get teamrig.scrubDenylist';

describe('configureHooks', () => {
  it('points git at the repo hooks and reports a configured denylist', async () => {
    const git = new FakeGit({ [WHERE]: AT_ROOT, [SET_HOOKS]: '', [GET_DENYLIST]: '/private/deny.txt\n' });
    assert.deepEqual(await configureHooks(git), { kind: 'configured', hooksPath: HOOKS_PATH, denylist: '/private/deny.txt' });
    assert.deepEqual(git.calls[1], ['config', '--local', 'core.hooksPath', HOOKS_PATH]);
  });

  it('reports no denylist when none is configured', async () => {
    const git = new FakeGit({ [WHERE]: 'true\r\n\r\n', [SET_HOOKS]: '', [GET_DENYLIST]: '\n' });
    assert.deepEqual(await configureHooks(git), { kind: 'configured', hooksPath: HOOKS_PATH, denylist: undefined });
  });

  it('skips without touching git config outside a repo, or where git is missing', async () => {
    const git = new FakeGit({ [WHERE]: new GitError(WHERE.split(' '), 'fatal: not a git repository', 128) });
    assert.deepEqual(await configureHooks(git), { kind: 'skipped', reason: 'not a git checkout' });
    assert.deepEqual(git.calls, [WHERE.split(' ')]);
  });

  it('skips inside the .git folder', async () => {
    const git = new FakeGit({ [WHERE]: 'false\n\n' });
    assert.deepEqual(await configureHooks(git), { kind: 'skipped', reason: 'not a git checkout' });
  });

  it("skips a copy below another repo's top, leaving that repo's hooks alone", async () => {
    const git = new FakeGit({ [WHERE]: 'true\nvendor/teamrig/\n' });
    assert.deepEqual(await configureHooks(git), { kind: 'skipped', reason: 'not the root of its git checkout' });
    assert.equal(git.calls.length, 1);
  });

  it('lets an error that is not a git failure through', async () => {
    await assert.rejects(configureHooks(new FakeGit({})), /unexpected git call: rev-parse/);
  });
});
