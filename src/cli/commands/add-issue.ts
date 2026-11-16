import { ENV } from '../../core/home.ts';
import type { SecretScanner } from '../../core/secrets.ts';
import { issueRef } from '../../github/map.ts';
import type { AddIssueAsk } from '../../github/issue-at-add.ts';
import type { IssueDraft, IssueHost } from '../../issues/host.ts';
import type { TaskFields } from '../../register/events.ts';
import type { AddInput, Verdict } from '../../register/policy.ts';
import type { WriteResult } from '../../register/register.ts';
import type { Flags } from '../args.ts';
import { hostOf } from '../issue-hosts.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { GITHUB_OFF, githubOff } from './issue-sync-auto.ts';

/** The flags of `add` that ask about the new task's issue (github/issue-at-add.ts). */
export const ADD_ISSUE_FLAGS = ['issue', 'issue-body', 'issue-repo', 'local'] as const;

/** What an add asked about its issue: its issue flags, with the task's own ref, type and priority. */
export function addIssueAskOf(flags: Flags, input: AddInput): AddIssueAsk {
  return {
    title: flags.get('issue'),
    body: flags.get('issue-body'),
    repo: flags.get('issue-repo'),
    local: flags.get('local'),
    ref: input.ref,
    type: input.type,
    priority: input.priority,
  };
}

/** The register's two steps an add with its issue takes: judged before the issue opens, written after. */
export interface IssueAddRegister {
  judgeAdd(caller: string, input: AddInput): Promise<Verdict<TaskFields>>;
  add(caller: string, input: AddInput): Promise<Verdict<WriteResult>>;
}

/** How an add with its issue ended: stopped with nothing written, or the register's answer to the task with its ref. */
export type IssueAddEnd = { readonly kind: 'stopped'; readonly code: ExitCode } | { readonly kind: 'written'; readonly verdict: Verdict<WriteResult>; readonly ref: string };

/** The host a new task's issue opens on: GitHub, with the token saved for the repository's owner, or none while GitHub is off here. */
export function addIssueHost(runtime: CliRuntime, scanner: SecretScanner): IssueHost | undefined {
  return githubOff(runtime.env) ? undefined : hostOf('github', runtime, scanner);
}

/**
 * Adds a task with its issue, all or nothing: the add is judged, the issue opened, then the task written with its ref
 * pointing at it, so the sync adds no second task for it. A refused add, GitHub off here or a GitHub failure writes
 * nothing and opens nothing. A write the register refuses after the issue opened (a task written between the two)
 * closes the issue as not planned, or says to close it by hand when that fails; the caller reports the refusal.
 */
export async function addWithIssue(
  say: (line: string) => void,
  register: IssueAddRegister,
  host: IssueHost | undefined,
  by: string,
  input: AddInput,
  draft: IssueDraft,
): Promise<IssueAddEnd> {
  const judged = await register.judgeAdd(by, input);
  if (!judged.ok) {
    throw new RefusedError(judged.error);
  }
  if (host === undefined) {
    throw new RefusedError(`${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine, so the new task's issue cannot open and nothing is written: turn GitHub on, or add the task with --local <reason>`);
  }
  const reach = await host.reach(draft.repo, 'open');
  const opened = reach.kind === 'unreachable' ? { kind: 'failed' as const, reason: reach.reason } : await host.open(draft);
  if (opened.kind === 'failed') {
    say(`FAILED the new task's issue: ${opened.reason}; nothing is written`);
    return { kind: 'stopped', code: EXIT.failed };
  }
  const ref = issueRef(opened.target.repo, opened.target.number);
  const verdict = await register.add(by, { ...input, ref });
  if (!verdict.ok) {
    const closed = await host.close(opened.target, 'not-planned');
    say(closed.kind === 'done' ? `CLOSED ${ref} as not planned: the task it opened for was refused` : `FAILED to close ${ref}: ${closed.reason}; close it by hand, the task it opened for was refused`);
  }
  return { kind: 'written', verdict, ref };
}
