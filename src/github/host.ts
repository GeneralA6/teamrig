import { isRecord, recordField, stringField } from '../core/guards.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { targetText, type HeadRead, type HostEnd, type HostReach, type IssueHost, type IssueTarget } from '../issues/host.ts';
import { exitText } from '../open/processes.ts';
import { issueCloseArgs, issueCommentArgs, pullReadArgs, type GhResult, type GhRunner } from './gh.ts';
import { ghFailureKind, plainLine, startFailureText } from './issues.ts';
import { TokenReadError, type RepoAccess, type RepoTokens } from './tokens.ts';

/** How one gh call ended: its output, or one plain line saying why it failed and whether GitHub showed nothing there. */
type CallEnd = { readonly kind: 'ran'; readonly stdout: string } | { readonly kind: 'failed'; readonly reason: string; readonly notVisible: boolean };

/**
 * GitHub as an issue host (issues/host.ts): each call is one gh REST call the runner's allowlist takes (gh.ts),
 * made with the token saved for the repository's owner, else, when none is saved, the gh login. A saved token the
 * store cannot read reaches nothing: never the login in its place (tokens.ts). gh's own error, any secret shape in
 * it redacted, is the reason a call failed.
 */
export class GitHubIssueHost implements IssueHost {
  readonly name = 'GitHub';
  private readonly gh: GhRunner;
  private readonly tokens: RepoTokens;
  private readonly scanner: SecretScanner;

  constructor(gh: GhRunner, tokens: RepoTokens, scanner: SecretScanner) {
    this.gh = gh;
    this.tokens = tokens;
    this.scanner = scanner;
  }

  async reach(repo: string): Promise<HostReach> {
    const access = await this.tokens.accessFor(repo);
    if (access instanceof TokenReadError) {
      return { kind: 'unreachable', reason: access.message };
    }
    return {
      kind: 'reached',
      access: access.via === 'token' ? `${access.owner}: writes with the token saved as ${access.credential}` : `${access.owner}: writes with the gh login; no token saved as ${access.credential}`,
    };
  }

  comment(target: IssueTarget, body: string): Promise<HostEnd> {
    return this.write(target, issueCommentArgs(target, body), 'comment on');
  }

  close(target: IssueTarget): Promise<HostEnd> {
    return this.write(target, issueCloseArgs(target), 'close');
  }

  /**
   * The pull request's head, from the REST read of it. GitHub answers 404 for an issue's number as for one not there,
   * so both read as `no-pull`: no head that could make it a session's own.
   */
  async headOf(target: IssueTarget): Promise<HeadRead> {
    const end = await this.call(target, pullReadArgs(target), 'read');
    if (end.kind === 'failed') {
      return end.notVisible ? { kind: 'no-pull' } : { kind: 'failed', reason: end.reason };
    }
    return headIn(end.stdout) ?? { kind: 'failed', reason: `GitHub's answer for ${targetText(target)} names no head branch: look at it on GitHub` };
  }

  private async write(target: IssueTarget, args: readonly string[], what: string): Promise<HostEnd> {
    const end = await this.call(target, args, what);
    return end.kind === 'ran' ? { kind: 'done' } : { kind: 'failed', reason: end.reason };
  }

  private async call(target: IssueTarget, args: readonly string[], what: string): Promise<CallEnd> {
    const access = await this.tokens.accessFor(target.repo);
    if (access instanceof TokenReadError) {
      return { kind: 'failed', reason: access.message, notVisible: false };
    }
    let result: GhResult;
    try {
      result = await this.gh.run({ args, env: access.env });
    } catch (error) {
      return { kind: 'failed', reason: startFailureText(error), notVisible: false };
    }
    if (result.end.kind === 'signal') {
      return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) on its way to ${what} ${targetText(target)}: look on GitHub before a rerun`, notVisible: false };
    }
    if (result.end.code !== 0) {
      const notVisible = ghFailureKind(result.end.code, result.stderr) === 'not-visible';
      return { kind: 'failed', reason: this.scanner.redact(writeFailureText(target, what, result.end.code, result.stderr, access)), notVisible };
    }
    return { kind: 'ran', stdout: result.stdout };
  }
}

/** The head branch and its repository from GitHub's pull request JSON, or undefined when it names no head branch. */
export function headIn(stdout: string): HeadRead | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const head = isRecord(parsed) ? recordField(parsed, 'head') : undefined;
  const branch = head === undefined ? undefined : stringField(head, 'ref');
  if (head === undefined || branch === undefined || branch === '') {
    return undefined;
  }
  const repo = recordField(head, 'repo');
  const name = repo === undefined ? undefined : stringField(repo, 'full_name');
  return { kind: 'pull', branch, repo: name === undefined ? null : name.toLowerCase() };
}

/** Why a call failed, with the fix when it is a known one: a refused token or login, a missing permission, an issue not there. */
export function writeFailureText(target: IssueTarget, what: string, code: number, stderr: string, access: RepoAccess): string {
  const shown = targetText(target);
  const token = `the token saved as ${access.credential}`;
  const saveOne = `save a token for ${access.owner} with Issues and Pull requests read and write, with: ${access.save}`;
  switch (ghFailureKind(code, stderr)) {
    case 'no-login':
      return access.via === 'token'
        ? `GitHub refused ${token} (expired or revoked?): create a new one and save it again with: ${access.save}`
        : `gh is not logged in to GitHub: run gh auth login, or ${saveOne}`;
    case 'no-permission':
      return access.via === 'token'
        ? `${token} may not ${what} ${shown}: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again`
        : `the gh login may not ${what} ${shown}: ${saveOne}`;
    case 'not-visible':
      return `${shown} is not there for ${access.via === 'token' ? token : 'the gh login'}: check the number, and that the token reaches ${target.repo}`;
    case undefined:
      return plainLine(`gh api to ${what} ${shown} ${exitText(code, stderr)}`);
  }
}
