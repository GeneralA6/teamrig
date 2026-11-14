import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import type { LinkedIssue } from './issue.ts';
import { changedIssues, planLinks, refTarget } from './links.ts';

const REPO = 'acme/web';

function tasks(...list: Task[]): Map<string, Task> {
  return new Map(list.map((task) => [task.id, task]));
}

function mirrored(id: string, number: number, overrides: Partial<Task> = {}): Task {
  return testTask({ id, ref: `gh:${REPO}#${number}`, ...overrides });
}

function issue(number: number, overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return { number, hostId: 1000 + number, parent: undefined, blockedBy: [], ...overrides };
}

describe('refTarget', () => {
  it('reads an issue ref, and nothing from no ref or another kind', () => {
    assert.deepEqual(refTarget({ ref: 'gh:Acme/Web#12' }), { repo: 'acme/web', number: 12 });
    assert.equal(refTarget({ ref: null }), undefined);
    assert.equal(refTarget({ ref: 'https://example.com/12' }), undefined);
    assert.equal(refTarget({ ref: 'gh:acme#12' }), undefined);
  });
});

describe('planLinks', () => {
  it('makes each part of a whole its sub-issue and its blocker', () => {
    const plan = planLinks(tasks(mirrored('T9', 9, { after: ['T10', 'T11'] }), mirrored('T10', 10), mirrored('T11', 11)), REPO, [issue(9), issue(10), issue(11)]);
    assert.deepEqual(plan.writes, [
      { kind: 'blocked-by', target: { repo: REPO, number: 9 }, blocker: { repo: REPO, number: 10 }, blockerId: 1010 },
      { kind: 'sub-issue', parent: { repo: REPO, number: 9 }, child: { repo: REPO, number: 10 }, childId: 1010 },
      { kind: 'blocked-by', target: { repo: REPO, number: 9 }, blocker: { repo: REPO, number: 11 }, blockerId: 1011 },
      { kind: 'sub-issue', parent: { repo: REPO, number: 9 }, child: { repo: REPO, number: 11 }, childId: 1011 },
    ]);
    assert.deepEqual([plan.present, plan.otherParent, plan.manyWholes, plan.otherRepo, plan.missing], [0, 0, 0, 0, 0]);
    assert.equal(changedIssues(plan), 1);
  });

  it('adds nothing the host already has, and counts it present', () => {
    const plan = planLinks(tasks(mirrored('T9', 9, { after: ['T10'] }), mirrored('T10', 10)), REPO, [issue(9, { blockedBy: [10] }), issue(10, { parent: { repo: REPO, number: 9 } })]);
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.present, 2);
    assert.equal(changedIssues(plan), 0);
  });

  it('keeps a parent a person set on the host, in this repository or another, adding only the blocker', () => {
    for (const parent of [{ repo: REPO, number: 4 }, { repo: 'acme/api', number: 9 }]) {
      const plan = planLinks(tasks(mirrored('T9', 9, { after: ['T10'] }), mirrored('T10', 10)), REPO, [issue(9), issue(10, { parent })]);
      assert.deepEqual(
        plan.writes.map((write) => write.kind),
        ['blocked-by'],
      );
      assert.equal(plan.otherParent, 1);
    }
  });

  it('gives a part of two wholes no parent, only a blocker on each', () => {
    const plan = planLinks(tasks(mirrored('T8', 8, { after: ['T10'] }), mirrored('T9', 9, { after: ['T10'] }), mirrored('T10', 10)), REPO, [issue(8), issue(9), issue(10)]);
    assert.deepEqual(
      plan.writes.map((write) => write.kind),
      ['blocked-by', 'blocked-by'],
    );
    assert.equal(plan.manyWholes, 2);
    assert.equal(changedIssues(plan), 2);
  });

  it('counts an edge to another repository, and one whose issue the host did not list, and writes neither', () => {
    const plan = planLinks(
      tasks(mirrored('T9', 9, { after: ['T10', 'T11'] }), testTask({ id: 'T10', ref: 'gh:acme/api#3' }), mirrored('T11', 11)),
      REPO,
      [issue(9)],
    );
    assert.deepEqual(plan.writes, []);
    assert.deepEqual([plan.otherRepo, plan.missing], [1, 1]);
  });

  it('makes no link from or to a dropped task, an unmirrored one, one not in the register or another repository', () => {
    const plan = planLinks(
      tasks(
        mirrored('T9', 9, { after: ['T10', 'T11', 'T12'] }),
        mirrored('T10', 10, { status: 'dropped' }),
        testTask({ id: 'T11' }),
        mirrored('T5', 5, { status: 'dropped', after: ['T13'] }),
        mirrored('T13', 13),
        testTask({ id: 'T6', ref: 'gh:acme/api#6', after: ['T13'] }),
      ),
      REPO,
      [issue(5), issue(9), issue(10), issue(13)],
    );
    assert.deepEqual(plan.writes, []);
    assert.deepEqual([plan.present, plan.otherRepo, plan.missing], [0, 0, 0]);
  });
});
