import type { GithubConfig } from '../config/types.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { IssueDraft } from '../issues/host.ts';
import { ISSUE_REF_PREFIX, LOCAL_REF_PREFIX } from '../register/model.ts';
import type { Verdict } from '../register/policy.ts';
import { issueLabels, priorityLabelOf, publicIssueText, type RowType } from './migrate.ts';

/**
 * What `teamrig add` does about the new task's GitHub issue (T3132): open one with the public wording given, record
 * why the task stays local, or nothing. While `github.issueAtAdd` names a repository, an add must say one or the
 * other (or point `--ref` at an issue it has), so no task starts without its issue unless someone wrote why. Judged
 * before the task is written, so a refused add writes nothing.
 */

/** What an add asked about its issue, from its flags, and the task's own type and priority for the labels. */
export interface AddIssueAsk {
  /** `--issue`: the issue's public title. */
  readonly title: string | undefined;
  /** `--issue-body`: the issue's public body. */
  readonly body: string | undefined;
  /** `--issue-repo`: the repository, one of `github.repos`. */
  readonly repo: string | undefined;
  /** `--local`: why the task gets no issue. */
  readonly local: string | undefined;
  /** `--ref`: the task's own ref. */
  readonly ref: string | undefined;
  readonly type: RowType | undefined;
  readonly priority: number;
}

/** No issue, the local ref to write with the task, or the issue to open before it is written, its ref pointing there. */
export type AddIssuePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'local'; readonly ref: string }
  | { readonly kind: 'open'; readonly draft: IssueDraft };

/** The name a refusal gives the task, which has no id before it is written. */
const NEW_TASK = 'the new task';

/** The plan for an add's issue under the team's GitHub settings, or why the add is refused. */
export function addIssuePlan(ask: AddIssueAsk, github: Pick<GithubConfig, 'repos' | 'issueAtAdd'>, scanner: SecretScanner): Verdict<AddIssuePlan> {
  const asksIssue = ask.title !== undefined || ask.body !== undefined || ask.repo !== undefined;
  if (ask.local !== undefined) {
    return localPlan(ask.local, asksIssue, ask.ref);
  }
  if (asksIssue) {
    return openPlan(ask, github, scanner);
  }
  if (github.issueAtAdd !== undefined && !(ask.ref?.startsWith(ISSUE_REF_PREFIX) ?? false)) {
    return {
      ok: false,
      error: `github.issueAtAdd is ${github.issueAtAdd}: give the task's public issue with --issue <title> --issue-body <text>, or why it stays local with --local <reason>`,
    };
  }
  return { ok: true, value: { kind: 'none' } };
}

function localPlan(reason: string, asksIssue: boolean, ref: string | undefined): Verdict<AddIssuePlan> {
  if (asksIssue) {
    return { ok: false, error: '--local keeps the task off GitHub, so it takes no --issue, --issue-body or --issue-repo' };
  }
  if (ref !== undefined) {
    return { ok: false, error: '--local writes the task\'s ref as the reason; give --local or --ref, not both' };
  }
  const shown = reason.trim();
  if (shown === '' || /[\r\n]/u.test(shown)) {
    return { ok: false, error: '--local is one line saying why the task gets no issue' };
  }
  return { ok: true, value: { kind: 'local', ref: `${LOCAL_REF_PREFIX}${shown}` } };
}

function openPlan(ask: AddIssueAsk, github: Pick<GithubConfig, 'repos' | 'issueAtAdd'>, scanner: SecretScanner): Verdict<AddIssuePlan> {
  if (ask.title === undefined || ask.body === undefined) {
    return { ok: false, error: '--issue and --issue-body come together: the issue\'s public title and body' };
  }
  if (ask.ref !== undefined) {
    return { ok: false, error: '--issue points the task\'s ref at its new issue; give --issue or --ref, not both' };
  }
  const repo = repoOf(ask.repo, github);
  if (!repo.ok) {
    return repo;
  }
  const text = publicIssueText(NEW_TASK, ask.title, ask.body, scanner);
  if (!text.ok) {
    return text;
  }
  const labels = issueLabels(ask.type ?? 'task', priorityLabelOf(ask.priority));
  return { ok: true, value: { kind: 'open', draft: { repo: repo.value, ...text.value, labels } } };
}

/** `--issue-repo`, else `github.issueAtAdd`, else the one repository of `github.repos`. */
function repoOf(asked: string | undefined, { repos, issueAtAdd }: Pick<GithubConfig, 'repos' | 'issueAtAdd'>): Verdict<string> {
  if (repos.length === 0) {
    return { ok: false, error: 'github.repos names no repository to open the issue in' };
  }
  if (asked !== undefined) {
    const repo = asked.trim().toLowerCase();
    return repos.includes(repo) ? { ok: true, value: repo } : { ok: false, error: `--issue-repo ${asked} is not one of github.repos (${repos.join(', ')})` };
  }
  if (issueAtAdd !== undefined) {
    return { ok: true, value: issueAtAdd };
  }
  const [only, ...more] = repos;
  if (only === undefined || more.length > 0) {
    return { ok: false, error: `--issue-repo names the repository: github.repos has ${repos.length} (${repos.join(', ')}) and github.issueAtAdd names none` };
  }
  return { ok: true, value: only };
}
