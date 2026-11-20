import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gh } from './github.ts';
import type { MainBranch, MergeRequest, Waiter } from './merge.ts';
import { mergeGroupFailure, parseQueueRead, queueLanding } from './merge-queue.ts';
import type { PullRequest } from './pulls.ts';

const REPO = 'Owner/repo';
const SHA = 'abc1234def';
const MERGED = 'merged0ccc';
const TIP = 'tip0000ddd';
const MINUTE = 60_000;
const PULL: PullRequest = { number: 7, url: 'https://github.com/Owner/repo/pull/7', headRef: 'dev', headSha: SHA, baseRef: 'main' };
const REQUEST: MergeRequest = { repo: REPO, head: 'dev', base: 'main', sha: SHA, title: 'Merge dev', body: '', lacks: null, opens: true, labels: [], unlinked: null };
const POLLING = { intervalMs: 30_000, timeoutMs: 10 * MINUTE };

/** A head pushed to the pull request after SHA was approved. */
const OTHER = 'other99eeee';

/** One read of the pull request: in the queue at a state and place, merged, or neither; at `head`, else SHA. */
type Round =
  | { kind: 'queued'; state: string; position: number; head?: string }
  | { kind: 'merged'; commit?: string | null; head?: string }
  | { kind: 'out' }
  | { kind: 'error'; message: string };

interface Options {
  rounds: readonly Round[];
  /** The removal the timeline shows before the enqueue, then after the pull request left the queue. */
  removedBefore?: { id: string; reason: string };
  removedAfter?: { id: string; reason: string };
  enqueue?: Error;
  /** The merge group runs (REST) and the failed run's jobs. */
  runs?: readonly Record<string, unknown>[];
  jobs?: readonly Record<string, unknown>[];
}

interface FakeQueue {
  gh: Gh;
  calls: string[][];
  enqueued: string[][];
}

/** GitHub whose pull request moves through `rounds`, one per read (the last repeats). */
function fakeQueue(options: Options): FakeQueue {
  const calls: string[][] = [];
  const enqueued: string[][] = [];
  let reads = 0;
  const gh: Gh = args => {
    calls.push([...args]);
    const query = args.find(arg => arg.startsWith('query=')) ?? '';
    if (query.startsWith('query=mutation')) {
      enqueued.push([...args]);
      if (options.enqueue !== undefined) throw options.enqueue;
      return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } } });
    }
    if (args[1] === 'graphql') {
      const round = options.rounds[Math.min(reads, options.rounds.length - 1)] ?? { kind: 'out' };
      const removed = enqueued.length > 0 && reads > 0 ? (options.removedAfter ?? options.removedBefore) : options.removedBefore;
      reads += 1;
      if (round.kind === 'error') throw new Error(round.message);
      const commit = round.kind === 'merged' ? (round.commit === undefined ? MERGED : round.commit) : null;
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: 'PR_node7',
              headRefOid: round.kind === 'out' ? SHA : (round.head ?? SHA),
              merged: round.kind === 'merged',
              mergeCommit: commit === null ? null : { oid: commit },
              mergeQueueEntry: round.kind === 'queued' ? { state: round.state, position: round.position } : null,
              timelineItems: { nodes: removed === undefined ? [] : [removed] },
            },
          },
        },
      });
    }
    if (args[1]?.includes('/jobs')) return JSON.stringify({ jobs: options.jobs ?? [] });
    if (args[1]?.includes('event=merge_group')) return JSON.stringify({ workflow_runs: options.runs ?? [] });
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { gh, calls, enqueued };
}

function fakeMain(options: { holds?: boolean; error?: Error } = {}): MainBranch {
  return {
    tip: () => {
      if (options.error !== undefined) throw options.error;
      return TIP;
    },
    contains: (sha, ancestor) => sha === TIP && ancestor === MERGED && options.holds !== false,
    treeOf: sha => `tree-${sha}`,
  };
}

function fakeWaiter(): Waiter & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    },
  };
}

