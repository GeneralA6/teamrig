import { ENV, KIT_NAME } from '../../core/home.ts';
import type { SecretScanner } from '../../core/secrets.ts';
import { issueRef } from '../../github/map.ts';
import type { AddIssueAsk } from '../../github/issue-at-add.ts';
import type { IssueDraft } from '../../issues/host.ts';
import type { AddInput } from '../../register/policy.ts';
import type { Flags } from '../args.ts';
import { hostOf } from '../issue-hosts.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { GITHUB_OFF, githubOff } from './issue-sync-auto.ts';
import { reportRotation } from './register.ts';
import type { Team } from './register-team.ts';

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

/**
 * Opens the issue of task `id`, just added, and points the task's ref at it, as `update <id> --ref` by the adder
 * would, so the sync adds no second task for it. On GitHub with the token saved for the repository's owner
 * (issue-hosts.ts). A failure leaves the task written with no issue and says how to give it one: exit 1 when GitHub
 * failed, 2 when the register refused the ref; with GitHub off on this machine it opens nothing and says so.
 */
export async function openAddedIssue(runtime: CliRuntime, team: Team, by: string, id: string, draft: IssueDraft, scanner: SecretScanner): Promise<ExitCode> {
  const say = (line: string): void => runtime.out.stdout(line);
  const later = `${id} is written with no issue; open it with ${KIT_NAME} issue migrate, or point its ref at one with ${KIT_NAME} update ${id} --ref`;
  if (githubOff(runtime.env)) {
    say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; ${later}`);
    return EXIT.ok;
  }
  const host = hostOf('github', runtime, scanner);
  const reach = await host.reach(draft.repo, 'open');
  if (reach.kind === 'unreachable') {
    say(`FAILED ${id}'s issue: ${reach.reason}; ${later}`);
    return EXIT.failed;
  }
  const end = await host.open(draft);
  if (end.kind === 'failed') {
    say(`FAILED ${id}'s issue: ${end.reason}; ${later}`);
    return EXIT.failed;
  }
  const ref = issueRef(end.target.repo, end.target.number);
  const verdict = await team.register.update(by, id, { ref }, undefined);
  if (!verdict.ok) {
    say(`REFUSED ${id}: ${verdict.error}; its issue ${ref} was opened: set it with ${KIT_NAME} update ${id} --ref ${ref}`);
    return EXIT.refused;
  }
  reportRotation(runtime, verdict.value.rotation, team.paths);
  say(`OPENED ${id} ${ref}`);
  return EXIT.ok;
}
