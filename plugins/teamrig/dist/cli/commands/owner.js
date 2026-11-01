import { formatAddress } from "../../core/address.js";
import { onePositional } from "../args.js";
import { taskRefOf } from "../inputs.js";
import { findTeam, openKit } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { postUrgentLine } from "../urgent-line.js";
import { report } from "./register.js";
import { teamOf, tellLine } from "./register-team.js";
/** `T12` and `alpha` in the caller's own team; `web/T12` and `web/alpha` in team `web` (`label`). */
export function namesOf(label) {
    return label === undefined
        ? { task: (id) => id, session: (id) => id }
        : { task: (id) => `${label}/${id}`, session: (id) => formatAddress({ team: label, id }) };
}
/** The team holding the task `text` names: the caller's own for `T12`, another team of the tree for `web/T12`. */
async function targetOf(runtime, text, access) {
    const ref = taskRefOf(text);
    const { team: own } = await findTeam(runtime);
    const held = ref.team ?? own;
    const kit = await openKit(runtime, held);
    const label = held === own ? undefined : held;
    return { kit, team: await teamOf(runtime, kit, access), id: ref.id, label, names: namesOf(label) };
}
/**
 * Posts `text` from the owner to `to` with a wake ask, so its idle tab wakes with the line quoted. A line that cannot
 * be posted or woken is named on stderr, never thrown: the register write it follows stands.
 */
async function wakeLine(runtime, target, to, text) {
    const { config } = target.team;
    const shown = target.names.session(to);
    const problem = await postUrgentLine(runtime, target.kit, config, { to, from: config.register.ownerSource, text });
    runtime.out.stderr(problem === undefined ? `NOTE ${shown} has an inbox line that wakes its idle tab: ${text}` : `WARN ${shown} was not woken: ${problem}`);
}
/** The line the task's session gets with the owner's Note. */
export function ownerNoteLine(owner, task, note) {
    return `${owner}'s Note on ${task}: ${note}`;
}
/** The line that wakes the task's session to start it next. */
export function ownerNextLine(owner, task) {
    return `${owner} put ${task} next: it is pinned above your other tasks; start it once the step in hand is done`;
}
/** The lead's line, posted without a wake, naming whose list the task tops now. */
export function ownerNextLeadLine(owner, task, names) {
    return `${owner} put ${names.task(task.id)} next on ${names.session(task.owner)}'s list: ${task.title}`;
}
/** The one line `owner next --preview` prints: where the task goes, the pin it moves down, who hears of it. */
export function ownerNextPreviewLine(owner, lead, { task, moves }, names) {
    const session = names.session(task.owner);
    const pins = moves.map((pinned) => names.task(pinned.id)).join(', ');
    const moved = moves.length === 0 ? '' : moves.length === 1 ? ` (the earlier pin on ${pins} moves down)` : ` (the earlier pins on ${pins} move down)`;
    const told = lead === task.owner ? '' : `, the lead (${names.session(lead)}) is told`;
    return `PREVIEW ${owner} next ${names.task(task.id)}: goes to the top of ${session}'s list${moved}, ${session} is woken${told}; nothing written`;
}
/**
 * `owner note <[team/]T<id>> --text ".."`: the owner's free text on a task, pressed in the pane (T1298). It is kept in
 * the task's history as the owner's (register.ownerSource), never as a session's, and sent to the task's session as an
 * inbox line that wakes it only while the task is in progress. Refused on a done or dropped task.
 */
export async function ownerNote(args, runtime) {
    const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), 'write');
    const { team, names } = target;
    const owner = team.config.register.ownerSource;
    const note = args.flags.get('text');
    const written = await team.register.ownerNote(target.id, note);
    const code = report(runtime, written, 'NOTED', team, target.label);
    if (written.ok) {
        const { task } = written.value;
        const text = ownerNoteLine(owner, names.task(task.id), note?.trim() ?? '');
        if (task.status === 'in-progress') {
            await wakeLine(runtime, target, task.owner, text);
        }
        else {
            const shown = names.session(task.owner);
            await tellLine(runtime, team, owner, task.owner, text, `${shown} was not told of ${owner}'s Note`, shown);
        }
    }
    return code;
}
/**
 * `owner next <[team/]T<id>> [--preview]`: the owner puts a task next, pressed in the pane (T1298). It pins the task
 * above every other task on its session's list (moving that session's earlier pin), wakes the session to start it once
 * the step in hand is done, and tells the team's lead without a wake. `--preview` prints what it would do and writes
 * nothing, for the pane's confirm step. Refused on a done, dropped or in-progress task, or one the owner put next already.
 */
export async function ownerNext(args, runtime) {
    const preview = args.switches.has('preview');
    const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), preview ? 'read' : 'write');
    const { team, names } = target;
    const owner = team.config.register.ownerSource;
    const lead = team.config.roles.lead;
    if (preview) {
        const seen = await team.register.ownerNextPreview(target.id);
        if (!seen.ok) {
            throw new RefusedError(seen.error);
        }
        runtime.out.stdout(ownerNextPreviewLine(owner, lead, seen.value, names));
        return EXIT.ok;
    }
    const written = await team.register.ownerNext(target.id);
    const code = report(runtime, written, 'NEXT', team, target.label);
    if (written.ok) {
        const { task } = written.value;
        await wakeLine(runtime, target, task.owner, ownerNextLine(owner, names.task(task.id)));
        if (lead !== task.owner) {
            const shownLead = names.session(lead);
            await tellLine(runtime, team, owner, lead, ownerNextLeadLine(owner, task, names), `${shownLead} was not told ${owner} put ${names.task(task.id)} next`, shownLead);
        }
    }
    return code;
}
