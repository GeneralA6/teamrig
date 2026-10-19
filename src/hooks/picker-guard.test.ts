import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asksDecision } from '../tabs/status.ts';
import { guardsPicker, pickerGuardOutput, pickerReason, refusesSession } from './picker-guard.ts';

const PICKER = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' };

describe('guardsPicker', () => {
  it('looks at a PreToolUse call of the question picker with the switch on', () => {
    assert.equal(guardsPicker(true, PICKER), true);
  });

  it('lets everything go with the switch off, and every other tool or event with it on', () => {
    assert.equal(guardsPicker(false, PICKER), false);
    assert.equal(guardsPicker(true, { ...PICKER, tool_name: 'ExitPlanMode' }), false, 'plan mode is the only way out of plan mode');
    assert.equal(guardsPicker(true, { ...PICKER, tool_name: 'Bash' }), false);
    assert.equal(guardsPicker(true, { ...PICKER, hook_event_name: 'PostToolUseFailure' }), false, 'the end of a call sets the tab to working');
    assert.equal(guardsPicker(true, { tool_name: 'AskUserQuestion' }), false);
  });
});

describe('refusesSession', () => {
  it('refuses a team session but the lead, and lets a tab that is no team session go', () => {
    assert.equal(refusesSession('alpha', 'lead'), true);
    assert.equal(refusesSession('lead', 'lead'), false);
    assert.equal(refusesSession(undefined, 'lead'), false);
  });
});

describe('pickerReason', () => {
  it("says why, then gives the session's own set command for the decision card and the turn-end marker", () => {
    const reason = pickerReason('teamrig', 'alpha');
    assert.match(reason, /^teamrig picker guard: the question picker stops this session until the owner answers/);
    assert.match(reason, /`teamrig set <id> --status waiting --waits decision:owner --note "<what waits>" --question "<what is decided>"/);
    assert.match(reason, /--default "<what happens with no answer>" --session alpha`; the lead brings it to the owner\./);
    assert.match(reason, /go straight on with your next task that does not need the answer\./);
    assert.equal(asksDecision(reason), false, 'the marker is quoted mid-line, so the reason itself sets no decision circle');
    assert.match(reason, /a `Decision needed:` line\.$/);
  });
});

describe('pickerGuardOutput', () => {
  it('prints a PreToolUse deny with the reason', () => {
    assert.deepEqual(JSON.parse(pickerGuardOutput('why')), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'why' },
    });
  });
});
