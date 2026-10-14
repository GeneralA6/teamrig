import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGit } from '../lib/fake-git.ts';
import { configureHooks, HOOKS_PATH } from './hooks.ts';

const SET_HOOKS = `config --local core.hooksPath ${HOOKS_PATH}`;
const GET_DENYLIST = 'config --default  --get teamrig.scrubDenylist';

describe('configureHooks', () => {
  it('points git at the repo hooks and reports a configured denylist', async () => {
    const git = new FakeGit({ [SET_HOOKS]: '', [GET_DENYLIST]: '/private/deny.txt\n' });
    assert.deepEqual(await configureHooks(git), { hooksPath: HOOKS_PATH, denylist: '/private/deny.txt' });
    assert.deepEqual(git.calls[0], ['config', '--local', 'core.hooksPath', HOOKS_PATH]);
  });

  it('reports no denylist when none is configured', async () => {
    const git = new FakeGit({ [SET_HOOKS]: '', [GET_DENYLIST]: '\n' });
    assert.equal((await configureHooks(git)).denylist, undefined);
  });
});
