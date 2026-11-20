import type { KitConfig } from '../../config/types.ts';
import { CLAIM_DAYS, CLAIM_READS, claimCandidates, claimKey, formatClaims, parseClaims, planClaims, type Claim, type ClaimCandidate, type ClaimState } from '../../issues/claim.ts';
import { targetText, type Assignees, type Comments, type HostAccess, type IssueTarget, type LabelFiles, type Labels } from '../../issues/host.ts';
import type { HostIssue, ReadComment } from '../../issues/issue.ts';
import { STATUS_LABELS } from '../../issues/status-push.ts';
import { labelIssue } from '../../issues/write.ts';
import { fileLockOf } from '../file-locks.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The claim part of an automatic sync that writes to GitHub (T3021, issues/claim.ts): in each repository it read,
 * a contributor's claim comment gets them assigned, `status:open` swapped for `status:claimed`, and one fixed reply;
 * a claim this code made that ran its days with no linked pull request loses that assignee, gets `status:open` back
 * and one fixed reply. The claims and the time of each repository's pass are kept in their own file under the sync's
 * lock. A failed assign makes no claim; a failed unassign keeps the claim, to try again on the next run.
 */

/** The reply on an issue code assigned by a claim comment. */
export const CLAIM_REPLY = `Assigned to you. A claim holds for ${CLAIM_DAYS} days: if no pull request is linked to this issue by then, the assignment is taken off so someone else can take it. The repository's contributing guide says how to open a pull request.`;

/** The reply on an issue whose claim ran out. */
export const RELEASE_REPLY = `This claim ran ${CLAIM_DAYS} days with no linked pull request, so the assignment was taken off and the issue is free to take again. A new /take comment claims it again.`;

/**
 * What a claim is written through: the tracker's comments, assignees and labels, and the code host's read of a
 * repository's label file, which the status swap needs when the repository lacks the label it adds.
 */
export interface ClaimVia {
  readonly host: HostAccess & Comments & Assignees & Labels;
  readonly labelFiles: LabelFiles;
}

/** One claim pass: what to write through, the issues of each repository read this run, and when the run started. */
export interface ClaimRun extends ClaimVia {
  readonly read: ReadonlyMap<string, readonly HostIssue[]>;
  /** Taken before any read, so the next pass reads every comment posted after this run's reads began. */
  readonly started: number;
  /** The writes this run may send in all; the claims spend from it first and the status push gets what is left. */
  readonly writes: number;
}

/** What a claim pass did: one line per claim made, ended, held or failed, and the writes it counted against the run. */
export interface ClaimOutcome {
  readonly lines: readonly string[];
  readonly writes: number;
}

/**
 * The writes making or ending one claim may send: the assign or unassign, the status swap (the new label made when
 * the repository lacks it, then added, the old one taken off) and the reply. Counted before the claim starts, so a
 * claim never stops halfway for the run's budget.
 */
export function claimWrites(swaps: boolean): number {
  return 2 + (swaps ? 3 : 0);
}

/**
 * The writes a run's claims may spend: the run's budget, raised to one whole claim. At the default watch (a probe a
 * minute) a run's share of the hour is 4 writes, fewer than a claim with its status swap sends, so with the budget
 * alone every claim would be held on every run. The raise only goes to a run that makes or ends a claim, and a
 * repository makes at most CLAIMS_PER_DAY claims a day, so the hour's writes stay far under GitHub's limit. A run
 * with no budget, as when no automatic push runs, makes none.
 */
export function claimBudget(writesPerRun: number): number {
  return writesPerRun <= 0 ? 0 : Math.max(writesPerRun, claimWrites(true));
}

/**
 * Makes and ends the claims of each repository in `run.read`, within `run.writes`. A claim the budget leaves out is
 * held for the next run: an expired one stays in the file, and a repository with a held new claim keeps its old pass
 * time, so the next run reads that comment again (an issue assigned meanwhile is no longer claimable). The list holds
 * no comment text, so a run reads the new comments of at most CLAIM_READS issues, oldest new comment first; one left
 * unread, or whose read failed, keeps the pass time at its oldest new comment, so the next run reads it.
 */
export async function recordClaims(runtime: CliRuntime, kit: Kit, config: KitConfig, run: ClaimRun): Promise<ClaimOutcome> {
  const lock = fileLockOf(runtime, kit.paths.githubSyncLock, config.lock);
  const before = await lock.run(async (): Promise<ClaimState> => parseClaims((await runtime.files.read(kit.paths.githubClaims)) ?? ''));
  const now = runtime.clock.now();
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };
  let left = run.writes;
  const spend = (claim: Claim, labels: readonly string[], swapFrom: string): boolean => {
    const cost = claimWrites(labels.includes(swapFrom));
    if (cost > left) {
      say(`HELD ${targetText(targetOf(claim))}: ${claim.login}'s claim waits for the next run, as this run's ${run.writes} write(s) are spent`);
      return false;
    }
    left -= cost;
    return true;
  };
  const claims: Claim[] = before.claims.filter((claim) => !run.read.has(claim.repo));
  const checked = new Map(before.checked);
  for (const [repo, issues] of run.read) {
    const since = before.checked.get(repo) ?? run.started;
    const pass = { now, since, acceptLabel: config.github.acceptLabel };
    const own = before.claims.filter((claim) => claim.repo === repo);
    const read = await readCandidates(run.host, claimCandidates(issues, own, pass), since, say);
    const plan = planClaims(issues, own, pass, read.comments);
    const labelsOf = (claim: Claim): readonly string[] => issues.find((issue) => issue.number === claim.number)?.labels ?? [];
    claims.push(...plan.kept);
    let held = false;
    for (const claim of plan.made) {
      if (!spend(claim, labelsOf(claim), run.host.labelName(STATUS_LABELS.open))) {
        held = true;
      } else if (await makeClaim(run, claim, labelsOf(claim), say)) {
        claims.push(claim);
      }
    }
    for (const claim of plan.expired) {
      if (!spend(claim, labelsOf(claim), run.host.labelName(STATUS_LABELS.claimed)) || !(await endClaim(run, claim, labelsOf(claim), say))) {
        claims.push(claim);
      }
    }
    // Up to the oldest comment left unread, so the next pass reads it again; past the read ones, which it skips.
    checked.set(repo, held ? since : Math.min(run.started, ...read.later));
  }
  await lock.run(async () => runtime.files.write(kit.paths.githubClaims, formatClaims({ claims, checked })));
  return { lines, writes: run.writes - left };
}

