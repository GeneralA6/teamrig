import { targetText, type CloseReason, type HostAssignee, type HostComments, type HostEnd, type HostIssueId, type HostIssueLabels, type HostJobLog, type HostLabel, type HostLabelFile, type HostLinks, type HostList, type HostOpen, type HostPulls, type HostReach, type HostThread, type HostUse, type HostViewer, type HostWatch, type IssueDraft, type IssueHost, type IssueTarget, type LabelNaming, type LabelSpec, type WatchMarks } from '../issues/host.ts';
import type { FieldValue, HostField, HostFieldRead, IssueFields } from '../issues/fields.ts';
import type { HostIssue, IssueThread, LinkedIssue } from '../issues/issue.ts';
import type { HostPost, HostPosts } from '../issues/post.ts';
import type { HostPull } from '../issues/pull.ts';

/** The login a fake host's access, and FakeGh's token, belong to until a test says otherwise: the account the sync runs as. */
export const FAKE_VIEWER = 'sync-bot';

/** An issue as the fake reads one a test did not give: open, with no labels, assignees or body. */
const BLANK_THREAD: IssueThread = { state: 'open', labels: [], assignees: [], pull: false, body: '' };

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
  | { readonly kind: 'unassign'; readonly target: IssueTarget; readonly login: string }
  | { readonly kind: 'field'; readonly target: IssueTarget; readonly field: string; readonly value: FieldValue }
  | { readonly kind: 'type'; readonly target: IssueTarget; readonly type: string };

