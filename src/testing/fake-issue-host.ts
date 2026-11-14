import type { HeadRead, HostEnd, HostReach, IssueHost, IssueTarget } from '../issues/host.ts';

/** One write a FakeIssueHost took. */
export type HostCall = { readonly kind: 'comment'; readonly target: IssueTarget; readonly body: string } | { readonly kind: 'close'; readonly target: IssueTarget };

/**
 * An issue host that reaches nothing: each write is recorded, and ends done unless a test set it to fail. It is
 * reached as `access` unless a test made it unreachable.
 */
export class FakeIssueHost implements IssueHost {
  readonly name = 'the test host';
  readonly calls: HostCall[] = [];
  readonly reached: string[] = [];
  private reach_: HostReach = { kind: 'reached', access: 'acme: writes as the test' };
  private commentEnd: HostEnd = { kind: 'done' };
  private closeEnd: HostEnd = { kind: 'done' };

  /** From now on, the host cannot be reached, for `reason`. */
  unreachable(reason: string): this {
    this.reach_ = { kind: 'unreachable', reason };
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

  reach(repo: string): Promise<HostReach> {
    this.reached.push(repo);
    return Promise.resolve(this.reach_);
  }

  comment(target: IssueTarget, body: string): Promise<HostEnd> {
    this.calls.push({ kind: 'comment', target, body });
    return Promise.resolve(this.commentEnd);
  }

  close(target: IssueTarget): Promise<HostEnd> {
    this.calls.push({ kind: 'close', target });
    return Promise.resolve(this.closeEnd);
  }

  /** Every number is an issue here: a test of a pull request's head uses FakeGh through the GitHub host. */
  headOf(): Promise<HeadRead> {
    return Promise.resolve({ kind: 'no-pull' });
  }
}
