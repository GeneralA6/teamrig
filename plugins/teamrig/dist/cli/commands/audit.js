import { formatAddress } from "../../core/address.js";
import { shortSha256 } from "../../register/hand-step.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { handStepPin } from "../hand-step-file.js";
import { callerOf, taskIdOf } from "../inputs.js";
import { findTeam, openKit, sessionIdOf } from "../kit.js";
import { RefusedError } from "../runtime.js";
import { report } from "./register.js";
import { openTeam, teamOf, tellLine } from "./register-team.js";
import { treeCallerOf } from "./team-ask.js";
/** The line the task's owner reads: who audited which file at which sha256, and that an edit to it needs a new audit. */
function auditedNotice(by, id, pin) {
    return `${by} audited the hand step ${pin.path} for ${id} at sha256 ${shortSha256(pin.sha256)}; an edit to it needs a new audit (core rule 11)`;
}
/**
 * Prints the written audit and tells the task's owner from `by`, the auditor as the owner's inbox names it (tellLine
 * names that line, with the pin, on stderr); `label` names another team's register, whose ids then read `<label>/T12`
 * and `<label>/<owner>`.
 */
async function reportAudit(runtime, written, team, by, pin, label) {
    const code = report(runtime, written, 'AUDITED', team, label);
    if (!written.ok) {
        return code;
    }
    const { task } = written.value;
    const id = label === undefined ? task.id : `${label}/${task.id}`;
    if (task.owner !== by) {
        const shown = label === undefined ? task.owner : formatAddress({ team: label, id: task.owner });
        await tellLine(runtime, team, by, task.owner, auditedNotice(by, id, pin), `${shown} was not told of the audit on ${id}`, shown);
    }
    return code;
}
/**
 * `audit T<n> --file <path> [--team <child>]`: an auditor of a team below audits one of its tasks' hand steps (T2312).
 * The caller's team must sit above `child` in the tree; the audit lands in `child`'s register as an event by the
 * caller's `<team>/<id>`, the form `child`'s roles.securityReviewer names a reviewer above it by, and its policy judges it.
 */
async function auditBelow(runtime, caller, child, id, pin, note) {
    const { team } = await findTeam(runtime);
    if (team === child) {
        throw new UsageError(`--team ${child} is your own team: audit ${id} without --team`);
    }
    const { from: address, tree } = await treeCallerOf(runtime, team, caller, child);
    if (!tree.ancestorsOf(child).includes(team)) {
        throw new RefusedError(`team ${child} is not below team ${team}: --team names a team below yours`);
    }
    const from = formatAddress(address);
    const target = await teamOf(runtime, await openKit(runtime, child), 'write');
    return reportAudit(runtime, await target.register.auditFrom(from, id, pin, note), target, from, pin, child);
}
/**
 * `audit T<n> --file <path> [--note ".."] [--team <child>]` (T2312, core rule 11): the security reviewer read a hand
 * step file for the task's owner to hand the human, and pins it at the sha256 of its bytes now, so a card may carry
 * it. The policy names who may (never the task's own owner) and the file kinds with a run line; a missing file is
 * refused here. The owner gets one inbox line naming the pin.
 */
export async function audit(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const caller = callerOf(args.flags, runtime.env);
    const note = args.flags.get('note');
    const child = args.flags.get('team');
    const pin = await handStepPin(runtime, 'file', requiredFlag(args.flags, 'file'));
    if (child !== undefined) {
        return auditBelow(runtime, caller, child, id, pin, note);
    }
    const team = await openTeam(runtime, 'write');
    const by = sessionIdOf(team.roster, caller);
    return reportAudit(runtime, await team.register.audit(by, id, pin, note), team, by, pin);
}