async function land(queue: FakeQueue, main: MainBranch = fakeMain(), waiter: Waiter = fakeWaiter()) {
  const lines: string[] = [];
  const result = await queueLanding(queue.gh, main, waiter, POLLING).land(PULL, REQUEST, line => lines.push(line));
  return { result, lines };
}

test('queueLanding: never holds a head back for main moving, as the queue tests it on main', () => {
  assert.equal(queueLanding(fakeQueue({ rounds: [] }).gh, fakeMain(), fakeWaiter(), POLLING).behind(REQUEST), null);
});

test('queueLanding: enqueues the approved head and lands once main holds the merge commit', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'queued', state: 'AWAITING_CHECKS', position: 1 }, { kind: 'queued', state: 'AWAITING_CHECKS', position: 1 }, { kind: 'merged' }] });
  const { result, lines } = await land(queue);
  assert.deepEqual(result, { kind: 'merged', pull: PULL, sha: MERGED });
  assert.equal(queue.enqueued.length, 1);
  assert.ok(queue.enqueued[0]?.includes('id=PR_node7'));
  assert.ok(queue.enqueued[0]?.includes(`head=${SHA}`));
  assert.ok(lines.includes(`enqueued #7 at ${SHA.slice(0, 7)} in the merge queue`));
  assert.equal(lines.filter(line => line === 'merge queue: #7 awaiting checks at position 1').length, 1);
});

test('queueLanding: waits on a pull request already in the queue, enqueueing it no second time', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'queued', state: 'QUEUED', position: 2 }, { kind: 'merged' }] });
  const { result, lines } = await land(queue);
  assert.equal(result.kind, 'merged');
  assert.equal(queue.enqueued.length, 0);
  assert.ok(lines.includes('#7 is already in the merge queue (queued at position 2): waiting on it'));
});

test('queueLanding: a pull request already queued at a head other than the approved one is refused, not waited on (T4681)', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'queued', state: 'QUEUED', position: 2, head: OTHER }, { kind: 'merged', head: OTHER }] });
  const waiter = fakeWaiter();
  const { result } = await land(queue, fakeMain(), waiter);
  assert.deepEqual(result, {
    kind: 'refused',
    pull: PULL,
    reason: `#7 is in the merge queue at ${OTHER.slice(0, 7)}, not the approved ${SHA.slice(0, 7)}: take it out of the queue, or ask approval of ${OTHER.slice(0, 7)} naming it and run merge again`,
  });
  assert.equal(queue.enqueued.length, 0);
  assert.deepEqual(waiter.slept, []);
});

test('queueLanding: an enqueue call with no answer, read again at a head other than the approved one, is refused (T4681)', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'queued', state: 'QUEUED', position: 1, head: OTHER }], enqueue: new Error('gh api graphql: HTTP 502') });
  const waiter = fakeWaiter();
  const { result } = await land(queue, fakeMain(), waiter);
  assert.equal(result.kind === 'refused' ? result.reason : result.kind, `#7 is in the merge queue at ${OTHER.slice(0, 7)}, not the approved ${SHA.slice(0, 7)}: take it out of the queue, or ask approval of ${OTHER.slice(0, 7)} naming it and run merge again`);
  assert.deepEqual(waiter.slept, []);
});

test('queueLanding: a head pushed and queued while the run waits is refused at the next poll (T4681)', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'queued', state: 'QUEUED', position: 1 }, { kind: 'queued', state: 'QUEUED', position: 1, head: OTHER }] });
  const { result } = await land(queue);
  assert.equal(result.kind === 'refused' ? result.reason : result.kind, `#7 is in the merge queue at ${OTHER.slice(0, 7)}, not the approved ${SHA.slice(0, 7)}: take it out of the queue, or ask approval of ${OTHER.slice(0, 7)} naming it and run merge again`);
});

