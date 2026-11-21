import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../../../plugin-api/index.ts';
import { closingStep, isDoneStatus } from './transitions.ts';

const DONE = { key: 'done' };
const OPEN = { key: 'indeterminate' };

/** A transition as Jira lists it: its id, the status it ends in with that status's category, then `over`. */
function transition(id: string, status: string, category: JsonRecord = DONE, over: JsonRecord = {}): JsonRecord {
  return { id, name: `To ${status}`, to: { name: status, statusCategory: category }, ...over };
}

/** The resolution field of a transition's screen. */
function resolutions(names: readonly string[], required: boolean = false): JsonRecord {
  return { fields: { resolution: { required, allowedValues: names.map((name, at) => ({ id: `r${at + 1}`, name })) } } };
}

describe('whether a Jira status is a closed one', () => {
  it('goes by the status category, never the name', () => {
    assert.equal(isDoneStatus({ name: 'In review', statusCategory: DONE }), true);
    assert.equal(isDoneStatus({ name: 'Done', statusCategory: OPEN }), false);
    assert.equal(isDoneStatus({ name: 'Done' }), false);
    assert.equal(isDoneStatus(undefined), false);
  });
});

describe('the transition a Jira issue closes by', () => {
  it('is none when no transition ends in a closed status, or the answer lists none', () => {
    assert.equal(closingStep({ transitions: [transition('11', 'In Progress', OPEN)] }, 'completed'), undefined);
    assert.equal(closingStep({ transitions: [] }, 'completed'), undefined);
    assert.equal(closingStep({}, 'completed'), undefined);
    assert.equal(closingStep('no answer', 'completed'), undefined);
  });

  it('is the one whose closed status is named for the reason', () => {
    const offered = { transitions: [transition('11', 'In Progress', OPEN), transition('21', "Won't Do"), transition('31', 'Done')] };
    assert.deepEqual(closingStep(offered, 'completed'), { id: '31', resolution: undefined });
    assert.deepEqual(closingStep(offered, 'not-planned'), { id: '21', resolution: undefined });
  });

  it('else is the one whose screen takes a resolution named for the reason, sent with it', () => {
    const offered = { transitions: [transition('21', 'Archived'), transition('31', 'Done', DONE, resolutions(['Done', "Won't Do", 'Duplicate']))] };
    assert.deepEqual(closingStep(offered, 'not-planned'), { id: '31', resolution: 'r2' });
    assert.deepEqual(closingStep(offered, 'duplicate'), { id: '31', resolution: 'r3' });
    assert.deepEqual(closingStep(offered, 'completed'), { id: '31', resolution: 'r1' });
  });

  it('else is one whose status is named for no reason, before one named for another', () => {
    const offered = { transitions: [transition('21', "Won't Do"), transition('31', 'Closed')] };
    assert.deepEqual(closingStep(offered, 'completed'), { id: '31', resolution: undefined });
  });

  it('else is the first, so an issue closes whenever its workflow lets it', () => {
    assert.deepEqual(closingStep({ transitions: [transition('31', 'Done')] }, 'not-planned'), { id: '31', resolution: undefined });
  });

  it('sends the first resolution allowed when the screen must have one and none is named for the reason, and none when it need not', () => {
    assert.deepEqual(closingStep({ transitions: [transition('31', 'Closed', DONE, resolutions(['Shipped', 'Parked'], true))] }, 'completed'), { id: '31', resolution: 'r1' });
    assert.deepEqual(closingStep({ transitions: [transition('31', 'Closed', DONE, resolutions(['Shipped', 'Parked']))] }, 'completed'), { id: '31', resolution: undefined });
  });

  it('passes over what does not read as a transition or a resolution', () => {
    const offered = {
      transitions: [
        'no transition',
        { to: { name: 'Done', statusCategory: DONE } },
        { id: '', to: { name: 'Done', statusCategory: DONE } },
        { id: '41', to: 'Done' },
        transition('51', 'Done', DONE, { fields: { resolution: { required: true, allowedValues: ['Done', { name: 'Done' }, { id: 'r9', name: 'Fixed' }] } } }),
      ],
    };
    assert.deepEqual(closingStep(offered, 'completed'), { id: '51', resolution: 'r9' });
  });
});
