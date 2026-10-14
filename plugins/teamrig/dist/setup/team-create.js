import { join } from 'node:path';
import { formatConfig, loadConfig } from "../config/load.js";
import { parseConfig } from "../config/parse.js";
import { CONFIG_VERSION } from "../config/types.js";
import { ID_PATTERN, ID_RULE } from "../core/ids.js";
import { resolveTeam, TEAM_POINTER } from "../core/team.js";
function ok(value) {
    return { ok: true, value };
}
function fail(problem) {
    return { ok: false, problem };
}
/** The team from the command line: ids only, no session twice, and at least one session besides the lead. */
export function teamSpecOf(team, sessionList, lead) {
    if (!ID_PATTERN.test(team)) {
        return fail(`team "${team}" is not an id (${ID_RULE})`);
    }
    if (!ID_PATTERN.test(lead)) {
        return fail(`--lead "${lead}" is not a session id (${ID_RULE})`);
    }
    const listed = sessionList.split(',').map((id) => id.trim());
    const bad = listed.find((id) => !ID_PATTERN.test(id));
    if (bad !== undefined) {
        return fail(`--sessions "${bad}" is not a session id (${ID_RULE})`);
    }
    const twice = listed.find((id, index) => listed.indexOf(id) !== index);
    if (twice !== undefined) {
        return fail(`--sessions lists "${twice}" twice`);
    }
    // The lead may be listed too; it is always on the team.
    const workers = listed.filter((id) => id !== lead);
    if (workers.length === 0) {
        return fail('--sessions needs at least one session besides the lead');
    }
    return ok({ team, lead, sessions: [lead, ...workers] });
}
/** The smallest config that runs a team: every other setting takes its default. */
export function configRecordOf(spec) {
    const record = { configVersion: CONFIG_VERSION, sessions: [...spec.sessions], roles: { lead: spec.lead } };
    const [issue] = parseConfig(record).issues;
    if (issue !== undefined) {
        throw new Error(`the new team config breaks its own schema at ${issue.path}: ${issue.message}`);
    }
    return record;
}
function sameTeam(spec, sessions, lead) {
    return lead === spec.lead && sessions.length === spec.sessions.length && spec.sessions.every((id) => sessions.includes(id));
}
async function configStep(files, format, spec, path) {
    const load = await loadConfig(files, path, format.migrations, format.version);
    switch (load.status) {
        case 'missing':
            return ok({ kind: 'create', path, text: formatConfig(configRecordOf(spec)) });
        case 'unreadable':
            return fail(`team ${spec.team} already has a config at ${path}, and it cannot be read (${load.issue.message}); choose another team name`);
        case 'loaded':
            break;
    }
    const { sessions, roles } = load.config;
    if (sameTeam(spec, sessions, roles.lead)) {
        return ok({ kind: 'keep', path, why: `team ${spec.team} already has these sessions` });
    }
    return fail(`team ${spec.team} already exists at ${path} with sessions ${sessions.join(', ')} (lead ${roles.lead}); choose another team name, or change that config by hand`);
}
/** A project tied to no team gets a pointer; one tied to this team, here or by a parent folder, keeps it. */
async function pointerStep(files, team, project) {
    // `$TEAMRIG_TEAM` says which team a command runs for, never which team a folder belongs to.
    const found = await resolveTeam(files, {}, [project]);
    switch (found.kind) {
        case 'none':
            return ok({ kind: 'create', path: join(project, TEAM_POINTER), text: formatConfig({ team }) });
        case 'broken':
            return fail(`${found.from} ${found.problem}; fix or remove it, then run this again`);
        case 'team':
            return found.team === team
                ? ok({ kind: 'keep', path: found.from, why: `the project is already tied to team ${team}` })
                : fail(`${project} is already tied to team ${found.team} by ${found.from}; give another --project, or remove that pointer first`);
    }
}
/** Checks the config and the project's pointer; nothing is written. */
export async function planTeamSetup(files, format, spec, configPath, project) {
    const config = await configStep(files, format, spec, configPath);
    if (!config.ok) {
        return config;
    }
    const pointer = await pointerStep(files, spec.team, project);
    if (!pointer.ok) {
        return pointer;
    }
    return ok({ spec, config: config.value, pointer: pointer.value });
}
/**
 * Writes the plan's new files, the config first, each only if it is still absent. A failure after the
 * config leaves a state the next run completes: the config then matches and only the pointer is written.
 */
export async function applyTeamSetup(files, plan) {
    for (const step of [plan.config, plan.pointer]) {
        if (step.kind === 'create' && !(await files.createExclusive(step.path, step.text))) {
            return fail(`${step.path} appeared while the team was being set up; run the command again`);
        }
    }
    return ok(plan);
}