/**
 * An issue host that reaches nothing: a list gives the issues a test gave it, none until then, a pull request read gives what a test set,
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
  private openFailure: string | undefined;
  private commentEnd: HostEnd = { kind: 'done' };
  private closeEnd: HostEnd = { kind: 'done' };
  private bodyEnd: HostEnd = { kind: 'done' };
  private labelEnd: HostEnd = { kind: 'done' };
  private labelCreateEnd: HostEnd = { kind: 'done' };
  private readonly removeEnds = new Map<string, HostEnd>();
  private labelReadFailure: string | undefined;
  private listed: readonly HostIssue[] = [];
  private readonly labels = new Set<string>();
  /** How it names a label; as it is, until a test says otherwise. */
  private naming: LabelNaming = (label) => label;
  private readonly labelFiles = new Map<string, HostLabelFile>();
  /** The repositories whose label file was read, in order. */
  readonly labelFileReads: string[] = [];
  private linkEnd: HostEnd = { kind: 'done' };
  private readonly linked = new Map<string, HostLinks>();
  private idRead: HostIssueId | undefined;
  private readonly unassignable = new Set<string>();
  private readonly spellings = new Map<string, string>();
  private assigneeRead: HostAssignee | undefined;
  /** Whom the access belongs to; the sync's own account, FAKE_VIEWER, until a test says otherwise. */
  private viewerRead: HostViewer = { kind: 'found', login: FAKE_VIEWER };
  /** How many times who the access belongs to was read. */
  viewerReads = 0;
  private assignEnd: HostEnd = { kind: 'done' };
  private readonly itemLabels = new Map<string, readonly string[]>();
  private issueLabelsRead: HostIssueLabels | undefined;
  private readonly participants = new Set<string>();
  /** Each item a labels read was asked for, in order. */
  readonly labelReads: IssueTarget[] = [];
  private unassignEnd: HostEnd = { kind: 'done' };
  /** No fields capability until a test gives one, as a tracker without issue fields has none. */
  fields?: IssueFields;

  /**
   * From now on, it has issue fields: a read of any repository gives `read`, and each field or type write is recorded
   * and ends with `end`.
   */
  hasFields(read: HostFieldRead, end: HostEnd = { kind: 'done' }): this {
    this.fields = {
      read: (_repo: string) => Promise.resolve(read),
      setField: (target: IssueTarget, field: HostField, value: FieldValue) => {
        this.calls.push({ kind: 'field', target, field: field.name, value });
        return Promise.resolve(end);
      },
      setType: (target: IssueTarget, type: string) => {
        this.calls.push({ kind: 'type', target, type });
        return Promise.resolve(end);
      },
    };
    return this;
  }
  private readonly threads = new Map<number, IssueThread>();
  private threadRead: HostThread | undefined;

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

  /** From now on, every read of whom the access belongs to ends as `viewer`: found with a login, or failed. */
  runsAs(viewer: HostViewer): this {
    this.viewerRead = viewer;
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

  /** From now on, the issue or pull request `target` carries these labels; every other one carries none. */
  labelsItem(target: IssueTarget, ...labels: string[]): this {
    this.itemLabels.set(targetText(target), labels);
    return this;
  }

  /** From now on, every read of an item's labels ends as `end`. */
  readsIssueLabels(end: HostIssueLabels): this {
    this.issueLabelsRead = end;
    return this;
  }

  /** From now on, these logins may be assigned only to the items they took part in: never in a repository-wide read. */
  tookPart(...logins: string[]): this {
    logins.forEach((login) => this.participants.add(login));
    return this;
  }

  /** From now on, every repository has these labels. */
  hasLabels(...labels: string[]): this {
    labels.forEach((label) => this.labels.add(label));
    return this;
  }

  /** From now on, it holds each label under the name `naming` gives it, as a tracker whose labels take fewer names does. */
  namesLabels(naming: LabelNaming): this {
    this.naming = naming;
    return this;
  }

  /** From now on, a read of `repo`'s label file gives `file`; a repository a test gave none has no label file. */
  holdsLabelFile(repo: string, file: HostLabelFile): this {
    this.labelFiles.set(repo, file);
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
  /** Each posts read asked, in order. */
  readonly postReads: { readonly repo: string; readonly since: string }[] = [];
  private readonly postsOf = new Map<string, readonly HostPost[]>();
  private postsFailure: string | undefined;

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

  /** From now on, opening an issue fails for `reason` and opens nothing. */
  failsOpen(reason: string): this {
    this.openFailure = reason;
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

  /** From now on, a list gives those of `issues` that are the asked repository's. */
  lists(...issues: HostIssue[]): this {
    this.listed = issues;
    return this;
  }

  list(repo: string): Promise<HostList> {
    return Promise.resolve({ kind: 'listed', issues: this.listed.filter((issue) => issue.repo === repo), notes: [] });
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

  /** From now on, a posts read of `repo` gives these, those changed at or after its time; a repository with none set has none. */
  holdsPosts(repo: string, posts: readonly HostPost[]): this {
    this.postsOf.set(repo, posts);
    return this;
  }

  /** From now on, a posts read fails for `reason`. */
  failsPosts(reason: string): this {
    this.postsFailure = reason;
    return this;
  }

  posts(repo: string, since: string): Promise<HostPosts> {
    this.postReads.push({ repo, since });
    if (this.postsFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.postsFailure });
    }
    const posts = (this.postsOf.get(repo) ?? []).filter((post) => Date.parse(post.updatedAt) >= Date.parse(since));
    return Promise.resolve({ kind: 'read', posts, cutAt: undefined, notes: [] });
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
    if (this.openFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.openFailure });
    }
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

  /** From now on, a read of `number` in any repository gives `thread`. */
  holdsThread(number: number, thread: Partial<IssueThread>): this {
    this.threads.set(number, { ...BLANK_THREAD, ...thread });
    return this;
  }

  /** From now on, every read of an issue or pull request ends as `end`. */
  readsThread(end: HostThread): this {
    this.threadRead = end;
    return this;
  }

  /** The thread a test gave the number, else an open issue with no labels, assignees or body. */
  thread(target: IssueTarget): Promise<HostThread> {
    return Promise.resolve(this.threadRead ?? { kind: 'read', thread: this.threads.get(target.number) ?? BLANK_THREAD });
  }

  labelName(label: string): string {
    return this.naming(label);
  }

  labelExists(_repo: string, label: string): Promise<HostLabel> {
    if (this.labelReadFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.labelReadFailure });
    }
    return Promise.resolve({ kind: this.labels.has(label) ? 'found' : 'missing' });
  }

  labelFile(repo: string): Promise<HostLabelFile> {
    this.labelFileReads.push(repo);
    return Promise.resolve(this.labelFiles.get(repo) ?? { kind: 'missing' });
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
    return Promise.resolve(this.assigneeRead ?? (this.participants.has(login) ? { kind: 'missing' } : this.assignee(login)));
  }

  viewer(_repo: string): Promise<HostViewer> {
    this.viewerReads += 1;
    return Promise.resolve(this.viewerRead);
  }

  /** As assigneeExists, but a login that took part in an item may be assigned to it too. */
  assignableOn(_target: IssueTarget, login: string): Promise<HostAssignee> {
    return Promise.resolve(this.assigneeRead ?? this.assignee(login));
  }

  /** Missing for a login set unassignable, else found as the host spells it. */
  private assignee(login: string): HostAssignee {
    return this.unassignable.has(login) ? { kind: 'missing' } : { kind: 'found', login: this.spellings.get(login.toLowerCase()) ?? login };
  }

  issueLabels(target: IssueTarget): Promise<HostIssueLabels> {
    this.labelReads.push(target);
    return Promise.resolve(this.issueLabelsRead ?? { kind: 'read', labels: this.itemLabels.get(targetText(target)) ?? [] });
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

  /** Its issues have no new comments. */
  newComments(_target: IssueTarget, _since: number): Promise<HostComments> {
    return Promise.resolve({ kind: 'read', comments: [] });
  }
}
