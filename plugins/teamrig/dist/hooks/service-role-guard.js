import { posix, win32 } from 'node:path';
import { toolCommandReadings } from "../core/bash-tool-readings.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
import { opaqueGuardedWords, runsOfReadings, teamrigLaunchOf } from "./exec-guard.js";
import { holdBackOutput, refusalOutput } from "./permission.js";
/**
 * The service-role guard (T2984, security condition C2): a service role lets its holders run a few teamrig commands
 * past every permission check, so who holds one is a permission, an owner gate. A session's `teamrig roles grant` or
 * `revoke` therefore always asks the owner, whatever `--yes` says (refused when asks are off), and the route allow
 * never lets one through, as it allows only what every guard passed. A session's own write of an owner-gated key
 * (OWNER_GATED_KEYS: `serviceRoles`, the roles, the guards and allow rules, the commands teamrig runs; T3083)
 * is refused: a file tool whose result changes one in the team config, or cannot be read, and a shell line
 * naming the team config file at all, since a shell line's writes cannot be told from its reads (the Read tool stays
 * open). The config's other keys stay a session's to edit. Like
 * the pass-record guard it reads only the call: a script the session writes and starts still reaches the file, as
 * sessions and the owner share one account (stopgap T791). A teamrig call whose subcommand is only known when it runs,
 * and a shell fed by a pipe, are the exec guard's to refuse.
 */
/**
 * The team config keys only the owner changes, by path: each is a permission or an owner gate (core rule 6). Who
 * holds a role or a service role; what is owner- or security-gated; who the owner is in the register; the asks, route
 * and read-only allow rules; the exec review; the alerts; whose GitHub logins count as ours; the guards; and each
 * repository's merge, deploy and check commands, which teamrig runs with the full environment.
 */
