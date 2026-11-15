import type { KitConfig } from '../../config/types.ts';
import { CLAIM_DAYS, formatClaims, parseClaims, planClaims, type Claim, type ClaimState } from '../../issues/claim.ts';
import { targetText, type IssueHost, type IssueTarget } from '../../issues/host.ts';
import type { HostIssue } from '../../issues/issue.ts';
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

/** One claim pass: the host to write through, the issues of each repository read this run, and when the run started. */
export interface ClaimRun {
  readonly host: IssueHost;
  readonly read: ReadonlyMap<string, readonly HostIssue[]>;
  /** Taken before any read, so the next pass reads every comment posted after this run's reads began. */
  readonly started: number;
}

/** Makes and ends the claims of each repository in `run.read`; gives one line per claim made, ended or failed. */
export async function recordClaims(runtime: CliRuntime, kit: Kit, config: KitConfig, run: ClaimRun): Promise<string[]> {
  const lock = fileLockOf(runtime, kit.paths.githubSyncLock, config.lock);
  const before = await lock.run(async (): Promise<ClaimState> => parseClaims((await runtime.files.read(kit.paths.githubClaims)) ?? ''));
  const now = runtime.clock.now();
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };
  const claims: Claim[] = before.claims.filter((claim) => !run.read.has(claim.repo));
  const checked = new Map(before.checked);
  for (const [repo, issues] of run.read) {
    const plan = planClaims(
      issues,
      before.claims.filter((claim) => claim.repo === repo),
      { now, since: before.checked.get(repo) ?? run.started },
    );
    const labelsOf = (claim: Claim): readonly string[] => issues.find((issue) => issue.number === claim.number)?.labels ?? [];
    claims.push(...plan.kept);
    for (const claim of plan.made) {
      if (await makeClaim(run.host, claim, labelsOf(claim), say)) {
        claims.push(claim);
      }
    }
    for (const claim of plan.expired) {
      if (!(await endClaim(run.host, claim, labelsOf(claim), say))) {
        claims.push(claim);
      }
    }
    checked.set(repo, run.started);
  }
  await lock.run(async () => runtime.files.write(kit.paths.githubClaims, formatClaims({ claims, checked })));
  return lines;
}

function targetOf(claim: Claim): IssueTarget {
  return { repo: claim.repo, number: claim.number };
}

/** Assigns the claimer, swaps the status label when the issue shows `status:open`, and replies; true once assigned. */
async function makeClaim(host: IssueHost, claim: Claim, labels: readonly string[], say: (line: string) => void): Promise<boolean> {
  const target = targetOf(claim);
  const assigned = await host.assign(target, [claim.login]);
  if (assigned.kind === 'failed') {
    say(`FAILED ${targetText(target)}: ${claim.login}'s claim: ${assigned.reason}; no claim was made, a person may assign by hand`);
    return false;
  }
  say(`CLAIMED ${targetText(target)}: ${claim.login} took it by a comment and is assigned for ${CLAIM_DAYS} days, or until a linked pull request lands`);
  await swapStatus(host, target, labels, { from: STATUS_LABELS.open, to: STATUS_LABELS.claimed }, say);
  await reply(host, target, CLAIM_REPLY, say);
  return true;
}

/** Takes the claimer off, swaps the status label back when the issue shows `status:claimed`, and replies; true once taken off. */
async function endClaim(host: IssueHost, claim: Claim, labels: readonly string[], say: (line: string) => void): Promise<boolean> {
  const target = targetOf(claim);
  const removed = await host.unassign(target, claim.login);
  if (removed.kind === 'failed') {
    say(`FAILED ${targetText(target)}: ending ${claim.login}'s claim: ${removed.reason}; tried again on the next run`);
    return false;
  }
  say(`RELEASED ${targetText(target)}: ${claim.login}'s claim ran ${CLAIM_DAYS} days with no linked pull request; the assignee is taken off`);
  await swapStatus(host, target, labels, { from: STATUS_LABELS.claimed, to: STATUS_LABELS.open }, say);
  await reply(host, target, RELEASE_REPLY, say);
  return true;
}

/** Swaps `from` for `to` only on an issue showing `from`: one with another status, or none, is the status push's. */
async function swapStatus(host: IssueHost, target: IssueTarget, labels: readonly string[], swap: { readonly from: string; readonly to: string }, say: (line: string) => void): Promise<void> {
  if (labels.includes(swap.from)) {
    await labelIssue(host, { target, add: [swap.to], remove: [swap.from] }, say);
  }
}

async function reply(host: IssueHost, target: IssueTarget, body: string, say: (line: string) => void): Promise<void> {
  const posted = await host.comment(target, body);
  say(posted.kind === 'done' ? `REPLIED ${targetText(target)}` : `FAILED ${targetText(target)}: the reply: ${posted.reason}`);
}
