import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS } from '../config/defaults.ts';
import { testConfig } from '../testing/config.ts';
import { ASK_REFUSED_NOTE, holdBack, holdBackOutput, hookAsksOf, refusalOutput } from './permission.ts';

describe('holdBack', () => {
  it('keeps a question under ask and a refusal under either choice', () => {
    assert.deepEqual(holdBack('ask', 'Why.', 'ask'), { permissionDecision: 'ask', permissionDecisionReason: 'Why.' });
    assert.deepEqual(holdBack('deny', 'Why.', 'ask'), { permissionDecision: 'deny', permissionDecisionReason: 'Why.' });
    assert.deepEqual(holdBack('deny', 'Why.', 'refuse'), { permissionDecision: 'deny', permissionDecisionReason: 'Why.' });
  });

  it('turns a question into a refusal under refuse, its reason saying what to do instead', () => {
    assert.deepEqual(holdBack('ask', 'Why.', 'refuse'), { permissionDecision: 'deny', permissionDecisionReason: `Why. ${ASK_REFUSED_NOTE}` });
    assert.match(ASK_REFUSED_NOTE, /\[prompts\.hookAsks\].*do not retry it.*--status waiting --waits approval:owner.*take your next task\.$/);
  });
});

describe('holdBackOutput', () => {
  it('wraps the fields in the PreToolUse output', () => {
    assert.deepEqual(JSON.parse(holdBackOutput('ask', 'Why.', 'refuse')), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Why. ${ASK_REFUSED_NOTE}` },
    });
  });
});

describe('refusalOutput', () => {
  it('is a PreToolUse refusal carrying the reason as given', () => {
    assert.deepEqual(JSON.parse(refusalOutput('Why.')), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Why.' },
    });
  });
});

describe('hookAsksOf', () => {
  it("takes a loaded config's choice and keeps the default for a missing or broken one", () => {
    const config = testConfig({ prompts: { hookAsks: 'refuse' } });
    assert.equal(hookAsksOf({ status: 'loaded', path: 'c.json', config, issues: [] }), 'refuse');
    assert.equal(hookAsksOf({ status: 'loaded', path: 'c.json', config: testConfig(), issues: [] }), 'ask');
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.equal(hookAsksOf(load), DEFAULT_PROMPTS.hookAsks);
    }
  });
});
