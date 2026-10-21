import type { LeadTree } from '../config/lead-tree.ts';
import type { CoordinatorRepoConfig, ReviewPath, RolesConfig } from '../config/types.ts';
import type { Clock } from '../core/lock.ts';
import type { TimeZone } from '../core/zone.ts';
import { fallbackOpen, holdApproved, holdClassOf, needsCheck, REVIEW_FALLBACK_MS, reviewRoute, type CheckOutcome } from '../push-guard/review-gate.ts';
import { GENERIC_REVIEW_PATHS, reviewHits, type ReviewHit } from '../push-guard/review-paths.ts';
import type { Task } from '../register/fold.ts';
import type { MergeGit } from './git.ts';
import { holdBinds, holdId, type HeldChange, type HoldHit, type ReviewHold, type ReviewHolds } from './review-holds.ts';

/**
 * The review gate's step in `teamrig merge` (T800 §2.2, T828). With `coordinator.repos.<name>.reviewGate` on, it runs
 * under the host lock after the rebase. It holds a change whose paths hit a review entry (the generic ones, then
 * `pushGuard.reviewPaths`) until its reviewer approves the branch's task; a `check` hit runs the repo's review check
 * first, and a clean check lets it go. A hold binds `base..head` and the tree they make: the same change lands once
 * its reviewer approved it after the hold was made (or its fallback leader did, from 30 minutes on); any other
 * change of the branch gets a new hold.
 */

export interface ReviewGateSetup {
  /** `pushGuard.reviewPaths`, on top of the generic entries. */
  readonly reviewPaths: readonly ReviewPath[];
  readonly tree: Pick<LeadTree, 'approversOf'>;
  readonly roles: Pick<RolesConfig, 'securityReviewer'>;
}

/** A task as the gate reads it: whose it is, and the latest answer to its approval wait. */
export type GateTask = Pick<Task, 'owner' | 'answer'>;

export interface ReviewGatePorts {
  readonly git: Pick<MergeGit, 'changedPaths' | 'treeOf'>;
  readonly holds: Pick<ReviewHolds, 'read' | 'write'>;
  readonly clock: Clock;
  /** The register's task by id; undefined when it has none. */
  taskOf(id: string): Promise<GateTask | undefined>;
  /** Runs the repo's review check on `base..HEAD`, under the host lock. */
  runCheck(argv: readonly string[], base: string): Promise<CheckOutcome>;
  say(text: string): void;
}

/** The change the gate looks at: the session's rebased branch, `base..head` in the checkout `top`. */
export interface GatedChange {
  readonly session: string;
  readonly repo: string;
  readonly config: Pick<CoordinatorRepoConfig, 'reviewGate' | 'reviewCheck'>;
  readonly top: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
}

/** A branch names its task as `t<n>-…`, after any folder part. */
const TASK_BRANCH = /\bt([1-9]\d*)-/;
/** A refusal names this many paths it held, then a count of the rest. */
const HITS_SHOWN = 5;

