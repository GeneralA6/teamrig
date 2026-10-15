import { launchOf } from "../../config/launch.js";
import { Roster } from "../../config/roster.js";
import { errorMessage, isRecord, stringField } from "../../core/guards.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { resolveTeam } from "../../core/team.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { indexMarks } from "../../inbox/marks.js";
import { boundPromptNote, boundStartNote } from "../../hooks/bind.js";
import { modelCheckLine, payloadEffortOf } from "../../hooks/model-check.js";
import { ModelNoticeStore } from "../../hooks/model-notices.js";
import { commitsOf, protectedBranchesOf, pushGuardOutput } from "../../hooks/push-guard.js";
import { JsonlHintLog } from "../../hooks/hint-log.js";
import { requirementsNoteOnce } from "../../hooks/requirements-note.js";
import { sessionStartContext, sessionStartOutput } from "../../hooks/session-start.js";
import { stopModelNotices } from "../../hooks/stop-model.js";
import { stopOutput } from "../../hooks/stop.js";
import { adoptTitle, promptNote, sessionStartNote } from "../../names/detect.js";
import { JsonlRenameLog } from "../../names/log.js";
import { decideStart, decideStop, handoverHashOf } from "../../refresh/decide.js";
import { RefreshStore } from "../../refresh/store.js";
import { readContextTokens } from "../../refresh/usage.js";
import { noPositionals } from "../args.js";
import { openKit, renameDepsOf, rosterOf, teamFolders } from "../kit.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
import { bindHintOnce, bindTab, inboxLinesFor, readTitle } from "./hook-bind.js";
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
/**
 * The team a session's hooks run for: `$TEAMRIG_TEAM`, else the nearest pointer above the folder the
 * session started in (`$CLAUDE_PROJECT_DIR`), then the payload's folder. The payload's `cwd` follows
 * a `cd`, so walking it first would let a tab that moved into another team's project read, and bind
 * to, that team's sessions. The push guard keeps `hookTeam`: a push belongs to the folder it runs in.
 */
function sessionTeam(payload, runtime) {
    const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.env[ENV.claudeProjectDir], cwd, runtime.cwd]));
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
    return markedSessionOf(runtime, kit, roster, claudeSession);
}
/**
 * The area this Claude Code session last read its inbox as, or was bound to by its title, when it is
 * on the roster. It is how a tab started without `$TEAMRIG_SESSION`, such as the one that set the team
 * up, stays its session.
 */
async function markedSessionOf(runtime, kit, roster, claudeSession) {
    if (claudeSession === null) {
        return undefined;
    }
    const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
    const area = indexMarks(marks).areaBySession.get(claudeSession);
    return area !== undefined && roster.ids.includes(area) ? area : undefined;
}
/** `markedSessionOf` for the SessionStart context, which must always load: a failed read means no session. */
async function startSessionOf(runtime, kit, roster, payload) {
    try {
        return await markedSessionOf(runtime, kit, roster, sessionIdOf(payload));
    }
    catch {
        return undefined;
    }
}
/**
 * A Claude Code rename (`--name`, `/rename`) of the session becomes its new team name: recorded in
 * the rename log, never by moving data. It never throws, so the hook always answers; a failure is
 * retried on the next prompt.
 */
