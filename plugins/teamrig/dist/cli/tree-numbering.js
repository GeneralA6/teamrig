import { FileLock } from "../core/lock.js";
import { LogNumbers, OWN_NUMBERS, TreeNumbering } from "../register/numbering.js";
import { JsonlEventLog } from "../register/store.js";
import { loadTree } from "./tree.js";
/**
 * A team's numbering as its kit home's tree stands at the write (T1139): one across every register of the tree,
 * under the lock in the root team's state folder; the team's own when it hangs in no tree, or when its parents go
 * round a loop, which `doctor` names.
 */
export class KitTreeNumbering {
    runtime;
    team;
    timings;
    constructor(runtime, team, timings) {
        this.runtime = runtime;
        this.team = team;
        this.timings = timings;
    }
    async issue(write) {
        return (await this.numbering()).issue(write);
    }
    async numbering() {
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
        const { files, clock, sleep, pid } = this.runtime;
        const lock = new FileLock(root.kit.paths.idsLock, this.timings, { files, clock, sleep, pid });
        return new TreeNumbering(lock, others.map((other) => new LogNumbers(new JsonlEventLog(files, other.kit.paths.events))));
    }
}
