import { join } from 'node:path';
import { taskFolder } from "../../core/home.js";
import { noPositionals, onePositional, UsageError } from "../args.js";
import { callerOf, taskIdOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { ownRegister } from "./register.js";
/**
 * The team whose register holds the task: the caller's own, a compacted task in its history included, else the team
 * of the tree that holds it (T1139). A task no register holds is refused, so a typo never makes a stray folder.
 */
async function holderOf(own, id) {
    if (own.snapshot.state.tasks.has(id)) {
        return own.team;
    }
    const away = own.elsewhere.get(id);
    if (away !== undefined) {
        return away.team;
    }
    if (own.snapshot.retired !== null && (await own.history()).state.tasks.has(id)) {
        return own.team;
    }
    throw new RefusedError(`no task ${id}`);
}
async function notesFolderOf(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const roster = await rosterOf(runtime, kit, requireConfig(kit, runtime, 'read'));
    return join(kit.paths.notes, sessionIdOf(roster, callerOf(args.flags, runtime.env)));
}
/**
 * `files <id>`: the folder for a task's files (design, build notes, plan, review, evidence), in the team whose register
 * holds it; `files --notes`: the caller's folder for notes that belong to no task. Either is made when missing and
 * printed alone, so a session writes there without composing a path (T1457).
 */
export async function files(args, runtime) {
    let folder;
    if (args.switches.has('notes')) {
        folder = await notesFolderOf(args, runtime);
    }
    else {
        if (args.positionals.length === 0) {
            throw new UsageError('files needs <id>, or --notes for your notes');
        }
        const id = taskIdOf(onePositional(args, 'id'));
        const { own } = await ownRegister(runtime);
        folder = taskFolder(own.paths.kitHome, await holderOf(own, id), id);
    }
    await runtime.files.makeFolder(folder);
    runtime.out.stdout(folder);
    return EXIT.ok;
}
