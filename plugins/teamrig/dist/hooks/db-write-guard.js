import { DEFAULT_DB_WRITE_GUARD } from "../config/defaults.js";
import { toolCommandReadings } from "../core/bash-tool-readings.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
import { dbWritesOf, describeDbWrite } from "../db-write-guard/writes.js";
import { holdBackOutput } from "./permission.js";
/** What a hand-run write gets. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function dbWriteGuardOf(load) {
    return load?.status === 'loaded' ? load.config.dbWriteGuard : DEFAULT_DB_WRITE_GUARD;
}
/** Why the line is refused or asked about: each write it makes, and the read-only step to show the owner first. */
export function dbWriteReason(writes) {
    const named = writes.map(describeDbWrite).join('; ');
    const preview = writes.some((write) => write.entrypoint)
        ? 'run it without its apply flag (its dry run)'
        : 'run a count or find of what it would change';
    return (`teamrig db-write guard: this line writes to a database by hand: ${named}. First ${preview}, show the owner the ` +
        "counts or a preview, and run the write only with the owner's OK. [dbWriteGuard.writes]");
}
/**
 * The PreToolUse output for a Bash or PowerShell call: a question (or a refusal, as `dbWriteGuard.writes` says) when
 * the line writes to a database by hand, through a built-in SQL client, a database program the team names, Node code
 * using a client module the team names, or a team entrypoint run with an apply flag; else nothing, so the normal
 * permission flow decides. Under `hookAsks: refuse` the question is a refusal instead, its reason saying what to do.
 * A Bash line on Windows is read in each text bash may run (`toolCommandReadings`), naming each write once.
 */
export async function dbWriteGuardOutput(payload, env) {
    const decision = env.writes;
    if (decision === 'allow' || !isRecord(payload)) {
        return '';
    }
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    if (command === undefined) {
        return '';
    }
    const tool = stringField(payload, 'tool_name');
    const context = {
        cwd: stringField(payload, 'cwd') ?? env.cwd,
        home: env.home,
        dialect: tool === 'PowerShell' ? 'powershell' : 'bash',
        files: env.files,
        rules: { entrypoints: env.entrypoints, programs: env.programs, nodeClients: env.nodeClients, clientReceivers: env.clientReceivers },
    };
    const readings = toolCommandReadings(tool, command, env.platform);
    const writes = uniqueWrites((await Promise.all(readings.map((text) => dbWritesOf(text, context)))).flat());
    return writes.length === 0 ? '' : holdBackOutput(decision, dbWriteReason(writes), env.hookAsks);
}
/** Each write once, in the order first found: a write both readings of a line make is named once. */
function uniqueWrites(writes) {
    const seen = new Set();
    return writes.filter((write) => {
        const phrase = describeDbWrite(write);
        if (seen.has(phrase)) {
            return false;
        }
        seen.add(phrase);
        return true;
    });
}
