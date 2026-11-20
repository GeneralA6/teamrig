import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS } from '../config/defaults.ts';
import { testConfig } from '../testing/config.ts';
import { replyText } from '../testing/host.ts';
import { ASK_REFUSED_NOTE, heldBack, hookAsksOf, refusal } from './permission.ts';

describe('ASK_REFUSED_NOTE', () => {
  it('says why a guard never asks, the route to take, and how to ask for a rule change', () => {
    assert.match(ASK_REFUSED_NOTE, /^teamrig guards never ask a person, so this is refused; do not retry it or route around it\./);
    assert.match(ASK_REFUSED_NOTE, /Take the route the reason names; .*--status waiting --waits approval:owner.*take your next task\./);
    assert.match(ASK_REFUSED_NOTE, /If you think the rule is wrong, ask for a change as a task: `teamrig add --owner <your lead> --title "Rule change: /);
    assert.match(ASK_REFUSED_NOTE, /or to the security reviewer for a security rule\.$/);
  });
});

describe('refusal and heldBack', () => {
  it('never ask a person: a deny with the reason as given, and with the note when a guard would have asked (T3356)', () => {
    assert.deepEqual(refusal('Why.'), { verdict: { kind: 'deny', reason: 'Why.' } });
    assert.deepEqual(heldBack('deny', 'Why.'), refusal('Why.'));
    assert.deepEqual(heldBack('ask', 'Why.'), refusal(`Why. ${ASK_REFUSED_NOTE}`));
  });

  it('are worded by the shipped host as a refusal before the tool runs, never a prompt', () => {
    assert.equal(
      replyText('tool-start', refusal('Why.')),
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Why."}}',
    );
    assert.deepEqual(JSON.parse(replyText('tool-start', heldBack('ask', 'Why.'))), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Why. ${ASK_REFUSED_NOTE}` },
    });
  });
});

describe('hookAsksOf', () => {
  it("takes a loaded config's choice and keeps the default for a missing or broken one", () => {
    const config = testConfig({ prompts: { hookAsks: 'refuse' } });
    assert.equal(hookAsksOf({ status: 'loaded', path: 'c.json', config, issues: [] }), 'refuse');
    assert.equal(hookAsksOf({ status: 'loaded', path: 'c.json', config: testConfig({ prompts: { hookAsks: 'ask' } }), issues: [] }), 'ask');
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.equal(hookAsksOf(load), DEFAULT_PROMPTS.hookAsks);
    }
  });
});
