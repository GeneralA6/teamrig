import { join } from 'node:path';
import { isTemporaryName } from "../core/files.js";
import { isRecord, isStringArray, stringField } from "../core/guards.js";
/** The folder of parked steps, inside the detached folder (`detachedDirOf`). */
export const PARKED_DIR = 'parked';
/** The suffix of a parked step's file. */
export const PARKED_SUFFIX = '.parked.json';
/** The parked step's format; a field added is a new format (CONTRIBUTING, Stored files). */
export const PARKED_FORMAT = 1;
/** The parked folder of the detached folder `detachedDir`. */
export function parkedDirOf(detachedDir) {
    return join(detachedDir, PARKED_DIR);
}
/** The file of the parked step `id` in the parked folder `dir`. */
export function parkedPathOf(dir, id) {
    return join(dir, `${id}${PARKED_SUFFIX}`);
}
export function formatParked(step) {
    return `${JSON.stringify(step)}\n`;
}
/** `value` as an environment, or undefined when one of its values is not text. */
function envOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const env = {};
    for (const [name, text] of Object.entries(value)) {
        if (typeof text !== 'string') {
            return undefined;
        }
        env[name] = text;
    }
    return env;
}
/** The parked step in `text`, or undefined when it is not one. */
export function parseParked(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value) || value['v'] !== PARKED_FORMAT) {
        return undefined;
    }
    const record = value;
    const [id, team, session, what, log, cwd, parkedAt] = ['id', 'team', 'session', 'what', 'log', 'cwd', 'parkedAt'].map((key) => stringField(record, key));
    const argv = record['argv'];
    const env = envOf(record['env']);
    if (id === undefined || team === undefined || session === undefined || what === undefined || log === undefined || cwd === undefined || parkedAt === undefined || !isStringArray(argv) || env === undefined) {
        return undefined;
    }
    return { v: PARKED_FORMAT, id, team, session, what, log, argv, cwd, env, parkedAt };
}
/** Parks a step in the parked folder `dir`: written whole (write then rename), so a dispatcher never reads half of it. */
export async function park(files, dir, step) {
    const path = parkedPathOf(dir, step.id);
    await files.write(path, formatParked(step));
    return path;
}
/**
 * Whether the parked folder `dir` holds a step of any team, so a dispatcher is still needed. `skip` holds the paths a
 * dispatcher already found are no step (`claimParked`'s unreadable): they would keep it running with nothing to run.
 */
export async function hasParked(files, dir, skip = new Set()) {
    return (await files.list(dir)).some((name) => name.endsWith(PARKED_SUFFIX) && !isTemporaryName(name) && !skip.has(join(dir, name)));
}
/**
 * Takes every parked step in `dir`, oldest first: each is read, then removed, and only a step whose removal this
 * call made is taken, so of two dispatchers that both read one, only one runs it. A file that is no parked step is
 * left and named, for the caller to report, never run.
 */
export async function claimParked(files, dir) {
    const steps = [];
    const unreadable = [];
    for (const name of (await files.list(dir)).sort()) {
        if (!name.endsWith(PARKED_SUFFIX) || isTemporaryName(name)) {
            continue;
        }
        const path = join(dir, name);
        const text = await files.read(path);
        if (text === undefined) {
            continue;
        }
        const step = parseParked(text);
        if (step === undefined) {
            unreadable.push(path);
            continue;
        }
        if (await files.remove(path)) {
            steps.push(step);
        }
    }
    return { steps: steps.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt)), unreadable };
}
