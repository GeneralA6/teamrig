import type { ElsewhereReader } from '../register/register.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';
import { JsonlEventLog } from '../register/store.ts';
import { NO_TASKS_ELSEWHERE, type TaskElsewhere, type TasksElsewhere } from '../register/tree.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree, type KitTree } from './tree.ts';

/**
 * The tasks a team tree's other registers hold, as one team of it reads them (T1139): each register's working set,
 * in the tree's walk order from its root, the first to hold an id winning. Nothing when the team hangs in no tree,
 * or when its parents go round a loop, which `doctor` names. Each register is read once however many teams ask.
 */
export class TreeTasks {
  private readonly runtime: CliRuntime;
  private readonly kitTree: KitTree;
  private readonly snapshots = new Map<string, Promise<RegisterSnapshot>>();

  /** `known` holds the working sets the caller read already, by team, which are not read again. */
  constructor(runtime: CliRuntime, kitTree: KitTree, known: ReadonlyMap<string, RegisterSnapshot> = new Map()) {
    this.runtime = runtime;
    this.kitTree = kitTree;
    for (const [team, snapshot] of known) {
      this.snapshots.set(team, Promise.resolve(snapshot));
    }
  }

  async elsewhereFor(team: string): Promise<TasksElsewhere> {
    const { tree, teams } = this.kitTree;
    const rootId = tree.rootOf(team);
    if (rootId === undefined) {
      return NO_TASKS_ELSEWHERE;
    }
    const others = tree
      .walk(rootId)
      .filter((step) => step.team !== team)
      .flatMap((step) => {
        const other = teams.get(step.team);
        return other === undefined ? [] : [{ team: step.team, events: other.kit.paths.events }];
      });
    const reads = await Promise.all(others.map(async (other) => ({ team: other.team, snapshot: await this.snapshotOf(other.team, other.events) })));
    const tasks = new Map<string, TaskElsewhere>();
    for (const { team: holder, snapshot } of reads) {
      for (const task of snapshot.state.tasks.values()) {
        if (!tasks.has(task.id)) {
          tasks.set(task.id, { team: holder, task });
        }
      }
    }
    return tasks.size === 0 ? NO_TASKS_ELSEWHERE : tasks;
  }

  private snapshotOf(team: string, events: string): Promise<RegisterSnapshot> {
    const known = this.snapshots.get(team);
    if (known !== undefined) {
      return known;
    }
    const read = new JsonlEventLog(this.runtime.files, events).read();
    this.snapshots.set(team, read);
    return read;
  }
}

/** What a team's register writes and reads with: the other registers of its tree as its kit home stands at the call. */
export class KitTreeTasks implements ElsewhereReader {
  private readonly runtime: CliRuntime;
  private readonly team: string;

  constructor(runtime: CliRuntime, team: string) {
    this.runtime = runtime;
    this.team = team;
  }

  async read(): Promise<TasksElsewhere> {
    return new TreeTasks(this.runtime, await loadTree(this.runtime)).elsewhereFor(this.team);
  }
}
