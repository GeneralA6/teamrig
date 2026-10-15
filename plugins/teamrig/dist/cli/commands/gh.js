import { ENV, KIT_NAME } from "../../core/home.js";
import { importRules } from "../../github/map.js";
import { importedTasks, planSync } from "../../github/plan.js";
import { applySteps, closedSince, readRepo } from "../../github/sync.js";
import { priorityText } from "../../register/model.js";
import { GITHUB_ACTOR } from "../../register/policy.js";
import { noPositionals } from "../args.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRegister } from "../team-register.js";
/** The rows of steps a repository prints; the rest are counted. */
export const SHOWN_STEPS = 10;
/** `TEAMRIG_GITHUB=off` turns the import off on this machine, whatever the team config says. */
const OFF = 'off';
/**
 * `gh sync [--repo <owner/name>] [--yes]`: brings the task list in step with the GitHub issues of the team's
 * `github.repos`, inbound only. gh only ever lists issues (github/gh.ts refuses any other command), and the
 * register's import writes (register.ts) touch only the tasks it added, as `github`. Without `--yes` it
 * shows what it would write and writes nothing. Exit 1 when a repository could not be read (its tasks stay
 * as they are), 2 when the register refused a step, else 0.
 */
export async function ghSync(args, runtime) {
    noPositionals(args);
    const write = args.switches.has('yes');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, write ? 'write' : 'read');
    const say = (line) => runtime.out.stdout(line);
    if (runtime.env[ENV.github]?.trim().toLowerCase() === OFF) {
        say(`OFF ${ENV.github}=${OFF} turns the GitHub import off on this machine; nothing was read or written`);
        return EXIT.ok;
    }
    if (config.github.repos.length === 0) {
        say('OFF no repository to read: list them as "owner/name" under github.repos in the team config; nothing was read or written');
        return EXIT.ok;
    }
    const register = teamRegister(runtime, kit.paths, config);
    const rules = importRules(config);
    const since = closedSince(new Date(runtime.clock.now()), config.github.closedDays);
    const ends = [];
    let written = 0;
    for (const repo of reposOf(config.github.repos, args.flags.get('repo'))) {
        const read = await readRepo(runtime.gh, runtime.env, repo, since);
        if (read.kind === 'failed') {
            say(`FAILED ${repo}: ${read.reason}; its tasks stay as they are`);
            ends.push('failed');
            continue;
        }
        read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
        const plan = planSync(read.issues, importedTasks((await register.snapshot()).state.tasks.values()), rules);
        if (!write) {
            previewLines(repo, plan).forEach(say);
            ends.push('ok');
            continue;
        }
        const outcomes = await applySteps(register, plan.steps);
        resultLines(repo, plan, outcomes).forEach(say);
        written += outcomes.filter((outcome) => outcome.result.ok).length;
        ends.push(outcomes.every((outcome) => outcome.result.ok) ? 'ok' : 'refused');
    }
    say(write
        ? `WROTE ${written} change(s) to the task list as ${GITHUB_ACTOR}; GitHub was only read`
        : `PREVIEW nothing was written; ${KIT_NAME} gh sync --yes writes the above as ${GITHUB_ACTOR}`);
    return ends.includes('failed') ? EXIT.failed : ends.includes('refused') ? EXIT.refused : EXIT.ok;
}
/** The repositories to read: every one of `github.repos`, or the one `--repo` names, which must be among them. */
function reposOf(repos, asked) {
    if (asked === undefined) {
        return repos;
    }
    const repo = asked.trim().toLowerCase();
    if (!repos.includes(repo)) {
        throw new RefusedError(`--repo ${asked} is not one of github.repos (${repos.join(', ')})`);
    }
    return [repo];
}
function previewLines(repo, plan) {
    return [
        `REPO ${repo}: ${plan.inserted} to add, ${plan.changed} to change, ${plan.unchanged} unchanged`,
        ...shown(plan.steps.map((step) => stepLine(step, step.kind === 'add' ? 'new' : step.id))),
    ];
}
function resultLines(repo, plan, outcomes) {
    const done = outcomes.filter((outcome) => outcome.result.ok);
    const added = done.filter((outcome) => outcome.step.kind === 'add').length;
    const changed = new Set(done.filter((outcome) => outcome.step.kind !== 'add').map((outcome) => outcome.step.ref)).size;
    const refused = outcomes.length - done.length;
    return [
        `REPO ${repo}: ${added} added, ${changed} changed, ${plan.unchanged} unchanged${refused > 0 ? `, ${refused} refused` : ''}`,
        ...shown(done.map((outcome) => stepLine(outcome.step, outcome.result.ok ? outcome.result.value : ''))),
        ...outcomes.flatMap((outcome) => (outcome.result.ok ? [] : [`SKIPPED ${outcome.step.ref}: ${outcome.result.error}`])),
    ];
}
/** The first SHOWN_STEPS lines, then how many more there are. */
function shown(lines) {
    const more = lines.length - SHOWN_STEPS;
    return more > 0 ? [...lines.slice(0, SHOWN_STEPS), `... and ${more} more`] : [...lines];
}
/** One step on one line; a title is outside input, so it is printed quoted, as data. */
export function stepLine(step, id) {
    switch (step.kind) {
        case 'add':
            return `ADD ${id} ${step.ref} ${priorityText(step.input.priority)} ${step.input.owner}: ${JSON.stringify(step.input.title)}`;
        case 'update': {
            const { title, priority } = step.changes;
            const fields = [...(title === undefined ? [] : [`title ${JSON.stringify(title)}`]), ...(priority === undefined ? [] : [`priority ${priorityText(priority)}`])];
            return `UPDATE ${id} ${step.ref}: ${fields.join(', ')}`;
        }
        case 'status':
            return `SET ${id} ${step.ref} ${step.input.status}: ${step.input.note ?? ''}`;
    }
}
