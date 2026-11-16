import { toolCommandReadings } from "../core/bash-tool-readings.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
import { ENV } from "../core/home.js";
import { SETTINGS_WRITERS, settingsWriteRefusal, WRITE_SWITCH } from "../core/settings-writers.js";
import { placeProgram, placeScript } from "../exec/client-launch.js";
import { PACKAGE_STARTERS } from "../package-guard/packaged.js";
import { runsOf } from "../package-guard/programs.js";
import { programName } from "../push-guard/launchers.js";
import { holdBackOutput } from "./permission.js";
import { changesVariable } from "./variable-change.js";
/**
 * The exec guard (T755, spec §7): an agent tab may run a `teamrig exec` review (approve, refuse, escalate) only as
 * itself. The allow line `Bash(teamrig exec *)` lets every exec command through unasked, and the CLI takes the
 * reviewer from `--session`, self-declared, so without this guard any tab could approve its own request as the
 * security reviewer or the owner. The owner never reviews through a tool call: they review in their own terminal, or
 * type `/teamrig exec approve R<n> --session <owner>` in a tab, which the mod runs without a PreToolUse hook. A teamrig
 * call with a word only known when it runs that decides whether it reviews, or as whom, is refused: its subcommand
 * too (`teamrig "$G" approve R1`, or `f(){ teamrig "$@"; }; f exec approve ...`), as reviews are not signed (T1780).
 * So is a line whose shell takes its commands from a pipe (`echo ... | bash`, `... | iex`), whatever feeds it, as a
 * pipe can carry a review the line never shows (T1855); a heredoc it reads is judged as written.
 *
 * It also pins the client (spec §2.2, phase 1): every `teamrig exec` call, whatever its command, runs only through an
 * install of this plugin whose files are the ones its build hashed, as phase 1 runs an approved request inside that
 * client. The guard places the file a call starts as its shell would (T803): a path the line writes, or the first
 * `teamrig` the shell's PATH search finds, where a `~/bin/teamrig` wins over the plugin bin the Bash tool appends
 * last; a call through a program only known when it runs (`$T exec ...`) is refused, as no file can be checked.
 *
 * It refuses every `teamrig owner` call too (T1298): `owner note`, `owner next` and `owner wake` write or wake as the
 * owner (register.ownerSource) whoever runs them, so only the owner's own routes run them: the pane, their own terminal, or
 * `/teamrig owner ...` typed in a tab, which the mod runs as a write only when the person types it. Like the review
 * check, it reads only a Bash or PowerShell tool call: a script the agent writes that starts the CLI is no such call.
 *
 * And it refuses every `teamrig hook <name>` call (T3081): a hook takes who it runs for, and which tab, from the
 * stdin whoever runs it writes, so only Claude Code's hooks and the teamrig mod run them; a hook is proved in a test,
 * or by a script on a scratch kit home.
 */
/** The `teamrig exec` commands that decide a request. */
export const REVIEW_ACTIONS = new Set(['approve', 'refuse', 'escalate']);
/** Every `teamrig exec` command, by which a call through an unknown program reads as a teamrig call, not as `docker exec`. */
export const EXEC_COMMANDS = new Set(['request', 'dry-run', ...REVIEW_ACTIONS, 'run', 'status']);
/** Every `teamrig owner` command, by which a call through an unknown program reads as a teamrig call. */
export const OWNER_COMMANDS = new Set(['note', 'next', 'wake']);
/** Every `teamrig hook` command, by which a call through an unknown program reads as a teamrig call, not as `git hook run`. */
export const HOOK_COMMANDS = new Set([
    'clear-claim',
    'clear-dir',
    'cold-send',
    'compact-check',
    'db-write-guard',
    'effort-writeback',
    'exec-guard',
    'failed-send',
    'helper-gate',
    'inbox-reminder',
    'loop-nudge',
    'meeting-due',
    'meeting-panel',
    'missing-cli',
    'needs-you',
    'needs-you-focus',
    'package-guard',
    'pass-record-guard',
    'picker-guard',
    'pre-compact',
    'prompt-refuse',
    'push-guard',
    'readonly-allow',
    'refresh-mid',
    'refresh-wake',
    'restore-track',
    'route-allow',
    'route-reminder',
    'secret-guard',
    'secret-redact',
    'service-role-guard',
    'session-start',
    'slash-command',
    'stop',
    'subagent-start',
    'subagent-stop',
    'tab-status',
    'tool-end',
    'update-apply',
    'update-check',
    'update-dismiss',
    'wake-check',
    'wake-dropped',
]);
/**
 * teamrig's entry scripts when a line runs one, through node or any other script host (`tsx`, `bun`, `npx tsx`): the
 * CLI (`<plugin>/dist/cli/main.js exec ...`) and the guard entry beside it (`cli/guard-main.js`), which hands its words
 * to the same CLI (T3069). The extension is optional, as Node finds `cli/main` as `cli/main.js` (T3069).
 */
