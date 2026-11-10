import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asksDecision } from '../tabs/status.ts';
import { askerOf, guardsPicker, pickerReason, type LeadMeeting } from './picker-guard.ts';

const PICKER = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' };
/** No meeting open. */
const CLOSED: LeadMeeting = { open: false };

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

const PARENT = { team: 'app', id: 'lead', name: 'app-lead' };

describe('askerOf', () => {
  it("names a session's own thread, the lead's, and a helper of either", () => {
    assert.deepEqual(askerOf('alpha', false, 'lead', undefined), { session: 'alpha', role: 'session' });
    assert.deepEqual(askerOf('lead', false, 'lead', undefined), { session: 'lead', role: 'lead' });
    assert.deepEqual(askerOf('alpha', true, 'lead', undefined), { session: 'alpha', role: 'helper' });
    assert.deepEqual(askerOf('lead', true, 'lead', undefined), { session: 'lead', role: 'helper' });
  });

  it("names a sub-team's lead with its parent lead, and its helpers and members as in any team", () => {
    assert.deepEqual(askerOf('lead', false, 'lead', PARENT), { session: 'lead', role: 'subteam-lead', parentLead: PARENT });
    assert.deepEqual(askerOf('lead', true, 'lead', PARENT), { session: 'lead', role: 'helper' });
    assert.deepEqual(askerOf('alpha', false, 'lead', PARENT), { session: 'alpha', role: 'session' });
  });

  it('leaves a tab that is no team session alone, from a helper too', () => {
    assert.equal(askerOf(undefined, false, 'lead', undefined), undefined);
    assert.equal(askerOf(undefined, true, 'lead', PARENT), undefined);
  });
});

describe('pickerReason', () => {
  it("says why, to decide it if it is the session's own, else to record a card with its default and take the next task", () => {
    const reason = pickerReason('teamrig', { session: 'alpha', role: 'session' }, CLOSED);
    assert.match(reason, /^teamrig picker guard: the question picker stops this session until the owner answers, and the owner may be away for hours/);
    assert.match(reason, /Decide it yourself if it is yours to decide, and note it on its task\. Else record it on its task as a decision card, its --default included, and take your next task/);
    assert.match(reason, /`teamrig set <id> --status waiting --waits decision:owner --note "<what waits>" --question "<what is decided>"/);
    assert.match(reason, /--default "<what happens with no answer>" --session alpha`; the lead brings it to the owner\./);
    assert.equal(asksDecision(reason), false, 'the marker is quoted mid-line, so the reason itself sets no decision circle');
    assert.match(reason, /a `Decision needed:` line\.$/);
  });

  // T1278, T2256: the meeting asks only in plain text, so the lead is never promised the picker there.
  it("tells the lead its card goes on the next meeting's agenda, where it asks the card in plain text", () => {
    const reason = pickerReason('teamrig', { session: 'lead', role: 'lead' }, CLOSED);
    assert.match(reason, /--session lead`; the agenda of the owner's next daily meeting lists it, and you ask it there in plain text \(`teamrig meeting start`\)\./);
    assert.doesNotMatch(reason, /picker opens|the lead brings it/);
    assert.match(reason, /a `Decision needed:` line\.$/);
  });

  it('tells the lead in an open meeting to read the card, let the owner answer in words and record it', () => {
    const reason = pickerReason('teamrig', { session: 'lead', role: 'lead' }, { open: true });
    assert.match(reason, /^teamrig picker guard: the owner's daily meeting asks in plain text\. Read the card as it stands, its options numbered and your recommendation first/);
    assert.doesNotMatch(reason, /askWith/);
    assert.match(reason, /let the owner answer in their own words; record the answer in the same turn: `teamrig update <id> --decided --note "owner decided: <decision>" --session lead`\.$/);
    assert.doesNotMatch(reason, /teamrig set|Decision needed|away for hours/);
  });

  it("tells a sub-team's lead to record the card and pass it to its parent lead, and never to ask the owner from its tab", () => {
    const reason = pickerReason('teamrig', { session: 'lead', role: 'subteam-lead', parentLead: PARENT }, CLOSED);
    assert.match(reason, /Else record it on its task as a decision card, its --default included, and take your next task/);
    assert.match(reason, /--session lead`; then tell your parent lead app\/lead \(name `app-lead`\) in one inbox line,/);
    assert.match(reason, /`teamrig inbox add --to app\/lead --text "T<id> waits on the owner's decision: <what is decided>" --session lead`, and it carries the decision up\./);
    assert.match(reason, /the picker never opens for a sub-team's lead, and its tab never asks the owner: with no task left, end your turn\.$/);
    assert.doesNotMatch(reason, /Decision needed|meeting start|the lead brings it/);
  });

  it('tells a helper to decide it within its brief, else to end its report with the decision, and to run no set', () => {
    const reason = pickerReason('teamrig', { session: 'alpha', role: 'helper' }, CLOSED);
    assert.match(reason, /^teamrig picker guard: a helper's question picker stops the session that started it until the owner answers/);
    assert.match(reason, /Decide it yourself if it is within your brief\. Else finish the rest of your brief and end your report with the decision/);
    assert.match(reason, /the session that started you records it\.$/);
    assert.doesNotMatch(reason, /teamrig set|Decision needed/);
  });
});
