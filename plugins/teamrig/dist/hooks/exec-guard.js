import { isRecord, recordField, stringField } from "../core/guards.js";
import { placeProgram, placeScript } from "../exec/client-launch.js";
import { runsOf } from "../package-guard/programs.js";
import { programName } from "../push-guard/launchers.js";
import { holdBackOutput } from "./permission.js";
/**
 * The exec guard (T755, spec §7): an agent tab may run a `teamrig exec` review (approve, refuse, escalate) only as
 * itself. The allow line `Bash(teamrig exec *)` lets every exec command through unasked, and the CLI takes the
 * reviewer from `--session`, self-declared, so without this guard any tab could approve its own request as the
 * security reviewer or the owner. The owner never reviews through a tool call: they review in their own terminal, or
 * type `/teamrig exec approve R<n> --session <owner>` in a tab, which the mod runs without a PreToolUse hook. A teamrig
 * call with a word only known when it runs that decides whether it reviews, or as whom, is refused: its subcommand
 * too (`teamrig "$G" approve R1`, or `f(){ teamrig "$@"; }; f exec approve ...`), as reviews are not signed (T1780).
 *
 * It also pins the client (spec §2.2, phase 1): every `teamrig exec` call, whatever its command, runs only through an
 * install of this plugin whose files are the ones its build hashed, as phase 1 runs an approved request inside that
 * client. The guard places the file a call starts as its shell would (T803): a path the line writes, or the first
 * `teamrig` the shell's PATH search finds, where a `~/bin/teamrig` wins over the plugin bin the Bash tool appends
 * last; a call through a program only known when it runs (`$T exec ...`) is refused, as no file can be checked.
 *
 * It refuses every `teamrig owner` call too (T1298): `owner note` and `owner next` write as the owner
 * (register.ownerSource) whoever runs them, so only the owner's own routes run them: the pane, their own terminal, or
 * `/teamrig owner ...` typed in a tab, which the mod runs as a write only when the person types it. Like the review
 * check, it reads only a Bash or PowerShell tool call: a script the agent writes that starts the CLI is no such call.
 */
