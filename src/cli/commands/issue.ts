import { ENV } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { GitHubIssueHost } from '../../github/host.ts';
import { RepoTokens } from '../../github/tokens.ts';
import { hostKindOf, parseIssueTarget, type HostKind, type IssueHost, type IssueTarget } from '../../issues/host.ts';
import { postRefusal, writeIssue, type IssueWrite } from '../../issues/write.ts';
import { RegisterPolicy } from '../../register/policy.ts';
import { onePositional, requiredFlag, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { GITHUB_OFF, githubOff } from './gh-auto.ts';
import { openTeam } from './register-team.ts';

/**
 * `issue comment <owner/name#n> --body <text>` (T2660): posts one comment on an issue or pull request of the team's
 * repositories, through the host whose config list names the repository (issues/host.ts; GitHub, github.repos, is
 * the only one so far). The caller must be on the team; the body may not be empty, carry a secret shape or name a
 * task id. Exit 1 when the host failed, else 0.
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

/** Checks the caller, the repository and the text, then writes through the repository's host. */
async function writeOn(args: ParsedArgs, runtime: CliRuntime, write: IssueWrite, textFlag: string): Promise<ExitCode> {
  const team = await openTeam(runtime, 'read');
  const notOnTeam = new RegisterPolicy(team.config, team.above).checkCaller(sessionIdOf(team.roster, callerOf(args.flags, runtime.env)));
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
  return (await writeIssue(hostOf(kind, runtime, scanner), write, say)) ? EXIT.ok : EXIT.failed;
}

/** The adapter for a host kind. */
function hostOf(kind: HostKind, runtime: CliRuntime, scanner: SecretScanner): IssueHost {
  switch (kind) {
    case 'github':
      return new GitHubIssueHost(runtime.gh, new RepoTokens(runtime.credentials, runtime.env), scanner);
  }
}