const CLI_ENTRY = /[\\/]cli[\\/](?:guard-)?main(?:\.[cm]?[jt]s)?$/i;
/** A word that names the teamrig CLI, a package runner's version spec included: `teamrig`, `teamrig@latest`. */
const TEAMRIG_SPEC = /^teamrig(?:@[^\\/]*)?$/;
/** True when the words a program only known when it runs takes read as a command of the teamrig group: `exec approve`, `exec "$CMD"`. */
export function startsGroup(words, name, commands) {
    const [group, command] = words;
    return group !== undefined && !group.dynamic && group.text === name && command !== undefined && (command.dynamic || commands.has(command.text));
}
/** True when the words read as a teamrig exec command. */
function startsExec(words) {
    return startsGroup(words, 'exec', EXEC_COMMANDS);
}
/** True when the words read as a teamrig owner command. */
function startsOwner(words) {
    return startsGroup(words, 'owner', OWNER_COMMANDS);
}
/**
 * The settings writer the words write with, or undefined when they run none or only its preview: its group, an action
 * of it or one only known when it runs, and `--yes` or a word only known when it runs after them.
 */
function settingsWriteOf(words) {
    const [group, action, ...tail] = words;
    const actions = group === undefined || group.dynamic ? undefined : SETTINGS_WRITERS.get(group.text);
    if (group === undefined || actions === undefined || action === undefined || !(action.dynamic || actions.has(action.text))) {
        return undefined;
    }
    const writes = tail.some((word) => word.dynamic || word.text === `--${WRITE_SWITCH}`);
    return writes ? (action.dynamic ? group.text : `${group.text} ${action.text}`) : undefined;
}
/** True when the words read as a settings writer's write. */
function writesSettings(words) {
    return settingsWriteOf(words) !== undefined;
}
/** True when the words read as a teamrig hook command. */
function startsHook(words) {
    return startsGroup(words, 'hook', HOOK_COMMANDS);
}
/** True when the words read as a command this guard checks, so a call through node and a script only known when it runs is one. */
function startsGuarded(words) {
    return startsExec(words) || startsOwner(words) || writesSettings(words) || startsHook(words);
}
/** The command of `group` the words name after it, or undefined when they name none the CLI has, or one only known when it runs. */
function commandOf(words, commands) {
    const command = words[1];
    return command === undefined || command.dynamic || !commands.has(command.text) ? undefined : command.text;
}
/** The owner command the words name after `owner`. */
function ownerActionOf(words) {
    return commandOf(words, OWNER_COMMANDS);
}
/** The hook the words name after `hook`. */
function hookNameOf(words) {
    return commandOf(words, HOOK_COMMANDS);
}
/**
 * True when the words start a command that binds the tab to a session, `start` or `inbox read`: the CLI marks the
 * tab with the session it names, by `--session` or `$TEAMRIG_SESSION`. It finds them after any program's words.
 */
