import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIssueHost, FAKE_VIEWER } from '../testing/fake-issue-host.ts';
import { testHostIssue } from '../testing/host-issue.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from '../register/fold.ts';
import type { HostIssue } from './issue.ts';
import { planAssigned, viewerOf, type AssignedPlan } from './push-assignees.ts';
import { changeLine, planPush, pushAssignees, sessionLogins, VIEWER_UNREAD, type PushLimits } from './status-push.ts';

const REPO = 'acme/web';

/** Task `id` holding acme/web#`number`, scheduled, owned by `owner`. */
function holding(id: string, number: number, owner: string, overrides: Partial<Task> = {}): Task {
  return testTask({ id, ref: `gh:${REPO}#${number}`, owner, status: 'in-progress', ...overrides });
}

/**
 * Plans acme/web's `issues` (by default 1..n, each unassigned and unlabelled) for `tasks`, with the login reads `host`
 * answers, the login the sync runs as among them (FAKE_VIEWER unless `host.runsAs` says otherwise), read only when a
 * plan wants it.
 */
async function assignedFor(
  host: FakeIssueHost,
  tasks: readonly Task[],
  limits: PushLimits,
  owners: Readonly<Record<string, string>>,
  issues: readonly HostIssue[] = tasks.map((_, index) => testHostIssue(index + 1)),
): Promise<{ result: AssignedPlan; lines: string[] }> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };
  const result = await planAssigned(host, REPO, (who) => planPush(REPO, issues, tasks, limits, who), pushAssignees(sessionLogins(owners), VIEWER_UNREAD), () => viewerOf(host, REPO, say), say);
  return { result, lines };
}

/** The change lines of a planned result, in the run and deferred. */
function planned(result: AssignedPlan): { changes: string[]; deferred: string[] } {
  assert.equal(result.kind, 'planned');
  return result.kind === 'planned' ? { changes: result.plan.changes.map(changeLine), deferred: result.plan.deferred.map(changeLine) } : { changes: [], deferred: [] };
}