export const OWNER_GATED_KEYS = [
    ['serviceRoles'],
    ['roles'],
    ['ownerGates'],
    ['securityGates'],
    ['register', 'ownerSource'],
    ['prompts'],
    ['readonlyShell'],
    ['exec'],
    ['alerts'],
    ['github', 'owners'],
    ['delivery', 'repos'],
    ['delivery', 'passEnv'],
    ['permissions'],
    ['pushGuard'],
    ['secretGuard'],
    ['packageGuard'],
    ['dbWriteGuard'],
    ['commitGuard'],
];
/** The `teamrig roles` commands that change who holds a role. */
export const ROLE_CHANGES = new Set(['grant', 'revoke']);
/** The file tools, by the input field naming the file they write. */
const FILE_WRITERS = new Map([
    ['Write', 'file_path'],
    ['Edit', 'file_path'],
    ['MultiEdit', 'file_path'],
    ['NotebookEdit', 'notebook_path'],
]);
const SHELLS = new Set(['Bash', 'PowerShell']);
/** A team config path in a line: `teams/<team>/config.json`, any slash, a glob or variable as the team too. */
const TEAM_CONFIG_TAIL = /teams[\\/]+[^\s\\/'"]+[\\/]+config\.json(?![\w.-])/i;
/** `config.json` as a file name of its own: not `tsconfig.json` or `config.json5`. */
const CONFIG_FILE_WORD = /(?<![\w.-])config\.json(?![\w.-])/i;
/** A line reaching into the kit home: its folder, or the variable that moves it. */
const KIT_HOME_WORD = /(?<![\w-])\.teamrig(?![\w-])|TEAMRIG_HOME/i;
/** True when the words run `roles grant` or `roles revoke`, or a `roles` command only known when it runs. */
function startsRoleChange(words) {
    const [group, action] = words;
    return group !== undefined && !group.dynamic && group.text === 'roles' && action !== undefined && (action.dynamic || ROLE_CHANGES.has(action.text));
}
/** A path as the platform compares it: absolute against the folder, one slash, any case on Windows. */
function samePathKey(path, cwd, platform) {
    return platform === 'win32' ? win32.resolve(cwd, path).replaceAll('\\', '/').toLowerCase() : posix.resolve(cwd, path);
}
/** The kit home a team config sits in: `<home>/teams/<team>/config.json`. */
function kitHomeOf(configPath, platform) {
    const path = platform === 'win32' ? win32 : posix;
    return path.dirname(path.dirname(path.dirname(configPath)));
}
/** A Git Bash drive path's head, `/c/`, which Windows tools read as the drive `c:/`. */
const MSYS_DRIVE = /^\/([a-z])(?=\/)/i;
/** A team config by its tail, `teams/<team>/config.json`, on a path in its compare form (one slash kind). */
const TEAM_CONFIG_FILE = /(?:^|\/)teams\/+[^/]+\/+config\.json$/i;
/**
 * The absolute path of the team config a file tool's path names, or undefined for another file (T3083). Any team's
 * config counts, not only the session's own, as each team's guards read their own; it is told by the same tail the
 * shell check uses, so the kit home's spelling (a Git Bash `/c/` drive, a `\\?\` long path) cannot hide it, and a
 * session with no team config of its own is still held to it.
 */
function teamConfigTarget(target, cwd, platform, configPath) {
    const native = platform === 'win32' ? target.replace(MSYS_DRIVE, '$1:') : target;
    const key = samePathKey(native, cwd, platform);
    if (configPath !== undefined && key === samePathKey(configPath, cwd, platform)) {
        return configPath;
    }
    return TEAM_CONFIG_FILE.test(key) ? (platform === 'win32' ? win32 : posix).resolve(cwd, native) : undefined;
}
/** The config text as JSON, or undefined when there is none or it is no JSON object. */
function configOf(text) {
    if (text === undefined) {
        return undefined;
    }
    try {
        const raw = JSON.parse(text);
        return isRecord(raw) ? raw : undefined;
    }
    catch {
        return undefined;
    }
}
/** A key's value as text to compare, `null` when the config or any step of the path lacks it. */
function valueAt(config, keyPath) {
    let at = config;
    for (const step of keyPath) {
        at = isRecord(at) ? at[step] : undefined;
    }
    return JSON.stringify(at ?? null);
}
/** The owner-gated keys whose value differs between two config texts, dotted. */
export function changedGatedKeys(before, after) {
    const [old, next] = [configOf(before), configOf(after)];
    return OWNER_GATED_KEYS.filter((keyPath) => valueAt(old, keyPath) !== valueAt(next, keyPath)).map((keyPath) => keyPath.join('.'));
}
function replacementOf(input) {
    const from = stringField(input, 'old_string');
    const to = stringField(input, 'new_string');
    return from === undefined || to === undefined ? undefined : { from, to, all: input['replace_all'] === true };
}
/** The text after the replacements, or undefined when one finds nothing to replace, so the guard cannot tell the result. */
function replaced(text, replacements) {
    let next = text;
    for (const { from, to, all } of replacements) {
        if (from === '' || !next.includes(from)) {
            return undefined;
        }
        next = all ? next.split(from).join(to) : next.replace(from, () => to);
    }
    return next;
}
/** The config's text after a file tool's call, or undefined when the guard cannot work it out. */
function nextText(tool, input, current) {
    if (tool === 'Write') {
        return stringField(input, 'content');
    }
    if (tool === 'Edit') {
        const one = replacementOf(input);
        return one === undefined || current === undefined ? undefined : replaced(current, [one]);
    }
    if (tool === 'MultiEdit') {
        const edits = input['edits'];
        if (!Array.isArray(edits) || current === undefined) {
            return undefined;
        }
        const each = edits.map((edit) => (isRecord(edit) ? replacementOf(edit) : undefined));
        return each.every((edit) => edit !== undefined) ? replaced(current, each.filter((edit) => edit !== undefined)) : undefined;
    }
    return undefined;
}
/** Why a file tool's call on the team config is refused, or undefined when it leaves every owner-gated key as it is. */
async function fileRefusal(tool, input, path, configFile, env) {
    const current = await env.readConfig(configFile);
    const next = nextText(tool, input, current);
    if (next === undefined) {
        return `this ${tool} of the team config (${path}) cannot be read as a change of its text, so the guard cannot tell whether it changes an owner-gated key`;
    }
    const changed = changedGatedKeys(current, next);
    return changed.length === 0 ? undefined : `this ${tool} changes ${changed.join(', ')} in the team config (${path})`;
}
/** True when the shell line names the team config file. */
function namesTeamConfig(command, cwd, env, configPath) {
    if (TEAM_CONFIG_TAIL.test(command)) {
        return true;
    }
    if (!CONFIG_FILE_WORD.test(command)) {
        return false;
    }
    const home = samePathKey(kitHomeOf(configPath, env.platform), env.cwd, env.platform);
    const here = samePathKey(cwd, env.cwd, env.platform);
    return KIT_HOME_WORD.test(command) || here === home || here.startsWith(`${home}/`);
}
const ROLE_CHANGE_ASK = 'teamrig service-role guard: `teamrig roles grant` and `revoke` change who may run a service role\'s commands past ' +
    'every permission check, a permission only the owner gives, so teamrig asks the owner at each session\'s call, ' +
    'whatever --yes says. Owner: allow it only if you asked for this change. A session does not retry it or route ' +
    'around it: the lead puts the change to the owner, who runs it from their own terminal or prompt.';
function editRefusalOf(reach) {
    return (`teamrig config guard: ${reach}. Its owner-gated keys (${OWNER_GATED_KEYS.map((keyPath) => keyPath.join('.')).join(', ')}) ` +
        'are permissions or owner gates, the owner\'s to change: a service role\'s holders with `teamrig roles grant` or ' +
        '`revoke`, which ask the owner, the rest in the owner\'s own editor. Change the config\'s other keys without touching ' +
        'them, read it with the Read tool, and do not retry this or route around it: the lead puts the change to the owner.');
}
/**
 * The PreToolUse output for a Bash, PowerShell or file tool call: a refusal when it writes an owner-gated key or may (a
 * file tool on the team config, a shell line naming it), else an ask when it runs `teamrig roles grant` or `revoke`
 * through any client, else nothing, so the normal permission flow decides.
 */
export async function serviceRoleGuardOutput(payload, env) {
    if (!isRecord(payload)) {
        return '';
    }
    const tool = stringField(payload, 'tool_name') ?? '';
    const input = recordField(payload, 'tool_input') ?? {};
    const cwd = stringField(payload, 'cwd') ?? env.cwd;
    const field = FILE_WRITERS.get(tool);
    if (field !== undefined) {
        const path = stringField(input, field);
        if (path === undefined) {
            return '';
        }
        const configFile = teamConfigTarget(path, cwd, env.platform, env.configPath);
        if (configFile === undefined) {
            return '';
        }
        const reach = await fileRefusal(tool, input, path, configFile, env);
        return reach === undefined ? '' : refusalOutput(editRefusalOf(reach));
    }
    const command = stringField(input, 'command');
    if (!SHELLS.has(tool) || command === undefined) {
        return '';
    }
    if (env.configPath !== undefined && namesTeamConfig(command, cwd, env, env.configPath)) {
        return refusalOutput(editRefusalOf(`this ${tool} line names the team config file, and a shell line's writes cannot be told from its reads`));
    }
    const context = { cwd, home: env.home, dialect: tool === 'PowerShell' ? 'powershell' : 'bash' };
    const runs = runsOfReadings(toolCommandReadings(tool, command, env.platform), context);
    const changes = runs.programs.some((run) => {
        const launch = teamrigLaunchOf(run, startsRoleChange);
        return launch !== undefined && startsRoleChange(launch.words);
    }) || runs.opaque.some((run) => opaqueGuardedWords(run, startsRoleChange) !== undefined);
    return changes ? holdBackOutput('ask', ROLE_CHANGE_ASK, env.hookAsks) : '';
}