test('queueLanding: a merge of a head other than the approved one is refused, never reported merged (T4681)', async () => {
  const before = await land(fakeQueue({ rounds: [{ kind: 'merged', head: OTHER }] }));
  const reason = `#7 merged at ${OTHER.slice(0, 7)}, not the approved ${SHA.slice(0, 7)}: nobody approved that head through this merge, so check ${PULL.url} and main`;
  assert.deepEqual(before.result, { kind: 'refused', pull: PULL, reason });
  const waited = await land(fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'queued', state: 'QUEUED', position: 1 }, { kind: 'merged', head: OTHER }] }));
  assert.deepEqual(waited.result, { kind: 'refused', pull: PULL, reason });
});

test('parseQueueRead: reads the head the pull request is at', () => {
  const read = parseQueueRead(JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_1', headRefOid: SHA, merged: false, mergeCommit: null, mergeQueueEntry: null, timelineItems: { nodes: [] } } } } }));
  assert.equal(read.headRefOid, SHA);
  assert.throws(() => parseQueueRead(JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_1', merged: false, timelineItems: { nodes: [] } } } } })), /headRefOid/);
});

test('queueLanding: a pull request merged before the run is merged at once', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'merged' }] });
  const { result } = await land(queue);
  assert.deepEqual(result, { kind: 'merged', pull: PULL, sha: MERGED });
  assert.equal(queue.enqueued.length, 0);
});

test("queueLanding: an ejected pull request is refused with GitHub's reason and the failed merge group run", async () => {
  const queue = fakeQueue({
    rounds: [{ kind: 'out' }, { kind: 'queued', state: 'AWAITING_CHECKS', position: 1 }, { kind: 'out' }],
    removedBefore: { id: 'old', reason: 'MANUAL' },
    removedAfter: { id: 'new', reason: 'FAILED_CHECKS' },
    runs: [
      { id: 5, name: 'CI', head_branch: 'gh-readonly-queue/main/pr-7-aaa', conclusion: 'success', html_url: 'https://github.com/Owner/repo/actions/runs/5' },
      { id: 9, name: 'CI', head_branch: 'gh-readonly-queue/main/pr-7-bbb', conclusion: 'failure', html_url: 'https://github.com/Owner/repo/actions/runs/9' },
      { id: 11, name: 'CI', head_branch: 'gh-readonly-queue/main/pr-70-ccc', conclusion: 'failure', html_url: 'https://github.com/Owner/repo/actions/runs/11' },
    ],
    jobs: [
      { name: 'test (windows-latest)', conclusion: 'failure' },
      { name: 'test (ubuntu-latest)', conclusion: 'success' },
      { name: 'every check passed', conclusion: 'failure' },
      { name: 'dependency-review', conclusion: 'skipped' },
    ],
  });
  const { result } = await land(queue);
  assert.deepEqual(result, {
    kind: 'refused',
    pull: PULL,
    reason: '#7 left the merge queue unmerged (GitHub: failed checks): merge group run CI failure: test (windows-latest) (failure), every check passed (failure); https://github.com/Owner/repo/actions/runs/9',
  });
  assert.ok(queue.calls.some(call => call[1] === 'repos/Owner/repo/actions/runs/9/jobs?filter=latest&per_page=100'));
});

test('queueLanding: an ejection names no removal older than this enqueue, and points at the pull request with no failed run', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }], removedBefore: { id: 'old', reason: 'MANUAL' } });
  const { result } = await land(queue);
  assert.deepEqual(result, { kind: 'refused', pull: PULL, reason: `#7 left the merge queue unmerged: no failed merge group run found; see ${PULL.url}` });
});

test('queueLanding: an enqueue GitHub refused is refused with its answer', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }], enqueue: new Error('gh api graphql: GraphQL: Head ref was modified') });
  const { result } = await land(queue);
  assert.deepEqual(result, { kind: 'refused', pull: PULL, reason: 'GitHub did not enqueue #7: gh api graphql: GraphQL: Head ref was modified' });
});

