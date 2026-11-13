import { ENV, KIT_NAME } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { readAdminRole } from '../../github/admin-store.ts';
import { GitHubIssueHost } from '../../github/host.ts';
import { issueRef } from '../../github/map.ts';
import { RepoTokens } from '../../github/tokens.ts';
import { hostKindOf, parseIssueTarget, type HostKind, type IssueHost, type IssueTarget } from '../../issues/host.ts';
import { adminText, writeRight, type AdminView } from '../../issues/ownership.ts';
import { postRefusal, writeIssue, type IssueWrite } from '../../issues/write.ts';
import { RegisterPolicy } from '../../register/policy.ts';
import { onePositional, requiredFlag, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { adminStoreOf } from './gh-admin.ts';
import { GITHUB_OFF, githubOff } from './gh-auto.ts';
import { openTeam, type Team } from './register-team.ts';

/**
 * `issue comment <owner/name#n> --body <text>` (T2660): posts one comment on an issue or pull request of the team's
 * repositories, through the host whose config list names the repository (issues/host.ts; GitHub, github.repos, is
 * the only one so far). The caller must be on the team and may write only on its own issue or pull request unless it
 * is the team's GitHub admin (T2705, issues/ownership.ts); the body may not be empty, carry a secret shape or name a
 * task id. Exit 1 when the host failed or could not say whose the target is, else 0.
 */
export async function issueComment(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  return writeOn(args, runtime, { target, comment: requiredFlag(args.flags, 'body'), close: false }, '--body');
}

/**
 * `issue close <owner/name#n> [--comment <text>]` (T2660): closes one issue or pull request of the team's
 * repositories, first posting `--comment` when given, through the same host and checks as `issue comment`. A
 * failed comment closes nothing. Exit 1 when the host failed, else 0.
 */
export async function issueClose(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const comment = args.flags.get('comment');
  return writeOn(args, runtime, comment === undefined ? { target, close: true } : { target, comment, close: true }, '--comment');
}

/** The issue or pull request the one positional names; refused when it names none. */
function targetOf(args: ParsedArgs): IssueTarget {
  const text = onePositional(args, 'issue');
  const target = parseIssueTarget(text);
  if (target === undefined) {
    throw new RefusedError(`${text} names no issue or pull request: give it as owner/name#number, such as acme/web#7`);
  }
  return target;
}

/**
 * The session the write is made as. A `--session` other than the tab's own `$TEAMRIG_SESSION` is refused: the
 * rights differ by session (T2705), so a session may not borrow another's by naming it.
 */
function writerOf(args: ParsedArgs, runtime: CliRuntime, team: Team): string {
  const caller = sessionIdOf(team.roster, callerOf(args.flags, runtime.env));
  const tab = runtime.env[ENV.session]?.trim();
  if (tab !== undefined && tab !== '' && sessionIdOf(team.roster, tab) !== caller) {
    throw new RefusedError(`--session ${caller} is not this tab's session (${tab}): ${KIT_NAME} issue writes only as the tab's own session`);
  }
  return caller;
}

/** Checks the caller, the repository and the text, then the caller's right to the target, then writes through the repository's host. */
async function writeOn(args: ParsedArgs, runtime: CliRuntime, write: IssueWrite, textFlag: string): Promise<ExitCode> {
  const team = await openTeam(runtime, 'read');
  const caller = writerOf(args, runtime, team);
  const notOnTeam = new RegisterPolicy(team.config, team.above).checkCaller(caller);
  if (notOnTeam !== undefined) {
    throw new RefusedError(notOnTeam);
  }
  const kind = hostKindOf(write.target.repo, team.config);
  if (kind === undefined) {
    const listed = team.config.github.repos.join(', ');
    throw new RefusedError(`${write.target.repo} is not one of the team's repositories: list it under github.repos in the team config${listed === '' ? '' : ` (now ${listed})`}`);
  }
  const scanner = new SecretScanner(team.config.register.secretPatterns);
  const refused = write.comment === undefined ? undefined : postRefusal(textFlag, write.comment, scanner);
  if (refused !== undefined) {
    throw new RefusedError(refused);
  }
  const say = (line: string): void => runtime.out.stdout(line);
  if (githubOff(runtime.env)) {
    say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; nothing was written`);
    return EXIT.ok;
  }
  const host = hostOf(kind, runtime, scanner);
  const right = await writeRight({
    caller,
    target: write.target,
    ref: refOf(kind, write.target),
    tasks: [...(await team.register.snapshot()).state.tasks.values()],
    admin: () => adminOf(runtime, team),
    head: () => host.headOf(write.target),
  });
  switch (right.kind) {
    case 'refused':
      throw new RefusedError(right.reason);
    case 'unknown':
      say(`FAILED ${right.reason}; nothing was written`);
      return EXIT.failed;
    case 'allowed':
      return (await writeIssue(host, write, say)) ? EXIT.ok : EXIT.failed;
  }
}

/** The team's GitHub admin as the signed role reads now: a broken role names no admin. */
async function adminOf(runtime: CliRuntime, team: Team): Promise<AdminView> {
  const read = await readAdminRole(adminStoreOf(runtime, team));
  switch (read.kind) {
    case 'admin':
      return { session: read.role.session, text: adminText(read.role.session, undefined) };
    case 'none':
      return { session: undefined, text: adminText(undefined, undefined) };
    case 'broken':
      return { session: undefined, text: adminText(undefined, read.reason) };
  }
}

/** The task ref that names `target` on its host. */
function refOf(kind: HostKind, target: IssueTarget): string {
  switch (kind) {
    case 'github':
      return issueRef(target.repo, target.number);
  }
}

/** The adapter for a host kind. */
function hostOf(kind: HostKind, runtime: CliRuntime, scanner: SecretScanner): IssueHost {
  switch (kind) {
    case 'github':
      return new GitHubIssueHost(runtime.gh, new RepoTokens(runtime.credentials, runtime.env), scanner);
  }
}
