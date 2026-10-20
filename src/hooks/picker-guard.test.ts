import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asksDecision } from '../tabs/status.ts';
import { askerOf, guardsPicker, pickerGuardOutput, pickerReason, refusesAsker } from './picker-guard.ts';

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

describe('askerOf', () => {
  it("names a session's own thread, the lead's, and a helper of either", () => {
    assert.deepEqual(askerOf('alpha', false, 'lead'), { session: 'alpha', role: 'session' });
    assert.deepEqual(askerOf('lead', false, 'lead'), { session: 'lead', role: 'lead' });
    assert.deepEqual(askerOf('alpha', true, 'lead'), { session: 'alpha', role: 'helper' });
    assert.deepEqual(askerOf('lead', true, 'lead'), { session: 'lead', role: 'helper' });
  });

  it('leaves a tab that is no team session alone, from a helper too', () => {
    assert.equal(askerOf(undefined, false, 'lead'), undefined);
    assert.equal(askerOf(undefined, true, 'lead'), undefined);
  });
});

describe('refusesAsker', () => {
  it("refuses a session and a helper always, and the lead's own thread unless the meeting is open", () => {
    for (const meetingOpen of [false, true]) {
      assert.equal(refusesAsker({ session: 'alpha', role: 'session' }, meetingOpen), true);
      assert.equal(refusesAsker({ session: 'lead', role: 'helper' }, meetingOpen), true, "a lead's helper reports, the meeting or not");
    }
    assert.equal(refusesAsker({ session: 'lead', role: 'lead' }, false), true, 'the owner may be away');
    assert.equal(refusesAsker({ session: 'lead', role: 'lead' }, true), false, 'the meeting asks through it');
  });
});

describe('pickerReason', () => {
  it("says why, to decide it if it is the session's own, else to record a card with its default and take the next task", () => {
    const reason = pickerReason('teamrig', { session: 'alpha', role: 'session' });
    assert.match(reason, /^teamrig picker guard: the question picker stops this session until the owner answers, and the owner may be away for hours/);
    assert.match(reason, /Decide it yourself if it is yours to decide, and note it on its task\. Else record it on its task as a decision card, its --default included, and take your next task/);
    assert.match(reason, /`teamrig set <id> --status waiting --waits decision:owner --note "<what waits>" --question "<what is decided>"/);
    assert.match(reason, /--default "<what happens with no answer>" --session alpha`; the lead brings it to the owner\./);
    assert.equal(asksDecision(reason), false, 'the marker is quoted mid-line, so the reason itself sets no decision circle');
    assert.match(reason, /a `Decision needed:` line\.$/);
  });

  it("tells the lead its card goes on the next meeting's agenda, the only time its picker opens", () => {
    const reason = pickerReason('teamrig', { session: 'lead', role: 'lead' });
    assert.match(reason, /--session lead`; the agenda of the owner's next daily meeting lists it, and the picker opens for you only while that meeting is open \(`teamrig meeting start`\)\./);
    assert.doesNotMatch(reason, /the lead brings it/);
    assert.match(reason, /a `Decision needed:` line\.$/);
  });

  it('tells a helper to decide it within its brief, else to end its report with the decision, and to run no set', () => {
    const reason = pickerReason('teamrig', { session: 'alpha', role: 'helper' });
    assert.match(reason, /^teamrig picker guard: a helper's question picker stops the session that started it until the owner answers/);
    assert.match(reason, /Decide it yourself if it is within your brief\. Else finish the rest of your brief and end your report with the decision/);
    assert.match(reason, /the session that started you records it\.$/);
    assert.doesNotMatch(reason, /teamrig set|Decision needed/);
  });
});

describe('pickerGuardOutput', () => {
  it('prints a PreToolUse deny with the reason', () => {
    assert.deepEqual(JSON.parse(pickerGuardOutput('why')), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'why' },
    });
  });
});
