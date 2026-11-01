import { NO_GOAL_TAGS, readGoals } from "../register/goals.js";
import { loadTree } from "./tree.js";
/**
 * The goal tags a team's task may name under `register.goals` checked or required (T1730): the tags of the team's own
 * goal records and of every team above it, up to the root, as its kit home stands at the call; a sibling team's goals
 * are not among them. Under `free` nothing is read, and a root team reads only its own file, not the tree.
 */
export class KitTreeGoals {
    runtime;
    paths;
    config;
    constructor(runtime, paths, config) {
        this.runtime = runtime;
        this.paths = paths;
        this.config = config;
    }
    async read() {
        if (this.config.register.goals === 'free') {
            return NO_GOAL_TAGS;
        }
        const files = [this.paths.goals, ...(await this.aboveFiles())];
        const reads = await Promise.all(files.map(async (file) => readGoals(await this.runtime.files.read(file))));
        return new Set(reads.flatMap((read) => [...read.goals.keys()]));
    }
    /** The goals files of the teams above this one; none for a root team, read without the tree. */
    async aboveFiles() {
        if (this.config.team?.parent === undefined) {
            return [];
        }
        const { tree, teams } = await loadTree(this.runtime);
        return tree.ancestorsOf(this.paths.team).flatMap((team) => {
            const above = teams.get(team);
            return above === undefined ? [] : [above.kit.paths.goals];
        });
    }
}
