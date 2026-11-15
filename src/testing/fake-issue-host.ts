import type { CloseReason, HostAssignee, HostComments, HostEnd, HostIssueId, HostJobLog, HostLabel, HostLinks, HostList, HostOpen, HostPulls, HostReach, HostUse, HostWatch, IssueDraft, IssueHost, IssueTarget, LabelSpec, WatchMarks } from '../issues/host.ts';
import type { LinkedIssue } from '../issues/issue.ts';
import type { HostPull } from '../issues/pull.ts';

/** What each use does, as the fake's access line words it. */
const USE_VERB: Readonly<Record<HostUse, string>> = { read: 'reads', open: 'opens issues', write: 'writes' };

/** One write a FakeIssueHost took. */
export type HostCall =
  | { readonly kind: 'open'; readonly draft: IssueDraft }
  | { readonly kind: 'comment'; readonly target: IssueTarget; readonly body: string }
  | { readonly kind: 'body'; readonly target: IssueTarget; readonly body: string }
  | { readonly kind: 'close'; readonly target: IssueTarget; readonly reason?: CloseReason; readonly duplicateId?: number }
  | { readonly kind: 'label-add'; readonly target: IssueTarget; readonly labels: readonly string[] }
  | { readonly kind: 'label-remove'; readonly target: IssueTarget; readonly label: string }
  | { readonly kind: 'label-create'; readonly repo: string; readonly label: LabelSpec }
  | { readonly kind: 'sub-issue'; readonly parent: IssueTarget; readonly childId: number }
  | { readonly kind: 'blocked-by'; readonly target: IssueTarget; readonly blockerId: number }
  | { readonly kind: 'assign'; readonly target: IssueTarget; readonly logins: readonly string[] }
  | { readonly kind: 'unassign'; readonly target: IssueTarget; readonly login: string };

/**
 * An issue host that reaches nothing and holds no issue: a list is empty, a pull request read gives what a test set,
 * each write is recorded, and ends done unless a test set it to fail; opened issues are numbered from 1. Its
 * repositories have the labels a test gave it, and every issue a test did not make missing, with the id 1000 + its
 * number; its links read gives the issues a test gave it, by repository. It is reached as `<owner>: writes as the
 * test` (or reads, or opens issues), scoped to the owner, unless a test made it unreachable.
 */
export class FakeIssueHost implements IssueHost {
  readonly name = 'the test host';
  readonly calls: HostCall[] = [];
  private unreachableFor: string | undefined;
  private opened = 0;
  private commentEnd: HostEnd = { kind: 'done' };
  private closeEnd: HostEnd = { kind: 'done' };
  private bodyEnd: HostEnd = { kind: 'done' };
  private labelEnd: HostEnd = { kind: 'done' };
  private labelCreateEnd: HostEnd = { kind: 'done' };
  private readonly removeEnds = new Map<string, HostEnd>();
  private labelReadFailure: string | undefined;
  private readonly labels = new Set<string>();
  private linkEnd: HostEnd = { kind: 'done' };
  private readonly linked = new Map<string, HostLinks>();
  private idRead: HostIssueId | undefined;
  private readonly unassignable = new Set<string>();
  private readonly spellings = new Map<string, string>();
  private assigneeRead: HostAssignee | undefined;
  private assignEnd: HostEnd = { kind: 'done' };
  private unassignEnd: HostEnd = { kind: 'done' };

