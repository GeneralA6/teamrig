import type { LeadTree } from '../config/lead-tree.ts';
import type { RolesConfig } from '../config/types.ts';
import type { Clock } from '../core/lock.ts';
import { renamedPath, type CommitStat } from '../push-guard/commit-size.ts';
import type { PassRecord } from '../push-guard/pass-record.ts';
import { holdApproved, reviewRoute } from '../push-guard/review-gate.ts';
import type { Task } from '../register/fold.ts';
import { gateHoldId, type GateHold, type GateHolds } from './gate-holds.ts';
import { holdBinds, type HeldChange } from './review-holds.ts';
import { taskOfBranch } from './review-gate-step.ts';
import { missesText, selfMergeMisses, type GateMiss, type SelfMergeGate, type SelfMergeRule } from './self-merge.ts';

/**
 * The self-merge step of `teamrig merge` under `pushGuard.pushToProtected: gated` (T800 §2.1, T858), run under the
 * host lock after the rebase and the review gate. A change that holds every gate merges with no click; a change that
 * misses one is held for the session's nearest leader, bound to `base..head` and its tree, and merges once that leader
 * approved the branch's task after the hold was made, as long as it misses no gate the hold did not name. The task gate
 * is never held: an approval waits on the session's own live task, so a branch must name one first.
 */

export interface GatedSetup {
  readonly tree: Pick<LeadTree, 'approversOf'>;
  readonly roles: Pick<RolesConfig, 'securityReviewer'>;
  readonly commits: SelfMergeRule;
}

/** A task as the step reads it: whose it is, how far it is, and the latest answer to its approval wait. */
export type GatedTask = Pick<Task, 'owner' | 'status' | 'answer'>;

/** What the step reads, bound to the checkout it merges from. */
export interface GatedPorts {
  readonly holds: Pick<GateHolds, 'read' | 'write'>;
  readonly clock: Clock;
  /** The register's task by id; undefined when it has none. */
  taskOf(id: string): Promise<GatedTask | undefined>;
  /** The tree a commit makes; undefined when git cannot read it. */
  treeOf(head: string): string | undefined;
  /** The commits `base..head` with their files; undefined when git cannot read them. */
  commitsOf(base: string, head: string): readonly CommitStat[] | undefined;
  /** The pass record of a tree; undefined when none proves it. */
  passOf(tree: string): Promise<PassRecord | undefined>;
  say(text: string): void;
}

/** The rebased change: `base..head` of the session's branch. */
export interface GatedChange {
  readonly session: string;
  readonly repo: string;
  /** Whether the review gate looked at it (`delivery.repos.<name>.reviewGate`). */
  readonly reviewGate: boolean;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
}

/** What the merges log keeps of a change the step lets merge. */
export interface LandedFacts {
  readonly task: string | undefined;
  readonly tree: string;
  readonly files: number;
  readonly lines: number;
  readonly checks: readonly string[];
}

export type GatedVerdict =
  | { readonly kind: 'self'; readonly facts: LandedFacts }
  | { readonly kind: 'approved'; readonly facts: LandedFacts; readonly missed: readonly SelfMergeGate[]; readonly approvedBy: string }
  | { readonly kind: 'held'; readonly reason: string };

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** The files the commits changed, judged where a rename ends, and their changed lines summed over the commits. */
function sizeOf(commits: readonly CommitStat[]): Pick<LandedFacts, 'files' | 'lines'> {
  const changes = commits.flatMap((commit) => commit.files);
  const files = new Set(changes.map((change) => renamedPath(change.path))).size;
  const lines = changes.reduce((sum, change) => sum + (change.added ?? 0) + (change.deleted ?? 0), 0);
  return { files, lines };
}

/** The refusal of a held change: what it missed, who answers it, and the command that asks them. */
function holdRefusal(hold: GateHold): string {
  const range = `${short(hold.base)}..${short(hold.head)}`;
  const note = `gate hold ${hold.id} of ${hold.branch} ${range}`;
  return (
    `gate hold ${hold.id} keeps ${hold.branch} (${range}) off the default branch: ${missesText(hold.misses)}. ${hold.reviewer} answers it: ` +
    `teamrig set ${hold.task} --status waiting --waits approval:${hold.reviewer} --note "${note}" --session ${hold.session}; ` +
    'merge again once it is approved'
  );
}

