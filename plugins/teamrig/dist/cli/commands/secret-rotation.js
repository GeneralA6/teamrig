import { roleHolderOf } from "../../config/roster.js";
import { formatAddress } from "../../core/address.js";
import { errorMessage, stringField } from "../../core/guards.js";
import { FileLock } from "../../core/lock.js";
import { ACTIVE_STATUSES } from "../../register/model.js";
import { filedToday, SecretIncidentLog } from "../../secret-guard/incidents.js";
import { taskRefOf } from "../inputs.js";
import { teamZone } from "../kit.js";
import { sessionScopeOf, teamScopeOf } from "./hook-input.js";
import { teamOf, tellAssigned } from "./register-team.js";
import { askTeam, treeCallerOf } from "./team-ask.js";
/** How long the redactor waits for another tab's rotation filing: the hook has 15 s, and its redaction must not wait on this. */
const LOCK_WAIT_MS = 3_000;
const every = (leak, problem) => leak.kinds.map((kind) => ({ kind, problem }));
/**
 * Has each kind of secret a tool's result held rotated (T1369 R8): one register task for the team's security reviewer,
 * else its lead, per kind, session and day on the team's clock, and one line per kind in the team's incident log, with
 * the call that showed it (its id, the session's transcript and a helper's id) and the accounts a URL's credentials
 * named, which the task names too; never the value. A reviewer of a team
 * above (`<team>/<id>`) gets the task in that team's register, as an ask of the session's. A kind its session was given
 * a task for that day names that task again while it is still active; a closed one (a false positive, say) gets a new
 * task, so a real leak later that day is never folded into a task no one works (T1545). Nothing here throws: a filing
 * that fails is that kind's problem, and the redaction is sent either way.
 */
export async function fileRotations(runtime, payload, leak) {
    try {
        const team = await teamScopeOf(runtime, payload);
        if (team === undefined) {
            return every(leak, "the tab's team has no loaded config");
        }
        const session = (await sessionScopeOf(runtime, team, payload))?.id;
        const { files, clock, sleep, pid } = runtime;
        const lock = new FileLock(team.kit.paths.secretIncidentsLock, { ...team.config.lock, waitMs: LOCK_WAIT_MS }, { files, clock, sleep, pid });
        return await lock.run(() => rotateEach(runtime, team, session, callOf(payload), leak));
    }
    catch (error) {
        return every(leak, errorMessage(error));
    }
}
function callOf(payload) {
    const toolUseId = stringField(payload, 'tool_use_id');
    const transcript = stringField(payload, 'transcript_path');
    const agent = stringField(payload, 'agent_id');
    return { ...(toolUseId === undefined ? {} : { toolUseId }), ...(transcript === undefined ? {} : { transcript }), ...(agent === undefined ? {} : { agent }) };
}
async function rotateEach(runtime, team, session, call, leak) {
    const log = new SecretIncidentLog(runtime.files, team.kit.paths.secretIncidents);
    const { incidents } = await log.read();
    const now = new Date(runtime.clock.now());
    const zone = teamZone(team.config, runtime);
    const rotations = [];
    for (const kind of leak.kinds) {
        const accounts = leak.accounts.get(kind);
        const named = accounts === undefined ? {} : { accounts };
        const rotation = session === undefined ? { kind, problem: "this tab's session is not known" } : await rotationOf(runtime, team, { session, tool: leak.tool, kind, ...named }, incidents, zone);
        rotations.push(rotation);
        const incident = { at: now.toISOString(), ...(session === undefined ? {} : { session }), tool: leak.tool, ...call, kind, ...named, ...('task' in rotation ? { task: rotation.task } : {}) };
        // The task is filed either way; a lost line only lets the next incident that day try again, which the register
        // refuses as a copy of the open task.
        await log.append(incident).catch(() => undefined);
    }
    return rotations;
}
async function rotationOf(runtime, team, sighting, incidents, zone) {
    const { kind } = sighting;
    const now = new Date(runtime.clock.now());
    const filed = filedToday(incidents, kind, sighting.session, now, zone);
    try {
        if (filed !== undefined && (await stillActive(runtime, team, filed))) {
            return { kind, task: filed };
        }
        const reviewer = roleHolderOf(team.config.roles, 'securityReviewer', team.kit.paths.team) ?? { team: team.kit.paths.team, id: team.config.roles.lead };
        return await fileRotation(runtime, team, reviewer, sighting, rotationInput(sighting, zone.day(now), team.config.register.maxTitle));
    }
    catch (error) {
        return { kind, problem: errorMessage(error) };
    }
}
/**
 * Whether the task a kind was given, `T12` in the team's register or `web/T12` in another of its tree, is still open,
 * in progress, waiting or verifying; a task the named register no longer holds is not. The tree's other registers are
 * read outright: the register's own tasks need not wait on any of them.
 */
async function stillActive(runtime, team, filed) {
    const ref = taskRefOf(filed);
    const { register } = await teamOf(runtime, team.kit, 'read');
    const held = ref.team === undefined ? (await register.snapshot()).state.tasks.get(ref.id) : heldBy(await register.elsewhere(), ref.team, ref.id);
    return held !== undefined && ACTIVE_STATUSES.includes(held.status);
}
function heldBy(elsewhere, holder, id) {
    const found = elsewhere.get(id);
    return found?.team === holder ? found.task : undefined;
}
/**
 * The task: what leaked where and on which day, with whose accounts, in plain words, and never the value or a file's
 * path. The day keeps a later day's task from being refused as a copy of an earlier one still open.
 */
function rotationInput(sighting, day, maxTitle) {
    const { session, tool, kind, accounts } = sighting;
    const title = `Rotate the ${kind} a ${tool} result showed ${session} on ${day}`;
    const whose = accounts === undefined ? '' : ` (${accounts.join('; ')})`;
    return {
        title: title.length <= maxTitle ? title : `Rotate the secret a ${tool} result showed ${session} on ${day}`,
        description: `The secret redactor found a ${kind}${whose} in a ${tool} result of session ${session} and replaced it before the model saw it. Treat it as leaked: rotate it where it was issued, then close this task. The team's secret incident log names the kind, accounts, session, tool and call; no log holds the value.`,
        priority: 1,
    };
}
async function fileRotation(runtime, team, reviewer, sighting, input) {
    const { kind, session } = sighting;
    const own = team.kit.paths.team;
    if (reviewer.team !== own) {
        const caller = await treeCallerOf(runtime, own, session, reviewer.team);
        const { verdict } = await askTeam(runtime, caller, { asked: reviewer.team, owner: reviewer.id }, input);
        return verdict.ok ? { kind, task: formatAddress({ team: reviewer.team, id: verdict.value.task.id }) } : { kind, problem: verdict.error };
    }
    const written = await teamOf(runtime, team.kit, 'write');
    const verdict = await written.register.add(session, { ...input, owner: reviewer.id, source: session });
    if (!verdict.ok) {
        return { kind, problem: verdict.error };
    }
    const { task } = verdict.value;
    if (task.owner !== session) {
        await tellAssigned(runtime, written, session, task);
    }
    return { kind, task: task.id };
}
