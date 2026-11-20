import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPENING_TYPE, openableNames, openingType } from './issue-type.ts';

const EPIC = { id: '10000', name: 'Epic', subtask: false };
const SUB_TASK = { id: '10003', name: 'Sub-task', subtask: true };
const TASK = { id: '10002', name: 'Task', subtask: false };
const BUG = { id: '10004', name: 'Bug', subtask: false };

describe('the type a new Jira issue opens as (T4754)', () => {
  it("is the project's Task, wherever the list holds it", () => {
    assert.equal(OPENING_TYPE, 'Task');
    assert.equal(openingType({ issueTypes: [EPIC, SUB_TASK, TASK, BUG] }), '10002');
  });

  it('is the first type that is no sub-task when the project has no Task', () => {
    assert.equal(openingType({ issueTypes: [SUB_TASK, BUG, EPIC] }), '10004');
    assert.equal(openingType({ issueTypes: [{ id: '7', name: 'Aufgabe' }] }), '7');
  });

  it('is never a sub-task, even one named Task', () => {
    assert.equal(openingType({ issueTypes: [{ id: '5', name: 'Task', subtask: true }, BUG] }), '10004');
    assert.equal(openingType({ issueTypes: [SUB_TASK] }), undefined);
  });

  it('leaves out a type that does not read as one, and finds none in an answer that is no list of types', () => {
    assert.equal(openingType({ issueTypes: [7, null, { name: 'Task' }, { id: '', name: 'Task' }, { id: 10002, name: 'Task' }, BUG] }), '10004');
    assert.equal(openingType({ issueTypes: [] }), undefined);
    assert.equal(openingType({ issueTypes: 'Task' }), undefined);
    assert.equal(openingType({}), undefined);
    assert.equal(openingType([TASK]), undefined);
    assert.equal(openingType(undefined), undefined);
  });

  it("is the type the team's config names, its name in any case, and no other when the project lacks it (T4766)", () => {
    assert.equal(openingType({ issueTypes: [EPIC, TASK, BUG] }, 'Bug'), '10004');
    assert.equal(openingType({ issueTypes: [EPIC, TASK, BUG] }, 'epic'), '10000');
    assert.equal(openingType({ issueTypes: [EPIC, TASK] }, 'Bug'), undefined);
    assert.equal(openingType({ issueTypes: [SUB_TASK, TASK] }, 'Sub-task'), undefined);
  });

  it('names the types an issue can open as, a sub-task and a type with no name left out (T4766)', () => {
    assert.deepEqual(openableNames({ issueTypes: [EPIC, SUB_TASK, TASK, { id: '9' }] }), ['Epic', 'Task']);
    assert.deepEqual(openableNames({}), []);
  });
});
