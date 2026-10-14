import { dirname, join, resolve } from 'node:path';
import { errorMessage, isRecord } from "./guards.js";
import { ENV } from "./home.js";
import { ID_PATTERN, ID_RULE } from "./ids.js";
import { pathKey } from "./paths.js";
/** The file that ties a project folder, and every folder below it, to a team: `{"team": "<id>"}`. */
export const TEAM_POINTER = '.teamrig.json';
/** The `from` of a team named by `$TEAMRIG_TEAM` rather than by a pointer file. */
export const ENV_SOURCE = `$${ENV.team}`;
/**
 * `$TEAMRIG_TEAM` wins, so a session working in another team's repo keeps its own team. Otherwise
 * the nearest pointer file, walking up from each folder in order; a folder already walked from an
 * earlier start, in any spelling the platform treats as the same, is not read twice.
 */
export async function resolveTeam(files, env, folders) {
    const fromEnv = env[ENV.team]?.trim();
    if (fromEnv) {
        return checkTeam(fromEnv, ENV_SOURCE);
    }
    const walked = new Set();
    for (const folder of folders) {
        for (let dir = resolve(folder); !walked.has(pathKey(dir)); dir = dirname(dir)) {
            walked.add(pathKey(dir));
            const found = await readPointer(files, join(dir, TEAM_POINTER));
            if (found !== undefined) {
                return found;
            }
        }
    }
    return { kind: 'none' };
}
async function readPointer(files, path) {
    let text;
    try {
        text = await files.read(path);
    }
    catch (error) {
        return { kind: 'broken', from: path, problem: `cannot be read (${errorMessage(error)})` };
    }
    if (text === undefined) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: 'broken', from: path, problem: 'is not JSON; expected {"team": "<id>"}' };
    }
    const team = isRecord(parsed) ? parsed['team'] : undefined;
    return typeof team === 'string' ? checkTeam(team, path) : { kind: 'broken', from: path, problem: 'has no "team" text; expected {"team": "<id>"}' };
}
function checkTeam(team, from) {
    return ID_PATTERN.test(team) ? { kind: 'team', team, from } : { kind: 'broken', from, problem: `"${team}" is not a team id (${ID_RULE})` };
}