function startsBind(words) {
    const [group, command] = words;
    return group?.dynamic === false && (group.text === 'start' || (group.text === 'inbox' && command?.dynamic === false && command.text === 'read'));
}
/**
 * The bind call a teamrig call's words run, read as the CLI reads them (only `--session <name>` names a session), or
 * undefined when they run none. An `inbox` command only known when it runs may be `read`, so it counts as one.
 */
function bindCallOf(words) {
    const [group, command] = words;
    const start = group?.dynamic === false && group.text === 'start';
    const inbox = group?.dynamic === false && group.text === 'inbox' && command !== undefined && (command.dynamic || command.text === 'read');
    if (!start && !inbox) {
        return undefined;
    }
    const sessions = words.flatMap((word, index) => {
        const value = words[index + 1];
        return word.text === '--session' && value !== undefined ? [value.text] : [];
    });
    return { command: start ? 'teamrig start' : 'teamrig inbox read', sessions, unread: words.some((word) => word.dynamic) };
}
/**
 * Why the guard refuses a bind call from a bound tab, or undefined when it binds the tab to its own session (T3081):
 * a tab reads its inbox and starts only as itself, so a tool call can never move it to another session, whichever
 * client runs it. `steered` is true when the line changes a variable the CLI binds by (`$TEAMRIG_SESSION`, the Claude
 * Code session id). A tab no mark binds yet binds freely: that is how it first binds.
 */
function bindRefusalOf(call, identity, steered) {
    if (identity.kind === 'unbound') {
        return undefined;
    }
    const command = `\`${call.command}\``;
    const own = `--session ${identity.session}`;
    if (call.unread) {
        return `${command} here has a word only known when it runs, so the guard cannot tell which session it binds this tab to; write it out (${own}).`;
    }
    const other = call.sessions.find((named) => {
        const id = identity.idOf(named);
        return id !== undefined && id !== identity.session;
    });
    if (other !== undefined) {
        return `${command} names --session ${other}, but this tab is ${identity.session}'s; a tab reads its inbox and starts only as its own session (${own}).`;
    }
    if (steered) {
        return `${command} runs on a line that sets the session the CLI binds the tab by ($${ENV.session} or $${ENV.claudeSession}); name this tab's own (${own}) and leave those as they are.`;
    }
    return undefined;
}
/**
 * Where a command `guarded` reads starts in a command's words, given as its program word and arguments, from the
 * argument `from` on (T3069): any program may be the CLI, so a renamed copy (`./x exec approve`), a script of any
 * name (`node C:/tmp/x.js exec approve`) or a package of any name (`npx git+https://... exec status`) is a call. A
 * command written out only when the word naming the client is the teamrig CLI or only known when it runs, so
 * `kubectl exec "$POD"` and `docker compose exec "$SERVICE"` are none; a renamed copy given a command only known when
 * it runs goes unread.
 */
function guardedStartOf(program, args, from, guarded) {
    const all = [program, ...args];
    for (let index = from + 1; index < all.length; index += 1) {
        const client = all[index - 1];
        const words = all.slice(index);
        const writtenOut = words[1]?.dynamic === false;
        if (client !== undefined && guarded(words) && (writtenOut || client.dynamic || TEAMRIG_SPEC.test(programName(client.text)))) {
            return { client, words, own: index === 1 };
        }
    }
    return undefined;
}
/** The guarded command's words in a command whose program is only known when it runs, anywhere they start (T3069). */
export function opaqueGuardedWords(run, guarded) {
    return guardedStartOf(run.program, run.args, 0, guarded)?.words;
}
/**
 * How a run starts the teamrig CLI, or undefined when it does not: by name; by any program and teamrig's entry script;
 * or by any program, its words read from wherever a command `guarded` reads starts (`guardedStartOf`). A package
 * runner or a version manager, or a program one starts, finds its program on a PATH of its own or fetches it (`npx
 * teamrig`, `npx -c "teamrig ..."`, `volta run teamrig`), so its teamrig may be no install of this plugin (T3069):
 * its client is the runner.
 */