/** The task a branch is named after (`t828-gate` is T828); undefined when it names none. */
export function taskOfBranch(branch: string): string | undefined {
  const number = TASK_BRANCH.exec(branch)?.[1];
  return number === undefined ? undefined : `T${number}`;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

function hitsText(hits: readonly HoldHit[]): string {
  const shown = hits.slice(0, HITS_SHOWN).map(({ path, glob }) => (path === glob ? path : `${path} (${glob})`));
  const left = hits.length - shown.length;
  return [...shown, ...(left > 0 ? [`${left} more`] : [])].join(', ');
}

/** Why a new hold was made: what the paths hit, and what the check said about them. */
function causeOf(hits: readonly HoldHit[], check: CheckOutcome | undefined, unchecked: boolean): string {
  const changes = `it changes ${hitsText(hits)}`;
  if (check?.kind === 'flagged') {
    return `${changes}, and the review check flagged it (its findings are above)`;
  }
  if (check?.kind === 'broken') {
    return `${changes}, and the review check ${check.detail}, which is no pass`;
  }
  return unchecked ? `${changes}, and no reviewCheck is set to clear its check paths` : changes;
}

/** The refusal of a held change: what holds it, who answers it, and the command that asks them. */
function holdRefusal(hold: ReviewHold, zone: TimeZone, now: number, cause: string): string {
  const createdAt = Date.parse(hold.createdAt);
  const { who, fallback } = hold.reviewer;
  const asked = fallback !== undefined && fallbackOpen(hold.reviewer, createdAt, now) ? fallback : who;
  const range = `${short(hold.base)}..${short(hold.head)}`;
  const answers =
    fallback === undefined
      ? `${who} answers it`
      : `${who} answers it, and ${fallback} too from ${zone.minute(new Date(createdAt + REVIEW_FALLBACK_MS))}`;
  const note = `review hold ${hold.id} of ${hold.branch} ${range}`;
  return (
    `review hold ${hold.id} keeps ${hold.branch} (${range}) off the default branch: ${cause}. ${answers}: ` +
    `teamrig set ${hold.task} --status waiting --waits approval:${asked} --note "${note}" --session ${hold.session}; ` +
    'merge again once it is approved'
  );
}

/** Whether the change's existing hold is answered: undefined lets it land; else why it is still held. */
async function answeredRefusal(zone: TimeZone, ports: ReviewGatePorts, hold: ReviewHold): Promise<string | undefined> {
  const createdAt = Date.parse(hold.createdAt);
  const answer = (await ports.taskOf(hold.task))?.answer ?? undefined;
  if (answer !== undefined && holdApproved(hold.reviewer, createdAt, answer)) {
    ports.say(`review hold ${hold.id} of ${hold.branch}: ${answer.by} approved it`);
    return undefined;
  }
  const now = ports.clock.now();
  if (answer?.verdict === 'declined' && Date.parse(answer.at) > createdAt) {
    const note = answer.note === null ? '' : ` (${answer.note.replace(/\s+/g, ' ')})`;
    return `review hold ${hold.id}: ${answer.by} declined ${hold.task}${note}; change ${hold.branch}, then merge again for a new hold`;
  }
  return holdRefusal(hold, zone, now, `it changes ${hitsText(hold.hits)}`);
}

/** Holds a change no hold binds yet, or lets it go when its check paths came out clean. */
async function newHoldRefusal(setup: ReviewGateSetup, zone: TimeZone, ports: ReviewGatePorts, change: GatedChange, held: HeldChange, hits: readonly ReviewHit[]): Promise<string | undefined> {
  const { session, repo, branch, base } = change;
  const holdHits = hits.map(({ path, entry }) => ({ path, glob: entry.glob }));
  const task = taskOfBranch(branch);
  if (task === undefined) {
    return `${branch} changes ${hitsText(holdHits)}, which the review gate holds for a review of its task, but the branch names none: name it t<n>-… after your task`;
  }
  const owner = (await ports.taskOf(task))?.owner;
  if (owner !== session) {
    const whose = owner === undefined ? 'is not in the register' : `is ${owner}'s`;
    return `${branch} changes review paths, so its reviewer approves its task ${task}, which ${whose}: merge a branch named after a task of ${session}`;
  }
  const checks = needsCheck(hits);
  const argv = checks ? change.config.reviewCheck : undefined;
  let check: CheckOutcome | undefined;
  if (argv !== undefined) {
    ports.say(`review check of ${branch}: ${argv.join(' ')}`);
    check = await ports.runCheck(argv, base);
  }
  const holdClass = holdClassOf(hits, check);
  if (holdClass === undefined) {
    ports.say(`review check of ${branch}: clean`);
    return undefined;
  }
  const route = reviewRoute(holdClass, session, setup.tree, setup.roles);
  if (route.kind === 'none') {
    return `${branch} changes ${hitsText(holdHits)}, which the review gate holds, but ${route.reason}`;
  }
  const now = ports.clock.now();
  const hold: ReviewHold = {
    ...held,
    id: holdId(held),
    task,
    session,
    holdClass,
    reviewer: { who: route.who, fallback: route.fallback },
    hits: holdHits,
    findings: check?.kind === 'flagged' ? check.findings : undefined,
    createdAt: new Date(now).toISOString(),
  };
  await ports.holds.write(hold);
  ports.say(`review hold ${hold.id} of ${repo} ${branch}: waits on ${route.who} (${holdClass})`);
  return holdRefusal(hold, zone, now, causeOf(holdHits, check, checks && argv === undefined));
}

/**
 * The gate on one change (see the module comment): undefined lets the push go; else why it stays off the default
 * branch, with the command that asks its reviewer.
 */
export async function reviewGateRefusal(setup: ReviewGateSetup, zone: TimeZone, ports: ReviewGatePorts, change: GatedChange): Promise<string | undefined> {
  const { top, repo, branch, base, head } = change;
  if (!change.config.reviewGate) {
    return undefined;
  }
  const paths = ports.git.changedPaths(top, base, head);
  if (paths === undefined) {
    return `could not read what ${branch} changes against ${short(base)}, so the review gate cannot clear it`;
  }
  const hits = reviewHits(paths, [...GENERIC_REVIEW_PATHS, ...setup.reviewPaths]);
  if (hits.length === 0) {
    return undefined;
  }
  const tree = ports.git.treeOf(top, head);
  if (tree === undefined) {
    return `could not read the tree ${short(head)} makes, so the review gate cannot bind a hold to it`;
  }
  const held: HeldChange = { repo, branch, base, head, tree };
  const hold = await ports.holds.read(repo, branch);
  if (hold !== undefined && holdBinds(hold, held)) {
    return answeredRefusal(zone, ports, hold);
  }
  return newHoldRefusal(setup, zone, ports, change, held, hits);
}
