import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_RULE_KEYS, coreRuleKeyOf, isCoreRuleKey, ruleLabel, ruleNumberOf } from './keys.ts';

describe('core rule keys', () => {
  it('numbers each key by its place in the pack', () => {
    assert.equal(ruleNumberOf('roles'), 1);
    assert.equal(ruleNumberOf('worktrees'), CORE_RULE_KEYS.length);
    assert.equal(ruleLabel('push'), '15 push');
  });

  it('finds a rule by its number or its key, and nothing else', () => {
    assert.equal(coreRuleKeyOf('16'), 'worktrees');
    assert.equal(coreRuleKeyOf(' 1 '), 'roles');
    assert.equal(coreRuleKeyOf('owner-gates'), 'owner-gates');
    for (const text of ['0', '17', '-1', '1.5', 'Roles', '', 'worktree']) {
      assert.equal(coreRuleKeyOf(text), undefined, text);
    }
    assert.equal(isCoreRuleKey('deploy'), true);
    assert.equal(isCoreRuleKey('deploys'), false);
  });
});