export function teamrigLaunchOf(run, guarded) {
    const starter = PACKAGE_STARTERS.has(run.name) ? run.program : undefined;
    const runner = run.packageRunner ?? starter;
    if (run.name === 'teamrig' || run.name === 'teamrig.ps1') {
        return { client: runner === undefined ? { kind: 'program', word: run.program } : { kind: 'runner', word: runner }, words: run.args };
    }
    const entry = run.args.findIndex((word) => CLI_ENTRY.test(word.text));
    const script = entry === -1 ? undefined : run.args[entry];
    if (script !== undefined) {
        return { client: { kind: script.dynamic ? 'opaque' : 'script', word: script }, words: run.args.slice(entry + 1) };
    }
    // A runner's own first words are its subcommand (`npm exec "$X"`), never a CLI call.
    const start = guardedStartOf(run.program, run.args, starter === undefined ? 0 : 1, guarded);
    if (start === undefined) {
        return undefined;
    }
    if (start.client.dynamic) {
        return { client: { kind: 'opaque', word: start.client }, words: start.words };
    }
    if (runner !== undefined) {
        return { client: { kind: 'runner', word: runner }, words: start.words };
    }
    return { client: { kind: start.own ? 'program' : 'script', word: start.client }, words: start.words };
}
/** True for a teamrig call whose subcommand is only known when it runs (`teamrig "$G" approve R1`), which the walker leaves unread. */
export function hidesSubcommand(run) {
    return !run.program.dynamic && programName(run.program.text) === 'teamrig';
}
/**
 * The guarded call the words run, read as the CLI reads them (src/cli/args.ts): the first two words are the command,
 * and each flag of a review takes the word after it as its value. Undefined when they run no `teamrig exec`,
 * `teamrig owner` or `teamrig hook` command.
 */