  /** From now on, taking an assignee off fails for `reason`. */
  failsUnassign(reason: string): this {
    this.unassignEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, these logins may not be assigned in any repository; every other login may. */
  cannotAssign(...logins: string[]): this {
    logins.forEach((login) => this.unassignable.add(login));
    return this;
  }

  /** From now on, the host spells each of these logins as given, whatever case a read names it in. */
  spells(...logins: string[]): this {
    logins.forEach((login) => this.spellings.set(login.toLowerCase(), login));
    return this;
  }

  /** From now on, every read of whether a login may be assigned ends as `end`. */
  readsAssignee(end: HostAssignee): this {
    this.assigneeRead = end;
    return this;
  }

  /** From now on, an assign fails for `reason`. */
  failsAssign(reason: string): this {
    this.assignEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, every repository has these labels. */
  hasLabels(...labels: string[]): this {
    labels.forEach((label) => this.labels.add(label));
    return this;
  }

  /** From now on, making a label fails for `reason`. */
  failsLabelCreate(reason: string): this {
    this.labelCreateEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, a label add or remove fails for `reason`. */
  failsLabel(reason: string): this {
    this.labelEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, taking `label` off fails for `reason`, while other labels come off. */
  failsRemove(label: string, reason: string): this {
    this.removeEnds.set(label, { kind: 'failed', reason });
    return this;
  }

  /** From now on, a read of whether a repository has a label fails for `reason`. */
  failsLabelRead(reason: string): this {
    this.labelReadFailure = reason;
    return this;
  }
  /** Each pull request read asked, in order. */
  readonly pullReads: { readonly repo: string; readonly since: string | undefined }[] = [];
  private readonly pullsOf = new Map<string, readonly HostPull[]>();
  private pullsFailure: string | undefined;
  /** Each failed job's log read asked, in order. */
  readonly jobLogReads: { readonly repo: string; readonly jobId: number }[] = [];
  private readonly jobLogs = new Map<number, HostJobLog>();

  /** From now on, a links read of `repo` gives `issues`, with `notes` about the read. */
  withLinks(repo: string, issues: readonly LinkedIssue[], notes: readonly string[] = []): this {
    this.linked.set(repo, { kind: 'listed', issues, notes });
    return this;
  }

  /** From now on, a links read of `repo` fails for `reason`. */
  failsLinks(repo: string, reason: string): this {
    this.linked.set(repo, { kind: 'failed', reason });
    return this;
  }

  /** From now on, each link write fails for `reason`. */
  failsLinkWrite(reason: string): this {
    this.linkEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, a read of any issue's id ends as given: missing, or failed with its reason. */
  readsId(end: HostIssueId): this {
    this.idRead = end;
    return this;
  }

  /** From now on, the host cannot be reached, for `reason`. */
  unreachable(reason: string): this {
    this.unreachableFor = reason;
    return this;
  }

  /** From now on, a comment fails for `reason`. */
  failsComment(reason: string): this {
    this.commentEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, a body edit fails for `reason`. */
  failsBody(reason: string): this {
    this.bodyEnd = { kind: 'failed', reason };
    return this;
  }

  /** From now on, a close fails for `reason`. */
  failsClose(reason: string): this {
    this.closeEnd = { kind: 'failed', reason };
    return this;
  }

  reach(repo: string, use: HostUse): Promise<HostReach> {
    const owner = repo.split('/')[0] ?? repo;
    return Promise.resolve(
      this.unreachableFor === undefined ? { kind: 'reached', access: `${owner}: ${USE_VERB[use]} as the test`, scope: owner } : { kind: 'unreachable', reason: this.unreachableFor },
    );
  }

  list(): Promise<HostList> {
    return Promise.resolve({ kind: 'listed', issues: [], notes: [] });
  }

  /** From now on, a pull request read of `repo` gives the open ones of `pulls`, and those changed at or after its time. */
  holdsPulls(repo: string, pulls: readonly HostPull[]): this {
    this.pullsOf.set(repo, pulls);
    return this;
  }

  /** From now on, a pull request read fails for `reason`. */
  failsPulls(reason: string): this {
    this.pullsFailure = reason;
    return this;
  }

  /** From now on, a log read of job `jobId` gives `log`; a job with none set reads as a log with no line. */
  holdsJobLog(jobId: number, log: HostJobLog): this {
    this.jobLogs.set(jobId, log);
    return this;
  }

  jobLog(repo: string, jobId: number): Promise<HostJobLog> {
    this.jobLogReads.push({ repo, jobId });
    return Promise.resolve(this.jobLogs.get(jobId) ?? { kind: 'read', step: undefined, lines: [] });
  }

  pulls(repo: string, since: string | undefined): Promise<HostPulls> {
    this.pullReads.push({ repo, since });
    if (this.pullsFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.pullsFailure });
    }
    const held = this.pullsOf.get(repo) ?? [];
    const changed = since === undefined ? held : held.filter((pull) => Date.parse(pull.updatedAt) >= Date.parse(since));
    return Promise.resolve({ kind: 'listed', open: held.filter((pull) => pull.state === 'open'), changed, notes: [] });
  }

  open(draft: IssueDraft): Promise<HostOpen> {
    this.calls.push({ kind: 'open', draft });
    this.opened += 1;
    return Promise.resolve({ kind: 'opened', target: { repo: draft.repo, number: this.opened } });
  }

  comment(target: IssueTarget, body: string): Promise<HostEnd> {
    this.calls.push({ kind: 'comment', target, body });
    return Promise.resolve(this.commentEnd);
  }

  editBody(target: IssueTarget, body: string): Promise<HostEnd> {
    this.calls.push({ kind: 'body', target, body });
    return Promise.resolve(this.bodyEnd);
  }

  close(target: IssueTarget, reason?: CloseReason, duplicateId?: number): Promise<HostEnd> {
    this.calls.push({ kind: 'close', target, ...(reason === undefined ? {} : { reason }), ...(duplicateId === undefined ? {} : { duplicateId }) });
    return Promise.resolve(this.closeEnd);
  }

  issueId(target: IssueTarget): Promise<HostIssueId> {
    return Promise.resolve(this.idRead ?? { kind: 'found', id: 1000 + target.number });
  }

  labelExists(_repo: string, label: string): Promise<HostLabel> {
    if (this.labelReadFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.labelReadFailure });
    }
    return Promise.resolve({ kind: this.labels.has(label) ? 'found' : 'missing' });
  }

  /** Records the make; once it is done, every repository has the label. */
  createLabel(repo: string, label: LabelSpec): Promise<HostEnd> {
    this.calls.push({ kind: 'label-create', repo, label });
    if (this.labelCreateEnd.kind === 'done') {
      this.labels.add(label.name);
    }
    return Promise.resolve(this.labelCreateEnd);
  }

  addLabels(target: IssueTarget, labels: readonly string[]): Promise<HostEnd> {
    this.calls.push({ kind: 'label-add', target, labels });
    return Promise.resolve(this.labelEnd);
  }

  removeLabel(target: IssueTarget, label: string): Promise<HostEnd> {
    this.calls.push({ kind: 'label-remove', target, label });
    return Promise.resolve(this.removeEnds.get(label) ?? this.labelEnd);
  }

  links(repo: string): Promise<HostLinks> {
    return Promise.resolve(this.linked.get(repo) ?? { kind: 'listed', issues: [], notes: [] });
  }

  addSubIssue(parent: IssueTarget, childId: number): Promise<HostEnd> {
    this.calls.push({ kind: 'sub-issue', parent, childId });
    return Promise.resolve(this.linkEnd);
  }

  addBlockedBy(target: IssueTarget, blockerId: number): Promise<HostEnd> {
    this.calls.push({ kind: 'blocked-by', target, blockerId });
    return Promise.resolve(this.linkEnd);
  }

  assigneeExists(_repo: string, login: string): Promise<HostAssignee> {
    return Promise.resolve(this.assigneeRead ?? (this.unassignable.has(login) ? { kind: 'missing' } : { kind: 'found', login: this.spellings.get(login.toLowerCase()) ?? login }));
  }

  assign(target: IssueTarget, logins: readonly string[]): Promise<HostEnd> {
    this.calls.push({ kind: 'assign', target, logins });
    return Promise.resolve(this.assignEnd);
  }

  /** Each repository changed when no marks are given (it holds no issue to change later), else unchanged. */
  watch(_repo: string, marks: WatchMarks): Promise<HostWatch> {
    return Promise.resolve(marks.size === 0 ? { kind: 'changed', marks: new Map([['all', 'seen']]) } : { kind: 'unchanged' });
  }

  unassign(target: IssueTarget, login: string): Promise<HostEnd> {
    this.calls.push({ kind: 'unassign', target, login });
    return Promise.resolve(this.unassignEnd);
  }

  /** Its issues have no comments, as its list holds none. */
  newComments(_target: IssueTarget, _since: number): Promise<HostComments> {
    return Promise.resolve({ kind: 'read', comments: [] });
  }
}
