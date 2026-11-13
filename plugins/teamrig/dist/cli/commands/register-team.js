import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { assignedNotice } from "../../register/views.js";
import { HELD_PRIORITY } from "../../wake/decide.js";
import { openTeamKit, requireConfig, rosterOf, teamZone } from "../kit.js";
import { leadAboveOf } from "../tree.js";
import { teamRegister } from "../team-register.js";
import { inboxDepsOf } from "./inbox.js";
export async function teamOf(runtime, kit, access) {
    const config = requireConfig(kit, runtime, access);
    const above = await leadAboveOf(runtime, kit.paths.team, config);
    return { config, paths: kit.paths, register: teamRegister(runtime, kit.paths, config, above), roster: await rosterOf(runtime, kit, config), zone: teamZone(config, runtime), above };
}
export async function openTeam(runtime, access) {
    return teamOf(runtime, await openTeamKit(runtime), access);
}
/**
 * One inbox line telling a task's owner the task is its own; `shown` names the owner in the NOTE (another team's by
 * address). A p0 task also says the owner is woken: its team's wake check wakes an idle owner for it (src/wake/decide.ts:
 * a p0 wakes even past the budget and in blocking quiet hours), so the asker needs no `inbox add --wake now` (T2686).
 */
export async function tellAssigned(runtime, team, by, task, shown = task.owner) {
    const posted = await tellLine(runtime, team, by, task.owner, assignedNotice(task, team.zone), `${shown} was not told of ${task.id}`, shown);
    if (posted && task.priority === HELD_PRIORITY && team.config.wake.enabled) {
        runtime.out.stderr(`NOTE ${shown} is woken at its idle prompt for ${task.id}, a p0, so no --wake now is needed`);
    }
}
/** Posts one inbox line, naming it on stderr, or naming `unsent` and why: a line that cannot be posted is never thrown. */
export async function tellLine(runtime, team, by, to, text, unsent, shown = to) {
    return postNamed(runtime, team.paths, new SecretScanner(team.config.register.secretPatterns), { to, from: by, text }, unsent, shown);
}
/** Posts one line to an inbox of the team at `paths`, naming it on stderr as `shown`, or naming `unsent` and why; true when posted. */
export async function postNamed(runtime, paths, secrets, line, unsent, shown) {
    const { inboxes } = inboxDepsOf(runtime, paths);
    const problem = await postLine(inboxes, secrets, { ...line, now: new Date(runtime.clock.now()) });
    runtime.out.stderr(problem === undefined ? `NOTE ${shown} has an inbox line: ${line.text}` : `WARN ${unsent}: ${problem}`);
    return problem === undefined;
}
