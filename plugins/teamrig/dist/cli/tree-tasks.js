import { JsonlEventLog } from "../register/store.js";
import { NO_TASKS_ELSEWHERE } from "../register/tree.js";
import { loadTree } from "./tree.js";
/**
 * The tasks a team tree's other registers hold, as one team of it reads them (T1139): each register's working set,
 * in the tree's walk order from its root, the first to hold an id winning. Nothing when the team hangs in no tree,
 * or when its parents go round a loop, which `doctor` names. Each register is read once however many teams ask, and
 * {@link registersFor} gives each register's working set apart, the asking team's own among them.
 */
export class TreeTasks {
    runtime;
    kitTree;
    snapshots = new Map();
    /** `known` holds the working sets the caller read already, by team, which are not read again. */
    constructor(runtime, kitTree, known = new Map()) {
        this.runtime = runtime;
        this.kitTree = kitTree;
        for (const [team, snapshot] of known) {
            this.snapshots.set(team, Promise.resolve(snapshot));
        }
    }
    async elsewhereFor(team) {
        const others = this.registersOf(team)?.filter((other) => other.team !== team) ?? [];
        const reads = await this.read(others);
        const tasks = new Map();
        for (const { team: holder, snapshot } of reads) {
            for (const task of snapshot.state.tasks.values()) {
                if (!tasks.has(task.id)) {
                    tasks.set(task.id, { team: holder, task });
                }
            }
        }
        return tasks.size === 0 ? NO_TASKS_ELSEWHERE : tasks;
    }
    /**
     * The working set of every register of the tree `team` hangs in, its own among them, in the tree's walk order from
     * its root; undefined when the parents above `team` go round a loop, so the tree has no root to walk from.
     */
    async registersFor(team) {
        const registers = this.registersOf(team);
        return registers === undefined ? undefined : this.read(registers);
    }
    registersOf(team) {
        const { tree, teams } = this.kitTree;
        const rootId = tree.rootOf(team);
        if (rootId === undefined) {
            return undefined;
        }
        return tree.walk(rootId).flatMap((step) => {
            const other = teams.get(step.team);
            return other === undefined ? [] : [{ team: step.team, events: other.kit.paths.events }];
        });
    }
    read(registers) {
        return Promise.all(registers.map(async (register) => ({ team: register.team, snapshot: await this.snapshotOf(register.team, register.events) })));
    }
    snapshotOf(team, events) {
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
export class KitTreeTasks {
    runtime;
    team;
    constructor(runtime, team) {
        this.runtime = runtime;
        this.team = team;
    }
    async read() {
        return new TreeTasks(this.runtime, await loadTree(this.runtime)).elsewhereFor(this.team);
    }
}
