import type { JsonRecord } from '../core/guards.ts';
import type { GhRequest, GhResult, GhRunner } from '../github/gh.ts';

/** What a test sets on an issue; the rest takes a plain default. */
export interface IssueSpec {
  readonly title?: string;
  readonly body?: string;
  readonly state?: 'OPEN' | 'CLOSED';
  readonly stateReason?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

/** An issue as `gh issue list --json number,title,body,state,stateReason,labels,assignees,url` prints it: an empty body as ''. */
export function ghIssue(repo: string, number: number, spec: IssueSpec = {}): JsonRecord {
  return {
    number,
    title: spec.title ?? `Issue ${number}`,
    body: spec.body ?? '',
    state: spec.state ?? 'OPEN',
    stateReason: spec.stateReason ?? '',
    labels: (spec.labels ?? []).map((name) => ({ id: `L_${name}`, name, description: '', color: 'ededed' })),
    assignees: (spec.assignees ?? []).map((login) => ({ id: `U_${login}`, login, name: '' })),
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

/** The word after `flag` in a gh command line, or empty. */
function valueAfter(args: readonly string[], flag: string): string {
  const at = args.indexOf(flag);
  return at === -1 ? '' : (args[at + 1] ?? '');
}

/**
 * A gh that reaches no network: each request is recorded, so a test can hold every one to a read.
 * `issue list -R <repo> --state <state>` prints the issues `holds` set for the repository in that state;
 * a repository it holds nothing for answers as GitHub does for one the login cannot see.
 */
export class FakeGh implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly issues = new Map<string, readonly JsonRecord[]>();
  private readonly canned = new Map<string, GhResult>();
  private failure: Error | undefined;

  /** From now on, `repo` holds these issues (as ghIssue builds them). */
  holds(repo: string, issues: readonly JsonRecord[]): this {
    this.issues.set(repo, issues);
    return this;
  }

  /** From now on, every run for `repo` ends as given, whatever it holds. */
  answers(repo: string, result: GhResult): this {
    this.canned.set(repo, result);
    return this;
  }

  /** From now on, every run fails to start with `error`, as a gh that is not installed does. */
  failsWith(error: Error): this {
    this.failure = error;
    return this;
  }

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const repo = valueAfter(request.args, '-R');
    const canned = this.canned.get(repo);
    if (canned !== undefined) {
      return canned;
    }
    const issues = this.issues.get(repo);
    if (issues === undefined) {
      return { end: { kind: 'exited', code: 1 }, stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)\n` };
    }
    const state = valueAfter(request.args, '--state').toUpperCase();
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify(issues.filter((issue) => issue['state'] === state)), stderr: '' };
  }
}