describe('planAssigned (T4581)', () => {
  const RUN: PushLimits = { writesPerRun: 40, closes: true };

  it("assigns a mapped session's issue to its login, and an unmapped one's to the login the sync runs as, never the repository's owner", async () => {
    const { result, lines } = await assignedFor(new FakeIssueHost(), [holding('T1', 1, 'dev'), holding('T2', 2, 'lead')], RUN, { octocat: 'dev' });
    assert.deepEqual(planned(result).changes, ['LABEL acme/web#1 T1 in-progress: add status:in progress, assign octocat', `LABEL acme/web#2 T2 in-progress: add status:in progress, assign ${FAKE_VIEWER}`]);
    assert.deepEqual(lines, []);
  });

  it('passes a refused session login to the login the sync runs as, and leaves the issue unassigned when that is refused too', async () => {
    const viewerTakes = await assignedFor(new FakeIssueHost().cannotAssign('octocat'), [holding('T1', 1, 'dev')], RUN, { octocat: 'dev' });
    assert.deepEqual(planned(viewerTakes.result).changes, [`LABEL acme/web#1 T1 in-progress: add status:in progress, assign ${FAKE_VIEWER}`]);
    assert.deepEqual(viewerTakes.lines, [
      'UNASSIGNED acme/web: octocat may not be assigned there (not a person with access to it); its 1 issue(s) go to the next login in line, the one the sync runs as, or stay unassigned, at no write: map the owning session to a login that may under github.owners',
    ]);
    const none = await assignedFor(new FakeIssueHost().cannotAssign('octocat', FAKE_VIEWER), [holding('T1', 1, 'dev')], RUN, { octocat: 'dev' });
    assert.deepEqual(planned(none.result).changes, ['LABEL acme/web#1 T1 in-progress: add status:in progress']);
    assert.equal(none.lines.length, 2);
  });

  it('plans no write for a refused assign, so the labels behind it go out in the same run (#928, #1232)', async () => {
    const tasks = [holding('T1', 1, 'lead', { status: 'open', due: '2030-01-09' }), holding('T2', 2, 'lead', { status: 'open', due: '2030-01-09' }), holding('T3', 3, 'dev'), holding('T4', 4, 'dev')];
    const { result } = await assignedFor(new FakeIssueHost().cannotAssign(FAKE_VIEWER, 'octocat'), tasks, { writesPerRun: 4, closes: false }, { octocat: 'dev' });
    assert.deepEqual(planned(result), {
      changes: ['LABEL acme/web#1 T1 open: add status:claimed', 'LABEL acme/web#2 T2 open: add status:claimed', 'LABEL acme/web#3 T3 in-progress: add status:in progress', 'LABEL acme/web#4 T4 in-progress: add status:in progress'],
      deferred: [],
    });
  });

  it('reads each login once, the deferred changes\' too, and keeps it as the host spells it (T2999)', async () => {
    const host = new FakeIssueHost().spells('GeneralA6');
    const { result } = await assignedFor(host, [holding('T1', 1, 'dev'), holding('T2', 2, 'dev')], { writesPerRun: 2, closes: true }, { generala6: 'dev' });
    assert.deepEqual(planned(result), {
      changes: ['LABEL acme/web#1 T1 in-progress: add status:in progress, assign GeneralA6'],
      deferred: ['LABEL acme/web#2 T2 in-progress: add status:in progress, assign GeneralA6'],
    });
  });

  it('assigns mapped sessions only when the login the sync runs as is unknown', async () => {
    const { result } = await assignedFor(new FakeIssueHost().runsAs({ kind: 'failed', reason: 'HTTP 403' }), [holding('T1', 1, 'dev'), holding('T2', 2, 'lead')], RUN, { octocat: 'dev' });
    assert.deepEqual(planned(result).changes, ['LABEL acme/web#1 T1 in-progress: add status:in progress, assign octocat', 'LABEL acme/web#2 T2 in-progress: add status:in progress']);
  });

  it('reads the login the sync runs as only when a plan wants it, and once', async () => {
    const mapped = new FakeIssueHost();
    await assignedFor(mapped, [holding('T1', 1, 'dev'), holding('T2', 2, 'dev')], RUN, { octocat: 'dev' });
    assert.equal(mapped.viewerReads, 0);
    const unmapped = new FakeIssueHost();
    await assignedFor(unmapped, [holding('T1', 1, 'lead'), holding('T2', 2, 'lead')], RUN, { octocat: 'dev' });
    assert.equal(unmapped.viewerReads, 1);
    const refused = new FakeIssueHost().cannotAssign('octocat');
    await assignedFor(refused, [holding('T1', 1, 'dev')], RUN, { octocat: 'dev' });
    assert.equal(refused.viewerReads, 1);
  });

  it('reads it for a close left for outside logins, and sends the close when the viewer holds the issue', async () => {
    const host = new FakeIssueHost();
    const { result } = await assignedFor(host, [holding('T1', 1, 'dev', { status: 'done' })], RUN, { octocat: 'dev' }, [testHostIssue(1, { assignees: [FAKE_VIEWER] })]);
    assert.equal(host.viewerReads, 1);
    assert.equal(result.kind, 'planned');
    if (result.kind === 'planned') {
      assert.deepEqual(result.plan.changes.map((change) => change.close), ['completed']);
      assert.deepEqual(result.plan.keptOpen, []);
    }
  });

  it('plans nothing when a login read fails, and says nothing was written', async () => {
    const { result, lines } = await assignedFor(new FakeIssueHost().readsAssignee({ kind: 'failed', reason: 'gh was stopped' }), [holding('T1', 1, 'dev')], RUN, { octocat: 'dev' });
    assert.deepEqual(result, { kind: 'failed', reason: 'gh was stopped' });
    assert.deepEqual(lines, ['FAILED acme/web: gh was stopped; nothing was written']);
  });
});

describe('viewerOf (T4581)', () => {
  it('gives the login the access belongs to, and a NOTE with no login when it cannot be read', async () => {
    const lines: string[] = [];
    assert.equal(await viewerOf(new FakeIssueHost(), REPO, (line) => lines.push(line)), FAKE_VIEWER);
    assert.equal(await viewerOf(new FakeIssueHost().runsAs({ kind: 'failed', reason: 'HTTP 403' }), REPO, (line) => lines.push(line)), undefined);
    assert.deepEqual(lines, ['NOTE acme/web: the login the sync runs as could not be read (HTTP 403), so an issue whose session maps to no login under github.owners stays unassigned']);
  });
});
