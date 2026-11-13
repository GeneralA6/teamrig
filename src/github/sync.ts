import { formatUtcDay } from '../core/time.ts';
import type { ImportChanges, ImportInput, StatusInput, Verdict } from '../register/policy.ts';
import type { WriteResult } from '../register/register.ts';
import type { GhRunner } from './gh.ts';
import type { HostIssue, IssueState } from '../issues/issue.ts';
import { ISSUE_LIMIT, listIssues, type IssueList } from './issues.ts';
import { latestIssues, type SyncStep } from './plan.ts';
import type { RepoAccess } from './tokens.ts';

const DAY_MS = 86_400_000;

/** A repository as one sync read it: its issues and what to say about the reads, or why it could not be read. */
export type RepoRead =
  | { readonly kind: 'read'; readonly repo: string; readonly issues: readonly HostIssue[]; readonly notes: readonly string[] }
  | { readonly kind: 'failed'; readonly repo: string; readonly reason: string };

/** The register's import writes (register.ts), the only writes a sync makes. */
export interface ImportWriter {
  importAdd(input: ImportInput): Promise<Verdict<WriteResult>>;
  importUpdate(id: string, changes: ImportChanges, note: string): Promise<Verdict<WriteResult>>;
  importStatus(id: string, input: StatusInput): Promise<Verdict<WriteResult>>;
}

/** A step as written: the task it wrote, or why the register refused it. */
export interface StepOutcome {
  readonly step: SyncStep;
  readonly result: Verdict<string>;
}

/** The first day whose closed issues a sync reads: `closedDays` before now, UTC. */
export function closedSince(now: Date, closedDays: number): string {
  return formatUtcDay(new Date(now.getTime() - closedDays * DAY_MS));
}

/**
 * Reads a repository's open issues, then those closed on or after `since`: pages of the two shipped issue queries
 * and nothing else. When either fails the repository is left out whole, so its tasks are not judged on half a read.
 */
export async function readRepo(gh: GhRunner, access: RepoAccess, repo: string, since: string): Promise<RepoRead> {
  const open = await listIssues(gh, access, { repo, state: 'open', limit: ISSUE_LIMIT });
  if (open.kind === 'failed') {
    return { kind: 'failed', repo, reason: open.reason };
  }
  const closed = await listIssues(gh, access, { repo, state: 'closed', closedSince: since, limit: ISSUE_LIMIT });
  if (closed.kind === 'failed') {
    return { kind: 'failed', repo, reason: closed.reason };
  }
  return { kind: 'read', repo, issues: latestIssues(open.issues, closed.issues), notes: [...listNotes('open', open), ...listNotes('closed', closed)] };
}

/** What a reader of the sync should know about one list: it may be cut short, or gh printed items it could not read. */
function listNotes(state: IssueState, list: Extract<IssueList, { kind: 'listed' }>): string[] {
  return [
    ...(list.full ? [`the ${state} list reached ${ISSUE_LIMIT} issues, so it may leave some out`] : []),
    ...(list.unreadable > 0 ? [`${list.unreadable} ${state} item(s) gh printed did not read as issues and were left out`] : []),
  ];
}

/** Writes the steps in order, each judged again under the register's lock; a refused step is reported and the rest still run. */
export async function applySteps(writer: ImportWriter, steps: readonly SyncStep[]): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const verdict = await writeStep(writer, step);
    outcomes.push({ step, result: verdict.ok ? { ok: true, value: verdict.value.task.id } : verdict });
  }
  return outcomes;
}

function writeStep(writer: ImportWriter, step: SyncStep): Promise<Verdict<WriteResult>> {
  switch (step.kind) {
    case 'add':
      return writer.importAdd(step.input);
    case 'update':
      return writer.importUpdate(step.id, step.changes, step.note);
    case 'status':
      return writer.importStatus(step.id, step.input);
  }
}