/** The `teamrig exec` commands that decide a request. */
export const REVIEW_ACTIONS = new Set(['approve', 'refuse', 'escalate']);
/** Every `teamrig exec` command, by which a call through an unknown program reads as a teamrig call, not as `docker exec`. */
export const EXEC_COMMANDS = new Set(['request', 'dry-run', ...REVIEW_ACTIONS, 'run', 'status']);
/** Every `teamrig owner` command, by which a call through an unknown program reads as a teamrig call. */
export const OWNER_COMMANDS = new Set(['note', 'next']);
/** teamrig's own entry point when a line runs it through node: `node <plugin>/dist/cli/main.js exec ...`. */
const CLI_ENTRY = /[\\/]cli[\\/]main\.[jt]s$/i;
/** True when the words a program only known when it runs takes read as a command of the teamrig group: `exec approve`, `exec "$CMD"`. */
function startsGroup(words, name, commands) {
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
/** The owner command the words name after `owner`, or undefined when they name none the CLI has, or one only known when it runs. */
function ownerActionOf(words) {
    const action = words[1];
    return action === undefined || action.dynamic || !OWNER_COMMANDS.has(action.text) ? undefined : action.text;
}
/** How a run starts the teamrig CLI, or undefined when it does not: by name, by node and teamrig's entry, or by node and a script only known when it runs. */
function teamrigLaunchOf(run) {
    if (run.name === 'teamrig' || run.name === 'teamrig.ps1') {
        return { client: { kind: 'program', word: run.program }, words: run.args };
    }
    if (run.name !== 'node') {
        return undefined;
    }
    const entry = run.args.findIndex((word) => CLI_ENTRY.test(word.text));
    const script = entry === -1 ? run.args.find((word) => !word.text.startsWith('-')) : run.args[entry];
    if (script === undefined) {
        return undefined;
    }
    const words = run.args.slice(run.args.indexOf(script) + 1);
    if (!script.dynamic) {
        return entry === -1 ? undefined : { client: { kind: 'script', word: script }, words };
    }
    return entry !== -1 || startsExec(words) || startsOwner(words) ? { client: { kind: 'opaque', word: script }, words } : undefined;
}
/** True for a teamrig call whose subcommand is only known when it runs (`teamrig "$G" approve R1`), which the walker leaves unread. */
function hidesSubcommand(run) {
    return !run.program.dynamic && programName(run.program.text) === 'teamrig';
}
/**
 * The guarded call the words run, read as the CLI reads them (src/cli/args.ts): the first two words are the command,
 * and each flag of a review takes the word after it as its value. Undefined when they run no `teamrig exec` or
 * `teamrig owner` command.
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
/** Why the guard refuses a call through a program only known when it runs. */
function opaqueRefusalOf(word) {
    return `\`teamrig exec\` here starts a program only known when it runs (${word.text}), so the guard cannot tell which client runs it; write it out: \`teamrig\`, or its full path.`;
}
/** The install a call's client word starts, placed as the line's shell places it. */
async function clientRootOf(client, at, env) {
    if (client.kind === 'opaque') {
        return { kind: 'refused', why: opaqueRefusalOf(client.word) };
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
 * The PreToolUse output for a Bash or PowerShell call: a refusal when the line runs a `teamrig exec` review as anyone
 * but the tab's own session, named by `--session` (the flag wins over `$TEAMRIG_SESSION` in the CLI, so a variable
 * set on the line changes nothing), when the guard cannot read who it reviews as, or when it runs any `teamrig exec`
 * command through a client that is no install of this plugin, one only known when it runs, or one whose files differ
 * from its build; and whenever the line runs a `teamrig owner` command, through any client, as it acts as the owner.
 * Else nothing, so the normal permission flow decides. It checks each install a line's `teamrig exec` calls start
 * once, and reads the tab's session only for a line that holds a review.
 */
export async function execGuardOutput(payload, env) {
    if (!isRecord(payload)) {
        return '';
    }
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    if (command === undefined) {
        return '';
    }
    const context = {
        cwd: stringField(payload, 'cwd') ?? env.cwd,
        home: env.home,
        dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
    };
    const runs = runsOf(command, context);
    const calls = runs.programs.flatMap((run) => {
        const launch = teamrigLaunchOf(run);
        const call = launch === undefined ? undefined : guardedCallOf(launch.words);
        const at = { dialect: run.dialect, dir: run.dir, home: env.home };
        return launch === undefined || call === undefined ? [] : [{ call, client: launch.client, at }];
    });
    const opaque = runs.opaque.filter((run) => startsExec(run.args));
    const opaqueOwner = runs.opaque.filter((run) => startsOwner(run.args));
    const unread = runs.opaque.some(hidesSubcommand) || calls.some(({ call }) => call.kind === 'unreadable');
    if (calls.length === 0 && opaque.length === 0 && opaqueOwner.length === 0 && !unread) {
        return '';
    }
    const reasons = unread ? [UNREADABLE] : [];
    reasons.push(...opaque.map((run) => opaqueRefusalOf(run.program)));
    reasons.push(...calls.flatMap(({ call }) => (call.kind === 'owner' ? [ownerRefusalOf(call.action)] : [])));
    reasons.push(...opaqueOwner.map((run) => ownerRefusalOf(ownerActionOf(run.args))));
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
    if (reviews.length > 0) {
        const identity = await env.identity();
        reasons.push(...reviews.map((call) => reviewRefusalOf(call, identity)).filter((reason) => reason !== undefined));
    }
    return reasons.length === 0 ? '' : holdBackOutput('deny', `teamrig exec guard: ${[...new Set(reasons)].join(' ')}`, env.hookAsks);
}
