import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { githubWatcher } from './watcher.ts';

describe('githubWatcher', () => {
  it('is the lead when no session is named and no role answers on GitHub', () => {
    assert.equal(githubWatcher(testConfig()), 'lead');
    assert.equal(githubWatcher(testConfig({ serviceRoles: { ship: { holders: 'team', commands: ['queue ship'] } } })), 'lead');
  });

  it('is the holder of a role holding issue comment, the session that answers on GitHub', () => {
    assert.equal(githubWatcher(testConfig({ serviceRoles: { gh: { holders: ['bravo', 'alpha'], commands: ['issue close', 'issue comment'] } } })), 'bravo');
    assert.equal(githubWatcher(testConfig({ serviceRoles: { gh: { holders: ['alpha'], commands: ['issue close'] } } })), 'lead', 'a close alone answers nothing');
  });

  it('reads the roles in name order, whatever order the file lists them in', () => {
    const roles = { zeta: { holders: ['bravo'], commands: ['issue comment'] }, alpha: { holders: ['alpha'], commands: ['issue comment'] } };
    assert.equal(githubWatcher(testConfig({ serviceRoles: roles })), 'alpha');
  });

  it('is github.watcher when it is set, over any role', () => {
    const config = testConfig({ github: { watcher: 'alpha' }, serviceRoles: { gh: { holders: ['bravo'], commands: ['issue comment'] } } });
    assert.equal(githubWatcher(config), 'alpha');
  });
});
