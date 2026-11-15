import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { applyPush } from './push-apply.ts';
import type { IssueChange, PushPlan } from './status-push.ts';

const REPO = 'acme/web';

/** A change on acme/web issue `number` for task T<number>. */
function change(number: number, writes: Partial<Pick<IssueChange, 'add' | 'remove' | 'close' | 'status'>>): IssueChange {
  return { target: { repo: REPO, number }, task: `T${number}`, status: writes.status ?? 'in-progress', add: writes.add ?? [], remove: writes.remove ?? [], close: writes.close };
}

function plan(...changes: IssueChange[]): PushPlan {
  return { repo: REPO, changes, deferred: [], heldCloses: [], unchanged: 0, closedActive: [], unlisted: [] };
}

/** Runs the push and gives its outcome with the lines it said. */
async function push(host: FakeIssueHost, pushed: PushPlan): Promise<{ outcome: Awaited<ReturnType<typeof applyPush>>; lines: string[] }> {
  const lines: string[] = [];
  const outcome = await applyPush(host, pushed, (line) => lines.push(line));
  return { outcome, lines };
}

describe('applyPush', () => {
  it('sends each change whole, its labels added, then taken off, then the close', async () => {
    const host = new FakeIssueHost().hasLabels('status:in-progress');
    const { outcome, lines } = await push(host, plan(change(7, { add: ['status:in-progress'], remove: ['status:triaged'] }), change(8, { status: 'done', remove: ['status:waiting'], close: 'completed' })));
    assert.deepEqual(outcome, { sent: 2, writes: 4, held: 0, failed: undefined });
    assert.deepEqual(lines, ['SET acme/web#7 T7 in-progress: add status:in-progress, take off status:triaged', 'SET acme/web#8 T8 done: close as completed, take off status:waiting']);
    assert.deepEqual(host.calls, [
      { kind: 'label-add', target: { repo: REPO, number: 7 }, labels: ['status:in-progress'] },
      { kind: 'label-remove', target: { repo: REPO, number: 7 }, label: 'status:triaged' },
      { kind: 'label-remove', target: { repo: REPO, number: 8 }, label: 'status:waiting' },
      { kind: 'close', target: { repo: REPO, number: 8 }, reason: 'completed' },
    ]);
  });

  it('holds the changes adding a label the repository lacks, and sends the rest', async () => {
    const host = new FakeIssueHost().hasLabels('status:waiting');
    const { outcome, lines } = await push(host, plan(change(1, { add: ['status:in-review'] }), change(2, { add: ['status:waiting'] }), change(3, { add: ['status:in-review'] })));
    assert.deepEqual(outcome, { sent: 1, writes: 1, held: 2, failed: undefined });
    assert.deepEqual(lines, ['MISSING acme/web: no label "status:in-review"; make it there, and the 2 change(s) adding it go on the next run', 'SET acme/web#2 T2 in-progress: add status:waiting']);
    assert.deepEqual(host.calls, [{ kind: 'label-add', target: { repo: REPO, number: 2 }, labels: ['status:waiting'] }]);
  });

  it('writes nothing when a label read fails', async () => {
    const host = new FakeIssueHost().failsLabelRead('HTTP 502');
    const { outcome, lines } = await push(host, plan(change(1, { add: ['status:waiting'] })));
    assert.deepEqual(outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 502' });
    assert.deepEqual(lines, ['FAILED acme/web: HTTP 502; nothing was written']);
    assert.deepEqual(host.calls, []);
  });

  it('stops the repository at the first failed write, whichever step it is', async () => {
    const added = await push(new FakeIssueHost().hasLabels('status:waiting').failsLabel('HTTP 403'), plan(change(1, { add: ['status:waiting'] }), change(2, { remove: ['status:triaged'] })));
    assert.deepEqual(added.outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 403' });
    assert.deepEqual(added.lines, ['FAILED acme/web#1 T1: HTTP 403; the rest of acme/web waits for the next run']);
    const removed = await push(new FakeIssueHost().failsRemove('status:waiting', 'HTTP 404'), plan(change(4, { remove: ['status:triaged'] }), change(5, { remove: ['status:waiting'] }), change(6, { remove: ['status:triaged'] })));
    assert.deepEqual(removed.outcome, { sent: 1, writes: 1, held: 0, failed: 'HTTP 404' });
    const host = new FakeIssueHost().failsClose('HTTP 410');
    const closed = await push(host, plan(change(9, { status: 'dropped', close: 'not-planned' })));
    assert.deepEqual(closed.outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 410' });
  });
});