/** Whether every gate the change misses now was named by the hold its approval answers. */
function coveredBy(hold: GateHold, misses: readonly GateMiss[]): boolean {
  return misses.every((miss) => hold.misses.some((named) => named.gate === miss.gate));
}

/** A change that misses gates: its approved hold lets it merge, else it is held, by its existing hold or a new one. */
async function heldVerdict(setup: GatedSetup, ports: GatedPorts, change: GatedChange, held: HeldChange, task: string, misses: readonly GateMiss[], facts: LandedFacts): Promise<GatedVerdict> {
  const { session, repo, branch } = change;
  const hold = await ports.holds.read(repo, branch);
  if (hold !== undefined && holdBinds(hold, held) && coveredBy(hold, misses)) {
    const createdAt = Date.parse(hold.createdAt);
    const answer = (await ports.taskOf(task))?.answer ?? undefined;
    if (answer !== undefined && holdApproved({ who: hold.reviewer, fallback: undefined }, createdAt, answer)) {
      ports.say(`gate hold ${hold.id} of ${branch}: ${answer.by} approved it`);
      return { kind: 'approved', facts, missed: misses.map((miss) => miss.gate), approvedBy: answer.by };
    }
    if (answer?.verdict === 'declined' && Date.parse(answer.at) > createdAt) {
      const note = answer.note === null ? '' : ` (${answer.note.replace(/\s+/g, ' ')})`;
      return { kind: 'held', reason: `gate hold ${hold.id}: ${answer.by} declined ${task}${note}; change ${branch}, then merge again for a new hold` };
    }
    return { kind: 'held', reason: holdRefusal(hold) };
  }
  const route = reviewRoute('leader', session, setup.tree, setup.roles);
  if (route.kind === 'none') {
    return { kind: 'held', reason: `${branch} misses the self-merge gates (${missesText(misses)}), but ${route.reason}` };
  }
  const made: GateHold = { ...held, id: gateHoldId(held), task, session, reviewer: route.who, misses, createdAt: new Date(ports.clock.now()).toISOString() };
  await ports.holds.write(made);
  ports.say(`gate hold ${made.id} of ${repo} ${branch}: waits on ${route.who}`);
  return { kind: 'held', reason: holdRefusal(made) };
}

/** The step on one change (see the module comment): merge it with no click, merge it as approved, or why it is held. */
export async function gatedVerdict(setup: GatedSetup, ports: GatedPorts, change: GatedChange): Promise<GatedVerdict> {
  const { session, repo, branch, base, head } = change;
  const tree = ports.treeOf(head);
  if (tree === undefined) {
    return { kind: 'held', reason: `could not read the tree ${short(head)} makes, so the self-merge gates cannot read its pass record` };
  }
  const commits = ports.commitsOf(base, head);
  if (commits === undefined) {
    return { kind: 'held', reason: `could not read the commits of ${branch} against ${short(base)}, so the self-merge gates cannot weigh them` };
  }
  const taskId = taskOfBranch(branch);
  const task = taskId === undefined ? undefined : await ports.taskOf(taskId);
  const pass = await ports.passOf(tree);
  const misses = selfMergeMisses({ session, repo, reviewGate: change.reviewGate, branch, taskId, task, tree, pass, commits }, setup.commits);
  const facts: LandedFacts = { task: taskId, tree, ...sizeOf(commits), checks: pass?.checks ?? [] };
  if (misses.length === 0) {
    ports.say(`self-merge gates of ${branch}: every gate holds, so it merges with no approval`);
    return { kind: 'self', facts };
  }
  if (taskId === undefined || misses.some((miss) => miss.gate === 'task')) {
    return { kind: 'held', reason: `${missesText(misses)}. A missed gate waits on the approval of the branch's task, so ${branch} must name a live task of ${session}'s first` };
  }
  return heldVerdict(setup, ports, change, { repo, branch, base, head, tree }, taskId, misses, facts);
}
