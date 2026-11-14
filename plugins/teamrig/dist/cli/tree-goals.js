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
        return this.recorded();
    }
    async recorded() {
        return new Set((await this.all()).keys());
    }
    async sliced() {
        return this.all();
    }
    /**
     * Every goal a task of the team may serve, whatever `register.goals` says, as a goal's rank counts under `free` too.
     * A tag two teams hold reads as the nearest team's: the root's goes first, so each team below overwrites it.
     */
    async all() {
        const files = [...(await this.aboveFiles()), this.paths.goals];
        const reads = await Promise.all(files.map(async (file) => readGoals(await this.runtime.files.read(file))));
        return new Map(reads.flatMap((read) => [...read.goals]));
    }
    /** The goals files of the teams above this one, root first; none for a root team, read without the tree. */
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