test('queueLanding: an enqueue call with no answer that still queued the pull request is waited on', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'queued', state: 'QUEUED', position: 1 }, { kind: 'merged' }], enqueue: new Error('gh api graphql: HTTP 502') });
  const { result, lines } = await land(queue);
  assert.equal(result.kind, 'merged');
  assert.ok(lines.includes('the enqueue call failed (gh api graphql: HTTP 502), but #7 is in the merge queue: waiting on it'));
});

test('queueLanding: at the deadline the pull request stays queued, and the run says to wait on it again', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'queued', state: 'QUEUED', position: 3 }] });
  const waiter = fakeWaiter();
  const { result } = await land(queue, fakeMain(), waiter);
  assert.deepEqual(result, {
    kind: 'refused',
    pull: PULL,
    reason: '#7 is still in the merge queue after 10 min (queued at position 3); it stays queued and GitHub lands it on its own: run merge again to wait on it',
  });
  assert.equal(waiter.now(), POLLING.timeoutMs);
  assert.equal(queue.enqueued.length, 1);
});

test('queueLanding: one poll with no answer is read again; two in a row stop the wait', async () => {
  const once = await land(fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'error', message: 'HTTP 502' }, { kind: 'merged' }] }));
  assert.equal(once.result.kind, 'merged');
  assert.ok(once.lines.includes('reading the merge queue got no answer from GitHub (HTTP 502): reading it once more at the next poll'));
  const twice = await land(fakeQueue({ rounds: [{ kind: 'out' }, { kind: 'error', message: 'HTTP 502' }] }));
  assert.deepEqual(twice.result, { kind: 'refused', pull: PULL, reason: `lost sight of #7 in the merge queue (HTTP 502): it may still land, so check ${PULL.url} before shipping again` });
});

test('queueLanding: a merge main does not show, or cannot be read for, is unchecked', async () => {
  const absent = await land(fakeQueue({ rounds: [{ kind: 'merged' }] }), fakeMain({ holds: false }));
  assert.deepEqual(absent.result, { kind: 'unchecked', pull: PULL, sha: MERGED, reason: `main at ${TIP.slice(0, 7)} does not hold the queue's merge commit ${MERGED.slice(0, 7)} yet: check main` });
  const unread = await land(fakeQueue({ rounds: [{ kind: 'merged' }] }), fakeMain({ error: new Error('fetch failed') }));
  assert.deepEqual(unread.result, { kind: 'unchecked', pull: PULL, sha: MERGED, reason: `could not read main for the queue's merge commit ${MERGED.slice(0, 7)}: fetch failed` });
  const bare = await land(fakeQueue({ rounds: [{ kind: 'merged', commit: null }] }));
  assert.deepEqual(bare.result, { kind: 'unchecked', pull: PULL, sha: SHA, reason: 'GitHub shows #7 merged with no merge commit: check main' });
});

test('queueLanding: a first read with no answer refuses before any enqueue', async () => {
  const queue = fakeQueue({ rounds: [{ kind: 'error', message: 'HTTP 401' }] });
  const { result } = await land(queue);
  assert.deepEqual(result, { kind: 'refused', pull: PULL, reason: 'could not read #7 in the merge queue: HTTP 401' });
  assert.equal(queue.enqueued.length, 0);
});

test('parseQueueRead: throws on an answer with no pull request', () => {
  assert.throws(() => parseQueueRead(JSON.stringify({ data: { repository: { pullRequest: null } } })), /"pullRequest" is not an object/);
});

test('mergeGroupFailure: null when the newest group run of the pull request passed or still runs', () => {
  const runs = (conclusion: string | null) => fakeQueue({ rounds: [], runs: [{ id: 3, name: 'CI', head_branch: 'gh-readonly-queue/main/pr-7-x', conclusion, html_url: 'u' }] }).gh;
  assert.equal(mergeGroupFailure(runs('success'), REPO, 'main', 7), null);
  assert.equal(mergeGroupFailure(runs(null), REPO, 'main', 7), null);
});
