import { errorMessage, isRecord, stringField } from "../../core/guards.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { resolveTeam } from "../../core/team.js";
import { reminderFor, sessionIdOf } from "../../inbox/inbox.js";
import { indexMarks } from "../../inbox/marks.js";
import { commitsOf, protectedBranchesOf, pushGuardOutput } from "../../hooks/push-guard.js";
import { sessionStartContext, sessionStartOutput } from "../../hooks/session-start.js";
import { adoptTitle, promptNote, sessionStartNote } from "../../names/detect.js";
import { JsonlRenameLog } from "../../names/log.js";
import { sessionTitleOf } from "../../names/title.js";
import { noPositionals } from "../args.js";
import { openKit, renameDepsOf, rosterOf, teamFolders } from "../kit.js";
import { EXIT } from "../runtime.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call. A plugin
 * enabled for the user fires in every project, so outside a team's projects each hook prints
 * nothing at all.
 */
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** The payload's folder first: Claude Code may start the hook process somewhere else. */
function hookTeam(payload, runtime) {
    const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd, runtime.cwd]));
}
/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const found = await hookTeam(payload, runtime);
    if (found.kind === 'none') {
        return EXIT.ok;
    }
    // A broken pointer, or a config that cannot even be opened, keeps the default branches: neither turns the guard off.
    const load = found.kind === 'team'
        ? await openKit(runtime, found.team).then((kit) => kit.load, () => undefined)
        : undefined;
    const output = pushGuardOutput(payload, {
        cwd: runtime.cwd,
        home: runtime.userHome,
        repo: runtime.git,
        protectedBranches: protectedBranchesOf(load),
        commits: commitsOf(load),
        commitLog: runtime.commitLog,
    });
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/** `$TEAMRIG_SESSION` as Claude Code passed it to the hook; undefined when unset or blank. */
function envSession(runtime) {
    const session = runtime.env[ENV.session]?.trim();
    return session === '' ? undefined : session;
}
/**
 * The team session a hook runs for: `$TEAMRIG_SESSION` when it is set (an id or any name the
 * session has had), else the area this Claude Code session last read its inbox as.
 */
async function teamSessionOf(runtime, kit, roster, claudeSession) {
    const session = envSession(runtime);
    if (session !== undefined) {
        const found = roster.lookup(session);
        return found.ok ? found.id : undefined;
    }
    if (claudeSession === null) {
        return undefined;
    }
    const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
    const area = indexMarks(marks).areaBySession.get(claudeSession);
    return area !== undefined && roster.ids.includes(area) ? area : undefined;
}
/**
 * A Claude Code rename (`--name`, `/rename`) of the session becomes its new team name: recorded in
 * the rename log, never by moving data. It never throws, so the hook always answers; a failure is
 * retried on the next prompt.
 */
async function titleOutcome(runtime, kit, config, payload) {
    try {
        const title = await sessionTitleOf(payload, runtime.files);
        if (title === undefined) {
            return { kind: 'none' };
        }
        const roster = await rosterOf(runtime, kit, config);
        const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
        return id === undefined ? { kind: 'none' } : await adoptTitle(renameDepsOf(runtime, kit, config), roster, id, title);
    }
    catch (error) {
        return { kind: 'failed', error: errorMessage(error) };
    }
}
/** UserPromptSubmit: notes a Claude Code rename of the session, then one line when its inbox has unread lines, or its team pointer is broken. */
export async function inboxReminder(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const claudeSession = sessionIdOf(payload);
    if (claudeSession === null) {
        return EXIT.ok;
    }
    const found = await hookTeam(payload, runtime);
    switch (found.kind) {
        case 'none':
            return EXIT.ok;
        case 'broken':
            runtime.out.stdout(`${KIT_NAME}: no team, so no inbox reminder: ${found.from} ${found.problem}`);
            return EXIT.ok;
        case 'team':
            break;
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return EXIT.ok;
    }
    const note = promptNote(await titleOutcome(runtime, kit, kit.load.config, payload), KIT_NAME);
    if (note !== undefined) {
        runtime.out.stdout(note);
    }
    const line = await reminderFor(inboxDepsOf(runtime, kit.paths), claudeSession, KIT_NAME);
    if (line !== undefined) {
        runtime.out.stdout(line);
    }
    return EXIT.ok;
}
/** A loaded team's rules.md and rename log, after recording a Claude Code rename of the session. */
async function teamPartsOf(runtime, kit, config, payload) {
    const titleNote = sessionStartNote(await titleOutcome(runtime, kit, config, payload));
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    const text = await runtime.files.read(kit.paths.teamRules);
    return { teamRules: text === undefined ? undefined : { path: kit.paths.teamRules, text }, renames, titleNote };
}
/** SessionStart: the core rules from the team config, who the session is, and the team's rules.md. */
export async function sessionStart(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const found = await hookTeam(payload, runtime);
    switch (found.kind) {
        case 'none':
            return EXIT.ok;
        case 'broken':
            runtime.out.stdout(sessionStartOutput(`${KIT_NAME}: no team, so no team rules: ${found.from} ${found.problem}`));
            return EXIT.ok;
        case 'team':
            break;
    }
    const kit = await openKit(runtime, found.team);
    const parts = kit.load.status === 'loaded'
        ? await teamPartsOf(runtime, kit, kit.load.config, payload)
        : { teamRules: undefined, renames: [], titleNote: undefined };
    const context = sessionStartContext({ team: found.team, load: kit.load, ...parts, session: envSession(runtime), command: KIT_NAME });
    runtime.out.stdout(sessionStartOutput(context));
    return EXIT.ok;
}
