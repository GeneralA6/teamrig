import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { passRecordPath } from '../../src/push-guard/pass-record.ts';
import { parseProfiles } from '../ship/repos.ts';
import { pushScope, recordPathOf, recordPathsFor, shortRecordPath } from './check-scope.ts';

const ROOT = resolve('work', 'repo');
const TREE = 'a'.repeat(40);

/** One repo per gate and switch, as repos.json lists them; the switch needs the ci gate. */
const PROFILES = parseProfiles(
  JSON.stringify({
    'Owner/Short': { aliases: ['owner/short-old'], main: 'trunk', gate: 'ci', checks: ['a'], mergeChecks: 'changed' },
    'Owner/Full': { main: 'main', gate: 'ci', checks: ['a'] },
    'Owner/Local': { main: 'main', gate: 'local', checks: [], local: { runner: 'tools/ci/local.ts' } },
  }),
);

describe('the records of each scope (T3414)', () => {
  it('keeps a short proof apart from the pass record, which only a full proof writes', () => {
    const full = passRecordPath(ROOT, '.git', TREE);
    const short = shortRecordPath(ROOT, '.git', TREE);
    assert.equal(short, join(ROOT, '.git', 'local-ci', 'short', `${TREE}.json`));
    assert.notEqual(short, full);
    assert.equal(recordPathOf('full', ROOT, '.git', TREE), full);
    assert.equal(recordPathOf('short', ROOT, '.git', TREE), short);
  });

  it('takes a full pass for a short proof, never a short one for a full proof', () => {
    assert.deepEqual(recordPathsFor('full', ROOT, '.git', TREE), [passRecordPath(ROOT, '.git', TREE)]);
    assert.deepEqual(recordPathsFor('short', ROOT, '.git', TREE), [passRecordPath(ROOT, '.git', TREE), shortRecordPath(ROOT, '.git', TREE)]);
  });
});

describe('pushScope', () => {
  const branch = ['refs/heads/topic'];

  it('is short for a branch of a repo whose switch is on, found by its name or an alias, over https or ssh', () => {
    for (const url of ['https://github.com/Owner/Short.git', 'git@github.com:owner/short-old.git']) {
      assert.equal(pushScope(PROFILES, url, branch), 'short', url);
    }
  });

  it("is full when a push goes to the repo's main, its switch is off, or the remote is not a listed GitHub repo", () => {
    assert.equal(pushScope(PROFILES, 'https://github.com/Owner/Short.git', ['refs/heads/topic', 'refs/heads/trunk']), 'full');
    assert.equal(pushScope(PROFILES, 'https://github.com/Owner/Full.git', branch), 'full');
    assert.equal(pushScope(PROFILES, 'https://github.com/Owner/Local.git', branch), 'full');
    assert.equal(pushScope(PROFILES, 'https://github.com/Owner/Other.git', branch), 'full');
    assert.equal(pushScope(PROFILES, 'https://example.com/Owner/Short.git', branch), 'full');
    assert.equal(pushScope(PROFILES, undefined, branch), 'full');
  });
});
