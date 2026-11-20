import type { Gh } from './github.ts';
import { booleanAt, isRecord, listAt, numberAt, recordAt, recordOf, stringAt } from './json.ts';
import type { Landing, MainBranch, MergeRequest, MergeResult, Polling, Waiter } from './merge.ts';
import type { PullRequest } from './pulls.ts';

/**
 * A pull request's landing through GitHub's merge queue (T3386), for a repo whose repos.json sets `queue`. The queue
 * tests each group on main's newest tip and lands it itself, so a head main moved past is no stop here (`behind` is
 * null) and nothing lands from this side: the checked head is enqueued, pinned to the approved sha
 * (`expectedHeadOid`, as the direct merge's `sha=`), then the pull request is polled until it merged or left the
 * queue. A pull request already queued (a merge run again after a timeout) is waited on, not enqueued twice. Each read
 * checks the pull request's head: one queued or merged at a head other than the approved sha is refused, never waited
 * on or reported merged (security C1, T4681). There is no fallback to the direct merge call: the ruleset's queue is
 * the only route onto main.
 */

/** The removal of a pull request from the queue GitHub's timeline last shows, and why. */
interface Removal {
  id: string;
  reason: string;
}

/** A pull request as the queue sees it. */
export interface QueueRead {
  /** The pull request's GraphQL node id, which the enqueue call takes. */
  id: string;
  /** The head commit the pull request is at: the one queued, or merged. */
  headRefOid: string;
  merged: boolean;
  /** The commit main got for it once merged; null before. */
  mergeCommit: string | null;
  /** Its place in the queue, or null when it is not in it. */
  entry: { state: string; position: number } | null;
  /** The newest removal from the queue on its timeline, or null when it never left one. */
  removed: Removal | null;
}

const READ_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){',
  'id headRefOid merged mergeCommit{oid} mergeQueueEntry{state position}',
  'timelineItems(last:1,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{... on RemovedFromMergeQueueEvent{id reason}}}',
  '}}}',
].join(' ');

const ENQUEUE_MUTATION =
  'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{state position}}}';

const WHAT = 'merge queue read';

