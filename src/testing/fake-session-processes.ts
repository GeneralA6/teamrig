import type { EndHow, EndOutcome, FeedOutcome, FeedRequest, ProcessInfo, SessionProcesses } from '../open/session-processes.ts';

/**
 * A process table in memory: only the processes added run, ending one also ends every process it started
 * (as the start-checked sweep does), and each look at a process, end and fed program is recorded. Feeding a program gives
 * the outcome set for its command, by default `done`.
 */
export class FakeSessionProcesses implements SessionProcesses {
  readonly parentPid: number;
  readonly described: number[] = [];
  /** Each pid whose starters were listed. */
  readonly lineages: number[] = [];
  readonly ends: { readonly pid: number; readonly how: EndHow }[] = [];
  readonly fed: FeedRequest[] = [];
  private readonly running = new Map<number, ProcessInfo>();
  private readonly endFailures = new Map<number, string>();
  private readonly lingering = new Set<number>();
  private readonly feedOutcomes = new Map<string, FeedOutcome>();
  private childrenHidden = false;
  private lineageHidden = false;
  private failingLookups = 0;
  /** Called after each end that ended something, as the operating system would tell a waiting parent. */
  private onEnded: (pid: number) => void = () => undefined;

  constructor(parentPid: number = 7000) {
    this.parentPid = parentPid;
  }

  /** A running process. */
  add(info: ProcessInfo): this {
    this.running.set(info.pid, info);
    return this;
  }

  /** Ending `pid` fails with `error`, and it runs on. */
  failEnd(pid: number, error: string): this {
    this.endFailures.set(pid, error);
    return this;
  }

  /** An `ask` end of `pid` reports success but leaves it running, as a program that ignores SIGTERM. */
  linger(pid: number): this {
    this.lingering.add(pid);
    return this;
  }

  /** `pid` ends by itself, as a command that finished: no end is recorded, and what it started runs on. */
  exit(pid: number): this {
    this.running.delete(pid);
    return this;
  }

  /** From now on the system will not list the processes one started. */
  hideChildren(): this {
    this.childrenHidden = true;
    return this;
  }

  /** From now on the system will not list a process's starters. */
  hideLineage(): this {
    this.lineageHidden = true;
    return this;
  }

  /** The next `count` looks at a process fail, as a lookup that timed out: `describe` gives undefined while it runs. */
  failLookups(count: number): this {
    this.failingLookups = count;
    return this;
  }

  /** From now on, feeding `command` gives `outcome`. */
  onFeed(command: string, outcome: FeedOutcome): this {
    this.feedOutcomes.set(command, outcome);
    return this;
  }

  /** Runs `listener` with each pid an end removes. */
  whenEnded(listener: (pid: number) => void): this {
    this.onEnded = listener;
    return this;
  }

  alive(pid: number): boolean {
    return this.running.has(pid);
  }

  async describe(pid: number): Promise<ProcessInfo | undefined> {
    this.described.push(pid);
    if (this.failingLookups > 0) {
      this.failingLookups -= 1;
      return undefined;
    }
    return this.running.get(pid);
  }

  async children(pid: number): Promise<readonly ProcessInfo[] | undefined> {
    return this.childrenHidden ? undefined : this.childrenOf(pid);
  }

  async lineage(pid: number): Promise<readonly ProcessInfo[] | undefined> {
    this.lineages.push(pid);
    if (this.lineageHidden) {
      return undefined;
    }
    const chain: ProcessInfo[] = [];
    for (let info = this.running.get(pid); info !== undefined && !chain.includes(info); info = this.running.get(info.parentPid)) {
      chain.push(info);
    }
    return chain;
  }

  async end(pid: number, how: EndHow): Promise<EndOutcome> {
    this.ends.push({ pid, how });
    const failure = this.endFailures.get(pid);
    if (failure !== undefined) {
      return { kind: 'failed', error: failure };
    }
    if (!this.running.has(pid)) {
      return { kind: 'gone' };
    }
    if (how === 'ask' && this.lingering.has(pid)) {
      return { kind: 'ended' };
    }
    for (const ended of this.tree(pid)) {
      this.running.delete(ended);
      this.onEnded(ended);
    }
    return { kind: 'ended' };
  }

  async feed(request: FeedRequest): Promise<FeedOutcome> {
    this.fed.push(request);
    return this.feedOutcomes.get(request.command) ?? { kind: 'done' };
  }

  /** `pid` and every running process it started, directly or not. */
  private tree(pid: number): readonly number[] {
    return [pid, ...this.childrenOf(pid).flatMap((child) => this.tree(child.pid))];
  }

  private childrenOf(pid: number): readonly ProcessInfo[] {
    return [...this.running.values()].filter((info) => info.parentPid === pid && info.pid !== pid);
  }
}
