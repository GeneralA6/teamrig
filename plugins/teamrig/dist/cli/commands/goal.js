import { KIT_NAME } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { GoalStore } from "../../register/goal-store.js";
import { GOAL_TAG, isGoalDay, NO_GOAL } from "../../register/goals.js";
import { noPositionals, onePositional, requiredFlag, UsageError } from "../args.js";
import { fileLockOf } from "../file-locks.js";
import { callerOf } from "../inputs.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
async function goalsKit(runtime, access) {
    const found = await findTeam(runtime);
    const kit = await openKit(runtime, found.team);
    const config = requireConfig(kit, runtime, access);
    return {
        config,
        roster: await rosterOf(runtime, kit, config),
        store: new GoalStore(runtime.files, kit.paths.goals, fileLockOf(runtime, kit.paths.goalsLock, config.lock)),
        path: kit.paths.goals,
        zone: teamZone(config, runtime),
        now: runtime.clock.now(),
    };
}
/** The caller as a goal's writer: the team's lead, else refused. */
function leadWriter(gk, args, runtime) {
    const caller = sessionIdOf(gk.roster, callerOf(args.flags, runtime.env));
    const lead = gk.roster.holderOf('lead');
    if (caller !== lead) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${gk.roster.nameOf(lead) ?? lead})`} adds and changes the team's goals`);
    }
    return { by: caller, at: new Date(gk.now).toISOString() };
}
/** The goal tag the command names, checked for its shape. */
function tagOf(args) {
    const tag = onePositional(args, 'goal tag');
    if (tag === NO_GOAL || !GOAL_TAG.test(tag)) {
        throw new UsageError(`"${tag}" is not a goal tag: a letter, then letters, digits, . or -, at most 24 characters, never "${NO_GOAL}"`);
    }
    return tag;
}
/** A day flag, `YYYY-MM-DD`. */
function dayOf(flag, text) {
    const day = text.trim();
    if (!isGoalDay(day)) {
        throw new UsageError(`--${flag} "${text}" is not a YYYY-MM-DD day`);
    }
    return day;
}
/** A text flag that is one line, at most `max` characters and no secret. */
function lineOf(flag, text, max, secrets) {
    const line = text.trim();
    if (line === '' || /[\r\n]/.test(line)) {
        throw new UsageError(`--${flag} is one non-empty line`);
    }
    const length = [...line].length;
    if (length > max) {
        throw new UsageError(`--${flag} holds ${length} characters: at most ${max}`);
    }
    const refusal = secrets.refusal(`--${flag}`, line);
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
    return line;
}
function slipsText(goal) {
    const count = goal.slips.length;
    return count === 0 ? '' : `, ${count} slip${count === 1 ? '' : 's'}`;
}
/** One goal as a list line: its tag, window, slips and parent, then its title. */
export function goalLine(goal) {
    const parent = goal.parent === null ? '' : `, part of ${goal.parent}`;
    return `${goal.tag} ${goal.start} to ${goal.target}${slipsText(goal)}${parent} | ${goal.title}`;
}
/** The goals as a tree: each top goal in the order added, then its parts under it, one level deeper each. */
export function goalTree(goals) {
    const children = new Map();
    for (const goal of goals.values()) {
        const parent = goal.parent !== null && goals.has(goal.parent) ? goal.parent : null;
        children.set(parent, [...(children.get(parent) ?? []), goal]);
    }
    const rows = [];
    const visit = (parent, depth) => {
        for (const goal of children.get(parent) ?? []) {
            rows.push({ goal, depth });
            visit(goal.tag, depth + 1);
        }
    };
    visit(null, 0);
    return rows;
}
/** Warns on stderr about lines of the goals file that fold to no goal. */
function warnDamage(runtime, read, path) {
    if (read.unreadable + read.newer + read.ignored > 0) {
        runtime.out.stderr(`WARN ${path}: ${read.unreadable} unreadable line(s), ${read.newer} line(s) from a newer ${KIT_NAME}, ${read.ignored} record(s) naming no goal or a second add`);
    }
}
/** Prints a write's goal as it now reads, or refuses with the store's reason. */
async function written(runtime, gk, verb, write) {
    if (write.kind === 'refused') {
        throw new RefusedError(write.reason);
    }
    const goal = (await gk.store.read()).goals.get(write.record.tag);
    runtime.out.stdout(`${verb} goal ${goal === undefined ? write.record.tag : goalLine(goal)}`);
    return EXIT.ok;
}
/** `goal add <tag> --title "<title>" --target <YYYY-MM-DD> [--start <YYYY-MM-DD>] [--parent <tag>]`: the lead adds a goal; its start is today by default. */
export async function goalAdd(args, runtime) {
    const tag = tagOf(args);
    const gk = await goalsKit(runtime, 'write');
    const writer = leadWriter(gk, args, runtime);
    const secrets = new SecretScanner(gk.config.register.secretPatterns);
    const start = args.flags.get('start');
    const parent = args.flags.get('parent')?.trim();
    const input = {
        tag,
        title: lineOf('title', requiredFlag(args.flags, 'title'), gk.config.register.maxTitle, secrets),
        start: start === undefined ? gk.zone.day(new Date(gk.now)) : dayOf('start', start),
        target: dayOf('target', requiredFlag(args.flags, 'target')),
        parent: parent === undefined || parent === '' ? null : parent,
    };
    return written(runtime, gk, 'ADDED', await gk.store.add(input, writer));
}
/** `goal set <tag> [--target <YYYY-MM-DD>] [--title "<title>"] --note "<why>"`: the lead moves a goal's target (a slip) or renames it. */
export async function goalSet(args, runtime) {
    const tag = tagOf(args);
    const gk = await goalsKit(runtime, 'write');
    const writer = leadWriter(gk, args, runtime);
    const secrets = new SecretScanner(gk.config.register.secretPatterns);
    const target = args.flags.get('target');
    const title = args.flags.get('title');
    const input = {
        tag,
        target: target === undefined ? null : dayOf('target', target),
        title: title === undefined ? null : lineOf('title', title, gk.config.register.maxTitle, secrets),
        note: lineOf('note', requiredFlag(args.flags, 'note'), gk.config.register.maxText, secrets),
    };
    return written(runtime, gk, 'SET', await gk.store.set(input, writer));
}
/** `goal list`: the team's goals as a tree, one line each. */
export async function goalList(args, runtime) {
    noPositionals(args);
    const gk = await goalsKit(runtime, 'read');
    const read = await gk.store.read();
    warnDamage(runtime, read, gk.path);
    if (read.goals.size === 0) {
        runtime.out.stdout(`GOALS 0: the lead adds one with ${KIT_NAME} goal add <tag> --title "<title>" --target <YYYY-MM-DD>`);
        return EXIT.ok;
    }
    runtime.out.stdout(`GOALS ${read.goals.size} (${KIT_NAME} goal show <tag> prints one with its slips)`);
    goalTree(read.goals).forEach(({ goal, depth }) => runtime.out.stdout(`${'  '.repeat(depth + 1)}${goalLine(goal)}`));
    return EXIT.ok;
}
/** `goal show <tag>`: one goal, who added it and when, its parts, and each move of its target with the note saying why. */
export async function goalShow(args, runtime) {
    const tag = tagOf(args);
    const gk = await goalsKit(runtime, 'read');
    const read = await gk.store.read();
    warnDamage(runtime, read, gk.path);
    const goal = read.goals.get(tag);
    if (goal === undefined) {
        throw new RefusedError(`${tag} is not a goal of the team: ${KIT_NAME} goal list lists them`);
    }
    goalShowLines(goal, read.goals, gk.zone).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/** What `goal show` prints for `goal`. */
export function goalShowLines(goal, goals, zone) {
    const parts = [...goals.values()].filter((each) => each.parent === goal.tag).map((each) => each.tag);
    const added = goal.slips.length === 0 ? '' : ` (planned ${goal.slips[0]?.from ?? goal.target})`;
    return [
        `${goal.tag} | ${goal.title}`,
        `  window ${goal.start} to ${goal.target}${added}`,
        `  added ${zone.weekdayMinute(new Date(goal.addedAt))} by ${goal.addedBy}`,
        ...(goal.parent === null ? [] : [`  part of ${goal.parent}`]),
        ...(parts.length === 0 ? [] : [`  parts ${parts.join(', ')}`]),
        `  SLIPS ${goal.slips.length}`,
        ...goal.slips.map((slip) => `    ${zone.weekdayMinute(new Date(slip.at))} ${slip.by}: ${slip.from} -> ${slip.to} | ${slip.note}`),
    ];
}
