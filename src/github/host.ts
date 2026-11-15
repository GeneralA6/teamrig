import type { SecretScanner } from '../core/secrets.ts';
import {
  targetText,
  type HostEnd,
  type HostList,
  type HostOpen,
  type HostReach,
  type HostUse,
  type IssueDraft,
  type IssueHost,
  type IssueTarget,
} from '../issues/host.ts';
import type { IssueState } from '../issues/issue.ts';
import { exitText } from '../open/processes.ts';
import { issueCloseArgs, issueCommentArgs, issueCreateArgs, type GhResult, type GhRunner } from './gh.ts';
import { ghFailureKind, ISSUE_LIMIT, listIssues, plainLine, startFailureText, type IssueList } from './issues.ts';
import { createdNumber } from './migrate.ts';
import { latestIssues } from './plan.ts';
import { TokenReadError, type RepoAccess, type RepoTokens } from './tokens.ts';

/** What each use does with an access, as its ACCESS line words it. */
const USE_VERB: Readonly<Record<HostUse, string>> = { read: 'read with', open: 'opens issues with', write: 'writes with' };

/**
 * GitHub as an issue host (issues/host.ts): a list is pages of the two shipped issue queries, and each write one gh
 * REST call the runner's allowlist takes (gh.ts), made with the token saved for the repository's owner, else, when
 * none is saved, the gh login. A saved token the store cannot read reaches nothing: never the login in its place
 * (tokens.ts). gh's own error, any secret shape in it redacted, is the reason a write failed.
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

  /** Reached with the owner's saved token, else the gh login; the scope is the owner, as one token serves all its repositories. */
  async reach(repo: string, use: HostUse): Promise<HostReach> {
    const access = await this.tokens.accessFor(repo);
    if (access instanceof TokenReadError) {
      return { kind: 'unreachable', reason: access.message };
    }
    const verb = USE_VERB[use];
    return {
      kind: 'reached',
      access: access.via === 'token' ? `${access.owner}: ${verb} the token saved as ${access.credential}` : `${access.owner}: ${verb} the gh login; no token saved as ${access.credential}`,
      scope: access.owner,
    };
  }

  /**
   * The open issues, then those closed on or after `closedSince`. When either read fails nothing of the repository
   * is given, so its tasks are not judged on half a read.
   */
  async list(repo: string, closedSince: string): Promise<HostList> {
    const access = await this.tokens.accessFor(repo);
    if (access instanceof TokenReadError) {
      return { kind: 'failed', reason: access.message };
    }
    const open = await listIssues(this.gh, access, { repo, state: 'open', limit: ISSUE_LIMIT });
    if (open.kind === 'failed') {
      return open;
    }
    const closed = await listIssues(this.gh, access, { repo, state: 'closed', closedSince, limit: ISSUE_LIMIT });
    if (closed.kind === 'failed') {
      return closed;
    }
    return { kind: 'listed', issues: latestIssues(open.issues, closed.issues), notes: [...listNotes('open', open), ...listNotes('closed', closed)] };
  }

  /**
   * Opens one issue. A failure is one plain line with gh's own first error line, any secret shape in it redacted; a
   * run stopped by a signal, or one that printed no issue number, may still have opened it, so its line says to
   * look before a rerun.
   */
  async open(draft: IssueDraft): Promise<HostOpen> {
    const access = await this.tokens.accessFor(draft.repo);
    if (access instanceof TokenReadError) {
      return { kind: 'failed', reason: access.message };
    }
    let result: GhResult;
    try {
      result = await this.gh.run({ args: issueCreateArgs(draft), env: access.env });
    } catch (error) {
      return { kind: 'failed', reason: startFailureText(error) };
    }
    const look = `look for it on ${draft.repo} before a rerun, and set the task's ref if it is there`;
    if (result.end.kind === 'signal') {
      return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) while opening the issue: ${look}` };
    }
    if (result.end.code !== 0) {
      return { kind: 'failed', reason: this.scanner.redact(plainLine(`gh api for an issue of ${draft.repo} ${exitText(result.end.code, result.stderr)}`)) };
    }
    const number = createdNumber(result.stdout);
    return number === undefined ? { kind: 'failed', reason: `gh printed no issue number: ${look}` } : { kind: 'opened', target: { repo: draft.repo, number } };
  }

  comment(target: IssueTarget, body: string): Promise<HostEnd> {
    return this.write(target, issueCommentArgs(target, body), 'comment on');
  }

  close(target: IssueTarget): Promise<HostEnd> {
    return this.write(target, issueCloseArgs(target), 'close');
  }

  private async write(target: IssueTarget, args: readonly string[], what: string): Promise<HostEnd> {
    const access = await this.tokens.accessFor(target.repo);
    if (access instanceof TokenReadError) {
      return { kind: 'failed', reason: access.message };
    }
    let result: GhResult;
    try {
      result = await this.gh.run({ args, env: access.env });
    } catch (error) {
      return { kind: 'failed', reason: startFailureText(error) };
    }
    if (result.end.kind === 'signal') {
      return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) on its way to ${what} ${targetText(target)}: look on GitHub before a rerun` };
    }
    if (result.end.code !== 0) {
      return { kind: 'failed', reason: this.scanner.redact(writeFailureText(target, what, result.end.code, result.stderr, access)) };
    }
    return { kind: 'done' };
  }
}

/** What a reader of the sync should know about one list: it may be cut short, or gh printed items it could not read. */
function listNotes(state: IssueState, list: Extract<IssueList, { kind: 'listed' }>): string[] {
  return [
    ...(list.full ? [`the ${state} list reached ${ISSUE_LIMIT} issues, so it may leave some out`] : []),
    ...(list.unreadable > 0 ? [`${list.unreadable} ${state} item(s) gh printed did not read as issues and were left out`] : []),
  ];
}

/** Why a write failed, with the fix when it is a known one: a refused token or login, a missing permission, an issue not there. */
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
