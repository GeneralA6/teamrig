import type { HostEnd, HostList, HostOpen, HostReach, HostUse, IssueDraft, IssueHost, IssueTarget } from '../issues/host.ts';

/** What each use does, as the fake's access line words it. */
const USE_VERB: Readonly<Record<HostUse, string>> = { read: 'reads', open: 'opens issues', write: 'writes' };

/** One write a FakeIssueHost took. */
export type HostCall =
  | { readonly kind: 'open'; readonly draft: IssueDraft }
  | { readonly kind: 'comment'; readonly target: IssueTarget; readonly body: string }
  | { readonly kind: 'close'; readonly target: IssueTarget };

/**
 * An issue host that reaches nothing and holds no issue: a list is empty, each write is recorded, and ends done
 * unless a test set it to fail; opened issues are numbered from 1. It is reached as `<owner>: writes as the test`
 * (or reads, or opens issues), scoped to the owner, unless a test made it unreachable.
 */
export class FakeIssueHost implements IssueHost {
  readonly name = 'the test host';
  readonly calls: HostCall[] = [];
  private unreachableFor: string | undefined;
  private opened = 0;
  private commentEnd: HostEnd = { kind: 'done' };
  private closeEnd: HostEnd = { kind: 'done' };

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

  close(target: IssueTarget): Promise<HostEnd> {
    this.calls.push({ kind: 'close', target });
    return Promise.resolve(this.closeEnd);
  }
}
