import type { StartedProcess, SweepHost } from '../delivery/tree-kill.ts';

/** A host whose process lists are set by the test, one a call; it records each kill and keeps one clock. */
export class FakeSweepHost implements SweepHost {
  readonly kills: (readonly number[])[] = [];
  listCalls = 0;
  private readonly lists: (readonly StartedProcess[] | undefined)[];

  constructor(lists: (readonly StartedProcess[] | undefined)[]) {
    this.lists = lists;
  }

  list(): Promise<readonly StartedProcess[] | undefined> {
    this.listCalls += 1;
    return Promise.resolve(this.lists.shift());
  }

  kill(targets: readonly StartedProcess[]): Promise<void> {
    this.kills.push(targets.map((target) => target.pid));
    return Promise.resolve();
  }

  now(): number {
    return 1_000;
  }
}
