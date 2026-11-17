import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { githubWatcher } from './watcher.ts';

describe('githubWatcher', () => {
  it('is the lead when no session is named and no role answers on GitHub', () => {
    assert.equal(githubWatcher(testConfig()), 'lead');
    assert.equal(githubWatcher(testConfig({ serviceRoles: { ship: { holders: 'team', commands: ['queue ship'] } } })), 'lead');
  });

  it('is the holder of a role holding issue close, the session that answers on GitHub', () => {
    assert.equal(githubWatcher(testConfig({ serviceRoles: { gh: { holders: ['bravo', 'alpha'], commands: ['issue close'] } } })), 'bravo');
    assert.equal(githubWatcher(testConfig({ serviceRoles: { ships: { holders: ['alpha'], commands: ['queue ship', 'queue merge'] } } })), 'lead', 'a ship role answers nothing');
  });

  it('reads the roles in name order, whatever order the file lists them in', () => {
    const roles = { zeta: { holders: ['bravo'], commands: ['issue close'] }, alpha: { holders: ['alpha'], commands: ['issue close'] } };
    assert.equal(githubWatcher(testConfig({ serviceRoles: roles })), 'alpha');
  });

  it('is github.watcher when it is set, over any role', () => {
    const config = testConfig({ github: { watcher: 'alpha' }, serviceRoles: { gh: { holders: ['bravo'], commands: ['issue close'] } } });
    assert.equal(githubWatcher(config), 'alpha');
  });
});