/** A GraphQL answer's `data.repository.pullRequest`, read into a QueueRead. */
export function parseQueueRead(json: string): QueueRead {
  const data = recordAt(recordOf(json, WHAT), 'data', WHAT);
  const pull = recordAt(recordAt(data, 'repository', WHAT), 'pullRequest', WHAT);
  const commit = pull['mergeCommit'];
  const entry = pull['mergeQueueEntry'];
  const nodes = recordAt(pull, 'timelineItems', WHAT)['nodes'];
  const last = Array.isArray(nodes) ? nodes.filter(isRecord).at(-1) : undefined;
  return {
    id: stringAt(pull, 'id', WHAT),
    headRefOid: stringAt(pull, 'headRefOid', WHAT),
    merged: booleanAt(pull, 'merged', WHAT),
    mergeCommit: isRecord(commit) ? stringAt(commit, 'oid', 'merge commit') : null,
    entry: isRecord(entry) ? { state: stringAt(entry, 'state', 'queue entry'), position: numberAt(entry, 'position', 'queue entry') } : null,
    removed: last === undefined ? null : { id: stringAt(last, 'id', 'queue removal'), reason: stringAt(last, 'reason', 'queue removal') },
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A run conclusion that proves nothing failed, or one not reached yet. */
const unfailed = (conclusion: unknown): boolean => conclusion === null || conclusion === 'success';

/**
 * The newest merge group run of pull request `number` that did not succeed, with its failed jobs and URL, or null when
 * there is none (GitHub names a group's branch `gh-readonly-queue/<base>/pr-<number>-<sha>`).
 */
export function mergeGroupFailure(gh: Gh, repo: string, base: string, number: number): string | null {
  const prefix = `gh-readonly-queue/${base}/pr-${number}-`;
  const runs = listAt(gh(['api', `repos/${repo}/actions/runs?event=merge_group&per_page=50`]), 'workflow_runs', 'merge group runs')
    .filter(run => typeof run['head_branch'] === 'string' && run['head_branch'].startsWith(prefix))
    .sort((a, b) => numberAt(b, 'id', 'run') - numberAt(a, 'id', 'run'));
  const newest = runs[0];
  if (newest === undefined || unfailed(newest['conclusion'])) return null;
  const id = numberAt(newest, 'id', 'run');
  const failed = listAt(gh(['api', `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`]), 'jobs', 'run jobs')
    .filter(job => !unfailed(job['conclusion']) && job['conclusion'] !== 'skipped')
    .map(job => `${stringAt(job, 'name', 'job')} (${String(job['conclusion'])})`);
  const jobs = failed.length === 0 ? 'no failed job listed' : failed.join(', ');
  return `merge group run ${stringAt(newest, 'name', 'run')} ${String(newest['conclusion'])}: ${jobs}; ${stringAt(newest, 'html_url', 'run')}`;
}

/** Lands a proven pull request through the merge queue, polling it every `polling.intervalMs` up to `polling.timeoutMs`. */
export function queueLanding(gh: Gh, main: MainBranch, waiter: Waiter, polling: Polling): Landing {
  return {
    behind: () => null,
    land: async (pull, request, log) => {
      const [owner = '', name = ''] = request.repo.split('/');
      const read = (): QueueRead =>
        parseQueueRead(gh(['api', 'graphql', '-f', `query=${READ_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pull.number}`]));
      const refused = (reason: string): MergeResult => ({ kind: 'refused', pull, reason });
      // Someone else may push and enqueue a newer head while this run waits: only the approved one is waited on or merged.
      const otherHead = (now: QueueRead): MergeResult | null => {
        if (now.headRefOid === request.sha || (!now.merged && now.entry === null)) return null;
        const at = `at ${now.headRefOid.slice(0, 7)}, not the approved ${request.sha.slice(0, 7)}`;
        return refused(
          now.merged
            ? `#${pull.number} merged ${at}: nobody approved that head through this merge, so check ${pull.url} and ${request.base}`
            : `#${pull.number} is in the merge queue ${at}: take it out of the queue, or ask approval of ${now.headRefOid.slice(0, 7)} naming it and run merge again`,
        );
      };

      let first: QueueRead;
      try {
        first = read();
      } catch (error) {
        return refused(`could not read #${pull.number} in the merge queue: ${messageOf(error)}`);
      }
      const firstOther = otherHead(first);
      if (firstOther !== null) return firstOther;
      if (first.merged) return landedOn(main, pull, request, first);
      // A removal from an earlier time in the queue is not why this one left it.
      const before = first.removed?.id ?? null;
      if (first.entry === null) {
        const failure = enqueue(gh, first.id, request.sha);
        if (failure !== null) {
          // A call with no answer may still have enqueued it: the queue says.
          let again: QueueRead | null = null;
          try {
            again = read();
          } catch (error) {
            log(`reading #${pull.number} after the enqueue call failed: ${messageOf(error)}`);
          }
          if (again === null || (again.entry === null && !again.merged)) return refused(`GitHub did not enqueue #${pull.number}: ${failure}`);
          const againOther = otherHead(again);
          if (againOther !== null) return againOther;
          log(`the enqueue call failed (${failure}), but #${pull.number} is in the merge queue: waiting on it`);
        } else log(`enqueued #${pull.number} at ${request.sha.slice(0, 7)} in the merge queue`);
      } else log(`#${pull.number} is already in the merge queue (${placeOf(first.entry)}): waiting on it`);

      const deadline = waiter.now() + polling.timeoutMs;
      let shown = '';
      let readFailed = false;
      for (;;) {
        await waiter.sleep(Math.min(polling.intervalMs, Math.max(deadline - waiter.now(), 0)));
        let now: QueueRead;
        try {
          now = read();
          readFailed = false;
        } catch (error) {
          if (readFailed) return refused(`lost sight of #${pull.number} in the merge queue (${messageOf(error)}): it may still land, so check ${pull.url} before shipping again`);
          readFailed = true;
          log(`reading the merge queue got no answer from GitHub (${messageOf(error)}): reading it once more at the next poll`);
          continue;
        }
        const nowOther = otherHead(now);
        if (nowOther !== null) return nowOther;
        if (now.merged) return landedOn(main, pull, request, now);
        if (now.entry === null) return ejected(gh, pull, request, now.removed?.id === before ? null : now.removed);
        const place = placeOf(now.entry);
        if (place !== shown) log(`merge queue: #${pull.number} ${place}`);
        shown = place;
        if (waiter.now() >= deadline) {
          return refused(`#${pull.number} is still in the merge queue after ${Math.round(polling.timeoutMs / 60_000)} min (${shown}); it stays queued and GitHub lands it on its own: run merge again to wait on it`);
        }
      }
    },
  };
}

const placeOf = (entry: NonNullable<QueueRead['entry']>): string => `${entry.state.toLowerCase().replace(/_/g, ' ')} at position ${entry.position}`;

/** Enqueues pull request `id` while its head is still `sha`; null once GitHub took it, else its answer. */
function enqueue(gh: Gh, id: string, sha: string): string | null {
  try {
    gh(['api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`, '-f', `id=${id}`, '-f', `head=${sha}`]);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/** Merged, once main on origin holds the queue's merge commit; unchecked when that cannot be shown. */
function landedOn(main: MainBranch, pull: PullRequest, request: MergeRequest, read: QueueRead): MergeResult {
  if (read.mergeCommit === null) return { kind: 'unchecked', pull, sha: request.sha, reason: `GitHub shows #${pull.number} merged with no merge commit: check ${request.base}` };
  const merged = read.mergeCommit;
  try {
    const tip = main.tip();
    if (main.contains(tip, merged)) return { kind: 'merged', pull, sha: merged };
    return { kind: 'unchecked', pull, sha: merged, reason: `${request.base} at ${tip.slice(0, 7)} does not hold the queue's merge commit ${merged.slice(0, 7)} yet: check ${request.base}` };
  } catch (error) {
    return { kind: 'unchecked', pull, sha: merged, reason: `could not read ${request.base} for the queue's merge commit ${merged.slice(0, 7)}: ${messageOf(error)}` };
  }
}

/** The queue let the pull request go unmerged: why GitHub says, and the merge group run that failed. */
function ejected(gh: Gh, pull: PullRequest, request: MergeRequest, removed: Removal | null): MergeResult {
  let failure: string | null;
  try {
    failure = mergeGroupFailure(gh, request.repo, request.base, pull.number);
  } catch (error) {
    failure = `the merge group runs could not be read (${messageOf(error)})`;
  }
  const why = removed === null ? '' : ` (GitHub: ${removed.reason.toLowerCase().replace(/_/g, ' ')})`;
  return { kind: 'refused', pull, reason: `#${pull.number} left the merge queue unmerged${why}: ${failure ?? `no failed merge group run found; see ${pull.url}`}` };
}