function guardedCallOf(words) {
    const [group, action] = words;
    if (group === undefined) {
        return undefined;
    }
    if (group.dynamic) {
        return { kind: 'unreadable' };
    }
    if (group.text === 'owner') {
        return { kind: 'owner', action: ownerActionOf(words) };
    }
    const settings = settingsWriteOf(words);
    if (settings !== undefined) {
        return { kind: 'settings', command: settings };
    }
    if (group.text === 'hook') {
        return { kind: 'hook', name: hookNameOf(words) };
    }
    if (group.text !== 'exec') {
        return undefined;
    }
    if (action === undefined) {
        return { kind: 'plain' };
    }
    if (action.dynamic) {
        return { kind: 'unreadable' };
    }
    if (!REVIEW_ACTIONS.has(action.text)) {
        return { kind: 'plain' };
    }
    const tail = words.slice(2);
    if (tail.some((word) => word.dynamic)) {
        return { kind: 'unreadable' };
    }
    const sessions = [];
    for (let index = 0; index < tail.length; index += 1) {
        const token = tail[index]?.text ?? '';
        if (!token.startsWith('--')) {
            continue;
        }
        const value = tail[index + 1];
        if (token === '--session' && value !== undefined) {
            sessions.push(value.text);
        }
        index += 1;
    }
    return { kind: 'review', action: action.text, sessions };
}
const UNREADABLE = 'a teamrig call here has a word only known when it runs (a variable or a substitution), so the guard cannot tell whether it reviews a request, or as whom; write the words out.';
const FED_SHELL = 'a shell here reads its commands from a pipe, so the guard cannot tell whether they review a request or act as the owner; run them directly, or hand the shell a heredoc, which the guard reads.';
const CLAUDE_CODE_CHANGED = `this line changes $${ENV.claudeCode}, which Claude Code sets so teamrig knows a command runs under it and keeps the checks that hold there; leave it as Claude Code set it.`;
const FOREIGN_SHELL = 'a package runner here hands its command line to a shell the line names (--script-shell, npm_config_script_shell or ComSpec) that the guard cannot read, so it cannot tell whether the line reviews a request or acts as the owner; leave the runner its own shell, or run the commands directly.';
/** At most this many changed files are named in a refusal; the rest are counted. */
const NAMED_FILES = 5;
/** Where the plugin's own client is, for a refusal to name: `<install>/bin/teamrig`. */
function ownClientOf(installs) {
    return `${installs.install}/bin/teamrig`;
}
/** Why the guard refuses an exec call through the install at `root`, or undefined when its files are the ones the build hashed. */
function clientRefusalOf(check, root, installs) {
    const own = installs.isOwn(root);
    const client = own ? 'the teamrig client' : `the teamrig client at ${root}`;
    const fix = own ? 'reinstall the teamrig plugin or ask security.' : `run the plugin's own (${ownClientOf(installs)}), or ask security.`;
    switch (check.kind) {
        case 'intact':
            return undefined;
        case 'no-manifest':
            return `${client} cannot be checked against its build (${check.why}), so it may have been changed; ${fix}`;
        case 'changed': {
            const more = check.paths.length > NAMED_FILES ? ` and ${check.paths.length - NAMED_FILES} more` : '';
            return `${client} was changed after its build (${check.paths.slice(0, NAMED_FILES).join(', ')}${more}); ${fix}`;
        }
    }
}
/** Why the guard refuses a client file that is no install of this plugin. */
function foreignRefusalOf(file, installs) {
    const own = ownClientOf(installs);
    return file.by === 'found'
        ? `the \`teamrig\` this line's shell finds on PATH is ${file.path}, no install of the teamrig plugin; remove it from PATH, or run the plugin's own (${own}).`
        : `\`teamrig exec\` here starts ${file.path}, no install of the teamrig plugin; run the plugin's own (${own}).`;
}
/** Why the guard refuses a `teamrig owner` call: the routes the owner runs it by. */
function ownerRefusalOf(action) {
    const command = action === undefined ? 'teamrig owner' : `teamrig owner ${action}`;
    return `\`${command}\` acts as the owner; the owner runs it from the pane or their own terminal, or types \`/${command} ...\` in a tab, never through a tool call.`;
}
/** Why the guard refuses a `teamrig hook` call: only Claude Code and the teamrig mod run hooks. */
function hookRefusalOf(name) {
    const command = name === undefined ? 'teamrig hook' : `teamrig hook ${name}`;
    return (`\`${command}\` takes the tab and who typed the line from its stdin, which a tool call writes, so only Claude Code's hooks ` +
        `and the teamrig mod run it, never a tool call; prove a hook in a test, or by a script on a scratch kit home.`);
}
/** Why the guard refuses a call through a program only known when it runs. */
function opaqueRefusalOf(word) {
    return `\`teamrig exec\` here starts a program only known when it runs (${word.text}), so the guard cannot tell which client runs it; write it out: \`teamrig\`, or its full path.`;
}
/** The install a call's client word starts, placed as the line's shell places it. */
async function clientRootOf(client, at, env) {
    if (client.kind === 'opaque') {
        return { kind: 'refused', why: opaqueRefusalOf(client.word) };
    }
    if (client.kind === 'runner') {
        return {
            kind: 'refused',
            why: `\`teamrig exec\` here runs through a package runner (${client.word.text}), which may find or fetch a teamrig other than this plugin's install; write \`teamrig\`, or its full path.`,
        };
    }
    const file = client.kind === 'program' ? await placeProgram(client.word.text, at, env.search) : placeScript(client.word.text, at);
    switch (file.kind) {
        case 'appended':
            return { kind: 'root', root: env.installs.install };
        case 'unplaced':
            return {
                kind: 'refused',
                why: `a teamrig call here starts its client by a relative path (${client.word.text}) from a folder only known when the line runs; write its full path.`,
            };
        case 'file': {
            const root = env.installs.rootOf(file.path);
            return root === undefined ? { kind: 'refused', why: foreignRefusalOf(file, env.installs) } : { kind: 'root', root };
        }
    }
}
/** Why the guard refuses a review, or undefined when it runs as the tab's own session. */
function reviewRefusalOf(call, identity) {
    const command = `\`teamrig exec ${call.action}\``;
    if (identity.kind === 'unbound') {
        return `${command} reviews a request, and ${identity.why}, so the guard cannot tell who reviews.`;
    }
    const own = `--session ${identity.session}`;
    const [named, twice] = call.sessions;
    if (named === undefined) {
        return `${command} names no --session; name this tab's own (${own}): $TEAMRIG_SESSION cannot show who runs the line.`;
    }
    if (twice !== undefined) {
        return `${command} names --session more than once; name this tab's own once (${own}).`;
    }
    if (named === identity.owner) {
        return (`${command} names the owner (--session ${named}); the owner reviews in their own terminal, or types ` +
            `\`/teamrig exec ${call.action} R<n> --session ${named}\` in a tab, never through a tool call.`);
    }
    const id = identity.idOf(named);
    if (id === undefined) {
        return `${command} names --session ${named}, no session of the team; a session reviews only as itself (${own}).`;
    }
    return id === identity.session ? undefined : `${command} names --session ${named}, but this tab is ${identity.session}'s; a session reviews only as itself (${own}).`;
}
/**
 * What every reading of a tool call runs, reading after reading. Joining them is safe, unlike the push guard's
 * checkouts: each run carries its own folder and shell, and the guard refuses a run whatever else the line runs.
 */
