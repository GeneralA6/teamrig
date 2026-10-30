import type { LockTimings } from '../core/lock.ts';
import { LogNumbers, OWN_NUMBERS, TreeNumbering, type TaskNumbering } from '../register/numbering.ts';
import { JsonlEventLog } from '../register/store.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree } from './tree.ts';
import { fileLockOf } from './file-locks.ts';

/**
 * A team's numbering as its kit home's tree stands at the write (T1139): one across every register of the tree,
 * under the lock in the root team's state folder; the team's own when it hangs in no tree, or when its parents go
 * round a loop, which `doctor` names.
 */
export class KitTreeNumbering implements TaskNumbering {
  private readonly runtime: CliRuntime;
  private readonly team: string;
  private readonly timings: LockTimings;

  constructor(runtime: CliRuntime, team: string, timings: LockTimings) {
    this.runtime = runtime;
    this.team = team;
    this.timings = timings;
  }

  async issue<T>(write: (floor: number) => Promise<T>): Promise<T> {
    return (await this.numbering()).issue(write);
  }

  private async numbering(): Promise<TaskNumbering> {
    const { tree, teams } = await loadTree(this.runtime);
    const rootId = tree.rootOf(this.team);
    const root = rootId === undefined ? undefined : teams.get(rootId);
    if (rootId === undefined || root === undefined) {
      return OWN_NUMBERS;
    }
    const others = tree
      .walk(rootId)
      .filter((step) => step.team !== this.team)
      .flatMap((step) => teams.get(step.team) ?? []);
    if (others.length === 0) {
      return OWN_NUMBERS;
    }
    const { files } = this.runtime;
    const lock = fileLockOf(this.runtime, root.kit.paths.idsLock, this.timings);
    return new TreeNumbering(lock, others.map((other) => new LogNumbers(new JsonlEventLog(files, other.kit.paths.events))));
  }
}
