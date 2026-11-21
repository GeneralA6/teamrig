import { SecretScanner } from "../../core/secrets.js";
import { goalsBody } from "../../interface/index.js";
import { readGoals } from "../../register/goals.js";
import { teamsFolderOf } from "../tree.js";
import { servedPathOf, skippedOf, stampsOf } from "./read-source.js";
/**
 * `goals`: the goals a task of the team may serve, which are its own and those of every team above it, the nearer
 * team's where two hold a tag, as `teamrig add --goals` and the plan's ranking read them. A team beside or below
 * the asked one is never read. It reads the tree's configs (who is above whom, the secret shapes) and those goals
 * files, and its revision covers each of them; `--owner` does not narrow it, as a goal is no session's.
 */
export function goalsSource(scope) {
    const { runtime, kit, config } = scope;
    return {
        async parts() {
            const loaded = await scope.tree();
            const configs = [...[...loaded.teams.values()].map((other) => other.kit.load.path), ...[...loaded.leftOut.values()].map((load) => load.path)];
            return {
                document: 'goals',
                args: [['team', kit.paths.team]],
                stamps: [
                    // A team folder added or removed moves no file the tree read: the folder's own listing tells.
                    (await runtime.files.list(teamsFolderOf(runtime))).join(','),
                    ...(await stampsOf(runtime, configs)),
                    ...(await stampsOf(runtime, goalsFilesOf(loaded, kit.paths))),
                ],
            };
        },
        async build() {
            const { held, problems } = await heldGoalsOf(scope);
            return { body: goalsBody({ held, shapes: new SecretScanner(config.register.secretPatterns) }), problems };
        },
    };
}
/**
 * The goals files of the scope's team and of every team above it, read once each. The `goals` document serves them
 * and `stats` counts its goals from them, so the two never read a different set of teams.
 */
export async function heldGoalsOf(scope) {
    const held = [];
    const problems = [];
    for (const holder of holdersOf(await scope.tree(), scope.kit.paths)) {
        const read = readGoals(await scope.runtime.files.read(holder.goals));
        held.push({ team: holder.team, goals: [...read.goals.values()] });
        problems.push(...leftOutOf(holder, read));
    }
    return { held, problems };
}
/** The paths of those goals files, in the order {@link heldGoalsOf} reads them: a revision's stamps are taken of these. */
export function goalsFilesOf(loaded, own) {
    return holdersOf(loaded, own).map((holder) => holder.goals);
}
/** The teams above `own` that the tree loaded, the root first, then `own` itself, read from the kit the run opened. */
function holdersOf(loaded, own) {
    const above = loaded.tree.ancestorsOf(own.team).flatMap((team) => {
        const found = loaded.teams.get(team);
        return found === undefined ? [] : [found.kit.paths];
    });
    return [...above, own];
}
/** What a goals file's read left out, a fixed line per kind: the file's served name and a count, never a line's own text. */
function leftOutOf(holder, read) {
    const ignored = read.ignored > 0 ? [`${servedPathOf(holder, holder.goals)}: ${read.ignored} record(s) of no goal left out`] : [];
    return [...skippedOf(holder, holder.goals, read), ...ignored];
}
