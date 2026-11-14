import type { CloseReason, HostEnd, HostLabel, HostList, HostOpen, HostReach, HostUse, IssueDraft, IssueHost, IssueTarget } from '../issues/host.ts';

/** What each use does, as the fake's access line words it. */
const USE_VERB: Readonly<Record<HostUse, string>> = { read: 'reads', open: 'opens issues', write: 'writes' };

/** One write a FakeIssueHost took. */
export type HostCall =
  | { readonly kind: 'open'; readonly draft: IssueDraft }
  | { readonly kind: 'comment'; readonly target: IssueTarget; readonly body: string }
  | { readonly kind: 'close'; readonly target: IssueTarget; readonly reason?: CloseReason }
  | { readonly kind: 'label-add'; readonly target: IssueTarget; readonly labels: readonly string[] }
  | { readonly kind: 'label-remove'; readonly target: IssueTarget; readonly label: string };

/**
 * An issue host that reaches nothing and holds no issue: a list is empty, each write is recorded, and ends done
 * unless a test set it to fail; opened issues are numbered from 1. Its repositories have the labels a test gave it. It is reached as `<owner>: writes as the test`
 * (or reads, or opens issues), scoped to the owner, unless a test made it unreachable.
 */
export class FakeIssueHost implements IssueHost {
  readonly name = 'the test host';
  readonly calls: HostCall[] = [];
  private unreachableFor: string | undefined;
  private opened = 0;
  private commentEnd: HostEnd = { kind: 'done' };
  private closeEnd: HostEnd = { kind: 'done' };
  private labelEnd: HostEnd = { kind: 'done' };
  private readonly removeEnds = new Map<string, HostEnd>();
  private labelReadFailure: string | undefined;
  private readonly labels = new Set<string>();

  /** From now on, every repository has these labels. */
  hasLabels(...labels: string[]): this {
    labels.forEach((label) => this.labels.add(label));
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

  open(draft: IssueDraft): Promise<HostOpen> {
    this.calls.push({ kind: 'open', draft });
    this.opened += 1;
    return Promise.resolve({ kind: 'opened', target: { repo: draft.repo, number: this.opened } });
  }

  comment(target: IssueTarget, body: string): Promise<HostEnd> {
    this.calls.push({ kind: 'comment', target, body });
    return Promise.resolve(this.commentEnd);
  }

  close(target: IssueTarget, reason?: CloseReason): Promise<HostEnd> {
    this.calls.push(reason === undefined ? { kind: 'close', target } : { kind: 'close', target, reason });
    return Promise.resolve(this.closeEnd);
  }

  labelExists(_repo: string, label: string): Promise<HostLabel> {
    if (this.labelReadFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.labelReadFailure });
    }
    return Promise.resolve({ kind: this.labels.has(label) ? 'found' : 'missing' });
  }

  addLabels(target: IssueTarget, labels: readonly string[]): Promise<HostEnd> {
    this.calls.push({ kind: 'label-add', target, labels });
    return Promise.resolve(this.labelEnd);
  }

  removeLabel(target: IssueTarget, label: string): Promise<HostEnd> {
    this.calls.push({ kind: 'label-remove', target, label });
    return Promise.resolve(this.removeEnds.get(label) ?? this.labelEnd);
  }
}
