import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { applyPush } from './push-apply.ts';
import { STATUS_LABEL_SPECS, type IssueChange, type PushPlan } from './status-push.ts';

const REPO = 'acme/web';

/** A change on acme/web issue `number` for task T<number>. */
function change(number: number, writes: Partial<Pick<IssueChange, 'add' | 'remove' | 'close' | 'status' | 'assign'>>): IssueChange {
  const base = { target: { repo: REPO, number }, task: `T${number}`, status: writes.status ?? 'in-progress', add: writes.add ?? [], remove: writes.remove ?? [], close: writes.close };
  return writes.assign === undefined ? base : { ...base, assign: writes.assign };
}

function plan(...changes: IssueChange[]): PushPlan {
  return { repo: REPO, changes, deferred: [], heldCloses: [], unchanged: 0, closedActive: [], keptOpen: [], unlisted: [] };
}

/** Runs the push and gives its outcome with the lines it said. */
async function push(host: FakeIssueHost, pushed: PushPlan): Promise<{ outcome: Awaited<ReturnType<typeof applyPush>>; lines: string[] }> {
  const lines: string[] = [];
  const outcome = await applyPush(host, pushed, (line) => lines.push(line));
  return { outcome, lines };
}

describe('applyPush', () => {
  it('reads each login once, then sends the assign after the labels', async () => {
    const host = new FakeIssueHost().hasLabels('status:in progress');
    const { outcome, lines } = await push(host, plan(change(7, { add: ['status:in progress'], assign: 'octocat' }), change(8, { assign: 'octocat' })));
    assert.deepEqual(outcome, { sent: 2, writes: 3, held: 0, failed: undefined });
    assert.deepEqual(lines, ['SET acme/web#7 T7 in-progress: add status:in progress, assign octocat', 'SET acme/web#8 T8 in-progress: assign octocat']);
    assert.deepEqual(
      host.calls.map((call) => call.kind),
      ['label-add', 'assign', 'assign'],
    );
  });

  it('sends a change without the assign of a login the repository may not assign, and skips one left empty', async () => {
    const host = new FakeIssueHost().hasLabels('status:in progress').cannotAssign('acme');
    const { outcome, lines } = await push(host, plan(change(7, { add: ['status:in progress'], assign: 'acme' }), change(8, { assign: 'acme' })));
    assert.deepEqual(outcome, { sent: 1, writes: 1, held: 0, failed: undefined });
    assert.deepEqual(lines, [
      'UNASSIGNED acme/web: acme may not be assigned there (not a person with access to it); its 2 issue(s) stay unassigned: map the owning session to a login that may under github.owners',
      'SET acme/web#7 T7 in-progress: add status:in progress',
    ]);
    assert.ok(host.calls.every((call) => call.kind !== 'assign'));
  });

  it('assigns a login as the host spells it, since GitHub drops an assign in another case (T2999)', async () => {
    const host = new FakeIssueHost().spells('GeneralA6');
    const { lines } = await push(host, plan(change(7, { assign: 'generala6' })));
    assert.deepEqual(lines, ['SET acme/web#7 T7 in-progress: assign GeneralA6']);
    assert.deepEqual(host.calls.flatMap((call) => (call.kind === 'assign' ? [call.logins] : [])), [['GeneralA6']]);
  });

  it('writes nothing when a login read fails, and stops the repository at a failed assign', async () => {
    const unread = await push(new FakeIssueHost().readsAssignee({ kind: 'failed', reason: 'gh was stopped' }), plan(change(7, { assign: 'octocat' })));
    assert.deepEqual(unread.outcome, { sent: 0, writes: 0, held: 0, failed: 'gh was stopped' });
    assert.deepEqual(unread.lines, ['FAILED acme/web: gh was stopped; nothing was written']);
    const refused = await push(new FakeIssueHost().failsAssign('may not assign'), plan(change(7, { assign: 'octocat' }), change(8, { assign: 'octocat' })));
    assert.deepEqual(refused.outcome, { sent: 0, writes: 0, held: 0, failed: 'may not assign' });
    assert.deepEqual(refused.lines, ['FAILED acme/web#7 T7: may not assign; the rest of acme/web waits for the next run']);
  });

  it('sends each change whole, its labels added, then taken off, then the close', async () => {
    const host = new FakeIssueHost().hasLabels('status:in progress');
    const { outcome, lines } = await push(host, plan(change(7, { add: ['status:in progress'], remove: ['status:open'] }), change(8, { status: 'done', remove: ['status:waiting'], close: 'completed' })));
    assert.deepEqual(outcome, { sent: 2, writes: 4, held: 0, failed: undefined });
    assert.deepEqual(lines, ['SET acme/web#7 T7 in-progress: add status:in progress, take off status:open', 'SET acme/web#8 T8 done: close as completed, take off status:waiting']);
    assert.deepEqual(host.calls, [
      { kind: 'label-add', target: { repo: REPO, number: 7 }, labels: ['status:in progress'] },
      { kind: 'label-remove', target: { repo: REPO, number: 7 }, label: 'status:open' },
      { kind: 'label-remove', target: { repo: REPO, number: 8 }, label: 'status:waiting' },
      { kind: 'close', target: { repo: REPO, number: 8 }, reason: 'completed' },
    ]);
  });

  it('holds the changes adding a label the repository lacks and the push does not own, and sends the rest', async () => {
    const host = new FakeIssueHost().hasLabels('status:waiting');
    const { outcome, lines } = await push(host, plan(change(1, { add: ['status:blocked'] }), change(2, { add: ['status:waiting'] }), change(3, { add: ['status:blocked'] })));
    assert.deepEqual(outcome, { sent: 1, writes: 1, held: 2, failed: undefined });
    assert.deepEqual(lines, ['MISSING acme/web: no label "status:blocked"; make it there, and the 2 change(s) adding it go on the next run', 'SET acme/web#2 T2 in-progress: add status:waiting']);
    assert.deepEqual(host.calls, [{ kind: 'label-add', target: { repo: REPO, number: 2 }, labels: ['status:waiting'] }]);
  });

  it('makes each status label the repository lacks, once and before any change, then sends the changes adding it (T2999)', async () => {
    const host = new FakeIssueHost().hasLabels('status:waiting');
    const { outcome, lines } = await push(host, plan(change(1, { add: ['status:in review'] }), change(2, { add: ['status:waiting'] }), change(3, { add: ['status:in review'] })));
    assert.deepEqual(outcome, { sent: 3, writes: 4, held: 0, failed: undefined });
    assert.deepEqual(lines, [
      'MADE acme/web: the label "status:in review", which the push sets',
      'SET acme/web#1 T1 in-progress: add status:in review',
      'SET acme/web#2 T2 in-progress: add status:waiting',
      'SET acme/web#3 T3 in-progress: add status:in review',
    ]);
    assert.deepEqual(host.calls[0], { kind: 'label-create', repo: REPO, label: STATUS_LABEL_SPECS.find((spec) => spec.name === 'status:in review') });
    assert.equal(host.calls.filter((call) => call.kind === 'label-create').length, 1);
  });

  it('sends no change when making a status label fails', async () => {
    const host = new FakeIssueHost().failsLabelCreate('HTTP 403');
    const { outcome, lines } = await push(host, plan(change(1, { add: ['status:waiting'] })));
    assert.deepEqual(outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 403' });
    assert.deepEqual(lines, ['FAILED acme/web: HTTP 403; no change was sent']);
    assert.ok(host.calls.every((call) => call.kind === 'label-create'));
  });

  it('writes nothing when a label read fails', async () => {
    const host = new FakeIssueHost().failsLabelRead('HTTP 502');
    const { outcome, lines } = await push(host, plan(change(1, { add: ['status:waiting'] })));
    assert.deepEqual(outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 502' });
    assert.deepEqual(lines, ['FAILED acme/web: HTTP 502; nothing was written']);
    assert.deepEqual(host.calls, []);
  });

  it('stops the repository at the first failed write, whichever step it is', async () => {
    const added = await push(new FakeIssueHost().hasLabels('status:waiting').failsLabel('HTTP 403'), plan(change(1, { add: ['status:waiting'] }), change(2, { remove: ['status:open'] })));
    assert.deepEqual(added.outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 403' });
    assert.deepEqual(added.lines, ['FAILED acme/web#1 T1: HTTP 403; the rest of acme/web waits for the next run']);
    const removed = await push(new FakeIssueHost().failsRemove('status:waiting', 'HTTP 404'), plan(change(4, { remove: ['status:open'] }), change(5, { remove: ['status:waiting'] }), change(6, { remove: ['status:open'] })));
    assert.deepEqual(removed.outcome, { sent: 1, writes: 1, held: 0, failed: 'HTTP 404' });
    const host = new FakeIssueHost().failsClose('HTTP 410');
    const closed = await push(host, plan(change(9, { status: 'dropped', close: 'not-planned' })));
    assert.deepEqual(closed.outcome, { sent: 0, writes: 0, held: 0, failed: 'HTTP 410' });
  });
});