/** The comments a pass read, by claimKey, and the oldest new comment time of each candidate it left for the next pass. */
interface CandidateRead {
  readonly comments: ReadonlyMap<string, readonly ReadComment[]>;
  readonly later: readonly number[];
}

/**
 * Reads the new comments of the first CLAIM_READS candidates, oldest new comment first. A failed read, and each
 * candidate past the bound, is left for the next pass, which starts from its oldest new comment.
 */
async function readCandidates(host: Comments, candidates: readonly ClaimCandidate[], since: number, say: (line: string) => void): Promise<CandidateRead> {
  const comments = new Map<string, readonly ReadComment[]>();
  const later: number[] = [];
  for (const candidate of candidates.slice(0, CLAIM_READS)) {
    const target = { repo: candidate.issue.repo, number: candidate.issue.number };
    const read = await host.newComments(target, since);
    if (read.kind === 'failed') {
      say(`FAILED ${targetText(target)}: reading its new comments for a claim: ${read.reason}; read again on the next run`);
      later.push(candidate.from);
    } else {
      comments.set(claimKey(target.repo, target.number), read.comments);
    }
  }
  const over = candidates.slice(CLAIM_READS);
  const first = over[0];
  if (first !== undefined) {
    say(`HELD ${first.issue.repo}: ${over.length} issue(s) with new comments wait for the next run, as a run reads at most ${CLAIM_READS} for claims`);
    later.push(...over.map((candidate) => candidate.from));
  }
  return { comments, later };
}

function targetOf(claim: Claim): IssueTarget {
  return { repo: claim.repo, number: claim.number };
}

/** Assigns the claimer, swaps the status label when the issue shows `status:open`, and replies; true once assigned. */
async function makeClaim(via: ClaimVia, claim: Claim, labels: readonly string[], say: (line: string) => void): Promise<boolean> {
  const target = targetOf(claim);
  const assigned = await via.host.assign(target, [claim.login]);
  if (assigned.kind === 'failed') {
    say(`FAILED ${targetText(target)}: ${claim.login}'s claim: ${assigned.reason}; no claim was made, a person may assign by hand`);
    return false;
  }
  say(`CLAIMED ${targetText(target)}: ${claim.login} took it by a comment and is assigned for ${CLAIM_DAYS} days, or until a linked pull request lands`);
  await swapStatus(via, target, labels, { from: STATUS_LABELS.open, to: STATUS_LABELS.claimed }, say);
  await reply(via.host, target, CLAIM_REPLY, say);
  return true;
}

/** Takes the claimer off, swaps the status label back when the issue shows `status:claimed`, and replies; true once taken off. */
async function endClaim(via: ClaimVia, claim: Claim, labels: readonly string[], say: (line: string) => void): Promise<boolean> {
  const target = targetOf(claim);
  const removed = await via.host.unassign(target, claim.login);
  if (removed.kind === 'failed') {
    say(`FAILED ${targetText(target)}: ending ${claim.login}'s claim: ${removed.reason}; tried again on the next run`);
    return false;
  }
  say(`RELEASED ${targetText(target)}: ${claim.login}'s claim ran ${CLAIM_DAYS} days with no linked pull request; the assignee is taken off`);
  await swapStatus(via, target, labels, { from: STATUS_LABELS.claimed, to: STATUS_LABELS.open }, say);
  await reply(via.host, target, RELEASE_REPLY, say);
  return true;
}

/**
 * Swaps `from` for `to` only on an issue showing `from`: one with another status, or none, is the status push's. The
 * issue's labels are as the tracker holds them, so `from` is looked for under the name it has there (labelIssue names
 * the two it writes itself).
 */
async function swapStatus(via: ClaimVia, target: IssueTarget, labels: readonly string[], swap: { readonly from: string; readonly to: string }, say: (line: string) => void): Promise<void> {
  if (labels.includes(via.host.labelName(swap.from))) {
    await labelIssue(via.host, via.labelFiles, { target, add: [swap.to], remove: [swap.from] }, say);
  }
}

async function reply(host: Comments, target: IssueTarget, body: string, say: (line: string) => void): Promise<void> {
  const posted = await host.comment(target, body);
  say(posted.kind === 'done' ? `REPLIED ${targetText(target)}` : `FAILED ${targetText(target)}: the reply: ${posted.reason}`);
}