async function titleOutcome(runtime, kit, config, payload, read) {
    if (read.kind === 'failed') {
        return { kind: 'failed', error: read.error };
    }
    const { title } = read;
    try {
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
/**
 * UserPromptSubmit: binds a hand-started tab by its title, notes a Claude Code rename of the session,
 * says once how to bind a tab that is not bound, and shows the session's new inbox lines; or one line
 * when its team pointer is broken.
 */
export async function inboxReminder(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const claudeSession = sessionIdOf(payload);
    if (claudeSession === null) {
        return EXIT.ok;
    }
    const found = await sessionTeam(payload, runtime);
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
    const { config } = kit.load;
    const title = await readTitle(runtime, payload);
    const own = { team: kit.paths.team, roster: await rosterOf(runtime, kit, config) };
    const binding = await bindTab(runtime, kit, own, claudeSession, title);
    const bound = boundPromptNote(binding.outcome, own, KIT_NAME);
    const renamed = promptNote(await titleOutcome(runtime, kit, config, payload, title), KIT_NAME);
    const hint = await bindHintOnce(runtime, kit, binding, claudeSession);
    // Found like a rename: `$TEAMRIG_SESSION` first, so a session is shown its lines before its first `inbox read`.
    const session = await teamSessionOf(runtime, kit, own.roster, claudeSession);
    const lines = session === undefined ? undefined : await inboxLinesFor(runtime, kit, session, claudeSession);
    for (const text of [bound, renamed, hint, lines]) {
        if (text !== undefined) {
            runtime.out.stdout(text);
        }
    }
    return EXIT.ok;
}
/**
 * A loaded team's rules.md and rename log, after binding a hand-started tab by its Claude Code title
 * and recording a Claude Code rename of the session; the pointer to its handover after a refresh; who
 * the session is: `$TEAMRIG_SESSION`, else the area it read its inbox as or was bound to, so a tab that
 * set the team up keeps its identity across a compact or resume; whether it runs on its configured
 * model and effort; and where the team sits in a tree of teams, read from every team config of the kit
 * home.
 */
async function teamPartsOf(runtime, kit, config, payload) {
    const title = await readTitle(runtime, payload);
    const claudeSession = sessionIdOf(payload);
    const bound = claudeSession === null
        ? undefined
        : boundStartNote((await bindTab(runtime, kit, { team: kit.paths.team, roster: await rosterOf(runtime, kit, config) }, claudeSession, title)).outcome);
    const renamed = sessionStartNote(await titleOutcome(runtime, kit, config, payload, title));
    const titleNote = bound === undefined || renamed === undefined ? (bound ?? renamed) : `${bound} ${renamed}`;
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    const roster = new Roster(config, kit.paths.team, renames);
    const refreshNote = await refreshNoteOf(runtime, kit, config, roster, payload);
    const text = await runtime.files.read(kit.paths.teamRules);
    const fromEnv = envSession(runtime);
    const { tree } = await loadTree(runtime);
    const session = fromEnv ?? (await startSessionOf(runtime, kit, roster, payload));
    return {
        teamRules: text === undefined ? undefined : { path: kit.paths.teamRules, text },
        renames,
        titleNote,
        refreshNote,
        modelNote: modelNoteOf(config, roster, session, payload),
        session,
        sessionInEnv: fromEnv !== undefined,
        tree: tree.placeOf(kit.paths.team),
    };
}
/**
 * The line for a session of the team that runs on another model than its `launch` entry (for the
 * lead, unset: `opus`), from the payload's model; Claude Code leaves it out at some starts, and then
 * nothing is checked. The effort is checked at the first Stop: SessionStart gets no effort level, and
 * `$CLAUDE_EFFORT` here can be the value of the session whose shell started this one.
 */
function modelNoteOf(config, roster, session, payload) {
    const found = session === undefined ? undefined : roster.lookup(session);
    if (found === undefined || !found.ok) {
        return undefined;
    }
    const running = { model: isRecord(payload) ? stringField(payload, 'model') : undefined, effort: undefined };
    return modelCheckLine(roster.nameOf(found.id) ?? found.id, launchOf(config, found.id), running);
}
/**
 * A fresh start (`/clear`, a new process) after the session's handover was marked ready: the note
 * that points it at the handover, given once. A start that keeps the old context (compact, resume)
 * leaves the handover waiting. It never throws, so the session always gets its rules.
 */
async function refreshNoteOf(runtime, kit, config, roster, payload) {
    try {
        const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
        if (id === undefined) {
            return undefined;
        }
        const store = new RefreshStore(runtime.files, kit.paths);
        const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
        const now = new Date(runtime.clock.now()).toISOString();
        const decision = decideStart(await store.state(id), source, config.refresh, store.handoverPath(id), now);
        if (decision.kind === 'none') {
            return undefined;
        }
        await store.setState(id, decision.state);
        await store.clearRequest(id);
        return decision.note;
    }
    catch (error) {
        return `${KIT_NAME} could not check for a refresh handover (${errorMessage(error)}); if you wrote one before a /clear, read it first.`;
    }
}
/**
 * The refresh facts of a boundary: the lead's request, the context size from the transcript's
 * tail, and the handover as it is now (so `refresh --ready` can tell a new one from it).
 */
async function boundaryFactsOf(runtime, roster, store, id, payload) {
    const request = await store.request(id);
    const transcript = stringField(payload, 'transcript_path');
    return {
        requestedBy: request === undefined ? undefined : (roster.nameOf(request.by) ?? request.by),
        tokens: transcript === undefined ? undefined : await readContextTokens(runtime.files, transcript),
        handoverHash: handoverHashOf(await store.handover(id)),
    };
}
/** The Stop payload's team session; undefined outside a team, without a loaded config or without a session. */
async function stopScopeOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    if (found.kind !== 'team') {
        return undefined;
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return undefined;
    }
    const { config } = kit.load;
    const roster = await rosterOf(runtime, kit, config);
    const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    return id === undefined ? undefined : { kit, config, roster, id };
}
/** The refresh decision for this turn's end; none with refresh off. */
async function refreshDecisionOf(runtime, scope, payload) {
    const { kit, config, roster, id } = scope;
    if (!config.refresh.enabled) {
        return { kind: 'none' };
    }
    const store = new RefreshStore(runtime.files, kit.paths);
    const state = await store.state(id);
    const context = {
        stopHookActive: payload['stop_hook_active'] === true,
        settings: config.refresh,
        now: new Date(runtime.clock.now()).toISOString(),
        session: { id, name: roster.nameOf(id) ?? id },
        handoverPath: store.handoverPath(id),
        command: KIT_NAME,
    };
    const first = decideStop(state, context);
    const decision = first.kind === 'measure' ? decideStop(state, context, await boundaryFactsOf(runtime, roster, store, id, payload)) : first;
    switch (decision.kind) {
        case 'write':
        case 'block':
        case 'notice':
            // Written before anything is printed: a block whose state is not recorded would ask again at every stop.
            await store.setState(id, decision.state);
            break;
        case 'none':
        case 'measure':
            break;
    }
    return decision;
}
/** The model notices for the user at this turn's end (`stopModelNotices`); none without a Claude Code session id. */
async function modelNoticesOf(runtime, scope, payload) {
    const claude = sessionIdOf(payload);
    if (claude === null) {
        return [];
    }
    const { kit, config, roster, id } = scope;
    return stopModelNotices(runtime.files, new ModelNoticeStore(runtime.files, kit.paths.modelNotices), {
        id,
        name: roster.nameOf(id) ?? id,
        launch: launchOf(config, id),
        claude,
        effort: payloadEffortOf(payload),
        transcript: stringField(payload, 'transcript_path'),
    });
}
/**
 * What the Stop hook prints for this turn's end; '' outside a team or without a session. The refresh
 * and the model notices fail apart: an error in either leaves only the other.
 */
async function stopOutputOf(runtime, payload) {
    const scope = await stopScopeOf(runtime, payload);
    if (scope === undefined) {
        return '';
    }
    const decision = await refreshDecisionOf(runtime, scope, payload).catch(() => ({ kind: 'none' }));
    const notices = await modelNoticesOf(runtime, scope, payload).catch(() => []);
    return stopOutput(decision, notices);
}
/**
 * Stop, at the end of every turn: after the session finished a task (`set done`), asks for its
 * handover once when its context reached the team's threshold or the lead asked, then tells the user
 * once that it waits for /clear. It also tells the user, once each, when the session runs at another
 * effort than its `launch` entry or Claude Code switched its model after a safeguard stop. A turn with
 * nothing to say reads only small files and the transcript's tail, and prints nothing. It never blocks
 * on an error, and ignores input that is not a hook payload (which would judge a boundary without its
 * transcript): a refresh is a convenience, and the next stop tries again.
 */
export async function stop(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await stopOutputOf(runtime, payload).catch(() => '') : '';
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/** SessionStart: the core rules from the team config, who the session is (and, after a refresh, its handover), and the team's rules.md. */
export async function sessionStart(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const found = await sessionTeam(payload, runtime);
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
        : { teamRules: undefined, renames: [], titleNote: undefined, refreshNote: undefined, modelNote: undefined, session: undefined, sessionInEnv: false, tree: undefined };
    const context = sessionStartContext({ team: found.team, load: kit.load, ...parts, command: KIT_NAME });
    const requirementsNote = await requirementsNoteOnce({
        problems: await runtime.requirements.problems(),
        log: new JsonlHintLog(runtime.files, kit.paths.bindHints),
        claudeSession: sessionIdOf(payload),
        now: new Date(runtime.clock.now()),
        command: KIT_NAME,
    });
    runtime.out.stdout(sessionStartOutput(context, [parts.modelNote, requirementsNote]));
    return EXIT.ok;
}