export function runsOfReadings(readings, context) {
    const each = readings.map((text) => runsOf(text, context));
    return {
        programs: each.flatMap((runs) => runs.programs),
        bare: each.flatMap((runs) => runs.bare),
        opaque: each.flatMap((runs) => runs.opaque),
        fedShells: each.flatMap((runs) => runs.fedShells),
        foreignShells: each.flatMap((runs) => runs.foreignShells),
        envEdits: each.flatMap((runs) => runs.envEdits),
    };
}
/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal when the line runs a `teamrig exec` review as anyone
 * but the tab's own session, named by `--session` (the flag wins over `$TEAMRIG_SESSION` in the CLI, so a variable
 * set on the line changes nothing), when the guard cannot read who it reviews as, or when it runs any `teamrig exec`
 * command through a client that is no install of this plugin, one only known when it runs, or one whose files differ
 * from its build; whenever the line runs a `teamrig owner` command, through any client, as it acts as the owner, or a
 * settings writer's write (`permissions trim --yes` and the rest of SETTINGS_WRITERS), as it changes a permission, or
 * a `teamrig hook` command, as it trusts the stdin the line gives it; whenever a bound tab's `teamrig start` or `teamrig
 * inbox read`, through any client, binds it to another session (`bindRefusalOf`); whenever the line changes
 * `$CLAUDECODE`, which tells teamrig a command runs under Claude Code; and when a shell on the line takes its commands
 * from a pipe the guard cannot read, or a package runner hands its line to a shell the line names that the guard
 * cannot read. Else nothing, so the normal permission flow decides. It checks each install a line's `teamrig exec`
 * calls start once, and reads the tab's session only for a line that holds a review, or a bind that names a session
 * or runs where the line changes one. A Bash line on Windows is read in each reading bash may run
 * (`toolCommandReadings`), so a call the line as written escapes is still refused. It reads only the line's own words:
 * a script the line runs is not covered, so these are checks against mistakes.
 */
export async function execGuardOutput(payload, env) {
    if (!isRecord(payload)) {
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
    };
    const runs = runsOfReadings(toolCommandReadings(tool, command, env.platform), context);
    const calls = runs.programs.flatMap((run) => {
        const launch = teamrigLaunchOf(run, startsGuarded);
        const call = launch === undefined ? undefined : guardedCallOf(launch.words);
        const at = { dialect: run.dialect, dir: run.dir, home: env.home };
        return launch === undefined || call === undefined ? [] : [{ call, client: launch.client, at }];
    });
    const opaque = runs.opaque.filter((run) => opaqueGuardedWords(run, startsExec) !== undefined);
    const opaqueOwner = runs.opaque.flatMap((run) => {
        const words = opaqueGuardedWords(run, startsOwner);
        return words === undefined ? [] : [words];
    });
    const opaqueSettings = runs.opaque.flatMap((run) => settingsWriteOf(opaqueGuardedWords(run, writesSettings) ?? []) ?? []);
    const opaqueHook = runs.opaque.flatMap((run) => {
        const words = opaqueGuardedWords(run, startsHook);
        return words === undefined ? [] : [words];
    });
    const binds = [
        ...runs.programs.flatMap((run) => {
            const launch = teamrigLaunchOf(run, startsBind);
            const call = launch === undefined ? undefined : bindCallOf(launch.words);
            return call === undefined ? [] : [call];
        }),
        ...runs.opaque.flatMap((run) => {
            const words = opaqueGuardedWords(run, startsBind);
            const call = words === undefined ? undefined : bindCallOf(words);
            return call === undefined ? [] : [call];
        }),
    ];
    const unread = runs.opaque.some(hidesSubcommand) || calls.some(({ call }) => call.kind === 'unreadable');
    const fed = runs.fedShells.length > 0;
    const foreign = runs.foreignShells.length > 0;
    const cleared = changesVariable(runs, ENV.claudeCode);
    const steered = changesVariable(runs, ENV.session) || changesVariable(runs, ENV.claudeSession);
    const checkedBinds = binds.filter((call) => call.unread || call.sessions.length > 0 || steered);
    const quiet = calls.length === 0 && opaque.length === 0 && opaqueOwner.length === 0 && opaqueSettings.length === 0 && opaqueHook.length === 0 && checkedBinds.length === 0;
    if (quiet && !unread && !fed && !foreign && !cleared) {
        return '';
    }
    const reasons = [...(unread ? [UNREADABLE] : []), ...(fed ? [FED_SHELL] : []), ...(foreign ? [FOREIGN_SHELL] : []), ...(cleared ? [CLAUDE_CODE_CHANGED] : [])];
    reasons.push(...opaque.map((run) => opaqueRefusalOf(run.program)));
    reasons.push(...calls.flatMap(({ call }) => (call.kind === 'owner' ? [ownerRefusalOf(call.action)] : call.kind === 'hook' ? [hookRefusalOf(call.name)] : [])));
    reasons.push(...opaqueOwner.map((words) => ownerRefusalOf(ownerActionOf(words))));
    reasons.push(...calls.flatMap(({ call }) => (call.kind === 'settings' ? [settingsWriteRefusal(call.command)] : [])));
    reasons.push(...opaqueSettings.map(settingsWriteRefusal));
    reasons.push(...opaqueHook.map((words) => hookRefusalOf(hookNameOf(words))));
    const roots = new Set();
    for (const { call, client, at } of calls) {
        if (call.kind === 'review' || call.kind === 'plain') {
            const placed = await clientRootOf(client, at, env);
            if (placed.kind === 'refused') {
                reasons.push(placed.why);
            }
            else {
                roots.add(placed.root);
            }
        }
    }
    for (const root of roots) {
        const refusal = clientRefusalOf(await env.checkClient(root), root, env.installs);
        if (refusal !== undefined) {
            reasons.push(refusal);
        }
    }
    const reviews = calls.map(({ call }) => call).filter((call) => call.kind === 'review');
    if (reviews.length > 0 || checkedBinds.length > 0) {
        const identity = await env.identity();
        reasons.push(...reviews.map((call) => reviewRefusalOf(call, identity)).filter((reason) => reason !== undefined));
        reasons.push(...checkedBinds.map((call) => bindRefusalOf(call, identity, steered)).filter((reason) => reason !== undefined));
    }
    return reasons.length === 0 ? '' : holdBackOutput('deny', `teamrig exec guard: ${[...new Set(reasons)].join(' ')}`, env.hookAsks);
}
